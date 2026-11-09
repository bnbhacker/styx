// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {InverseBase} from "./Base.sol";
import {InversePool} from "../InversePool.sol";
import {MockV3Pool, MockV3Factory, MockCLFactory, MockArbSys} from "./Mocks.sol";

/// SPEC В§6: keeper price vs v3/Aero CL TWAP, pool verification.
contract OracleTest is InverseBase {
    MockV3Factory internal fac;
    MockCLFactory internal clf;
    MockV3Pool internal v3;
    uint256 internal m3;

    address internal constant TOKEN_LO = address(0x1100); // < WETH: token0
    address internal constant TOKEN_HI = address(0x9000); // > WETH: token1
    int24 internal constant TICK_P0 = -69082; // ~0.001 ETH per token
    int24 internal constant TICK_10PCT = 953; // 1.0001^953 ~ 1.1

    function setUp() public override {
        super.setUp();
        fac = new MockV3Factory();
        clf = new MockCLFactory();
        vm.startPrank(owner);
        pool.setFactory(address(fac), 1);
        pool.setFactory(address(clf), 2);
        vm.stopPrank();
        v3 = _v3(TOKEN_LO, 3000);
        v3.setTick(TICK_P0);
        vm.prank(keeper);
        m3 = pool.addMarket(TOKEN_LO, 18, address(v3), bytes32(0));
    }

    function _v3(address token, uint24 fee) internal returns (MockV3Pool p) {
        (address t0, address t1) = token < WETH ? (token, WETH) : (WETH, token);
        p = new MockV3Pool(t0, t1, address(fac), fee, 60);
        fac.setPool(t0, t1, fee, address(p));
    }

    function _twap(uint256 m) internal view returns (uint256 p) {
        bool ok;
        (ok, p) = pool.oraclePrice(m);
        assertTrue(ok, "oracle");
    }

    function _openV3(address who, bool isLong, uint8 lev, uint256 stake) internal returns (uint256 id) {
        id = _open(who, m3, isLong, lev, stake, _twap(m3));
    }

    function test_addMarket_verifies_pool() public {
        InversePool.Market memory m = pool.getMarket(m3);
        assertTrue(m.tokenIsToken0);
        assertEq(m.v3Pool, address(v3));
        assertEq(m.priceSource, bytes32(uint256(uint160(address(v3)))), "source defaults to the pool");

        address tok = address(0x1200);
        MockV3Factory other = new MockV3Factory();
        MockV3Pool rogue = new MockV3Pool(tok, WETH, address(other), 3000, 60);
        other.setPool(tok, WETH, 3000, address(rogue));
        MockV3Pool noWeth = new MockV3Pool(tok, address(0x1300), address(fac), 3000, 60);
        fac.setPool(tok, address(0x1300), 3000, address(noWeth));
        MockV3Pool fake = new MockV3Pool(tok, WETH, address(fac), 500, 10); // claims the factory, not registered

        vm.startPrank(keeper);
        vm.expectRevert(InversePool.BadPool.selector);
        pool.addMarket(tok, 18, address(rogue), 0); // factory not approved
        vm.expectRevert(InversePool.BadPool.selector);
        pool.addMarket(tok, 18, address(noWeth), 0); // not a WETH pair
        vm.expectRevert(InversePool.BadPool.selector);
        pool.addMarket(tok, 18, address(fake), 0); // factory does not know it
        vm.expectRevert(InversePool.BadPool.selector);
        pool.addMarket(address(0x1400), 18, address(v3), 0); // pool of another token
        vm.stopPrank();
        assertEq(pool.marketIdOf(tok), 0);
    }

    function test_cl_factory_keyed_by_tick_spacing() public {
        MockV3Pool cl = new MockV3Pool(WETH, TOKEN_HI, address(clf), 0, 100);
        clf.setPool(WETH, TOKEN_HI, 100, address(cl));
        vm.prank(keeper);
        uint256 m = pool.addMarket(TOKEN_HI, 18, address(cl), bytes32("aero"));
        assertFalse(pool.getMarket(m).tokenIsToken0);
        assertEq(pool.getMarket(m).priceSource, bytes32("aero"));

        // a fee-keyed factory registration does not stand in for a tickSpacing-keyed one
        MockV3Pool v3Like = new MockV3Pool(WETH, address(0x9100), address(clf), 100, 1);
        fac.setPool(WETH, address(0x9100), 100, address(v3Like));
        vm.prank(keeper);
        vm.expectRevert(InversePool.BadPool.selector);
        pool.addMarket(address(0x9100), 18, address(v3Like), 0);

        vm.prank(owner);
        vm.expectRevert(InversePool.BadParams.selector);
        pool.setFactory(address(clf), 3);
    }

    function test_twap_orientation_and_decimals() public {
        MockV3Pool hi = _v3(TOKEN_HI, 3000);
        vm.prank(keeper);
        uint256 mh = pool.addMarket(TOKEN_HI, 18, address(hi), 0);
        v3.setTick(0);
        hi.setTick(0);
        assertEq(_twap(m3), 1e18);
        assertEq(_twap(mh), 1e18);

        v3.setTick(6932); // token0: price = 1.0001^tick
        hi.setTick(-6932); // token1: price = 1 / 1.0001^tick
        assertApproxEqRel(_twap(m3), 2e18, 1e14);
        assertApproxEqRel(_twap(mh), 2e18, 1e14);

        address usd = address(0x9200);
        MockV3Pool u = _v3(usd, 500);
        u.setTick(-6932);
        vm.prank(keeper);
        uint256 mu = pool.addMarket(usd, 6, address(u), 0);
        assertApproxEqRel(_twap(mu), 2e6, 1e14, "price per whole 6-decimal token");
    }

    function test_twap_rounds_negative_ticks_down() public {
        MockV3Pool ref2 = _v3(address(0x1500), 3000);
        vm.prank(keeper);
        uint256 mr = pool.addMarket(address(0x1500), 18, address(ref2), 0);
        ref2.setTick(-2);
        uint256 atMinus2 = _twap(mr);
        v3.setRaw(0, -31); // mean tick -1.03 -> floor -2 (OracleLibrary rounding)
        assertEq(_twap(m3), atMinus2);
        v3.setRaw(0, 29); // 0.97 -> 0
        assertEq(_twap(m3), 1e18);
    }

    function test_keeper_price_within_3pct_of_twap() public {
        uint256 tw = _twap(m3);
        uint256 tol = tw * 300 / 10_000;
        _fund(alice, 1 ether);
        uint256 a = _request(alice, m3, true, 2, 0.1 ether);
        vm.roll(vm.getBlockNumber() + 1);
        vm.startPrank(keeper);
        vm.expectRevert(InversePool.PriceDeviation.selector);
        pool.executeOpen(a, tw + tol + 1, vm.getBlockNumber(), 10, MAX);
        vm.expectRevert(InversePool.PriceDeviation.selector);
        pool.executeOpen(a, tw - tol - 1, vm.getBlockNumber(), 10, MAX);
        vm.expectEmit(true, true, false, true);
        emit InversePool.PositionOpened(a, m3, tw + tol, vm.getBlockNumber(), bytes32(uint256(uint160(address(v3)))), tw, 0.2 ether);
        pool.executeOpen(a, tw + tol, vm.getBlockNumber(), 10, MAX);
        vm.stopPrank();
    }

    function test_close_checked_against_twap() public {
        uint256 id = _openV3(alice, true, 2, 1 ether);
        uint256 entry = pool.getPosition(id).entryPrice;
        v3.setTick(TICK_P0 + TICK_10PCT);
        vm.warp(vm.getBlockTimestamp() + 10);
        vm.prank(alice);
        pool.requestClose(id);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        vm.expectRevert(InversePool.PriceDeviation.selector); // stale price, pool moved 10 %
        pool.executeClose(id, entry, vm.getBlockNumber(), InversePool.CloseReason.USER);
        uint256 tw = _twap(m3);
        vm.prank(keeper);
        pool.executeClose(id, tw, vm.getBlockNumber(), InversePool.CloseReason.USER);
        assertApproxEqRel(pool.balanceOf(alice), _payout(1 ether, 0.2 ether), 0.001e18);
    }

    function test_oracle_unavailable_blocks_keeper_but_not_exits() public {
        uint256 id = _openV3(alice, true, 2, 1 ether);
        _fund(bob, 1 ether);
        uint256 pending = _request(bob, m3, true, 2, 0.1 ether);
        v3.setBroken(true);
        (bool ok,) = pool.oraclePrice(m3);
        assertFalse(ok);

        vm.roll(vm.getBlockNumber() + 1);
        vm.startPrank(keeper);
        vm.expectRevert(InversePool.OracleUnavailable.selector);
        pool.executeOpen(pending, P0, vm.getBlockNumber(), 10, MAX);
        vm.expectRevert(InversePool.OracleUnavailable.selector);
        pool.executeClose(id, P0, vm.getBlockNumber(), InversePool.CloseReason.CAP_LOSS);
        // the keeper can still unwind the market by disabling it
        pool.setMarketEnabled(m3, false);
        pool.executeClose(id, 0, 0, InversePool.CloseReason.POOL_GONE);
        vm.stopPrank();
        assertEq(uint8(_status(id)), uint8(InversePool.Status.Closed));
    }

    function test_emergency_close_uses_twap() public {
        uint256 id = _openV3(alice, true, 2, 1 ether);
        v3.setTick(TICK_P0 + TICK_10PCT);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        pool.emergencyClose(id);
        assertApproxEqRel(pool.balanceOf(alice), _payout(1 ether, 0.2 ether), 0.001e18);
    }

    /// v1.1: a v3 market's emergency close waits for its 900-s TWAP instead of falling back to lastPrice
    /// (a 30-s / last price is cheap to hold off for a manipulator). It retries fine once observe() answers.
    function test_emergency_close_v3_needs_the_long_twap() public {
        uint256 id = _openV3(alice, true, 2, 1 ether);
        v3.setTick(TICK_P0 + TICK_10PCT);
        v3.setBroken(true);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.expectRevert(InversePool.OracleUnavailable.selector);
        pool.emergencyClose(id);
        v3.setBroken(false);
        pool.emergencyClose(id);
        assertApproxEqRel(pool.balanceOf(alice), _payout(1 ether, 0.2 ether), 0.001e18);
    }

    /// v1.1: listing a v3 pool needs observationCardinalityNext > emergencyTwapWindow (one slot per second).
    function test_addMarket_needs_cardinality_for_emergency_twap() public {
        MockV3Pool thin = _v3(TOKEN_HI, 500);
        thin.setTick(-TICK_P0);
        thin.setCardinalityNext(900);
        vm.prank(keeper);
        vm.expectRevert(InversePool.LowCardinality.selector);
        pool.addMarket(TOKEN_HI, 18, address(thin), bytes32(0));
        thin.setCardinalityNext(901); // what anyone gets by calling increaseObservationCardinalityNext
        vm.prank(keeper);
        pool.addMarket(TOKEN_HI, 18, address(thin), bytes32(0));
    }

    function test_only_owner_drops_the_twap_check() public {
        MockV3Pool alt = _v3(TOKEN_LO, 500);
        alt.setTick(TICK_P0);
        vm.startPrank(keeper);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.setMarketSource(m3, address(0), bytes32("v4:x"));
        pool.setMarketSource(m3, address(alt), 0); // swap to another verified pool is fine
        vm.stopPrank();
        assertEq(pool.getMarket(m3).v3Pool, address(alt));

        vm.prank(owner);
        pool.setMarketSource(m3, address(0), bytes32("v4:x"));
        (bool ok, uint256 p) = pool.oraclePrice(m3);
        assertFalse(ok);
        assertEq(p, 0);
        vm.prank(stranger);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.setMarketSource(m3, address(alt), 0);
    }

    function test_v4_market_has_no_oracle_but_rejects_absurd_prices() public {
        (bool ok,) = pool.oraclePrice(mid);
        assertFalse(ok);
        _fund(alice, 1 ether);
        uint256 a = _request(alice, mid, true, 2, 0.1 ether);
        vm.roll(vm.getBlockNumber() + 1);
        vm.startPrank(keeper);
        vm.expectRevert(InversePool.BadPrice.selector);
        pool.executeOpen(a, 0, vm.getBlockNumber(), 10, MAX);
        vm.expectRevert(InversePool.BadPrice.selector);
        pool.executeOpen(a, uint256(type(uint128).max) + 1, vm.getBlockNumber(), 10, MAX);
        pool.executeOpen(a, 12_345, vm.getBlockNumber(), 10, MAX);
        vm.stopPrank();
    }

    function testFuzz_twap_monotonic_in_tick(int24 a, int24 b) public {
        a = int24(bound(a, -400_000, 400_000));
        b = int24(bound(b, -400_000, 400_000));
        if (a > b) (a, b) = (b, a);
        MockV3Pool hi = _v3(TOKEN_HI, 3000);
        vm.prank(keeper);
        uint256 mh = pool.addMarket(TOKEN_HI, 18, address(hi), 0);
        v3.setTick(a);
        hi.setTick(a);
        (, uint256 loA) = pool.oraclePrice(m3);
        (, uint256 hiA) = pool.oraclePrice(mh);
        v3.setTick(b);
        hi.setTick(b);
        (, uint256 loB) = pool.oraclePrice(m3);
        (, uint256 hiB) = pool.oraclePrice(mh);
        assertLe(loA, loB, "token0: price rises with tick");
        assertGe(hiA, hiB, "token1: price falls with tick");
    }
}

