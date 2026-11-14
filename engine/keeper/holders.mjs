/**
 * Who holds a coin, for the insider short limiter (STYX-ELYSIUM §3.2). The coin's whole Transfer history is read once
 * (the range is split in two wherever the node's log cap is hit), then kept current from the last block read.
 * Balances stay in memory; a restart reads them again. Nothing here signs or sends.
 */
import { keccak256, toHex } from "viem";
import { CFG } from "../config.mjs";
import { client } from "../chain.mjs";
import * as M from "../markets.mjs";
import * as D from "./decide.mjs";

const TRANSFER = keccak256(toHex("Transfer(address,address,uint256)"));
const ZERO = "0x" + "0".repeat(40);
const BURN = [ZERO, "0x000000000000000000000000000000000000dead", "0x0000000000000000000000000000000000000001"];
const MAX_LOGS = 600_000; // a coin with more transfers than this is not counted (its shorts stay on the strictest tier)
const REFRESH_MS = 60_000;
const RETRY_MS = 5 * 60_000;
const lc = (a) => (a || "").toLowerCase();
const addrOf = (topic) => "0x" + topic.slice(26).toLowerCase();

const H = new Map(); // token -> { state, balances, minted, to, logs, share, holders, at, error, job }

/**
 * Transfer logs of one token in [from, to], oldest first. The whole range is asked for first (one request for most
 * coins); where the node refuses a window (too many logs) the window shrinks to a quarter, and it grows again while
 * the answers stay small. A refusal costs a round trip (and seconds on an anvil fork, which retries it), so the
 * window is walked forward rather than halved recursively: a handful of refusals instead of one per split.
 */
export async function transferLogs(token, from, to, getLogs, budget = { left: MAX_LOGS }) {
  const out = [];
  let span = to - from + 1n;
  for (let cur = from; cur <= to; ) {
    const end = cur + span - 1n < to ? cur + span - 1n : to;
    let part;
    try {
      part = await getLogs({ address: token, fromBlock: toHex(cur), toBlock: toHex(end), topics: [TRANSFER] });
    } catch (e) {
      if (span <= 1n) throw e; // a single block the node will not serve: not a size problem
      span = span / 4n || 1n;
      continue;
    }
    budget.left -= part.length;
    if (budget.left < 0) throw new Error("too many transfers to count");
    for (const l of part) out.push(l);
    cur = end + 1n;
    if (part.length < 2_000) span *= 2n;
  }
  return out;
}

/** Apply ERC-20 Transfer logs to balances (ERC-721 transfers carry four topics and are skipped). */
export function applyTransfers(h, logs) {
  for (const l of logs) {
    if (l.topics.length !== 3 || l.data.length < 66) continue;
    const from = addrOf(l.topics[1]);
    const to = addrOf(l.topics[2]);
    const v = BigInt(l.data.slice(0, 66));
    if (from === ZERO) h.minted.add(to);
    else h.balances.set(from, (h.balances.get(from) || 0n) - v);
    if (to !== ZERO) h.balances.set(to, (h.balances.get(to) || 0n) + v);
  }
  h.logs += logs.length;
}

/** Addresses whose balance is not an insider's: burn, the token itself, pools, PoolManagers, configured lockers / bridge. */
function excluded(token) {
  const x = new Set([...BURN, token, ...CFG.poolManagers, ...CFG.holderExclude]);
  for (const k of M.tokens.get(token)?.pools || []) if (k.length === 42) x.add(k);
  return x;
}

async function scan(token, h) {
  const head = await client.getBlockNumber();
  const from = h.to == null ? 0n : h.to + 1n;
  if (from <= head) {
    // no retries: the node's "too many logs" refusal is the signal to split the range, not a hiccup to wait out
    const getLogs = (f) => client.request({ method: "eth_getLogs", params: [f] }, { retryCount: 0 });
    applyTransfers(h, await transferLogs(token, from, head, getLogs, { left: MAX_LOGS - h.logs }));
    h.to = head;
  }
  const r = D.insiderShare(h.balances, { minted: h.minted, exclude: excluded(token) });
  h.share = r?.share ?? null;
  h.holders = r?.holders ?? [];
  h.state = r ? "ready" : "failed";
  h.error = r ? null : "no supply";
}

/** Start counting a coin's holders, or bring the count up to date (at most once a minute). Never throws. */
export function track(token) {
  token = lc(token);
  let h = H.get(token);
  if (!h) {
    h = { state: "scanning", balances: new Map(), minted: new Set(), to: null, logs: 0, share: null, holders: [], at: 0, error: null, job: null };
    H.set(token, h);
  }
  if (h.job || Date.now() - h.at < (h.state === "failed" ? RETRY_MS : REFRESH_MS)) return;
  h.job = scan(token, h)
    .catch((e) => {
      // a half-applied history is worthless: start over next time
      Object.assign(h, { state: "failed", error: String(e?.shortMessage || e?.message || e).split("\n")[0], balances: new Map(), minted: new Set(), to: null, logs: 0, share: null, holders: [] });
      console.warn(`[holders] ${token}: ${h.error}`);
    })
    .finally(() => {
      h.at = Date.now();
      h.job = null;
    });
}

/** -> { state: "ready" | "scanning" | "failed", share: 0..1 | null, holders: [[address, share]], at } | null (not tracked) */
export function shareOf(token) {
  const h = H.get(lc(token));
  return h ? { state: h.state, share: h.state === "ready" ? h.share : null, holders: h.holders, at: h.at, error: h.error } : null;
}
