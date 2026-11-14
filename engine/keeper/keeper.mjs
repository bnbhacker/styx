/**
 * Styx keeper (InversePool v1.1). Runs inside the engine when STYX_POOL is set and a key is available:
 *  - fills pending opens and USER closes inside the contract's execution window, at the engine's
 *    worse-of(spot, 30-s average) price taken ONLY from the pool the market is bound to on-chain;
 *  - fits that price to the on-chain band one-sidedly (only ever worse for the trader, never better);
 *  - rejects what admission, policy, depth or the pool's limits refuse, with a published code;
 *  - flags rugs first, then closes on TP / SL / +200 % / -100 % / RUG with a higher priority tip;
 *  - stops new opens on markets whose bound pool emptied or whose depth collapsed;
 *  - reports traders' unrealized PnL (NAV) every 10 s, and a heartbeat every minute when idle — but only while the
 *    engine is fresh and nothing of ours is in flight, so a stalled engine lets the emergency exit open.
 * Every action is simulated first; the contract stays the judge. Positions are polled (positionCount +
 * getPosition), not reconstructed from logs, so a missed log cannot desync the book.
 * Without a usable key (or while the key is not a keeper: isKeeper is re-read every 30 s) it runs as a read-only
 * observer: the book and every listed market's bound pool are still synced for the site, nothing is signed.
 * Guards (14.11.2026): wallets with common funding trade as one (funding.mjs), shorts of a coin whose supply sits with
 * a few holders are limited (holders.mjs), and an optional second key (KEEPER2_*) sends the defensive transactions
 * from its own nonce stream, so a stop-loss never queues behind a fill.
 * Review 06.11.2026 fixes are marked [R].
 */
import { createWalletClient, http, ContractFunctionRevertedError, BaseError, zeroAddress } from "viem";
import { privateKeyToAccount, nonceManager } from "viem/accounts";
import { CFG } from "../config.mjs";
import { client, net } from "../chain.mjs";
import * as M from "../markets.mjs";
import { loadKeeperKey } from "./keystore.mjs";
import * as D from "./decide.mjs";
import * as Holders from "./holders.mjs";
import * as Funding from "./funding.mjs";
import { onDeposit } from "./ledger.mjs";

import { POOL_ABI, SRC_ABI, ABI } from "../abi.mjs";

const REASON = { USER: 0, TP: 1, SL: 2, CAP_WIN: 3, CAP_LOSS: 4, RUG: 5, POOL_GONE: 6, EMERGENCY: 7 };
const OPEN_REASON = 255;
const ST = { None: 0, PendingOpen: 1, Open: 2, PendingClose: 3, Closed: 4, Cancelled: 5 };
/**
 * Blocks: an engine further behind the chain than this holds prices too old to act on. Four fifths of the pool's
 * maxPriceAgeBlocks (40 of the testnet's 50; the mainnet, with slower blocks, sets fewer).
 */
const engineLag = () => (BigInt(K.params?.maxPriceAgeBlocks ?? 50) * 4n) / 5n;
const WARMUP_MS = (CFG.rules.twapS + 5) * 1000; // [R] the 30-s average must hold live samples only
const lc = (a) => (a || "").toLowerCase();
const nowS = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Keeper state, also read by the API. */
export const K = {
  enabled: false, // this engine signs as the keeper (isKeeper is re-read every 30 s)
  observer: false, // STYX_POOL without a usable key, or the key is not (or no longer) a keeper: read-only book
  address: null,
  defensive: null, // address of the second key while it is a keeper of the pool (defensive lane), else null
  pool: CFG.pool,
  adapter: null,
  params: null,
  bands: null,
  markets: new Map(), // marketId -> on-chain Market + id
  ids: new Map(), // token -> marketId (marketIdOf never changes once set)
  marketCount: 0n, // markets 1..marketCount were walked for pinning
  bound: new Map(), // marketId -> { key, kind, manager } the market's on-chain price pool, pinned in the engine
  unfed: new Set(), // marketIds on the default adapter whose V4SpotSource feed is missing
  feedTries: new Map(), // marketId -> ms of the last setFeed attempt
  positions: new Map(), // id -> position
  nextId: 1n,
  chainHead: 0n,
  baseFee: null,
  lastReport: 0,
  readySince: 0,
  sentThisTick: 0,
  log: [], // last actions, newest first
  sent: 0,
  failed: 0,
  troubleSince: new Map(), // marketId -> ms its bound pool emptied or its depth collapsed
  riskD10: new Map(), // marketId -> deepest D10 seen while positions were open
  listing: new Map(), // token -> in-progress listing promise
  listTimes: [], // ms of recent listings (rate limit)
  startError: null,
};

let wallet;
let account;
let wallet2; // the defensive lane (KEEPER2_*): TP / SL / caps / RUG / flagRug / disable, on its own nonces
let account2;
let roleAt = 0; // ms of the last isKeeper read (0 = due on the next loop pass)
const inflight = new Map(); // key -> expiry ms (set only once a tx is really out)

function note(kind, msg, extra = {}) {
  const e = { t: Date.now(), kind, msg, ...extra };
  K.log.unshift(e);
  K.log.length = Math.min(K.log.length, 200);
  console.log(`[keeper] ${kind}: ${msg}`);
}

function errName(e) {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r) return r.data?.errorName || r.reason || "reverted";
    return e.shortMessage || e.name;
  }
  return String(e?.message || e);
}

/** A contract-level refusal (deterministic), as opposed to a network / RPC hiccup worth retrying. [R] */
const isRevert = (name) => /^[A-Z][A-Za-z]+$/.test(name) && !/^(HttpRequestError|TimeoutError|RpcRequestError)/.test(name);

const read = (functionName, args = [], address = K.pool, abi = ABI) => client.readContract({ address, abi, functionName, args });

const engineFresh = () =>
  M.state.ready && K.chainHead - M.state.head <= engineLag() && Date.now() - M.state.lastPoll < 5_000;
