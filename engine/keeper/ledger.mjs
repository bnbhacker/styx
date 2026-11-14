/**
 * Ledger: the InversePool's own events, followed from its deploy block and kept on disk. The keeper never trusts it
 * (positions are polled from storage); the site uses it for what storage does not keep: why a request was refused,
 * how a position closed (price, PnL, payout, reason, when), the tape, the wins board and LP exit requests.
 * Works without a keeper key, so a read-only engine can serve Real mode.
 * apply() is idempotent: every pass re-reads the last REWIND blocks, since a lagging RPC replica may answer getLogs
 * short of the head it reported.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEventLogs, encodeEventTopics, zeroAddress, toHex } from "viem";
import { CFG } from "../config.mjs";
import { client } from "../chain.mjs";
import { POOL_ABI as ABI } from "../abi.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "..", "data");
const BROADCAST = () => path.join(HERE, "..", "..", "contracts", "broadcast", "Deploy.s.sol", String(CFG.chainId), "run-latest.json");
const EVENTS = new Set([
  "Deposited", // not journaled: passed to onDeposit hooks
  "MarketAdded",
  "OpenRequested",
  "PositionOpened",
  "CloseRequested",
  "PositionClosed",
  "RequestRejected",
  "RequestCancelled",
  "RemoveRequested",
  "RemoveExecuted",
  "RemoveCancelled",
  "RugFlagged",
]);
// events whose time the site shows: fills (tape), closes (history, wins board), rugs
const TIMED = new Set(["PositionOpened", "PositionClosed", "RugFlagged"]);
// the pool's constructor emits OwnershipTransferred(0, deployer): marks the deploy block without archive state
const DEPLOY_TOPICS = encodeEventTopics({ abi: ABI, eventName: "OwnershipTransferred", args: { previousOwner: zeroAddress } });
const REWIND = 50n; // trailing blocks re-read on every pass
const TS_PAR = 8; // parallel getBlock calls for timestamps
export const REASONS = ["USER", "TP", "SL", "CAP_WIN", "CAP_LOSS", "RUG", "POOL_GONE", "EMERGENCY"];
const lc = (a) => (a || "").toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (e) => String(e?.shortMessage || e?.message || e).split("\n")[0];

export const L = {
  ready: false, // caught up with the head at least once
  from: null, // deploy block
  to: null, // last block processed
  markets: {}, // id -> { token, decimals }
  pos: {}, // id -> { id, trader, marketId, isLong, lev, stake, fee, tp, sl, reqBlock, reqTx, entry, entryBlock, openTx, openBlock, openAt, closeReq, closed, rejected, cancelled, closeRejected, closeCancelled }
  removes: {}, // rid -> { rid, lp, shares, executableAt, done: null | "executed" | "cancelled", amount }
  feed: [], // newest first: { kind: "open" | "close", id, block, tx, at } | { kind: "rug", marketId, block, tx, at }
  error: null,
};

const FILE = () => path.join(DATA, `ledger-${CFG.chainId}-${CFG.pool}.json`);
let dirty = false; // something besides L.to changed since the last write
let savedAt = 0;
let savedTo = null;
let saving = false;
let anchor = null; // { block, hash } written as to/toHash: lets load() tell a reset chain from ours
let fromHash = null; // hash of block L.from: tells a reset chain still short of `to` from a node that is behind
const untimed = new Set(); // blocks of entries still without a timestamp
const tsCache = new Map(); // block -> timestamp, recent fetches
const byTrader = new Map(); // trader -> Set(id)
const byLp = new Map(); // lp -> Set(rid)

const s = (v) => (typeof v === "bigint" ? v.toString() : v);
const index = (m, key, v) => (m.get(key) || m.set(key, new Set()).get(key)).add(v);

function reindex() {
  byTrader.clear();
  byLp.clear();
  untimed.clear();
  for (const p of Object.values(L.pos)) {
    if (p.trader) index(byTrader, p.trader, p.id);
    if (p.openBlock && p.openAt == null) untimed.add(p.openBlock);
    if (p.closed && p.closed.at == null) untimed.add(p.closed.block);
  }
  for (const r of Object.values(L.removes)) if (r.lp) index(byLp, r.lp, r.rid);
  for (const x of L.feed) if (x.at == null) untimed.add(x.block);
}

function drop(why) {
  console.log(`[ledger] starting over: ${why}`);
  try {
    fs.renameSync(FILE(), FILE() + ".old");
  } catch {}
}

/** Saved ledger, if it belongs to this chain: same chainId and pool, and block `to` still has the saved hash. */
async function load() {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(FILE(), "utf8"));
  } catch {
    return;
  }
  if (j.pool !== CFG.pool || j.chainId !== CFG.chainId || j.from == null || j.to == null || !j.toHash) return drop("the saved file has no chain check");
  const env = process.env.STYX_FROM_BLOCK;
  if (env && BigInt(env) < BigInt(j.from)) return drop(`STYX_FROM_BLOCK ${env} is before the saved start ${j.from}`);
  const to = BigInt(j.to);
  let blk = null;
  try {
    blk = await client.getBlock({ blockNumber: to });
  } catch (e) {
    if (e?.name !== "BlockNotFoundError") throw e; // transient: keep the file and try again
    const head = await client.getBlockNumber();
    // a node behind us, unless block `from` changed too (a reset or a fork rerun shorter than `to`)
    const f = j.fromHash ? await client.getBlock({ blockNumber: BigInt(j.from) }).catch(() => null) : null;
    if (to - head < 1000n && (!f || f.hash === j.fromHash)) throw new Error(`waiting for the node to reach block ${to}`);
  }
  if (!blk || blk.hash !== j.toHash) return drop(`block ${to} is not the saved one (chain reset or another fork)`);
  Object.assign(L, { from: BigInt(j.from), to });
  Object.assign(L, { markets: j.markets || {}, pos: j.pos || {}, removes: j.removes || {}, feed: j.feed || [] });
  anchor = { block: to, hash: j.toHash };
  fromHash = j.fromHash || null;
  savedTo = to;
  savedAt = Date.now();
  reindex();
}

