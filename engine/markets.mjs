/**
 * Every swap on the chain -> per-coin price, 30s average, depth (D10),
 * admission. One eth_getLogs per tick over the v3 and v4 Swap topics, no
 * address filter: Uniswap v3, Aero Slipstream, v3 forks and all v4 pools
 * (launchpads after graduation, Doppler, hooks) arrive in the same stream.
 *
 * "ETH" in names below means the chain's native coin (ETH on RH, HYPE on
 * Elysium). With CFG.dexscreener = null, pool metadata comes from Initialize /
 * PoolCreated events and 24h stats from the engine's own swap stream.
 */
import { CFG } from "./config.mjs";
import { client, getSwapLogs, tokenMeta, poolState, v3Tokens, v4Init, v4PoolsOf, v3CreatedAt, verifyV3, v3PoolsFor } from "./chain.mjs";
import { pairsByPool, pairsByToken } from "./dex.mjs";

const Q96 = 2 ** 96;
const D10_K = Math.sqrt(1.1) - 1; // share of L*sqrtP that moves the price 10%
const R = CFG.rules;
const DS = !!CFG.dexscreener;
const lc = (s) => s.toLowerCase();
const isEth = (a) => a === CFG.WETH || a === CFG.NATIVE;
const isUsd = (a) => a === CFG.USD;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const pools = new Map(); // pool address or v4 id -> pool
export const tokens = new Map(); // token address -> coin
export const state = { head: 0n, ethUsd: 0, ethUsdSrc: null, swaps: 0, startedAt: Date.now(), ready: false, since: 0, lastPoll: 0 };

const pending = new Set(); // pool keys waiting for metadata
const ignored = new Set(); // pools without an ETH/USDG side
const needMeta = new Set(); // tokens waiting for symbol/decimals/supply
const rugHandlers = [];
export const onRug = (fn) => rugHandlers.push(fn);

// ---------- swaps ----------

function ingest(l) {
  const v4 = l.topics[0] === CFG.topics.v4;
  if (v4 && !CFG.poolManagers.has(lc(l.address))) return;
  const key = lc(v4 ? l.topics[1] : l.address);
  if (ignored.has(key)) return;
  const w = (i) => BigInt("0x" + l.data.slice(2 + 64 * i, 66 + 64 * i));
  const a0 = BigInt.asIntN(256, w(0));
  const a1 = BigInt.asIntN(256, w(1));
  // the RH node reports blockTimestamp "0x0" for fresh blocks
  const bts = l.blockTimestamp ? parseInt(l.blockTimestamp, 16) : 0;
  const ts = bts > 0 ? bts * 1000 : Date.now();
  if (!state.since || ts < state.since) state.since = ts;
  let p = pools.get(key);
  if (!p) {
    p = { key, kind: v4 ? "v4" : "v3", manager: v4 ? lc(l.address) : null, vol: [], swaps: 0 };
    pools.set(key, p);
    pending.add(key);
  }
  p.sqrtP = w(2);
  p.L = w(3);
  p.lastSwap = ts;
  p.lastSwapBlock = BigInt(l.blockNumber); // the keeper prices a block only if the pool has not moved since
  p.swaps++;
  p.vol.push([ts, Math.abs(Number(a0)), Math.abs(Number(a1))]);
  state.swaps++;
}

async function pollLoop() {
  const head = await client.getBlockNumber();
  state.head = head - CFG.backfillBlocks;
  // backfill in fixed ranges, then follow the head
  while (state.head < head) {
    const to = state.head + CFG.maxRange < head ? state.head + CFG.maxRange : head;
    try {
      (await getSwapLogs(state.head + 1n, to)).forEach(ingest);
      state.head = to;
    } catch (e) {
      console.warn("backfill", e.shortMessage || e.message);
    }
    await sleep(300);
  }
  state.ready = true;
  for (;;) {
    try {
      const h = await client.getBlockNumber();
      if (h > state.head) {
        const to = h - state.head > CFG.maxRange ? state.head + CFG.maxRange : h;
        (await getSwapLogs(state.head + 1n, to)).forEach(ingest);
        state.head = to;
      }
      state.lastPoll = Date.now(); // the keeper refuses to act on a stalled stream
    } catch (e) {
      console.warn("poll", e.shortMessage || e.message);
    }
    await sleep(CFG.pollMs);
  }
}

// ---------- pool metadata ----------