const warm = () => K.readySince && Date.now() - K.readySince > WARMUP_MS;

// ───────────────────────────── sending ─────────────────────────────

/**
 * Simulate, then send with a priority tip. Never awaits the receipt on the hot path. The in-flight lock is taken only
 * after the tx is out [R], and lasts until its receipt (or lockMs).
 * -> { ok: true, hash } | { ok: false, error }
 */
async function send(key, functionName, args, tip, { address = K.pool, abi = ABI, lockMs = 15_000, defensive = false } = {}) {
  if (!K.enabled || !wallet) return { ok: false, error: "not the keeper" }; // [R] a revoked key sends nothing
  const until = inflight.get(key);
  if (until && until > Date.now()) return { ok: false, error: "inflight" };
  // the defensive lane signs with the second key while it is a keeper; otherwise everything goes through the main key
  const second = defensive && !!K.defensive && !!wallet2;
  const from = second ? account2 : account;
  let request;
  try {
    ({ request } = await client.simulateContract({ account: from, address, abi, functionName, args }));
  } catch (e) {
    const error = errName(e);
    if (error === "Unauthorized") roleAt = 0; // [R] maybe revoked: re-read isKeeper on the next pass
    return { ok: false, error };
  }
  try {
    const fee = K.baseFee != null ? { maxPriorityFeePerGas: tip, maxFeePerGas: K.baseFee * 2n + tip } : {};
    const hash = await (second ? wallet2 : wallet).writeContract({ ...request, ...fee });
    inflight.set(key, Date.now() + lockMs);
    K.sent++;
    K.sentThisTick++;
    client
      .waitForTransactionReceipt({ hash, timeout: 60_000 })
      .then((r) => {
        if (lockMs <= 15_000) inflight.delete(key);
        if (r.status !== "success") {
          K.failed++;
          inflight.delete(key);
          note("reverted", `${functionName} ${key} ${hash}`);
        }
      })
      .catch((e) => {
        inflight.delete(key);
        note("receipt", `${functionName} ${key}: ${errName(e)}`);
      });
    return { ok: true, hash };
  } catch (e) {
    return { ok: false, error: errName(e) };
  }
}

const busy = () => [...inflight.entries()].some(([k, t]) => t > Date.now() && k !== "report");

async function reject(pos, code, why) {
  const r = await send(`reject:${pos.id}`, "rejectRequest", [pos.id, code], CFG.tips.exec);
  if (r.ok) note("reject", `#${pos.id} code ${code} (${why})`, { id: String(pos.id), code });
  else if (r.error !== "inflight") note("reject-failed", `#${pos.id}: ${r.error}`);
  return true;
}

// ───────────────────────────── chain sync ─────────────────────────────

/**
 * Params and the default adapter. [R] The adapter's band getters are read on their own: an adapter without them (any
 * IPriceSource is accepted on-chain) keeps the last bands read from it instead of failing the params or the boot.
 */
async function refreshParams() {
  const [params, adapter] = await Promise.all([read("getParams"), read("defaultAdapter")]);
  const a = lc(adapter);
  if (K.adapter != null && a !== K.adapter) {
    // a new adapter: its feeds and bands are not the old one's
    K.bands = null;
    K.bound.clear();
    K.unfed.clear();
  }
  K.params = params;
  K.adapter = a;
  if (!a || a === zeroAddress) {
    K.bands = null;
    return;
  }
  try {
    const [fav, worse, defensive] = await Promise.all(["favBps", "worseBps", "defensiveWorseBps"].map((fn) => read(fn, [], a, SRC_ABI)));
    K.bands = { fav: BigInt(fav), worse: BigInt(worse), defensive: BigInt(defensive) };
  } catch (e) {
    note("bands", `adapter ${a}: ${errName(e)}${K.bands ? " (keeping the last bands)" : ""}`);
  }
}

async function market(id) {
  let m = K.markets.get(id);
  if (!m || Date.now() - m.at > 5_000) {
    const raw = await read("getMarket", [id]);
    const local = m && m.localUntil > Date.now() ? { lockedUntil: m.lockedUntil, enabled: m.enabled, localUntil: m.localUntil } : {};
    m = { ...raw, id, at: Date.now(), token: lc(raw.token), v3Pool: lc(raw.v3Pool), priceAdapter: lc(raw.priceAdapter), ...local };
    K.markets.set(id, m);
    if (m.token !== zeroAddress) K.ids.set(m.token, id);
  }
  return m;
}

/** The market is priced through the default adapter, which needs a V4SpotSource feed for it. */
const needsFeed = (m) => m.v3Pool === zeroAddress && m.priceAdapter === zeroAddress && !!K.adapter && K.adapter !== zeroAddress;

/** [R] new positions since last tick + a refresh of the active ones; nextId moves only past what was read. */
async function syncPositions() {
  const count = await read("positionCount");
  const fresh = [];
  for (let i = K.nextId; i <= count; i++) fresh.push(i);
  const active = [];
  for (const [id, p] of K.positions) if (p.status === ST.PendingOpen || p.status === ST.Open || p.status === ST.PendingClose) active.push(id);
  const ids = [...new Set([...fresh, ...active])];
  let firstNone = null;
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    const res = await client.multicall({
      contracts: part.map((id) => ({ address: K.pool, abi: POOL_ABI, functionName: "getPosition", args: [id] })),
      allowFailure: false,
    });
    res.forEach((p, j) => {
      const id = part[j];
      const status = Number(p.status);
      if (status === ST.None) {
        if (firstNone == null || id < firstNone) firstNone = id;
        return;
      }
      K.positions.set(id, { ...p, id, status });
      if (K.enabled && status === ST.PendingOpen) Funding.warm(p.trader); // its cluster is needed before the fill
    });
  }
  K.nextId = firstNone != null && firstNone >= K.nextId ? firstNone : count + 1n;
}

// ───────────────────────────── pricing ─────────────────────────────

const binding = new Map(); // marketId -> bind in progress (one at a time per market: tick, sync and the API share it)

