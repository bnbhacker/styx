// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InverseBase} from "./Base.sol";
import {InversePool} from "../InversePool.sol";

/// SPEC В§4вЂ“В§5, В§9 limits: requestOpen -> executeOpen.
contract OpenTest is InverseBase {
    function test_requestOpen_locks_stake_and_fee() public {
        _fund(alice, 1 ether);
        uint256 id = _request(alice, mid, true, 5, 0.2 ether);
        InversePool.Position memory p = pool.getPosition(id);
        assertEq(uint8(p.status), uint8(InversePool.Status.PendingOpen));
        assertEq(p.stake, 0.2 ether);
        assertEq(p.openFee, 0.002 ether);
        assertEq(p.requestBlock, vm.getBlockNumber());
        assertEq(pool.balanceOf(alice), 1 ether - 0.202 ether);
        assertEq(pool.totalEscrow(), 0.202 ether);
        _assertBooks();
    }

    function test_requestOpen_validation() public {
        _fund(alice, 10 ether);
        vm.startPrank(alice);
        uint8[4] memory bad = [uint8(0), 1, 3, 20];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(InversePool.BadLeverage.selector);
            pool.requestOpen(mid, true, bad[i], 0.1 ether, 0, 0, address(0));
        }
        vm.expectRevert(InversePool.BadStake.selector);
        pool.requestOpen(mid, true, 2, uint256(type(uint96).max) + 1, 0, 0, address(0));
        vm.expectRevert(InversePool.UnknownMarket.selector);
        pool.requestOpen(99, true, 2, 0.1 ether, 0, 0, address(0));
        vm.expectRevert(InversePool.BadPrice.selector);
        pool.requestOpen(mid, true, 2, 0.1 ether, uint256(type(uint128).max) + 1, 0, address(0));
        vm.expectRevert(InversePool.InsufficientBalance.selector);
        pool.requestOpen(mid, true, 2, 10 ether, 0, 0, address(0));
        vm.stopPrank();
    }

    function test_executeOpen_price_must_come_after_request_block() public {
        _fund(alice, 1 ether);
        uint256 id = _request(alice, mid, true, 2, 0.1 ether);
        uint256 b = vm.getBlockNumber();

        // same block: no price can be both > request block and <= current block
        vm.prank(keeper);
        vm.expectRevert(InversePool.BadPriceBlock.selector);
        pool.executeOpen(id, P0, b, 10, MAX);

        vm.roll(b + 1);
        vm.startPrank(keeper);
        vm.expectRevert(InversePool.BadPriceBlock.selector);
        pool.executeOpen(id, P0, b, 10, MAX); // == request block
        vm.expectRevert(InversePool.BadPriceBlock.selector);
        pool.executeOpen(id, P0, b + 2, 10, MAX); // future block
        pool.executeOpen(id, P0, b + 1, 10, MAX);
        vm.stopPrank();
        assertEq(pool.getPosition(id).entryBlock, b + 1);
    }

    function test_executeOpen_price_age_limit() public {
        _fund(alice, 1 ether);
        uint256 id = _request(alice, mid, true, 2, 0.1 ether);
        uint256 b = vm.getBlockNumber();
        uint256 age = pool.getParams().maxPriceAgeBlocks;
        vm.roll(b + 1 + age + 1);
        vm.startPrank(keeper);
        vm.expectRevert(InversePool.BadPriceBlock.selector);
        pool.executeOpen(id, P0, b + 1, 10, MAX);
        pool.executeOpen(id, P0, b + 2, 10, MAX);
        vm.stopPrank();
    }

    function test_executeOpen_books_position_and_fee_split() public {
        uint256 cash0 = pool.poolCash();
        uint256 id = _open(alice, mid, true, 5, 1 ether, P0);
        InversePool.Position memory p = pool.getPosition(id);
        assertEq(uint8(p.status), uint8(InversePool.Status.Open));
        assertEq(p.openFee, 0);
        assertEq(p.maxWin, 2 ether);
        assertEq(p.entryPrice, P0);
        assertEq(p.openTime, vm.getBlockTimestamp());

        // 1 % open fee, no referrer: 85 % pool / 10 % prize / 5 % ops
        assertEq(pool.poolCash(), cash0 + 0.0085 ether);
        assertEq(pool.prizePool(), 0.001 ether);
        assertEq(pool.opsBalance(), 0.0005 ether);

        assertEq(pool.totalReserved(), 2 ether);
        assertEq(pool.totalOpenStake(), 1 ether);
        assertEq(pool.totalEscrow(), 1 ether);
        InversePool.Market memory m = pool.getMarket(mid);
        assertEq(m.notionalLong, 5 ether);
        assertEq(m.maxWinLong, 2 ether);
        assertEq(m.lastPrice, P0);
        assertEq(m.lastPriceBlock, vm.getBlockNumber());
        assertEq(pool.lastKeeperActivity(), vm.getBlockTimestamp());
        _assertBooks();
    }

    function test_fee_split_with_referrer_75_10_10_5() public {
        uint256 cash0 = pool.poolCash();
        _fund(alice, 1.01 ether);
        vm.prank(alice);
        uint256 id = pool.requestOpen(mid, true, 2, 1 ether, 0, 0, ref);
        _fill(id, P0);
        assertEq(pool.balanceOf(ref), 0.001 ether);
        assertEq(pool.prizePool(), 0.001 ether);
        assertEq(pool.opsBalance(), 0.0005 ether);
        assertEq(pool.poolCash(), cash0 + 0.0075 ether);

        // close fee is split the same way: price flat -> gross 1, fee 0.01
        _closeUser(id, P0);
        assertEq(pool.balanceOf(ref), 0.002 ether);
        assertEq(pool.balanceOf(alice), 0.99 ether);
        _assertBooks();
    }

    function test_executeOpen_only_keeper() public {
        _fund(alice, 1 ether);
        uint256 id = _request(alice, mid, true, 2, 0.1 ether);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(stranger);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.executeOpen(id, P0, vm.getBlockNumber(), 10, MAX);
    }

    function test_leverage_limited_by_keeper_depth_tier() public {
        _fund(alice, 1 ether);
        uint256 id = _request(alice, mid, true, 10, 0.1 ether);
        vm.roll(vm.getBlockNumber() + 1);
        vm.startPrank(keeper);
        vm.expectRevert(InversePool.BadLeverage.selector);
        pool.executeOpen(id, P0, vm.getBlockNumber(), 5, MAX);
        vm.expectRevert(InversePool.BadLeverage.selector);
        pool.executeOpen(id, P0, vm.getBlockNumber(), 0, MAX); // market closed by depth
        pool.executeOpen(id, P0, vm.getBlockNumber(), 10, MAX);
        vm.stopPrank();
    }

    function test_notional_cap_per_side() public {
        _fund(alice, 10 ether);
        uint256 a = _request(alice, mid, true, 10, 0.1 ether); // notional 1 ETH
        uint256 b = _request(alice, mid, true, 2, 0.001 ether);
        uint256 c = _request(alice, mid, false, 10, 0.1 ether);
        vm.roll(vm.getBlockNumber() + 1);
        vm.startPrank(keeper);
        pool.executeOpen(a, P0, vm.getBlockNumber(), 10, 1 ether);
        vm.expectRevert(InversePool.NotionalCap.selector);
        pool.executeOpen(b, P0, vm.getBlockNumber(), 10, 1 ether);
        pool.executeOpen(c, P0, vm.getBlockNumber(), 10, 1 ether); // the other side has its own cap
        vm.stopPrank();
    }

    /// В§9: max wins of one market side <= 5 % of the pool (fresh report: base = poolCash).
    function test_market_liability_5pct() public {
        _report(0);
        _fund(alice, 10 ether);
        uint256 a = _request(alice, mid, true, 2, 2.5 ether); // max win 5 ETH = 5 % of 100
        uint256 b = _request(alice, mid, true, 2, 0.001 ether);
        uint256 c = _request(alice, mid, false, 2, 2.5 ether);
        vm.roll(vm.getBlockNumber() + 1);
        vm.startPrank(keeper);
        pool.executeOpen(a, P0, vm.getBlockNumber(), 10, MAX);
        vm.expectRevert(InversePool.MarketLiability.selector);
        pool.executeOpen(b, P0, vm.getBlockNumber(), 10, MAX);
        pool.executeOpen(c, P0, vm.getBlockNumber(), 10, MAX);
        vm.stopPrank();
        assertEq(pool.totalReserved(), 10 ether);
    }

    /// В§9: all max wins <= 50 % of the pool.
    function test_pool_liability_50pct() public {
        _report(0);
        _fund(alice, 100 ether);
        uint256[] memory ids = new uint256[](10);
        for (uint256 i; i < 10; ++i) {
            ids[i] = _request(alice, _newMarket(i), true, 2, 2.5 ether);
        }
        uint256 extra = _request(alice, mid, false, 2, 0.06 ether); // +0.12 max win
        vm.roll(vm.getBlockNumber() + 1);
        vm.startPrank(keeper);
        for (uint256 i; i < 10; ++i) {
            pool.executeOpen(ids[i], P0, vm.getBlockNumber(), 10, MAX);
        }
        assertEq(pool.totalReserved(), 50 ether);
        vm.expectRevert(InversePool.PoolLiability.selector);
        pool.executeOpen(extra, P0, vm.getBlockNumber(), 10, MAX);
        vm.stopPrank();
    }

    /// Without a fresh report NAV = poolCash - totalReserved, so limits tighten as reservations grow.
    function test_liability_base_is_conservative_without_report() public {
        _fund(alice, 10 ether);
        uint256 a = _request(alice, mid, true, 2, 2.5 ether);
        uint256 b = _request(alice, _newMarket(1), true, 2, 2.5 ether);
        vm.roll(vm.getBlockNumber() + 1);
        vm.startPrank(keeper);
        pool.executeOpen(a, P0, vm.getBlockNumber(), 10, MAX);
        vm.expectRevert(InversePool.MarketLiability.selector);
        pool.executeOpen(b, P0, vm.getBlockNumber(), 10, MAX); // 5 ETH > 5 % of (100 - 5)
        vm.stopPrank();
        assertEq(_liabilityBase(), pool.poolCash() - 5 ether);
    }

    function test_opens_blocked_by_owner_pause_closes_still_work() public {
        uint256 open = _open(alice, mid, true, 2, 0.1 ether, P0);
        _fund(bob, 1 ether);
        uint256 pending = _request(bob, mid, true, 2, 0.1 ether);
        vm.prank(owner);
        pool.setPaused(true);

        vm.prank(bob);
        vm.expectRevert(InversePool.OpensDisabled.selector);
        pool.requestOpen(mid, true, 2, 0.1 ether, 0, 0, address(0));
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        vm.expectRevert(InversePool.OpensDisabled.selector);
        pool.executeOpen(pending, P0, vm.getBlockNumber(), 10, MAX);

        // pending opens are refundable at once, closes go through
        vm.prank(bob);
        pool.cancelRequest(pending);
        assertEq(pool.balanceOf(bob), 1 ether);
        _closeUser(open, P0);
        assertEq(uint8(_status(open)), uint8(InversePool.Status.Closed));
    }

    function test_disabled_market_blocks_opens() public {
        _fund(alice, 1 ether);
        uint256 pending = _request(alice, mid, true, 2, 0.1 ether);
        vm.prank(keeper);
        pool.setMarketEnabled(mid, false);
        vm.prank(alice);
        vm.expectRevert(InversePool.MarketClosed.selector);
        pool.requestOpen(mid, true, 2, 0.1 ether, 0, 0, address(0));
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        vm.expectRevert(InversePool.MarketClosed.selector);
        pool.executeOpen(pending, P0, vm.getBlockNumber(), 10, MAX);
    }
}