const body = (to, hash) =>
  JSON.stringify({
    pool: CFG.pool,
    chainId: CFG.chainId,
    from: L.from.toString(),
    to: to.toString(),
    toHash: hash,
    fromHash,
    markets: L.markets,
    pos: L.pos,
    removes: L.removes,
    feed: L.feed,
  });

/** Write the ledger when something changed (at most every 5 s), or every 10 min when only the head moved. */
async function save() {
  if (saving || L.from == null || L.to == null || L.to < L.from) return;
  const age = Date.now() - savedAt;
  if (!(dirty ? age >= 5_000 : L.to !== savedTo && age >= 600_000)) return;
  saving = true;
  let cleared = false;
  try {
    const to = L.to;
    fromHash ||= await client.getBlock({ blockNumber: L.from }).then((b) => b.hash, () => null);
    const { hash } = await client.getBlock({ blockNumber: to });
    dirty = false; // changes from here on make the next write
    cleared = true;
    const text = body(to, hash);
    await fs.promises.mkdir(DATA, { recursive: true });
    await fs.promises.writeFile(FILE() + ".tmp", text);
    await fs.promises.rename(FILE() + ".tmp", FILE());
    anchor = { block: to, hash };
    savedTo = to;
  } catch (e) {
    if (cleared) dirty = true;
    console.error(`[ledger] save failed: ${short(e)}`);
  } finally {
    savedAt = Date.now();
    saving = false;
  }
}

// ───────────────────────────── deploy block ─────────────────────────────

/** Does the pool have code at this block? A failed probe proves nothing: retried, then thrown. */
async function hasCode(blockNumber) {
  for (let i = 0; ; i++) {
    try {
      return ((await client.getCode({ address: CFG.pool, blockNumber })) || "0x") !== "0x";
    } catch (e) {
      if (i >= 2) throw new Error(`getCode at block ${blockNumber}: ${short(e)}`);
      await sleep(1_000 * (i + 1));
    }
  }
}

