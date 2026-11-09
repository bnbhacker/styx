import { createPublicClient, http, defineChain, toHex, parseAbi, keccak256, encodeAbiParameters } from "viem";
import { CFG } from "./config.mjs";

export const net = defineChain({
  id: CFG.chainId,
  name: CFG.name,
  nativeCurrency: { name: CFG.native, symbol: CFG.native, decimals: 18 },
  rpcUrls: { default: { http: [CFG.rpc] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

// cacheTime 0: viem otherwise caches eth_blockNumber for pollingInterval (up to 4 s = ~37 Elysium blocks, longer
// than the keeper's 20-block execution window). pollingInterval drives waitForTransactionReceipt.
export const client = createPublicClient({
  chain: net,
  cacheTime: 0,
  pollingInterval: 200,
  transport: http(undefined, { retryCount: 3, retryDelay: 800, timeout: 20_000 }),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Raw getLogs with backoff: public nodes 403/429 bursts. */
async function logs(filter) {
  for (let i = 0; ; i++) {
    try {
      return await client.request({ method: "eth_getLogs", params: [filter] });
    } catch (e) {
      if (i >= 4) throw e;
      await sleep(1000 * (i + 1));
    }
  }
}

export const getSwapLogs = (from, to) =>
  logs({ fromBlock: toHex(from), toBlock: toHex(to), topics: [[CFG.topics.v3, CFG.topics.v4]] });

const erc20 = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);

/** symbol / name / decimals / totalSupply for many tokens in one multicall. */
export async function tokenMeta(addrs) {
  const calls = addrs.flatMap((a) =>
    ["symbol", "name", "decimals", "totalSupply"].map((fn) => ({ address: a, abi: erc20, functionName: fn })),
  );
  const res = await client.multicall({ contracts: calls, allowFailure: true });
  return addrs.map((a, i) => {
    const [s, n, d, t] = res.slice(i * 4, i * 4 + 4).map((r) => (r.status === "success" ? r.result : null));
    return { addr: a, symbol: s, name: n, decimals: d == null ? null : Number(d), totalSupply: t };
  });
}

const v3Abi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
]);
const svAbi = parseAbi([
  "function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)",
  "function getLiquidity(bytes32) view returns (uint128)",
]);
const pmAbi = parseAbi(["function extsload(bytes32) view returns (bytes32)"]);
const POOLS_SLOT = 6n; // PoolManager: mapping(PoolId => Pool.State) _pools

/** Current sqrtPrice + in-range liquidity of a pool that has not swapped since start. */
export async function poolState(p) {
  if (p.kind === "v4") {
    if (CFG.stateView) {
      const [s0, L] = await Promise.all([
        client.readContract({ address: CFG.stateView, abi: svAbi, functionName: "getSlot0", args: [p.key] }),
        client.readContract({ address: CFG.stateView, abi: svAbi, functionName: "getLiquidity", args: [p.key] }),
      ]);
      return { sqrtP: s0[0], L };
    }
    // no StateView: read Pool.State directly (slot0 word, liquidity three words further)
    const base = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [p.key, POOLS_SLOT])));
    const [w0, w3] = await Promise.all(
      [base, base + 3n].map((s) =>
        client.readContract({ address: p.manager, abi: pmAbi, functionName: "extsload", args: [toHex(s, { size: 32 })] }),
      ),
    );
    return { sqrtP: BigInt(w0) & ((1n << 160n) - 1n), L: BigInt(w3) & ((1n << 128n) - 1n) };
  }
  // Aero Slipstream slot0 has a different tail; read only the first word.
  const raw = await client.call({ to: p.key, data: "0x3850c7bd" });
  const sqrtP = BigInt("0x" + raw.data.slice(2, 66));
  const L = await client.readContract({ address: p.key, abi: v3Abi, functionName: "liquidity" });
  return { sqrtP, L };
}

const v3FactoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);

/**
 * A v3-style pool the engine may trust: factory() is on the network's allowlist and that factory's
 * getPool(token0, token1, fee) returns this very address. Any contract can emit the v3 Swap topic and claim
 * token0/token1, so without this a fake "pool" with a huge liquidity field could become a coin's price.
 * -> { factory, fee } or null
 */
