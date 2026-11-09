/**
 * Practice book: the same rules the contract enforces (SPEC.md §4–§9), with
 * the chain's paper native coin. Positions, the house pool and the fee split all live here.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CFG } from "./config.mjs";
import { tokens, fill, spot, twap, admission, onRug } from "./markets.mjs";

const R = CFG.rules;
// one book per chain; RH keeps the original file name
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", CFG.network === "rh" ? "paper.json" : `paper-${CFG.network}.json`);

const S = load();
let dirty = false;

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {
      seq: 1,
      accounts: {},
      positions: {},
      closed: [],
      trades: [],
      pool: { cash: CFG.paper.poolSeed, weekly: 0, ops: 0, feesToPool: 0, paidToWinners: 0, keptFromLosers: 0, history: [] },
    };
  }
}

function save() {
  if (!dirty) return;
  dirty = false;
  const f = FILE;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + ".tmp", JSON.stringify(S));
  fs.renameSync(f + ".tmp", f);
}

class UserError extends Error {}
export { UserError };

const r6 = (x) => Math.round(x * 1e6) / 1e6;

export function account(id, ref) {
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(id || "")) throw new UserError("bad account id");
  let a = S.accounts[id];
  if (!a) {
    a = S.accounts[id] = { id, balance: 0, createdAt: Date.now(), claimedAt: 0, ref: null, refEarned: 0 };
    if (ref && ref !== id && S.accounts[ref]) a.ref = ref;
    dirty = true;
  }
  return a;
}

export function claim(id) {
  const a = account(id);
  if (Date.now() - a.claimedAt < 24 * 3600_000) throw new UserError(`paper ${CFG.native} can be claimed once a day`);
  a.balance = r6(a.balance + CFG.paper.claim);
  a.claimedAt = Date.now();
  dirty = true;
  return a;
}

function openSide(token, side) {
  let notional = 0;
  let maxWin = 0;
  for (const p of Object.values(S.positions)) {
    if (p.token !== token || p.side !== side) continue;
    notional += p.stake * p.lev;
    maxWin += p.stake * R.maxWinMult;
  }
  return { notional, maxWin };
}

function totalMaxWin() {
  let m = 0;
  for (const p of Object.values(S.positions)) m += p.stake * R.maxWinMult;
  return m;
}

function poolPaused() {
  const hourAgo = S.pool.history.find((h) => h[0] >= Date.now() - 3600_000);
  return hourAgo ? S.pool.cash < hourAgo[1] * (1 - R.poolLossPauseH) : false;
}

/** How much more notional a coin can take on one side right now. */
export function room(t, side) {
  const { notional, maxWin } = openSide(t.addr, side);
  const byDepth = (t.d10 || 0) * R.notionalPctOfD10 - notional;
  const byPoolCoin = S.pool.cash * R.maxWinPerMarketPct - maxWin; // in max-win terms
  const byPoolAll = S.pool.cash * R.maxWinTotalPct - totalMaxWin();
  const stakeRoom = Math.min(byPoolCoin, byPoolAll) / R.maxWinMult;
  return { notional: Math.max(0, byDepth), stake: Math.max(0, stakeRoom) };
}

function splitFee(fee, acct) {
  const f = R.feeSplit;
  const ref = acct.ref && S.accounts[acct.ref];
  const toRef = ref ? (fee * f.ref) / 10_000 : 0;
  if (ref) {
    ref.balance = r6(ref.balance + toRef);
    ref.refEarned = r6(ref.refEarned + toRef);
  }
  const toPool = (fee * f.pool) / 10_000 + (ref ? 0 : (fee * f.ref) / 10_000);
  S.pool.cash += toPool;
  S.pool.feesToPool += toPool;
  S.pool.weekly += (fee * f.weekly) / 10_000;
  S.pool.ops += (fee * f.ops) / 10_000;
}

function feed(kind, p, extra = {}) {
  S.trades.unshift({ t: Date.now(), kind, symbol: p.symbol, token: p.token, side: p.side, lev: p.lev, stake: p.stake, acct: p.acct, ...extra });
  S.trades.length = Math.min(S.trades.length, 300);
}

