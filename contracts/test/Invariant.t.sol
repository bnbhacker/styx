// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {InversePool} from "../InversePool.sol";

/// @dev Drives the pool with random traders, LPs, keeper and owner actions. Every call is bounded so that
///      most of them succeed; whatever reverts is swallowed (the invariants are what is under test).
contract Handler is Test {
    InversePool public immutable pool;
    address public immutable owner;
    address public immutable keeper;
    address public constant REF = address(0xBEEF);
    address public constant OPS_SINK = address(0xD00D);

    address[] public traders;
    address[] public lps;
    uint256[] public markets;
    mapping(uint256 => uint256) public px; // market price, WAD
    uint256[] public ids;
    uint256[] public rids;
    mapping(bytes32 => uint256) public calls;

    constructor(InversePool p, address o, address k, uint256[] memory ms) {
        pool = p;
        owner = o;
        keeper = k;
        markets = ms;
        for (uint256 i; i < ms.length; ++i) {
            px[ms[i]] = 1e15;
        }
        traders.push(makeAddr("t0"));
        traders.push(makeAddr("t1"));
        traders.push(makeAddr("t2"));
        lps.push(makeAddr("lp0"));
        lps.push(makeAddr("lp1"));
    }

    // в”Ђв”Ђв”Ђв”Ђв”Ђ views for the invariant contract в”Ђв”Ђв”Ђв”Ђв”Ђ

    function traderCount() external view returns (uint256) {
        return traders.length;
    }

    function lpCount() external view returns (uint256) {
        return lps.length;
    }

    // в”Ђв”Ђв”Ђв”Ђв”Ђ helpers в”Ђв”Ђв”Ђв”Ђв”Ђ

    function _trader(uint256 s) internal view returns (address) {
        return traders[s % traders.length];
    }

    function _lp(uint256 s) internal view returns (address) {
        return lps[s % lps.length];
    }

    function _market(uint256 s) internal view returns (uint256) {
        return markets[s % markets.length];
    }

    uint256 internal constant PENDING_OPEN = 1 << 1;
    uint256 internal constant OPEN = 1 << 2;
    uint256 internal constant PENDING_CLOSE = 1 << 3;
    uint256 internal constant ANY = type(uint256).max;

    /// @dev A position from a random start whose status bit is in `mask` (a few tries, then any).
    function _id(uint256 s, uint256 mask) internal view returns (uint256 id, bool ok) {
        uint256 n = ids.length;
        if (n == 0) return (0, false);
        for (uint256 i; i < 24 && i < n; ++i) {
            id = ids[(s % n + i) % n];
            if (mask & (1 << uint8(pool.getPosition(id).status)) != 0) return (id, true);
        }
        return (ids[s % n], true);
    }

    /// @dev The close reason the price actually satisfies (USER if none does).
    function _reasonFor(uint256 id, uint256 p) internal view returns (InversePool.CloseReason) {
        InversePool.Position memory pos = pool.getPosition(id);
        (int256 pnl,,) = pool.previewClose(id, p);
        if (pnl == int256(uint256(pos.maxWin))) return InversePool.CloseReason.CAP_WIN;
        if (pnl == -int256(uint256(pos.stake))) return InversePool.CloseReason.CAP_LOSS;
        if (pos.sl != 0 && (pos.isLong ? p <= pos.sl : p >= pos.sl)) return InversePool.CloseReason.SL;
        if (pos.tp != 0 && (pos.isLong ? p >= pos.tp : p <= pos.tp)) return InversePool.CloseReason.TP;
        if (!pos.isLong && pool.getMarket(pos.marketId).lockedUntil > vm.getBlockTimestamp()) {
            return InversePool.CloseReason.RUG;
        }
        return InversePool.CloseReason.USER;
    }

    function _move(uint256 m, uint256 bps) internal returns (uint256 p) {
        p = px[m] * bps / 10_000;
        if (p == 0) p = 1;
        if (p > 1e30) p = 1e30;
        px[m] = p;
    }

    function _next() internal {
        vm.roll(vm.getBlockNumber() + 1);
    }

    // в”Ђв”Ђв”Ђв”Ђв”Ђ traders в”Ђв”Ђв”Ђв”Ђв”Ђ

    function deposit(uint256 a, uint256 amt) public {
        amt = bound(amt, 1, 20 ether);
        address u = _trader(a);
        vm.deal(u, u.balance + amt);
        vm.prank(u);
        pool.deposit{value: amt}();
        calls["deposit"]++;
    }

    function withdraw(uint256 a, uint256 amt) public {
        address u = _trader(a);
        uint256 b = pool.balanceOf(u);
        if (b == 0) return;
        amt = bound(amt, 1, b);
        vm.prank(u);
        pool.withdraw(amt);
        calls["withdraw"]++;
    }

    function requestOpen(uint256 a, uint256 ms, bool isLong, uint256 levSeed, uint256 stake, uint256 tpS, uint256 slS)
        public
    {
        address u = _trader(a);
        uint256 m = _market(ms);
        stake = bound(stake, 0.001 ether, 3 ether);
        uint256 need = stake + stake / 100;
        if (pool.balanceOf(u) < need) deposit(a, need);
        uint8[3] memory levs = [uint8(2), 5, 10];
        uint256 p = px[m];
        uint256 tp = tpS % 3 == 0 ? 0 : p * bound(tpS, 5_000, 20_000) / 10_000;
        uint256 sl = slS % 3 == 0 ? 0 : p * bound(slS, 5_000, 20_000) / 10_000;
        vm.prank(u);
        try pool.requestOpen(m, isLong, levs[levSeed % 3], stake, tp, sl, a % 4 == 0 ? REF : address(0)) returns (
            uint256 id
        ) {
            ids.push(id);
            calls["requestOpen"]++;
        } catch {}
    }

    function requestClose(uint256 s) public {
        (uint256 id, bool ok) = _id(s, OPEN);
        if (!ok) return;
        vm.warp(vm.getBlockTimestamp() + 10);
        vm.prank(pool.getPosition(id).trader);
        try pool.requestClose(id) {
            calls["requestClose"]++;
        } catch {}
    }

    function cancel(uint256 s) public {
        (uint256 id, bool ok) = _id(s, PENDING_OPEN | PENDING_CLOSE);
        if (!ok) return;
        vm.warp(vm.getBlockTimestamp() + 60);
        vm.prank(pool.getPosition(id).trader);
        try pool.cancelRequest(id) {
            calls["cancel"]++;
        } catch {}
    }

    // в”Ђв”Ђв”Ђв”Ђв”Ђ keeper в”Ђв”Ђв”Ђв”Ђв”Ђ

    function executeOpen(uint256 s, uint256 moveBps, uint256 capSeed) public {
        (uint256 id, bool ok) = _id(s, PENDING_OPEN);
        if (!ok) return;
        _next();
        uint256 m = pool.getPosition(id).marketId;
        uint256 p = _move(m, bound(moveBps, 9_000, 11_000));
        uint256 cap = capSeed % 4 == 0 ? bound(capSeed, 0, 20 ether) : type(uint256).max;
        vm.prank(keeper);
        try pool.executeOpen(id, p, vm.getBlockNumber(), 10, cap) {
            calls["executeOpen"]++;
        } catch {}
    }

    function executeClose(uint256 s, uint256 moveBps, uint256 reasonSeed) public {
        (uint256 id, bool ok) = _id(s, OPEN | PENDING_CLOSE);
        if (!ok) return;
        _next();
        uint256 m = pool.getPosition(id).marketId;
        uint256 p = _move(m, bound(moveBps, 1_000, 30_000));
        // mostly the reason the price satisfies, sometimes a random one (must be refused if wrong)
        InversePool.CloseReason r = reasonSeed % 4 == 0
            ? InversePool.CloseReason(reasonSeed % 6) // USER..RUG
            : _reasonFor(id, p);
        vm.prank(keeper);
        try pool.executeClose(id, p, vm.getBlockNumber(), r) {
            calls["executeClose"]++;
        } catch {}
    }

    function reject(uint256 s, uint8 code) public {
        (uint256 id, bool ok) = _id(s, PENDING_OPEN | PENDING_CLOSE);
        if (!ok) return;
        vm.prank(keeper);
        try pool.rejectRequest(id, code) {
            calls["reject"]++;
        } catch {}
    }

    function report(int256 v) public {
        int256 hi = int256(pool.totalReserved());
        int256 lo = -int256(pool.totalOpenStake());
        v = bound(v, lo, hi);
        vm.prank(keeper);
        pool.reportUnrealized(v, vm.getBlockTimestamp());
        calls["report"]++;
    }

    function flagRug(uint256 ms) public {
        uint256 m = _market(ms);
        _next();
        uint256 before = px[m];
        uint256 afterP = _move(m, 1_000);
        vm.prank(keeper);
        try pool.flagRug(m, before, vm.getBlockNumber() - 1, afterP, vm.getBlockNumber()) {
            calls["flagRug"]++;
        } catch {}
    }

    function toggleMarket(uint256 ms, bool enabled) public {
        vm.prank(keeper);
        pool.setMarketEnabled(_market(ms), enabled);
        calls["toggleMarket"]++;
    }

    function poolGone(uint256 s) public {
        (uint256 id, bool ok) = _id(s, OPEN | PENDING_CLOSE);
        if (!ok) return;
        vm.prank(keeper);
        try pool.executeClose(id, 0, 0, InversePool.CloseReason.POOL_GONE) {
            calls["poolGone"]++;
        } catch {}
    }

    // в”Ђв”Ђв”Ђв”Ђв”Ђ LPs в”Ђв”Ђв”Ђв”Ђв”Ђ

    function addLiquidity(uint256 a, uint256 amt, int256 v) public {
        if (pool.totalReserved() != 0) report(v);
        amt = bound(amt, 0.01 ether, 50 ether);
        address u = _lp(a);
        vm.deal(u, u.balance + amt);
        vm.prank(u);
        try pool.addLiquidity{value: amt}() {
            calls["addLiquidity"]++;
        } catch {}
    }

    function requestRemove(uint256 a, uint256 frac) public {
        address u = _lp(a);
        uint256 have = pool.sharesOf(u);
        if (have == 0) return;
        uint256 sh = have * bound(frac, 1, 100) / 100;
        if (sh == 0) return;
        vm.prank(u);
        rids.push(pool.requestRemove(sh));
        calls["requestRemove"]++;
    }

    function executeRemove(uint256 s, bool wait) public {
        if (rids.length == 0) return;
        uint256 rid = rids[s % rids.length];
        (address u,,) = pool.removeRequests(rid);
        if (u == address(0)) return;
        if (wait) vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.prank(u);
        try pool.executeRemove(rid) {
            calls["executeRemove"]++;
        } catch {}
    }

    function cancelRemove(uint256 s) public {
        if (rids.length == 0) return;
        uint256 rid = rids[s % rids.length];
        (address u,,) = pool.removeRequests(rid);
        if (u == address(0)) return;
        vm.prank(u);
        pool.cancelRemove(rid);
        calls["cancelRemove"]++;
    }

    // в”Ђв”Ђв”Ђв”Ђв”Ђ anyone / owner / time в”Ђв”Ђв”Ђв”Ђв”Ђ

    function emergencyClose(uint256 s) public {
        (uint256 id, bool ok) = _id(s, OPEN | PENDING_CLOSE);
        if (!ok) return;
        try pool.emergencyClose(id) {
            calls["emergencyClose"]++;
        } catch {}
    }

    function prizes(uint256 a, uint256 amt) public {
        uint256 pot = pool.prizePool();
        if (pot == 0) return;
        address[] memory w = new address[](1);
        uint256[] memory x = new uint256[](1);
        w[0] = _trader(a);
        x[0] = bound(amt, 0, pot);
        vm.prank(owner);
        pool.distributePrizes(w, x);
        calls["prizes"]++;
    }

    function withdrawOps(uint256 amt) public {
        uint256 ops = pool.opsBalance();
        if (ops == 0) return;
        vm.prank(owner);
        pool.withdrawOps(payable(OPS_SINK), bound(amt, 0, ops));
        calls["withdrawOps"]++;
    }

    function warp(uint256 secs) public {
        secs = bound(secs, 1, 3 days);
        vm.warp(vm.getBlockTimestamp() + secs);
        vm.roll(vm.getBlockNumber() + 1 + secs % 1000);
        calls["warp"]++;
    }
}

