/**
 * The site's Real-mode API: everything the browser needs besides the wallet itself. Reads come from the pool's
 * storage (multicall), the keeper's book (positions polled every tick) and the ledger (events: refusals, closes,
 * LP exits). Nothing here signs. Amounts go out as floats in native units, for display only: the browser builds
 * every transaction from its own inputs and the contract stays the judge.
 */
import { parseAbi, zeroAddress } from "viem";
import { CFG } from "./config.mjs";
import { client, net } from "./chain.mjs";
import * as M from "./markets.mjs";
import * as KP from "./keeper/keeper.mjs";
import * as D from "./keeper/decide.mjs";
import { POOL_ABI, SRC_ABI, ABI } from "./abi.mjs";
import { L, tokenOf, removesOf, idsOf } from "./keeper/ledger.mjs";
import { UserError } from "./paper.mjs";

const lc = (a) => (a || "").toLowerCase();
const f = (w) => (w == null ? null : Number(w) / 1e18);
const BPS = 10_000n;
const nowS = () => Math.floor(Date.now() / 1000);
const MC3_ABI = parseAbi(["function getCurrentBlockTimestamp() view returns (uint256)"]);

/** What a refusal code means, for the trader (codes: keeper/decide.mjs CODES). */
export const WHY = {
  1: "the coin no longer passes the listing rules",
  2: "too large for the coin's depth right now",
  3: "over the stake limit or the pool's limit for this coin",
  4: "leverage above what the coin allows right now",
  5: "the market is locked",
  6: "no fresh price from the coin's pool",
  7: "the fill window passed without a usable price",
  8: "new trades are paused",
  9: "the price left the on-chain band during the window",
  10: "new accounts trade smaller stakes in their first day",
  11: "shorts of this coin are limited: too much of its supply sits with a few holders",
  12: "you already hold the other side of this coin",
};

const STATUS = ["none", "pending-open", "open", "pending-close", "closed", "cancelled"];

/** Pool reads in one eth_call (plus `extra` contracts, same block). */
const mc = (fns, extra = []) =>
  client.multicall({
    contracts: [...fns.map(([functionName, args = []]) => ({ address: CFG.pool, abi: POOL_ABI, functionName, args })), ...extra],
    allowFailure: false,
  });

function need() {
  if (!CFG.pool) throw new UserError("real mode is not configured on this server");
  if (!KP.K.params) throw new UserError("the engine is still connecting to the pool");
}

// ───────────────────────────── config ─────────────────────────────

export function config() {
  const P = KP.K.params;
  return {
    enabled: !!CFG.pool && !!P,
    pool: CFG.pool,
    adapter: KP.K.adapter,
    chainId: CFG.chainId,
    chainName: CFG.name,
    native: CFG.native,
    testnet: /testnet/i.test(CFG.name),
    rpc: CFG.publicRpc,
    explorer: CFG.explorer,
    sessionGas: CFG.sessionGas,
    keeperHere: KP.K.enabled,
    ledgerReady: L.ready,
    params: P && {
      minStake: f(P.minStake),
      openFeeBps: Number(P.openFeeBps),
      closeFeeBps: Number(P.closeFeeBps),
      maxWinBps: Number(P.maxWinBps),
      minHold: Number(P.minHold),
      cancelDelay: Number(P.cancelDelay),
      removeDelay: Number(P.removeDelay),
      removeWindow: Number(P.removeWindow),
      maxPoolCash: f(P.maxPoolCash),
    },
    policy: CFG.policy,
    why: WHY,
  };
}

let abiCache;
export const abi = () => (abiCache ||= ABI.filter((x) => x.type === "function" || x.type === "event" || x.type === "error"));

// ───────────────────────────── pool ─────────────────────────────

const DAY = 86_400;
const posOf = (id) => KP.K.positions.get(BigInt(id));
const symbolOf = (token) => M.tokens.get(token)?.symbol || "?";