export async function verifyV3(pool, t0, t1) {
  try {
    const [f, fee] = await Promise.all([
      client.readContract({ address: pool, abi: v3Abi, functionName: "factory" }),
      client.readContract({ address: pool, abi: v3Abi, functionName: "fee" }),
    ]);
    const factory = f.toLowerCase();
    if (CFG.v3Factories && !CFG.v3Factories.has(factory)) return null;
    const real = await client.readContract({ address: factory, abi: v3FactoryAbi, functionName: "getPool", args: [t0, t1, fee] });
    return real.toLowerCase() === pool.toLowerCase() ? { factory, fee: Number(fee) } : null;
  } catch {
    return null;
  }
}

/** Every pool a fee-keyed v3 factory holds for a pair, over the usual fee tiers. Factories keyed otherwise give none. */
export async function v3PoolsFor(factory, a, b) {
  const out = [];
  for (const fee of [100, 500, 3000, 10000]) {
    try {
      const p = await client.readContract({ address: factory, abi: v3FactoryAbi, functionName: "getPool", args: [a, b, fee] });
      if (p && !/^0x0{40}$/i.test(p)) out.push(p.toLowerCase());
    } catch {}
  }
  return out;
}

export async function v3Tokens(pool) {
  const [t0, t1] = await Promise.all([
    client.readContract({ address: pool, abi: v3Abi, functionName: "token0" }),
    client.readContract({ address: pool, abi: v3Abi, functionName: "token1" }),
  ]);
  return [t0.toLowerCase(), t1.toLowerCase()];
}

const word = (t) => "0x" + t.slice(26).toLowerCase();
const blockTs = new Map();
async function tsOf(bn) {
  const k = BigInt(bn);
  if (!blockTs.has(k)) blockTs.set(k, Number((await client.getBlock({ blockNumber: k })).timestamp) * 1000);
  return blockTs.get(k);
}

/**
 * Currencies and creation time of v4 pools from their Initialize events, one query per manager.
 * Returns Map(poolId -> { c0, c1, hooks, createdAt }).
 */
export async function v4Init(manager, ids) {
  const out = new Map();
  const found = await logs({ address: manager, fromBlock: "0x0", toBlock: "latest", topics: [CFG.topics.v4Init, ids] });
  for (const l of found) {
    out.set(l.topics[1].toLowerCase(), {
      c0: word(l.topics[2]),
      c1: word(l.topics[3]),
      ...initData(l.data),
      createdAt: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) * 1000 : await tsOf(l.blockNumber),
    });
  }
  return out;
}

/** Initialize(id, c0, c1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick) data words. */
function initData(data) {
  const w = (i) => BigInt("0x" + data.slice(2 + 64 * i, 66 + 64 * i));
  return {
    fee: Number(w(0) & 0xffffffn),
    tickSpacing: Number(BigInt.asIntN(24, w(1) & 0xffffffn)),
    hooks: "0x" + data.slice(2 + 64 * 2 + 24, 2 + 64 * 3),
  };
}

/** v4 pools of one token on every manager (the paste-any-CA path without DexScreener). */
export async function v4PoolsOf(token) {
  const t = toHex(BigInt(token), { size: 32 });
  const out = [];
  for (const m of CFG.poolManagers) {
    for (const topics of [[CFG.topics.v4Init, null, t], [CFG.topics.v4Init, null, null, t]]) {
      for (const l of await logs({ address: m, fromBlock: "0x0", toBlock: "latest", topics })) {
        out.push({
          key: l.topics[1].toLowerCase(),
          manager: m,
          c0: word(l.topics[2]),
          c1: word(l.topics[3]),
          ...initData(l.data),
          createdAt: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) * 1000 : await tsOf(l.blockNumber),
        });
      }
    }
  }
  return out;
}

/** Creation time of a v3 pool from its factory's PoolCreated event; null if the factory is not v3-shaped. */
export async function v3CreatedAt(pool, t0, t1) {
  try {
    const [f, fee] = await Promise.all([
      client.readContract({ address: pool, abi: v3Abi, functionName: "factory" }),
      client.readContract({ address: pool, abi: v3Abi, functionName: "fee" }),
    ]);
    const found = await logs({
      address: f,
      fromBlock: "0x0",
      toBlock: "latest",
      topics: [CFG.topics.v3Created, toHex(BigInt(t0), { size: 32 }), toHex(BigInt(t1), { size: 32 }), toHex(fee, { size: 32 })],
    });
    const l = found.find((x) => ("0x" + x.data.slice(2 + 64 + 24, 2 + 128)).toLowerCase() === pool);
    if (!l) return null;
    return l.blockTimestamp ? parseInt(l.blockTimestamp, 16) * 1000 : await tsOf(l.blockNumber);
  } catch {
    return null;
  }
}