function coin(addr) {
  let t = tokens.get(addr);
  if (!t) {
    t = { addr, pools: new Set(), samples: [], lockedUntil: 0, ds: null };
    tokens.set(addr, t);
    needMeta.add(addr);
  }
  return t;
}

/** Attach a pool to its coin given the two sides DexScreener (or the pool) reports. */
function attach(p, base, quote, priceNative, pair) {
  base = lc(base);
  quote = lc(quote);
  if ((isEth(base) && isUsd(quote)) || (isEth(quote) && isUsd(base))) {
    // the native/USD anchor, whichever way round the pool lists it
    p.ethUsdPool = true;
    p.token = CFG.WETH;
    p.quote = isUsd(quote) ? quote : base;
    if (p.token0 === CFG.NATIVE) p.token0 = CFG.WETH; // native currency0 plays the WETH side
  } else if (isEth(base) && isEth(quote)) {
    ignored.add(p.key); // WETH/native wrappers
    pools.delete(p.key);
    return;
  } else if (isEth(quote) || isUsd(quote)) {
    p.token = base;
    p.quote = quote;
  } else if (isEth(base) || isUsd(base)) {
    p.token = quote;
    p.quote = base;
    priceNative = priceNative ? 1 / priceNative : null;
  } else {
    ignored.add(p.key);
    pools.delete(p.key);
    return;
  }
  p.quoteUsd = isUsd(p.quote);
  p.decQ = p.quoteUsd ? CFG.usdDecimals : 18;
  p.dsPrice = priceNative || null;
  p.dexId = pair?.dexId ?? p.dexId ?? "?";
  p.createdAt = pair?.pairCreatedAt ?? p.createdAt ?? null;
  if (p.ethUsdPool) return;
  coin(p.token).pools.add(p.key);
}

/** No DexScreener: currencies and age from Initialize (v4) / token0-token1 + PoolCreated (v3). */
async function resolveFromChain(keys) {
  const drop = (k) => {
    ignored.add(k);
    pools.delete(k);
  };
  const byManager = new Map();
  for (const k of keys) {
    const p = pools.get(k);
    if (!p) continue;
    if (p.kind === "v4") {
      if (!byManager.has(p.manager)) byManager.set(p.manager, []);
      byManager.get(p.manager).push(k);
      continue;
    }
    try {
      const [t0, t1] = await v3Tokens(k);
      const v = await verifyV3(k, t0, t1);
      if (!v) throw new Error("unverified v3 emitter"); // any contract can emit the v3 Swap topic
      p.token0 = t0;
      p.fee = v.fee;
      p.factory = v.factory;
      p.createdAt = await v3CreatedAt(k, t0, t1);
      p.dexId = "v3";
      attach(p, t0, t1, null, null);
    } catch {
      drop(k);
    }
  }
  for (const [m, ids] of byManager) {
    let init;
    try {
      init = await v4Init(m, ids);
    } catch (e) {
      console.warn("v4Init", e.shortMessage || e.message);
      ids.forEach((k) => pending.add(k)); // retry later
      continue;
    }
    for (const k of ids) {
      const p = pools.get(k);
      const i = init.get(k);
      if (!p) continue;
      if (!i) {
        drop(k);
        continue;
      }
      p.token0 = i.c0;
      p.c1 = i.c1;
      p.hooks = i.hooks;
      p.fee = i.fee;
      p.tickSpacing = i.tickSpacing;
      p.createdAt = i.createdAt;
      p.dexId = "v4";
      attach(p, i.c0, i.c1, null, null);
    }
  }
}

