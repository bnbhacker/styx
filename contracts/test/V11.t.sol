// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InverseBase} from "./Base.sol";
import {InversePool, IPriceSource} from "../InversePool.sol";
import {V4SpotSource} from "../V4SpotSource.sol";
import {MockV3Pool, MockV3Factory} from "./Mocks.sol";

/// @dev Uniswap v4 PoolManager storage, as far as extsload goes.
contract MockPoolManager {
    mapping(bytes32 => bytes32) public slots;

    function set(bytes32 slot, bytes32 value) external {
        slots[slot] = value;
    }

    function extsload(bytes32 slot) external view returns (bytes32) {
        return slots[slot];
    }
}

/// @dev Adapter that books a fixed price, or refuses.
contract FixedAdapter is IPriceSource {
    uint256 public px;
    bool public refuse;

    function set(uint256 p, bool r) external {
        px = p;
        refuse = r;
    }

    function quote(uint256, uint256, bool, bool, uint8) external view returns (uint256, uint256) {
        require(!refuse, "refused");
        return (px, px);
    }
}

/// @dev Elysium parameters from STYX-ELYSIUM.md §3.3 on top of the shared fixture.
abstract contract ElysiumBase is InverseBase {
    function setUp() public virtual override {
        super.setUp();
        InversePool.Params memory p = pool.getParams();
        p.cancelDelay = 10;
        p.maxPriceAgeBlocks = 50;
        p.rugWindowBlocks = 280;
        p.minExecDelayBlocks = 1;
        p.maxExecDelayBlocks = 20;
        p.keeperBlockRate = 7200; // 2 blocks/s in these tests; the deploy sets a lower floor
        vm.prank(owner);
        pool.setParams(p);
    }
}

