// Styx client: Real only (wallet + the InversePool contract, see real.js). The Practice switch and the server's paper
// book left the site on 09.11; until the pool is live on the server the site shows markets and says when trading opens.
// Token names come from the chain, account names from other visitors: escape every server string that reaches HTML.
const $ = (s) => document.querySelector(s);
const app = $("#app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sym = (s) => esc(String(s ?? "?").slice(0, 16)) + (String(s ?? "").length > 16 ? "…" : "");
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

let ACCT = store.get("acct");
if (!ACCT) {
  ACCT = "p" + (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, "").slice(0, 20);
  store.set("acct", ACCT);
}
const REF = new URLSearchParams(location.search).get("ref");
// a wallet address as ?ref= is a Real-mode referrer: the first valid one seen wins, never the zero address
// (real.js also drops it when it is the trader's own)
const isRef = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || "") && !/^0x0{40}$/.test(a);
if (isRef(REF) && !isRef(store.get("styx.ref"))) store.set("styx.ref", REF.toLowerCase());

// The chain the engine runs on (Elysium), filled from /api/status before the first render.
let N = { id: "elysium", name: "Elysium", native: "HYPE", usd: "USDC", minStake: 0.03 };
/** "Elysium testnet" -> "Elysium" for headlines; the full name stays in the fine print. */
const chainShort = () => String(N.name).replace(/\s+testnet$/i, "");

// Real: the wallet and the contract. real.js loads at boot when the server reports a live pool; RM stays null until
// then (or when it fails to load), and every trading control says so instead of acting.
let RCFG = null; // /api/real/config
let RM = null; // real.js module, set only once it initialised
const real = () => !!RM;
const soon = () => `Trading opens once the Styx pool is live on ${N.name}.`;

const api = async (path, body) => {
  const r = await fetch("/api/" + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "error");
  return j;
};

function toast(msg, err, ms = 4200) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = err ? "err" : "";
  t.style.display = "block";
  clearTimeout(toast.h);
  toast.h = setTimeout(() => (t.style.display = "none"), ms);
}