async function resolveLoop() {
  for (;;) {
    const keys = [...pending].slice(0, 30);
    if (keys.length && !DS) {
      keys.forEach((k) => pending.delete(k));
      await resolveFromChain(keys);
    } else if (keys.length) {
      keys.forEach((k) => pending.delete(k));
      const pairs = await pairsByPool(keys);
      const byKey = new Map(pairs.map((x) => [lc(x.pairAddress), x]));
      for (const k of keys) {
        const p = pools.get(k);
        if (!p) continue;
        const pair = byKey.get(k);
        if (pair) {
          attach(p, pair.baseToken.address, pair.quoteToken.address, Number(pair.priceNative), pair);
        } else if (p.kind === "v3") {
          try {
            const [t0, t1] = await v3Tokens(k);
            const v = await verifyV3(k, t0, t1); // DexScreener does not know it: trust only allowlisted factories
            if (!v) throw new Error("unverified v3 emitter");
            p.token0 = t0;
            p.fee = v.fee;
            attach(p, t0, t1, null, null);
          } catch {
            ignored.add(k);
            pools.delete(k);
          }
        } else {
          ignored.add(k); // unknown v4 pool: no way to learn its currencies cheaply
          pools.delete(k);
        }
      }
    }
    // token metadata in one multicall per 40 tokens
    const metas = [...needMeta].slice(0, 40);
    if (metas.length) {
      metas.forEach((a) => needMeta.delete(a));
      try {
        for (const m of await tokenMeta(metas)) {
          const t = tokens.get(m.addr);
          if (!t || m.decimals == null) continue;
          t.symbol = t.symbol || m.symbol || "?";
          t.name = t.name || m.name || "";
          t.decimals = m.decimals;
          t.supply = m.totalSupply == null ? 0 : Number(m.totalSupply) / 10 ** m.decimals;
        }
      } catch (e) {
        metas.forEach((a) => needMeta.add(a));
      }
    }
    await sleep(keys.length || metas.length ? 300 : 1000);
  }
}

// ---------- math ----------

/** Price of the coin in the pool's quote currency, orientation fixed on first use. */
function quotePrice(p, decT) {
  if (!p.sqrtP || decT == null) return null;
  const s = Number(p.sqrtP) / Q96;
  const raw = s * s;
  const asT0 = raw * 10 ** (decT - p.decQ);
  const asT1 = raw ? 10 ** (decT - p.decQ) / raw : 0;
  if (p.tokenIs0 == null) {
    if (p.token0) p.tokenIs0 = p.token0 === p.token;
    else if (p.dsPrice) {
      const d0 = Math.abs(Math.log(asT0 / p.dsPrice));
      const d1 = Math.abs(Math.log(asT1 / p.dsPrice));
      p.tokenIs0 = d0 <= d1;
    } else {
      // v4 currencies are sorted by address; native ETH (0x0) is always currency0
      const q = p.quote === CFG.WETH && p.kind === "v4" ? CFG.NATIVE : p.quote;
      p.tokenIs0 = BigInt(p.token) < BigInt(q);
    }
  }
  return p.tokenIs0 ? asT0 : asT1;
}

const toEth = (p, v) => (p.quoteUsd ? (state.ethUsd ? v / state.ethUsd : null) : v);

/** ETH that moves the price 10% (in-range liquidity, assumed flat over ±10%). */
function d10(p) {
  if (!p.sqrtP || !p.L || p.tokenIs0 == null) return 0;
  const s = Number(p.sqrtP) / Q96;
  const L = Number(p.L);
  const quoteRaw = (p.tokenIs0 ? L * s : L / s) * D10_K;
  return toEth(p, quoteRaw / 10 ** p.decQ) || 0;
}

function volEth(p, sinceMs) {
  let q = 0;
  for (const [ts, a0, a1] of p.vol) if (ts >= sinceMs) q += p.tokenIs0 ? a1 : a0;
  return toEth(p, q / 10 ** p.decQ) || 0;
}

export function spot(t) {
  const p = pools.get(t.primary);
  if (!p) return null;
  const v = quotePrice(p, t.decimals);
  return v == null ? null : toEth(p, v);
}

export function twap(t) {
  const cut = Date.now() - R.twapS * 1000;
  let s = 0;
  let n = 0;
  for (let i = t.samples.length - 1; i >= 0 && t.samples[i][0] >= cut; i--) {
    s += t.samples[i][1];
    n++;
  }
  return n ? s / n : spot(t);
}

/** Worse-for-the-trader of spot and 30s average. */
export function fill(t, side, opening) {
  const a = spot(t);
  const b = twap(t);
  if (a == null || b == null) return null;
  const traderBuys = (side === "long") === opening;
  return traderBuys ? Math.max(a, b) : Math.min(a, b);
}

// ---------- periodic: primary pool, samples, rug, ETH/USD ----------

/** A coin's price source changes: its samples go, so a 30-s average or rug window never mixes two pools. */
function setPrimary(t, key, now = Date.now()) {
  if (t.primary === key) return;
  t.primary = key;
  t.primaryAt = now;
  t.samples = [];
}