/// SPEC В§4, В§7: PnL, caps, close reasons.
contract CloseTest is InverseBase {
    function test_user_close_long_profit() public {
        uint256 cash0 = pool.poolCash();
        uint256 id = _open(alice, mid, true, 2, 1 ether, P0);
        _closeUser(id, P0 * 110 / 100);
        // pnl = 1 * 2 * 10 % = 0.2; gross 1.2; fee 0.012; payout 1.188
        assertEq(pool.balanceOf(alice), 1.188 ether);
        assertEq(uint8(_status(id)), uint8(InversePool.Status.Closed));
        assertEq(pool.totalReserved(), 0);
        assertEq(pool.totalOpenStake(), 0);
        assertEq(pool.totalEscrow(), 0);
        assertEq(pool.poolCash(), cash0 + _poolCut(0.01 ether) - 0.2 ether + _poolCut(0.012 ether));
        InversePool.Market memory m = pool.getMarket(mid);
        assertEq(m.notionalLong, 0);
        assertEq(m.maxWinLong, 0);
        _assertBooks();
    }

    function test_short_profit_and_long_loss() public {
        uint256 s = _open(alice, mid, false, 5, 1 ether, P0);
        uint256 l = _open(bob, mid, true, 5, 1 ether, P0);
        _closeUser(s, P0 * 90 / 100);
        _closeUser(l, P0 * 90 / 100);
        assertEq(pool.balanceOf(alice), _payout(1 ether, 0.5 ether)); // 1.485
        assertEq(pool.balanceOf(bob), _payout(1 ether, -0.5 ether)); // 0.495
        _assertBooks();
    }

    function test_win_capped_at_200pct() public {
        uint256 id = _open(alice, mid, true, 10, 1 ether, P0);
        assertEq(_previewPnl(id, P0 * 150 / 100), 2 ether);
        _closeUser(id, P0 * 150 / 100); // raw +500 %
        assertEq(pool.balanceOf(alice), _payout(1 ether, 2 ether)); // 2.97
        _assertBooks();
    }

    function test_loss_capped_at_stake() public {
        uint256 cash0 = pool.poolCash();
        uint256 id = _open(alice, mid, true, 10, 1 ether, P0);
        _closeUser(id, P0 * 80 / 100); // raw -200 %
        assertEq(pool.balanceOf(alice), 0);
        assertEq(pool.poolCash(), cash0 + _poolCut(0.01 ether) + 1 ether);
        _assertBooks();
    }

    function test_previewClose_matches_settlement() public {
        uint256 id = _open(alice, mid, false, 5, 0.37 ether, P0);
        uint256 exit = P0 * 93 / 100;
        (int256 pnl, uint256 payout, uint256 fee) = pool.previewClose(id, exit);
        _closeUser(id, exit);
        assertEq(pool.balanceOf(alice), payout);
        assertEq(fee, (uint256(int256(0.37 ether) + pnl)) / 100);
    }

    function test_min_hold_10s_for_user_close() public {
        uint256 id = _open(alice, mid, true, 2, 0.1 ether, P0);
        vm.warp(vm.getBlockTimestamp() + 9);
        vm.prank(alice);
        vm.expectRevert(InversePool.TooEarly.selector);
        pool.requestClose(id);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(alice);
        pool.requestClose(id);
        assertEq(uint8(_status(id)), uint8(InversePool.Status.PendingClose));
    }

    function test_user_close_needs_request_and_later_price() public {
        uint256 id = _open(alice, mid, true, 2, 0.1 ether, P0);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        vm.expectRevert(InversePool.BadReason.selector); // no request
        pool.executeClose(id, P0, vm.getBlockNumber(), InversePool.CloseReason.USER);

        vm.warp(vm.getBlockTimestamp() + 10);
        vm.prank(alice);
        pool.requestClose(id);
        uint256 rb = vm.getBlockNumber();
        vm.roll(rb + 1);
        vm.startPrank(keeper);
        vm.expectRevert(InversePool.BadPriceBlock.selector); // v1.1: price from the request block is outside the window
        pool.executeClose(id, P0, rb, InversePool.CloseReason.USER);
        pool.executeClose(id, P0, rb + 1, InversePool.CloseReason.USER);
        vm.stopPrank();
    }

    function test_close_price_not_before_entry() public {
        uint256 id = _openTpSl(alice, true, 2, 0.1 ether, 0, P0 * 9 / 10);
        uint256 entry = pool.getPosition(id).entryBlock;
        vm.prank(keeper);
        vm.expectRevert(InversePool.BadPriceBlock.selector);
        pool.executeClose(id, P0 / 2, entry - 1, InversePool.CloseReason.SL);
    }

    function test_take_profit_long() public {
        uint256 tp = P0 * 120 / 100;
        uint256 id = _openTpSl(alice, true, 2, 1 ether, tp, 0);
        vm.roll(vm.getBlockNumber() + 1);
        vm.startPrank(keeper);
        vm.expectRevert(InversePool.BadReason.selector);
        pool.executeClose(id, tp - 1, vm.getBlockNumber(), InversePool.CloseReason.TP);
        vm.expectRevert(InversePool.TooEarly.selector); // TP respects the minimum hold
        pool.executeClose(id, tp, vm.getBlockNumber(), InversePool.CloseReason.TP);
        vm.warp(vm.getBlockTimestamp() + 10);
        pool.executeClose(id, tp, vm.getBlockNumber(), InversePool.CloseReason.TP);
        vm.stopPrank();
        assertEq(pool.balanceOf(alice), _payout(1 ether, 0.4 ether));
    }

    function test_take_profit_short() public {
        uint256 tp = P0 * 80 / 100;
        uint256 id = _openTpSl(alice, false, 2, 1 ether, tp, 0);
        vm.warp(vm.getBlockTimestamp() + 10);
        vm.roll(vm.getBlockNumber() + 1);
        vm.startPrank(keeper);
        vm.expectRevert(InversePool.BadReason.selector);
        pool.executeClose(id, tp + 1, vm.getBlockNumber(), InversePool.CloseReason.TP);
        pool.executeClose(id, tp, vm.getBlockNumber(), InversePool.CloseReason.TP);
        vm.stopPrank();
        assertEq(pool.balanceOf(alice), _payout(1 ether, 0.4 ether));
    }

    function test_take_profit_unset_rejected() public {
        uint256 id = _open(alice, mid, true, 2, 1 ether, P0);
        vm.warp(vm.getBlockTimestamp() + 10);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        vm.expectRevert(InversePool.BadReason.selector);
        pool.executeClose(id, P0 * 10, vm.getBlockNumber(), InversePool.CloseReason.TP);
    }

    function test_stop_loss_long_works_immediately() public {
        uint256 sl = P0 * 90 / 100;
        uint256 id = _openTpSl(alice, true, 2, 1 ether, 0, sl);
        vm.roll(vm.getBlockNumber() + 1);
        vm.startPrank(keeper);
        vm.expectRevert(InversePool.BadReason.selector);
        pool.executeClose(id, sl + 1, vm.getBlockNumber(), InversePool.CloseReason.SL);
        pool.executeClose(id, sl, vm.getBlockNumber(), InversePool.CloseReason.SL); // no minimum hold for SL
        vm.stopPrank();
        assertEq(pool.balanceOf(alice), _payout(1 ether, -0.2 ether));
    }

    function test_stop_loss_short() public {
        uint256 sl = P0 * 110 / 100;
        uint256 id = _openTpSl(alice, false, 2, 1 ether, 0, sl);
        vm.roll(vm.getBlockNumber() + 1);
        vm.startPrank(keeper);
        vm.expectRevert(InversePool.BadReason.selector);
        pool.executeClose(id, sl - 1, vm.getBlockNumber(), InversePool.CloseReason.SL);
        pool.executeClose(id, sl, vm.getBlockNumber(), InversePool.CloseReason.SL);
        vm.stopPrank();
    }

    function test_cap_win_needs_price_at_cap() public {
        uint256 l = _open(alice, mid, true, 10, 1 ether, P0);
        uint256 s = _open(bob, mid, false, 10, 1 ether, P0);
        vm.roll(vm.getBlockNumber() + 1);
        vm.startPrank(keeper);
        vm.expectRevert(InversePool.BadReason.selector);
        pool.executeClose(l, P0 * 119 / 100, vm.getBlockNumber(), InversePool.CloseReason.CAP_WIN); // +190 %
        pool.executeClose(l, P0 * 120 / 100, vm.getBlockNumber(), InversePool.CloseReason.CAP_WIN);
        vm.expectRevert(InversePool.BadReason.selector);
        pool.executeClose(s, P0 * 120 / 100, vm.getBlockNumber(), InversePool.CloseReason.CAP_WIN); // short is losing
        pool.executeClose(s, P0 * 80 / 100, vm.getBlockNumber(), InversePool.CloseReason.CAP_WIN);
        vm.stopPrank();
        assertEq(pool.balanceOf(alice), _payout(1 ether, 2 ether));
        assertEq(pool.balanceOf(bob), _payout(1 ether, 2 ether));
    }

    function test_cap_loss_needs_price_at_cap() public {
        uint256 l = _open(alice, mid, true, 10, 1 ether, P0);
        uint256 s = _open(bob, mid, false, 2, 1 ether, P0);
        vm.roll(vm.getBlockNumber() + 1);
        vm.startPrank(keeper);
        vm.expectRevert(InversePool.BadReason.selector);
        pool.executeClose(l, P0 * 91 / 100, vm.getBlockNumber(), InversePool.CloseReason.CAP_LOSS);
        pool.executeClose(l, P0 * 90 / 100, vm.getBlockNumber(), InversePool.CloseReason.CAP_LOSS);
        vm.expectRevert(InversePool.BadReason.selector);
        pool.executeClose(s, P0 * 149 / 100, vm.getBlockNumber(), InversePool.CloseReason.CAP_LOSS);
        pool.executeClose(s, P0 * 150 / 100, vm.getBlockNumber(), InversePool.CloseReason.CAP_LOSS);
        vm.stopPrank();
        assertEq(pool.balanceOf(alice), 0);
        assertEq(pool.balanceOf(bob), 0);
        _assertBooks();
    }

    function test_emergency_reason_not_for_keeper() public {
        uint256 id = _open(alice, mid, true, 2, 1 ether, P0);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        vm.expectRevert(InversePool.BadReason.selector);
        pool.executeClose(id, P0, vm.getBlockNumber(), InversePool.CloseReason.EMERGENCY);
    }

    function test_pool_gone_closes_disabled_market_at_last_price() public {
        uint256 a = _open(alice, mid, true, 2, 1 ether, P0);
        _open(bob, mid, true, 2, 1 ether, P0 * 105 / 100); // lastPrice = 1.05 P0
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        vm.expectRevert(InversePool.BadReason.selector); // market still enabled
        pool.executeClose(a, P0, vm.getBlockNumber(), InversePool.CloseReason.POOL_GONE);

        vm.prank(keeper);
        pool.setMarketEnabled(mid, false);
        vm.prank(keeper);
        pool.executeClose(a, P0 * 50, 0, InversePool.CloseReason.POOL_GONE); // passed price ignored
        assertEq(pool.balanceOf(alice), _payout(1 ether, 0.1 ether));
        _assertBooks();
    }

    function test_protective_close_of_pending_close() public {
        uint256 sl = P0 * 90 / 100;
        uint256 id = _openTpSl(alice, true, 2, 1 ether, 0, sl);
        vm.warp(vm.getBlockTimestamp() + 10);
        vm.prank(alice);
        pool.requestClose(id);
        _close(id, sl, InversePool.CloseReason.SL);
        assertEq(uint8(_status(id)), uint8(InversePool.Status.Closed));
    }

    function test_closed_position_cannot_close_again() public {
        uint256 id = _open(alice, mid, true, 2, 1 ether, P0);
        _closeUser(id, P0);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        vm.expectRevert(InversePool.BadStatus.selector);
        pool.executeClose(id, P0 / 2, vm.getBlockNumber(), InversePool.CloseReason.CAP_LOSS);
    }

    function test_last_price_keeps_newest_block() public {
        _fund(alice, 1.01 ether);
        _fund(bob, 1.01 ether);
        uint256 a = _request(alice, mid, true, 2, 1 ether);
        uint256 b = _requestTpSl(bob, mid, true, 2, 1 ether, 0, P0);
        vm.roll(vm.getBlockNumber() + 1);
        uint256 e = vm.getBlockNumber();
        vm.startPrank(keeper);
        pool.executeOpen(a, P0, e, 10, MAX);
        pool.executeOpen(b, P0, e, 10, MAX);
        vm.roll(e + 5);
        pool.executeClose(a, P0 * 2, e + 3, InversePool.CloseReason.CAP_WIN);
        assertEq(pool.getMarket(mid).lastPrice, P0 * 2);
        assertEq(pool.getMarket(mid).lastPriceBlock, e + 3);
        pool.executeClose(b, P0, e + 1, InversePool.CloseReason.SL);
        vm.stopPrank();
        assertEq(pool.getMarket(mid).lastPrice, P0 * 2, "an older block does not override");
    }

    function _previewPnl(uint256 id, uint256 price) internal view returns (int256 pnl) {
        (pnl,,) = pool.previewClose(id, price);
    }
}