// ---------- formatting ----------
const sig = (x, n = 4) => {
  if (x == null || !isFinite(x)) return "—";
  if (x === 0) return "0";
  const a = Math.abs(x);
  if (a >= 1000) return x.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (a >= 1) return x.toLocaleString("en-US", { maximumFractionDigits: n });
  const z = Math.floor(-Math.log10(a));
  if (z >= 4) return `${x < 0 ? "−" : ""}0.0<sub>${z}</sub>${(a * 10 ** (z + n - 1)).toFixed(0)}`;
  return x.toFixed(z + n);
};
// the same number for plain text (toasts): 0.0<sub>4</sub>19 -> 0.0₄19
const sigTxt = (x, n) => sig(x, n).replace(/<sub>(\d+)<\/sub>/, (_, d) => [...d].map((c) => "₀₁₂₃₄₅₆₇₈₉"[c]).join(""));
const eth = (x, d = 3) => (x == null ? "—" : `${Number(x).toFixed(d)}`);
const usd = (x) => {
  if (x == null) return "—";
  const a = Math.abs(x);
  if (a >= 1e9) return "$" + (x / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return "$" + (x / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (x / 1e3).toFixed(1) + "K";
  return "$" + x.toFixed(0);
};
// direction is carried by the arrow, not by colour: the page has only one ink
const mv = (x) => {
  if (x == null) return "—";
  const a = Math.abs(x);
  return `${x >= 0 ? "↑" : "↓"} ${a >= 1000 ? (a / 1000).toFixed(1) + "K" : a.toFixed(1)}%`;
};
const signed = (x, d = 4) => (x == null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`);
const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 60 ? `${s | 0}s` : s < 3600 ? `${(s / 60) | 0}m` : s < 86400 * 2 ? `${(s / 3600) | 0}h` : `${(s / 86400) | 0}d`;
};
// a time of day, with the weekday when it is not within the next 20 hours (LP exits wait 24 h)
const clock = (s) =>
  new Date(s * 1000).toLocaleString([], Math.abs(s - Date.now() / 1000) > 72_000 ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
// a chain timestamp (expiry, LP exits) on this computer's clock, which may run off the chain's
const chainClock = (s) => clock(s - (RM?.R?.skew || 0));
const chainNow = () => (RM ? RM.chainNow() : Date.now() / 1000);
const icon = (m) => (m.image ? `<img src="${esc(m.image)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ph'}))">` : `<span class="ph"></span>`);
const short = (a) => String(a ?? "").slice(0, 6) + "…" + String(a ?? "").slice(-4);
const txLink = (hash, label = "tx") => {
  const u = RM?.txUrl(hash);
  return u ? `<a class="txt" href="${esc(u)}" target="_blank" rel="noopener">${label}</a>` : hash ? `<span class="dim" title="${esc(hash)}">${esc(String(hash).slice(0, 10))}…</span>` : "";
};
/** innerHTML only when it changed: a rewrite drops a click in flight and loses focus and selection. */
const setHtml = (el, html) => {
  if (el && el._h !== html) (el._h = html), (el.innerHTML = html);
};

// Ticker width is data: how much native coin it takes to move the price 10%.
// Thin coins are squeezed, deep ones stretch out.
// The scale runs from the 2x floor to 60× the 10x floor (0.3 → 300 ETH on RH).
const depthWidth = (d10) => {
  const lo = Math.log(N.tiers ? N.tiers[2][0] : 0.3);
  const hi = Math.log(N.tiers ? N.tiers[0][0] * 60 : 300);
  const t = Math.min(1, Math.max(0, (Math.log(Math.max(d10 || 0, 0.01)) - lo) / (hi - lo)));
  return Math.round(52 + t * 98);
};

// ---------- account ----------
async function refreshMe() {
  if (real()) return RM.refresh();
  $("#bal").textContent = "";
  $("#claim").textContent = "Opens soon";
}

function paintAcct() {
  if (!real()) return;
  const R = RM.R;
  $("#claim").style.display = "";
  if (!R.address) {
    $("#bal").textContent = "";
    $("#claim").textContent = "Connect wallet";
    return;
  }
  $("#bal").textContent = R.acct?.trader === R.address ? `${eth(R.acct.balance)} ${N.native}` : "…";
  $("#claim").textContent = short(R.address);
}

$("#claim").onclick = () => {
  if (!real()) return toast(soon(), true, 6000);
  if (!RM.R.address) return connectFlow();
  location.hash = "#/portfolio";
};

// ---------- Real: wallet, start-up, status changes ----------

function sheet(html) {
  const s = $("#sheet");
  s.innerHTML = `<div class="sheet-box" role="dialog" aria-modal="true">${html}</div>`;
  s.hidden = false;
  const done = () => ((s.hidden = true), (s.innerHTML = ""));
  s.onclick = (e) => e.target === s && done();
  return { el: s, done };
}

/** A choice in a sheet -> the picked value, or null for "Not now" (or a click outside). */
function choose(html, values) {
  return new Promise((resolve) => {
    const { el, done } = sheet(`${html}<button class="txt dim" data-x>Not now</button>`);
    const end = (v) => (done(), resolve(v));
    el.onclick = (e) => e.target === el && end(null);
    el.querySelectorAll("[data-i]").forEach((b) => (b.onclick = () => end(values[Number(b.dataset.i)])));
    el.querySelector("[data-x]").onclick = () => end(null);
  });
}

const pickWallet = (list) =>
  choose(
    `<p class="eyebrow">Connect a wallet</p>${list
      .map((w, i) => `<button class="w-pick" data-i="${i}">${w.info.icon ? `<img src="${esc(w.info.icon)}" alt="">` : ""}<span>${esc(w.info.name)}</span></button>`)
      .join("")}`,
    list,
  );

const ask = (title, text, answers) =>
  choose(
    `<p class="eyebrow">${esc(title)}</p><p class="q">${esc(text)}</p>${answers.map(([, label], i) => `<button class="w-pick" data-i="${i}"><span>${esc(label)}</span></button>`).join("")}`,
    answers.map(([v]) => v),
  );

let connecting = null; // one wallet prompt at a time: a second click waits for the first
function connectFlow() {
  return (connecting ||= connectOnce().finally(() => (connecting = null)));
}
async function connectOnce() {
  if (!RM) return;
  const list = RM.wallets();
  if (!list.length) return toast("No wallet found in this browser. Install Rabby or MetaMask, then reload the page.", true, 6000);
  const w = list.length === 1 ? list[0] : await pickWallet(list);
  if (!w) return;
  try {
    toast(`Confirm in ${w.info.name}…`);
    await RM.connect(w);
    toast(`Connected ${short(RM.R.address)} on ${N.name}`);
    route();
  } catch (e) {
    toast(RM.explain(e), true);
  }
}

/** A Real flow failed. A transaction that was sent is followed to its end (true if it landed); else an error. */
async function realFail(e) {
  if (e?.sent) {
    toast(RM.explain(e), false, 30000);
    return (await e.follow).ok === true;
  }
  toast(RM.explain(e), true, 7000);
  return false;
}
// the end of a transaction whose flow stopped waiting for it
const txNote = (n) =>
  toast(
    n.ok
      ? `${n.what} is confirmed on chain.`
      : n.ok === false
        ? `${n.what} reverted on chain.`
        : `${n.what} still does not show on chain after 10 minutes (${String(n.hash).slice(0, 10)}…). Check your wallet before sending it again.`,
    n.ok !== true,
    9000,
  );

// toasts when the keeper acts on one of my positions
const seen = new Map(); // id -> status
let seenFor = null;
function noticeChanges(R) {
  if (seenFor !== R.address) {
    seen.clear();
    seenFor = R.address;
  }
  const a = R.acct;
  if (!a || a.trader !== R.address) return;
  for (const p of [...a.open, ...a.history]) {
    const was = seen.get(p.id);
    // the keeper's book runs ahead of the event ledger: a status counts as seen only with its reason or payout
    if (p.settling || (p.status === "closed" && !p.closed) || (p.status === "cancelled" && !p.rejected && !p.cancelled)) continue;
    if (was === "pending-close" && p.status === "open" && !p.closeRejected && !p.closeCancelled) continue;
    seen.set(p.id, p.status);
    if (!was || was === p.status) continue;
    const what = `${p.side} ${p.lev}x $${p.symbol}`;
    if (was === "pending-open" && p.status === "open") toast(`Filled: ${what} at ${sigTxt(p.entry, 5)} ${N.native}`, false, 6000);
    else if (was === "pending-open" && p.status === "cancelled")
      toast(p.rejected ? `Refused: ${p.rejected.why}. Stake and fee are back in your balance.` : `Order cancelled. Stake and fee are back in your balance.`, !!p.rejected, 7000);
    else if (p.status === "closed") toast(`Closed ${what} (${p.closed.reason}): ${signed(p.closed.pnl)} · ${eth(p.closed.payout, 4)} ${N.native} back`, false, 7000);
    else if (was === "pending-close" && p.status === "open") toast(p.closeRejected ? `Close refused: ${p.closeRejected.why}. Still open.` : "Close cancelled. Still open.", !!p.closeRejected, 6000);
  }
}

/** Loads the Real client once, when the server reports a live pool. Without one the site stays read-only. */
async function startReal() {
  if (RCFG?.enabled) {
    try {
      const mod = await import("/real.js");
      if (!(await mod.init())) throw new Error("the pool is not live on this server yet");
      RM = mod;
      RM.onChange((R) => {
        paintAcct();
        noticeChanges(R);
      });
      RM.onTx(txNote);
    } catch (e) {
      RM = null;
      toast("Trading failed to load: " + e.message, true, 7000);
    }
  }
  document.body.dataset.mode = "real";
  $("#foot-mode").textContent = real()
    ? `Real mode · ${N.name} · ${RCFG?.testnet ? "test " : ""}${N.native} in one contract`
    : `Real mode · opens once the pool is live on ${N.name}`;
  if (real()) paintAcct();
  refreshMe();
  tape();
}

// ---------- tape: longs ride above the horizon, shorts below ----------
async function tape() {
  if (!real()) {
    $("#lane-long").innerHTML = `<span>↑ longs appear here as they open and close</span>`;
    $("#lane-short").innerHTML = `<span>↓ shorts appear here as they open and close</span>`;
    return;
  }
  try {
    const f = (await api("real/feed")).slice(0, 40);
    const item = (x) =>
      `<span><b>$${sym(x.symbol)}</b> ${esc(x.lev)}x ${x.kind === "open" ? `in ${eth(x.stake)}` : `out ${signed(x.pnl, 3)}`}</span>`;
    const L = f.filter((x) => x.side === "long").map(item).join("");
    const S = f.filter((x) => x.side === "short").map(item).join("");
    $("#lane-long").innerHTML = L || `<span>↑ longs appear here as they open and close</span>`;
    $("#lane-short").innerHTML = S || `<span>↓ shorts appear here as they open and close</span>`;
  } catch {}
}

// ---------- views ----------
let timers = [];
let gen = 0; // bumps on every route (a mode switch routes too): work of a page already left must not paint
// fn(g) now and every `ms`, never two runs at once; fn returns early when g !== gen after an await
const every = (ms, fn) => {
  const g = gen;
  let running = false;
  const run = () => {
    if (running || g !== gen) return;
    running = true;
    Promise.resolve()
      .then(() => fn(g))
      .catch((e) => g === gen && console.warn(e))
      .finally(() => (running = false));
  };
  run();
  timers.push(setInterval(run, ms));
};
const onReal = (fn) => {
  if (!RM) return;
  const off = RM.onChange(fn);
  timers.push({ off });
};
const views = {};

// One Real flow per group at a time ("money", "sess", "lp"): the group's buttons (data-grp) stay disabled until it
// settles, a sent transaction included; painters draw them disabled while flows.has(group).
const flows = new Set();
async function flow(group, msg, fn) {
  if (flows.has(group)) return false;
  flows.add(group);
  const btns = () => app.querySelectorAll(`[data-grp="${group}"]`);
  btns().forEach((b) => (b.disabled = true));
  try {
    toast(msg, false, 30000);
    await fn();
    return true;
  } catch (e) {
    return await realFail(e);
  } finally {
    flows.delete(group);
    btns().forEach((b) => (b.disabled = false));
  }
}
const grpBtn = (group, attrs, label, cls = "txt") =>
  `<button class="${cls}" data-grp="${group}" ${attrs} ${flows.has(group) ? "disabled" : ""}>${label}</button>`;

/** "5", "5,5", "7.5 %" or "-5" -> 5.5 etc.; empty -> null; anything else is an error, never a silent "none". */
function pctOf(text, what) {
  const t = String(text ?? "").trim().replace(/\s*%$/, "").replace(",", ".");
  if (!t) return null;
  if (!/^[+\-−]?(\d+\.?\d*|\.\d+)$/.test(t)) throw new Error(`${what}: enter a percent move, like 25 or 7,5.`);
  const x = Math.abs(Number(t.replace("−", "-")));
  if (!(x > 0) || !isFinite(x)) throw new Error(`${what} must be above 0%.`);
  return x;
}
function exitsOf(tpText, slText, side) {
  const tp = pctOf(tpText, "Take profit");
  const sl = pctOf(slText, "Stop loss");
  if (side === "long" && sl >= 100) throw new Error("Stop loss on a long must be under 100%: the price cannot fall further.");
  if (side === "short" && tp >= 100) throw new Error("Take profit on a short must be under 100%: the price cannot fall further.");
  return { tp, sl };
}

views.markets = async () => {
  const g0 = gen;
  let filter = "open";
  let q = "";
  app.innerHTML = `
    <section class="hero" aria-labelledby="hero-t">
      <svg class="hero-chart" viewBox="0 0 1500 1000" preserveAspectRatio="none" aria-hidden="true">
        <polyline points="0,470 90,440 160,452 240,392 320,410 400,350 470,372 560,300 640,318 720,250 800,268 880,205 960,222 1040,160 1130,180 1220,118 1310,132 1400,80 1500,40" />
        <polyline points="0,530 90,560 160,548 240,608 320,590 400,650 470,628 560,700 640,682 720,750 800,732 880,795 960,778 1040,840 1130,820 1220,882 1310,868 1400,920 1500,960" />
      </svg>
      <span class="eyebrow h-tl">↑ long any memecoin</span>
      <span class="eyebrow h-tr">perps for memes · on ${chainShort()}</span>
      <h1 class="styx" id="hero-t" aria-label="Styx">STYX</h1>
      <span class="eyebrow h-bl">↓ short any memecoin</span>
      <span class="eyebrow h-br">2x · 5x · 10x · against the pool</span>
    </section>
    <section class="pitch">
      ${caHtml()}
      <p class="pitch-lead">Above the line you win when the price goes up. Below it you win when it goes down. The line is the pool: it takes the other side of every trade and pays winners straight away.</p>
      <ul class="pitch-points mono">
        <li><b>Worst case = your stake.</b> No margin calls, no liquidation engine, no debt. Wins up to +200%.</li>
        <li><b>Any ${chainShort()} memecoin.</b> Launchpad coins list by public rules: pool age, cap, volume, depth.</li>
        <li><b>${N.native} in, ${N.native} out.</b> Gas, stake and payout are the same coin. Nothing to wrap.</li>
        <li><b>Fair fills.</b> Your price comes from a block after your order, the worse of spot and its 30-s average.</li>
      </ul>
      <div class="balance">
        <div class="bw" id="w-long">long<span class="arrow">↑</span></div>
        <div class="bw" id="w-short">short<span class="arrow">↓</span></div>
        <p class="mono dim" id="balance-note"></p>
      </div>
    </section>
    <section class="ledger" id="ledger"></section>
    <div class="controls">
      <input id="q" placeholder="Paste a contract address or type a ticker" autocomplete="off" spellcheck="false" />
      <div class="toggle"><button data-f="open" class="on">Tradable</button><button data-f="all">All coins</button></div>
    </div>
    <p class="legend mono dim">Ticker width shows depth: the wider the name, the more ${N.native} it takes to move the price 10%.</p>
    <div class="mkt-head mono dim"><span>Coin</span><span>Price</span><span>5m</span><span class="x">24h</span><span class="x">Cap</span><span class="x">Moves 10% on</span><span>Max</span><span></span></div>
    <div id="rows"><p class="empty">Reading the chain…</p></div>`;

  $("#q").oninput = (e) => {
    q = e.target.value.trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(q)) location.hash = "#/c/" + q.toLowerCase();
    else load();
  };
  app.querySelectorAll("[data-f]").forEach(
    (b) =>
      (b.onclick = () => {
        filter = b.dataset.f;
        app.querySelectorAll("[data-f]").forEach((x) => x.classList.toggle("on", x === b));
        load();
      }),
  );

  let loads = 0;
  let show = []; // mainnet showcase (display only), refreshed by the engine once a minute
  async function load() {
    const n = ++loads;
    const [list, sc] = await Promise.all([api("markets" + (q ? "?q=" + encodeURIComponent(q) : "")), api("showcase").catch(() => show)]);
    if (g0 !== gen || n !== loads) return; // another page, or a newer search
    show = sc;
    // Real money trades under the launch policy's cap too
    const cap = RCFG?.policy?.maxLev && real() ? RCFG.policy.maxLev : Infinity;
    const shown = filter === "open" ? list.filter((m) => m.ok) : list;
    const ql = q.toLowerCase();
    const sc2 = show.filter((s) => !ql || s.symbol.toLowerCase().includes(ql) || s.name.toLowerCase().includes(ql));
    // mainnet coins first, at full width (they are the deepest on the chain), marked and not tradable here
    const scRows = sc2
      .map(
        (s) => `<div class="mkt soon" data-sc="${esc(s.symbol)}" role="button" tabindex="0" title="Trades on ${esc(chainShort())} mainnet. Styx lists it with the mainnet pool.">
        <div class="coin">${icon(s)}<div class="names"><b class="tk" style="font-stretch:${s.symbol.length > 7 ? 70 : 120}%">$${sym(s.symbol)}</b><span class="tag">mainnet</span><small>${esc(s.name.slice(0, 32))}</small></div></div>
        <span class="r p mono">$${sig(s.priceUsd)}</span>
        <span class="r m mono">${mv(s.chg5m)}</span>
        <span class="r x mono">${mv(s.chg24h)}</span>
        <span class="r x mono">${usd(s.mcapUsd)}</span>
        <span class="r x mono">${usd(s.liqUsd)} liq.</span>
        <span class="r m mono closed">soon</span>
        <div class="sides"><span class="mono dim">mainnet · soon</span></div>
      </div>`,
      )
      .join("");
    $("#rows").innerHTML =
      scRows +
      (shown
        .map(
          (m) => `<div class="mkt" data-t="${esc(m.token)}" role="link" tabindex="0">
        <div class="coin">${icon(m)}<div class="names"><b class="tk" style="font-stretch:${depthWidth(m.d10)}%">$${sym(m.symbol)}</b><small>${esc(String(m.name).slice(0, 32))}</small></div></div>
        <span class="r p mono">$${sig(m.priceUsd)}</span>
        <span class="r m mono">${mv(m.chg5m)}</span>
        <span class="r x mono">${mv(m.chg24h)}</span>
        <span class="r x mono">${usd(m.mcapUsd)}</span>
        <span class="r x mono">${eth(m.d10, 2)} ${N.native}</span>
        <span class="r m mono ${m.ok ? "signal" : "closed"}" title="${esc((m.reasons || []).join(", "))}">${m.ok ? esc(Math.min(m.maxLev, cap)) + "x" : "shut"}</span>
        <div class="sides"><button data-side="long" ${m.ok ? "" : "disabled"}>Long ↑</button><button data-side="short" ${m.ok ? "" : "disabled"}>Short ↓</button></div>
      </div>`,
        )
        .join("") || (scRows ? "" : `<p class="empty">No coin matches. Paste its contract address to look it up on chain.</p>`));
    $("#rows")
      .querySelectorAll(".mkt.soon")
      .forEach((row) => {
        const say = () => toast(`$${row.dataset.sc} trades on ${chainShort()} mainnet. Styx lists it when the mainnet pool opens.`, false, 6000);
        row.onclick = say;
        row.onkeydown = (e) => e.key === "Enter" && say();
      });
    $("#rows")
      .querySelectorAll(".mkt:not(.soon)")
      .forEach((row) => {
        const go = (side) => (location.hash = "#/c/" + row.dataset.t + (side ? "?" + side : ""));
        row.onclick = (e) => go(e.target.closest("button")?.dataset.side);
        row.onkeydown = (e) => e.key === "Enter" && e.target === row && go();
      });
  }

  every(5000, async (g) => {
    const r = real();
    const [s] = await Promise.all([api("status"), load()]);
    // only the contract's numbers: a failed chain read, or no pool yet, shows as a dash
    const p = r ? await api("real/pool").catch(() => null) : null;
    if (g !== gen) return;
    const v = (fn) => (p ? fn(p) : "—");
    const tot = p ? p.longNotional + p.shortNotional : 0;
    const share = tot ? p.longNotional / tot : 0.5;
    // the words themselves are the long/short balance of open money
    $("#w-long").style.fontStretch = Math.round(55 + share * 95) + "%";
    $("#w-short").style.fontStretch = Math.round(55 + (1 - share) * 95) + "%";
    $("#balance-note").textContent = !r
      ? `Word width is open money. ${soon()}`
      : !p
        ? "Word width is open money. The chain could not be read just now."
        : tot
          ? `Word width is open money: ${Math.round(share * 100)}% long, ${Math.round((1 - share) * 100)}% short.`
          : "Word width is open money. Nothing open yet, so both are even.";
    $("#ledger").innerHTML = `
      <div><span class="eyebrow">Pool${r ? " · on chain" : " · opens soon"}</span><b>${v((p) => `${eth(p.cash, 2)} ${N.native}`)}</b></div>
      <div><span class="eyebrow">Volume 24h</span><b>${v((p) => `${eth(p.volume24, 2)} ${N.native}`)}</b></div>
      <div><span class="eyebrow">Trades 24h</span><b>${v((p) => esc(p.trades24))}</b></div>
      <div><span class="eyebrow">Paid to winners 24h</span><b>${v((p) => signed(p.paidToWinners24, 3))}</b></div>
      <div><span class="eyebrow">Best win 24h</span><b>${v((p) => (p.best24 ? `${signed(p.best24.pnl, 3)} $${sym(p.best24.symbol)}` : "—"))}</b></div>
      <div><span class="eyebrow">Fees</span><b>1% in · 1% out</b></div>
      <div><span class="eyebrow">Read from chain</span><b>${esc(s.coins)} coins</b></div>`;
  });
};

views.coin = async (addr, sideHint) => {
  const g0 = gen;
  let m = null;
  let rm = null; // Real: the on-chain market (listed?, fed?, room, prices of its bound pool)
  let lev = 2;
  let going = false; // an order is in flight: Long and Short stay disabled until it settles
  app.innerHTML = `<p class="empty mono">Looking up ${esc(addr)} on ${esc(N.name)}…</p>`;
  try {
    m = await api("market?token=" + encodeURIComponent(addr));
  } catch (e) {
    if (g0 === gen) app.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    return;
  }
  if (g0 !== gen) return; // the trader went to another page meanwhile
  if (!m.found) {
    app.innerHTML = `<h1 class="page-t">No pool.</h1><p class="lead">${esc(addr)} has no ${N.native} or ${N.usd} pool on ${N.name} that the engine can read. Coins still on a bonding curve open here once they graduate.</p><p><a class="txt" href="#/">Back to markets</a></p>`;
    return;
  }
  const policy = (real() && RCFG.policy) || {};
  const levCap = () => (policy.maxLev ? Math.min(m.maxLev || 0, policy.maxLev) : m.maxLev || 0);
  // the selected leverage never sits above the coin's cap (it moves with depth)
  const clampLev = () => {
    const cap = levCap();
    if (lev > cap) lev = [10, 5, 2].find((l) => l <= cap) || 2;
  };
  lev = Math.min(levCap() || 2, 5);
  clampLev();
  if (real()) rm = await RM.marketFor(m.token, false).catch(() => null);
  if (g0 !== gen) return;
  const samples = m.samples || [];
  const minStake = real() ? RCFG.params.minStake : N.minStake;
  const stake0 = real() ? Math.min(0.5, policy.newAccountStake || 0.5) : +(N.minStake * 50).toPrecision(2);

  app.innerHTML = `
    <div class="c-head">
      <div>
        <h1 class="c-tk" style="font-stretch:${depthWidth(m.d10)}%">$${sym(m.symbol)}</h1>
        <p class="c-name">${esc(String(m.name).slice(0, 48))} <span class="mono dim">· ${esc(short(m.token))} · ${esc(m.dex || "")} ${esc(m.poolKind)} · ${esc(m.quote)} pool</span></p>
      </div>
      <div class="c-px"><div class="big" id="px">—</div><div class="mono dim" id="pxe"></div></div>
    </div>
    <div class="chart"><canvas id="ch" aria-label="Price, last 15 minutes"></canvas></div>
    <p class="mono dim">Solid: live price. Dotted: 30-second average. You always fill at whichever is worse for you.</p>
    <p class="facts" id="facts"></p>
    <p class="why mono" id="why"></p>
    <p class="mono rnote" id="rnote"></p>
    <h2 class="section-t">Your positions</h2>
    <div id="mine"></div>`;

  // the ticket lives outside the scroll, pinned to the horizon
  const tk = document.createElement("div");
  tk.className = "ticket";
  tk.innerHTML = `
    <div class="t-long"><button class="go" data-go="long"><span class="lbl">Long<i>↑</i></span><small class="mono" id="cap-long"></small></button></div>
    <div class="t-lev"><span class="mono dim">Leverage</span><div class="levs">${[2, 5, 10].map((l) => `<button data-l="${l}">${l}x</button>`).join("")}</div></div>
    <label class="t-stake"><input id="stake" type="text" inputmode="decimal" autocomplete="off" value="${esc(stake0)}" aria-label="Stake in ${N.native}" /><span class="mono">${N.native}</span></label>
    <div class="t-exit"><input id="tp" type="text" inputmode="decimal" autocomplete="off" placeholder="Take profit, %" aria-label="Take profit, percent price move" /><input id="sl" type="text" inputmode="decimal" autocomplete="off" placeholder="Stop loss, %" aria-label="Stop loss, percent price move" /></div>
    <div class="t-short"><button class="go" data-go="short"><small class="mono" id="cap-short"></small><span class="lbl">Short<i>↓</i></span></button></div>`;
  $("#ui").appendChild(tk);
  timers.push({ off: () => tk.remove() });

  // Real: why this coin cannot take real money from here right now, or null
  const realBlock = () => {
    if (!real()) return soon();
    if (!rm) return null;
    if (!rm.listed) {
      if (!rm.canList) return "Not tradable with real money here: this server cannot list coins.";
      if (m.quote !== N.native) return `Not tradable with real money: only ${N.native}-quoted pools list.`;
      return null;
    }
    if (rm.fed === false && !rm.canList) return "Not tradable right now: the coin's price feed is missing on chain.";
    if (rm.enabled === false) return "Closed for new trades on chain.";
    if (rm.lockedUntil > chainNow()) return `Locked after a rug until ${chainClock(rm.lockedUntil)}.`;
    return null;
  };
  const room = (side) => {
    const r = rm?.[side];
    if (!r || r.notional == null || r.maxWin == null || !rm.maxWinBps) return null; // the bound pool is not read yet
    let x = Math.min(r.notional / lev, r.maxWin / (rm.maxWinBps / 10_000));
    if (policy.maxStake) x = Math.min(x, policy.maxStake);
    return Math.max(0, x);
  };
  const roomTxt = (side) => {
    if (real() && !rm) return ""; // not read yet
    if (real() && !rm.listed) return " · lists on your first order";
    if (real() && rm.fed === false) return " · its price feed is set up on your first order";
    const r = room(side);
    return r == null ? " · room unknown" : ` · room ${eth(r)}`;
  };
  const paintTicket = () => {
    clampLev();
    const no = realBlock();
    tk.querySelectorAll("[data-l]").forEach((b) => {
      b.classList.toggle("on", Number(b.dataset.l) === lev);
      b.disabled = !m.ok || Number(b.dataset.l) > levCap();
    });
    tk.querySelectorAll("[data-go]").forEach((b) => (b.disabled = !m.ok || !!no || going));
    const lose = +(100 / lev).toFixed(1);
    const win = Math.min(200 / lev, 100).toFixed(0);
    const cl = $("#cap-long");
    const cs = $("#cap-short");
    if (!cl || !cs) return;
    cl.innerHTML = !m.ok ? "Closed for trading" : no ? esc(no) : `Stake gone at −${lose}% · max win at +${win}%<span class="room">${esc(roomTxt("long"))}</span>`;
    cs.innerHTML = !m.ok ? esc((m.reasons || []).join(" · ")) : no ? "" : `Stake gone at +${lose}% · max win at −${win}%<span class="room">${esc(roomTxt("short"))}</span>`;
  };
  tk.querySelectorAll("[data-l]").forEach((b) => (b.onclick = () => ((lev = Number(b.dataset.l)), paintTicket())));

  tk.querySelectorAll("[data-go]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (going) return;
        const side = b.dataset.go;
        const stakeTxt = $("#stake").value;
        let ex;
        try {
          ex = exitsOf($("#tp").value, $("#sl").value, side);
        } catch (e) {
          return toast(e.message, true, 6000);
        }
        clampLev();
        if (!real()) return toast(soon(), true, 6000);
        if (!RM.R.address) await connectFlow();
        if (g0 !== gen || !RM.R.address) return;
        if (realBlock()) return paintTicket();
        going = true;
        paintTicket();
        try {
          toast(RM.willUseWallet() ? "Confirm the order in your wallet…" : "Sending your order…", false, 30000);
          // TP/SL are percent moves from the price of the pool the coin is bound to (real.js reads it)
          const r = await RM.open({ token: m.token, isLong: side === "long", lev, stake: stakeTxt, tpPct: ex.tp, slPct: ex.sl, ref: { spot: m.priceEth, twap: m.twapEth } });
          seen.set(r.id, "pending-open");
          toast(`Order #${r.id} is on chain. The keeper fills it at a price from a later block…`, false, 8000);
          const fresh = await RM.marketFor(m.token, false).catch(() => null);
          if (fresh && g0 === gen) rm = fresh;
        } catch (e) {
          await realFail(e); // a sent order is followed to its end before the buttons come back
        } finally {
          going = false;
          if (g0 === gen) paintTicket();
        }
      }),
  );

  const draw = () => {
    const c = $("#ch");
    if (!c) return;
    const dpr = devicePixelRatio || 1;
    const W = c.clientWidth;
    const H = c.clientHeight;
    c.width = W * dpr;
    c.height = H * dpr;
    const g = c.getContext("2d");
    g.scale(dpr, dpr);
    g.font = "400 10.5px 'Martian Mono', monospace";
    g.fillStyle = "#8a8f96";
    if (samples.length < 2) {
      g.fillText("Collecting price samples…", 0, 16);
      return;
    }
    const tw = samples.map((s, i) => {
      const cut = s[0] - 30000;
      let sum = 0;
      let n = 0;
      for (let j = i; j >= 0 && samples[j][0] >= cut; j--) (sum += samples[j][1]), n++;
      return sum / n;
    });
    const vals = samples.map((s) => s[1]).concat(tw);
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (hi === lo) (hi *= 1.001), (lo *= 0.999);
    const t0 = samples[0][0];
    const t1 = samples[samples.length - 1][0];
    const X = (t) => ((t - t0) / Math.max(1, t1 - t0)) * (W - 64);
    const Y = (v) => H - 18 - ((v - lo) / (hi - lo)) * (H - 36);
    // hairline grid: top, bottom, last price
    g.strokeStyle = "rgba(242,244,247,0.18)";
    g.lineWidth = 1;
    [lo, hi].forEach((v) => {
      g.beginPath();
      g.moveTo(0, Math.round(Y(v)) + 0.5);
      g.lineTo(W, Math.round(Y(v)) + 0.5);
      g.stroke();
    });
    const path = (arr) => {
      g.beginPath();
      arr.forEach((v, i) => (i ? g.lineTo(X(samples[i][0]), Y(v)) : g.moveTo(X(samples[i][0]), Y(v))));
      g.stroke();
    };
    g.strokeStyle = "rgba(242,244,247,0.55)";
    g.setLineDash([1, 3]);
    path(tw);
    g.setLineDash([]);
    g.strokeStyle = "#f2f4f7";
    g.lineWidth = 1.6;
    path(samples.map((s) => s[1]));
    const last = samples[samples.length - 1][1];
    g.fillStyle = "#c8bf1a";
    g.beginPath();
    g.arc(X(t1), Y(last), 3, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#8a8f96";
    g.fillText(`+${(((hi - lo) / lo) * 100).toFixed(2)}%`, W - 56, Y(hi) - 4);
    g.fillText(`${Math.max(1, Math.round((t1 - t0) / 60000))} min`, W - 56, Y(lo) + 14);
  };

  const paintInfo = () => {
    if (!$("#px")) return;
    $("#px").innerHTML = "$" + sig(m.priceUsd);
    $("#pxe").innerHTML = sig(m.priceEth) + " " + N.native;
    $("#facts").innerHTML = `${usd(m.mcapUsd)} market cap. ${eth(m.d10, 2)} ${N.native} moves the price 10%, so it trades ${
      m.ok ? `up to <span class="signal">${esc(levCap())}x</span>` : "at no leverage right now"
    }. ${m.txns24 != null ? esc(Number(m.txns24).toLocaleString("en-US")) + " trades" : "—"} and ${usd(m.vol24Usd)} volume in 24 hours; last swap ${m.lastSwap ? ago(m.lastSwap) + " ago" : "unknown"}.`;
    $("#why").textContent = m.ok ? "" : "Closed: " + (m.reasons || []).join(" · ");
  };

  // Real: who signs, the guarded-launch limits, whether the coin is listed
  const paintReal = () => {
    const el = $("#rnote");
    if (!el) return;
    if (!real()) return setHtml(el, "");
    const R = RM.R;
    const st = RM.sessionState();
    const a = R.acct?.trader === R.address ? R.acct : null;
    const lim = [policy.maxStake && `≤ ${policy.maxStake} ${N.native} a trade`, policy.maxLev && `≤ ${policy.maxLev}x`, policy.newAccountStake && `≤ ${policy.newAccountStake} ${N.native} in an account's first day`]
      .filter(Boolean)
      .join(", ");
    const who = !R.address
      ? `<button class="txt" data-connect>Connect a wallet</button> to trade with real ${N.native}.`
      : st === "on"
        ? `One-click trading is on: orders sign in this browser.`
        : st === "elsewhere"
          ? `One-click trading is on in another browser, so orders here ask your wallet. <a class="txt" href="#/portfolio">Manage it</a>.`
          : `Every order asks your wallet. <a class="txt" href="#/portfolio">Turn on one-click trading</a> to skip the prompts.`;
    const bal = a ? ` Free balance ${eth(a.balance, 4)} ${N.native}${a.balance < minStake ? ` · <a class="txt" href="#/portfolio">deposit</a>` : ""}.` : "";
    const no = realBlock();
    const html = `Real money${RCFG.testnet ? " (testnet)" : ""}. ${who}${bal}${no ? ` ${esc(no)}` : ""}${lim ? ` <span class="dim">Guarded launch: ${esc(lim)}. Min stake ${esc(minStake)} ${N.native}.</span>` : ""}`;
    if (el._h === html) return;
    setHtml(el, html);
    el.querySelector("[data-connect]")?.addEventListener("click", connectFlow);
  };

  const paintMine = () => {
    const mine = real() && RM.R.acct?.trader === RM.R.address ? RM.R.acct.open : [];
    paintRows(
      $("#mine"),
      mine.filter((x) => x.token === m.token),
      `<p class="empty">Nothing open on $${sym(m.symbol)}. Pick a side on the ticket.</p>`,
    );
  };

  paintInfo();
  paintTicket();
  paintReal();
  draw();
  addEventListener("resize", draw);
  timers.push({ off: () => removeEventListener("resize", draw) });
  if (sideHint) tk.querySelector(`[data-go="${sideHint === "short" ? "short" : "long"}"]`)?.focus({ preventScroll: true });
  onReal(() => (paintReal(), paintMine()));
  if (real()) every(1500, () => RM.R.address && RM.refresh()); // fills and closes show up within a couple of seconds

  every(1000, async (g) => {
    const t = await api("tick?tokens=" + m.token);
    if (g !== gen) return;
    const p = t.prices[m.token];
    if (p && p[0]) {
      m.priceEth = p[0];
      m.twapEth = p[1];
      m.priceUsd = p[0] * t.ethUsd;
      samples.push([t.t, p[0]]);
      while (samples.length > 900) samples.shift();
    }
    paintInfo();
    draw();
    paintMine();
  });
  every(10000, async (g) => {
    const fresh = await api("market?token=" + m.token);
    if (g !== gen) return;
    Object.assign(m, { ...fresh, samples: undefined });
    if (real()) {
      const r = await RM.marketFor(m.token, false).catch(() => null);
      if (g !== gen) return;
      if (r) rm = r;
    }
    paintTicket();
    paintReal();
  });
};

