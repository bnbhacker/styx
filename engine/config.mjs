import { keccak256, toHex } from "viem";

/**
 * Everything tunable lives here. Numbers mirror SPEC.md.
 * Styx runs on Elysium: NETWORK=elysium (the testnet) is the default, NETWORK=elysium-mainnet
 * (engine/elysium-mainnet.mjs) is the mainnet, NETWORK=rh (engine/rh.mjs) keeps the Robinhood Chain build.
 */
const lcAll = (xs) => xs.map((x) => x.toLowerCase());

const NETWORKS = {
  rh: {
    name: "Robinhood Chain",
    rpc: process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com",
    chainId: 4663,
    port: 4680,
    native: "ETH",
    WETH: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    USD: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
    usdSymbol: "USDG",
    usdDecimals: 6,
    poolManagers: ["0x8366a39cc670b4001a1121b8f6a443a643e40951"],
    stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    dexscreener: "robinhood", // pool metadata + 24h stats; null = read everything from the chain
    pollMs: 1500,
    maxRange: 400n,
    backfillBlocks: 6000n, // ~10 min
    // [D10 in native, max leverage] — D10 = native needed to move the price 10%
    tiers: [
      [5, 10],
      [1.5, 5],
      [0.3, 2],
    ],
    minStake: 0.001,
    paper: { claim: 1, poolSeed: 25 },
    // keeper priority tips (wei): RH sequences FCFS, tips buy nothing
    tips: { defensive: 0n, exec: 0n },
    // v3 factories whose pools the engine trusts when DexScreener does not know a pool (getPool is checked too)
    v3Factories: ["0x1f7d7550b1b028f7571e69a784071f0205fd2efa"], // Uniswap v3
    nativeUsd: [100, 100_000], // sanity band for the ETH/USD anchor
    policy: { maxStake: 0, maxLev: 10, newAccountStake: 0 }, // 0 = no keeper-side cap
    // Real mode on the site: the RPC a wallet adds for this chain, its explorer, the gas a session key gets
    publicRpc: "https://rpc.mainnet.chain.robinhood.com",
    explorer: null,
    sessionGas: 0.0005,
  },

  // Kinetiq's L2 on HyperEVM (Arbitrum Orbit). Gas and quote are HYPE. Testnet values, checked 05.11.2026:
  // blocks ~0.107 s; memecoins sit in v4 pools with native HYPE (launchpad hook 0xd492…84cc on 0x0088…f647),
  // majors on a Uniswap-v3 fork (factory 0x520b…7893, pools keep 1 observation). DexScreener does not list it.
  elysium: {
    name: "Elysium testnet",
    rpc: process.env.ELY_RPC || "https://testnet-rpc.elysium.kinetiq.xyz",
    chainId: 99801,
    port: 4681,
    native: "HYPE",
    WETH: "0xcd57f65c2b0e5881cfc2e609f7cd53b746e1f234", // WHYPE used by the main v3 and v4 venues
    USD: "0x7d29d8047b905000459c0e80c34a26ceedcb47b2",
    usdSymbol: "USDC",
    usdDecimals: 6,
    poolManagers: [
      "0x0088bea218c283a939c93d7db8353cd87cdcf647", // memecoin launchpad, all pools native HYPE
      "0x889a96eedb1df35a012d7e48baf7f9c780f1243b",
      "0x0a47f680e4123a9d77946de9efa710d18d7aa782",
      "0x3b7f3d8d1ce6c26bb8072db0d046d17bffbbff07",
    ],
    stateView: null, // read v4 state with PoolManager.extsload
    dexscreener: null,
    // with a keeper the price must reach it inside the 20-block (~2 s) execution window
    pollMs: process.env.STYX_POOL ? 400 : 1000,
    maxRange: 2000n, // the node caps getLogs at 10k logs; ~1 swap per block
    backfillBlocks: BigInt(process.env.BACKFILL || 40000), // ~70 min of history on start
    // Mainnet depth tiers (same dollars as on RH at ETH/HYPE ≈ 30): [150, 10], [45, 5], [9, 2] HYPE.
    // Testnet launch profile (user decisions 09.11.2026): the testnet went quiet when mainnet opened (5 coins,
    // ~800 swaps/h), so a coin opens after 10 minutes on shallower depth, and quiet coins are not shut for having no
    // trades (the user asked for coins on the board to click and trade). Testnet HYPE is free, so this costs nothing
    // real. Mainnet goes back to the defaults in CFG.rules.
    admission: { minMcapUsd: 5_000, minPoolAgeH: 1 / 6, minTxns24h: 0, minVol24hUsd: 0 },
    tiers: [
      [15, 10],
      [5, 5],
      [1, 2],
    ],
    // the board on a quiet testnet: the 40 busiest pools of the 24 h before 09.11.2026 03:10 (317k swaps, 961 pools).
    // Loaded at start even without a swap; pairs that are not to HYPE/USDC or come from unknown factories drop out.
    featuredPools: [
      "0x30b402c6429ecea14fc1e0a8963ebbedd5b920c1", "0x224966692c8b849af834885fe07848ffd8c2c375",
      "0x3cb12abff6060dff9f31837f3a66236ae2da1907", "0xc826b2a15a7d6bdb0e88f6d72900bf2c2d2e9127",
      "0xb509a5c2ff66dc40f1a84ae6d4a6b51dbc250dae", "0xd6c752aa17358572c6ffd24a81bafcd31d2e32b4",
      "0x82f9323710040be13a1ec9d4777c182a4680da13", "0xdb31be5033038360b5965e22e29ceb2e20294553df2474bcb033c439718039d0",
      "0xe3bcd17f4a0096a84ef906ebd10dc4161edb45e7", "0xa7e70f887dc7cd0f994110f2ebf6552d48106db0",
      "0xf82402f6f9cadd3a145601cf38fa879e8db92f33", "0xea15648de8a2d5f26e35c64603779c9c9fb1e98c",
      "0x1b6314f60961093aa977d7020cbabbce9dd2cb7e", "0x591aa2ec4275135c640d07f9eaa35cdad52ab05c",
      "0xd89f9ba9608fd6047b85e14b5af5ae6e82e75aaf", "0xcb410889ff70bb5a46ccb38821b0ae0004811e6b6cbbb2504bf19b0753315611",
      "0xc1ad66dfb1530a555a85eb167ffc9e4aa20e0771", "0xf6beb92e9a25e77d48a7384ab504dc085bcfff5de8eace1010c557333321528d",
      "0x6a6081c04ce7b959e430cbb806563bfa0ee4df2e7cb56447f04f13f8489a02e4", "0x4548fcae455608719d6fc993143495f405205622",
      "0x1bb6f757dd9df64b6898f236b70b7c7098143650", "0x18f0f462ff07c0a55e4e7ced3f94b26785edb7d0bc6b5d23b8b094676fbd9d34",
      "0x487ecfbec9ded84a7725eb8dc18eed477c50530d", "0x7a6197e6c3a5cb9a2334abd9eb85fa8579254846",
      "0xf3893fd77f569155f79d1396a0eece62a381dcfc", "0x6641df8e50dda70694ee6bcb4e87f735a10f863e",
      "0xb33f0899fcc4b74dd2cc5d6fd59802ee52a82a1d", "0xa8bd1eddd481a47f84487b7719c9931239fc4d1a",
      "0x918fad50952b20e96723e641544e0506d2ebdd79", "0x42e878f6abf03d7db8a339406d79cd0b304662f1",
      "0xa32fce6bb39ef51d0989151a592a4029bd136e2d", "0x7e0d8896a7560c9884954cf90f1ba599d84178e4",
      "0x94bff7ff41cc2ac1f33acc76e4de5f0b1dd8e01f", "0x6b0020a0d4ac3c16458a2c0f638824ef1a486405a14a153b00820223269c6a31",
      "0x232242d9cf0e53c457594a4691658f36cf0bc117a6ddd1193460e2e243ff62c3", "0x595fc14fa153154e29cc596830021d2621394551",
      "0xa64a9ad4e5cbb6d8dffa40c4fbf54c4bae8348b14a369291a096a182767b3d08", "0x52fe6d465206c3dfdc07c212bcc89ca91a753483fbf4fa46b37cfc656e3a8c2c",
      "0xad5a21eb3f8311b94d7a53e063152681f07d63f7b1cb6993d1a448c25eb45c66", "0xfcb8093c4f88576a2987509735a0b54156299369",
    ],
    minStake: 0.03,
    paper: { claim: 30, poolSeed: 750 },
    // Elysium orders a block by priority fee: SL / CAP / RUG must win same-block races against dumps
    // (STYX-ELYSIUM §3.4: +1 gwei defensive ≈ 0.00015 HYPE per 150k gas, +0.05 gwei for fills)
    tips: { defensive: 1_000_000_000n, exec: 50_000_000n },
    // every v3 factory with swaps on the testnet (scan 05–06.11.2026); mainnet: re-scan after 09.11
    v3Factories: [
      "0x520bf060f58cee054f725877279328f5f73a7893", // Kalos (fee-keyed, approved on-chain)
      "0x77573e627213afcfb5c2165940ce696fef2b4794",
      "0x1186defcaf121da6e773425fec0814608798e792",
      "0x9a31d641c26349b11562d532ddf532968d56939f",
      "0xf172c253610b41147fb655067bfcb9415087b9ac",
      "0x645abe53fe3eab2c5101d97c27b2637cced6d37c",
      "0x58494c6fffd988a6ec3645439313c80fae80a989",
    ],
    // HYPE ≈ $77 on mainnet (06.11) but ≈ $13 000 in testnet pools: a wide band, the deepest pool wins
    nativeUsd: [1, 1_000_000],
    // guarded launch (STYX-ELYSIUM §3.5): stake ≤ 5 HYPE, 10x on launchpad coins only after measuring jumps,
    // a new Styx account (< 24 h since its first request) ≤ 1 HYPE per trade
    policy: { maxStake: 5, maxLev: 5, newAccountStake: 1 },
    publicRpc: "https://testnet-rpc.elysium.kinetiq.xyz",
    explorer: "https://explorer-elysium-testnet.t.conduit.xyz", // Conduit's Blockscout-style explorer (/tx/<hash>), checked 07.11
    // a session-key order costs ~250k gas; at testnet fees 0.02 HYPE lasts hundreds of orders
    sessionGas: 0.02,
    // Markets showcase (09.11, the user's pick): the biggest Elysium MAINNET memecoins, shown above the testnet board
    // with live DexScreener numbers. Display only: no testnet pool, no Styx market, nothing can trade them here.
    showcase: {
      chain: "elysium",
      pairs: [
        "0xc0be17156606216257c638d839c1dd6d43955a565e0b3d6c568d79ebe82cf84c", // e/acc 0x8df4f39d…4128 / WHYPE, v4
        "0x35bd0e6a8b82e0e18b0381757d97ba01cde11a02740f006132dd40395ffc8ce2", // eaccat 0x32193afd…ec71 / HYPE, v4
        "0x61a799e016a5433af3e67cee4ca32dae81338c1ae7287192dc9d69b83b282aac", // CHAMELEON 0xd662d66e…cf38 / HYPE, v4
      ],
    },
  },

  // Elysium mainnet (live since 09.11.2026). Read from the chain and the docs on 14.11.2026:
  // - chainId 99901 (eth_chainId), WHYPE and USDC from elysium.kinetiq.xyz/docs/contract-addresses (look-alikes exist);
  // - blocks ~0.23 s (20 000 blocks), base fee 0.5 gwei, ~10k swaps an hour, HYPE ≈ $68 in the deepest USDC/WHYPE pool;
  // - getLogs is capped at 10 000 logs a query, and logs carry blockTimestamp.
  // DexScreener lists the chain ("elysium"), but the engine reads everything from the chain as on the testnet.
  "elysium-mainnet": {
    name: "Elysium",
    rpc: process.env.ELY_MAINNET_RPC || "https://rpc.elysium.kinetiq.xyz",
    chainId: 99901,
    port: 4682,
    native: "HYPE",
    WETH: "0xba876237b0f021a6c6d852d6c26e107997cc5e81", // WHYPE
    USD: "0xb47c4c8f73f009cc0c0d3f92b388d13e293f0b65",
    usdSymbol: "USDC",
    usdDecimals: 6,
    // every v4 Swap emitter of a 60 000-block scan (14.11) that is a stock PoolManager: 24 009 bytes of code, and
    // extsload of slot 6 returned the sqrtPrice and liquidity of the pool's last Swap event. Left out: 0x794a…ff1f
    // (other bytecode, price 1 % off its event) and 0x3564…fa25 (other bytecode, one swap).
    poolManagers: [
      "0xe2e105d3f7209a9da11f83ccf3e7398a753823f1", // the main one: 426 active pools, HYPE / WHYPE / USDC quotes
      "0x5c54a7293d96b11a29a0256ee8dfdbc3059637da", // a launchpad: native HYPE pools, fee 0 in the key, one hook
      "0x5fb015a49f5b35073f9ce01c2adb287a75f89600",
      "0x06c63714fbf1f5753017123e2fcfdede4540b2c4",
      "0xb308b5df891c300a5f5a5b8fdbc30108ba842490",
    ],
    stateView: null, // read v4 state with PoolManager.extsload
    dexscreener: null,
    pollMs: process.env.STYX_POOL ? 400 : 1000,
    maxRange: 1000n, // bursts reach ~0.9 swaps a block: stay well under the 10 000-log cap
    backfillBlocks: BigInt(process.env.BACKFILL || 20000), // ~75 min of history on start
    // STYX-ELYSIUM §3.2 asks for $12k / $3.5k / $0.7k of depth; in HYPE at ~$77 (06.11). Recalibrate on live data.
    tiers: [
      [150, 10],
      [45, 5],
      [9, 2],
    ],
    minStake: 0.1, // STYX-ELYSIUM §3.3
    paper: { claim: 30, poolSeed: 750 },
    tips: { defensive: 1_000_000_000n, exec: 50_000_000n }, // ordering is by priority fee, as on the testnet
    // every factory of a v3 Swap emitter in the same scan whose registry returned its pools (verifyV3)
    v3Factories: [
      "0xefd7a089d3057f05189b05f74ffcf30610c42891", // keyed by tick spacing, dynamic fee; the busiest USDC/WHYPE pool
      "0x29cd8852ff040cfe74fb20277a121ed1293afb41", // keyed by tick spacing, dynamic fee
      "0x8c60243181370bda9a7d1a45b1249a8263da0158", // fee-keyed, USDC/WHYPE at 0.05 / 0.3 / 1 %
      "0x6307fc239c7964942c1bffe51930e55606619c74",
      "0x1707327f626496a7b5b3872e7e4d2879df7d7a9f",
      "0x809ff79945fffbf9b8df33bb3b62872ceb2efaf1",
      "0x367f85886af509e364c8190862bc714555fefc3e",
      "0x4f66184a9ffabb7f7071d590c2c48dedf41676f4",
      "0x24e21e3f2b0bb0c166ec3eaff1e615ab14cdd85f",
      "0xe83aabbd2e326ceaae3bdcb605b3af94ac3cf883",
    ],
    nativeUsd: [5, 1000],
    // the same guarded launch as on the testnet (STYX-ELYSIUM §3.5)
    policy: { maxStake: 5, maxLev: 5, newAccountStake: 1 },
    publicRpc: "https://rpc.elysium.kinetiq.xyz",
    explorer: "https://elysium.kinetiq.xyz", // Kinetiq's own explorer; the /tx/<hash> path is not checked yet
    sessionGas: 0.02, // an order is ~250k gas: ~160 orders at the 0.5 gwei base fee
  },
};

