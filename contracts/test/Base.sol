// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {InversePool} from "../InversePool.sol";

/// @dev Shared fixture: pool deployed by `owner`, one keeper, a v4-style market (no on-chain TWAP), 100 ETH of LP.
abstract contract InverseBase is Test {
    InversePool internal pool;

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal lp = makeAddr("lp");
    address internal ref = makeAddr("ref");
    address internal stranger = makeAddr("stranger");

    address internal constant WETH = address(0x5000);
    address internal constant TOKEN = address(0x1000);

    uint256 internal constant P0 = 1e15; // 0.001 ETH per token
    uint256 internal constant SEED = 100 ether;
    uint256 internal constant MAX = type(uint256).max;

    uint256 internal mid; // v4-style market: keeper price only

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        vm.roll(1_000);
        vm.prank(owner);
        pool = new InversePool(WETH, keeper);
        vm.prank(keeper);
        mid = pool.addMarket(TOKEN, 18, address(0), bytes32("v4:TOKEN"));
        _addLp(lp, SEED);
    }

    // в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ helpers в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

    function _addLp(address who, uint256 amount) internal returns (uint256 shares) {
        vm.deal(who, who.balance + amount);
        vm.prank(who);
        shares = pool.addLiquidity{value: amount}();
    }

    function _fund(address who, uint256 amount) internal {
        vm.deal(who, who.balance + amount);
        vm.prank(who);
        pool.deposit{value: amount}();
    }

    function _newMarket(uint256 i) internal returns (uint256 m) {
        vm.prank(keeper);
        m = pool.addMarket(address(uint160(0x2000 + i)), 18, address(0), bytes32(0));
    }

    function _request(address who, uint256 m, bool isLong, uint8 lev, uint256 stake) internal returns (uint256 id) {
        vm.prank(who);
        id = pool.requestOpen(m, isLong, lev, stake, 0, 0, address(0));
    }

    function _requestTpSl(address who, uint256 m, bool isLong, uint8 lev, uint256 stake, uint256 tp, uint256 sl)
        internal
        returns (uint256 id)
    {
        vm.prank(who);
        id = pool.requestOpen(m, isLong, lev, stake, tp, sl, address(0));
    }

    /// @dev Keeper fills at the next block with no leverage/notional limits of its own.
    function _fill(uint256 id, uint256 price) internal {
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        pool.executeOpen(id, price, vm.getBlockNumber(), 10, MAX);
    }

    function _open(address who, uint256 m, bool isLong, uint8 lev, uint256 stake, uint256 price)
        internal
        returns (uint256 id)
    {
        _fund(who, stake + stake / 100);
        id = _request(who, m, isLong, lev, stake);
        _fill(id, price);
    }

    function _openTpSl(address who, bool isLong, uint8 lev, uint256 stake, uint256 tp, uint256 sl)
        internal
        returns (uint256 id)
    {
        _fund(who, stake + stake / 100);
        id = _requestTpSl(who, mid, isLong, lev, stake, tp, sl);
        _fill(id, P0);
    }

    /// @dev USER close: wait the minimum hold, request, keeper fills at the next block.
    function _closeUser(uint256 id, uint256 price) internal {
        vm.warp(vm.getBlockTimestamp() + 10);
        vm.prank(pool.getPosition(id).trader);
        pool.requestClose(id);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        pool.executeClose(id, price, vm.getBlockNumber(), InversePool.CloseReason.USER);
    }

    function _close(uint256 id, uint256 price, InversePool.CloseReason r) internal {
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        pool.executeClose(id, price, vm.getBlockNumber(), r);
    }

    function _report(int256 value) internal {
        vm.prank(keeper);
        pool.reportUnrealized(value, vm.getBlockTimestamp());
    }

    /// @dev v1.1 dropped these views from the pool (bytecode); same formulas off-chain.
    function _liabilityBase() internal view returns (uint256) {
        uint256 n = pool.nav();
        uint256 c = pool.poolCash();
        return n < c ? n : c;
    }

    function _lpValue(address who) internal view returns (uint256) {
        uint256 ts = pool.totalShares();
        return ts == 0 ? 0 : pool.sharesOf(who) * pool.nav() / ts;
    }

    function _status(uint256 id) internal view returns (InversePool.Status) {
        return pool.getPosition(id).status;
    }

    /// @dev Payout after the 1 % close fee for a clamped PnL.
    function _payout(uint256 stake, int256 pnl) internal pure returns (uint256) {
        uint256 gross = uint256(int256(stake) + pnl);
        return gross - gross / 100;
    }

    /// @dev Pool share of a fee (no referrer): 85 %.
    function _poolCut(uint256 fee) internal pure returns (uint256) {
        return fee - fee / 10 - fee / 20;
    }

    function _assertBooks() internal view {
        assertEq(pool.accountingSurplus(), 0, "accounting surplus");
        assertGe(pool.poolCash(), pool.totalReserved(), "poolCash < totalReserved");
        assertEq(
            address(pool).balance,
            pool.totalBalances() + pool.poolCash() + pool.totalEscrow() + pool.prizePool() + pool.opsBalance(),
            "buckets"
        );
    }
}
