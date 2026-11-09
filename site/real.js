// Real mode: the wallet, the one-click session key and every transaction. Nothing here trusts the server with
// money: amounts come from the inputs, every call is simulated against the chain first, the contract judges.
// The server only answers reads (/api/real/*) and relays JSON-RPC for the session key (/api/rpc).
// Every flow takes the trader (and the key) at its start and never reads R.address again after an await: the
// wallet may switch accounts or lock at any moment, and a flow must not finish on another account.
let V; // viem, bundled in /vendor/viem.js, loaded on first use

const RPC = location.origin + "/api/rpc";
const ZERO = "0x0000000000000000000000000000000000000000";
const DAY = 86_400;

export const R = {
  cfg: null,
  abi: null,
  chain: null,
  pub: null,
  provider: null, // EIP-1193
  walletName: null,
  address: null, // lowercase
  acct: null, // /api/real/account
  walletBal: null, // wei
  session: null, // { pk, account, expiry } kept in this browser
  sessionBal: null, // wei held by the session key for gas
  oldKeys: [], // { slot, pk, account, trader, bal }: keys this browser made for earlier pools on this chain
  skew: 0, // chain time minus the local clock, seconds
  error: null,
};

const subs = new Set();
export const onChange = (fn) => (subs.add(fn), () => subs.delete(fn));
// a subscriber that throws must not stop the others, nor reject the refresh that emitted
const emit = () =>
  subs.forEach((fn) => {
    try {
      fn(R);
    } catch (e) {
      console.warn(e);
    }
  });
// the end of a transaction that was still unconfirmed when its flow gave up waiting
const txSubs = new Set();
export const onTx = (fn) => (txSubs.add(fn), () => txSubs.delete(fn));

const get = async (p) => {
  const r = await fetch("/api/" + p);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "error");
  return j;
};
const post = async (p, b) => {
  const r = await fetch("/api/" + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "error");
  return j;
};
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
      v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
    } catch {}
  },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const switched = () => new Error("The wallet switched accounts, so nothing was sent.");
const notLoaded = () => new Error("Still reading your account. Try again in a second.");
/** R.acct when it belongs to `who` (it lags an account switch by one read). */
const acctOf = (who) => (who && R.acct?.trader === who ? R.acct : null);

// ───────────────────────────── boot ─────────────────────────────

const found = new Map(); // EIP-6963: rdns -> { info, provider }
addEventListener("eip6963:announceProvider", (e) => {
  const d = e.detail;
  if (d?.provider && d?.info) found.set(d.info.rdns || d.info.uuid, d);
});

let booting = null;
/** -> true when the server runs Real mode (a deployed pool). Safe to call twice; a failed start is retried. */
export function init() {
  if (R.cfg?.enabled) return Promise.resolve(true);
  return (booting ||= start().finally(() => (booting = null)));
}

async function start() {
  const cfg = await get("real/config");
  if (!cfg.enabled) return false;
  const [v, abi] = await Promise.all([import("/vendor/viem.js"), get("real/abi")]);
  V = v;
  const native = { name: cfg.native, symbol: cfg.native, decimals: 18 };
  const chain = V.defineChain({ id: cfg.chainId, name: cfg.chainName, nativeCurrency: native, rpcUrls: { default: { http: [RPC] } } });
  const pub = V.createPublicClient({ chain, transport: V.http(RPC, { retryCount: 1, timeout: 30_000 }), pollingInterval: 500, cacheTime: 0 });
  Object.assign(R, { abi, chain, pub, cfg }); // cfg last: R.cfg set means everything else is too
  dispatchEvent(new Event("eip6963:requestProvider"));
  readSkew();
  // come back connected without a prompt if this wallet already gave us the account
  const last = store.get("styx.wallet");
  if (last) {
    await sleep(120);
    const w = wallets().find((x) => (x.info.rdns || "injected") === last);
    if (w) {
      try {
        const [a] = await w.provider.request({ method: "eth_accounts" });
        attach(w, a); // a locked wallet gives no account: listen anyway, unlocking brings it back
      } catch {}
    }
  }
  return true;
}