/** The pool's constructor log in [a, b] (getLogs needs no historical state). */
const deployLogs = (a, b) =>
  client.request({
    method: "eth_getLogs",
    params: [{ address: CFG.pool, fromBlock: toHex(a), toBlock: toHex(b), topics: DEPLOY_TOPICS }],
  });
const isDeploy = async (b) => (await deployLogs(b, b)).length > 0;

/** contracts/broadcast/Deploy.s.sol/<chainId>/run-latest.json: the block of the receipt that created the pool. */
function broadcastBlock() {
  try {
    const j = JSON.parse(fs.readFileSync(BROADCAST(), "utf8"));
    const r = (j.receipts || []).find((x) => lc(x.contractAddress) === CFG.pool);
    return r && r.blockNumber != null ? BigInt(r.blockNumber) : null;
  } catch {
    return null;
  }
}

/**
 * First block with the pool: STYX_FROM_BLOCK, else a binary search over eth_getCode, else the forge broadcast,
 * else the constructor log from one getLogs over the whole chain (nodes without archive state).
 */
async function deployBlock(head) {
  if (process.env.STYX_FROM_BLOCK) return { block: BigInt(process.env.STYX_FROM_BLOCK), how: "STYX_FROM_BLOCK" };
  let why;
  try {
    if (!(await hasCode(head))) throw new Error(`no contract at ${CFG.pool} at block ${head}`);
    let lo = 0n;
    let hi = head;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      if (await hasCode(mid)) hi = mid;
      else lo = mid + 1n;
    }
    if (await isDeploy(lo)) return { block: lo, how: "eth_getCode" };
    why = `block ${lo} has no deploy log`;
  } catch (e) {
    why = short(e);
  }
  const b = broadcastBlock();
  if (b != null && (await isDeploy(b))) return { block: b, how: "forge broadcast" };
  try {
    const logs = await deployLogs(0n, head);
    if (logs.length) return { block: BigInt(logs[0].blockNumber), how: "eth_getLogs" };
    why += "; no constructor log up to the head";
  } catch (e) {
    why += `; getLogs: ${short(e)}`;
  }
  const err = new Error(`deploy block not found (${why}); the RPC may not serve historical state: set STYX_FROM_BLOCK`);
  err.wait = 30_000;
  throw err;
}

// ───────────────────────────── events ─────────────────────────────

/** Timestamps of these blocks (strings), at most TS_PAR at a time; failures are left out. */
async function blockTimes(blocks) {
  const out = new Map();
  const todo = [];
  for (const b of blocks) {
    if (tsCache.has(b)) out.set(b, tsCache.get(b));
    else todo.push(b);
  }
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const b = todo[i++];
      try {
        const ts = Number((await client.getBlock({ blockNumber: BigInt(b) })).timestamp);
        out.set(b, ts);
        tsCache.set(b, ts);
        if (tsCache.size > 2_000) tsCache.delete(tsCache.keys().next().value);
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(TS_PAR, todo.length) }, worker));
  return out;
}

/** Add to the tape once (newest first, by block); a repeat only fills in a missing time. -> changed */
function feedAdd(e, same) {
  const old = L.feed.find(same);
  if (old) {
    if (old.at != null || e.at == null) return false;
    old.at = e.at;
    return true;
  }
  const b = BigInt(e.block);
  let i = 0;
  while (i < L.feed.length && BigInt(L.feed[i].block) > b) i++;
  if (i >= 200) return false;
  L.feed.splice(i, 0, e);
  if (L.feed.length > 200) L.feed.length = 200;
  if (e.at == null) untimed.add(e.block);
  return true;
}

const depositHooks = [];
/** Call fn(wallet) for every deposit the ledger reads (a wallet deposits before it can trade). */
export const onDeposit = (fn) => depositHooks.push(fn);