/// On Nitro vm.getBlockNumber() is the parent-chain block: request/price blocks must come from ArbSys.
contract ArbSysTest is Test {
    address internal keeper = makeAddr("keeper");

    function test_block_numbers_come_from_arbsys() public {
        vm.etch(address(100), address(new MockArbSys()).code);
        MockArbSys arb = MockArbSys(address(100));
        arb.set(90_000_000);

        InversePool p = new InversePool(address(0x5000), keeper);
        assertTrue(p.USE_ARBSYS());
        assertEq(p.blockNumber(), 90_000_000);

        vm.prank(keeper);
        uint256 m = p.addMarket(address(0x1000), 18, address(0), 0);
        vm.deal(address(this), 101 ether);
        p.addLiquidity{value: 100 ether}();
        p.deposit{value: 1 ether}();
        uint256 id = p.requestOpen(m, true, 2, 0.1 ether, 0, 0, address(0));
        assertEq(p.getPosition(id).requestBlock, 90_000_000);

        // vm.getBlockNumber() (parent chain) moves, the L2 block does not: still no fill
        vm.roll(vm.getBlockNumber() + 100);
        vm.prank(keeper);
        vm.expectRevert(InversePool.BadPriceBlock.selector);
        p.executeOpen(id, 1e15, 90_000_001, 10, type(uint256).max);

        arb.set(90_000_001);
        vm.prank(keeper);
        p.executeOpen(id, 1e15, 90_000_001, 10, type(uint256).max);
        assertEq(p.getPosition(id).entryBlock, 90_000_001);
    }

    function test_falls_back_to_block_number_off_nitro() public {
        assertEq(address(100).code.length, 0);
        InversePool p = new InversePool(address(0x5000), keeper);
        assertFalse(p.USE_ARBSYS());
        vm.roll(777);
        assertEq(p.blockNumber(), 777);
    }

    /// Bug fix: a fork of RH (anvil/forge) keeps 0x64's 0xfe placeholder without the precompile behind it;
    /// the uncapped probe burned 63/64 of the deploy gas there.
    function test_deploy_on_fork_without_precompile_is_cheap() public {
        vm.etch(address(100), hex"fe");
        uint256 g = gasleft();
        InversePool p = new InversePool(address(0x5000), keeper);
        assertLt(g - gasleft(), 6_000_000); // ~5.2M is the deploy itself; the uncapped probe burned ~1e9
        assertFalse(p.USE_ARBSYS());
    }

    function test_constructor_rejects_zero_weth() public {
        vm.expectRevert(InversePool.BadParams.selector);
        new InversePool(address(0), keeper);
    }
}