/**
 * InversePool._keeperSilent(delay): silent by the clock AND, with keeperBlockRate on, by L2 blocks. Inputs come
 * from one eth_call, the same context a simulated executeRemove sees.
 */
export function keeperSilent(delay, rate, { ts, lastAt, block, lastBlock }) {
  if (ts < lastAt + delay) return false;
  return rate === 0n || block >= lastBlock + (delay * rate) / 3600n;
}

/** The pool as the front page shows it (same keys as the Practice book's poolStats). */
async function poolNow() {
  need();
  const P = KP.K.params;
  const [cash, navV, reserved, openStake, shares, prize, paused, opensAllowed, lpGate, lastKeeper, asOf, lastKeeperBlock, l2Block, chainTs] =
    await mc(
      [
        ["poolCash"],
        ["nav"],
        ["totalReserved"],
        ["totalOpenStake"],
        ["totalShares"],
        ["prizePool"],
        ["paused"],
        ["opensAllowed"],
        ["lpGate"],
        ["lastKeeperActivity"],
        ["reportedAsOf"],
        ["lastKeeperBlock"],
        ["blockNumber"],
      ],
      [{ address: net.contracts.multicall3.address, abi: MC3_ABI, functionName: "getCurrentBlockTimestamp" }],
    );
  const oi = { long: 0, short: 0 };
  let open = 0;
  for (const p of KP.K.positions.values()) {
    if (p.status !== KP.ST.Open && p.status !== KP.ST.PendingClose) continue;
    open++;
    oi[p.isLong ? "long" : "short"] += f(p.stake) * Number(p.leverage);
  }
  // from the whole ledger, not the 200-event tape
  const since = nowS() - DAY;
  const all = Object.values(L.pos);
  const opens = all.filter((p) => p.openAt >= since);
  const closes = all.filter((p) => p.closed?.at >= since);
  const wins = closes.filter((p) => BigInt(p.closed.pnl) > 0n);
  const best = wins.reduce((b, p) => (!b || BigInt(p.closed.pnl) > BigInt(b.closed.pnl) ? p : b), null);
  return {
    cash: f(cash),
    nav: f(navV),
    reservedMaxWin: f(reserved),
    openStake: f(openStake),
    totalShares: String(shares),
    longNotional: oi.long,
    shortNotional: oi.short,
    openPositions: open,
    volume24: opens.reduce((s, p) => s + (f(p.stake) || 0), 0),
    trades24: opens.length + closes.length,
    paidToWinners24: wins.reduce((s, p) => s + f(p.closed.pnl), 0),
    best24: best && { symbol: symbolOf(tokenOf(best.marketId)), side: best.isLong ? "long" : "short", lev: best.lev, pnl: f(best.closed.pnl) },
    weeklyPot: f(prize),
    paused: paused || !opensAllowed,
    lpGate,
    maxPoolCash: f(P.maxPoolCash),
    keeperSeenS: Number(lastKeeper),
    // executeRemove waives the LP delay and expiry now
    keeperGone: keeperSilent(BigInt(P.lpEmergencyDelay), BigInt(P.keeperBlockRate), {
      ts: BigInt(chainTs),
      lastAt: BigInt(lastKeeper),
      block: BigInt(l2Block),
      lastBlock: BigInt(lastKeeperBlock),
    }),
    reportedAsOf: Number(asOf),
    history: [],
  };
}

// ───────────────────────────── one trader ─────────────────────────────

async function tokenFor(marketId) {
  const t = tokenOf(marketId);
  if (t) return t;
  try {
    return (await KP.marketOf(BigInt(marketId))).token;
  } catch {
    return null;
  }
}

/**
 * The engine coin of a listed market, priced from the pool the market is bound to on-chain (keeper.pinMarket), or
 * null while that binding is unknown: never another pool of the same coin.
 */
async function boundCoin(marketId) {
  try {
    const t = await KP.pinMarket(BigInt(marketId));
    return t && t.primary && t.primary === t.pinned && t.decimals != null ? t : null;
  } catch {
    return null;
  }
}

