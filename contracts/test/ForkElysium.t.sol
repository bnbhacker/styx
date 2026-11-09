// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {InversePool} from "../InversePool.sol";

interface IPoolEly {
    function observe(uint32[] calldata) external view returns (int56[] memory, uint160[] memory);
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function increaseObservationCardinalityNext(uint16) external;
}

/// Elysium testnet (chainId 99801, Kinetiq's Orbit L2 on HyperEVM) against a fork of the head block.
/// Skipped unless ELY_FORK=1:
///   ELY_FORK=1 forge test --match-contract ForkElysium -vv
/// The native coin is HYPE; "WETH" in the contract is WHYPE here. Addresses found 05.11.2026 by scanning
/// every Swap log of the last ~30 000 blocks (~54 min).
contract ForkElysiumTest is Test {
    address internal constant WHYPE = 0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234;
    address internal constant USDC = 0x7D29d8047B905000459c0E80c34a26CeedcB47b2; // 6 decimals
    address internal constant KALOS = 0x8a2201953AF29e8BE7700bcB53dA3ce5caD18726;
    /// Uniswap-v3 fork with most of the testnet's swaps; getPool(a, b, fee) -> setFactory(f, 1)
    address internal constant V3_FACTORY = 0x520bF060F58ceE054f725877279328F5f73A7893;
    address internal constant KALOS_WHYPE_100 = 0x30b402C6429Ecea14fc1e0a8963EBBedd5B920C1; // fee 0.01 %, busiest
    address internal constant USDC_WHYPE = 0xf82402F6f9CaDD3A145601cF38Fa879E8dB92F33;
    /// memecoin launchpad: v4 PoolManager, every pool native HYPE, hook 0xd492вЂ¦84cc
    address internal constant LAUNCHPAD_PM = 0x0088BEA218c283a939C93d7dB8353Cd87CDCF647;
    address internal constant RHSL = 0x378BCC6827483d176473AddC279d19A8Ea3ad752; // busiest launchpad coin

    bool internal live;

    function setUp() public {
        live = vm.envOr("ELY_FORK", false);
        if (live) vm.createSelectFork("elysium");
    }

    modifier onlyFork() {
        if (!live) vm.skip(true);
        _;
    }

    function _cardinality(address pool) internal view returns (uint16 card, uint16 next) {
        (bool ok, bytes memory s0) = pool.staticcall(abi.encodeWithSignature("slot0()"));
        require(ok && s0.length >= 224, "slot0");
        uint256 c;
        uint256 n;
        assembly {
            c := mload(add(s0, 128)) // word 3
            n := mload(add(s0, 160)) // word 4
        }
        return (uint16(c), uint16(n));
    }

    function _twapOk(address pool) internal view returns (bool ok) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = 30;
        try IPoolEly(pool).observe(ago) returns (int56[] memory, uint160[] memory) {
            ok = true;
        } catch {}
    }

    function test_fork_chain_and_deploy() public onlyFork {
        assertEq(block.chainid, 99801);
        uint256 g = gasleft();
        InversePool p = new InversePool(WHYPE, address(this));
        console2.log("deploy gas on the fork", g - gasleft());
        assertLt(g - gasleft(), 10_000_000);
        // forge's fork has no Nitro precompiles; the live ArbSys answer comes from script/live-check.ps1
        console2.log("USE_ARBSYS on the fork", p.USE_ARBSYS());
    }

    /// The main v3 venue verifies as fee-keyed; its pools keep one observation, so the TWAP check is off
    /// until someone raises the cardinality (anyone may).
    function test_fork_v3_venue_and_cardinality() public onlyFork {
        assertEq(IPoolEly(KALOS_WHYPE_100).factory(), V3_FACTORY);
        (uint16 card, uint16 next) = _cardinality(KALOS_WHYPE_100);
        console2.log("KALOS/WHYPE cardinality / next", card, next);
        console2.log("KALOS/WHYPE observe([30,0]) ok", _twapOk(KALOS_WHYPE_100));
        (card, next) = _cardinality(USDC_WHYPE);
        console2.log("USDC/WHYPE cardinality / next", card, next);

        InversePool p = new InversePool(WHYPE, address(this));
        vm.expectRevert(InversePool.BadPool.selector); // factory not approved yet
        p.addMarket(KALOS, 18, KALOS_WHYPE_100, bytes32(0));
        p.setFactory(V3_FACTORY, 1);
        vm.expectRevert(InversePool.LowCardinality.selector); // v1.1: 1 slot cannot carry the 900-s emergency TWAP
        p.addMarket(KALOS, 18, KALOS_WHYPE_100, bytes32(0));

        uint256 g = gasleft();
        vm.prank(address(0xC0FFEE));
        IPoolEly(KALOS_WHYPE_100).increaseObservationCardinalityNext(1000);
        console2.log("gas to grow KALOS/WHYPE to 1000 slots", g - gasleft());
        (, next) = _cardinality(KALOS_WHYPE_100);
        assertEq(next, 1000, "anyone can grow the oracle before listing");
        uint256 m = p.addMarket(KALOS, 18, KALOS_WHYPE_100, bytes32(0));
        (bool ok, uint256 px) = p.oraclePrice(m);
        console2.log("InversePool oraclePrice ok / wei of HYPE per KALOS", ok, px);
    }

    /// USDC/WHYPE would be the HYPE/USD anchor through the contract's TWAP path, but on 05.11.2026 it keeps
    /// one observation: observe([30,0]) answers only when the last swap is over 30 s old (it trades every
    /// ~18 s), so a v3 market listed before raising the cardinality fails keeper fills at random
    /// (OracleUnavailable). The KALOS pools trade every block and never answer. Logged, not asserted.
    function test_fork_usdc_anchor_needs_cardinality() public onlyFork {
        InversePool p = new InversePool(WHYPE, address(this));
        p.setFactory(V3_FACTORY, 1);
        IPoolEly(USDC_WHYPE).increaseObservationCardinalityNext(1000); // v1.1 listing rule
        uint256 m = p.addMarket(USDC, 6, USDC_WHYPE, bytes32(0));
        (bool ok, uint256 px) = p.oraclePrice(m);
        (uint16 card,) = _cardinality(USDC_WHYPE);
        console2.log("USDC/WHYPE cardinality", card);
        console2.log("USDC: oracle ok right now / wei of HYPE per 1 USDC", ok, px);
        if (ok) console2.log("  -> HYPE/USD on testnet", 1e18 / px);
    }

    /// Launchpad memecoins are v4 pools with native HYPE: no on-chain oracle, keeper price only (as on RH).
    /// A full deposit -> open -> close cycle in HYPE.
    function test_fork_v4_coin_trade_cycle() public onlyFork {
        assertGt(LAUNCHPAD_PM.code.length, 0);
        assertGt(RHSL.code.length, 0);
        InversePool p = new InversePool(WHYPE, address(this));
        uint256 m = p.addMarket(RHSL, 18, address(0), keccak256("RHSL launchpad pool"));
        vm.deal(address(this), 3_100 ether);
        p.addLiquidity{value: 3_000 ether}();
        p.deposit{value: 30.3 ether}();

        uint256 id = p.requestOpen(m, true, 5, 30 ether, 0, 0, address(0));
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 1);
        uint256 entry = 1e14; // keeper price: 0.0001 HYPE per RHSL
        p.executeOpen(id, entry, p.blockNumber(), 10, type(uint256).max);

        vm.warp(vm.getBlockTimestamp() + 11);
        p.requestClose(id);
        vm.roll(vm.getBlockNumber() + 1);
        p.executeClose(id, entry * 110 / 100, p.blockNumber(), InversePool.CloseReason.USER); // +10 % at 5x
        assertEq(uint8(p.getPosition(id).status), uint8(InversePool.Status.Closed));
        assertEq(p.accountingSurplus(), 0);
        console2.log("trader balance after +10% at 5x (HYPE wei)", p.balanceOf(address(this)));
        assertGt(p.balanceOf(address(this)), 30 ether);
    }
}