const id = (process.env.NETWORK || "elysium").toLowerCase();
const N = NETWORKS[id];
if (!N) throw new Error(`NETWORK=${id}: expected one of ${Object.keys(NETWORKS).join(", ")}`);

export const CFG = {
  network: id,
  name: N.name,
  rpc: N.rpc,
  chainId: N.chainId,
  port: Number(process.env.PORT || N.port),
  native: N.native,

  pollMs: N.pollMs,
  maxRange: N.maxRange,
  backfillBlocks: N.backfillBlocks,
  sampleMs: 1000, // price sample cadence for TWAP / charts
  keepSamplesS: 15 * 60,
  // without DexScreener the engine counts 24h stats itself, so it keeps a day of swaps
  keepVolS: N.dexscreener ? 3600 : 24 * 3600,

  WETH: N.WETH.toLowerCase(),
  USD: N.USD.toLowerCase(),
  usdSymbol: N.usdSymbol,
  usdDecimals: N.usdDecimals,
  NATIVE: "0x0000000000000000000000000000000000000000",
  poolManagers: new Set(lcAll(N.poolManagers)),
  stateView: N.stateView,
  dexscreener: N.dexscreener,

  topics: {
    v3: keccak256(toHex("Swap(address,address,int256,int256,uint160,uint128,int24)")),
    v4: keccak256(toHex("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")),
    v4Init: keccak256(toHex("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)")),
    v3Created: keccak256(toHex("PoolCreated(address,address,uint24,int24,address)")),
    v3CreatedTick: keccak256(toHex("PoolCreated(address,address,int24,address)")), // factories keyed by tick spacing
  },

  rules: {
    minMcapUsd: 30_000,
    minPoolAgeH: 2,
    minTxns24h: 100,
    minVol24hUsd: 2_000,
    ...N.admission,
    tiers: N.tiers,
    leverages: [2, 5, 10],
    notionalPctOfD10: 0.2, // per coin, per side: sum(stake*lev) <= 20% of D10
    maxWinPerMarketPct: 0.05, // sum of +200% caps per coin side <= 5% of pool
    maxWinTotalPct: 0.5,
    maxWinMult: 2, // +200%
    twapS: 30,
    minHoldS: 10,
    feeBps: 100,
    feeSplit: { pool: 7500, ref: 1000, weekly: 1000, ops: 500 },
    rugDrop: 0.8,
    rugWindowS: 30,
    rugShortCap: 0.2,
    rugLockS: 3600,
    poolLossPauseH: 0.1, // pool lost >10% in the last hour -> pause opens
    minStake: N.minStake,
  },

  paper: N.paper,
  tips: N.tips,
  v3Factories: N.v3Factories ? new Set(lcAll(N.v3Factories)) : null,
  nativeUsd: N.nativeUsd,
  policy: {
    maxStake: Number(process.env.POLICY_MAX_STAKE ?? N.policy.maxStake),
    maxLev: Number(process.env.POLICY_MAX_LEV ?? N.policy.maxLev),
    newAccountStake: Number(process.env.POLICY_NEW_ACCOUNT_STAKE ?? N.policy.newAccountStake),
  },
  // v4 hooks that take their own fee (the PoolKey says 0): pips per hook, for the notional cap. Unknown -> 0.1·D10.
  hookFeePips: {},
  // Real mode: STYX_POOL = deployed InversePool; the key comes from a keystore (see keeper/keystore.mjs)
  pool: process.env.STYX_POOL ? process.env.STYX_POOL.toLowerCase() : null,
  keeperTickMs: Number(process.env.KEEPER_TICK_MS || 300),
  // the site: what a wallet adds for this chain (never CFG.rpc, which may carry a provider key)
  publicRpc: process.env.STYX_PUBLIC_RPC || N.publicRpc,
  explorer: process.env.STYX_EXPLORER || N.explorer,
  sessionGas: Number(process.env.STYX_SESSION_GAS || N.sessionGas),
  // pools always on the board (loaded without waiting for a swap): N.featuredPools plus STYX_FEATURED (comma list)
  featuredPools: [...new Set(lcAll([...(N.featuredPools || []), ...String(process.env.STYX_FEATURED || "").split(",").filter((s) => /^0x([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(s.trim())).map((s) => s.trim())]))],
  // the $STYX token: the site shows its contract address with a copy button and a link to its market
  styxToken: /^0x[0-9a-fA-F]{40}$/.test(process.env.STYX_TOKEN || "") ? process.env.STYX_TOKEN.toLowerCase() : null,
  // reverse proxies in front of the engine that append X-Forwarded-For (0 = none: rate limits key on the socket peer)
  trustProxy: Math.max(0, Math.floor(Number(process.env.STYX_TRUST_PROXY) || 0)),
  // display-only mainnet coins on Markets (showcase.mjs); STYX_SHOWCASE=0 hides them
  showcase: process.env.STYX_SHOWCASE === "0" ? null : N.showcase || null,
};