/** Status index: the keeper's book when it holds the position, else the ledger. */
const statusOf = (p, e) => (p ? p.status : e.closed ? 4 : e.cancelled || e.rejected ? 5 : e.entry ? 2 : 1);

/** The book already says closed / cancelled but the ledger has not applied the matching event yet. */
const settlingOf = (p, e) => !!p && ((p.status === 4 && !e.closed) || (p.status === 5 && !e.rejected && !e.cancelled));

/** A position as the site shows it: live status from the keeper's book, the story from the ledger. */
async function view(id) {
  const p = posOf(id);
  const e = L.pos[String(id)] || {};
  if (!p && !e.trader) return null;
  const marketId = p ? p.marketId : e.marketId;
  const token = await tokenFor(marketId);
  const status = statusOf(p, e);
  const P = KP.K.params;
  const out = {
    id: String(id),
    token,
    symbol: symbolOf(token),
    side: (p ? p.isLong : e.isLong) ? "long" : "short",
    lev: Number(p ? p.leverage : e.lev),
    stake: f(p ? p.stake : e.stake),
    status: STATUS[status],
    entry: f(p?.entryPrice || e.entry) || null,
    tp: f(p?.tp || e.tp) || null,
    sl: f(p?.sl || e.sl) || null,
    requestTime: p ? Number(p.requestTime) : null,
    openTime: p && p.openTime ? Number(p.openTime) : null,
    canCloseAt: p && p.openTime ? Number(p.openTime) + Number(P.minHold) : null,
    canCancelAt: p && (status === 1 || status === 3) ? Number(p.requestTime) + Number(P.cancelDelay) : null,
    reqTx: e.reqTx || null,
    openTx: e.openTx || null,
  };
  if (settlingOf(p, e)) out.settling = true; // the reason / payout follows within a ledger step
  if (e.rejected) out.rejected = { code: e.rejected.code, why: WHY[e.rejected.code] || `code ${e.rejected.code}` };
  // a close outcome counts only once the ledger holds the book's latest close request, never an earlier attempt's
  const ledgerReq = e.closeReq?.block != null ? BigInt(e.closeReq.block) : null;
  const closeKnown = status === 2 && !(p && ledgerReq != null && BigInt(p.requestBlock) > ledgerReq);
  if (e.closeRejected && closeKnown) out.closeRejected = { code: e.closeRejected.code, why: WHY[e.closeRejected.code] || `code ${e.closeRejected.code}` };
  if (e.closeCancelled && closeKnown) out.closeCancelled = true;
  if (e.cancelled) out.cancelled = true;
  if (e.closed) out.closed = { reason: e.closed.reason, price: f(e.closed.price), pnl: f(e.closed.pnl), payout: f(e.closed.payout), at: e.closed.at, tx: e.closed.tx };
  if (p && (status === 2 || status === 3) && p.entryPrice) {
    // unknown (null) until the market's bound pool is pinned
    out.mark = null;
    out.pnl = null;
    const t = await boundCoin(marketId);
    const s = t && M.spot(t);
    if (s) {
      const m = await KP.marketOf(BigInt(marketId)).catch(() => null);
      const pnl = D.clampedPnl(p, D.toWad(s), { rugLocked: !!m && Number(m.lockedUntil) > nowS(), rugCapBps: BigInt(P.rugCapBps) });
      out.mark = s;
      out.pnl = f(pnl);
    }
  }
  return out;
}

const SETTLING_MAX = 20;
const HISTORY_MAX = 60;

