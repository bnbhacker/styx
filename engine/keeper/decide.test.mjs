// node --test inverse-rh/engine/keeper/  — pure keeper decisions, mirrored on InversePool v1.1 / V4SpotSource.
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "./decide.mjs";

const E = 10n ** 18n;

test("toWad keeps 15 significant digits across magnitudes", () => {
  assert.equal(D.toWad(1), E);
  assert.equal(D.toWad(0.001), 10n ** 15n);
  assert.equal(D.toWad(4.8e-6), 4_800_000_000_000n);
  assert.equal(D.toWad(1234.5), 1234_500_000_000_000_000_000n);
  assert.equal(D.toWad(0), 0n);
  assert.equal(D.toWad(-1), 0n);
  assert.equal(D.toWad(NaN), 0n);
  // WAD is wei per whole token: a 3e-9 price has ~10 significant digits in wei, so the loss is under 1 wei
  assert.equal(D.toWad(3.14159265358979e-9), 3_141_592_653n);
  const x = 0.0123456789012345;
  assert.ok(Math.abs(D.fromWad(D.toWad(x)) / x - 1) < 1e-13);
});

test("execBlock: window [req+min, req+max], engine head, pool not moved since", () => {
  const w = { req: 100n, minD: 1n, maxD: 20n };
  assert.deepEqual(D.execBlock({ ...w, head: 100n, lastSwapBlock: 50n }), { wait: true });
  assert.deepEqual(D.execBlock({ ...w, head: 101n, lastSwapBlock: 50n }), { block: 101n });
  assert.deepEqual(D.execBlock({ ...w, head: 115n, lastSwapBlock: 115n }), { block: 115n });
  // engine is past the window but the pool has not traded since: its state at req+20 is the current one
  assert.deepEqual(D.execBlock({ ...w, head: 160n, lastSwapBlock: 90n }), { block: 120n });
  // ... unless it traded after req+20
  assert.deepEqual(D.execBlock({ ...w, head: 160n, lastSwapBlock: 121n }), { missed: true });
  assert.deepEqual(D.execBlock({ ...w, head: 160n, lastSwapBlock: null }), { block: 120n });
});

/** V4SpotSource.quote acceptance, transcribed. */
function bandOk(price, spot, lowerIsBetter, fav, worse) {
  const lo = (spot * (D.BPS - (lowerIsBetter ? fav : worse))) / D.BPS;
  const hi = (spot * (D.BPS + (lowerIsBetter ? worse : fav))) / D.BPS;
  return price >= lo && price <= hi;
}

test("fitBand: inside V4SpotSource's band, and only ever worse for the trader", () => {
  const spot = 10n ** 15n;
  const band = { favBps: 200n, worseBps: 500n };
  for (const lowerIsBetter of [true, false]) {
    for (const p of [spot / 2n, (spot * 97n) / 100n, spot, (spot * 104n) / 100n, spot * 2n]) {
      const r = D.fitBand(p, spot, { lowerIsBetter, ...band });
      if (r.outOfBand) continue;
      assert.ok(bandOk(r.price, spot, lowerIsBetter, 200n, 500n), `${lowerIsBetter} ${p} -> ${r.price}`);
      // never better for the trader than the engine's price
      assert.ok(lowerIsBetter ? r.price >= p : r.price <= p, "moved in the trader's favour");
    }
  }
  assert.deepEqual(D.fitBand(spot, spot, { lowerIsBetter: true, ...band }), { price: spot });
  // a buyer whose worse-of is 10 % above spot (TWAP lags a dump) is refused, not pulled to +5 %
  assert.deepEqual(D.fitBand((spot * 11n) / 10n, spot, { lowerIsBetter: true, ...band }), { outOfBand: true });
  // a buyer quoted 5 % below spot (too good) is raised to the band edge
  const r = D.fitBand((spot * 95n) / 100n, spot, { lowerIsBetter: true, ...band });
  assert.ok(r.price > (spot * 98n) / 100n && r.price < spot);
  // a seller after a pump (worse-of = lagging average far below spot) is refused, not lifted to -5 %
  assert.deepEqual(D.fitBand((spot * 8n) / 10n, spot, { lowerIsBetter: false, ...band }), { outOfBand: true });
});

test("fitTwap is one-sided the same way", () => {
  const tw = 10n ** 15n;
  assert.deepEqual(D.fitTwap(tw * 2n, tw, 300n, true), { outOfBand: true });
  const r = D.fitTwap(tw * 2n, tw, 300n, false);
  assert.ok(r.price <= (tw * 103n) / 100n && r.price > tw);
});

