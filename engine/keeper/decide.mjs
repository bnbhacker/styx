/**
 * Pure keeper decisions (no I/O), mirrored on InversePool v1.1 so the keeper only sends what the contract accepts.
 * Prices are WAD BigInts: wei of native per 1 whole token (10**decimals units), like the contract.
 */

export const BPS = 10_000n;

/** rejectRequest codes, published in STYX-ELYSIUM.md §3.3. */
export const CODES = {
  ADMISSION: 1,
  DEPTH_CAP: 2,
  POOL_CAP: 3,
  LEVERAGE: 4,
  MARKET_LOCKED: 5,
  NO_PRICE: 6,
  MISSED_WINDOW: 7,
  OPENS_PAUSED: 8,
  PRICE_BAND: 9,
  NEW_ACCOUNT_CAP: 10,
  INSIDER_SHORT: 11,
  OPPOSITE_SIDE: 12,
};

/** Contract custom error -> reject code for a pending open. */
export const OPEN_ERROR_CODE = {
  NotionalCap: CODES.DEPTH_CAP,
  MarketLiability: CODES.POOL_CAP,
  PoolLiability: CODES.POOL_CAP,
  BadLeverage: CODES.LEVERAGE,
  MarketClosed: CODES.MARKET_LOCKED,
  OpensDisabled: CODES.OPENS_PAUSED,
  OutOfBand: CODES.PRICE_BAND,
  PriceDeviation: CODES.PRICE_BAND,
  OracleUnavailable: CODES.NO_PRICE,
  NoFeed: CODES.NO_PRICE,
  NoSpot: CODES.NO_PRICE,
  BadPriceBlock: CODES.MISSED_WINDOW,
};

/** Float price (native per token) -> WAD BigInt. 15 significant digits are plenty for a fill price. */
export function toWad(x) {
  if (!(x > 0) || !isFinite(x)) return 0n;
  const [m, e] = x.toExponential(14).split("e");
  const digits = BigInt(m.replace(".", "")); // 15 digits, value = digits * 10^(e - 14)
  const exp = Number(e) - 14 + 18;
  return exp >= 0 ? digits * 10n ** BigInt(exp) : digits / 10n ** BigInt(-exp);
}

export const fromWad = (w) => Number(w) / 1e18;

/**
 * Which L2 block may price an open / USER close requested at `req`: [req + minD, req + maxD], not after the engine's
 * head (the newest block its pool state reflects), and only if the pool has not swapped after the chosen block
 * (otherwise the engine no longer holds that block's state).
 * -> { block } | { wait: true } | { missed: true }
 */
export function execBlock({ head, req, lastSwapBlock, minD, maxD }) {
  const lo = req + minD;
  const hi = req + maxD;
  if (head < lo) return { wait: true };
  const pb = head < hi ? head : hi;
  if (lastSwapBlock != null && lastSwapBlock > pb) return { missed: true };
  return { block: pb };
}

/** The trader buys (long open, short close): a lower price is better for them. */
export const traderBuys = (isLong, isOpen) => isLong === isOpen;

/**
 * Fit a keeper price to V4SpotSource's band around `spot` (bps), leaving `marginBps` so the spot moving between our
 * read and inclusion does not flip it out. ONE-SIDED (review 06.11): a price too GOOD for the trader is pulled to the
 * band edge (worse for them); a price too BAD for the trader is never improved — that would replace the 30-s
 * worse-of rule with "spot ± band" and pay manipulation. -> { price } | { outOfBand: true }
 */
export function fitBand(price, spot, { lowerIsBetter, favBps, worseBps, marginBps = 20n }) {
  const loBps = (lowerIsBetter ? favBps : worseBps) - marginBps;
  const hiBps = (lowerIsBetter ? worseBps : favBps) - marginBps;
  const lo = (spot * (BPS - (loBps > 0n ? loBps : 0n))) / BPS + 1n;
  const hi = (spot * (BPS + (hiBps > 0n ? hiBps : 0n))) / BPS;
  return fitRange(price, lo, hi, lowerIsBetter);
}

/** Same for the v3 TWAP check (±twapToleranceBps, symmetric), equally one-sided. */
export function fitTwap(price, twap, tolBps, lowerIsBetter, marginBps = 20n) {
  const t = tolBps > marginBps ? tolBps - marginBps : 0n;
  return fitRange(price, (twap * (BPS - t)) / BPS + 1n, (twap * (BPS + t)) / BPS, lowerIsBetter);
}

function fitRange(price, lo, hi, lowerIsBetter) {
  if (price >= lo && price <= hi) return { price };
  // lowerIsBetter (trader buys): below lo is too good -> raise; above hi is too bad -> refuse
  if (lowerIsBetter) return price < lo ? { price: lo } : { outOfBand: true };
  return price > hi ? { price: hi } : { outOfBand: true };
}

