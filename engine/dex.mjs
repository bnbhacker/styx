/**
 * DexScreener: pool metadata (which token / which quote) and 24h stats for
 * admission. Prices never come from here — only from the chain.
 * Limit is 300 req/min; we stay at ~4/s through one queue.
 */
import { CFG } from "./config.mjs";

const BASE = "https://api.dexscreener.com";
let chain = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function queued(url) {
  const run = chain.then(async () => {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(url, { headers: { accept: "application/json" } });
        if (r.status === 429) {
          await sleep(3000);
          continue;
        }
        if (!r.ok) return null;
        return await r.json();
      } catch {
        await sleep(1000);
      }
    }
    return null;
  });
  chain = run.then(() => sleep(250));
  return run;
}

/** Pairs by pool address / v4 pool id, up to 30 at a time. */
export async function pairsByPool(keys) {
  const j = await queued(`${BASE}/latest/dex/pairs/${CFG.dexscreener}/${keys.join(",")}`);
  return j?.pairs ?? [];
}

/** All pairs of up to 30 tokens. */
export async function pairsByToken(tokens) {
  const j = await queued(`${BASE}/tokens/v1/${CFG.dexscreener}/${tokens.join(",")}`);
  return Array.isArray(j) ? j : [];
}