export function open({ id, token, side, lev, stake, tp, sl }) {
  const a = account(id);
  const t = tokens.get(String(token).toLowerCase());
  if (!t) throw new UserError("unknown coin");
  if (side !== "long" && side !== "short") throw new UserError("side must be long or short");
  lev = Number(lev);
  stake = Number(stake);
  if (!R.leverages.includes(lev)) throw new UserError("leverage must be 2, 5 or 10");
  if (!(stake >= R.minStake)) throw new UserError(`minimum ${R.minStake} ${CFG.native}`);
  const adm = admission(t);
  if (!adm.ok) throw new UserError("closed: " + adm.reasons.join(", "));
  if (lev > adm.maxLev) throw new UserError(`this coin allows up to ${adm.maxLev}x`);
  if (poolPaused()) throw new UserError("pool lost over 10% in the last hour, new trades paused");
  const fee = stake * (R.feeBps / 10_000);
  if (a.balance < stake + fee) throw new UserError("not enough balance");
  const rm = room(t, side);
  if (stake * lev > rm.notional) throw new UserError(`room left on this side: ${(rm.notional / lev).toFixed(4)} ${CFG.native} at ${lev}x`);
  if (stake > rm.stake) throw new UserError(`pool room left: ${rm.stake.toFixed(4)} ${CFG.native}`);
  const entry = fill(t, side, true);
  if (!entry) throw new UserError("no price yet");
  tp = tp ? Number(tp) : null;
  sl = sl ? Number(sl) : null;
  if (tp && (side === "long" ? tp <= entry : tp >= entry)) throw new UserError("take profit is on the wrong side of the price");
  if (sl && (side === "long" ? sl >= entry : sl <= entry)) throw new UserError("stop loss is on the wrong side of the price");

  a.balance = r6(a.balance - stake - fee);
  splitFee(fee, a);
  const p = { id: S.seq++, acct: id, token: t.addr, symbol: t.symbol, side, lev, stake, entry, tp, sl, openedAt: Date.now(), fee };
  S.positions[p.id] = p;
  feed("open", p, { price: entry });
  dirty = true;
  return p;
}

function pnlAt(p, price) {
  const dir = p.side === "long" ? 1 : -1;
  const raw = p.stake * p.lev * (price / p.entry - 1) * dir;
  return Math.max(-p.stake, Math.min(p.stake * R.maxWinMult, raw));
}

function settle(p, exit, reason) {
  let pnl = pnlAt(p, exit);
  if (reason === "rug" && p.side === "short") pnl = Math.min(pnl, p.stake * R.rugShortCap);
  const back = p.stake + pnl;
  const fee = back * (R.feeBps / 10_000);
  const a = S.accounts[p.acct];
  a.balance = r6(a.balance + back - fee);
  S.pool.cash -= pnl;
  if (pnl > 0) S.pool.paidToWinners += pnl;
  else S.pool.keptFromLosers -= pnl;
  splitFee(fee, a);
  delete S.positions[p.id];
  const done = { ...p, exit, pnl: r6(pnl), closeFee: fee, reason, closedAt: Date.now() };
  S.closed.unshift(done);
  S.closed.length = Math.min(S.closed.length, 2000);
  feed("close", p, { pnl: r6(pnl), reason, price: exit });
  dirty = true;
  return done;
}

export function close(id, pid) {
  const p = S.positions[pid];
  if (!p || p.acct !== id) throw new UserError("no such open position");
  if (Date.now() - p.openedAt < R.minHoldS * 1000) throw new UserError(`positions can close after ${R.minHoldS}s`);
  const t = tokens.get(p.token);
  const exit = t && fill(t, p.side, false);
  if (!exit) throw new UserError("no price right now, try again");
  return settle(p, exit, "user");
}