/// SPEC В§9/В§11 invariants under random sequences of every role.
contract InvariantTest is Test {
    InversePool internal pool;
    Handler internal h;
    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.roll(1_000);
        vm.prank(owner);
        pool = new InversePool(address(0x5000), keeper);
        uint256[] memory ms = new uint256[](3);
        for (uint256 i; i < 3; ++i) {
            vm.prank(keeper);
            ms[i] = pool.addMarket(address(uint160(0x2000 + i)), 18, address(0), bytes32(0));
        }
        h = new Handler(pool, owner, keeper, ms);
        address sink = h.OPS_SINK();
        vm.startPrank(owner);
        pool.setRoles(address(0), sink, address(0), address(0)); // v1.1: ops only to a keeper or the treasury
        // The handler fills requests hundreds of blocks later; the v1.1 execution window is unit-tested
        // (WindowTest), here it is opened wide so the fuzzer keeps reaching every accounting path.
        InversePool.Params memory pp = pool.getParams();
        pp.maxExecDelayBlocks = 100_000;
        pp.maxPriceAgeBlocks = 100_000;
        pool.setParams(pp);
        vm.stopPrank();
        address lp0 = h.lps(0);
        vm.deal(lp0, 100 ether);
        vm.prank(lp0);
        pool.addLiquidity{value: 100 ether}();
        targetContract(address(h));
        excludeSender(address(pool));
    }

    /// Payouts never outrun the pool: cash always covers every open max win.
    function invariant_reserve_covered() public view {
        assertGe(pool.poolCash(), pool.totalReserved());
    }

    /// Contract ETH == balances + pool + escrow + prize + ops, to the wei.
    function invariant_accounting_exact() public view {
        assertEq(pool.accountingSurplus(), 0);
        assertEq(
            address(pool).balance,
            pool.totalBalances() + pool.poolCash() + pool.totalEscrow() + pool.prizePool() + pool.opsBalance()
        );
    }

    /// Ledgers rebuilt from scratch out of positions, balances and LP requests match the running totals.
    function invariant_ledgers_match_positions() public view {
        uint256 escrow;
        uint256 reserved;
        uint256 openStake;
        uint256 n = pool.positionCount();
        uint256[4][4] memory side; // [market][notionalLong, notionalShort, maxWinLong, maxWinShort]
        for (uint256 id = 1; id <= n; ++id) {
            InversePool.Position memory p = pool.getPosition(id);
            if (p.status == InversePool.Status.PendingOpen) {
                escrow += uint256(p.stake) + p.openFee;
            } else if (p.status == InversePool.Status.Open || p.status == InversePool.Status.PendingClose) {
                escrow += p.stake;
                reserved += p.maxWin;
                openStake += p.stake;
                uint256 notional = uint256(p.stake) * p.leverage;
                if (p.isLong) {
                    side[p.marketId][0] += notional;
                    side[p.marketId][2] += p.maxWin;
                } else {
                    side[p.marketId][1] += notional;
                    side[p.marketId][3] += p.maxWin;
                }
            }
        }
        assertEq(pool.totalEscrow(), escrow, "escrow");
        assertEq(pool.totalReserved(), reserved, "reserved");
        assertEq(pool.totalOpenStake(), openStake, "open stake");
        for (uint256 m = 1; m <= 3; ++m) {
            InversePool.Market memory mk = pool.getMarket(m);
            assertEq(mk.notionalLong, side[m][0], "notional long");
            assertEq(mk.notionalShort, side[m][1], "notional short");
            assertEq(mk.maxWinLong, side[m][2], "max win long");
            assertEq(mk.maxWinShort, side[m][3], "max win short");
        }

        uint256 balances = pool.balanceOf(h.REF());
        for (uint256 i; i < h.traderCount(); ++i) {
            balances += pool.balanceOf(h.traders(i));
        }
        for (uint256 i; i < h.lpCount(); ++i) {
            balances += pool.balanceOf(h.lps(i));
        }
        assertEq(pool.totalBalances(), balances, "sum of balances");
    }

    /// Shares are neither minted nor burned outside add/remove: holders + dead + escrowed == total.
    function invariant_shares_conserved() public view {
        uint256 s = pool.sharesOf(address(0));
        for (uint256 i; i < h.lpCount(); ++i) {
            s += pool.sharesOf(h.lps(i));
        }
        for (uint256 rid = 1; rid <= pool.removeCount(); ++rid) {
            (, uint128 sh,) = pool.removeRequests(rid);
            s += sh;
        }
        assertEq(pool.totalShares(), s);
    }

    /// NAV stays inside what the books allow: [poolCash - totalReserved, poolCash + totalOpenStake].
    function invariant_nav_bounded() public view {
        uint256 nav = pool.nav();
        assertGe(nav, pool.poolCash() - pool.totalReserved());
        assertLe(nav, pool.poolCash() + pool.totalOpenStake());
    }

    /// The handler swallows reverts, so prove it really reaches every path: a long deterministic walk
    /// must land successful calls of each kind, with the books checked along the way.
    function test_handler_reaches_every_path() public {
        uint256 seed = 42;
        for (uint256 i; i < 6000; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 a = seed >> 8;
            uint256 b = seed >> 72;
            uint256 c = seed >> 136;
            uint256 k = seed % 21;
            if (k == 0) h.deposit(a, b);
            else if (k == 1) h.withdraw(a, b);
            else if (k <= 4) h.requestOpen(a, b, a % 2 == 0, c, b % 2 ether, c, a);
            else if (k <= 7) h.executeOpen(a, 9_000 + b % 2_001, c);
            else if (k == 8) h.requestClose(a);
            else if (k <= 10) h.executeClose(a, 1_000 + b % 29_001, c);
            else if (k == 11) h.cancel(a);
            else if (k == 12) h.reject(a, uint8(b));
            else if (k == 13) h.report(int256(b % 1 ether) - 0.5 ether);
            else if (k == 14 && c % 4 == 0) h.flagRug(a);
            else if (k == 15) h.addLiquidity(a, b, int256(c % 1 ether));
            else if (k == 16 && c % 3 == 0) h.cancelRemove(a);
            else if (k == 16) h.requestRemove(a, b);
            else if (k == 17) h.executeRemove(a, b % 2 == 0);
            else if (k == 18) {
                if (c % 3 == 0) h.emergencyClose(a);
                else if (c % 3 == 1) h.toggleMarket(a, b % 4 != 0);
                else h.poolGone(a);
            } else if (k == 19) {
                if (c % 2 == 0) h.prizes(a, b);
                else h.withdrawOps(b);
            } else {
                h.warp(c % 10 == 0 ? b : b % 120);
            }
            if (i % 500 == 0) {
                invariant_reserve_covered();
                invariant_accounting_exact();
                invariant_ledgers_match_positions();
                invariant_shares_conserved();
                invariant_nav_bounded();
            }
        }
        string[18] memory must = [
            "requestOpen", "executeOpen", "requestClose", "executeClose", "cancel", "reject", "flagRug",
            "addLiquidity", "requestRemove", "executeRemove", "cancelRemove", "emergencyClose", "poolGone",
            "prizes", "withdrawOps", "withdraw", "report", "toggleMarket"
        ];
        for (uint256 i; i < must.length; ++i) {
            uint256 n = h.calls(bytes32(bytes(must[i])));
            emit log_named_uint(must[i], n);
            assertGt(n, 0, must[i]);
        }
    }
}
