// Markets showcase: a few mainnet memecoins (CFG.showcase) with their live DexScreener numbers.
// Display only. The engine does not index these coins, has no Styx market for them and nothing trades them here;
// the site marks them "mainnet · soon". One request for all pairs a minute, the last good answer kept on errors.
import { CFG } from "./config.mjs";

const EVERY_MS = 60_000;
let list = [];

const num = (x) => (x == null || x === "" || !isFinite(Number(x)) ? null : Number(x));
const http = (u) => (typeof u === "string" && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : null);

async function refresh() {
  const S = CFG.showcase;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${S.chain}/${S.pairs.join(",")}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const by = new Map((j.pairs || []).map((p) => [String(p.pairAddress).toLowerCase(), p]));
    // the configured order, not DexScreener's
    const next = S.pairs
      .map((id) => by.get(id.toLowerCase()))
      .filter(Boolean)
      .map((p) => {
        const token = String(p.baseToken?.address || "").toLowerCase();
        return {
          token,
          symbol: String(p.baseToken?.symbol || "?").slice(0, 24),
          name: String(p.baseToken?.name || "").slice(0, 48),
          quote: String(p.quoteToken?.symbol || "").slice(0, 12),
          // DexScreener's small per-token icon (~1 KB); its CMS image only comes at full size (other widths give 422)
          image: /^0x[0-9a-f]{40}$/.test(token) ? `https://dd.dexscreener.com/ds-data/tokens/${S.chain}/${token}.png` : http(p.info?.imageUrl),
          url: http(p.url),
          priceUsd: num(p.priceUsd),
          chg5m: num(p.priceChange?.m5) ?? 0,
          chg24h: num(p.priceChange?.h24),
          mcapUsd: num(p.marketCap) ?? num(p.fdv),
          liqUsd: num(p.liquidity?.usd),
          vol24Usd: num(p.volume?.h24),
        };
      });
    if (next.length) list = next;
  } catch (e) {
    console.warn("[showcase] DexScreener:", e.message);
  }
}

export const showcase = () => list;

export function start() {
  if (!CFG.showcase?.pairs?.length) return;
  refresh();
  setInterval(refresh, EVERY_MS).unref?.();
}