export function wallets() {
  const list = [...found.values()];
  if (!list.length && window.ethereum) list.push({ info: { name: "Browser wallet", rdns: "injected", icon: null }, provider: window.ethereum });
  return list;
}

export async function connect(w) {
  const [a] = await w.provider.request({ method: "eth_requestAccounts" });
  if (!a) throw new Error("The wallet gave no account.");
  attach(w, a);
  await ensureChain(w.provider);
  store.set("styx.wallet", w.info.rdns || "injected");
  await refresh(true);
}

/** The Disconnect button: let the wallet go and ask it to forget the site. A one-click key stays as it is. */
export function disconnect() {
  const p = R.provider;
  detach?.();
  detach = null;
  try {
    p?.request?.({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] })?.catch?.(() => {});
  } catch {}
  store.set("styx.wallet", null);
  Object.assign(R, { provider: null, walletName: null });
  forgetAccount();
}

/** No account in hand (a locked wallet, or a disconnect): the page shows "Connect" until one comes back. */
function forgetAccount() {
  Object.assign(R, { address: null, acct: null, walletBal: null, session: null, sessionBal: null, oldKeys: [] });
  emit();
}

let detach = null;
function attach(w, a) {
  detach?.();
  R.provider = w.provider;
  R.walletName = w.info.name;
  const onAcc = (accs) => {
    if (R.provider !== w.provider) return; // a wallet we already let go
    if (!accs?.[0]) return forgetAccount(); // locked: keep the wallet and its permission
    if (accs[0].toLowerCase() !== R.address) setAddress(accs[0]);
    refresh();
  };
  const onChain = () => R.provider === w.provider && refresh();
  w.provider.on?.("accountsChanged", onAcc);
  w.provider.on?.("chainChanged", onChain);
  detach = () => {
    w.provider.removeListener?.("accountsChanged", onAcc);
    w.provider.removeListener?.("chainChanged", onChain);
  };
  if (a) setAddress(a);
  else emit();
}

function setAddress(a) {
  R.address = a.toLowerCase();
  Object.assign(R, { acct: null, walletBal: null, sessionBal: null, oldKeys: [] });
  R.session = loadSession();
  emit();
}

async function ensureChain(p = R.provider) {
  if (!p) throw new Error("Connect a wallet first.");
  const id = parseInt(await p.request({ method: "eth_chainId" }), 16);
  if (id === R.cfg.chainId) return;
  const hex = "0x" + R.cfg.chainId.toString(16);
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if (e?.code !== 4902 && !/unrecognized|not added|unknown chain/i.test(e?.message || "")) throw e;
    await p.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hex,
          chainName: R.cfg.chainName,
          nativeCurrency: { name: R.cfg.native, symbol: R.cfg.native, decimals: 18 },
          rpcUrls: [R.cfg.rpc],
          ...(R.cfg.explorer ? { blockExplorerUrls: [R.cfg.explorer] } : {}),
        },
      ],
    });
  }
}

// ───────────────────────────── chain time ─────────────────────────────
// Session expiry is judged by block.timestamp, not by this computer's clock. The head block's time is a lower
// bound on chain time (Nitro makes no blocks while idle), so the largest reading of the last 10 minutes wins.

let skewBest = null; // { v, at }
let skewAt = 0;
function noteSkew(ts, t0) {
  const v = Number(ts) - (t0 + Date.now()) / 2000;
  const now = Date.now();
  if (!skewBest || v >= skewBest.v || now - skewBest.at > 600_000) skewBest = { v, at: now };
  R.skew = skewBest.v;
}
async function readSkew() {
  skewAt = Date.now();
  try {
    const t0 = Date.now();
    noteSkew((await R.pub.getBlock()).timestamp, t0);
  } catch {}
}
/** Now, in chain seconds. */
export const chainNow = () => Date.now() / 1000 + R.skew;

// ───────────────────────────── reads ─────────────────────────────

