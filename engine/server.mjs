import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CFG } from "./config.mjs";
import * as M from "./markets.mjs";
import * as P from "./paper.mjs";
import * as KP from "./keeper/keeper.mjs";
import * as R from "./real.mjs";
import { startLedger } from "./keeper/ledger.mjs";
import * as SC from "./showcase.mjs";

// the keeper runs in this process: one stray promise must not take it down
process.on("unhandledRejection", (e) => console.error("[engine] unhandled rejection:", e));

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "site");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const BODY_MAX = 100_000; // bytes

/** An error with its own HTTP status. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (res, code, body, headers = {}) => {
  if (res.headersSent || res.destroyed) return void res.destroy();
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body ?? null, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
};

/** The JSON body, at most BODY_MAX bytes. Settles once; past the limit it stops reading (413, then the socket goes). */
const readBody = (req) =>
  new Promise((ok, no) => {
    if (Number(req.headers["content-length"]) > BODY_MAX) return no(new HttpError(413, "body too large"));
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      fn(v);
    };
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_MAX) {
        req.removeAllListeners("data");
        req.pause();
        return done(no, new HttpError(413, "body too large"));
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      try {
        done(ok, size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        done(no, new P.UserError("bad json"));
      }
    });
    req.on("error", (e) => done(no, e));
    req.on("close", () => done(no, new Error("request closed")));
  });

// ───────────────────────────── client identity (rate limits) ─────────────────────────────

/** The first 64 bits of an IPv6 address (valid per net.isIPv6, no zone), as four hex groups. */
function v6prefix(a) {
  const [head, tail] = a.includes("::") ? a.split("::") : [a, null];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const width = (xs) => xs.reduce((s, x) => s + (x.includes(".") ? 2 : 1), 0); // a dotted IPv4 tail is two groups
  const groups = tail == null ? h : [...h, ...Array(Math.max(0, 8 - width(h) - width(t))).fill("0"), ...t];
  return groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(":");
}

/** One bucket key per client: IPv4 as is (v4-mapped unwrapped), IPv6 by its /64. */
function clientKey(a) {
  a = String(a || "").trim().toLowerCase();
  let m;
  if ((m = /^\[([^\]]+)\](?::\d+)?$/.exec(a))) a = m[1];
  else if ((m = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(a))) a = m[1];
  if ((m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a))) a = m[1];
  if (net.isIPv4(a)) return a;
  const v6 = a.split("%")[0];
  if (net.isIPv6(v6)) return v6prefix(v6) + "::/64";
  return a.slice(0, 64) || "?";
}

/**
 * The client behind `hops` trusted reverse proxies (STYX_TRUST_PROXY): each proxy appends its peer to
 * X-Forwarded-For, so the client is the hops-th entry from the right; anything left of it is the client's own claim.
 * hops = 0 (default): the socket peer, X-Forwarded-For ignored.
 */