/**
 * [R] The pool a market is bound to on-chain: its v3 pool, else the V4SpotSource feed, else its priceSource (v4 id).
 * Pinned in the engine so price, depth, samples, rug checks and the report all come from it — never from whatever
 * pool the engine would otherwise call the coin's "primary". A failed binding is retried after 15 s, then less often
 * (up to the 60 s of a good one): a pool read that keeps failing (a full-history log scan) must not stall every tick.
 */
function bind(m) {
  const have = K.bound.get(m.id);
  if (have && have.at > Date.now() - have.retry) return Promise.resolve(have.ok ? have : null);
  if (!binding.has(m.id)) binding.set(m.id, bindNow(m, have).finally(() => binding.delete(m.id)));
  return binding.get(m.id);
}

async function bindNow(m, have) {
  let b = null;
  if (m.v3Pool !== zeroAddress) b = { key: m.v3Pool, kind: "v3" };
  else if (needsFeed(m)) {
    const [manager, poolId] = await read("feeds", [m.id], K.adapter, SRC_ABI);
    if (manager !== zeroAddress) b = { key: lc(poolId), kind: "v4", manager: lc(manager) };
    if (b) K.unfed.delete(m.id);
    else K.unfed.add(m.id); // [R] the keeper sets it again on its own (retryFeeds)
  } else if (m.priceSource && BigInt(m.priceSource) !== 0n) {
    b = { key: lc(m.priceSource), kind: "v4" };
  }
  const ok = !!b && !!(await M.pin(m.token, b.key, { kind: b.kind, manager: b.manager, decimals: m.decimals }));
  const retry = ok ? 60_000 : have && !have.ok ? Math.min(60_000, have.retry * 2) : 15_000;
  K.bound.set(m.id, { ...(b || {}), ok, at: Date.now(), retry });
  if (!ok && (!have || have.ok)) note("unbound", `market ${m.id}: no readable on-chain price pool`);
  return ok ? K.bound.get(m.id) : null;
}

/**
 * [R] Pin a market's on-chain price pool (v3 pool / adapter feed / priceSource) in the engine without sending anything,
 * so the site prices it as the keeper settles it; safe in observer mode. marketId: bigint | number | string.
 * -> the engine coin, priced from the bound pool, or null while the binding cannot be resolved or loaded
 */
export async function pinMarket(marketId) {
  if (!CFG.pool || !K.params) return null;
  try {
    const m = await market(BigInt(marketId));
    if (m.token === zeroAddress) return null; // not listed
    const t = await coinOf(m);
    if (t && K.enabled) Holders.track(m.token); // counted ahead of the first short
    return t;
  } catch {
    return null;
  }
}

let syncing = null;
const unpinned = new Map(); // listed marketId not pinned yet -> { at, wait } next try (backs off to 10 min)

/** [R] Walk marketCount: every listed market is pinned at boot, and new ones (any lister) within 30 s. */
function syncMarkets() {
  syncing ||= (async () => {
    const count = await read("marketCount");
    for (let id = K.marketCount + 1n; id <= count; id++) unpinned.set(id, { at: 0, wait: 30_000 });
    if (count > K.marketCount) K.marketCount = count;
    for (const [id, u] of unpinned) {
      if (u.at > Date.now()) continue;
      if (await pinMarket(id)) unpinned.delete(id);
      else unpinned.set(id, { at: Date.now() + u.wait, wait: Math.min(600_000, u.wait * 2) });
    }
  })()
    .catch((e) => note("markets", errName(e)))
    .finally(() => (syncing = null));
  return syncing;
}

/** The engine coin for a market, if it is priced from the market's bound pool. */
async function coinOf(m) {
  const b = await bind(m);
  if (!b) return null;
  const t = M.tokens.get(m.token);
  return t && t.primary === b.key && t.decimals != null ? t : null;
}

/** Engine price for the trader's side (worse of spot and 30-s average) as WAD, or 0n. */
function enginePrice(t, isLong, isOpen) {
  const f = M.fill(t, isLong ? "long" : "short", isOpen);
  return f ? D.toWad(f) : 0n;
}

/**
 * [R] Fit a price to what the contract accepts — V4SpotSource band (default adapter, markets without a v3 pool) or
 * the v3 TWAP tolerance — ONE-SIDEDLY: only ever worse for the trader. -> { price } | { outOfBand } | { error }
 */
async function banded(m, price, isLong, isOpen, reason) {
  const lowerIsBetter = D.traderBuys(isLong, isOpen);
  if (m.priceAdapter === zeroAddress && m.v3Pool === zeroAddress && K.bands) {
    let spot;
    try {
      spot = await read("spot", [m.id], K.adapter, SRC_ABI);
    } catch (e) {
      return { error: errName(e) };
    }
    const worse = isOpen || reason === REASON.USER || reason === REASON.TP ? K.bands.worse : K.bands.defensive;
    const r = D.fitBand(price, spot, { lowerIsBetter, favBps: K.bands.fav, worseBps: worse });
    if (r.outOfBand) return r;
    price = r.price;
  }
  if (m.v3Pool !== zeroAddress) {
    const [ok, twap] = await read("oraclePrice", [m.id]);
    if (!ok) return { error: "OracleUnavailable" };
    const r = D.fitTwap(price, twap, BigInt(K.params.twapToleranceBps), lowerIsBetter);
    if (r.outOfBand) return r;
    price = r.price;
  }
  return { price };
}

function feePips(p) {
  if (p?.fee) return p.fee;
  return CFG.hookFeePips[lc(p?.hooks)] ?? null;
}

const windowOf = (pos) => {
  const req = BigInt(pos.requestBlock);
  return { req, end: req + BigInt(K.params.maxExecDelayBlocks) };
};

// ───────────────────────────── guards ─────────────────────────────

/**
 * What shorts of a coin may do (decide.insiderTier) from the share of its supply with its largest holders. Until the
 * holders are counted the strictest tier applies. `why` is the sentence the site shows.
 */