/// SPEC В§5: cancel after 60 s of keeper silence, keeper rejects.
contract CancelTest is InverseBase {
    function test_cancel_pending_open_after_60s_full_refund() public {
        _fund(alice, 1 ether);
        uint256 id = _request(alice, mid, true, 2, 0.5 ether);
        vm.warp(vm.getBlockTimestamp() + 59);
        vm.prank(alice);
        vm.expectRevert(InversePool.TooEarly.selector);
        pool.cancelRequest(id);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(alice);
        pool.cancelRequest(id);
        assertEq(pool.balanceOf(alice), 1 ether, "stake and fee back");
        assertEq(uint8(_status(id)), uint8(InversePool.Status.Cancelled));
        assertEq(pool.totalEscrow(), 0);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        vm.expectRevert(InversePool.BadStatus.selector);
        pool.executeOpen(id, P0, vm.getBlockNumber(), 10, MAX);
        _assertBooks();
    }

    function test_cancel_pending_close_after_60s_reverts_to_open() public {
        uint256 id = _open(alice, mid, true, 2, 0.5 ether, P0);
        vm.warp(vm.getBlockTimestamp() + 10);
        vm.prank(alice);
        pool.requestClose(id);
        vm.warp(vm.getBlockTimestamp() + 59);
        vm.prank(alice);
        vm.expectRevert(InversePool.TooEarly.selector);
        pool.cancelRequest(id);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(alice);
        pool.cancelRequest(id);
        assertEq(uint8(_status(id)), uint8(InversePool.Status.Open));
        vm.prank(alice);
        pool.requestClose(id);
    }

    function test_cancel_open_position_rejected() public {
        uint256 id = _open(alice, mid, true, 2, 0.5 ether, P0);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(alice);
        vm.expectRevert(InversePool.BadStatus.selector);
        pool.cancelRequest(id);
    }

    function test_keeper_reject_refunds_open_and_reverts_close() public {
        _fund(alice, 1 ether);
        uint256 o = _request(alice, mid, true, 2, 0.5 ether);
        vm.prank(keeper);
        pool.rejectRequest(o, 7);
        assertEq(pool.balanceOf(alice), 1 ether);

        uint256 c = _open(bob, mid, true, 2, 0.5 ether, P0);
        vm.warp(vm.getBlockTimestamp() + 10);
        vm.prank(bob);
        pool.requestClose(c);
        vm.prank(keeper);
        pool.rejectRequest(c, 1);
        assertEq(uint8(_status(c)), uint8(InversePool.Status.Open));
        vm.prank(keeper);
        vm.expectRevert(InversePool.BadStatus.selector);
        pool.rejectRequest(c, 1);
        vm.prank(stranger);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.rejectRequest(c, 1);
        _assertBooks();
    }
}