/**
 * D10 of one of the coin's pools. Flat-L over ±10% overstates narrow ranges; buying 10% up can never take more ETH
 * than the coin's pools hold on the token side. Without DexScreener the cap is the coin's own balance in its v3 pool at
 * spot; an unknown balance counts as 0, not infinity, so a fresh pool cannot win on a huge liquidity field alone
 * (v4 pools share one PoolManager balance, so their depth stays flat-L: see README).
 */
function cappedD10(t, p) {
  quotePrice(p, t.decimals);
  const d = d10(p);
  if (DS || p.kind !== "v3") return d;
  if (p.tokenBal == null) return 0;
  return Math.min(d, toEth(p, p.tokenBal * (quotePrice(p, t.decimals) ?? 0)) ?? 0);
}
const dsCap = (t) => (t.ds?.liqUsd && state.ethUsd ? t.ds.liqUsd / 2 / state.ethUsd : Infinity);

function sampleLoop() {
  setInterval(() => {
    // ETH/USD from the deepest WETH/USDG pool
    let best = null;
    for (const p of pools.values()) {
      if (!p.ethUsdPool || !p.sqrtP) continue;
      const depth = Number(p.L || 0n);
      if (!best || depth > best.depth) best = { p, depth };
    }
    if (best) {
      const v = quotePrice(best.p, 18);
      if (v > CFG.nativeUsd[0] && v < CFG.nativeUsd[1]) {
        state.ethUsd = v;
        state.ethUsdSrc = best.p.key;
      }
    }

    const now = Date.now();
    for (const t of tokens.values()) {
      if (t.decimals == null) continue;
      let top = null;
      let cur = 0;
      for (const k of t.pools) {
        const p = pools.get(k);
        if (!p) continue;
        const d = cappedD10(t, p);
        if (k === t.primary) cur = d;
        if (!top || d > top.d) top = { k, d };
      }
      if (!top) continue;
      if (t.pinned && pools.has(t.pinned)) {
        // a coin listed on-chain is priced only from the pool it is bound to there (keeper.pin)
        setPrimary(t, t.pinned, now);
        top = { k: t.pinned, d: cappedD10(t, pools.get(t.pinned)) };
      } else if (!t.primary || !pools.has(t.primary) || top.d > cur * 1.5) {
        // switch the price source only on a clear win: two pools of one coin can sit at different prices for a while
        setPrimary(t, top.k, now);
      } else top = { k: t.primary, d: cur };
      t.d10 = Math.min(top.d, dsCap(t));
      const px = spot(t);
      if (!px || !isFinite(px)) continue;
      t.samples.push([now, px, state.head]); // [ms, price, L2 block the price is valid at]
      const cut = now - CFG.keepSamplesS * 1000;
      while (t.samples.length && t.samples[0][0] < cut) t.samples.shift();

      // rug: -80% against the 30s high
      const wcut = now - R.rugWindowS * 1000;
      let hi = 0;
      for (let i = t.samples.length - 1; i >= 0 && t.samples[i][0] >= wcut; i--) hi = Math.max(hi, t.samples[i][1]);
      const settled = now - (t.primaryAt || 0) > R.rugWindowS * 1000;
      if (settled && hi && px <= hi * (1 - R.rugDrop) && t.lockedUntil < now) {
        t.lockedUntil = now + R.rugLockS * 1000;
        console.log(`rug guard: ${t.symbol} ${hi} -> ${px}`);
        rugHandlers.forEach((fn) => fn(t, px));
      }
    }
    // keep one hour of swap volume (a day when the engine counts 24h stats itself)
    const vcut = now - CFG.keepVolS * 1000;
    for (const p of pools.values()) while (p.vol.length && p.vol[0][0] < vcut) p.vol.shift();
  }, CFG.sampleMs);
}

/** No DexScreener: every 30 s, how many coins each v3 pool of a listed coin actually holds. */
async function v3BalanceLoop() {
  for (;;) {
    const list = [];
    for (const t of tokens.values()) {
      if (t.decimals == null) continue;
      for (const k of t.pools) if (pools.get(k)?.kind === "v3") list.push([t, pools.get(k)]);
    }
    for (let i = 0; i < list.length; i += 100) {
      const part = list.slice(i, i + 100);
      try {
        const res = await client.multicall({
          contracts: part.map(([t, p]) => ({ address: t.addr, abi: balAbi, functionName: "balanceOf", args: [p.key] })),
          allowFailure: true,
        });
        res.forEach((r, j) => {
          const [t, p] = part[j];
          if (r.status === "success") p.tokenBal = Number(r.result) / 10 ** t.decimals;
        });
      } catch (e) {
        console.warn("v3 balances", e.shortMessage || e.message);
      }
    }
    await sleep(30_000);
  }
}
const balAbi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];