async function accountNow(trader) {
  need();
  trader = lc(trader);
  const [bal, sess, shares, allowed, ref, navV, totalShares] = await mc([
    ["balanceOf", [trader]],
    ["sessionOf", [trader]],
    ["sharesOf", [trader]],
    ["lpAllowed", [trader]],
    ["referrerOf", [trader]],
    ["nav"],
    ["totalShares"],
  ]);
  const ids = new Set(idsOf(trader));
  for (const [id, p] of KP.K.positions) if (lc(p.trader) === trader) ids.add(String(id));
  // split first, cap after: every live position is shown however old; only history is cut
  const openIds = [];
  const doneIds = [];
  let settling = 0;
  for (const id of [...ids].sort((a, b) => Number(b) - Number(a))) {
    const p = posOf(id);
    const e = L.pos[id] || {};
    const s = statusOf(p, e);
    if ((s >= 1 && s <= 3) || (settlingOf(p, e) && settling++ < SETTLING_MAX)) openIds.push(id);
    else if (doneIds.length < HISTORY_MAX) doneIds.push(id);
  }
  const [open, history] = await Promise.all([openIds, doneIds].map(async (xs) => (await Promise.all(xs.map(view))).filter(Boolean)));
  return {
    trader,
    balance: f(bal),
    session: { key: lc(sess[0]), expiry: Number(sess[1]) },
    referrer: lc(ref),
    lp: {
      shares: String(shares),
      value: totalShares ? f((shares * navV) / totalShares) : 0,
      allowed,
      removes: removesOf(trader)
        .filter((r) => !r.done)
        .map((r) => ({ rid: r.rid, shares: r.shares, value: totalShares ? f((BigInt(r.shares) * navV) / totalShares) : 0, executableAt: r.executableAt })),
    },
    open,
    history,
    ledgerReady: L.ready,
  };
}

// ───────────────────────────── one market ─────────────────────────────

/** Spot and 30-s average (native per token, like /api/market's priceEth / twapEth) of an engine coin, or nulls. */
function prices(t) {
  const spot = t ? M.spot(t) : null;
  if (!(spot > 0) || !isFinite(spot)) return { spot: null, twap: null };
  const twap = M.twap(t);
  return { spot, twap: twap > 0 && isFinite(twap) ? twap : null };
}

/** false only for a market that needs a V4SpotSource feed and has none (every fill would revert NoFeed). */
async function fedOf(m, id) {
  const adapter = lc(KP.K.adapter);
  if (lc(m.v3Pool) !== zeroAddress || lc(m.priceAdapter) !== zeroAddress || !adapter || adapter === zeroAddress) return true;
  const [manager] = await KP.read("feeds", [id], adapter, SRC_ABI);
  return lc(manager) !== zeroAddress;
}

/** The insider limit on this coin's shorts, for the ticket: null when shorts are not limited. */
function shortLimit(token) {
  const t = KP.shortTier(token);
  if (!t.tier) return null;
  return { maxLev: t.maxLev, share: t.share, counted: t.state === "ready", halfNotional: t.notionalDiv > 1n, maxWinPoolBps: Number(t.maxWinPoolBps), why: t.why };
}