let refreshing = null;
let balAt = 0; // native balances cost two RPC calls: every 5 s, or right after our own transaction
let balFor = "";
let oldAt = 0;
let oldFor = "";
/** Account, wallet and session-key balances. Coalesces concurrent calls; `force` after a transaction. */
export function refresh(force = false) {
  if (!R.address || !R.pub) return Promise.resolve();
  if (force && refreshing) return refreshing.then(() => refresh(true));
  refreshing ||= (async () => {
    try {
      const me = R.address;
      const sk = R.session;
      const key = me + (sk?.account.address || "");
      const bal = force || Date.now() - balAt > 5_000 || balFor !== key;
      if (force || Date.now() - skewAt > 30_000) readSkew();
      if (force || Date.now() - oldAt > 60_000 || oldFor !== me) readOldKeys(me);
      const [acct, wb, sb] = await Promise.all([
        get("real/account?trader=" + me),
        bal ? R.pub.getBalance({ address: me }).catch(() => null) : R.walletBal,
        !sk ? null : bal ? R.pub.getBalance({ address: sk.account.address }).catch(() => null) : R.sessionBal,
      ]);
      if (me !== R.address) return; // the wallet switched accounts meanwhile
      if (bal) (balAt = Date.now()), (balFor = key);
      Object.assign(R, { acct, walletBal: wb, error: null });
      if (R.session?.pk === sk?.pk) R.sessionBal = sb;
      else (R.sessionBal = null), (balAt = 0); // the key changed under us (another tab): read it next time
    } catch (e) {
      R.error = e.message;
    } finally {
      refreshing = null;
      emit();
    }
  })();
  return refreshing;
}

// ───────────────────────────── the session key ─────────────────────────────
// A key made in this browser that may open, close and cancel on the trader's Styx balance for at most 24 h. It can
// never withdraw or set keys (the contract refuses), so the worst a stolen one does is trade the free balance until
// it expires or the wallet turns it off. It pays its own gas from a small top-up.

const skPre = () => `styx.sk.${R.cfg.chainId}.`;
const skSlot = (who = R.address) => `${skPre()}${R.cfg.pool}.${who}`;
const keyAddr = (s) => s.account.address.toLowerCase();

function keyOf(raw) {
  try {
    const j = JSON.parse(raw || "null");
    if (!j?.pk) return null;
    return { pk: j.pk, expiry: j.expiry || 0, account: V.privateKeyToAccount(j.pk, { nonceManager: V.nonceManager }) };
  } catch {
    return null;
  }
}
const loadSession = (slot = skSlot()) => keyOf(store.get(slot));

// another tab turned the key on, off or swept it: follow it here, or two tabs overwrite each other's key
addEventListener("storage", (e) => {
  if (!R.cfg?.enabled || !R.address || !V) return;
  if (e.key !== null && !e.key.startsWith(skPre())) return;
  oldAt = 0;
  const s = loadSession();
  if (s?.pk !== R.session?.pk) (R.session = s), (R.sessionBal = null);
  refresh(true);
});

/** Keys this browser keeps for `me` under other pools of this chain (a redeploy leaves their gas behind). */
async function readOldKeys(me) {
  oldAt = Date.now();
  oldFor = me;
  const pre = skPre();
  const pool = String(R.cfg.pool).toLowerCase();
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const slot = localStorage.key(i);
      if (!slot?.startsWith(pre) || !slot.endsWith("." + me)) continue;
      if (slot.slice(pre.length, -(me.length + 1)).toLowerCase() === pool) continue;
      const s = keyOf(store.get(slot));
      if (s) keys.push({ ...s, slot, trader: me, bal: null });
    }
  } catch {}
  await Promise.all(keys.map(async (k) => (k.bal = await R.pub.getBalance({ address: k.account.address }).catch(() => null))));
  if (me !== R.address) return;
  R.oldKeys = keys;
  emit();
}

const gasWant = () => V.parseEther(String(R.cfg.sessionGas));

/** "off" | "on" | "low-gas" | "expired" | "elsewhere" (a live key this browser does not hold) */
function stateOf(s, on, sb) {
  if (!on || !on.key || on.key === ZERO) return "off";
  if (on.expiry <= chainNow() + 30) return "expired";
  if (!s || on.key !== keyAddr(s)) return "elsewhere";
  if (sb != null && sb < gasWant() / 10n) return "low-gas";
  return "on";
}
export const sessionState = () => stateOf(R.session, acctOf(R.address)?.session, R.sessionBal);

