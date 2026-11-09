// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InverseBase} from "./Base.sol";
import {InversePool} from "../InversePool.sol";

/// SPEC В§9: LP shares at NAV, 24 h exit, NAV from the keeper report.
contract LpTest is InverseBase {
    function test_first_deposit_burns_dead_shares() public {
        assertEq(pool.sharesOf(lp), SEED - 1000);
        assertEq(pool.sharesOf(address(0)), 1000);
        assertEq(pool.totalShares(), SEED);
        assertEq(pool.nav(), SEED);

        vm.prank(owner);
        InversePool fresh = new InversePool(WETH, keeper);
        vm.deal(alice, 1000);
        vm.prank(alice);
        vm.expectRevert(InversePool.ZeroAmount.selector);
        fresh.addLiquidity{value: 1000}();
    }

    function test_second_lp_priced_at_nav() public {
        uint256 id = _open(alice, mid, true, 10, 0.5 ether, P0);
        _closeUser(id, P0 * 90 / 100); // trader loses the whole stake to the pool
        uint256 navNow = pool.nav();
        assertEq(navNow, SEED + _poolCut(0.005 ether) + 0.5 ether);
        uint256 s = _addLp(bob, 10 ether);
        assertEq(s, 10 ether * SEED / navNow);
        assertApproxEqAbs(_lpValue(bob), 10 ether, 1);
        _assertBooks();
    }

    function test_addLiquidity_needs_fresh_report_with_open_positions() public {
        _open(alice, mid, true, 2, 1 ether, P0);
        vm.deal(bob, 2 ether);
        vm.prank(bob);
        vm.expectRevert(InversePool.StaleReport.selector);
        pool.addLiquidity{value: 1 ether}();

        _report(0.1 ether);
        uint256 navNow = pool.nav();
        assertEq(navNow, pool.poolCash() - 0.1 ether);
        uint256 ts = pool.totalShares();
        vm.prank(bob);
        uint256 s = pool.addLiquidity{value: 1 ether}();
        assertEq(s, 1 ether * ts / navNow);

        vm.warp(vm.getBlockTimestamp() + 1 hours + 1);
        vm.prank(bob);
        vm.expectRevert(InversePool.StaleReport.selector);
        pool.addLiquidity{value: 1 ether}();
    }

    function test_remove_after_24h_at_nav() public {
        uint256 half = pool.sharesOf(lp) / 2;
        vm.prank(lp);
        uint256 rid = pool.requestRemove(half);
        assertEq(pool.sharesOf(lp), SEED - 1000 - half);

        vm.warp(vm.getBlockTimestamp() + 24 hours - 1);
        vm.prank(lp);
        vm.expectRevert(InversePool.TooEarly.selector);
        pool.executeRemove(rid);

        vm.warp(vm.getBlockTimestamp() + 1);
        uint256 expected = half * pool.nav() / pool.totalShares();
        vm.prank(lp);
        uint256 got = pool.executeRemove(rid);
        assertEq(got, expected);
        assertEq(pool.balanceOf(lp), got);
        vm.prank(lp);
        pool.withdraw(got);
        assertEq(lp.balance, got);
        _assertBooks();
    }

    /// Bug fix: a request used to stay executable forever, so one old request skipped the 24 h delay for good.
    function test_remove_request_expires_after_window() public {
        vm.prank(lp);
        uint256 rid = pool.requestRemove(1 ether);
        uint256 t0 = vm.getBlockTimestamp();

        vm.warp(t0 + 48 hours); // last second of the window
        _report(0); // keeper alive: no 7-day waiver
        uint256 snap = vm.snapshotState();
        vm.prank(lp);
        pool.executeRemove(rid);
        vm.revertToState(snap);

        vm.warp(t0 + 48 hours + 1);
        vm.prank(lp);
        vm.expectRevert(InversePool.RemoveExpired.selector);
        pool.executeRemove(rid);

        vm.prank(lp);
        pool.cancelRemove(rid);
        vm.prank(lp);
        uint256 rid2 = pool.requestRemove(1 ether);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.prank(lp);
        pool.executeRemove(rid2);
    }

    function test_remove_cannot_take_reserved_cash() public {
        _report(0);
        _open(alice, mid, true, 2, 2.5 ether, P0); // reserves 5 ETH
        vm.startPrank(lp);
        uint256 rid = pool.requestRemove(pool.sharesOf(lp));
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        _report(0);
        vm.prank(lp);
        vm.expectRevert(InversePool.InsufficientFreeCash.selector);
        pool.executeRemove(rid);
        assertEq(pool.poolCash() - pool.totalReserved(), pool.poolCash() - 5 ether);
    }

    function test_lp_exit_without_delay_after_7d_keeper_silence() public {
        vm.prank(lp);
        uint256 rid = pool.requestRemove(1 ether);
        vm.warp(pool.lastKeeperActivity() + 7 days);
        vm.prank(lp);
        pool.executeRemove(rid); // also past its 48 h expiry: waived
        vm.prank(lp);
        uint256 rid2 = pool.requestRemove(1 ether);
        vm.prank(lp);
        pool.executeRemove(rid2); // same second
        assertEq(pool.balanceOf(lp), 2 ether);
    }

    function test_keeper_activity_keeps_lp_delay() public {
        vm.warp(vm.getBlockTimestamp() + 6 days);
        _report(0);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.prank(lp);
        uint256 rid = pool.requestRemove(1 ether);
        vm.prank(lp);
        vm.expectRevert(InversePool.TooEarly.selector);
        pool.executeRemove(rid);
    }

    function test_remove_request_ownership_and_bounds() public {
        vm.startPrank(lp);
        vm.expectRevert(InversePool.InsufficientShares.selector);
        pool.requestRemove(0);
        vm.expectRevert(InversePool.InsufficientShares.selector);
        pool.requestRemove(SEED);
        uint256 rid = pool.requestRemove(5 ether);
        vm.stopPrank();

        vm.prank(stranger);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.cancelRemove(rid);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.prank(stranger);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.executeRemove(rid);

        vm.prank(lp);
        pool.cancelRemove(rid);
        assertEq(pool.sharesOf(lp), SEED - 1000);
        vm.prank(lp);
        vm.expectRevert(InversePool.Unauthorized.selector); // gone
        pool.executeRemove(rid);
    }

    function test_report_bounds_staleness_and_clamp() public {
        _open(alice, mid, true, 2, 1 ether, P0); // reserved 2, open stake 1
        uint256 cash = pool.poolCash();
        vm.startPrank(keeper);
        vm.expectRevert(InversePool.BadReport.selector);
        pool.reportUnrealized(2 ether + 1, vm.getBlockTimestamp());
        vm.expectRevert(InversePool.BadReport.selector);
        pool.reportUnrealized(-1 ether - 1, vm.getBlockTimestamp());
        vm.expectRevert(InversePool.BadReport.selector);
        pool.reportUnrealized(0, vm.getBlockTimestamp() + 1);
        pool.reportUnrealized(0.5 ether, vm.getBlockTimestamp());
        vm.expectRevert(InversePool.BadReport.selector);
        pool.reportUnrealized(0, vm.getBlockTimestamp() - 1);
        vm.stopPrank();
        assertEq(pool.nav(), cash - 0.5 ether);

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        assertEq(pool.nav(), cash - 0.5 ether, "fresh for exactly 1 h");
        vm.warp(vm.getBlockTimestamp() + 1);
        assertEq(pool.nav(), cash - 2 ether, "stale: every position at max win");

        _report(-1 ether);
        assertEq(pool.nav(), cash + 1 ether);
        assertEq(_liabilityBase(), cash);
    }

    /// Bug fix: a realized win stayed in the report and was subtracted from NAV a second time.
    function test_nav_does_not_double_count_realized_win() public {
        uint256 a = _open(alice, mid, true, 2, 1 ether, P0);
        _open(bob, mid, true, 10, 1 ether, P0); // keeps the clamp ceiling at 2 ETH after a closes
        _report(0.2 ether); // a is up 10 %
        assertEq(pool.nav(), pool.poolCash() - 0.2 ether);
        _closeUser(a, P0 * 110 / 100);
        assertEq(pool.reportedUnrealized(), 0);
        assertEq(pool.nav(), pool.poolCash(), "win counted once");
    }

    /// Bug fix, other sign: a realized loss was added to NAV twice, overpaying exiting LPs.
    function test_nav_does_not_double_count_realized_loss() public {
        uint256 a = _open(alice, mid, true, 5, 1 ether, P0);
        _open(bob, mid, true, 2, 1 ether, P0); // keeps the clamp floor at -1 ETH after a closes
        _report(-0.5 ether); // a is down 10 %
        _closeUser(a, P0 * 90 / 100);
        assertEq(pool.reportedUnrealized(), 0);
        assertEq(pool.nav(), pool.poolCash(), "loss counted once");
    }

    function test_positions_opened_after_report_are_not_netted() public {
        _open(bob, mid, true, 2, 1 ether, P0);
        _report(0);
        vm.warp(vm.getBlockTimestamp() + 1);
        uint256 c = _open(alice, mid, true, 5, 1 ether, P0);
        _closeUser(c, P0 * 90 / 100);
        assertEq(pool.reportedUnrealized(), 0);
    }
}