/// v1.1 P0-1: the price of an open / USER close comes from [B+1, B+20].
contract WindowTest is ElysiumBase {
    function test_open_window() public {
        _fund(alice, 1.01 ether);
        uint256 id = _request(alice, mid, true, 2, 1 ether);
        uint256 b = pool.getPosition(id).requestBlock;
        vm.roll(b + 25);
        vm.startPrank(keeper);
        vm.expectRevert(InversePool.BadPriceBlock.selector);
        pool.executeOpen(id, P0, b, 10, MAX); // the request block itself
        vm.expectRevert(InversePool.BadPriceBlock.selector);
        pool.executeOpen(id, P0, b + 21, 10, MAX); // past the window
        vm.expectRevert(InversePool.BadPriceBlock.selector);
        pool.executeOpen(id, P0, b + 26, 10, MAX); // from the future
        pool.executeOpen(id, P0, b + 20, 10, MAX);
        vm.stopPrank();
        assertEq(pool.getPosition(id).entryBlock, b + 20);
    }

    function test_open_window_also_needs_a_fresh_price() public {
        _fund(alice, 1.01 ether);
        uint256 id = _request(alice, mid, true, 2, 1 ether);
        uint256 b = pool.getPosition(id).requestBlock;
        vm.roll(b + 1 + 51); // price block in the window, but 51 blocks old
        vm.prank(keeper);
        vm.expectRevert(InversePool.BadPriceBlock.selector);
        pool.executeOpen(id, P0, b + 1, 10, MAX);
    }

    function test_missed_window_means_reject_or_cancel() public {
        _fund(alice, 1.01 ether);
        uint256 id = _request(alice, mid, true, 2, 1 ether);
        vm.roll(vm.getBlockNumber() + 100);
        vm.warp(vm.getBlockTimestamp() + 10);
        vm.prank(alice);
        pool.cancelRequest(id); // 10 s cancelDelay on Elysium
        assertEq(pool.balanceOf(alice), 1.01 ether);
        _assertBooks();
    }

    function test_user_close_window() public {
        uint256 id = _open(alice, mid, true, 2, 1 ether, P0);
        vm.warp(vm.getBlockTimestamp() + 10);
        vm.prank(alice);
        pool.requestClose(id);
        uint256 b = pool.getPosition(id).requestBlock;
        vm.roll(b + 22);
        vm.startPrank(keeper);
        vm.expectRevert(InversePool.BadPriceBlock.selector);
        pool.executeClose(id, P0, b + 21, InversePool.CloseReason.USER);
        pool.executeClose(id, P0, b + 20, InversePool.CloseReason.USER);
        vm.stopPrank();
        assertEq(uint8(_status(id)), uint8(InversePool.Status.Closed));
    }

    function test_defensive_close_is_not_windowed_only_fresh() public {
        uint256 id = _openTpSl(alice, true, 2, 1 ether, 0, P0 * 9 / 10);
        vm.roll(vm.getBlockNumber() + 200); // long after any window
        vm.startPrank(keeper);
        vm.expectRevert(InversePool.BadPriceBlock.selector);
        pool.executeClose(id, P0 * 9 / 10, vm.getBlockNumber() - 51, InversePool.CloseReason.SL);
        pool.executeClose(id, P0 * 9 / 10, vm.getBlockNumber() - 50, InversePool.CloseReason.SL);
        vm.stopPrank();
    }

    function test_setParams_bounds_v11() public {
        InversePool.Params memory p = pool.getParams();
        p.minExecDelayBlocks = 0;
        _bad(p);
        p = pool.getParams();
        p.maxExecDelayBlocks = 0;
        _bad(p);
        p = pool.getParams();
        p.maxExecDelayBlocks = 100_001;
        _bad(p);
        p = pool.getParams();
        p.keeperBlockRate = 360_001;
        _bad(p);
        p = pool.getParams();
        p.emergencyTwapWindow = p.twapWindow - 1;
        _bad(p);
        p = pool.getParams();
        p.emergencyTwapWindow = 1 hours + 1;
        _bad(p);
    }

    function _bad(InversePool.Params memory p) internal {
        vm.prank(owner);
        vm.expectRevert(InversePool.BadParams.selector);
        pool.setParams(p);
    }

    function test_constructor_defaults_keep_v1_behaviour() public {
        InversePool fresh = new InversePool(WETH, keeper);
        InversePool.Params memory p = fresh.getParams();
        assertEq(p.minExecDelayBlocks, 1);
        assertEq(p.maxExecDelayBlocks, 600);
        assertEq(p.notionalCapMax, 0);
        assertEq(p.keeperBlockRate, 0);
        assertEq(p.emergencyTwapWindow, 900);
        assertEq(p.maxPoolCash, 0);
    }
}

/// v1.1 P0-2: a ceiling over the keeper, and a guardian that can only stop.
contract CeilingTest is ElysiumBase {
    function test_notional_cap_max_clamps_the_keeper() public {
        InversePool.Params memory p = pool.getParams();
        p.notionalCapMax = 3 ether;
        vm.prank(owner);
        pool.setParams(p);
        _fund(alice, 1.01 ether);
        uint256 id = _request(alice, mid, true, 5, 1 ether); // 5 ether notional
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        vm.expectRevert(InversePool.NotionalCap.selector);
        pool.executeOpen(id, P0, vm.getBlockNumber(), 10, MAX); // keeper says "no cap"
        _fund(bob, 0.303 ether);
        uint256 ok = _request(bob, mid, true, 10, 0.3 ether); // 3 ether notional fits
        _fill(ok, P0);
        assertEq(uint8(_status(ok)), uint8(InversePool.Status.Open));
    }

    function test_guardian_only_pauses() public {
        address g = makeAddr("guardian");
        vm.prank(owner);
        pool.setRoles(g, address(0), address(0), address(0));
        vm.prank(g);
        pool.setPaused(true);
        assertTrue(pool.paused());
        vm.prank(g);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.setPaused(false);
        vm.prank(stranger);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.setPaused(true);
        vm.prank(owner);
        pool.setPaused(false);
        assertFalse(pool.paused());
    }

    /// review 06.11: flagRug no longer writes lastPrice, so flagRug + POOL_GONE settles at the last real fill.
    function test_flagRug_does_not_set_the_settlement_price() public {
        uint256 id = _open(alice, mid, true, 2, 1 ether, P0);
        vm.roll(vm.getBlockNumber() + 1);
        uint256 bn = vm.getBlockNumber();
        vm.startPrank(keeper);
        pool.flagRug(mid, 50 * P0, bn - 1, 10 * P0, bn); // forged "rug" from 50x to 10x
        assertEq(pool.getMarket(mid).lastPrice, P0, "lastPrice untouched");
        pool.setMarketEnabled(mid, false);
        pool.executeClose(id, 0, 0, InversePool.CloseReason.POOL_GONE);
        vm.stopPrank();
        assertEq(pool.balanceOf(alice), _payout(1 ether, 0), "settled at the entry fill, not at 10x");
        _assertBooks();
    }

    /// review 06.11: a keeper cannot trade the default band for a v3 pool of its own (or the reverse).
    function test_keeper_cannot_switch_between_band_and_twap() public {
        MockV3Factory fac = new MockV3Factory();
        MockV3Pool dust = new MockV3Pool(TOKEN, WETH, address(fac), 3000, 60);
        fac.setPool(TOKEN, WETH, 3000, address(dust));
        vm.prank(owner);
        pool.setFactory(address(fac), 1);
        vm.prank(keeper);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.setMarketSource(mid, address(dust), bytes32(0));
        vm.prank(owner);
        pool.setMarketSource(mid, address(dust), bytes32(0)); // the owner may
        assertEq(pool.getMarket(mid).v3Pool, address(dust));
    }

    function test_roles_only_owner() public {
        vm.startPrank(keeper);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.setRoles(keeper, keeper, keeper, keeper);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.setPriceAdapter(mid, keeper);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.setLpAllowed(address(0), true);
        vm.stopPrank();
    }
}