let sessBusy = false;
/** A session action (on, top-up, off, sweep) is in flight: the others wait, and orders go through the wallet. */
export const sessionBusy = () => sessBusy;
const exclusive =
  (fn) =>
  async (...a) => {
    if (sessBusy) throw new Error("Another one-click action is still running.");
    sessBusy = true;
    emit();
    try {
      return await fn(...a);
    } finally {
      sessBusy = false;
      emit();
    }
  };
/** May `key` sign for the trader of account `a` right now? */
const keyLive = (key, a) => !!key && !!a && !sessBusy && stateOf(key, a.session, R.session?.pk === key.pk ? R.sessionBal : null) === "on";

/** Gas sitting on a key of this browser that no longer trades: worth sending back. */
export const leftoverGas = () =>
  R.session && acctOf(R.address) && !["on", "low-gas"].includes(sessionState()) && R.sessionBal > 0n ? R.sessionBal : 0n;
/** Gas on this browser's keys of earlier pools. */
export const oldGas = () => R.oldKeys.filter((k) => k.trader === R.address).reduce((t, k) => t + (k.bal || 0n), 0n);

export const sessionOn = exclusive(async () => {
  const me = R.address;
  if (!me) throw new Error("Connect a wallet first.");
  const slot = skSlot(me);
  const t0 = Date.now();
  const blk = await R.pub.getBlock();
  noteSkew(blk.timestamp, t0);
  if (R.address !== me) throw switched();
  const expiry = Number(blk.timestamp) + DAY - 600; // chain time, inside the contract's 24 h limit
  // the key this browser already keeps for the account wins (another tab may have made it): it may hold gas, and
  // overwriting it would strand that gas
  let s = loadSession(slot) || R.session;
  if (!s) {
    const pk = V.generatePrivateKey();
    s = { pk, expiry, account: V.privateKeyToAccount(pk, { nonceManager: V.nonceManager }) };
  }
  s.expiry = expiry;
  store.set(slot, JSON.stringify({ pk: s.pk, expiry })); // saved before any prompt: a closed tab keeps its gas
  if (loadSession(slot)?.pk !== s.pk) throw new Error("This browser does not keep data for the site (private window or blocked storage), so one-click trading stays off.");
  R.session = s;
  await send("setSessionKey", [s.account.address, BigInt(expiry)], { from: me });
  const have = await R.pub.getBalance({ address: s.account.address });
  if (have < gasWant() / 2n) await sendValue(s.account.address, gasWant() - have, me);
  await refresh(true);
});

export const sessionTopUp = exclusive(async () => {
  const me = R.address;
  const s = R.session;
  if (!me || !s) throw new Error("One-click trading is off.");
  await sendValue(s.account.address, gasWant(), me);
  await refresh(true);
});

/** Turn the account's key off on chain (wallet), whichever browser holds it, then return this browser's gas. */
export const sessionOff = exclusive(async () => {
  const me = R.address;
  if (!me) throw new Error("Connect a wallet first.");
  const slot = skSlot(me);
  const s = R.session;
  const a = acctOf(me);
  if (!a) throw notLoaded();
  if (a.session?.key && a.session.key !== ZERO) await send("setSessionKey", [ZERO, 0n], { from: me });
  if (s) await sweep(s, me, slot, true);
  await refresh(true);
});

/** Send what is left on this browser's key back to the wallet; forget a key that no longer trades. -> wei sent */
export const sessionSweep = exclusive(async ({ forget } = {}) => {
  const me = R.address;
  const s = R.session;
  if (!me || !s) return 0n;
  const slot = skSlot(me);
  if (!acctOf(me)) throw notLoaded();
  forget ??= !["on", "low-gas"].includes(sessionState());
  const sent = await sweep(s, me, slot, forget);
  await refresh(true);
  return sent;
});

/** Send back the gas on this browser's keys of earlier pools, and forget those keys. -> wei sent */
export const sessionSweepOld = exclusive(async () => {
  const me = R.address;
  if (!me) throw new Error("Connect a wallet first.");
  const keys = R.oldKeys.filter((k) => k.trader === me && k.bal > 0n);
  let sent = 0n;
  for (const k of keys) sent += await sweep(k, me, k.slot, true);
  oldAt = 0;
  await refresh(true);
  return sent;
});

