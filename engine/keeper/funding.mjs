/**
 * Who first funded a wallet, for the wallet clusters (STYX-ELYSIUM §3.2): wallets with common funding trade as one
 * (one side per coin, one new-account allowance). Read from the chain alone: the first block in which the wallet has a
 * balance or a nonce (a k-ary search over historical state), then the plain transfer that paid it in that block.
 * Bridge deposits, transfers made inside contracts and funders that are contracts link nobody (-> null).
 * Answers are kept in engine/data/funders-<chainId>.json: a wallet's first funder never changes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toHex } from "viem";
import { CFG } from "../config.mjs";
import { client } from "../chain.mjs";
import * as D from "./decide.mjs";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", `funders-${CFG.chainId}.json`);
const FANOUT = 8; // historical-state probes per search round (~8 rounds over 10M blocks, two calls per probe)
const PLAIN = new Set(["0x0", "0x1", "0x2"]); // legacy / access-list / 1559: not a bridge deposit or a retryable
const lc = (a) => (a || "").toLowerCase();

const links = new Map(); // wallet -> funder | null (resolved)
const jobs = new Map(); // wallet -> lookup in progress
const failures = new Map(); // wallet -> failed lookups
let version = 0;
let tail = Promise.resolve(); // the lookup queue (every job ends resolved: failures are caught inside it)
let cached = { version: -1, map: new Map() };
let saveTimer = null;

try {
  for (const [w, f] of Object.entries(JSON.parse(fs.readFileSync(FILE, "utf8")))) links.set(w, f);
} catch {}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(links)));
    } catch (e) {
      console.warn("[funding] save:", e.message);
    }
  }, 2_000);
  saveTimer.unref?.();
}

/**
 * The first funder of `wallet`. rpc(method, params) is the JSON-RPC transport (injected for tests).
 * -> lowercase address | null (never funded, funded by a contract or a bridge deposit, or nothing plain to see)
 */
export async function firstFunder(wallet, rpc, head) {
  wallet = lc(wallet);
  const alive = async (b) => {
    const tag = toHex(b);
    const [bal, n] = await Promise.all([rpc("eth_getBalance", [wallet, tag]), rpc("eth_getTransactionCount", [wallet, tag])]);
    return BigInt(bal) > 0n || BigInt(n) > 0n;
  };
  if (!(await alive(head))) return null;
  // invariant: not alive at lo - 1 (or lo = 0), alive at hi
  let lo = 0n;
  let hi = head;
  while (lo < hi) {
    const step = (hi - lo) / BigInt(FANOUT + 1);
    const pts = [];
    for (let i = 1; i <= FANOUT; i++) {
      const p = lo + step * BigInt(i);
      if (p >= lo && p < hi && !pts.includes(p)) pts.push(p);
    }
    if (!pts.length) pts.push(lo);
    const seen = await Promise.all(pts.map(alive));
    const first = seen.indexOf(true);
    if (first === -1) lo = pts[pts.length - 1] + 1n;
    else {
      hi = pts[first];
      if (first > 0) lo = pts[first - 1] + 1n;
    }
  }
  const blk = await rpc("eth_getBlockByNumber", [toHex(lo), true]);
  const tx = (blk?.transactions || []).find((t) => lc(t.to) === wallet && BigInt(t.value || "0x0") > 0n && PLAIN.has(t.type) && lc(t.from) !== wallet);
  if (!tx) return null;
  const funder = lc(tx.from);
  const code = await rpc("eth_getCode", [funder, "latest"]);
  return code && code !== "0x" ? null : funder;
}

/** Start (or join) the lookup of a wallet. Never throws: an RPC failure leaves the wallet unresolved, to be retried. */
export function warm(wallet) {
  wallet = lc(wallet);
  if (links.has(wallet) || jobs.has(wallet)) return jobs.get(wallet) || Promise.resolve();
  const rpc = (method, params) => client.request({ method, params });
  // one lookup at a time: a burst of deposits must not turn into hundreds of parallel archive reads (public nodes
  // answer 429, an anvil fork stops answering at all)
  const job = tail
    .then(() => client.getBlockNumber())
    .then((head) => firstFunder(wallet, rpc, head))
    .then((f) => {
      links.set(wallet, f);
      version++;
      save();
    })
    .catch((e) => {
      // a node without historical state would otherwise refuse every first order: after two failures the wallet
      // trades as its own cluster until the engine restarts (not saved, so it is looked up again then)
      const n = (failures.get(wallet) || 0) + 1;
      failures.set(wallet, n);
      console.warn(`[funding] ${wallet}: ${String(e?.shortMessage || e?.message || e).split("\n")[0]}${n >= 2 ? " (giving up: it trades unclustered)" : ""}`);
      if (n >= 2) {
        links.set(wallet, null);
        version++;
      }
    })
    .finally(() => jobs.delete(wallet));
  tail = job;
  jobs.set(wallet, job);
  return job;
}

/** Is the wallet's funder known (so its cluster can be trusted)? */
export const resolved = (wallet) => links.has(lc(wallet));

/** The cluster id of a wallet: equal ids trade as one. An unresolved wallet is its own cluster. */
export function clusterOf(wallet) {
  wallet = lc(wallet);
  if (cached.version !== version) cached = { version, map: D.clusters(links, { exclude: CFG.clusterExclude, hub: CFG.clusterHub }) };
  return cached.map.get(wallet) || wallet;
}

export const stats = () => ({ wallets: links.size, linked: [...links.values()].filter(Boolean).length, pending: jobs.size });