export function shortTier(token) {
  Holders.track(token);
  const h = Holders.shareOf(token);
  const share = h?.state === "ready" ? h.share : null;
  const tier = D.insiderTier(share);
  const why =
    share == null
      ? `shorts limited to ${tier.maxLev}x: this coin's holders are ${h?.state === "failed" ? "not countable" : "still being counted"}`
      : tier.tier
        ? `shorts limited to ${tier.maxLev}x: ${Math.round(share * 100)}% of the supply sits with its largest holders`
        : null;
  return { ...tier, share, state: h?.state || "scanning", why };
}

let baseAt = 0;
let baseVal = [0n, 0n];
/** [poolCash, nav], read at most every 3 s. */
async function poolBase() {
  if (Date.now() - baseAt > 3_000) {
    baseVal = await Promise.all([read("poolCash"), read("nav")]);
    baseAt = Date.now();
  }
  return baseVal;
}

// ───────────────────────────── actions ─────────────────────────────

async function handleOpen(pos) {
  if (!engineFresh()) return; // [R] no rejects on our own lag: the trader can cancel after cancelDelay
  const { req, end } = windowOf(pos);
  const late = K.chainHead > end;
  if (!warm()) return late ? reject(pos, D.CODES.MISSED_WINDOW, "keeper warming up") : null;
  const m = await market(BigInt(pos.marketId));
  const trader = lc(pos.trader);
  // wallets with common funding are one trader: the account's age and the one-side rule are the cluster's. A wallet
  // whose funder is still being looked up waits inside the window, and is refused at its end (the next request finds
  // the answer cached): an unknown wallet must not slip past the cluster rules by being new.
  if (!Funding.resolved(trader)) {
    Funding.warm(trader);
    return late ? reject(pos, D.CODES.MISSED_WINDOW, "the account check did not finish in the window") : null;
  }
  const cluster = Funding.clusterOf(trader);
  let firstSeenS = null;
  let opposite = false;
  for (const q of K.positions.values()) {
    const other = lc(q.trader);
    if (other !== trader && (!Funding.resolved(other) || Funding.clusterOf(other) !== cluster)) continue;
    const at = Number(q.requestTime);
    if (q.id !== pos.id && (firstSeenS == null || at < firstSeenS)) firstSeenS = at;
    if (q.id !== pos.id && q.marketId === pos.marketId && q.isLong !== pos.isLong && q.status >= ST.PendingOpen && q.status <= ST.PendingClose) {
      opposite = true;
    }
  }
  const pc = D.policyCode(pos, { policy: CFG.policy, firstSeenS: firstSeenS ?? Number(pos.requestTime), nowS: nowS(), opposite });
  if (pc) return reject(pos, pc, "policy");
  const t = await coinOf(m);
  if (!t) return late ? reject(pos, D.CODES.NO_PRICE, "no price from the market's bound pool") : null;
  const adm = M.admission(t);
  if (!adm.ok) return reject(pos, D.CODES.ADMISSION, adm.reasons.join("; "));
  const maxLev = CFG.policy.maxLev ? Math.min(adm.maxLev, CFG.policy.maxLev) : adm.maxLev;
  if (pos.leverage > maxLev) return reject(pos, D.CODES.LEVERAGE, `max ${maxLev}x`);
  const pl = M.pools.get(t.primary);
  const eb = D.execBlock({
    head: M.state.head,
    req,
    lastSwapBlock: pl?.lastSwapBlock ?? null,
    minD: BigInt(K.params.minExecDelayBlocks),
    maxD: BigInt(K.params.maxExecDelayBlocks),
  });
  if (eb.wait) return late ? reject(pos, D.CODES.MISSED_WINDOW, "engine never reached the window") : null;
  if (eb.missed) return reject(pos, D.CODES.MISSED_WINDOW, "pool moved after the window");
  let price = enginePrice(t, pos.isLong, true);
  if (price === 0n) return late ? reject(pos, D.CODES.NO_PRICE, "no price") : null;
  const b = await banded(m, price, pos.isLong, true, OPEN_REASON);
  if (b.outOfBand) return late ? reject(pos, D.CODES.PRICE_BAND, "price outside the band all window") : null;
  if (b.error) {
    const code = D.OPEN_ERROR_CODE[b.error];
    return code ? reject(pos, code, b.error) : late ? reject(pos, D.CODES.NO_PRICE, b.error) : null;
  }
  price = b.price;
  let cap = D.notionalCap(t.d10 || 0, feePips(pl), CFG.rules.notionalPctOfD10);
  let lev = maxLev;
  if (!pos.isLong) {
    // insider short limiter: how much of the supply sits with the largest holders decides what shorts may do
    const tier = shortTier(m.token);
    if (tier.tier) {
      const [cash, navV] = await poolBase();
      const lim = { shortMaxWin: BigInt(m.maxWinShort), poolBase: cash < navV ? cash : navV, maxWinBps: K.params.maxWinBps };
      if (D.insiderRefuses(pos, tier, lim)) return reject(pos, D.CODES.INSIDER_SHORT, tier.why);
      cap /= tier.notionalDiv;
      lev = Math.min(lev, tier.maxLev);
    }
  }
  const r = await send(`open:${pos.id}`, "executeOpen", [pos.id, price, eb.block, lev, cap], CFG.tips.exec);
  if (r.ok) {
    note("open", `#${pos.id} ${t.symbol} ${pos.isLong ? "long" : "short"} ${pos.leverage}x at ${D.fromWad(price)} (block ${eb.block})`, { id: String(pos.id), hash: r.hash });
    K.riskD10.set(m.id, Math.max(K.riskD10.get(m.id) || 0, t.d10 || 0));
  } else if (r.error !== "inflight") {
    const code = D.OPEN_ERROR_CODE[r.error];
    if (code) await reject(pos, code, r.error);
    else if (late) await reject(pos, D.CODES.NO_PRICE, r.error);
    else note("open-retry", `#${pos.id}: ${r.error}`);
  }
}