/** One event into the ledger. Applying it again changes nothing. -> changed */
function apply(log, times) {
  const a = log.args;
  const tx = log.transactionHash;
  const block = s(log.blockNumber);
  const k = Number(log.blockNumber) * 1e6 + (log.logIndex ?? 0); // order of events
  const at = times.get(block) ?? null;
  const id = a.id != null ? s(a.id) : null;
  const mk = a.marketId != null ? s(a.marketId) : null;
  const rid = a.rid != null ? s(a.rid) : null;
  const snap = () => JSON.stringify([id && L.pos[id], mk && L.markets[mk], rid && L.removes[rid]]);
  const was = snap();
  let fed = false;
  const p = id && (L.pos[id] ||= { id });
  switch (log.eventName) {
    case "Deposited":
      depositHooks.forEach((fn) => fn(lc(a.user))); // not journaled: the keeper looks the wallet's funder up early
      break;
    case "MarketAdded":
      L.markets[mk] = { token: lc(a.token), decimals: Number(a.decimals) };
      break;
    case "OpenRequested":
      Object.assign(p, {
        trader: lc(a.trader),
        marketId: mk,
        isLong: a.isLong,
        lev: Number(a.leverage),
        stake: s(a.stake),
        fee: s(a.fee),
        tp: s(a.tp),
        sl: s(a.sl),
        reqBlock: s(a.requestBlock),
        reqTx: tx,
      });
      index(byTrader, p.trader, id);
      break;
    case "PositionOpened":
      Object.assign(p, { entry: s(a.price), entryBlock: s(a.priceBlock), openTx: tx, openBlock: block, maxWin: s(a.maxWin), openAt: at ?? p.openAt ?? null });
      if (p.openAt == null) untimed.add(block);
      fed = feedAdd({ kind: "open", id, block, tx, at: p.openAt }, (x) => x.kind === "open" && x.id === id);
      break;
    case "CloseRequested":
      // only the latest close request's outcome counts: drop what an earlier one left
      if (!(p.closeReq?.k > k)) p.closeReq = { block: s(a.requestBlock), tx, k };
      if (p.closeRejected?.k < k) delete p.closeRejected;
      if (p.closeCancelled?.k < k) delete p.closeCancelled;
      break;
    case "PositionClosed":
      p.closed = { reason: REASONS[Number(a.reason)] || String(a.reason), price: s(a.price), pnl: s(a.pnl), payout: s(a.payout), block, tx, at: at ?? p.closed?.at ?? null };
      if (p.closed.at == null) untimed.add(block);
      fed = feedAdd({ kind: "close", id, block, tx, at: p.closed.at }, (x) => x.kind === "close" && x.id === id);
      break;
    case "RequestRejected":
      if (a.wasOpen) p.rejected = { code: Number(a.code), block, tx };
      else if (!(p.closeReq?.k > k)) p.closeRejected = { code: Number(a.code), block, tx, k };
      break;
    case "RequestCancelled":
      if (a.wasOpen) p.cancelled = { block, tx };
      else if (!(p.closeReq?.k > k)) p.closeCancelled = { block, tx, k };
      break;
    case "RemoveRequested": {
      // done stays: a replay must not reopen an executed or cancelled request
      const r = (L.removes[rid] ||= { rid, done: null });
      Object.assign(r, { lp: lc(a.lp), shares: s(a.shares), executableAt: Number(a.executableAt) });
      index(byLp, r.lp, rid);
      break;
    }
    case "RemoveExecuted":
      if (L.removes[rid]) Object.assign(L.removes[rid], { done: "executed", amount: s(a.amount) });
      break;
    case "RemoveCancelled":
      if (L.removes[rid]) L.removes[rid].done = "cancelled";
      break;
    case "RugFlagged":
      fed = feedAdd({ kind: "rug", marketId: mk, block, tx, at }, (x) => x.kind === "rug" && x.tx === tx && x.marketId === mk);
      break;
  }
  return fed || snap() !== was;
}

let span = 50_000n;

