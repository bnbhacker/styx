// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {InversePool} from "../InversePool.sol";
import {V4SpotSource} from "../V4SpotSource.sol";

/// Deploys Styx v1.1: InversePool + (on Elysium) the V4SpotSource band as the default price adapter, and sets the
/// per-chain parameters of STYX-ELYSIUM.md §3.3. The signer comes from a Foundry keystore (never a raw key in the
/// environment):
///
///   cast wallet import inverse-deployer --interactive          # once; stored in ~/.foundry/keystores
///   NETWORK=elysium forge script script/Deploy.s.sol --rpc-url elysium --account inverse-deployer --broadcast
///   (NETWORK=elysium-mainnet with --rpc-url elysium-mainnet for the mainnet)
///
/// Env (all optional): KEEPER (default deployer), GUARDIAN, TREASURY, REBATE_SOURCE, MAX_POOL_CASH (wei).
/// Guarded launch on Elysium: the LP gate is ON with only the deployer allowed, pool cash capped.
/// After deploy: hand ownership to a multisig behind a TimelockController (transferOwnership + acceptOwnership);
/// V4SpotSource follows the pool's owner automatically.
contract Deploy is Script {
    struct Hook {
        address manager;
        address hooks;
    }

    struct Net {
        uint256 chainId;
        address weth;
        address[] feeFactories; // getPool(a, b, fee)        -> setFactory(f, 1)
        address[] tsFactories; //  getPool(a, b, tickSpacing) -> setFactory(f, 2)
        Hook[] v4Hooks; // allowed for V4SpotSource feeds; empty = no adapter
        bool elysium;
        bool mainnet; // Elysium mainnet: ~0.23 s blocks (the testnet makes ~0.107 s ones)
    }

    function _net(string memory id) internal pure returns (Net memory n) {
        if (keccak256(bytes(id)) == keccak256("elysium")) {
            // TESTNET addresses (05.11.2026). Mainnet ones are published on 09.11: replace before a mainnet deploy.
            n.chainId = 99801;
            n.elysium = true;
            n.weth = 0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234; // WHYPE
            n.feeFactories = new address[](1);
            n.feeFactories[0] = 0x520bF060F58ceE054f725877279328F5f73A7893; // main v3 venue on the testnet
            n.tsFactories = new address[](0);
            n.v4Hooks = new Hook[](2);
            // memecoin launchpad: every pool native HYPE
            n.v4Hooks[0] = Hook(0x0088BEA218c283a939C93d7dB8353Cd87CDCF647, 0xd492b95e2ECf74DB6c5493E7C32F6816248484cC);
            // WHYPE pairs (GCR, VEL, ...)
            n.v4Hooks[1] = Hook(0x889A96eeDb1dF35A012D7e48BaF7f9c780f1243b, 0xDa605da70Bff4b32a9B379c614A6D9E4a09BAAEC);
        } else if (keccak256(bytes(id)) == keccak256("elysium-mainnet")) {
            // MAINNET (chain 99901), read 14.11.2026. WHYPE is the one on elysium.kinetiq.xyz/docs/contract-addresses
            // (look-alikes exist). The factories are every v3 venue with swaps in a 60 000-block scan whose own
            // registry returned its pools; the engine's list (engine/config.mjs) is the same.
            n.chainId = 99901;
            n.elysium = true;
            n.mainnet = true;
            n.weth = 0xbA876237B0F021A6c6D852d6c26E107997cC5E81; // WHYPE
            n.feeFactories = new address[](8);
            n.feeFactories[0] = 0x8C60243181370bDA9A7d1a45b1249A8263da0158;
            n.feeFactories[1] = 0x6307fc239C7964942c1BfFE51930E55606619c74;
            n.feeFactories[2] = 0x1707327F626496A7b5b3872e7E4d2879Df7d7a9f;
            n.feeFactories[3] = 0x809ff79945FfFbf9B8Df33Bb3B62872CEB2efaF1;
            n.feeFactories[4] = 0x367F85886af509E364c8190862BC714555FeFc3e;
            n.feeFactories[5] = 0x4F66184A9FFabB7f7071D590C2c48DEDf41676f4;
            n.feeFactories[6] = 0x24e21E3F2b0bB0C166ec3EAFf1e615aB14cDD85F;
            n.feeFactories[7] = 0xE83aaBBd2e326ceAAE3BDCB605b3af94Ac3CF883;
            n.tsFactories = new address[](2); // keyed by tick spacing, dynamic fee: the two busiest v3 venues
            n.tsFactories[0] = 0xEfd7A089D3057F05189B05f74Ffcf30610c42891;
            n.tsFactories[1] = 0x29cd8852FF040CfE74fb20277A121eD1293AFb41;
            // Only hookless pools of the main PoolManager are allowed at deploy. A launchpad hook sits in the swap
            // path and takes its own fee: the owner allows each one with setHookAllowed after reading its code.
            n.v4Hooks = new Hook[](1);
            n.v4Hooks[0] = Hook(0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1, address(0));
        } else if (keccak256(bytes(id)) == keccak256("rh")) {
            n.chainId = 4663;
            n.weth = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
            n.feeFactories = new address[](1);
            n.feeFactories[0] = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA; // Uniswap v3
            n.tsFactories = new address[](1);
            n.tsFactories[0] = 0xc63d7338c178e805c544B8f897066bD3BBcBE136; // Aero Slipstream
            n.v4Hooks = new Hook[](0);
        } else {
            revert("NETWORK: rh, elysium or elysium-mainnet");
        }
    }

    /// @dev STYX-ELYSIUM.md §3.3 A: ~0.107 s blocks, priority-fee ordering.
    function _elysiumParams(InversePool.Params memory p) internal view returns (InversePool.Params memory) {
        p.minStake = 0.1 ether; // 0.1 HYPE
        p.cancelDelay = 10;
        p.maxPriceAgeBlocks = 50;
        p.rugWindowBlocks = 280;
        p.reportMaxAge = 60;
        p.removeWindow = 1 hours;
        p.minExecDelayBlocks = 1;
        p.maxExecDelayBlocks = 20;
        p.keeperBlockRate = 1800; // L2 blocks per hour (0.5/s floor): Nitro makes no empty blocks on a quiet chain
        p.marketLiabilityBps = 200; // guarded launch: max-win per coin side <= 2 % of the pool (STYX-ELYSIUM §3.5)
        p.notionalCapMax = 50 ether; // 5 HYPE at 10x per side: the guarded-launch ceiling over the keeper
        p.maxPoolCash = vm.envOr("MAX_POOL_CASH", uint256(5_000 ether));
        return p;
    }

    /// @dev The same windows in seconds on mainnet, whose blocks take ~0.23 s (20 000 blocks, 14.11.2026): the block
    ///      counts of _elysiumParams shrink by 0.107 / 0.23. cancelDelay (10 s) still covers the whole window in
    ///      which the keeper may fill: (9 + 23) blocks * 0.23 s = 7.4 s.
    function _mainnetBlocks(InversePool.Params memory p) internal pure returns (InversePool.Params memory) {
        p.maxExecDelayBlocks = 9; // ~2.1 s, as 20 blocks are on the testnet
        p.maxPriceAgeBlocks = 23; // ~5.3 s
        p.rugWindowBlocks = 130; // ~30 s
        return p;
    }

    function run() external returns (InversePool pool, V4SpotSource src) {
        Net memory n = _net(vm.envOr("NETWORK", string("elysium")));
        require(block.chainid == n.chainId, "rpc-url points at another chain");
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        address keeper = vm.envOr("KEEPER", deployer);
        // the hot keeper key must never also be the owner (review 06.11)
        if (n.elysium) require(keeper != deployer, "set KEEPER to a separate hot key; the deployer is the owner");
        pool = new InversePool(n.weth, keeper);
        for (uint256 i; i < n.feeFactories.length; ++i) pool.setFactory(n.feeFactories[i], 1);
        for (uint256 i; i < n.tsFactories.length; ++i) pool.setFactory(n.tsFactories[i], 2);
        if (n.v4Hooks.length != 0) {
            src = new V4SpotSource(pool);
            for (uint256 i; i < n.v4Hooks.length; ++i) src.setHookAllowed(n.v4Hooks[i].manager, n.v4Hooks[i].hooks, true);
        }
        pool.setRoles(
            vm.envOr("GUARDIAN", address(0)),
            vm.envOr("TREASURY", address(0)),
            vm.envOr("REBATE_SOURCE", address(0)),
            address(src)
        );
        if (n.elysium) {
            InversePool.Params memory p = _elysiumParams(pool.getParams());
            pool.setParams(n.mainnet ? _mainnetBlocks(p) : p);
            pool.setLpAllowed(deployer, true);
            pool.setLpAllowed(address(0), true); // gate on: guarded launch, team LP only
        }
        vm.stopBroadcast();
        console2.log("InversePool", address(pool));
        console2.log("V4SpotSource", address(src));
        console2.log("owner / keeper", deployer, keeper);
        console2.log("USE_ARBSYS", pool.USE_ARBSYS());
    }
}