/** Keeper loop: TP / SL / +200% / -100%, all on the worse-for-trader price. */
function keeper() {
  for (const p of Object.values(S.positions)) {
    const t = tokens.get(p.token);
    if (!t) continue;
    const exit = fill(t, p.side, false);
    if (!exit) continue;
    const pnl = pnlAt(p, exit);
    let reason = null;
    if (pnl >= p.stake * R.maxWinMult) reason = "max win";
    else if (pnl <= -p.stake) reason = "stake lost";
    else if (p.tp && (p.side === "long" ? exit >= p.tp : exit <= p.tp)) reason = "take profit";
    else if (p.sl && (p.side === "long" ? exit <= p.sl : exit >= p.sl)) reason = "stop loss";
    if (reason) settle(p, exit, reason);
  }
  const h = S.pool.history;
  if (!h.length || Date.now() - h[h.length - 1][0] > 60_000) {
    h.push([Date.now(), r6(S.pool.cash)]);
    while (h.length > 60 * 24 * 7) h.shift();
    dirty = true;
  }
}

onRug((t, px) => {
  for (const p of Object.values(S.positions)) if (p.token === t.addr && p.side === "short") settle(p, px, "rug");
});

// ---------- read side ----------

const DAY = 24 * 3600_000;

export function me(id) {
  const a = account(id);
  const open = Object.values(S.positions)
    .filter((p) => p.acct === id)
    .map((p) => {
      const t = tokens.get(p.token);
      const mark = t && fill(t, p.side, false);
      return { ...p, mark, pnl: mark ? r6(pnlAt(p, mark)) : null, spot: t && spot(t), twap: t && twap(t) };
    });
  const history = S.closed.filter((p) => p.acct === id).slice(0, 100);
  return { account: a, open, history };
}

export function positionsOn(token) {
  return Object.values(S.positions).filter((p) => p.token === token);
}

export function poolStats() {
  const since = Date.now() - DAY;
  const day = S.closed.filter((p) => p.closedAt >= since);
  const wins = day.filter((p) => p.pnl > 0);
  const best = wins.reduce((b, p) => (!b || p.pnl > b.pnl ? p : b), null);
  const opens = S.trades.filter((x) => x.kind === "open" && x.t >= since);
  // open money by side, for the long/short balance on the front page
  const oi = { long: 0, short: 0 };
  for (const p of Object.values(S.positions)) oi[p.side] += p.stake * p.lev;
  return {
    cash: r6(S.pool.cash),
    longNotional: r6(oi.long),
    shortNotional: r6(oi.short),
    reservedMaxWin: r6(totalMaxWin()),
    openPositions: Object.keys(S.positions).length,
    volume24: r6(opens.reduce((s, x) => s + x.stake, 0)),
    trades24: opens.length + day.length,
    paidToWinners24: r6(wins.reduce((s, p) => s + p.pnl, 0)),
    winningTrades24: wins.length,
    best24: best && { symbol: best.symbol, side: best.side, lev: best.lev, pnl: best.pnl },
    weeklyPot: r6(S.pool.weekly),
    opsFund: r6(S.pool.ops),
    feesToPool: r6(S.pool.feesToPool),
    paidToWinners: r6(S.pool.paidToWinners),
    keptFromLosers: r6(S.pool.keptFromLosers),
    paused: poolPaused(),
    history: S.pool.history.slice(-24 * 60),
  };
}

export function trades() {
  return S.trades.slice(0, 60);
}

export function wins() {
  const since = Date.now() - DAY;
  const top = S.closed.filter((p) => p.closedAt >= since && p.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, 20);
  const weekStart = Date.now() - 7 * DAY;
  const by = {};
  for (const p of S.closed) if (p.closedAt >= weekStart) by[p.acct] = (by[p.acct] || 0) + p.pnl;
  const board = Object.entries(by)
    .map(([acct, pnl]) => ({ acct, pnl: r6(pnl) }))
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 20);
  return { top, board, pot: r6(S.pool.weekly) };
}

export function start() {
  setInterval(keeper, 1000);
  setInterval(save, 5000);
}