/** One step: re-read the last REWIND blocks and process up to `span` new ones. -> true if caught up with the head. */
async function step(head) {
  const from = L.to + 1n - REWIND > L.from ? L.to + 1n - REWIND : L.from;
  if (from > head) return true;
  const to = L.to + span < head ? L.to + span : head;
  let logs;
  try {
    logs = await client.getLogs({ address: CFG.pool, fromBlock: from, toBlock: to });
  } catch (e) {
    if (span > 500n) {
      span /= 4n; // the node refused the range: ask for less
      return false;
    }
    throw e;
  }
  const parsed = parseEventLogs({ abi: ABI, logs, strict: false }).filter((l) => EVENTS.has(l.eventName));
  // Elysium logs carry blockTimestamp; otherwise fetch the block (failures stay untimed and are retried later)
  const times = new Map();
  const need = new Set();
  for (const l of parsed) {
    if (!TIMED.has(l.eventName)) continue;
    const b = s(l.blockNumber);
    // Nitro nodes may report "0x0" for fresh blocks (seen on RH, markets.mjs): that is no time
    const ts = l.blockTimestamp != null ? Number(BigInt(l.blockTimestamp)) : 0;
    if (ts > 0) times.set(b, ts);
    else need.add(b);
  }
  for (const b of times.keys()) need.delete(b);
  if (need.size > 1_000 && span > 1_000n) {
    span /= 4n; // too many blocks to time in one step
    return false;
  }
  if (span < 200_000n) span *= 2n;
  for (const [b, ts] of await blockTimes([...need])) times.set(b, ts);
  let changed = false;
  for (const l of parsed) if (apply(l, times)) changed = true;
  if (changed) dirty = true;
  if (to > L.to) L.to = to;
  return to === head;
}

let backfillAt = 0;

/** Timestamps that failed earlier, at most every 10 s. */
async function backfill() {
  if (!untimed.size || Date.now() - backfillAt < 10_000) return;
  backfillAt = Date.now();
  const got = await blockTimes([...untimed].slice(0, 200));
  if (!got.size) return;
  const fill = (o, key, b) => {
    if (o[key] != null || !got.has(b)) return;
    o[key] = got.get(b);
    dirty = true;
  };
  for (const p of Object.values(L.pos)) {
    if (p.openBlock) fill(p, "openAt", p.openBlock);
    if (p.closed) fill(p.closed, "at", p.closed.block);
  }
  for (const x of L.feed) fill(x, "at", x.block);
  for (const b of got.keys()) untimed.delete(b);
}

export async function startLedger() {
  if (!CFG.pool) return;
  let loaded = false;
  for (;;) {
    try {
      if (!loaded) {
        await load();
        loaded = true;
      }
      const head = await client.getBlockNumber();
      if (L.from == null) {
        const d = await deployBlock(head);
        L.from = d.block;
        L.to = L.from - 1n;
        dirty = true;
        console.log(`[ledger] ${CFG.pool} deployed at block ${L.from} (${d.how})`);
      }
      const caught = await step(head);
      if (caught && !L.ready) {
        L.ready = true;
        console.log(`[ledger] caught up at ${L.to}: ${Object.keys(L.pos).length} positions`);
      }
      if (caught) await backfill();
      L.error = null;
      save(); // async, does not hold the loop
      if (caught) await sleep(1_000);
    } catch (e) {
      const msg = short(e);
      if (msg !== L.error) console.error(`[ledger] ${msg}`);
      L.error = msg;
      await sleep(e?.wait || 3_000);
    }
  }
}

export const tokenOf = (marketId) => L.markets[String(marketId)]?.token || null;
export const entryOf = (id) => L.pos[String(id)] || null;
export const removesOf = (lp) => [...(byLp.get(lc(lp)) || [])].map((rid) => L.removes[rid]).filter(Boolean);
export const idsOf = (trader) => [...(byTrader.get(lc(trader)) || [])];
// last write on a clean exit; `to` stays at the hashed block, the replay from there is idempotent
process.on("exit", () => {
  if (!dirty || !anchor) return;
  try {
    fs.writeFileSync(FILE() + ".exit", body(anchor.block, anchor.hash));
    fs.renameSync(FILE() + ".exit", FILE());
  } catch {}
});