// ---------- position rows ----------
// Practice rows ({openedAt}) and Real rows ({status, canCloseAt, canCancelAt, settling}) in one table. A row's
// buttons are rebuilt only when what they do changes; figures and countdowns update in place, so a click never
// lands on a button that a repaint has just replaced.
const pending = new Map(); // position id -> { st, until }: Close/Cancel clicked at status st, disabled until it moves
const HOLD_MS = 15_000; // after the tx lands: a close refused between two reads moves the book and back unseen
const CELL = ["", "", "x", "x", "x", "r", "r"];

function rowParts(p) {
  const id = String(p.id);
  const st = p.status ?? "";
  const pe = pending.get(id);
  if (pe && (pe.st !== st || Date.now() > pe.until)) pending.delete(id); // the book moved: the click did its job
  const held = pending.has(id);
  const now = p.status == null ? Date.now() / 1000 : chainNow(); // Real times are the chain's
  const btn = (attr, label) => `<button ${attr}="${esc(id)}" data-st="${esc(st)}" ${held ? "disabled" : ""}>${label}</button>`;
  let kind;
  let act;
  if (p.settling) (kind = "settling"), (act = `<span class="dim pulse">settling…</span>`);
  else if (p.status == null) {
    const left = 10 - (Date.now() - p.openedAt) / 1000;
    if (left > 0 && !held) (kind = "wait"), (act = `<button disabled>${Math.ceil(left)}s</button>`);
    else (kind = "close" + held), (act = btn("data-close", "Close"));
  } else if (p.status === "pending-open" || p.status === "pending-close") {
    const word = p.status === "pending-open" ? "filling…" : "closing…";
    if (p.canCancelAt && now >= p.canCancelAt) (kind = "cancel" + held), (act = `<span class="dim">${word}</span> ${btn("data-cancel", "Cancel")}`);
    else (kind = "pend"), (act = `<span class="dim pulse">${word}</span>`);
  } else if (p.status === "open") {
    if (p.canCloseAt && now < p.canCloseAt && !held) (kind = "wait"), (act = `<button disabled>${Math.ceil(p.canCloseAt - now)}s</button>`);
    else (kind = "close" + held), (act = btn("data-close", "Close"));
  } else (kind = "x" + st), (act = `<span class="dim">${esc(st)}</span>`);
  const pc = p.pnl != null && p.stake ? ` (${p.pnl >= 0 ? "+" : "−"}${Math.abs((p.pnl / p.stake) * 100).toFixed(0)}%)` : "";
  const cells = [
    `<a href="#/c/${esc(p.token)}"><b class="tk" style="font-size:20px">$${sym(p.symbol)}</b></a>`,
    `${p.side === "long" ? "Long ↑" : "Short ↓"} ${esc(p.lev)}x`,
    `${eth(p.stake)} ${N.native}`,
    `in ${p.entry ? sig(p.entry) : "—"}`,
    `now ${p.mark ? sig(p.mark) : "—"}`,
    p.pnl != null ? signed(p.pnl) + pc : "—",
    act,
  ];
  return { id, kind, st, cells };
}