/** Hours of swaps the engine has actually seen (backfill + live), at most 24. */
export const statsWindowH = () => (state.since ? Math.min(24, (Date.now() - state.since) / 3600_000) : 0);

/**
 * No DexScreener: 24h stats from the engine's own swap stream. Until a full day is seen they cover
 * statsWindowH() hours, and admission scales the trade/volume floors to that window.
 */
function chainStatsLoop() {
  setInterval(() => {
    const now = Date.now();
    const cut = now - 24 * 3600_000;
    for (const t of tokens.values()) {
      if (!t.primary) continue;
      let txns = 0;
      let volEthSum = 0;
      for (const k of t.pools) {
        const p = pools.get(k);
        if (!p || p.tokenIs0 == null) continue;
        for (const v of p.vol) if (v[0] >= cut) txns++;
        volEthSum += volEth(p, cut);
      }
      const prim = pools.get(t.primary);
      const s = t.samples;
      const old = s.find((q) => q[0] >= now - 3600_000);
      const px = spot(t);
      t.ds = {
        vol24Usd: state.ethUsd ? volEthSum * state.ethUsd : 0,
        txns24: txns,
        createdAt: prim?.createdAt ?? null,
        chg1h: old && px && now - s[0][0] > 50 * 60_000 ? (px / old[1] - 1) * 100 : null,
        chg24h: null,
        image: null,
        dexId: prim?.dexId,
        mcapUsd: mcapUsd(t),
        priceUsd: px && state.ethUsd ? px * state.ethUsd : null,
        liqUsd: null,
        windowH: statsWindowH(),
      };
      t.dsAt = now;
    }
  }, 5000);
}

/** DexScreener 24h stats for admission, refreshed for coins that traded lately. */
async function statsLoop() {
  for (;;) {
    const now = Date.now();
    const due = [...tokens.values()]
      .filter((t) => t.primary && (!t.dsAt || now - t.dsAt > 90_000))
      .sort((a, b) => (a.dsAt || 0) - (b.dsAt || 0))
      .slice(0, 30);
    if (due.length) {
      const pairs = await pairsByToken(due.map((t) => t.addr));
      for (const t of due) {
        t.dsAt = now;
        const mine = pairs.filter((x) => lc(x.baseToken.address) === t.addr || lc(x.quoteToken.address) === t.addr);
        if (!mine.length) continue;
        const prim = mine.find((x) => lc(x.pairAddress) === t.primary) || mine.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
        t.ds = {
          vol24Usd: mine.reduce((s, x) => s + (x.volume?.h24 || 0), 0),
          txns24: mine.reduce((s, x) => s + (x.txns?.h24?.buys || 0) + (x.txns?.h24?.sells || 0), 0),
          createdAt: prim.pairCreatedAt || null,
          chg1h: prim.priceChange?.h1 ?? null,
          chg24h: prim.priceChange?.h24 ?? null,
          image: prim.info?.imageUrl || null,
          dexId: prim.dexId,
          mcapUsd: prim.marketCap ?? prim.fdv ?? null,
          priceUsd: prim.priceUsd && lc(prim.baseToken.address) === t.addr ? Number(prim.priceUsd) : null,
          // liquidity on all of the coin's pools; half of it is the ETH/USD side
          liqUsd: mine.reduce((s, x) => s + (x.liquidity?.usd || 0), 0),
        };
        if (!t.symbol || t.symbol === "?") t.symbol = lc(prim.baseToken.address) === t.addr ? prim.baseToken.symbol : prim.quoteToken.symbol;
        // fallback ETH/USD from any WETH-quoted pair
        if (!state.ethUsd && lc(prim.quoteToken.address) === CFG.WETH && prim.priceUsd && prim.priceNative) {
          state.ethUsd = Number(prim.priceUsd) / Number(prim.priceNative);
          state.ethUsdSrc = "dexscreener";
        }
      }
    }
    await sleep(due.length ? 500 : 3000);
  }
}

// ---------- admission ----------