/** -> true if it acted (or must keep the position for a USER close), false to let the defensive checks run. */
async function handleUserClose(pos) {
  if (!engineFresh() || !warm()) return false;
  const { req, end } = windowOf(pos);
  const late = K.chainHead > end;
  const m = await market(BigInt(pos.marketId));
  const t = await coinOf(m);
  if (!t) return late ? reject(pos, D.CODES.NO_PRICE, "close: no price") : false;
  if (!pos.isLong && Number(m.lockedUntil) <= nowS() && (await flagIfCrashed(m, t))) return true; // [R] rug first
  const pl = M.pools.get(t.primary);
  const eb = D.execBlock({
    head: M.state.head,
    req,
    lastSwapBlock: pl?.lastSwapBlock ?? null,
    minD: BigInt(K.params.minExecDelayBlocks),
    maxD: BigInt(K.params.maxExecDelayBlocks),
  });
  if (eb.wait) return late ? reject(pos, D.CODES.MISSED_WINDOW, "close: engine never reached the window") : false;
  if (eb.missed) return reject(pos, D.CODES.MISSED_WINDOW, "close: pool moved after the window");
  if (eb.block < BigInt(pos.entryBlock)) return false;
  let price = enginePrice(t, pos.isLong, false);
  if (price === 0n) return false;
  const b = await banded(m, price, pos.isLong, false, REASON.USER);
  if (b.outOfBand || b.error) return late ? reject(pos, D.CODES.PRICE_BAND, "close: price outside the band all window") : false;
  price = b.price;
  const r = await send(`close:${pos.id}`, "executeClose", [pos.id, price, eb.block, REASON.USER], CFG.tips.exec);
  if (r.ok) {
    note("close", `#${pos.id} ${t.symbol} USER at ${D.fromWad(price)}`, { id: String(pos.id), hash: r.hash });
    return true;
  }
  if (r.error === "inflight") return true;
  if (r.error === "BadPriceBlock") return reject(pos, D.CODES.MISSED_WINDOW, "close: price block refused"); // [R]
  note("close-retry", `#${pos.id}: ${r.error}`);
  return false;
}

/** TP / SL / caps, and RUG for shorts while their market is locked. Runs for Open and stuck PendingClose. */
async function handleTriggers(pos) {
  if (!engineFresh() || !warm()) return;
  const m = await market(BigInt(pos.marketId));
  const t = await coinOf(m);
  if (!t) return;
  const head = M.state.head;
  if (head < BigInt(pos.entryBlock) || K.chainHead - head > BigInt(K.params.maxPriceAgeBlocks) - 5n) return;
  const locked = Number(m.lockedUntil) > nowS();
  if (!pos.isLong && !locked && (await flagIfCrashed(m, t))) return; // [R] flag before settling a short
  let price = enginePrice(t, pos.isLong, false);
  if (price === 0n) return;
  const clock = { nowS: nowS(), minHold: K.params.minHold };
  let reason = locked && !pos.isLong ? "RUG" : D.triggerFor(pos, price, clock);
  if (!reason) return;
  const b = await banded(m, price, pos.isLong, false, REASON[reason]);
  if (b.outOfBand || b.error) return; // wait for the TWAP / spot to agree
  price = b.price;
  if (reason !== "RUG") {
    reason = D.triggerFor(pos, price, clock); // [R] any reason the banded price still justifies
    if (!reason) return;
  }
  const r = await send(`trig:${pos.id}`, "executeClose", [pos.id, price, head, REASON[reason]], CFG.tips.defensive, { defensive: true });
  if (r.ok) note("close", `#${pos.id} ${t.symbol} ${reason} at ${D.fromWad(price)}`, { id: String(pos.id), hash: r.hash });
  else if (r.error !== "inflight") note("trigger-retry", `#${pos.id} ${reason}: ${r.error}`);
}

/** [R] A crash visible on the fresh spot, not flagged yet: flag it now (once), and say so. */
async function flagIfCrashed(m, t) {
  const plan = D.freshCrash(t.samples, M.spot(t), M.state.head, {
    windowBlocks: BigInt(K.params.rugWindowBlocks),
    dropBps: BigInt(K.params.rugDropBps),
  });
  if (!plan) return false;
  const r = await send(`rug:${m.id}`, "flagRug", [m.id, plan.before, plan.blockBefore, plan.after, plan.blockAfter], CFG.tips.defensive, {
    lockMs: 120_000, // [R] once per dump, not once per tick
    defensive: true,
  });
  if (r.ok) {
    note("rug", `${t.symbol}: ${D.fromWad(plan.before)} -> ${D.fromWad(plan.after)}`, { hash: r.hash });
    m.lockedUntil = BigInt(nowS() + Number(K.params.rugLock));
    m.localUntil = Date.now() + 30_000;
  } else if (r.error !== "inflight") note("rug-retry", `${t.symbol}: ${r.error}`);
  return true;
}

/** Flag rugs on markets with live positions — before any fill or close in the tick. */
async function checkRugs(marketIds) {
  for (const id of marketIds) {
    try {
      const m = await market(id);
      if (Number(m.lockedUntil) > nowS()) continue;
      const t = await coinOf(m);
      if (t) await flagIfCrashed(m, t);
    } catch {
      // [R] one market's read error (e.g. a broken adapter) must not stop the tick for the others
    }
  }
}

/**
 * [R] Stop new opens (no forced closes) on a market whose bound pool holds no in-range liquidity or whose depth fell
 * under 30 % of the deepest D10 seen with positions open, for a minute. The pool's state is re-read on-chain, so a
 * restart or an RPC error cannot look like a vanished pool. POOL_GONE settlement stays a manual (owner) decision.
 */