/// Roles, parameters, prize pot and ops.
contract AdminTest is InverseBase {
    function test_ownership_two_step() public {
        vm.prank(stranger);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.transferOwnership(stranger);
        vm.prank(owner);
        pool.transferOwnership(alice);
        assertEq(pool.owner(), owner);
        assertEq(pool.pendingOwner(), alice);
        vm.prank(bob);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.acceptOwnership();
        vm.prank(alice);
        pool.acceptOwnership();
        assertEq(pool.owner(), alice);
        assertEq(pool.pendingOwner(), address(0));
    }

    function test_owner_only() public {
        InversePool.Params memory p = pool.getParams();
        address[] memory w = new address[](0);
        uint256[] memory a = new uint256[](0);
        address[2] memory notOwner = [stranger, keeper];
        for (uint256 i; i < 2; ++i) {
            vm.startPrank(notOwner[i]);
            vm.expectRevert(InversePool.Unauthorized.selector);
            pool.setKeeper(stranger, true);
            vm.expectRevert(InversePool.Unauthorized.selector);
            pool.setFactory(stranger, 1);
            vm.expectRevert(InversePool.Unauthorized.selector);
            pool.setParams(p);
            vm.expectRevert(InversePool.Unauthorized.selector);
            pool.setPaused(true);
            vm.expectRevert(InversePool.Unauthorized.selector);
            pool.clearLossPause();
            vm.expectRevert(InversePool.Unauthorized.selector);
            pool.distributePrizes(w, a);
            vm.expectRevert(InversePool.Unauthorized.selector);
            pool.withdrawOps(payable(stranger), 0);
            vm.stopPrank();
        }
    }

    function test_market_admin() public {
        vm.startPrank(stranger);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.addMarket(address(0x7777), 18, address(0), 0);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.setMarketEnabled(mid, false);
        vm.stopPrank();

        vm.startPrank(keeper);
        vm.expectRevert(InversePool.BadMarket.selector);
        pool.addMarket(TOKEN, 18, address(0), 0); // duplicate
        vm.expectRevert(InversePool.BadMarket.selector);
        pool.addMarket(WETH, 18, address(0), 0);
        vm.expectRevert(InversePool.BadMarket.selector);
        pool.addMarket(address(0), 18, address(0), 0);
        vm.expectRevert(InversePool.BadMarket.selector);
        pool.addMarket(address(0x7777), 37, address(0), 0);
        vm.expectRevert(InversePool.UnknownMarket.selector);
        pool.setMarketEnabled(99, false);
        vm.stopPrank();

        vm.prank(owner);
        pool.setKeeper(keeper, false);
        vm.prank(keeper);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.addMarket(address(0x7777), 18, address(0), 0);
    }

    function _expectBad(InversePool.Params memory p) internal {
        vm.prank(owner);
        vm.expectRevert(InversePool.BadParams.selector);
        pool.setParams(p);
    }

    function test_setParams_bounds() public {
        InversePool.Params memory d = pool.getParams();
        InversePool.Params memory p;
        p = pool.getParams(); p.minStake = 0; _expectBad(p);
        p = pool.getParams(); p.openFeeBps = 501; _expectBad(p);
        p = pool.getParams(); p.closeFeeBps = 501; _expectBad(p);
        p = pool.getParams(); p.referrerBps = 5000; p.prizeBps = 5000; p.opsBps = 1; _expectBad(p);
        p = pool.getParams(); p.maxWinBps = 0; _expectBad(p);
        p = pool.getParams(); p.maxWinBps = 100_001; _expectBad(p);
        p = pool.getParams(); p.rugCapBps = d.maxWinBps + 1; _expectBad(p);
        p = pool.getParams(); p.rugDropBps = 0; _expectBad(p);
        p = pool.getParams(); p.rugDropBps = 10_000; _expectBad(p);
        p = pool.getParams(); p.rugWindowBlocks = 0; _expectBad(p);
        p = pool.getParams(); p.rugLock = 1 days + 1; _expectBad(p);
        p = pool.getParams(); p.marketLiabilityBps = d.totalLiabilityBps + 1; _expectBad(p);
        p = pool.getParams(); p.totalLiabilityBps = 10_001; p.marketLiabilityBps = 500; _expectBad(p);
        p = pool.getParams(); p.twapWindow = 0; _expectBad(p);
        p = pool.getParams(); p.twapWindow = 1 hours + 1; _expectBad(p);
        p = pool.getParams(); p.twapToleranceBps = 2001; _expectBad(p);
        p = pool.getParams(); p.maxPriceAgeBlocks = 0; _expectBad(p);
        p = pool.getParams(); p.minHold = 1 hours + 1; _expectBad(p);
        p = pool.getParams(); p.cancelDelay = 1 hours + 1; _expectBad(p);
        p = pool.getParams(); p.removeDelay = 7 days + 1; _expectBad(p);
        p = pool.getParams(); p.removeWindow = 1 hours - 1; _expectBad(p);
        p = pool.getParams(); p.removeWindow = 7 days + 1; _expectBad(p);
        p = pool.getParams(); p.emergencyDelay = 1 hours - 1; _expectBad(p);
        p = pool.getParams(); p.emergencyDelay = 7 days + 1; _expectBad(p);
        p = pool.getParams(); p.lpEmergencyDelay = 30 days + 1; _expectBad(p);
        p = pool.getParams(); p.reportMaxAge = 0; _expectBad(p);
        p = pool.getParams(); p.reportMaxAge = 1 days + 1; _expectBad(p);
        p = pool.getParams(); p.pauseWindow = 0; _expectBad(p);
        p = pool.getParams(); p.pauseWindow = 1 days + 1; _expectBad(p);
        p = pool.getParams(); p.pauseDuration = 7 days + 1; _expectBad(p);
        p = pool.getParams(); p.pauseLossBps = 10_001; _expectBad(p);

        p = pool.getParams();
        p.minStake = 0.01 ether;
        vm.prank(owner);
        pool.setParams(p);
        assertEq(pool.getParams().minStake, 0.01 ether);
    }

    function test_defaults_match_spec() public view {
        InversePool.Params memory p = pool.getParams();
        assertEq(p.minStake, 0.001 ether);
        assertEq(p.openFeeBps, 100);
        assertEq(p.closeFeeBps, 100);
        assertEq(p.referrerBps + p.prizeBps + p.opsBps, 2500); // pool keeps 75 %
        assertEq(p.maxWinBps, 20_000);
        assertEq(p.rugCapBps, 2000);
        assertEq(p.rugDropBps, 8000);
        assertEq(p.rugLock, 1 hours);
        assertEq(p.minHold, 10);
        assertEq(p.cancelDelay, 60);
        assertEq(p.marketLiabilityBps, 500);
        assertEq(p.totalLiabilityBps, 5000);
        assertEq(p.twapWindow, 30);
        assertEq(p.twapToleranceBps, 300);
        assertEq(p.removeDelay, 24 hours);
        assertEq(p.emergencyDelay, 24 hours);
        assertEq(p.lpEmergencyDelay, 7 days);
        assertEq(p.pauseLossBps, 1000);
        assertEq(p.pauseWindow, 1 hours);
        // block windows sized for RH Chain's ~9.6 blocks/s
        assertEq(p.rugWindowBlocks, 300);
        assertEq(p.maxPriceAgeBlocks, 600);
    }

    function test_prize_pot_and_ops() public {
        for (uint256 i; i < 3; ++i) {
            uint256 id = _open(alice, mid, true, 2, 1 ether, P0);
            _closeUser(id, P0);
        }
        uint256 prize = pool.prizePool();
        uint256 ops = pool.opsBalance();
        assertGt(prize, 0);
        assertGt(ops, 0);

        address[] memory w = new address[](2);
        uint256[] memory a = new uint256[](2);
        w[0] = bob;
        w[1] = ref;
        a[0] = prize / 2;
        a[1] = prize - prize / 2 + 1;
        vm.startPrank(owner);
        vm.expectRevert(InversePool.InsufficientBalance.selector);
        pool.distributePrizes(w, a);
        a[1] -= 1;
        pool.distributePrizes(w, a);
        assertEq(pool.prizePool(), 0);
        assertEq(pool.balanceOf(bob) + pool.balanceOf(ref), prize);

        w[0] = address(0);
        vm.expectRevert(InversePool.BadParams.selector);
        pool.distributePrizes(w, a);
        vm.expectRevert(InversePool.BadParams.selector);
        pool.distributePrizes(w, new uint256[](1));

        // v1.1: ops go only to a keeper or the treasury
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.withdrawOps(payable(stranger), 1);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.withdrawOps(payable(address(0)), 1); // treasury unset (0) is not a destination
        pool.setRoles(address(0), stranger, address(0), address(0));
        vm.expectRevert(InversePool.InsufficientBalance.selector);
        pool.withdrawOps(payable(stranger), ops + 1);
        pool.withdrawOps(payable(stranger), ops - 1);
        pool.withdrawOps(payable(keeper), 1);
        vm.stopPrank();
        assertEq(stranger.balance, ops - 1);
        assertEq(keeper.balance, 1);
        _assertBooks();
    }
}