export function mcapUsd(t) {
  const px = spot(t);
  return px && t.supply && state.ethUsd ? px * t.supply * state.ethUsd : null;
}

export function admission(t) {
  const reasons = [];
  const now = Date.now();
  if (!t.primary || spot(t) == null) reasons.push(`no live ${CFG.native}/${CFG.usdSymbol} pool`);
  const mc = mcapUsd(t);
  if (mc != null && mc < R.minMcapUsd) reasons.push(`market cap under $${R.minMcapUsd / 1000}K`);
  const created = pools.get(t.primary)?.createdAt || t.ds?.createdAt;
  // a featured pool is hand-picked, so a PoolCreated scan that came back empty does not shut it
  if (!created && !CFG.featuredPools.includes(t.primary)) reasons.push("pool age unknown");
  else if (now - created < R.minPoolAgeH * 3600_000) reasons.push(`pool younger than ${R.minPoolAgeH < 1 ? Math.round(R.minPoolAgeH * 60) + " min" : R.minPoolAgeH + "h"}`);
  if (!t.ds || (!DS && !state.ready)) reasons.push("24h stats loading");
  else {
    // own-stream stats cover windowH hours until a full day is seen: scale the floors to it
    const f = t.ds.windowH == null ? 1 : Math.min(1, t.ds.windowH / 24);
    const minTx = Math.ceil(R.minTxns24h * f);
    const minVol = R.minVol24hUsd * f;
    const span = f < 1 ? `${t.ds.windowH.toFixed(1)}h seen` : "24h";
    if (t.ds.txns24 < minTx) reasons.push(`under ${minTx} trades in ${span}`);
    if (t.ds.vol24Usd < minVol) reasons.push(`under $${(minVol / 1000).toFixed(minVol < 1000 ? 2 : 0)}K volume in ${span}`);
  }
  let maxLev = 0;
  for (const [d, lev] of R.tiers) if ((t.d10 || 0) >= d) { maxLev = lev; break; }
  if (!maxLev) reasons.push(`too thin: ${(t.d10 || 0).toFixed(2)} ${CFG.native} moves it 10%`);
  if (t.lockedUntil > now) reasons.push(`rug guard lock, ${Math.ceil((t.lockedUntil - now) / 60000)} min left`);
  return { ok: reasons.length === 0, maxLev: reasons.length ? 0 : maxLev, reasons };
}

export function view(t, withSamples = false) {
  const p = pools.get(t.primary);
  const adm = admission(t);
  const px = spot(t);
  const s = t.samples;
  const ago = (sec) => {
    const cut = Date.now() - sec * 1000;
    const x = s.find((q) => q[0] >= cut);
    return x && px ? (px / x[1] - 1) * 100 : null;
  };
  return {
    token: t.addr,
    symbol: t.symbol || "?",
    name: t.name || "",
    image: t.ds?.image || null,
    priceEth: px,
    priceUsd: px && state.ethUsd ? px * state.ethUsd : null,
    twapEth: twap(t),
    mcapUsd: mcapUsd(t),
    d10: t.d10 || 0,
    vol1hEth: p ? volEth(p, Date.now() - 3600_000) : 0,
    vol24Usd: t.ds?.vol24Usd ?? null,
    txns24: t.ds?.txns24 ?? null,
    chg5m: ago(300),
    chg1h: t.ds?.chg1h ?? null,
    chg24h: t.ds?.chg24h ?? null,
    pool: t.primary,
    poolKind: p?.kind,
    dex: p?.dexId,
    quote: p ? (p.quoteUsd ? CFG.usdSymbol : CFG.native) : null,
    statsWindowH: t.ds?.windowH ?? null,
    createdAt: p?.createdAt || t.ds?.createdAt || null,
    lastSwap: p?.lastSwap || null,
    ...adm,
    ds: t.ds ? { mcapUsd: t.ds.mcapUsd, priceUsd: t.ds.priceUsd, liqUsd: t.ds.liqUsd } : null,
    samples: withSamples ? s.map(([a, b]) => [a, b]) : undefined,
  };
}

// [R] A lookup of an unseen coin scans the whole history of every PoolManager (or asks DexScreener): one scan at a
// time engine-wide, a short queue, and a coin with nothing to find is not scanned again for a while.
const LOOKUP_QUEUE = 8;
const MISS_MS = 2 * 60_000;
const missed = new Map(); // addr -> ms until which a lookup that found no pool is not repeated
const looking = new Map(); // addr -> lookup in progress
let lookupTail = Promise.resolve();
let lookupsQueued = 0;