function paintRows(el, list, empty) {
  if (!el) return;
  const rows = list.map(rowParts);
  // the status too: "filling…" and "closing…" share a kind, and a button carries the status it was drawn at
  const sig = rows.length ? rows.map((r) => [r.id, r.kind, r.st, r.cells[0]].join(":")).join("|") : "empty";
  if (el._sig !== sig) {
    el._sig = sig;
    el.innerHTML = rows.length
      ? `<div class="rows">${rows.map((r) => `<div class="row mono" data-id="${esc(r.id)}">${r.cells.map((c, j) => (j ? `<span class="${CELL[j]}">${c}</span>` : c)).join("")}</div>`).join("")}</div>`
      : empty;
    el.querySelectorAll("[data-id]").forEach((row, i) => [...row.children].forEach((c, j) => (c._h = rows[i].cells[j])));
    el.querySelectorAll("[data-close],[data-cancel]").forEach((b) => (b.onclick = () => posAct(b)));
    return;
  }
  // the same rows with the same buttons: refresh the figures, and a countdown, in place
  const els = el.querySelectorAll("[data-id]");
  rows.forEach((r, i) =>
    r.cells.forEach((c, j) => {
      if (j === 0 || (j === 6 && r.kind !== "wait")) return;
      const cell = els[i]?.children[j];
      if (cell && cell._h !== c) (cell._h = c), (cell.innerHTML = c);
    }),
  );
}