/** |PnL| and sign at `price`, exactly as InversePool._rawPnl. */
export function rawPnl(pos, price) {
  const entry = pos.entryPrice;
  const up = price >= entry;
  const diff = up ? price - entry : entry - price;
  const mag = (BigInt(pos.stake) * BigInt(pos.leverage) * diff) / entry;
  return { gain: up === pos.isLong && mag !== 0n, mag };
}

/** Clamped PnL in [-stake, +maxWin]; shorts in a rug-locked market are capped at +rugCapBps of the stake. */
export function clampedPnl(pos, price, { rugLocked = false, rugCapBps = 2000n } = {}) {
  const { gain, mag } = rawPnl(pos, price);
  const stake = BigInt(pos.stake);
  let pnl = gain ? (mag > BigInt(pos.maxWin) ? BigInt(pos.maxWin) : mag) : -(mag > stake ? stake : mag);
  if (rugLocked && !pos.isLong) {
    const cap = (stake * rugCapBps) / BPS;
    if (pnl > cap) pnl = cap;
  }
  return pnl;
}

/**
 * The defensive close the price justifies, in the contract's own terms (_checkReason), or null.
 * Loss-side first: the pool's book should not keep a position the price already wiped out.
 */
export function triggerFor(pos, price, { nowS, minHold }) {
  const { gain, mag } = rawPnl(pos, price);
  if (!gain && mag >= BigInt(pos.stake)) return "CAP_LOSS";
  if (gain && mag >= BigInt(pos.maxWin)) return "CAP_WIN";
  const sl = BigInt(pos.sl);
  if (sl !== 0n && (pos.isLong ? price <= sl : price >= sl)) return "SL";
  const tp = BigInt(pos.tp);
  if (tp !== 0n && (pos.isLong ? price >= tp : price <= tp) && nowS >= Number(pos.openTime) + Number(minHold)) return "TP";
  return null;
}

/**
 * Per-side notional cap for a coin: k * D10, k = min(0.2, 10 * poolFee) (STYX-ELYSIUM §3.2: pumping an AMM back and
 * forth costs ~2·fee·D10, so the break-even notional is 20·fee·D10; the old 0.2·D10 is exactly break-even at 1 %).
 * feePips: pool fee in hundredths of a bip (Uniswap units, 10_000 = 1 %). Unknown or 0 (launchpad hooks declare 0
 * and take their fee inside the hook, so the PoolKey cannot tell) -> half the old rule, 0.1·D10, until the hook's
 * real fee is measured and configured.
 */
export function notionalCap(d10Native, feePips, pctCap = 0.2) {
  // the dynamic-fee flag (0x800000) says nothing about the real fee: unknown
  const known = feePips && !(feePips & 0x800000) && feePips < 1_000_000;
  const k = !known ? pctCap / 2 : Math.min(pctCap, (10 * feePips) / 1e6);
  return toWad(d10Native * k);
}

/**
 * Keeper policy for the guarded launch (STYX-ELYSIUM §3.2/§3.5), checked before any fill:
 * stake ceiling, leverage ceiling, a new account's smaller stake, and one side per trader per coin
 * (a long + short pair on one coin is a sold strangle against the ±caps).
 * policy: { maxStake, maxLev, newAccountStake } in native units (0 = off). -> code | null
 */
export function policyCode(pos, { policy, firstSeenS, nowS, opposite }) {
  const stake = Number(pos.stake) / 1e18;
  if (policy.maxStake && stake > policy.maxStake) return CODES.POOL_CAP;
  if (policy.maxLev && Number(pos.leverage) > policy.maxLev) return CODES.LEVERAGE;
  if (policy.newAccountStake && firstSeenS != null && nowS - firstSeenS < 86_400 && stake > policy.newAccountStake) {
    return CODES.NEW_ACCOUNT_CAP;
  }
  if (opposite) return CODES.OPPOSITE_SIDE;
  return null;
}

/** A crash visible now (fresh spot vs the window high) that is not flagged on-chain yet. */
export function freshCrash(samples, spotNow, headNow, { windowBlocks, dropBps }) {
  if (!(spotNow > 0)) return null;
  return rugPlan([...samples, [Date.now(), spotNow, headNow]], { head: headNow, windowBlocks, dropBps });
}

/**
 * Rug: the newest price fell >= dropBps below the highest sample within `windowBlocks` blocks.
 * samples: [[ms, price(float), block(BigInt)], ...] oldest first. -> { before, blockBefore, after, blockAfter } | null
 */
export function rugPlan(samples, { head, windowBlocks, dropBps }) {
  if (samples.length < 2) return null;
  const last = samples[samples.length - 1];
  const after = toWad(last[1]);
  const blockAfter = last[2];
  if (after === 0n || blockAfter == null) return null;
  let best = null;
  for (let i = samples.length - 2; i >= 0; i--) {
    const s = samples[i];
    if (s[2] == null || blockAfter - s[2] > windowBlocks) break;
    if (s[2] >= blockAfter) continue;
    const w = toWad(s[1]);
    if (!best || w > best.before) best = { before: w, blockBefore: s[2] };
  }
  if (!best) return null;
  if (after * BPS > best.before * (BPS - dropBps)) return null;
  if (head - blockAfter > 40n) return null; // stale: the contract wants a fresh blockAfter
  return { ...best, after, blockAfter };
}

