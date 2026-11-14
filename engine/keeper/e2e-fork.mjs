/**
 * End-to-end run of the keeper on a local anvil fork: listing a v4 coin with its price feed, wallet clusters, the
 * insider short limit, and SL / TP firing on a real price move (the pool's price is moved in the fork's storage).
 * It only talks to 127.0.0.1 and signs with anvil's public test keys. README, "Сквозной прогон на форке", has the
 * commands that start anvil, deploy the pool and start the engine this script drives.
 *
 *   node engine/keeper/e2e-fork.mjs          # E2E_RPC, E2E_API, E2E_TOKEN override the defaults below
 */
import { createPublicClient, createWalletClient, http, defineChain, parseEther, parseEventLogs, keccak256, encodeAbiParameters, toHex, zeroAddress } from "viem";
import { privateKeyToAccount, generatePrivateKey, nonceManager } from "viem/accounts";
import { POOL_ABI, SRC_ABI } from "../abi.mjs";
import * as D from "./decide.mjs";

const RPC = process.env.E2E_RPC || "http://127.0.0.1:8545";
const API = process.env.E2E_API || "http://127.0.0.1:4681";
const TOKEN = (process.env.E2E_TOKEN || "0x378bcc6827483d176473addc279d19a8ea3ad752").toLowerCase(); // RHSL: a testnet launchpad coin (v4, hook)
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(RPC)) throw new Error("E2E_RPC must be a local anvil fork");

// anvil's well-known accounts (public test keys: never funded on a real network)
const ANVIL = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // 0: owner / LP
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // 5: funds W1 and W2
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", // 6: funds W3
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, body) => {
  const r = await fetch(API + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${JSON.stringify(j)}`);
  return j;
};

const cfg = await api("/api/real/config");
const POOL = cfg.pool;
const chain = defineChain({ id: cfg.chainId, name: "fork", nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000 }), pollingInterval: 200, cacheTime: 0 }); // a fork can stall for seconds
const rpc = (method, params = []) => pub.request({ method, params });
const signer = (key) => {
  const account = privateKeyToAccount(key, { nonceManager });
  return { account, address: account.address, w: createWalletClient({ account, chain, transport: http(RPC, { timeout: 60_000 }) }) };
};
const [owner, funderA, funderB] = ANVIL.map(signer);
const [w1, w2, w3] = [1, 2, 3].map(() => signer(generatePrivateKey()));
const read = (functionName, args = [], address = POOL, abi = POOL_ABI) => pub.readContract({ address, abi, functionName, args });
const mined = async (hash) => {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (r.status !== "success") throw new Error(`reverted: ${hash}`);
  return r;
};
const call = async (s, functionName, args = [], value) => mined(await s.w.writeContract({ address: POOL, abi: POOL_ABI, functionName, args, value }));
const pay = async (s, to, eth) => mined(await s.w.sendTransaction({ to, value: parseEther(eth) }));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
async function until(what, fn, ms = 60_000) {
  const t0 = Date.now();
  for (;;) {
    // a fork stalls for seconds whenever the upstream node refuses a log range: a failed poll is just "not yet"
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await sleep(400);
  }
}

const ST = ["none", "pending-open", "open", "pending-close", "closed", "cancelled"];
/** Send an open request and wait for the keeper's verdict. -> { id, status, code?, closed? } */
async function order(s, marketId, isLong, lev, stakeEth, { tp = 0n, sl = 0n } = {}) {
  const rc = await call(s, "requestOpen", [marketId, isLong, lev, parseEther(stakeEth), tp, sl, zeroAddress]);
  const id = parseEventLogs({ abi: POOL_ABI, logs: rc.logs, eventName: "OpenRequested" })[0].args.id;
  const status = await until(`verdict on #${id}`, async () => {
    const st = Number((await read("getPosition", [id])).status);
    return st === 1 ? null : st;
  });
  const out = { id, status: ST[status], from: rc.blockNumber };
  if (status === 5) {
    const ev = await events("RequestRejected", id, rc.blockNumber);
    out.code = ev ? Number(ev.args.code) : null;
  }
  return out;
}
async function events(eventName, id, fromBlock) {
  const logs = await pub.getContractEvents({ address: POOL, abi: POOL_ABI, eventName, fromBlock, toBlock: "latest" });
  return logs.find((l) => l.args.id === id) || null;
}

// ── setup ──
console.log(`pool ${POOL} on chain ${cfg.chainId}, coin ${TOKEN}`);
await rpc("evm_setIntervalMining", [1]); // the keeper prices a request from a later block: blocks must keep coming
const status = await until("the keeper is up", async () => {
  const s = await api("/api/real");
  return s.enabled ? s : null;
});
check("second key signs the defensive lane", !!status.defensiveLane, status.defensiveLane || "one lane");
const keeper2 = (status.defensiveLane || "").toLowerCase();

await call(owner, "addLiquidity", [], parseEther("1000"));
await pay(funderA, w1.address, "30");
await pay(funderA, w2.address, "30");
await pay(funderB, w3.address, "30");
for (const s of [w1, w2, w3]) await call(s, "deposit", [], parseEther("20"));