/// SPEC В§9: pool lost > 10 % within an hour -> new opens paused, closes keep working.
contract PauseTest is InverseBase {
    /// @dev Three 10x longs of 2.5 ETH on separate markets: +20 % pays 5 ETH each.
    function _threeWinners() internal returns (uint256[3] memory ids) {
        for (uint256 i; i < 3; ++i) {
            ids[i] = _open(alice, _newMarket(i), true, 10, 2.5 ether, P0);
        }
    }

    function _payWinners(uint256[3] memory ids, uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            _close(ids[i], P0 * 120 / 100, InversePool.CloseReason.CAP_WIN);
        }
    }

    function test_pause_after_10pct_loss_closes_still_work() public {
        _report(0);
        uint256 keep = _open(bob, mid, true, 2, 0.1 ether, P0);
        uint256[3] memory ids = _threeWinners();
        _payWinners(ids, 2); // ~ -9.8 %
        assertTrue(pool.opensAllowed(), "below 10 %");
        _close(ids[2], P0 * 120 / 100, InversePool.CloseReason.CAP_WIN); // ~ -14.8 %
        assertFalse(pool.opensAllowed());
        assertEq(pool.opensPausedUntil(), vm.getBlockTimestamp() + 1 hours);

        _fund(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(InversePool.OpensDisabled.selector);
        pool.requestOpen(mid, true, 2, 0.1 ether, 0, 0, address(0));
        _closeUser(keep, P0);
        assertEq(uint8(_status(keep)), uint8(InversePool.Status.Closed));

        vm.warp(pool.opensPausedUntil());
        assertTrue(pool.opensAllowed());
        _request(bob, mid, true, 2, 0.1 ether);
    }

    function test_owner_clears_loss_pause() public {
        _report(0);
        _payWinners(_threeWinners(), 3);
        assertFalse(pool.opensAllowed());
        vm.prank(stranger);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.clearLossPause();
        vm.prank(owner);
        pool.clearLossPause();
        assertTrue(pool.opensAllowed());
    }

    function test_loss_outside_the_window_does_not_pause() public {
        _report(0);
        uint256[3] memory ids = _threeWinners();
        _payWinners(ids, 2);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _close(ids[2], P0 * 120 / 100, InversePool.CloseReason.CAP_WIN); // new window: 5 % of the smaller pool
        assertTrue(pool.opensAllowed());
    }

    /// Bug fix: a big LP exit inside the window left the base at the old pool size, so the
    /// remaining pool could lose far more than 10 % before the pause.
    function test_lp_exit_does_not_dilute_pause() public {
        uint256 bobShares = _addLp(bob, 900 ether); // pool 1000
        vm.prank(bob);
        uint256 rid = pool.requestRemove(bobShares);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        _report(0);
        uint256[3] memory ids = _threeWinners(); // window opens at ~1000
        assertEq(pool.windowBase(), 1000 ether);

        vm.prank(bob);
        pool.executeRemove(rid); // pool back to ~100
        assertApproxEqRel(pool.windowBase(), pool.poolCash(), 0.001e18);

        _payWinners(ids, 3); // ~15 % of what is left
        assertFalse(pool.opensAllowed());
    }

    /// Bug fix, other side: new LP money inside the window used to keep the old base, so a later small
    /// loss looked like > 10 % and paused opens for nothing.
    function test_lp_deposit_does_not_false_pause() public {
        _report(0);
        uint256 a1 = _open(alice, _newMarket(1), true, 10, 1.5 ether, P0);
        uint256 a2 = _open(alice, _newMarket(2), true, 10, 1.5 ether, P0);
        uint256 b = _open(alice, _newMarket(3), true, 10, 2.5 ether, P0);
        _close(a1, P0 * 120 / 100, InversePool.CloseReason.CAP_WIN);
        _close(a2, P0 * 120 / 100, InversePool.CloseReason.CAP_WIN); // ~ -5.9 %
        _report(0);
        _addLp(bob, 100 ether); // pool doubles
        _close(b, P0 * 120 / 100, InversePool.CloseReason.CAP_WIN); // -5 ETH of ~194: the old base said -10.9 %
        assertTrue(pool.opensAllowed());
    }
}