/** Is the coin listed for real money, and how much room is left on each side (the ticket's "room"). */
async function marketNow(token) {
  need();
  token = lc(token);
  const id = await KP.read("marketIdOf", [token]);
  if (id === 0n) {
    // not listed: the engine's primary pool is what the keeper would bind at listing
    const t = M.tokens.get(token);
    return { listed: false, canList: KP.K.enabled, ...prices(t?.primary ? t : null) };
  }
  const m = await KP.marketOf(id);
  const [[cash, navV, reserved], t, fed] = await Promise.all([mc([["poolCash"], ["nav"], ["totalReserved"]]), boundCoin(id), fedOf(m, id)]);
  const P = KP.K.params;
  let long = null; // room stays unknown until the bound pool is pinned
  let short = null;
  if (t) {
    const base = cash < navV ? cash : navV;
    const pl = M.pools.get(t.primary);
    let cap = D.notionalCap(t.d10 || 0, KP.feePips(pl), CFG.rules.notionalPctOfD10);
    const capMax = BigInt(P.notionalCapMax);
    if (capMax && cap > capMax) cap = capMax;
    const mkWin = (base * BigInt(P.marketLiabilityBps)) / BPS;
    const totWin = (base * BigInt(P.totalLiabilityBps)) / BPS;
    const totRoom = totWin > reserved ? totWin - reserved : 0n;
    const tier = KP.shortTier(token);
    const poolWin = (base * tier.maxWinPoolBps) / BPS; // shorts of a concentrated coin: a smaller share of the pool
    const side = (isLong) => {
      const notional = BigInt(isLong ? m.notionalLong : m.notionalShort);
      if (!isLong && tier.tier) {
        const c = cap / tier.notionalDiv;
        const w = BigInt(m.maxWinShort);
        const room = tier.maxWinPoolBps ? (poolWin > w ? poolWin - w : 0n) : mkWin > w ? mkWin - w : 0n;
        return { notional: f(c > notional ? c - notional : 0n), maxWin: f(room < totRoom ? room : totRoom) };
      }
      const win = BigInt(isLong ? m.maxWinLong : m.maxWinShort);
      const winRoom = mkWin > win ? mkWin - win : 0n;
      return { notional: f(cap > notional ? cap - notional : 0n), maxWin: f(winRoom < totRoom ? winRoom : totRoom) };
    };
    long = side(true);
    short = side(false);
  }
  return {
    listed: true,
    marketId: String(id),
    enabled: m.enabled,
    lockedUntil: Number(m.lockedUntil),
    maxWinBps: Number(P.maxWinBps),
    long,
    short,
    shortLimit: shortLimit(token),
    fed,
    canList: KP.K.enabled,
    ...prices(t),
  };
}

// ───────────────────────────── tape and wins ─────────────────────────────

export function feed() {
  return L.feed
    .filter((x) => x.kind !== "rug")
    .slice(0, 40)
    .map((x) => {
      const p = L.pos[x.id];
      if (!p) return null;
      return {
        kind: x.kind,
        symbol: symbolOf(tokenOf(p.marketId)),
        side: p.isLong ? "long" : "short",
        lev: p.lev,
        stake: f(p.stake),
        pnl: x.kind === "close" ? f(p.closed?.pnl) : null,
        t: (x.at || 0) * 1000,
      };
    })
    .filter(Boolean);
}

async function winsNow() {
  need();
  const now = new Date();
  const weekStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)) / 1000);
  const closed = Object.values(L.pos).filter((p) => p.closed && p.closed.at);
  const top = closed
    .filter((p) => p.closed.at >= nowS() - DAY && BigInt(p.closed.pnl) > 0n)
    .sort((a, b) => (BigInt(b.closed.pnl) > BigInt(a.closed.pnl) ? 1 : -1))
    .slice(0, 10)
    .map((p) => ({ symbol: symbolOf(tokenOf(p.marketId)), side: p.isLong ? "long" : "short", lev: p.lev, pnl: f(p.closed.pnl), acct: p.trader }));
  const by = new Map();
  for (const p of closed) if (p.closed.at >= weekStart) by.set(p.trader, (by.get(p.trader) || 0) + f(p.closed.pnl));
  const board = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([acct, pnl]) => ({ acct, pnl }));
  const { weeklyPot } = await cached("pool", 2_000, poolNow); // the pool read already holds prizePool
  return { top, board, pot: weeklyPot };
}

// ───────────────────────────── rate limits ─────────────────────────────

/** Thrown when a client (or everyone together) spends too fast: HTTP 429 on the /api routes. */
export class RateLimited extends Error {}

/**
 * Token buckets by client key (server.mjs: IP, IPv6 by /64). Past `max` keys the least recently used go first,
 * one by one: never a wholesale reset that hands every client a full bucket.
 */