async function posAct(b) {
  const id = b.dataset.close || b.dataset.cancel;
  const isClose = !!b.dataset.close;
  if (!id || pending.has(id)) return;
  const pe = { st: b.dataset.st || "", until: Infinity };
  pending.set(id, pe);
  const release = () => pending.get(id) === pe && pending.delete(id);
  b.disabled = true;
  if (!real()) return release(); // rows exist only with the pool live
  try {
    await (isClose ? RM.close(id) : RM.cancel(id));
    toast(isClose ? "Close sent. The keeper settles it at a price from a later block…" : "Cancel sent.", false, 6000);
    // the button stays disabled until the book shows the new status (rowParts lets go), at most HOLD_MS
    pe.until = Date.now() + HOLD_MS;
  } catch (e) {
    if (await realFail(e)) pe.until = Date.now() + HOLD_MS;
    else release(), (b.disabled = false);
  }
}

/** A page that needs the pool, shown before it is live on this server. */
const soonPage = (title, lead) =>
  (app.innerHTML = `<h1 class="page-t">${esc(title)}</h1><p class="lead">${esc(lead)}</p><p class="lead signal">${esc(soon())}</p><p><a class="txt" href="#/">Back to markets</a></p>`);

views.portfolio = async () =>
  real() ? portfolioReal() : soonPage("Portfolio", `Deposits, positions and withdrawals live in one ${N.native} contract on ${N.name}. You connect a wallet, deposit, trade and withdraw any time.`);