function clientIp(req, hops = CFG.trustProxy) {
  let a = req.socket?.remoteAddress || "";
  if (hops > 0) {
    const xff = String(req.headers["x-forwarded-for"] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (xff.length >= hops) a = xff[xff.length - hops];
  }
  return clientKey(a);
}

// ───────────────────────────── routes ─────────────────────────────

function markets(q) {
  let list = [...M.tokens.values()].filter((t) => t.primary && t.symbol);
  if (q) {
    const s = q.toLowerCase();
    list = list.filter((t) => t.addr.includes(s) || (t.symbol || "").toLowerCase().includes(s) || (t.name || "").toLowerCase().includes(s));
  }
  return list
    .map((t) => M.view(t))
    .filter((v) => v.priceEth)
    .sort((a, b) => (b.ok - a.ok) || (b.vol24Usd || 0) - (a.vol24Usd || 0) || b.vol1hEth - a.vol1hEth)
    .slice(0, 200);
}

// route handlers: (url, body, req, client key)
const routes = {
  "GET /api/status": () => ({
    net: {
      id: CFG.network,
      name: CFG.name,
      chainId: CFG.chainId,
      native: CFG.native,
      usd: CFG.usdSymbol,
      paperClaim: CFG.paper.claim,
      ownStats: !CFG.dexscreener,
      token: CFG.styxToken,
      statsWindowH: M.statsWindowH(),
    },
    head: M.state.head,
    ready: M.state.ready,
    ethUsd: M.state.ethUsd,
    swaps: M.state.swaps,
    coins: M.tokens.size,
    pools: M.pools.size,
    rules: CFG.rules,
    pool: P.poolStats(),
  }),
  "GET /api/markets": (u) => markets(u.searchParams.get("q")),
  "GET /api/market": async (u, _, __, ip) => {
    const a = (u.searchParams.get("token") || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) throw new P.UserError("bad address");
    let t = M.tokens.get(a);
    if (!t?.primary) {
      R.spendApi(ip, 5); // an unknown coin costs a log scan on every pool manager
      t = await M.lookup(a).catch((e) => {
        throw e?.busy ? new R.RateLimited(e.message) : e; // the shared lookup queue is full: 429, not a 500
      });
    }
    if (!t || !t.primary) return { token: a, found: false };
    const v = M.view(t, true);
    return {
      found: true,
      ...v,
      room: { long: P.room(t, "long"), short: P.room(t, "short") },
      positions: P.positionsOn(t.addr).length,
    };
  },
  "GET /api/tick": (u) => {
    const out = {};
    for (const a of (u.searchParams.get("tokens") || "").toLowerCase().split(",").slice(0, 50)) {
      const t = M.tokens.get(a);
      if (t?.primary) out[a] = [M.spot(t), M.twap(t)];
    }
    return { t: Date.now(), ethUsd: M.state.ethUsd, prices: out };
  },
  "GET /api/showcase": () => SC.showcase(),
  "GET /api/feed": () => P.trades(),
  "GET /api/pool": () => P.poolStats(),
  "GET /api/wins": () => P.wins(),
  "GET /api/me": (u) => P.me(u.searchParams.get("id")),
  "POST /api/claim": (_, b) => P.claim(b.id),
  "POST /api/hello": (_, b) => P.account(b.id, b.ref),
  "POST /api/open": (_, b) => P.open(b),
  "POST /api/close": (_, b) => P.close(b.id, b.position),

  // ── Real mode (STYX_POOL + keeper key) ──
  "GET /api/real": () => ({
    enabled: KP.K.enabled,
    observer: KP.K.observer,
    pool: KP.K.pool,
    adapter: KP.K.adapter,
    keeper: KP.K.address,
    ...KP.guards(),
    chainId: CFG.chainId,
    chainHead: KP.K.chainHead,
    engineHead: M.state.head,
    params: KP.K.params,
    sent: KP.K.sent,
    failed: KP.K.failed,
    log: KP.K.log.slice(0, 50),
  }),
  "POST /api/real/market": async (_, b, __, ip) => {
    const a = String(b.token || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) throw new P.UserError("bad address");
    R.spendApi(ip, 5); // listing checks read the chain (and may scan logs) before any rate limit of the keeper's
    try {
      const r = await KP.ensureMarket(a);
      R.forgetMarket(a);
      return r;
    } catch (e) {
      // never hand RPC URLs (they can carry a provider key) or raw client errors to a visitor
      const msg = String(e.message || "listing failed").replace(/https?:\/\/\S+/g, "[rpc]").split("\n")[0].slice(0, 200);
      throw new P.UserError(msg);
    }
  },
  "GET /api/real/positions": (u) => KP.positionsOf(addr(u, "trader")),

  // the site's Real mode (engine/real.mjs): reads only, the browser signs
  "GET /api/real/config": () => R.config(),
  "GET /api/real/abi": () => R.abi(),
  "GET /api/real/pool": (_, __, ___, ip) => R.pool(ip),
  "GET /api/real/account": (u, _, __, ip) => R.account(addr(u, "trader"), ip),
  "GET /api/real/market": (u, _, __, ip) => R.market(addr(u, "token"), ip),
  "GET /api/real/feed": () => R.feed(),
  "GET /api/real/wins": (_, __, ___, ip) => R.wins(ip),
  "POST /api/rpc": (_, b, __, ip) => R.relay(b, ip),
};

function addr(u, key) {
  const a = (u.searchParams.get(key) || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw new P.UserError("bad address");
  return a;
}

function fail(req, res, e) {
  if (e instanceof HttpError) {
    // a body we stopped reading: answer, discard (never buffer) what still arrives for a second so the client can
    // read the answer, then drop the connection instead of draining an endless upload
    json(res, e.status, { error: e.message });
    req.removeAllListeners("data");
    req.resume();
    setTimeout(() => req.destroy(), 1_000).unref();
  } else if (e instanceof P.UserError) json(res, 400, { error: e.message });
  else if (e instanceof R.RateLimited) json(res, 429, { error: e.message }, { "retry-after": "1" });
  else {
    console.error(e);
    json(res, 500, { error: "server error" });
  }
}

/** Static site, SPA fallback. Only files under SITE; anything else gets index.html. */
function serveStatic(res, u) {
  let rel;
  try {
    rel = decodeURIComponent(u.pathname);
  } catch {
    return json(res, 400, { error: "bad path" });
  }
  let f = path.normalize(path.join(SITE, rel));
  let st = null;
  if (f.startsWith(SITE + path.sep)) {
    try {
      st = fs.statSync(f);
    } catch {}
  }
  if (!st || !st.isFile()) f = path.join(SITE, "index.html");
  const s = fs.createReadStream(f);
  s.on("error", (e) => {
    console.error("[http] static", f, e.message);
    if (!res.headersSent) json(res, 404, { error: "not found" });
    else res.destroy();
  });
  s.once("open", () => {
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
    s.pipe(res);
  });
  res.once("close", () => s.destroy());
}

// diagnostics for a new proxy chain: STYX_LOG_IP=N logs how the first N requests resolve to a client key
let ipLogLeft = Math.max(0, Math.floor(Number(process.env.STYX_LOG_IP) || 0));

async function handle(req, res) {
  const ip = clientIp(req); // once per request: the relay and the API limits key on it
  if (ipLogLeft > 0) {
    ipLogLeft--;
    console.log(`[ip] ${req.method} ${req.url} peer=${req.socket?.remoteAddress} xff="${req.headers["x-forwarded-for"] || ""}" -> ${ip}`);
  }
  let u;
  try {
    u = new URL(req.url, "http://x");
  } catch {
    return json(res, 400, { error: "bad request" });
  }
  const fn = Object.hasOwn(routes, `${req.method} ${u.pathname}`) ? routes[`${req.method} ${u.pathname}`] : null;
  if (!fn) return serveStatic(res, u);
  try {
    const body = req.method === "POST" ? await readBody(req) : null;
    json(res, 200, await fn(u, body, req, ip));
  } catch (e) {
    fail(req, res, e);
  }
}

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error("[http]", e);
      try {
        if (!res.headersSent) json(res, 500, { error: "server error" });
        else res.destroy();
      } catch {}
    });
  })
  .listen(CFG.port, () => console.log(`engine + site on http://localhost:${CFG.port} · ${CFG.name}`));

M.start();
P.start();
SC.start();
KP.startKeeper().catch((e) => console.error("[keeper] failed to start:", e.message));
startLedger();