function buckets(cap, perS, max = 10_000) {
  const map = new Map();
  return (key, n) => {
    const t = Date.now();
    const b = map.get(key) || { tokens: cap, t };
    b.tokens = Math.min(cap, b.tokens + ((t - b.t) / 1000) * perS);
    b.t = t;
    map.delete(key);
    map.set(key, b); // most recently used last
    if (map.size > max) map.delete(map.keys().next().value);
    if (b.tokens < n) return false;
    b.tokens -= n;
    return true;
  };
}
// /api/rpc: per client, and for everyone together so a crowd of addresses cannot drain the keeper's provider
const rpcClient = buckets(120, 12);
const rpcAll = buckets(400, 150, 1);
// /api/real/* cache misses (a Real tab misses the 1-s account cache ~0.7/s), /api/market lookups, listing requests
const apiClient = buckets(60, 6);
const apiAll = buckets(300, 100, 1);

/** Charge `n` upstream-bound requests to a client; throws RateLimited. */
export function spendApi(ip, n = 1) {
  if (!apiClient(ip || "?", n) || !apiAll("*", n)) throw new RateLimited("too many requests: slow down");
}

// ───────────────────────────── RPC relay ─────────────────────────────

/**
 * A narrow JSON-RPC relay for the browser's session key and reads, so the site never needs CORS on a public node
 * and never sees CFG.rpc (it may carry a provider key). Signed transactions pass through untouched; eth_call and
 * eth_estimateGas only reach the pool and its adapter (estimateGas also prices a plain transfer, the session-key
 * sweep), never with state overrides. Per-client and global token buckets.
 */
const RPC_OK = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBalance",
  "eth_getTransactionCount",
  "eth_getBlockByNumber",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_sendRawTransaction",
]);
const PLAIN_GAS = "0x30d40"; // 200k: the most a plain-transfer estimate may run (a contract's fallback included)
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(a);

/**
 * A refused call gets a JSON-RPC error, not an HTTP one: clients treat "method not found" as "unsupported" and fall
 * back (viem tries eth_fillTransaction first). viem does not retry HTTP 400, so it is kept for malformed bodies.
 */
function refusal(r) {
  if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.method !== "string") return [-32600, "invalid request"];
  if (!RPC_OK.has(r.method)) return [-32601, `method not available here: ${r.method.slice(0, 40)}`];
  if (r.params != null && !Array.isArray(r.params)) return [-32602, "invalid params"];
  if (r.method === "eth_call" || r.method === "eth_estimateGas") {
    const p = r.params || [];
    if (p.length > 2) return [-32602, "state and block overrides are not relayed"];
    const tx = p[0];
    if (!tx || typeof tx !== "object" || Array.isArray(tx)) return [-32602, "invalid params"];
    const to = typeof tx.to === "string" ? lc(tx.to) : "";
    if (relay.callable.has(to)) return null;
    if (r.method === "eth_call") return [-32602, "eth_call only reaches the Styx contracts"];
    const empty = (d) => d == null || d === "0x"; // a node may read either field
    if (!isAddr(to) || !empty(tx.data) || !empty(tx.input)) return [-32602, "eth_estimateGas only prices Styx calls and plain transfers"];
  }
  return null;
}

const rpcError = (r, code, message) => ({ jsonrpc: "2.0", id: r?.id ?? null, error: { code, message } });

/**
 * Transient trouble (our limits, the upstream failing or timing out) is a JSON-RPC error at HTTP 200, per request,
 * which viem retries: -32005 limit exceeded, -32603 upstream failure. HTTP 400 is left for malformed bodies.
 */