/** Real portfolio: money in and out, the one-click key, positions from the chain. */
async function portfolioReal() {
  const R = RM.R;
  if (!R.address) {
    app.innerHTML = `<h1 class="page-t">Portfolio</h1><p class="lead">Real mode trades real ${N.native}${RCFG.testnet ? " (testnet)" : ""} from one contract on ${N.name}. Connect a wallet to deposit, trade and withdraw.</p><p><button class="txt big-act" id="cw">Connect wallet</button></p>`;
    $("#cw").onclick = connectFlow;
    onReal(() => R.address && route());
    return;
  }
  // the page is drawn for this account: another one, or a locked wallet, draws it again
  const shown = R.address;
  onReal(() => R.address !== shown && route());
  app.innerHTML = `<h1 class="page-t">Portfolio</h1>
    <section class="ledger" id="ps"></section>
    <h2 class="section-t">Money</h2>
    <div class="money">
      <label class="amt"><input id="amt" type="text" inputmode="decimal" autocomplete="off" placeholder="0.0" aria-label="Amount in ${N.native}" /><span class="mono">${N.native}</span></label>
      ${grpBtn("money", 'id="dep"', "Deposit")}${grpBtn("money", 'id="wd"', "Withdraw")}<button class="txt dim" id="max">Max free</button>
    </div>
    <p class="mono dim">Deposits come from your wallet into your Styx balance. The free balance withdraws any time, without anyone's signature. Stakes of open positions stay locked until they close.</p>
    <h2 class="section-t">One-click trading</h2><div id="sess" class="sess mono"></div>
    <h2 class="section-t">Open</h2><div id="open"></div>
    <h2 class="section-t">History</h2><div id="hist"></div>
    <h2 class="section-t">Referral link</h2><p class="lead">You earn 10% of every fee paid by traders who arrive through your link. It binds on their first order signed in the wallet.<br /><span class="mono">${esc(location.origin)}/?ref=${esc(shown)}</span></p>
    <p class="mono dim">Connected ${esc(R.walletName || "wallet")} · ${esc(shown)} · <button class="txt" id="dc">Disconnect</button></p>`;

  const acct = () => (R.acct?.trader === shown ? R.acct : null);
  $("#dep").onclick = () => flow("money", "Confirm the deposit in your wallet…", async () => (await RM.deposit($("#amt").value), toast("Deposited.")));
  $("#wd").onclick = () => flow("money", "Confirm the withdrawal in your wallet…", async () => (await RM.withdraw($("#amt").value), toast("Withdrawn to your wallet.")));
  $("#max").onclick = () => acct() && ($("#amt").value = String(Math.floor(acct().balance * 1e6) / 1e6));
  // Disconnect leaves a live one-click key in this browser: say so, and offer to turn it off first
  $("#dc").onclick = async () => {
    const st = RM.sessionState();
    if (st === "on" || st === "low-gas") {
      const exp = acct()?.session?.expiry;
      const pick = await ask(
        "Disconnect",
        `One-click trading stays on in this browser until ${exp ? chainClock(exp) : "it expires"}: the key kept here can still trade your free balance. Turn it off first?`,
        [
          ["off", "Turn it off, then disconnect"],
          ["keep", "Disconnect, keep it on"],
        ],
      );
      if (!pick) return;
      if (pick === "off" && !(await flow("sess", "Confirm in your wallet; leftover gas comes back…", () => RM.sessionOff()))) return;
    }
    RM.disconnect();
    route();
  };

  const paintSession = (a) => {
    const st = RM.sessionState();
    const busy = RM.sessionBusy() || flows.has("sess");
    const gas = R.sessionBal != null ? `${RM.fmt(R.sessionBal, 4)} ${N.native}` : "—";
    const left = RM.leftoverGas();
    const old = RM.oldGas();
    const exp = a.session?.expiry;
    const until = exp ? chainClock(exp) : "—";
    const B = (s, label) => `<button class="txt" data-s="${s}" data-grp="sess" ${busy ? "disabled" : ""}>${label}</button>`;
    const rows = {
      off: `<p>Off. Every order asks your wallet.</p><p class="dim">Turning it on takes two wallet prompts: allow a key made in this browser for 24 hours, then send it ${esc(RCFG.sessionGas)} ${N.native} for gas. The key can open, close and cancel on your Styx balance. It can never withdraw or move your money.</p><p>${B("on", "Turn on")}</p>`,
      on: `<p>On until ${until}. Orders sign in this browser, no prompts. Gas left ${gas}.</p><p>${B("top", "Top up gas")} ${B("off", "Turn off")}</p>`,
      "low-gas": `<p>On, but the key is almost out of gas (${gas}). Orders go through your wallet until you top it up.</p><p>${B("top", `Top up ${esc(RCFG.sessionGas)} ${N.native}`)} ${B("off", "Turn off")}</p>`,
      expired: `<p>Expired at ${until}. Orders go through your wallet.</p><p>${B("on", "Turn on again")}</p>`,
      elsewhere: `<p>On in another browser until ${until}. Orders here go through your wallet.</p><p>${B("on", "Use this browser instead")} ${B("off", "Turn off")}</p>`,
    };
    $("#sess").innerHTML =
      rows[st] +
      (left ? `<p class="dim">This browser's old key still holds ${RM.fmt(left, 5)} ${N.native}. ${B("sweep", "Send it back")}</p>` : "") +
      (old > 0n ? `<p class="dim">Keys this browser made for an earlier Styx pool hold ${RM.fmt(old, 5)} ${N.native}. ${B("old", "Send it back")}</p>` : "");
    const back = (w) => toast(w > 0n ? `${RM.fmt(w, 5)} ${N.native} back in your wallet.` : "Too little gas was left to send back.");
    $("#sess")
      .querySelectorAll("[data-s]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            const s = b.dataset.s;
            if (s === "on") flow("sess", "Confirm two prompts: the key, then its gas…", async () => (await RM.sessionOn(), toast("One-click trading is on for 24 hours.")));
            if (s === "top") flow("sess", "Confirm the gas top-up in your wallet…", async () => (await RM.sessionTopUp(), toast("Gas topped up.")));
            if (s === "off") flow("sess", "Confirm in your wallet; leftover gas comes back…", async () => (await RM.sessionOff(), toast("One-click trading is off.")));
            if (s === "sweep") flow("sess", "Sending the gas back…", async () => back(await RM.sessionSweep()));
            if (s === "old") flow("sess", "Sending the gas back…", async () => back(await RM.sessionSweepOld()));
          }),
      );
  };

  let sessSig = "";
  const paint = () => {
    if (R.address !== shown) return; // the subscriber above draws the page again
    const a = acct();
    if (!a) {
      // the previous account's buttons must not stay live while this one loads
      if (sessSig !== "wait") (sessSig = "wait"), ($("#sess").innerHTML = `<p class="dim">Reading your account…</p>`);
      return;
    }
    const live = a.open.filter((p) => !p.settling);
    const upnl = live.reduce((s, p) => s + (p.pnl || 0), 0);
    const locked = live.reduce((s, p) => s + p.stake, 0);
    const realized = a.history.reduce((s, p) => s + (p.closed?.pnl || 0), 0);
    setHtml(
      $("#ps"),
      `
      <div><span class="eyebrow">Free in Styx</span><b>${eth(a.balance, 4)} ${N.native}</b></div>
      <div><span class="eyebrow">In open trades</span><b>${eth(locked, 4)}</b></div>
      <div><span class="eyebrow">Open P&amp;L</span><b>${signed(upnl)}</b></div>
      <div><span class="eyebrow">Realized, shown</span><b>${signed(realized)}</b></div>
      <div><span class="eyebrow">Wallet</span><b>${RM.fmt(R.walletBal, 4)} ${N.native}</b></div>
      ${a.lp.value ? `<div><span class="eyebrow">Pool share</span><b>${eth(a.lp.value, 4)}</b></div>` : ""}`,
    );
    // the session block holds buttons: repaint it only when its state changes
    const s = [RM.sessionState(), R.sessionBal, a.session?.key, a.session?.expiry, RM.leftoverGas(), RM.oldGas(), RM.sessionBusy() || flows.has("sess")].join("|");
    if (s !== sessSig) (sessSig = s), paintSession(a);
    paintRows($("#open"), a.open, `<p class="empty">No open positions. Pick a coin on <a class="txt" href="#/">Markets</a>.</p>`);
    setHtml(
      $("#hist"),
      a.history.length
        ? `<div class="rows">${a.history
            .map((p) => {
              const end =
                p.settling || (p.status === "closed" && !p.closed)
                  ? `<span class="x dim pulse" style="grid-column: span 2">settling…</span><span class="r dim"></span>`
                  : p.closed
                    ? `<span class="x dim">${esc(p.closed.reason)}${p.closed.at ? ` · ${ago(p.closed.at * 1000)} ago` : ""}</span><span class="x">${txLink(p.closed.tx)}</span><span class="r">${signed(p.closed.pnl)}</span>`
                    : `<span class="x dim" style="grid-column: span 2">${p.rejected ? "refused: " + esc(p.rejected.why) : "cancelled"}</span><span class="r dim">refunded</span>`;
              return `<div class="row mono"><a href="#/c/${esc(p.token)}"><b class="tk" style="font-size:20px">$${sym(p.symbol)}</b></a><span>${p.side === "long" ? "Long ↑" : "Short ↓"} ${esc(p.lev)}x</span><span class="x">${eth(p.stake)} ${N.native}</span>${end}<span></span></div>`;
            })
            .join("")}</div>`
        : `<p class="empty">Nothing closed yet.</p>`,
    );
  };
  onReal(paint);
  every(1500, () => RM.refresh());
  every(1000, paint); // countdowns, session expiry
}