async function checkTrouble(marketIds) {
  for (const id of marketIds) {
    let m;
    let b;
    let p;
    try {
      m = await market(id);
      if (!m.enabled) continue;
      b = await bind(m);
      if (!b) continue;
      p = await M.refreshPool(b.key);
    } catch {
      continue; // an RPC error is not evidence
    }
    const t = M.tokens.get(m.token);
    const risk = K.riskD10.get(id) || 0;
    const empty = p && p.L === 0n;
    const thin = !!t && risk > 0 && (t.d10 || 0) < risk * 0.3;
    if (!empty && !thin) {
      K.troubleSince.delete(id);
      continue;
    }
    if (!K.troubleSince.has(id)) K.troubleSince.set(id, Date.now());
    if (Date.now() - K.troubleSince.get(id) < 60_000) continue;
    const r = await send(`disable:${id}`, "setMarketEnabled", [id, false], CFG.tips.defensive, { lockMs: 120_000, defensive: true });
    if (r.ok) {
      note("disable", `market ${id} (${empty ? "pool emptied" : "depth collapsed"}): opens stopped, positions stay`);
      m.enabled = false;
      m.localUntil = Date.now() + 30_000;
    }
  }
}

/**
 * Traders' aggregate unrealized PnL at spot of each market's bound pool (an unknown price counts at max win:
 * conservative for LPs). [R] Skipped while the engine is stale (silence lets the emergency clocks run), while any of
 * our transactions is in flight or was sent this tick (a close landing after a stale report counts its PnL twice).
 */
async function report(open) {
  if (!engineFresh() || !warm() || K.sentThisTick || busy()) return;
  let v = 0n;
  for (const p of open) {
    const m = await market(BigInt(p.marketId));
    const t = await coinOf(m).catch(() => null); // an unreadable binding counts as an unknown price
    const s = t && M.spot(t);
    if (!s) {
      v += BigInt(p.maxWin);
      continue;
    }
    v += D.clampedPnl(p, D.toWad(s), { rugLocked: Number(m.lockedUntil) > nowS(), rugCapBps: BigInt(K.params.rugCapBps) });
  }
  const [hi, lo, asOfPrev] = await Promise.all([read("totalReserved"), read("totalOpenStake"), read("reportedAsOf")]);
  if (v > hi) v = hi;
  if (v < -lo) v = -lo;
  const blk = await client.getBlock();
  const asOf = blk.timestamp > asOfPrev ? blk.timestamp : asOfPrev;
  const r = await send("report", "reportUnrealized", [v, asOf], CFG.tips.exec);
  if (r.ok) K.lastReport = Date.now();
  else if (r.error !== "inflight") note("report-retry", r.error);
}

// ───────────────────────────── listing ─────────────────────────────

/**
 * Make a coin tradable on-chain: addMarket (+ V4SpotSource feed for v4, + oracle growth for v3), then pin it.
 * [R] Public endpoint: one listing at a time engine-wide (and per token one request), at most one every 15 s and
 * 100 a day — the slot is taken before the first await, so concurrent requests cannot all pass — and every check
 * before the first transaction (admission, HYPE quote, verified v3 factory approved on-chain / v4 hook allowed by the
 * owner, the key still a keeper). The unseen-coin scan behind it is capped engine-wide (markets.lookup).
 */
export function ensureMarket(token) {
  if (!K.enabled) return Promise.reject(new Error("real mode is off"));
  token = lc(token);
  if (K.listing.has(token)) return K.listing.get(token);
  let slot = null;
  try {
    slot = K.ids.has(token) ? null : reserveListing(); // a listed coin (feed repair) takes no listing slot
  } catch (e) {
    return Promise.reject(e);
  }
  const job = oneAtATime(() => listMarket(token, slot)).finally(() => {
    K.listing.delete(token);
    if (slot && !slot.used) slot.release(); // nothing was sent: the slot was not spent
  });
  K.listing.set(token, job);
  return job;
}

let listTail = Promise.resolve();
function oneAtATime(fn) {
  const run = listTail.then(fn);
  listTail = run.catch(() => {});
  return run;
}

/** Take a listing slot now (synchronously) or throw the rate limit. -> { used, release() } */
function reserveListing() {
  const now = Date.now();
  K.listTimes = K.listTimes.filter((x) => x > now - 86_400_000);
  if (K.listTimes.length && now - K.listTimes[K.listTimes.length - 1] < 15_000) throw new Error("listing rate limit: try again in a few seconds");
  if (K.listTimes.length >= 100) throw new Error("listing limit for today reached");
  K.listTimes.push(now);
  let held = true;
  return {
    used: false,
    release() {
      if (!held) return;
      held = false;
      const i = K.listTimes.lastIndexOf(now);
      if (i >= 0) K.listTimes.splice(i, 1);
    },
  };
}