// ── listing a v4 coin with its feed ──
const listed = await api("/api/real/market", { token: TOKEN });
const marketId = BigInt(listed.marketId);
const mkt = await until("the market is fed and priced", async () => {
  const m = await api(`/api/real/market?token=${TOKEN}`);
  return m.listed && m.fed !== false && m.spot ? m : null;
}, 120_000);
const adapter = await read("defaultAdapter");
const [manager, poolId] = await read("feeds", [marketId], adapter, SRC_ABI);
check("v4 coin listed with a V4SpotSource feed", manager !== zeroAddress, `market ${marketId}, pool ${poolId.slice(0, 10)}… on ${manager.slice(0, 10)}…`);
await sleep(40_000); // the keeper's warm-up: its 30-s average must hold live samples only
// the coin's holders are counted in the background from its whole Transfer history: wait for the verdict
const counted = await until("the coin's holders are counted", async () => {
  const m = await api(`/api/real/market?token=${TOKEN}`);
  return !m.shortLimit || m.shortLimit.counted ? m : null;
}, 300_000);
console.log(`spot ${counted.spot}, short limit: ${counted.shortLimit ? counted.shortLimit.why : "none"}`);
// each wallet's funder is looked up when it deposits; on a fork that takes seconds per wallet
const fund = await until("the wallets' funders are looked up", async () => {
  const f = (await api("/api/real")).funding;
  return f.wallets >= 3 && f.pending === 0 ? f : null;
}, 180_000);
check("funders found from the deposits, before any order", fund.linked >= 3, JSON.stringify(fund));

// ── clusters ──
const px = D.toWad(counted.spot);
const long = await order(w1, marketId, true, 2, "1", { sl: (px * 95n) / 100n });
check("W1 long 2x opens", long.status === "open", long.status + (long.code ? ` code ${long.code}` : ""));
const opp = await order(w2, marketId, false, 2, "1");
check("W2 (same funder as W1) cannot take the other side", opp.status === "cancelled" && opp.code === D.CODES.OPPOSITE_SIDE, `${opp.status} code ${opp.code}`);

// ── insider short limit ──
const lim = (await api(`/api/real/market?token=${TOKEN}`)).shortLimit;
let shortLev = 5;
if (lim && lim.maxLev < 5) {
  const big = await order(w3, marketId, false, 5, "1");
  check(`W3 short 5x refused by the insider limit (max ${lim.maxLev}x)`, big.status === "cancelled" && big.code === D.CODES.INSIDER_SHORT, `${big.status} code ${big.code}`);
  shortLev = lim.maxLev;
} else console.log(`SKIP  insider refusal: shorts of this coin are ${lim ? `limited to ${lim.maxLev}x` : "not limited"}`);
const short = await order(w3, marketId, false, shortLev, "1", { tp: (px * 95n) / 100n });
check(`W3 (another funder) short ${shortLev}x opens`, short.status === "open", short.status + (short.code ? ` code ${short.code}` : ""));

// ── SL and TP on a price move: -8 % in the pool's own storage ──
const slot = toHex(BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, 6n]))), { size: 32 });
const word = BigInt(await rpc("eth_getStorageAt", [manager, slot, "latest"]));
const MASK = (1n << 160n) - 1n;
const sqrt = word & MASK;
const spot0 = await read("spot", [marketId], adapter, SRC_ABI);
const setSqrt = (v) => rpc("anvil_setStorageAt", [manager, slot, toHex((word & ~MASK) | v, { size: 32 })]);
// price ~ sqrt^2 or its inverse: try one direction, turn round if the adapter's spot went up
const K = 1_042_572n; // 1 / sqrt(0.92), 6 decimals
await setSqrt((sqrt * K) / 1_000_000n);
if ((await read("spot", [marketId], adapter, SRC_ABI)) > spot0) await setSqrt((sqrt * 1_000_000n) / K);
const spot1 = await read("spot", [marketId], adapter, SRC_ABI);
check("the pool's price fell ~8 %", spot1 < (spot0 * 93n) / 100n && spot1 > (spot0 * 91n) / 100n, `${D.fromWad(spot0)} -> ${D.fromWad(spot1)}`);

const closedOf = async (o, what) => {
  const ev = await until(what, () => events("PositionClosed", o.id, o.from), 120_000);
  const tx = await pub.getTransaction({ hash: ev.transactionHash });
  return { reason: Number(ev.args.reason), from: tx.from.toLowerCase(), pnl: ev.args.pnl, payout: ev.args.payout };
};
const sl = await closedOf(long, "the long's stop-loss");
check("the long closed on its stop-loss", sl.reason === 2, `reason ${sl.reason}, pnl ${D.fromWad(sl.pnl)}`);
if (keeper2) check("…sent by the defensive key", sl.from === keeper2, sl.from);
const tp = await closedOf(short, "the short's take-profit");
check("the short closed on its take-profit", tp.reason === 1, `reason ${tp.reason}, pnl ${D.fromWad(tp.pnl)}`);
if (keeper2) check("…sent by the defensive key", tp.from === keeper2, tp.from);

// ── books ──
await sleep(3_000);
const surplus = await read("accountingSurplus");
check("accounting surplus is 0", surplus === 0n, String(surplus));
const end = await api("/api/real");
check("no keeper transaction failed", end.failed === 0, `${end.sent} sent, ${end.failed} failed`);
console.log(`funding: ${JSON.stringify(end.funding)}`);

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);