views.pool = async () =>
  real()
    ? poolReal()
    : soonPage("The pool", `The pool is the line between long and short, held by one contract on ${N.name}. It takes the other side of every trade: it keeps losing stakes, pays winners and receives 75% of every fee. LPs own it by shares.`);

/** Real pool: the contract's own numbers, and LP shares for whoever may add. */
async function poolReal() {
  const R = RM.R;
  const P = RCFG.params;
  const hours = (s) => (s >= 3600 ? `${+(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`);
  app.innerHTML = `<h1 class="page-t">The pool</h1>
    <p class="lead">The pool is the line between long and short, held by one contract on ${N.name}. It keeps losing stakes, pays winners and receives 75% of every fee. LPs own it by shares; a withdrawal is asked for, then paid ${hours(P.removeDelay)} later at the pool's value of that moment, within ${hours(P.removeWindow)}.</p>
    <section class="ledger" id="pst"></section>
    <h2 class="section-t">Your share</h2><div id="lp"></div>`;
  let pool = null;
  // The share block is three parts: the held value (text), the form (rebuilt only when what it offers changes, so
  // what the LP types survives), and the withdrawal rows (rebuilt when a row's state changes; values in place).
  let lpFor = null; // the account the block is drawn for, "x" when no wallet is connected
  let formSig = "";
  let rmSig = "";
  const run = (msg, fn) => flow("lp", msg, async () => (await fn(), toast("Done.")));
  const paintLp = () => {
    const el = $("#lp");
    if (!el) return;
    if (!R.address) {
      if (lpFor !== "x") (lpFor = "x"), (el.innerHTML = `<p class="empty"><button class="txt" id="cw">Connect a wallet</button> to see or add a share.</p>`), ($("#cw").onclick = connectFlow);
      return;
    }
    const a = R.acct?.trader === R.address ? R.acct : null;
    if (!a) {
      // another account is loading: the previous one's buttons must not stay live
      if (lpFor && lpFor !== R.address) (lpFor = null), (el.innerHTML = `<p class="empty">Reading your share…</p>`);
      return;
    }
    if (lpFor !== a.trader) {
      lpFor = a.trader;
      formSig = rmSig = "";
      el.innerHTML = `<p class="lead" id="lpheld"></p><div id="lpform"></div><div id="lprm"></div>`;
    }
    const held = `You hold ${eth(a.lp.value, 4)} ${N.native} of the pool.`;
    if ($("#lpheld").textContent !== held) $("#lpheld").textContent = held;

    const canAdd = !pool?.lpGate || a.lp.allowed;
    const hasShares = BigInt(a.lp.shares || 0) > 0n;
    const fs = `${canAdd}|${hasShares}|${pool?.maxPoolCash ?? ""}`;
    if (fs !== formSig) {
      formSig = fs;
      const was = $("#lpamt");
      const typed = was?.value || "";
      const focused = !!was && document.activeElement === was;
      const input = `<label class="amt"><input id="lpamt" type="text" inputmode="decimal" autocomplete="off" placeholder="0.0" aria-label="Amount in ${N.native}" /><span class="mono">${N.native}</span></label>`;
      const asks = `${grpBtn("lp", 'id="rq"', "Ask to withdraw")}${grpBtn("lp", 'id="rqall"', "Ask for all", "txt dim")}`;
      $("#lpform").innerHTML = canAdd
        ? `<div class="money">${input}${grpBtn("lp", 'id="add"', "Add")}${asks}</div>
           <p class="mono dim">Adding mints shares at the pool's current value${pool?.maxPoolCash ? `; during the guarded launch the pool holds at most ${eth(pool.maxPoolCash, 0)} ${N.native}` : ""}.</p>`
        : `<p class="mono dim">During the guarded launch only allowlisted LPs add liquidity.</p>${hasShares ? `<div class="money">${input}${asks}</div>` : ""}`;
      const inp = $("#lpamt");
      if (inp) {
        inp.value = typed;
        if (focused) inp.focus();
      }
      $("#add") && ($("#add").onclick = () => run("Confirm in your wallet…", () => RM.addLiquidity($("#lpamt").value)));
      $("#rq") && ($("#rq").onclick = () => run("Confirm in your wallet…", () => RM.requestRemove($("#lpamt").value)));
      $("#rqall") && ($("#rqall").onclick = () => run("Confirm in your wallet…", () => RM.requestRemove("all")));
    }

    // once the keeper is silent long enough the contract pays a withdrawal at once, whatever its time
    const now = chainNow();
    const gone = !!pool?.keeperGone;
    const list = a.lp.removes.map((r) => ({
      r,
      st: gone ? "gone" : now > r.executableAt + P.removeWindow ? "expired" : now >= r.executableAt ? "ready" : "wait",
    }));
    const rs = list.map((x) => `${x.r.rid}:${x.st}`).join("|");
    const box = $("#lprm");
    if (rs !== rmSig) {
      rmSig = rs;
      box.innerHTML = list.length
        ? `<div class="rows">${list
            .map(({ r, st }) => {
              const state =
                st === "gone"
                  ? "the keeper is silent: paid at once"
                  : st === "expired"
                    ? "expired: cancel and ask again"
                    : st === "ready"
                      ? `ready until ${chainClock(r.executableAt + P.removeWindow)}`
                      : `ready at ${chainClock(r.executableAt)}`;
              const pay = st === "ready" || st === "gone" ? grpBtn("lp", `data-x="${esc(r.rid)}"`, "Withdraw", "") : "";
              return `<div class="row mono"><span>Withdrawal #${esc(r.rid)}</span><span data-v>${eth(r.value, 4)} ${N.native}</span><span class="x dim">${state}</span><span class="x"></span><span class="x"></span><span class="r">${pay}</span><span class="r">${grpBtn("lp", `data-c="${esc(r.rid)}"`, "Cancel", "")}</span></div>`;
            })
            .join("")}</div>`
        : "";
      box.querySelectorAll("[data-x]").forEach((b) => (b.onclick = () => run("Confirm in your wallet…", () => RM.executeRemove(b.dataset.x))));
      box.querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => run("Confirm in your wallet…", () => RM.cancelRemove(b.dataset.c))));
    } else {
      box.querySelectorAll("[data-v]").forEach((v, i) => {
        const t = `${eth(list[i]?.r.value, 4)} ${N.native}`;
        if (list[i] && v.textContent !== t) v.textContent = t;
      });
    }
  };
  every(5000, async (g) => {
    const p = await api("real/pool");
    if (g !== gen) return;
    pool = p;
    const seenS = pool.keeperSeenS ? Math.max(0, chainNow() - pool.keeperSeenS) : null;
    $("#pst").innerHTML = `
      <div><span class="eyebrow">Pool cash</span><b>${eth(pool.cash)} ${N.native}</b></div>
      <div><span class="eyebrow">Pool value (NAV)</span><b>${eth(pool.nav)} ${N.native}</b></div>
      <div><span class="eyebrow">Owed if every open trade hits +200%</span><b>${eth(pool.reservedMaxWin)} ${N.native}</b></div>
      <div><span class="eyebrow">Open long / short</span><b>${eth(pool.longNotional, 2)} / ${eth(pool.shortNotional, 2)}</b></div>
      <div><span class="eyebrow">Weekly prize pot</span><b>${eth(pool.weeklyPot, 4)}</b></div>
      <div><span class="eyebrow">New trades</span><b class="${pool.paused ? "signal" : ""}">${pool.paused ? "paused" : "open"}</b></div>
      <div><span class="eyebrow">Keeper last seen</span><b class="${pool.keeperGone ? "signal" : ""}">${seenS == null ? "—" : ago(Date.now() - seenS * 1000) + " ago"}${pool.keeperGone ? " · LP exits skip the wait" : ""}</b></div>`;
    paintLp();
  });
  onReal(paintLp);
  every(3000, () => RM.refresh());
}

views.wins = async () => {
  app.innerHTML = `<h1 class="page-t">Wins</h1><h2 class="section-t">Biggest today</h2><div id="top"></div><h2 class="section-t">This week</h2><p class="lead">The three most profitable traders of the week split the pot: 10% of every fee paid that week. The pot sits in the contract and is paid into winners' Styx balances.</p><div id="board"></div>`;
  every(5000, async (g) => {
    if (!real()) {
      $("#top").innerHTML = `<p class="empty">No wins yet. ${esc(soon())}</p>`;
      $("#board").innerHTML = "";
      return;
    }
    const w = await api("real/wins");
    if (g !== gen) return;
    const mine = RM.R.address;
    $("#top").innerHTML = w.top.length
      ? `<div class="rows board">${w.top
          .map((p, i) => `<div class="row mono"><span class="dim">${i + 1}</span><span><b class="tk" style="font-size:20px">$${sym(p.symbol)}</b> ${p.side === "long" ? "↑" : "↓"} ${esc(p.lev)}x <span class="dim">${esc(short(p.acct))}</span></span><span class="r">${signed(p.pnl)}</span></div>`)
          .join("")}</div>`
      : `<p class="empty">No wins yet today.</p>`;
    $("#board").innerHTML =
      `<p class="mono">Pot: ${eth(w.pot, 4)} ${N.native}</p>` +
      (w.board.length
        ? `<div class="rows board">${w.board.map((b, i) => `<div class="row mono"><span class="dim">${i + 1}</span><span>${esc(short(b.acct))}${b.acct === mine ? " · you" : ""}</span><span class="r">${signed(b.pnl)}</span></div>`).join("")}</div>`
        : `<p class="empty">Nobody has closed a trade this week.</p>`);
  });
};