test("policyCode: stake, leverage, new account, one side per coin", () => {
  const policy = { maxStake: 5, maxLev: 5, newAccountStake: 1 };
  const p = (stake, leverage) => ({ stake: BigInt(Math.round(stake * 1e18)), leverage });
  assert.equal(D.policyCode(p(2, 5), { policy, firstSeenS: 0, nowS: 100_000 }), null);
  assert.equal(D.policyCode(p(6, 2), { policy, firstSeenS: 0, nowS: 100_000 }), D.CODES.POOL_CAP);
  assert.equal(D.policyCode(p(1, 10), { policy, firstSeenS: 0, nowS: 100_000 }), D.CODES.LEVERAGE);
  assert.equal(D.policyCode(p(2, 2), { policy, firstSeenS: 90_000, nowS: 100_000 }), D.CODES.NEW_ACCOUNT_CAP);
  assert.equal(D.policyCode(p(1, 2), { policy, firstSeenS: 90_000, nowS: 100_000 }), null);
  assert.equal(D.policyCode(p(1, 2), { policy, firstSeenS: 0, nowS: 100_000, opposite: true }), D.CODES.OPPOSITE_SIDE);
  assert.equal(D.policyCode(p(99, 10), { policy: { maxStake: 0, maxLev: 0, newAccountStake: 0 }, nowS: 0 }), null);
});

const pos = (o) => ({ stake: E, leverage: 10, isLong: true, entryPrice: 10n ** 15n, maxWin: 2n * E, tp: 0n, sl: 0n, openTime: 0, ...o });

test("rawPnl / clampedPnl match the contract's formula and clamps", () => {
  const p = pos();
  assert.deepEqual(D.rawPnl(p, 11n * 10n ** 14n), { gain: true, mag: E }); // +10 % at 10x = +1 stake
  assert.equal(D.clampedPnl(p, 2n * 10n ** 15n), 2n * E); // capped at +200 %
  assert.equal(D.clampedPnl(p, 5n * 10n ** 14n), -E); // floored at -100 %
  const s = pos({ isLong: false });
  assert.equal(D.clampedPnl(s, 5n * 10n ** 14n), 2n * E);
  assert.equal(D.clampedPnl(s, 5n * 10n ** 14n, { rugLocked: true, rugCapBps: 2000n }), E / 5n); // rug cap +20 %
});

test("triggerFor mirrors _checkReason (losses first, TP needs the hold)", () => {
  const p = pos({ sl: 95n * 10n ** 13n, tp: 12n * 10n ** 14n, openTime: 1000 });
  const at = (x, now = 2000) => D.triggerFor(p, x, { nowS: now, minHold: 10 });
  assert.equal(at(10n ** 15n), null);
  assert.equal(at(95n * 10n ** 13n), "SL");
  assert.equal(at(9n * 10n ** 14n), "CAP_LOSS"); // -10 % at 10x
  assert.equal(at(12n * 10n ** 14n), "CAP_WIN"); // +20 % at 10x = +200 %
  const q = pos({ tp: 105n * 10n ** 13n, openTime: 1000 });
  assert.equal(D.triggerFor(q, 106n * 10n ** 13n, { nowS: 1005, minHold: 10 }), null, "TP before the hold");
  assert.equal(D.triggerFor(q, 106n * 10n ** 13n, { nowS: 1010, minHold: 10 }), "TP");
  const s = pos({ isLong: false, sl: 105n * 10n ** 13n });
  assert.equal(D.triggerFor(s, 106n * 10n ** 13n, { nowS: 0, minHold: 10 }), "SL");
});

test("notionalCap = min(0.2, 10·fee) · D10", () => {
  assert.equal(D.notionalCap(100, 10_000), D.toWad(10)); // 1 % pool: 0.1·D10
  assert.equal(D.notionalCap(100, 30_000), D.toWad(20)); // 3 % pool: capped at 0.2
  assert.equal(D.notionalCap(100, 3_000), D.toWad(3)); // 0.3 % pool: 0.03·D10
  assert.equal(D.notionalCap(100, null), D.toWad(10)); // unknown fee: half the old rule
  assert.equal(D.notionalCap(100, 0), D.toWad(10)); // hook-taken fee (PoolKey says 0): same
  assert.equal(D.notionalCap(100, 0x800000), D.toWad(10)); // dynamic-fee flag: unknown, not "max fee"
});