async function listMarket(token, slot) {
  const known = K.ids.get(token) ?? (await read("marketIdOf", [token]));
  if (known !== 0n) {
    K.ids.set(token, known);
    slot?.release();
    const m = await market(known);
    // idempotent: a market whose feed failed earlier gets it now (until then every fill reverts NoFeed)
    if (needsFeed(m)) {
      const [manager] = await read("feeds", [known], K.adapter, SRC_ABI);
      if (manager === zeroAddress) {
        K.unfed.add(known);
        if (!feeding.has(known) && Date.now() - (K.feedTries.get(known) || 0) < 60_000) {
          throw new Error("this coin's price feed failed a moment ago and is retried automatically: try again in a minute");
        }
        await feedMarket(known);
      }
    }
    return { marketId: String(known) };
  }
  const t = M.tokens.get(token)?.primary ? M.tokens.get(token) : await M.lookup(token);
  if (!t || !t.primary) throw new Error("no pool the engine can read");
  const adm = M.admission(t);
  if (!adm.ok) throw new Error("not admitted: " + adm.reasons.join("; "));
  const p = M.pools.get(t.primary);
  if (p.quoteUsd) throw new Error(`only ${CFG.native}-quoted pools can be traded with real money`);
  const zero = "0x" + "0".repeat(64);
  if (p.kind === "v3") {
    if (!p.factory || Number(await read("factoryKind", [p.factory])) === 0) throw new Error("this v3 venue is not approved for on-chain price checks");
  } else if (K.adapter && K.adapter !== zeroAddress) {
    if (p.fee == null || p.tickSpacing == null || !p.hooks) throw new Error("pool key unknown");
    if (!(await read("hookAllowed", [p.manager, p.hooks], K.adapter, SRC_ABI))) throw new Error("this launchpad hook is not allowed for real money yet");
  }
  // [R] a revoked key must not pay for the v3 oracle growth only to see addMarket fail Unauthorized
  if (!(await read("isKeeper", [account.address]))) {
    dropRole();
    throw new Error("real mode is off: this engine is no longer a keeper of the pool");
  }
  if (p.kind === "v3") {
    const raw = await client.call({ to: p.key, data: "0x3850c7bd" });
    const next = BigInt("0x" + raw.data.slice(2 + 64 * 4, 2 + 64 * 5));
    if (next <= BigInt(K.params.emergencyTwapWindow)) {
      const abi = [{ type: "function", name: "increaseObservationCardinalityNext", inputs: [{ type: "uint16" }], outputs: [], stateMutability: "nonpayable" }];
      const g = await send(`grow:${p.key}`, "increaseObservationCardinalityNext", [1000], CFG.tips.exec, { address: p.key, abi });
      if (!g.ok) throw new Error("growing the pool oracle failed");
      if (slot) slot.used = true;
      await mined(g.hash);
      note("grow", `${t.symbol} pool oracle -> 1000 slots`);
    }
    const r = await send(`list:${token}`, "addMarket", [token, t.decimals, p.key, zero], CFG.tips.exec);
    if (!r.ok) throw new Error("listing failed: " + r.error);
    if (slot) slot.used = true;
    await mined(r.hash);
  } else {
    const r = await send(`list:${token}`, "addMarket", [token, t.decimals, zeroAddress, p.key], CFG.tips.exec);
    if (!r.ok) throw new Error("listing failed: " + r.error);
    if (slot) slot.used = true;
    await mined(r.hash);
  }
  const id = await read("marketIdOf", [token]);
  K.ids.set(token, id);
  note("list", `${t.symbol} -> market ${id}`);
  const m = await market(id);
  if (needsFeed(m)) await feedMarket(id); // on failure the keeper retries it on its own (retryFeeds)
  await bind(m);
  return { marketId: String(id) };
}

/** A transaction's receipt; a revert throws. */
async function mined(hash) {
  const r = await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (r.status !== "success") throw new Error(`transaction reverted: ${hash}`);
  return r;
}

/**
 * Point V4SpotSource at the market's v4 pool: the one it was listed with (priceSource), else the coin's main v4 pool.
 * Full PoolKey; the adapter re-derives and checks it.
 */
async function setFeedFor(id, token, source) {
  let p = source && BigInt(source) !== 0n ? await M.loadPool(source, { kind: "v4" }) : null;
  if (!p || p.kind !== "v4" || p.token !== token) {
    const t = M.tokens.get(token);
    p = t?.primary && M.pools.get(t.primary);
  }
  if (!p || p.kind !== "v4") throw new Error("feed: the coin's main pool is not a v4 pool");
  if (p.fee == null || p.tickSpacing == null || !p.hooks) throw new Error("feed: pool key unknown");
  const key = { currency0: p.token0, currency1: p.c1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks };
  const f = await send(`feed:${id}`, "setFeed", [id, p.manager, key], CFG.tips.exec, { address: K.adapter, abi: SRC_ABI });
  if (!f.ok) throw new Error("market listed but its price feed failed (fills stay blocked): " + f.error);
  await mined(f.hash);
  note("feed", `market ${id} -> ${p.key.slice(0, 10)}… on ${p.manager.slice(0, 10)}…`);
}

const feeding = new Map(); // marketId -> setFeed in progress

/** Set a listed market's missing feed (once at a time per market), then rebind it from the new feed. */
function feedMarket(id) {
  if (feeding.has(id)) return feeding.get(id);
  K.unfed.add(id);
  K.feedTries.set(id, Date.now());
  const job = (async () => {
    const m = await market(id);
    if (needsFeed(m)) {
      const [manager] = await read("feeds", [id], K.adapter, SRC_ABI);
      if (manager === zeroAddress) await setFeedFor(id, m.token, m.priceSource);
    }
    K.unfed.delete(id);
    K.bound.delete(id); // rebind now, not when the failed binding expires
  })().finally(() => feeding.delete(id));
  feeding.set(id, job);
  return job;
}

/** [R] Keeper mode: a listed market without its feed (setFeed failed or never ran) gets it again, once a minute. */
function retryFeeds() {
  for (const id of K.unfed) {
    if (feeding.has(id) || Date.now() - (K.feedTries.get(id) || 0) < 60_000) continue;
    feedMarket(id).catch((e) => note("feed-retry", `market ${id}: ${errName(e)}`));
  }
}

// ───────────────────────────── loop ─────────────────────────────

async function tick() {
  K.sentThisTick = 0;
  K.chainHead = await client.getBlockNumber();
  const blk = await client.getBlock();
  K.baseFee = blk.baseFeePerGas ?? null;
  await syncPositions();
  const active = [...K.positions.values()].filter((p) => p.status === ST.PendingOpen || p.status === ST.Open || p.status === ST.PendingClose);
  const marketIds = [...new Set(active.map((p) => BigInt(p.marketId)))];
  for (const id of marketIds) await pinMarket(id); // [R] observer too: the site prices them from the bound pool
  if (!K.enabled) return; // observer: the book is in sync, nothing is signed
  if (!M.state.ready) return;
  if (!K.readySince) K.readySince = Date.now();
  const open = active.filter((p) => p.status !== ST.PendingOpen);
  if (engineFresh() && warm()) await checkRugs(marketIds); // [R] rugs before any fill or close
  for (const p of active) {
    try {
      if (p.status === ST.PendingOpen) await handleOpen(p);
      else if (p.status === ST.PendingClose) {
        if (!(await handleUserClose(p))) await handleTriggers(p); // [R] a stuck close still gets SL/CAP/RUG
      } else await handleTriggers(p);
    } catch (e) {
      note("error", `#${p.id}: ${errName(e)}`);
    }
  }
  await checkTrouble(marketIds);
  const due = open.length ? 10_000 : 60_000;
  if (Date.now() - K.lastReport > due) await report(open);
}