/// v1.1 P0-5: keeper silence counts on two clocks, so a sequencer stall is not keeper silence.
contract DualClockTest is ElysiumBase {
    function test_sequencer_stall_does_not_open_emergency() public {
        uint256 id = _open(alice, mid, true, 2, 1 ether, P0);
        vm.warp(vm.getBlockTimestamp() + 24 hours); // the clock jumps, almost no blocks were made
        vm.roll(vm.getBlockNumber() + 10);
        vm.expectRevert(InversePool.KeeperAlive.selector);
        pool.emergencyClose(id);
        vm.roll(vm.getBlockNumber() + 24 hours * 2); // the chain then really runs for a day without the keeper
        pool.emergencyClose(id);
        assertEq(uint8(_status(id)), uint8(InversePool.Status.Closed));
        _assertBooks();
    }

    function test_keeper_action_resets_both_clocks() public {
        uint256 id = _open(alice, mid, true, 2, 1 ether, P0);
        vm.roll(vm.getBlockNumber() + 24 hours * 2);
        vm.warp(vm.getBlockTimestamp() + 24 hours - 1);
        _report(0); // keeper alive at the last second
        vm.roll(vm.getBlockNumber() + 24 hours * 2 - 1);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.expectRevert(InversePool.KeeperAlive.selector);
        pool.emergencyClose(id); // a block short of the second clock
        vm.roll(vm.getBlockNumber() + 1);
        pool.emergencyClose(id);
    }

    function test_lp_emergency_exit_needs_both_clocks() public {
        uint256 half = pool.sharesOf(lp) / 2;
        vm.prank(lp);
        uint256 rid = pool.requestRemove(half);
        vm.warp(vm.getBlockTimestamp() + 7 days); // stall: past the delay window, keeper "silent" by time only
        vm.prank(lp);
        vm.expectRevert(InversePool.RemoveExpired.selector);
        pool.executeRemove(rid);
        vm.roll(vm.getBlockNumber() + 7 days * 2);
        vm.prank(lp);
        pool.executeRemove(rid);
        _assertBooks();
    }
}