test("rugPlan: -80 % within the block window, fresh", () => {
  const s = [
    [0, 1.0, 1000n],
    [1, 1.2, 1100n],
    [2, 0.2, 1350n],
  ];
  const p = D.rugPlan(s, { head: 1360n, windowBlocks: 280n, dropBps: 8000n });
  assert.ok(p);
  assert.equal(p.blockBefore, 1100n); // the high inside the window, not the older one
  assert.equal(p.blockAfter, 1350n);
  assert.equal(D.rugPlan(s, { head: 1360n, windowBlocks: 200n, dropBps: 8000n }), null, "high outside the window");
  assert.equal(D.rugPlan(s, { head: 1400n, windowBlocks: 280n, dropBps: 8000n }), null, "stale after-price");
  assert.equal(D.rugPlan([[0, 1, 1n], [1, 0.5, 2n]], { head: 2n, windowBlocks: 280n, dropBps: 8000n }), null, "-50 % is not a rug");
});

test("insiderShare: top holders plus mint recipients, pools and burn excluded but still supply", () => {
  const bal = new Map([
    ["pool", 600n],
    ["dead", 100n],
    ["dev", 150n],
    ["a", 100n],
    ["b", 50n],
    ["gone", 0n],
  ]);
  const r = D.insiderShare(bal, { minted: ["dev", "gone"], exclude: new Set(["pool", "dead"]), top: 1 });
  // top 1 of the free holders is dev (150); dev is also the mint recipient: counted once
  assert.equal(r.share, 0.15);
  assert.deepEqual(r.holders, [["dev", 0.15]]);
  const all = D.insiderShare(bal, { exclude: new Set(["pool", "dead"]) });
  assert.equal(all.share, 0.3);
  // a mint recipient outside the top still counts
  assert.equal(D.insiderShare(bal, { minted: ["b"], exclude: new Set(["pool", "dead"]), top: 1 }).share, 0.2);
  assert.equal(D.insiderShare(new Map([["x", 0n]])), null);
});

test("insiderTier / insiderRefuses: 20 % and 40 % steps, unknown is the strictest", () => {
  assert.equal(D.insiderTier(0.2).tier, 0);
  assert.deepEqual(D.insiderTier(0.3), { tier: 1, maxLev: 5, notionalDiv: 2n, maxWinPoolBps: 0n });
  assert.equal(D.insiderTier(0.41).tier, 2);
  assert.equal(D.insiderTier(null).tier, 2);
  const short = (leverage, stake = E) => ({ isLong: false, leverage, stake });
  const pool = { shortMaxWin: 0n, poolBase: 1000n * E, maxWinBps: 20_000n };
  assert.equal(D.insiderRefuses({ ...short(10), isLong: true }, D.insiderTier(0.9), pool), false); // longs never
  assert.equal(D.insiderRefuses(short(10), D.insiderTier(0.1), pool), false);
  assert.equal(D.insiderRefuses(short(10), D.insiderTier(0.3), pool), true);
  assert.equal(D.insiderRefuses(short(5), D.insiderTier(0.3), pool), false);
  assert.equal(D.insiderRefuses(short(5), D.insiderTier(0.5), pool), true);
  // tier 2: shorts' max win at most 1 % of the pool (10 of 1000): 2 x stake each
  assert.equal(D.insiderRefuses(short(2, 5n * E), D.insiderTier(0.5), pool), false); // 10 = the limit
  assert.equal(D.insiderRefuses(short(2, 5n * E + 1n), D.insiderTier(0.5), pool), true);
  assert.equal(D.insiderRefuses(short(2, E), D.insiderTier(0.5), { ...pool, shortMaxWin: 9n * E }), true);
});

test("clusters: a shared funder joins wallets, bridges and hubs join nobody", () => {
  const id = (links, opt) => D.clusters(new Map(Object.entries(links)), opt);
  let c = id({ a: "f", b: "f", c: null, d: "a" });
  assert.equal(c.get("a"), c.get("b"));
  assert.equal(c.get("d"), c.get("a")); // funded by a
  assert.notEqual(c.get("c"), c.get("a"));
  assert.equal(c.get("c"), "c");
  // an excluded funder (bridge, exchange) links nobody
  c = id({ a: "bridge", b: "bridge" }, { exclude: new Set(["bridge"]) });
  assert.notEqual(c.get("a"), c.get("b"));
  // a funder of more than `hub` wallets is a hub
  c = id({ a: "h", b: "h", c: "h" }, { hub: 2 });
  assert.notEqual(c.get("a"), c.get("b"));
  c = id({ a: "h", b: "h" }, { hub: 2 });
  assert.equal(c.get("a"), c.get("b"));
  // self-funding and chains
  c = id({ a: "a", b: "a", c: "b" });
  assert.equal(c.get("c"), c.get("a"));
});