/** Send what `s` holds to `to`; with `forget`, drop it from `slot`, only if the slot still keeps this very key. */
async function sweep(s, to, slot, forget) {
  if (!to) throw new Error("Connect a wallet first.");
  const bal = await R.pub.getBalance({ address: s.account.address });
  let sent = 0n;
  if (bal > 0n) {
    const fees = await R.pub.estimateFeesPerGas();
    const gas = await R.pub.estimateGas({ account: s.account, to, value: 1n });
    const cost = (gas * fees.maxFeePerGas * 12n) / 10n;
    if (bal > cost) {
      const w = keyClient(s.account);
      const hash = await w.sendTransaction({ to, value: bal - cost, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
      await receipt(hash, "The gas transfer");
      sent = bal - cost;
    }
  }
  if (forget) {
    if (keyOf(store.get(slot))?.pk === s.pk) store.set(slot, null);
    if (R.session?.pk === s.pk) (R.session = null), (R.sessionBal = null);
  }
  return sent;
}

// ───────────────────────────── transactions ─────────────────────────────
// Once a hash exists, a transport error never makes it "failed": the receipt is polled until it shows up. Only a
// mined receipt that reverted is a failure.

// keccak-256 (Keccak padding), for the hash of a transaction the session key signed
const KRC = [
  0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an,
  0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n,
];
const KROT = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const KPI = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const M64 = (1n << 64n) - 1n;
const rotl = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64;
export function keccakHex(hex) {
  const h = String(hex).replace(/^0x/, "");
  const len = h.length / 2;
  const msg = new Uint8Array(len + 136 - (len % 136));
  for (let i = 0; i < len; i++) msg[i] = parseInt(h.substr(i * 2, 2), 16);
  msg[len] ^= 0x01;
  msg[msg.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < msg.length; off += 136) {
    for (let i = 0; i < 17; i++) {
      let v = 0n;
      for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(msg[off + i * 8 + b]);
      s[i] ^= v;
    }
    for (let r = 0; r < 24; r++) {
      const C = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
      for (let x = 0; x < 5; x++) {
        const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
        for (let y = 0; y < 25; y += 5) s[y + x] ^= D;
      }
      let cur = s[1];
      for (let t = 0; t < 24; t++) {
        const j = KPI[t];
        const tmp = s[j];
        s[j] = rotl(cur, KROT[t]);
        cur = tmp;
      }
      for (let y = 0; y < 25; y += 5) {
        const row = s.slice(y, y + 5);
        for (let x = 0; x < 5; x++) s[y + x] = row[x] ^ (~row[(x + 1) % 5] & M64 & row[(x + 2) % 5]);
      }
      s[0] ^= KRC[r];
    }
  }
  let out = "0x";
  for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) out += Number((s[i] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, "0");
  return out;
}

/** One JSON-RPC call through the relay. `transit` marks a failure after which the call may still have gone out. */
let rpcId = 0;
async function rpc(method, params) {
  let r;
  try {
    r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }), signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw Object.assign(new Error("The server did not answer."), { cause: e, transit: true });
  }
  const j = await r.json().catch(() => null);
  if (!j || r.status >= 500) throw Object.assign(new Error("The server did not answer."), { transit: true });
  if (!r.ok) throw new Error(String(j.error || "The server refused the request.")); // never forwarded
  if (j.error) throw Object.assign(new Error(j.error.message || "RPC error"), { code: j.error.code, data: j.error.data, transit: j.error.code === -32603 });
  return j.result;
}
/**
 * The session key's transport. Its raw transaction's hash is known before it leaves, so a send lost in transit
 * (the relay or the chain's RPC had a bad moment) returns that hash and is looked up: it is never sent twice.
 * A refusal (rate limit, a node rejection) still fails, since nothing went out.
 */