/// SPEC В§8: rug guard.
contract RugTest is InverseBase {
    function _flag(uint256 before, uint256 afterPrice) internal {
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        pool.flagRug(mid, before, vm.getBlockNumber() - 1, afterPrice, vm.getBlockNumber());
    }

    function test_flagRug_validation() public {
        vm.roll(vm.getBlockNumber() + 400);
        uint256 b = vm.getBlockNumber();
        uint256 win = pool.getParams().rugWindowBlocks;
        vm.startPrank(keeper);
        vm.expectRevert(InversePool.BadRug.selector); // only a 79.99 % drop
        pool.flagRug(mid, P0, b - 1, P0 * 2001 / 10_000, b);
        vm.expectRevert(InversePool.BadRug.selector); // blocks out of order
        pool.flagRug(mid, P0, b, P0 / 10, b);
        vm.expectRevert(InversePool.BadRug.selector); // slower than the window
        pool.flagRug(mid, P0, b - win - 1, P0 / 10, b);
        vm.expectRevert(InversePool.BadPriceBlock.selector);
        pool.flagRug(mid, P0, b, P0 / 10, b + 1);
        vm.expectRevert(InversePool.BadPrice.selector);
        pool.flagRug(mid, P0, b - 1, 0, b);
        vm.expectRevert(InversePool.UnknownMarket.selector);
        pool.flagRug(42, P0, b - 1, P0 / 10, b);
        pool.flagRug(mid, P0, b - win, P0 / 5, b); // exactly -80 % over exactly the window
        vm.stopPrank();
        assertEq(pool.getMarket(mid).lockedUntil, vm.getBlockTimestamp() + 1 hours);
        assertEq(pool.getMarket(mid).lastPrice, 0, "v1.1: flagRug prices are unchecked, they never become lastPrice");

        vm.prank(stranger);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.flagRug(mid, P0, b - 1, P0 / 10, b);
    }

    function test_rug_caps_shorts_at_20pct_longs_by_normal_rules() public {
        uint256 s = _open(alice, mid, false, 5, 1 ether, P0);
        uint256 l = _open(bob, mid, true, 2, 1 ether, P0);
        _flag(P0, P0 / 10);

        vm.roll(vm.getBlockNumber() + 1);
        vm.startPrank(keeper);
        vm.expectRevert(InversePool.BadReason.selector); // RUG is for shorts
        pool.executeClose(l, P0 / 10, vm.getBlockNumber(), InversePool.CloseReason.RUG);
        pool.executeClose(s, P0 / 10, vm.getBlockNumber(), InversePool.CloseReason.RUG);
        pool.executeClose(l, P0 / 10, vm.getBlockNumber(), InversePool.CloseReason.CAP_LOSS);
        vm.stopPrank();
        assertEq(pool.balanceOf(alice), _payout(1 ether, 0.2 ether), "short capped at +20 %");
        assertEq(pool.balanceOf(bob), 0, "long lost the stake");
        _assertBooks();
    }

    function test_rug_cap_applies_to_any_short_close_during_lock() public {
        uint256 s = _open(alice, mid, false, 2, 1 ether, P0);
        _flag(P0, P0 / 10);
        _closeUser(s, P0 / 10);
        assertEq(pool.balanceOf(alice), _payout(1 ether, 0.2 ether));
    }

    function test_rug_lock_blocks_opens_and_frees_pending() public {
        _fund(alice, 1 ether);
        uint256 pending = _request(alice, mid, true, 2, 0.5 ether);
        _flag(P0, P0 / 10);
        vm.prank(keeper);
        vm.expectRevert(InversePool.MarketClosed.selector);
        pool.executeOpen(pending, P0 / 10, vm.getBlockNumber(), 10, MAX);
        vm.prank(alice);
        vm.expectRevert(InversePool.MarketClosed.selector);
        pool.requestOpen(mid, true, 2, 0.1 ether, 0, 0, address(0));
        vm.prank(alice);
        pool.cancelRequest(pending); // no 60 s wait while the market is locked
        assertEq(pool.balanceOf(alice), 1 ether);

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _request(alice, mid, true, 2, 0.1 ether); // lock over
    }

    function test_rug_reason_needs_live_lock() public {
        uint256 s = _open(alice, mid, false, 5, 1 ether, P0);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        vm.expectRevert(InversePool.BadReason.selector);
        pool.executeClose(s, P0 / 10, vm.getBlockNumber(), InversePool.CloseReason.RUG);

        _flag(P0, P0 / 10);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        vm.expectRevert(InversePool.BadReason.selector);
        pool.executeClose(s, P0 / 10, vm.getBlockNumber(), InversePool.CloseReason.RUG);

        // after the lock a short is paid in full again (up to +200 %)
        _close(s, P0 / 10, InversePool.CloseReason.CAP_WIN);
        assertEq(pool.balanceOf(alice), _payout(1 ether, 2 ether));
    }
}