export async function relay(body, ip) {
  if (!CFG.pool) throw new UserError("real mode is not configured on this server");
  const batch = Array.isArray(body);
  const reqs = batch ? body : [body];
  if (!reqs.length || reqs.length > 20) throw new UserError("bad rpc request");
  const answer = (out) => (batch ? out : out[0]);
  if (!rpcClient(ip || "?", reqs.length)) return answer(reqs.map((r) => rpcError(r, -32005, "limit exceeded")));
  relay.callable = new Set([CFG.pool, lc(KP.K.adapter)].filter((a) => a && a !== zeroAddress));
  const out = new Array(reqs.length);
  let pass = [];
  reqs.forEach((r, i) => {
    const no = refusal(r);
    if (no) return (out[i] = rpcError(r, no[0], no[1]));
    if (r.method === "eth_getBlockByNumber" && r.params) r.params[1] = false; // headers only
    if (r.method === "eth_estimateGas" && !relay.callable.has(lc(r.params[0].to))) r.params[0] = { ...r.params[0], gas: PLAIN_GAS };
    pass.push(i);
  });
  if (pass.length && !rpcAll("*", pass.length)) {
    for (const i of pass) out[i] = rpcError(reqs[i], -32005, "limit exceeded");
    pass = [];
  }
  if (pass.length) {
    // forwarded under our own ids (position in `pass`), answered under the caller's
    const fwd = pass.map((i, k) => ({ jsonrpc: "2.0", method: reqs[i].method, params: reqs[i].params ?? [], id: k }));
    let got = [];
    let loose = false; // HTTP 200: a lone answer is the lone call's
    let fail = [-32603, "the chain's RPC did not answer"];
    try {
      const r = await fetch(CFG.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch ? fwd : fwd[0]),
        signal: AbortSignal.timeout(20_000), // under the site's own 30-s transport timeout
      });
      if (r.status === 429) fail = [-32005, "limit exceeded"];
      else if (!r.ok) fail = [-32603, `the chain's RPC answered HTTP ${r.status}`];
      const j = await r.json().catch(() => null);
      if (r.status !== 429) got = Array.isArray(j) ? j : j ? [j] : []; // a 429 body is the gateway's, not the node's
      loose = r.ok;
    } catch {}
    const valid = got.filter((x) => x && typeof x === "object" && ("result" in x || "error" in x));
    const byId = new Map(valid.map((x) => [String(x.id), x]));
    // one call forwarded, one answer: it is that call's, whatever id the node put on it (an error may carry null)
    const only = loose && pass.length === 1 && valid.length === 1 ? valid[0] : null;
    pass.forEach((i, k) => {
      const x = byId.get(String(k)) ?? only;
      const id = reqs[i].id ?? null;
      out[i] = !x ? rpcError(reqs[i], ...fail) : x.error != null ? { jsonrpc: "2.0", id, error: x.error } : { jsonrpc: "2.0", id, result: x.result };
    });
  }
  return answer(out);
}
relay.callable = new Set();

// ───────────────────────────── short caches ─────────────────────────────
// Every open tab polls; one chain read per key and TTL serves them all. Errors are not cached. A read still in flight
// is shared past its TTL (a slow upstream must not pile up reads). Only a miss is charged to the client's bucket.
const CACHE_MAX = 5_000;
const SHARED = new Set(["pool", "wins"]); // never evicted for per-address keys
const cache = new Map();
function cached(key, ttl, fn, ip) {
  const hit = cache.get(key);
  if (hit && (!hit.done || Date.now() - hit.t < ttl)) return hit.p;
  if (ip !== undefined) spendApi(ip);
  const e = { t: Date.now(), done: false, p: null };
  e.p = fn().then(
    (v) => ((e.done = true), v),
    (err) => {
      if (cache.get(key) === e) cache.delete(key);
      throw err;
    },
  );
  cache.delete(key);
  cache.set(key, e);
  if (cache.size > CACHE_MAX) {
    for (const k of cache.keys()) {
      if (SHARED.has(k)) continue;
      cache.delete(k); // the oldest
      break;
    }
  }
  return e.p;
}
export const pool = (ip) => cached("pool", 2_000, poolNow, ip ?? "?");
export const account = (trader, ip) => cached("acct:" + lc(trader), 1_000, () => accountNow(trader), ip ?? "?");
export const market = (token, ip) => cached("mkt:" + lc(token), 2_000, () => marketNow(token), ip ?? "?");
export const wins = (ip) => cached("wins", 5_000, winsNow, ip ?? "?");
/** A listing just landed: the next market read must see it. */
export const forgetMarket = (token) => cache.delete("mkt:" + lc(token));