const keyTransport = () =>
  V.custom(
    {
      async request({ method, params }) {
        if (method !== "eth_sendRawTransaction") return rpc(method, params);
        try {
          return await rpc(method, params);
        } catch (e) {
          if (!e.transit) throw e;
          return keccakHex(params[0]);
        }
      },
    },
    { retryCount: 0 },
  );
const keyClient = (account) => V.createWalletClient({ account, chain: R.chain, transport: keyTransport() });

async function lookup(hash) {
  try {
    return await R.pub.getTransactionReceipt({ hash });
  } catch {
    return null; // not mined yet, or the relay had a bad moment
  }
}
async function mined(hash, ms, every) {
  const end = Date.now() + ms;
  for (;;) {
    const r = await lookup(hash);
    if (r || Date.now() > end) return r;
    await sleep(every);
  }
}
/** Keep looking a sent hash up in the background; tell onTx subscribers how it ended. */
function follow(hash, what) {
  return (async () => {
    const r = await mined(hash, 600_000, 2_000);
    const n = { hash, what, ok: r ? r.status === "success" : null };
    txSubs.forEach((fn) => {
      try {
        fn(n);
      } catch {}
    });
    refresh(true);
    return n;
  })();
}
async function receipt(hash, what = "The transaction") {
  const r = await mined(hash, 90_000, 500);
  if (!r) throw Object.assign(new Error("Sent, checking…"), { sent: hash, follow: follow(hash, what) });
  if (r.status !== "success") throw new Error("The transaction reverted on chain.");
  return r;
}

const WHAT = {
  requestOpen: "Your order",
  requestOpenFor: "Your order",
  requestClose: "Your close",
  cancelRequest: "Your cancel",
  deposit: "Your deposit",
  withdraw: "Your withdrawal",
  setSessionKey: "The one-click key",
  addLiquidity: "Your liquidity",
  requestRemove: "Your withdrawal request",
  executeRemove: "Your pool withdrawal",
  cancelRemove: "Your cancel",
};
const revertName = (e) => (typeof e?.walk === "function" ? e.walk((x) => x instanceof V.ContractFunctionRevertedError)?.data?.errorName : null);

/** Simulate, then sign with the session key `key` or with the wallet of `from`, then wait for the receipt. */
async function send(functionName, args, { value, key, from } = {}) {
  const call = { address: R.cfg.pool, abi: R.abi, functionName, args, ...(value ? { value } : {}) };
  const what = WHAT[functionName];
  if (key) {
    let request;
    try {
      ({ request } = await R.pub.simulateContract({ ...call, account: key.account }));
    } catch (e) {
      // expired or replaced a moment ago: nothing was sent, the caller may ask the wallet instead
      if (revertName(e) === "Unauthorized") e.keyRefused = true;
      throw e;
    }
    const w = keyClient(key.account);
    return receipt(await w.writeContract(request), what);
  }
  if (!from) throw new Error("Connect a wallet first.");
  if (R.address !== from) throw switched();
  const p = R.provider;
  await ensureChain(p);
  const { request } = await R.pub.simulateContract({ ...call, account: from });
  if (R.address !== from || R.provider !== p) throw switched();
  const w = V.createWalletClient({ account: from, chain: R.chain, transport: V.custom(p) });
  return receipt(await w.writeContract(request), what);
}

async function sendValue(to, value, from) {
  if (!from) throw new Error("Connect a wallet first.");
  if (R.address !== from) throw switched();
  const p = R.provider;
  await ensureChain(p);
  if (R.address !== from || R.provider !== p) throw switched();
  const w = V.createWalletClient({ account: from, chain: R.chain, transport: V.custom(p) });
  return receipt(await w.sendTransaction({ to, value }), "The gas top-up");
}

/** Float price (native per token) -> WAD. 15 significant digits, as the keeper does. */
function toWad(x) {
  if (!(x > 0) || !isFinite(x)) return 0n;
  const [m, e] = x.toExponential(14).split("e");
  const digits = BigInt(m.replace(".", ""));
  const exp = Number(e) - 14 + 18;
  return exp >= 0 ? digits * 10n ** BigInt(exp) : digits / 10n ** BigInt(-exp);
}