/**
 * [R] The key, classified by where an error comes from (not by its text): anything thrown while loading or parsing it
 * is a config problem — no key, a read-only observer, never retried. Whether the key is a keeper is asked by
 * checkRole, again every 30 s.
 */
function loadKey() {
  let key;
  try {
    key = loadKeeperKey(CFG.rpc);
  } catch (e) {
    K.startError = `keeper key: ${errName(e)}`;
    console.warn(`[keeper] ${K.startError}: running as a read-only observer`);
    return;
  }
  if (!key) {
    console.log("[keeper] STYX_POOL set but no key (KEEPER_KEYSTORE + KEEPER_PASSPHRASE_FILE): read-only observer");
    return;
  }
  try {
    account = privateKeyToAccount(key, { nonceManager });
  } catch {
    K.startError = "keeper key: not a valid private key"; // never echo the key itself
    console.warn(`[keeper] ${K.startError}: running as a read-only observer`);
    return;
  }
  wallet = createWalletClient({ account, chain: net, transport: http(CFG.rpc) });
  K.address = account.address;
  loadSecondKey();
}

/** The optional defensive key (KEEPER2_KEYSTORE + KEEPER2_PASSPHRASE_FILE). Any problem with it leaves one lane. */
function loadSecondKey() {
  try {
    const key = loadKeeperKey(CFG.rpc, "KEEPER2");
    if (!key) return;
    const a = privateKeyToAccount(key, { nonceManager });
    if (lc(a.address) === lc(account.address)) throw new Error("it is the main keeper key: two lanes need two keys");
    account2 = a;
    wallet2 = createWalletClient({ account: a, chain: net, transport: http(CFG.rpc) });
  } catch (e) {
    console.warn(`[keeper] second key: ${errName(e)}: defensive transactions go through the main key`);
  }
}

/**
 * [R] isKeeper(our key), in both modes: an observer whose key is granted becomes the keeper (warm-up again), a keeper
 * whose rights were revoked drops to observer and stops sending. -> false on an RPC error (the mode stays as it was).
 */
async function checkRole() {
  if (!account) return true;
  let ok;
  try {
    ok = await read("isKeeper", [account.address]);
  } catch {
    return false;
  }
  if (account2) {
    // the second key is a keeper or it is not used: a revoked or never-granted key must not swallow a stop-loss
    const ok2 = await read("isKeeper", [account2.address]).catch(() => null);
    if (ok2 != null) {
      const now = ok2 ? account2.address : null;
      if (now !== K.defensive) console.log(`[keeper] defensive lane: ${now ? `${now} (own nonces)` : `${account2.address} is not a keeper, using the main key`}`);
      K.defensive = now;
    }
  }
  if (!ok) dropRole();
  else if (!K.enabled) {
    K.enabled = true;
    K.observer = false;
    K.readySince = 0;
    K.startError = null;
    console.log(`[keeper] ${account.address} keeping ${CFG.pool} (adapter ${K.adapter})`);
  }
  return true;
}

function dropRole() {
  const was = K.enabled;
  const why = `${account.address} is not a keeper of ${CFG.pool}`;
  K.enabled = false;
  K.observer = true;
  if (was) note("role", `${why}: read-only observer until it is granted again`);
  else if (K.startError !== why) console.warn(`[keeper] ${why}: running as a read-only observer (isKeeper re-read every 30 s)`);
  K.startError = why;
}

export async function startKeeper() {
  if (!CFG.pool) return null;
  // [R] the pool's params first, retried on RPC hiccups; the read-only book starts as soon as they are readable,
  // whatever happens with the key
  for (let attempt = 0; ; attempt++) {
    try {
      await refreshParams();
      break;
    } catch (e) {
      K.startError = errName(e);
      console.warn(`[keeper] pool not readable (${K.startError}), retrying`);
      await sleep(Math.min(60_000, 5_000 * (attempt + 1)));
    }
  }
  K.startError = null;
  K.observer = true; // until isKeeper says otherwise (first loop pass)
  loadKey();
  // a wallet deposits before it trades: look its funder up then, so its first order does not wait for the answer
  onDeposit((w) => account && Funding.warm(w));
  (async () => {
    let paramsAt = Date.now();
    let marketsAt = 0;
    for (;;) {
      const t0 = Date.now();
      if (account && t0 - roleAt > 30_000) roleAt = (await checkRole()) ? t0 : t0 - 25_000; // RPC error: again in 5 s
      if (t0 - paramsAt > 30_000) {
        paramsAt = t0;
        try {
          await refreshParams();
        } catch (e) {
          note("params", errName(e)); // [R] never stops the tick
        }
      }
      if (t0 - marketsAt > 30_000) {
        marketsAt = t0;
        syncMarkets(); // in the background: pin every listed market
      }
      try {
        await tick();
      } catch (e) {
        note("tick", errName(e));
      }
      if (K.enabled) retryFeeds();
      await sleep(Math.max(50, (K.enabled ? CFG.keeperTickMs : 1_000) - (Date.now() - t0)));
    }
  })();
  return K;
}

/** Positions of one trader for the site (Real mode). */
export function positionsOf(trader) {
  trader = lc(trader);
  return [...K.positions.values()].filter((p) => lc(p.trader) === trader);
}

// for engine/real.mjs (the site's Real-mode API): same reads, same caches, same caps as the keeper's
export { read, market as marketOf, feePips, POOL_ABI, ABI, ST };

/** Guard state for the API: clusters and the defensive lane. */
export const guards = () => ({ defensiveLane: K.defensive, funding: Funding.stats() });