/// v1.1 P0-6/7/8: rebates, surplus, ops destination, guarded launch.
contract MoneyV11Test is ElysiumBase {
    function test_rebate_goes_to_the_prize_pot() public {
        address src = makeAddr("rebate");
        vm.prank(owner);
        pool.setRoles(address(0), address(0), src, address(0));
        vm.deal(src, 1 ether);
        vm.prank(src);
        (bool ok,) = address(pool).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(pool.prizePool(), 1 ether);
        assertEq(pool.balanceOf(src), 0);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (ok,) = address(pool).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(pool.balanceOf(alice), 1 ether, "everyone else still deposits");
        _assertBooks();
    }

    function test_sweep_surplus() public {
        vm.expectRevert(InversePool.ZeroAmount.selector);
        pool.sweepSurplus();
        vm.deal(address(pool), address(pool).balance + 0.5 ether); // forced send (selfdestruct, coinbase...)
        assertEq(pool.accountingSurplus(), 0.5 ether);
        vm.prank(stranger);
        pool.sweepSurplus();
        assertEq(pool.prizePool(), 0.5 ether);
        _assertBooks();
    }

    function test_lp_gate_and_cap() public {
        vm.startPrank(owner);
        pool.setLpAllowed(address(0), true); // gate on
        pool.setLpAllowed(bob, true);
        InversePool.Params memory p = pool.getParams();
        p.maxPoolCash = SEED + 5 ether;
        pool.setParams(p);
        vm.stopPrank();
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.addLiquidity{value: 1 ether}();
        vm.deal(bob, 10 ether);
        vm.prank(bob);
        vm.expectRevert(InversePool.PoolCap.selector);
        pool.addLiquidity{value: 6 ether}();
        vm.prank(bob);
        pool.addLiquidity{value: 5 ether}();
        vm.prank(owner);
        pool.setLpAllowed(address(0), false); // gate off: anyone, still under the cap
        vm.prank(stranger);
        vm.expectRevert(InversePool.PoolCap.selector);
        pool.addLiquidity{value: 1 ether}();
    }
}

/// v1.1 P0-3: price adapters (per market, and the default for markets without a v3 pool).
contract AdapterTest is ElysiumBase {
    FixedAdapter internal fa;

    function setUp() public override {
        super.setUp();
        fa = new FixedAdapter();
    }

    function test_market_adapter_sets_the_fill() public {
        fa.set(2 * P0, false);
        vm.prank(owner);
        pool.setPriceAdapter(mid, address(fa));
        uint256 id = _open(alice, mid, true, 2, 1 ether, P0);
        assertEq(pool.getPosition(id).entryPrice, 2 * P0, "adapter price booked, keeper price ignored");
    }

    function test_adapter_refusal_blocks_the_fill_not_the_exit() public {
        vm.prank(owner);
        pool.setRoles(address(0), address(0), address(0), address(fa));
        fa.set(P0, false);
        uint256 id = _open(alice, mid, true, 2, 1 ether, P0);
        fa.set(P0, true);
        vm.warp(vm.getBlockTimestamp() + 10);
        vm.prank(alice);
        pool.requestClose(id);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        vm.expectRevert(bytes("refused"));
        pool.executeClose(id, P0, vm.getBlockNumber(), InversePool.CloseReason.USER);
        // the trader is not stuck: the pending close reverts to Open, and emergencyClose ignores adapters
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.roll(vm.getBlockNumber() + 24 hours * 2);
        pool.emergencyClose(id);
        assertEq(uint8(_status(id)), uint8(InversePool.Status.Closed));
    }

    function test_default_adapter_skips_v3_markets() public {
        MockV3Factory fac = new MockV3Factory();
        address tok = address(0x1100);
        MockV3Pool v3 = new MockV3Pool(tok, WETH, address(fac), 3000, 60);
        fac.setPool(tok, WETH, 3000, address(v3));
        v3.setTick(-69082);
        vm.prank(owner);
        pool.setFactory(address(fac), 1);
        vm.prank(keeper);
        uint256 m3 = pool.addMarket(tok, 18, address(v3), bytes32(0));
        fa.set(P0, true); // would refuse everything
        vm.prank(owner);
        pool.setRoles(address(0), address(0), address(0), address(fa));
        (, uint256 twap) = pool.oraclePrice(m3);
        uint256 id = _open(alice, m3, true, 2, 1 ether, twap); // v3 market: TWAP check, no default adapter
        assertEq(uint8(_status(id)), uint8(InversePool.Status.Open));
    }
}