/** "1.5" -> wei, strictly from the text the trader typed. */
export function amount(text) {
  const t = String(text ?? "").trim().replace(",", ".");
  if (!/^\d*\.?\d+$/.test(t) && !/^\d+\.$/.test(t)) throw new Error("Enter an amount.");
  const w = V.parseEther(t.replace(/\.$/, ""));
  if (w === 0n) throw new Error("Enter an amount.");
  return w;
}

/** The on-chain market; with `list`, lists the coin (or repairs a missing price feed) through the keeper first. */
export async function marketFor(token, list = true) {
  let m = await get("real/market?token=" + token);
  if (list && (!m.listed || m.fed === false)) {
    if (!m.canList)
      throw new Error(
        m.listed
          ? "This coin's price feed is missing on chain and this server cannot set it up, so orders on it would be refused. Try later."
          : "This coin is not listed for real money yet, and this server cannot list it.",
      );
    await post("real/market", { token });
    m = await get("real/market?token=" + token);
    if (!m.listed || m.fed === false) throw new Error("The coin's listing is not complete on chain yet. Try again in a minute.");
  }
  return m;
}

function referrer(me) {
  const r = (store.get("styx.ref") || "").toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(r) && r !== ZERO && r !== me ? r : null;
}
/** A referrer still to bind: it binds only on an order the trader signs, so that order goes through the wallet. */
const refToBind = (me, a) => {
  const r = referrer(me);
  return r && (!a || a.referrer === ZERO) ? r : null;
};
/** Will the next order ask the wallet? */
export const willUseWallet = () => {
  const me = R.address;
  const a = acctOf(me);
  return !!refToBind(me, a) || !keyLive(R.session, a);
};

/**
 * -> { id, via } once the request is on chain; the keeper fills it at a price from a later block. Take-profit and
 * stop-loss come as percent moves from the price of the pool the coin is bound to (`ref` is the engine's price, only
 * for a server that sends no `spot` at all).
 */
export async function open({ token, isLong, lev, stake, tpPct, slPct, ref }) {
  const me = R.address;
  if (!me) throw new Error("Connect a wallet first.");
  const key = R.session;
  const wei = amount(stake);
  const m = await marketFor(token);
  if (R.address !== me) throw switched();
  // spot: null means the bound pool is not read yet (no price), never "use another pool's"; NaN refuses a TP/SL
  const px = m.spot > 0 ? [m.spot, m.twap > 0 ? m.twap : m.spot] : "spot" in m ? [NaN] : [ref?.spot, ref?.twap > 0 ? ref.twap : ref?.spot];
  const at = isLong ? Math.max(...px) : Math.min(...px);
  const dir = isLong ? 1 : -1;
  const exit = (pct, sign, name) => {
    if (!pct) return 0n;
    if (!(at > 0)) throw new Error(`No price for this coin yet, so the ${name} cannot be set. Try again in a few seconds.`);
    const x = at * (1 + (sign * dir * pct) / 100);
    if (!(x > 0)) throw new Error(`That ${name} needs a price at or below zero.`);
    return toWad(x);
  };
  const args = [BigInt(m.marketId), isLong, lev, wei, exit(tpPct, 1, "take profit"), exit(slPct, -1, "stop loss")];
  const a = acctOf(me);
  const bind = refToBind(me, a);
  const done = (r, via) => {
    const ev = V.parseEventLogs({ abi: R.abi, logs: r.logs, eventName: "OpenRequested" })[0];
    refresh(true);
    return { id: String(ev.args.id), via };
  };
  if (!bind && keyLive(key, a)) {
    try {
      return done(await send("requestOpenFor", [me, ...args, ZERO], { key }), "session");
    } catch (e) {
      if (!e.keyRefused) throw e;
    }
  }
  return done(await send("requestOpen", [...args, bind || ZERO], { from: me }), "wallet");
}

const act = async (fn, id) => {
  const me = R.address;
  const key = R.session;
  let r = null;
  if (keyLive(key, acctOf(me))) {
    try {
      r = await send(fn, [BigInt(id)], { key });
    } catch (e) {
      if (!e.keyRefused) throw e;
    }
  }
  r ||= await send(fn, [BigInt(id)], { from: me });
  refresh(true);
  return r;
};
export const close = (id) => act("requestClose", id);
export const cancel = (id) => act("cancelRequest", id);