/// SPEC В§11: emergency exit without the keeper.
contract EmergencyTest is InverseBase {
    function test_emergency_close_after_24h_keeper_silence() public {
        uint256 a = _open(alice, mid, true, 2, 1 ether, P0);
        _open(bob, mid, true, 2, 1 ether, P0 * 110 / 100); // lastPrice 1.1 P0
        uint256 t = pool.lastKeeperActivity();

        vm.warp(t + 24 hours - 1);
        vm.prank(stranger);
        vm.expectRevert(InversePool.KeeperAlive.selector);
        pool.emergencyClose(a);

        vm.warp(t + 24 hours);
        vm.prank(stranger);
        pool.emergencyClose(a);
        assertEq(uint8(_status(a)), uint8(InversePool.Status.Closed));
        assertEq(pool.balanceOf(alice), _payout(1 ether, 0.2 ether), "closed at lastPrice");
        assertEq(pool.lastKeeperActivity(), t, "not keeper activity");
        _assertBooks();
    }

    function test_any_keeper_action_resets_silence() public {
        uint256 a = _open(alice, mid, true, 2, 1 ether, P0);
        vm.warp(vm.getBlockTimestamp() + 23 hours);
        _report(0);
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        vm.expectRevert(InversePool.KeeperAlive.selector);
        pool.emergencyClose(a);
    }

    function test_emergency_close_of_pending_close_and_bad_status() public {
        uint256 a = _open(alice, mid, true, 2, 1 ether, P0);
        _fund(bob, 1 ether);
        uint256 pending = _request(bob, mid, true, 2, 0.5 ether);
        vm.warp(vm.getBlockTimestamp() + 10);
        vm.prank(alice);
        pool.requestClose(a);
        vm.warp(vm.getBlockTimestamp() + 24 hours);

        vm.expectRevert(InversePool.BadStatus.selector);
        pool.emergencyClose(pending); // pending opens are cancelled by their owner instead
        pool.emergencyClose(a);
        vm.expectRevert(InversePool.BadStatus.selector);
        pool.emergencyClose(a);

        vm.prank(bob);
        pool.cancelRequest(pending);
        assertEq(pool.balanceOf(bob), 1 ether);
        _assertBooks();
    }
}