/// V4SpotSource: the band, the feed checks, the spot math.
contract V4SpotSourceTest is ElysiumBase {
    MockPoolManager internal pm;
    V4SpotSource internal src;
    address internal constant HOOK = address(0xA0C);

    function setUp() public override {
        super.setUp();
        pm = new MockPoolManager();
        src = new V4SpotSource(pool);
        vm.startPrank(owner);
        src.setHookAllowed(address(pm), HOOK, true);
        pool.setRoles(address(0), address(0), address(0), address(src));
        vm.stopPrank();
    }

    function _key(address c0, address c1, uint24 fee, address hooks) internal pure returns (V4SpotSource.PoolKey memory) {
        return V4SpotSource.PoolKey(c0, c1, fee, 60, hooks);
    }

    function _sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x;
        uint256 y = (x + 1) / 2;
        while (y < z) {
            z = y;
            y = (x / y + y) / 2;
        }
    }

    /// @dev Native HYPE is currency0, TOKEN currency1: pool price = TOKEN per HYPE = 1e18 / p.
    function _setSpot(V4SpotSource.PoolKey memory k, uint256 p) internal {
        uint256 s = _sqrt((uint256(1e18) << 192) / p);
        bytes32 id = keccak256(abi.encode(k));
        pm.set(keccak256(abi.encode(id, uint256(6))), bytes32(s));
    }

    function _feed(uint256 p) internal returns (V4SpotSource.PoolKey memory k) {
        k = _key(address(0), TOKEN, 10_000, HOOK);
        _setSpot(k, p);
        vm.prank(keeper);
        src.setFeed(mid, address(pm), k);
    }

    function test_spot_math() public {
        _feed(P0);
        assertApproxEqRel(src.spot(mid), P0, 1e9); // 1e-9 relative
    }

    function test_feed_checks() public {
        V4SpotSource.PoolKey memory k = _key(address(0), TOKEN, 10_000, HOOK);
        _setSpot(k, P0);
        vm.prank(stranger);
        vm.expectRevert(V4SpotSource.Unauthorized.selector);
        src.setFeed(mid, address(pm), k);
        vm.startPrank(keeper);
        vm.expectRevert(V4SpotSource.BadKey.selector); // hook not allowed
        src.setFeed(mid, address(pm), _key(address(0), TOKEN, 10_000, address(0xBAD)));
        vm.expectRevert(V4SpotSource.BadKey.selector); // someone else's token
        src.setFeed(mid, address(pm), _key(address(0), address(0x4444), 10_000, HOOK));
        vm.expectRevert(V4SpotSource.NoSpot.selector); // pool does not exist
        src.setFeed(mid, address(pm), _key(address(0), TOKEN, 3000, HOOK));
        // launchpad pools declare fee 0 (the hook takes it): accepted, the hook allowlist is the gate
        V4SpotSource.PoolKey memory zeroFee = _key(address(0), TOKEN, 0, HOOK);
        _setSpot(zeroFee, P0);
        src.setFeed(mid, address(pm), zeroFee);
        vm.expectRevert(V4SpotSource.Unauthorized.selector); // the first feed is the keeper's; re-pointing is not
        src.setFeed(mid, address(pm), k);
        vm.stopPrank();
        (address manager, bytes32 id,,) = src.feeds(mid);
        assertEq(manager, address(pm));
        assertEq(id, keccak256(abi.encode(zeroFee)));
    }

    /// review 06.11: a keeper sets the first feed; only the owner re-points a live one.
    function test_keeper_cannot_repoint_a_live_feed() public {
        _feed(P0);
        V4SpotSource.PoolKey memory other = _key(address(0), TOKEN, 3000, HOOK);
        _setSpot(other, P0 * 10);
        vm.prank(keeper);
        vm.expectRevert(V4SpotSource.Unauthorized.selector);
        src.setFeed(mid, address(pm), other);
        vm.prank(owner);
        src.setFeed(mid, address(pm), other);
        assertApproxEqRel(src.spot(mid), P0 * 10, 1e9);
    }

    function test_market_without_feed_cannot_fill() public {
        _fund(alice, 1.01 ether);
        uint256 id = _request(alice, mid, true, 2, 1 ether);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        vm.expectRevert(V4SpotSource.NoFeed.selector);
        pool.executeOpen(id, P0, vm.getBlockNumber(), 10, MAX);
    }

    function test_open_long_band() public {
        _feed(P0);
        // a long buys: the keeper may not give more than 2 % below spot, nor charge more than 5 % above
        _fund(alice, 1.515 ether); // 3 × 0.5: max-wins stay under 5 % of the 100-ether pool
        uint256 a = _request(alice, mid, true, 2, 0.5 ether);
        uint256 b = _request(alice, mid, true, 2, 0.5 ether);
        uint256 c = _request(alice, mid, true, 2, 0.5 ether);
        vm.roll(vm.getBlockNumber() + 1);
        vm.startPrank(keeper);
        vm.expectRevert(V4SpotSource.OutOfBand.selector);
        pool.executeOpen(a, P0 * 97 / 100, vm.getBlockNumber(), 10, MAX);
        vm.expectRevert(V4SpotSource.OutOfBand.selector);
        pool.executeOpen(a, P0 * 106 / 100, vm.getBlockNumber(), 10, MAX);
        pool.executeOpen(a, P0 * 99 / 100, vm.getBlockNumber(), 10, MAX);
        pool.executeOpen(b, P0 * 104 / 100, vm.getBlockNumber(), 10, MAX);
        pool.executeOpen(c, P0, vm.getBlockNumber(), 10, MAX);
        vm.stopPrank();
        assertEq(pool.getPosition(a).entryPrice, P0 * 99 / 100);
    }

    function test_short_open_band_is_mirrored() public {
        _feed(P0);
        _fund(alice, 1.01 ether);
        uint256 a = _request(alice, mid, false, 2, 1 ether);
        vm.roll(vm.getBlockNumber() + 1);
        vm.startPrank(keeper);
        vm.expectRevert(V4SpotSource.OutOfBand.selector);
        pool.executeOpen(a, P0 * 103 / 100, vm.getBlockNumber(), 10, MAX); // > 2 % better for a seller
        vm.expectRevert(V4SpotSource.OutOfBand.selector);
        pool.executeOpen(a, P0 * 94 / 100, vm.getBlockNumber(), 10, MAX); // > 5 % worse
        pool.executeOpen(a, P0 * 96 / 100, vm.getBlockNumber(), 10, MAX);
        vm.stopPrank();
    }

    function test_stop_loss_needs_spot_near_the_trigger() public {
        V4SpotSource.PoolKey memory k = _feed(P0);
        uint256 sl = P0 * 90 / 100;
        _fund(alice, 1.01 ether);
        vm.prank(alice);
        uint256 id = pool.requestOpen(mid, true, 2, 1 ether, 0, sl, address(0));
        _fill(id, P0);
        // spot still at P0: a forged SL print 10 % lower is outside the 3 % defensive band
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        vm.expectRevert(V4SpotSource.OutOfBand.selector);
        pool.executeClose(id, sl, vm.getBlockNumber(), InversePool.CloseReason.SL);
        // spot really falls to 2 % above the trigger: SL at the trigger is now inside the band
        _setSpot(k, sl * 102 / 100);
        vm.prank(keeper);
        pool.executeClose(id, sl, vm.getBlockNumber(), InversePool.CloseReason.SL);
        assertEq(uint8(_status(id)), uint8(InversePool.Status.Closed));
        _assertBooks();
    }

    function test_bands_admin() public {
        vm.prank(keeper);
        vm.expectRevert(V4SpotSource.Unauthorized.selector);
        src.setBands(100, 100, 100);
        vm.startPrank(owner);
        vm.expectRevert(V4SpotSource.BadBands.selector);
        src.setBands(100, 300, 400); // defensive wider than normal
        src.setBands(100, 300, 200);
        vm.stopPrank();
        assertEq(src.favBps(), 100);
    }
}