export async function deposit(text) {
  const me = R.address;
  await send("deposit", [], { value: amount(text), from: me });
  await refresh(true);
}
export async function withdraw(text) {
  const me = R.address;
  await send("withdraw", [amount(text)], { from: me });
  await refresh(true);
}

// LP: shares in, HYPE out after the delay
export async function addLiquidity(text) {
  const me = R.address;
  await send("addLiquidity", [], { value: amount(text), from: me });
  await refresh(true);
}
/** Ask to withdraw `text` HYPE worth of shares (or everything when text is "all"). */
export async function requestRemove(text) {
  const me = R.address;
  const lp = acctOf(me)?.lp;
  if (!lp) throw notLoaded();
  const have = BigInt(lp.shares || 0);
  if (!have) throw new Error("You hold no pool shares.");
  let shares = have;
  if (text !== "all") {
    const want = amount(text);
    const value = toWad(lp.value);
    shares = value ? (have * want) / value : 0n;
    if (shares > have) shares = have;
  }
  await send("requestRemove", [shares], { from: me });
  await refresh(true);
}
export async function executeRemove(rid) {
  const me = R.address;
  await send("executeRemove", [BigInt(rid)], { from: me });
  await refresh(true);
}
export async function cancelRemove(rid) {
  const me = R.address;
  await send("cancelRemove", [BigInt(rid)], { from: me });
  await refresh(true);
}

// ───────────────────────────── errors ─────────────────────────────

export function explain(e) {
  if (e?.sent) return `Sent, checking… (${String(e.sent).slice(0, 10)}…) It may take a moment to show up.`;
  const walk = (fn) => (typeof e?.walk === "function" ? e.walk(fn) : null);
  if (e?.code === 4001 || walk((x) => x?.code === 4001 || x instanceof V.UserRejectedRequestError)) return "Cancelled in your wallet.";
  const rev = walk((x) => x instanceof V.ContractFunctionRevertedError);
  const name = rev?.data?.errorName;
  const P = R.cfg?.params || {};
  const n = R.cfg?.native || "";
  const ERR = {
    InsufficientBalance: "Not enough free balance in Styx. Deposit first.",
    BadStake: `The stake must be at least ${P.minStake} ${n}.`,
    BadLeverage: "Leverage is 2x, 5x or 10x.",
    OpensDisabled: "New trades are paused on the pool right now.",
    MarketClosed: "This coin is closed for new trades right now.",
    UnknownMarket: "This coin is not listed yet.",
    TooEarly: "Too early. Wait for the minimum hold or the cancel delay.",
    BadStatus: "This position cannot do that in its current state.",
    Unauthorized: "This wallet is not allowed to do that.",
    BadSessionKey: "The one-click key was refused. Try again.",
    ZeroAmount: "Enter an amount.",
    PoolCap: "The pool is full during the guarded launch.",
    InsufficientShares: "Not enough pool shares.",
    InsufficientFreeCash: "The pool's free cash is reserved for open positions. Try later.",
    RemoveExpired: "This withdrawal expired. Cancel it and ask again.",
    StaleReport: "The pool waits for a fresh keeper report. Try again in a few seconds.",
    BadPrice: "Take-profit or stop-loss price is out of range.",
    TransferFailed: "The transfer failed.",
  };
  if (name) return ERR[name] || name;
  if (walk((x) => x?.code === -32005) || e?.code === -32005) return "Too many requests from this network. Try again in a few seconds.";
  if (walk((x) => x?.code === -32603) || e?.code === -32603) return "The chain's RPC did not answer. Try again.";
  if (/insufficient funds/i.test(e?.message || "")) return `Not enough ${n} in the wallet for this and its gas.`;
  return String(e?.shortMessage || e?.message || e).split("\n")[0].slice(0, 180);
}

export const fmt = (wei, d = 4) => (wei == null ? "—" : Number(V.formatEther(wei)).toFixed(d));
export const txUrl = (hash) => (R.cfg?.explorer && hash ? `${R.cfg.explorer.replace(/\/$/, "")}/tx/${hash}` : null);