/// SPEC В§4 under fuzzing: payout always matches the clamped formula and the books balance.
contract SettleFuzzTest is InverseBase {
    function testFuzz_close_matches_formula(bool isLong, uint8 levSeed, uint256 stake, uint256 exit) public {
        uint8[3] memory levs = [uint8(2), 5, 10];
        uint8 lev = levs[levSeed % 3];
        stake = bound(stake, 0.001 ether, 2.5 ether);
        exit = bound(exit, 1, P0 * 100);
        _report(0);
        uint256 id = _open(alice, mid, isLong, lev, stake, P0);

        uint256 diff = exit >= P0 ? exit - P0 : P0 - exit;
        uint256 mag = stake * lev * diff / P0;
        bool gain = (exit >= P0) == isLong && mag != 0;
        int256 pnl = gain ? int256(mag > 2 * stake ? 2 * stake : mag) : -int256(mag > stake ? stake : mag);

        (int256 previewPnl, uint256 previewPayout,) = pool.previewClose(id, exit);
        _closeUser(id, exit);
        assertEq(previewPnl, pnl);
        assertEq(pool.balanceOf(alice), _payout(stake, pnl));
        assertEq(previewPayout, _payout(stake, pnl));
        assertLe(pool.balanceOf(alice), stake * 3);
        _assertBooks();
    }
}