// ───────────────────────────── insider shorts (STYX-ELYSIUM §3.2) ─────────────────────────────

/**
 * F: the share of a coin's supply held by its insiders = the ten largest holders plus everyone the supply was minted
 * to, not counting what sits in pools, lockers, burn addresses and the bridge (`exclude`). Excluded balances still
 * count in the supply: a coin that is 80 % in its pool has at most 20 % with insiders.
 * balances: Map(address -> BigInt), minted: iterable of mint recipients, exclude: Set of lowercase addresses.
 * -> { share (0..1), holders: [[address, share]] largest first } | null if there is no supply
 */
export function insiderShare(balances, { minted = [], exclude = new Set(), top = 10 } = {}) {
  let supply = 0n;
  const free = [];
  for (const [a, b] of balances) {
    if (b <= 0n) continue;
    supply += b;
    if (!exclude.has(a)) free.push([a, b]);
  }
  if (supply === 0n) return null;
  free.sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0));
  const picked = new Map(free.slice(0, top));
  for (const a of minted) {
    const b = balances.get(a);
    if (b > 0n && !exclude.has(a)) picked.set(a, b);
  }
  let held = 0n;
  for (const b of picked.values()) held += b;
  const part = (b) => Number((b * 1_000_000n) / supply) / 1e6;
  const holders = [...picked].sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0)).map(([a, b]) => [a, part(b)]);
  return { share: part(held), holders };
}

/**
 * What shorts of a coin may do given F. Up to 20 %: no limit. 20–40 %: at most 5x and half the short notional.
 * Above 40 %: at most 2x and the shorts' summed max win at most 1 % of the pool. An unknown F (holders not counted
 * yet, or the count failed) gets the strictest tier: the pool does not lend its balance sheet to a coin it cannot see.
 * -> { tier, maxLev, notionalDiv, maxWinPoolBps (0 = no extra limit) }
 */
export function insiderTier(share) {
  if (share != null && share <= 0.2) return { tier: 0, maxLev: 10, notionalDiv: 1n, maxWinPoolBps: 0n };
  if (share != null && share <= 0.4) return { tier: 1, maxLev: 5, notionalDiv: 2n, maxWinPoolBps: 0n };
  return { tier: 2, maxLev: 2, notionalDiv: 1n, maxWinPoolBps: 100n };
}

/**
 * Does the insider limit refuse this short? pos: the pending short; tier: insiderTier(); shortMaxWin: the market's
 * open shorts' summed max win; poolBase: min(poolCash, nav); maxWinBps: the pool's win cap. -> true = INSIDER_SHORT
 */
export function insiderRefuses(pos, tier, { shortMaxWin, poolBase, maxWinBps }) {
  if (pos.isLong || tier.tier === 0) return false;
  if (Number(pos.leverage) > tier.maxLev) return true;
  if (tier.maxWinPoolBps === 0n) return false;
  const win = (BigInt(pos.stake) * BigInt(maxWinBps)) / BPS;
  return (BigInt(shortMaxWin) + win) * BPS > BigInt(poolBase) * tier.maxWinPoolBps;
}

// ───────────────────────────── wallet clusters (STYX-ELYSIUM §3.2) ─────────────────────────────

/**
 * Wallets with common funding count as one trader. links: Map(wallet -> its first funder | null). A funder that is
 * excluded (bridge, exchange hot wallet, solver: `exclude`) or that funded more than `hub` wallets links nobody: on RH
 * a Relay solver glued strangers together that way. A wallet funded by another wallet joins it; two wallets with the
 * same funder join each other. -> Map(wallet -> cluster id), every wallet of `links` and every linking funder included
 */
export function clusters(links, { exclude = new Set(), hub = 8 } = {}) {
  const fanout = new Map();
  for (const f of links.values()) if (f) fanout.set(f, (fanout.get(f) || 0) + 1);
  const parent = new Map();
  const find = (a) => {
    if (!parent.has(a)) parent.set(a, a);
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r);
    for (let x = a; parent.get(x) !== r; ) {
      const n = parent.get(x);
      parent.set(x, r);
      x = n;
    }
    return r;
  };
  for (const [w, f] of links) {
    const rw = find(w);
    if (!f || f === w || exclude.has(f) || fanout.get(f) > hub) continue;
    const rf = find(f);
    if (rw !== rf) parent.set(rw < rf ? rf : rw, rw < rf ? rw : rf); // the smaller address names the cluster
  }
  const out = new Map();
  for (const a of parent.keys()) out.set(a, find(a));
  return out;
}