views.how = async () => {
  const g0 = gen;
  const s = await api("status");
  if (g0 !== gen) return;
  const r = s.rules;
  app.innerHTML = `<div class="how">
    <h1 class="page-t">How Styx works</h1>
    <p class="lead">Styx is the river between two worlds: above the line you are long, below it you are short, and the line is the pool. Paste any ${chainShort()} contract address, pick a side and 2x, 5x or 10x. You trade against the pool and close whenever you want.</p>
    <dl>
      <dt>Prices</dt><dd>Read straight from ${chainShort()}: every swap on the chain's Uniswap v3 and v4 pools (launchpad hooks included), every block. A coin's price is its deepest ${N.native} or ${N.usd} pool; once a coin is listed for real money it is priced only from the pool it is bound to on chain.</dd>
      <dt>Fair fills</dt><dd>Every fill uses the worse, for you, of the live price and its ${r.twapS}-second average. A one-second pump moves the price, not the average.</dd>
      <dt>Order, then fill</dt><dd>${chainShort()} makes a block every ~0.1 s. You send an order; the keeper fills it at a price from a block after it, inside a window of about 2 seconds. Nobody, you included, knows the fill price when the order goes out, so racing the sequencer gives no edge.</dd>
      <dt>Price band</dt><dd>For real money the contract checks every keeper price against the coin's own pool on chain: at most 2% better for you, at most 5% worse (3% for stop-losses and caps). A forged price does not get through.</dd>
      <dt>Leverage</dt><dd>Set by depth: how much ${N.native} it takes to move the price 10%. 10x from ${r.tiers[0][0]} ${N.native}, 5x from ${r.tiers[1][0]} ${N.native}, 2x from ${r.tiers[2][0]} ${N.native}, closed below that. On Markets the width of each ticker shows this depth.</dd>
      <dt>Fees</dt><dd>1% of your stake to open, 1% of what comes back to close. No spread, no fee on profits. 75% goes to the pool, 10% to your referrer, 10% to the weekly prize, 5% to keeper gas.</dd>
      <dt>Wins and losses</dt><dd>Win up to +200% of your stake, lose at most the stake. A position closes on its own at either end, and you never owe anything.</dd>
      <dt>Real coins only</dt><dd>At least $${+(r.minMcapUsd / 1000).toFixed(1)}K market cap, a pool older than ${r.minPoolAgeH < 1 ? Math.round(r.minPoolAgeH * 60) + " minutes" : r.minPoolAgeH + " hours"}${r.minTxns24h ? `, ${r.minTxns24h}+ trades and $${+(r.minVol24hUsd / 1000).toFixed(1)}K+ volume in 24 hours` : ""}. Coins still on a bonding curve wait for graduation.</dd>
      <dt>Size</dt><dd>All open positions on one side of a coin together stay under ${r.notionalPctOfD10 * 50}–${r.notionalPctOfD10 * 100}% of its 10% depth (less where the pool's fee is low or unknown), so moving the price to win costs more than it pays. The pool never risks more than ${r.maxWinPerMarketPct * 100}% of itself on one coin.</dd>
      <dt>Hold time</dt><dd>Positions close after ${r.minHoldS} seconds.</dd>
      <dt>Rug guard</dt><dd>If a coin drops ${r.rugDrop * 100}% within ${r.rugWindowS} seconds, every short on it settles at once and wins, capped at +${r.rugShortCap * 100}%. The coin then locks for an hour.</dd>
      <dt>Your money</dt><dd>Deposits, positions and the pool all live in one ${N.native} contract on ${chainShort()}. Your free balance withdraws any time without anyone's signature. If the keeper goes quiet for a day (by the clock and by the chain's own blocks), anyone can close positions: at the coin's 15-minute average where the chain keeps one, else at the last checked price. After 7 days, pool shares withdraw without delay.</dd>
      <dt>One-click trading</dt><dd>Optional. Your wallet allows a key made in your browser to open, close and cancel on your Styx balance for up to 24 hours, and sends it a little ${N.native} for gas. The contract never lets that key withdraw or set keys, so the most a leaked key can do is trade your free balance until it expires or you turn it off.</dd>
      <dt>Launch limits</dt><dd>Real money starts guarded: stakes up to 5 ${N.native}, up to 5x, 1 ${N.native} per trade in an account's first day, one side per coin per trader, and no coin may cost the pool more than 2% of itself.</dd>
      <dt>Risks</dt><dd>Memecoins move fast. At 10x a 10% move against you takes the whole stake. A dev or a whale can still move a coin; the average, the depth caps and the breakers make that expensive, not impossible.</dd>
    </dl></div>`;
};

// ---------- router ----------
function route() {
  timers.forEach((t) => (t.off ? t.off() : clearInterval(t)));
  timers = [];
  gen++;
  const h = location.hash.slice(1) || "/";
  const [p, qs] = h.split("?");
  const parts = p.split("/").filter(Boolean);
  const page = parts[0] === "c" && parts[1] ? "coin" : views[parts[0]] ? parts[0] : "markets";
  document.body.dataset.page = page;
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#/" + (page === "markets" ? "" : page)));
  window.scrollTo(0, 0);
  if (page === "coin") return views.coin(parts[1].toLowerCase(), qs);
  return views[page]();
}

const guard = (fn) => async (...a) => {
  try {
    await fn(...a);
  } catch (e) {
    console.warn(e);
  }
};
Object.keys(views).forEach((k) => (views[k] = guard(views[k])));

/** The $STYX contract address with a copy button and a link to its market; empty until STYX_TOKEN is set. */
const caHtml = () =>
  N.token
    ? `<span class="ca mono">$STYX <button class="txt" data-copy="${esc(N.token)}" title="Copy the contract address">${esc(N.token)}</button> · <a class="txt" href="#/c/${esc(N.token)}">Trade $STYX</a></span>`
    : "";

async function boot() {
  try {
    const s = await api("status");
    N = { ...N, ...s.net, minStake: s.rules.minStake, tiers: s.rules.tiers };
  } catch {}
  try {
    RCFG = await api("real/config");
  } catch {
    RCFG = null;
  }
  document.title = `Styx · perps for memes on ${chainShort()}`;
  $("#foot").firstElementChild.textContent = `STYX · perps for memes on ${chainShort()}`;
  if (N.token) $("#foot").firstElementChild.insertAdjacentHTML("afterend", caHtml());
  // copy the $STYX address from anywhere it is shown
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-copy]");
    if (!b) return;
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      toast("Copied the $STYX contract address");
    } catch {
      toast("Copy failed: select the address and copy it by hand", true);
    }
  });
  addEventListener("hashchange", route);
  addEventListener("scroll", () => document.body.classList.toggle("scrolled", scrollY > 60), { passive: true });
  api("hello", { id: ACCT, ref: REF }).catch(() => {});
  await startReal();
  setInterval(() => (real() ? RM.R.address && !app.querySelector("#ps") && RM.refresh() : refreshMe()), 3000);
  setInterval(tape, 5000);
  route();
}
boot();
