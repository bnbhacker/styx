// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InverseBase} from "./Base.sol";
import {InversePool} from "../InversePool.sol";
import {Reenterer, IWithdraw} from "./Mocks.sol";

/// SPEC В§2: internal ETH balance, deposit, withdraw of the free balance with no operator.
contract MoneyTest is InverseBase {
    function test_deposit_and_plain_transfer_credit_balance() public {
        vm.deal(alice, 3 ether);
        vm.prank(alice);
        pool.deposit{value: 1 ether}();
        vm.prank(alice);
        (bool ok,) = address(pool).call{value: 2 ether}("");
        assertTrue(ok);
        assertEq(pool.balanceOf(alice), 3 ether);
        assertEq(pool.totalBalances(), 3 ether);
        _assertBooks();
    }

    function test_zero_deposit_and_withdraw_revert() public {
        vm.startPrank(alice);
        vm.expectRevert(InversePool.ZeroAmount.selector);
        pool.deposit();
        vm.expectRevert(InversePool.ZeroAmount.selector);
        pool.withdraw(0);
        vm.stopPrank();
    }

    function test_withdraw_only_free_balance() public {
        _fund(alice, 1 ether);
        _request(alice, mid, true, 2, 0.5 ether); // locks 0.505
        vm.prank(alice);
        vm.expectRevert(InversePool.InsufficientBalance.selector);
        pool.withdraw(0.5 ether);
        vm.prank(alice);
        pool.withdraw(0.495 ether);
        assertEq(alice.balance, 0.495 ether);
        assertEq(pool.balanceOf(alice), 0);
        _assertBooks();
    }

    function test_withdraw_works_without_any_keeper() public {
        _fund(alice, 1 ether);
        vm.prank(owner);
        pool.setKeeper(keeper, false);
        vm.prank(owner);
        pool.setPaused(true);
        vm.prank(alice);
        pool.withdraw(1 ether);
        assertEq(alice.balance, 1 ether);
    }

    function test_withdraw_reentrancy_is_blocked() public {
        Reenterer r = new Reenterer(IWithdraw(address(pool)));
        vm.deal(address(this), 1 ether);
        // The re-entering withdraw reverts with Reentrancy, so the ETH transfer fails as a whole.
        vm.expectRevert(InversePool.TransferFailed.selector);
        r.depositAndWithdraw{value: 1 ether}(0.5 ether);
    }

    function test_min_stake() public {
        _fund(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(InversePool.BadStake.selector);
        pool.requestOpen(mid, true, 2, 0.001 ether - 1, 0, 0, address(0));
        _request(alice, mid, true, 2, 0.001 ether);
    }
}

/// SPEC В§5: a session key may open/close/cancel on the owner's internal balance, nothing else.
contract SessionKeyTest is InverseBase {
    address internal key = makeAddr("key");

    function _setKey() internal {
        vm.prank(alice);
        pool.setSessionKey(key, uint64(vm.getBlockTimestamp() + 24 hours));
    }

    function test_setSessionKey_bounds() public {
        vm.startPrank(alice);
        vm.expectRevert(InversePool.BadSessionKey.selector);
        pool.setSessionKey(alice, uint64(vm.getBlockTimestamp() + 1 hours));
        vm.expectRevert(InversePool.BadSessionKey.selector);
        pool.setSessionKey(key, uint64(vm.getBlockTimestamp()));
        vm.expectRevert(InversePool.BadSessionKey.selector);
        pool.setSessionKey(key, uint64(vm.getBlockTimestamp() + 24 hours + 1));
        pool.setSessionKey(key, uint64(vm.getBlockTimestamp() + 24 hours));
        assertTrue(pool.isSessionKey(alice, key));
        pool.setSessionKey(address(0), 0);
        assertFalse(pool.isSessionKey(alice, key));
        vm.stopPrank();
    }

    function test_key_opens_and_closes_for_owner() public {
        _fund(alice, 1 ether);
        _setKey();
        vm.prank(key);
        uint256 id = pool.requestOpenFor(alice, mid, true, 2, 0.1 ether, 0, 0, address(0));
        assertEq(pool.getPosition(id).trader, alice);
        _fill(id, P0);

        vm.warp(vm.getBlockTimestamp() + 10);
        vm.prank(key);
        pool.requestClose(id);
        _close(id, P0 * 11 / 10, InversePool.CloseReason.USER);

        assertEq(uint8(_status(id)), uint8(InversePool.Status.Closed));
        assertEq(pool.balanceOf(key), 0, "proceeds never reach the key");
        assertEq(pool.balanceOf(alice), 1 ether - 0.101 ether + _payout(0.1 ether, 0.02 ether));
        _assertBooks();
    }

    function test_key_can_cancel_for_owner() public {
        _fund(alice, 1 ether);
        _setKey();
        vm.prank(key);
        uint256 id = pool.requestOpenFor(alice, mid, true, 2, 0.1 ether, 0, 0, address(0));
        vm.warp(vm.getBlockTimestamp() + 60);
        vm.prank(key);
        pool.cancelRequest(id);
        assertEq(pool.balanceOf(alice), 1 ether);
    }

    function test_key_cannot_withdraw_set_keys_or_touch_lp() public {
        _fund(alice, 1 ether);
        _addLp(alice, 1 ether);
        _setKey();

        // withdraw only ever debits msg.sender
        vm.prank(key);
        vm.expectRevert(InversePool.InsufficientBalance.selector);
        pool.withdraw(1);

        // setSessionKey only ever writes msg.sender's slot
        vm.prank(key);
        pool.setSessionKey(bob, uint64(vm.getBlockTimestamp() + 1 hours));
        (address k,) = pool.sessionOf(alice);
        assertEq(k, key);

        // LP shares are msg.sender's
        vm.prank(key);
        vm.expectRevert(InversePool.InsufficientShares.selector);
        pool.requestRemove(1);

        assertEq(pool.balanceOf(alice), 1 ether);
    }

    function test_expired_or_foreign_key_rejected() public {
        _fund(alice, 1 ether);
        _setKey();
        vm.prank(stranger);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.requestOpenFor(alice, mid, true, 2, 0.1 ether, 0, 0, address(0));

        vm.warp(vm.getBlockTimestamp() + 24 hours + 1);
        vm.prank(key);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.requestOpenFor(alice, mid, true, 2, 0.1 ether, 0, 0, address(0));
    }

    function test_stranger_cannot_close_or_cancel() public {
        uint256 id = _open(alice, mid, true, 2, 0.1 ether, P0);
        vm.warp(vm.getBlockTimestamp() + 10);
        vm.prank(stranger);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.requestClose(id);
        vm.prank(stranger);
        vm.expectRevert(InversePool.Unauthorized.selector);
        pool.cancelRequest(id);
    }

    /// Bug fix: a key's first trade used to bind the key's referrer to its owner for good.
    function test_key_cannot_bind_referrer() public {
        _fund(alice, 1 ether);
        _setKey();
        vm.prank(key);
        pool.requestOpenFor(alice, mid, true, 2, 0.1 ether, 0, 0, key);
        assertEq(pool.referrerOf(alice), address(0));

        vm.prank(alice);
        pool.requestOpen(mid, true, 2, 0.1 ether, 0, 0, ref);
        assertEq(pool.referrerOf(alice), ref);
        vm.prank(alice);
        pool.requestOpen(mid, true, 2, 0.1 ether, 0, 0, bob);
        assertEq(pool.referrerOf(alice), ref, "first referrer stays");
    }

    function test_self_referral_ignored() public {
        _fund(alice, 1 ether);
        vm.prank(alice);
        pool.requestOpen(mid, true, 2, 0.1 ether, 0, 0, alice);
        assertEq(pool.referrerOf(alice), address(0));
    }
}