/** Paste-any-CA path: learn a coin we have not seen swap yet. -> coin | null */
export function lookup(addr) {
  addr = lc(addr);
  const t = tokens.get(addr);
  if (t?.primary) return Promise.resolve(t);
  if ((missed.get(addr) || 0) > Date.now()) return Promise.resolve(null);
  if (looking.has(addr)) return looking.get(addr);
  if (lookupsQueued >= LOOKUP_QUEUE) return Promise.reject(Object.assign(new Error("too many coin lookups at once: try again in a few seconds"), { busy: true }));
  lookupsQueued++;
  const scan = lookupTail.then(() => findCoin(addr)).finally(() => lookupsQueued--);
  lookupTail = scan.catch(() => {});
  const job = scan
    .then(async (r) => {
      const none = !r.t || ![...r.t.pools].some((k) => pools.has(k));
      if (none && r.complete) {
        if (missed.size > 10_000) missed.clear();
        missed.set(addr, Date.now() + MISS_MS);
      }
      if (!r.t) return null;
      r.t.dsAt = 0;
      await sleep(1200); // let the sampler pick a primary pool (outside the scan queue)
      return r.t;
    })
    .finally(() => looking.delete(addr));
  looking.set(addr, job);
  return job;
}

/** -> { t, complete } (complete: no query failed, so "nothing found" is an answer, not an RPC hiccup) */
async function findCoin(addr) {
  let t = tokens.get(addr);
  if (t?.primary) return { t, complete: true };
  let complete = !DS; // DexScreener answers [] on failure too: its "nothing" is never cached
  if (!DS) {
    // v4 pools only: v3 forks have no common registry, they show up once they swap
    const found = await v4PoolsOf(addr).catch(() => {
      complete = false;
      return [];
    });
    for (const x of found) {
      if (ignored.has(x.key)) continue;
      let p = pools.get(x.key);
      if (!p) {
        p = {
          key: x.key, kind: "v4", manager: x.manager, vol: [], swaps: 0, token0: x.c0, c1: x.c1,
          hooks: x.hooks, fee: x.fee, tickSpacing: x.tickSpacing, createdAt: x.createdAt, dexId: "v4",
        };
        pools.set(x.key, p);
        attach(p, x.c0, x.c1, null, null);
      }
      if (pools.has(x.key) && !p.sqrtP) {
        try {
          Object.assign(p, await poolState(p));
        } catch {}
      }
    }
  }
  const pairs = DS ? (await pairsByToken([addr])).filter((x) => x.chainId === CFG.dexscreener) : [];
  for (const x of pairs) {
    const key = lc(x.pairAddress);
    if (ignored.has(key)) continue;
    let p = pools.get(key);
    if (!p) {
      p = { key, kind: key.length === 66 ? "v4" : "v3", vol: [], swaps: 0 };
      pools.set(key, p);
    }
    if (!p.token) attach(p, x.baseToken.address, x.quoteToken.address, Number(x.priceNative), x);
    if (!pools.has(key)) continue;
    if (!p.sqrtP) {
      try {
        Object.assign(p, await poolState(p));
      } catch {}
    }
  }
  t = tokens.get(addr);
  if (!t) return { t: null, complete };
  if (t.decimals == null) {
    const [m] = await tokenMeta([addr]);
    t.symbol = m.symbol || "?";
    t.name = m.name || "";
    t.decimals = m.decimals ?? 18;
    t.supply = m.totalSupply == null ? 0 : Number(m.totalSupply) / 10 ** t.decimals;
    needMeta.delete(addr);
  }
  return { t, complete };
}

/**
 * A pool by key, read from the chain if the engine has not seen it swap since start (v4: its Initialize event on the
 * given manager, or on each known one). Added to the engine only once fully read. -> the pool, or null
 */
