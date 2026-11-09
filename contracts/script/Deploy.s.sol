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
        } else if (keccak256(bytes(id)) == keccak256("rh")) {
            n.chainId = 4663;
            n.weth = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
            n.feeFactories = new address[](1);
            n.feeFactories[0] = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA; // Uniswap v3
            n.tsFactories = new address[](1);
            n.tsFactories[0] = 0xc63d7338c178e805c544B8f897066bD3BBcBE136; // Aero Slipstream
            n.v4Hooks = new Hook[](0);
        } else {
            revert("NETWORK: rh or elysium");
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
            pool.setParams(_elysiumParams(pool.getParams()));
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