export async function loadPool(key, { kind, manager } = {}) {
  key = lc(key);
  if (pools.has(key)) return pools.get(key);
  if (ignored.has(key)) return null;
  kind = kind || (key.length === 66 ? "v4" : "v3");
  let p = null;
  let c1;
  try {
    if (kind === "v4") {
      for (const m of manager ? [lc(manager)] : CFG.poolManagers) {
        const i = (await v4Init(m, [key])).get(key);
        if (!i) continue;
        p = { key, kind, manager: m, vol: [], swaps: 0, token0: i.c0, c1: i.c1, hooks: i.hooks, fee: i.fee, tickSpacing: i.tickSpacing, createdAt: i.createdAt, dexId: "v4" };
        c1 = i.c1;
        break;
      }
      if (!p) return null;
    } else {
      const [t0, t1] = await v3Tokens(key);
      const v = await verifyV3(key, t0, t1);
      if (!v) return null;
      p = { key, kind, manager: null, vol: [], swaps: 0, token0: t0, fee: v.fee, factory: v.factory, createdAt: await v3CreatedAt(key, t0, t1), dexId: "v3" };
      c1 = t1;
    }
    Object.assign(p, await poolState(p));
  } catch {
    return null; // nothing half-read stays behind: the next call reads it again
  }
  if (pools.has(key)) return pools.get(key); // it swapped meanwhile
  pools.set(key, p);
  attach(p, p.token0, c1, null, null);
  return pools.has(key) ? p : null;
}

/**
 * Bind a coin to the pool it is listed with on-chain (InversePool priceSource / V4SpotSource feed) and make sure the
 * engine holds that pool even if it has not swapped since start. From then on the coin's price, depth, samples and
 * rug checks come only from this pool, at once (the sampler would switch only on its next pass).
 * decimals: the market's on-chain decimals, used until the token's metadata is read. -> the pool, or null
 */
export async function pin(token, key, { kind, manager, decimals } = {}) {
  token = lc(token);
  key = lc(key);
  const p = await loadPool(key, { kind, manager });
  if (!p || p.token !== token) return null;
  const t = coin(token);
  if (t.decimals == null && decimals != null) t.decimals = Number(decimals);
  t.pinned = key;
  t.pools.add(key);
  setPrimary(t, key);
  if (t.decimals != null) t.d10 = Math.min(cappedD10(t, p), dsCap(t));
  return p;
}

/** Re-read a pinned pool's on-chain state (liquidity can be pulled without a Swap event). */
export async function refreshPool(key) {
  const p = pools.get(lc(key));
  if (!p) return null;
  Object.assign(p, await poolState(p));
  return p;
}

/**
 * The native/USD anchor without waiting for a swap. On a quiet chain the WHYPE/USDC pools can go an hour without
 * one, and without the anchor every coin's volume reads $0 and nothing opens (Elysium testnet, 09.11.2026). So load
 * those pools from the allowed v3 factories at start and re-read them every few minutes.
 */
async function usdAnchorLoop() {
  const keys = new Set();
  for (const f of CFG.v3Factories) for (const k of await v3PoolsFor(f, CFG.WETH, CFG.USD)) keys.add(k);
  console.log(`[markets] ${CFG.native}/USD anchor pools: ${keys.size}`);
  for (;;) {
    for (const k of keys) {
      try {
        if (pools.has(k)) await refreshPool(k);
        else await loadPool(k);
      } catch {}
    }
    await sleep(5 * 60_000);
  }
}

/**
 * Featured pools (CFG.featuredPools): loaded at start and re-read every few minutes whether or not they swap, so a
 * quiet chain still has coins on the board. Each still passes the same admission as any other coin.
 */
async function featuredLoop() {
  for (;;) {
    let n = 0;
    for (const k of CFG.featuredPools) {
      try {
        if (pools.has(k)) await refreshPool(k);
        else await loadPool(k);
        if (pools.has(k)) n++;
      } catch {}
    }
    if (!featuredLoop.logged) console.log(`[markets] featured pools loaded: ${n}/${CFG.featuredPools.length}`);
    featuredLoop.logged = true;
    await sleep(5 * 60_000);
  }
}

export function start() {
  pollLoop().catch((e) => console.error("pollLoop died", e));
  if (!DS && CFG.v3Factories) usdAnchorLoop().catch((e) => console.error("usdAnchorLoop died", e));
  if (CFG.featuredPools.length) featuredLoop().catch((e) => console.error("featuredLoop died", e));
  resolveLoop().catch((e) => console.error("resolveLoop died", e));
  if (DS) statsLoop().catch((e) => console.error("statsLoop died", e));
  else {
    chainStatsLoop();
    v3BalanceLoop().catch((e) => console.error("v3BalanceLoop died", e));
  }
  sampleLoop();
}
