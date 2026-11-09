// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {InversePool} from "../InversePool.sol";

interface IPoolLive {
    function observe(uint32[] calldata) external view returns (int56[] memory, uint160[] memory);
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IERC20Dec {
    function decimals() external view returns (uint8);
}

interface ICLFactoryList {
    function allPoolsLength() external view returns (uint256);
    function allPools(uint256) external view returns (address);
}

/// Live RH Chain (chainId 4663) checks against a fork of the head block. Skipped unless RH_FORK=1:
///   RH_FORK=1 forge test --match-contract ForkRH -vv
/// The public node keeps no old state and rate-limits, so the fork is always taken at the head.
contract ForkRHTest is Test {
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant UNI_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address internal constant AERO_CL_FACTORY = 0xc63d7338c178e805c544B8f897066bD3BBcBE136;

    // pools with the most swaps in the last 2000 blocks on 29.10.2026
    address internal constant UNI_WETH_USDG = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca;
    address internal constant UNI_MEMELORD = 0xdf1d762EbFE8664e9162C6D548510966E47a3159;
    address internal constant UNI_SPY = 0xDDCBBa3666f578E3F09516f21Ff85BFee859AB5e;
    address internal constant UNI_SPCX = 0xC3c9F0171490Ef0F4536fe493F3b0EbB5ee0CB5e;
    address internal constant AERO_WETH_USDG = 0x7615926023bb149f36095645C2a81DC367d39750;
    address internal constant FORK_1AC9_WETH_USDG = 0x16679e2ac1A798865eCf1c1639e67693ddB1C220;
    address internal constant FORK_E519_WETH_USDG = 0x9B050cb1F265094b0977160a2BD7dA8C9E529c3C;
    address internal constant FORK_E0C4_WETH_USDG = 0xFAE65eAa11943f45E83D5B45DC7A7C801C51bfB0;
    address internal constant FORK_1649_WETH_SPY = 0x43343e5881C9382BbDC7b8FB44e837D7A6C254Ad;

    bool internal live;

    function setUp() public {
        live = vm.envOr("RH_FORK", false);
        if (live) vm.createSelectFork("rh");
    }

    modifier onlyFork() {
        if (!live) vm.skip(true);
        _;
    }

    struct PoolInfo {
        address factory;
        bool slot0Ok;
        uint256 slot0Words;
        int24 spotTick;
        uint16 card;
        uint16 cardNext;
        bool twapOk;
        int56 twapTick;
    }

    function _word(bytes memory b, uint256 i) internal pure returns (uint256 w) {
        assembly {
            w := mload(add(b, add(32, mul(32, i))))
        }
    }

    function _probe(address pool) internal view returns (PoolInfo memory r) {
        r.factory = IPoolLive(pool).factory();
        (bool ok, bytes memory s0) = pool.staticcall(abi.encodeWithSignature("slot0()"));
        r.slot0Ok = ok && s0.length >= 160;
        r.slot0Words = s0.length / 32;
        if (r.slot0Ok) {
            r.spotTick = int24(int256(_word(s0, 1)));
            r.card = uint16(_word(s0, 3));
            r.cardNext = uint16(_word(s0, 4));
        }
        uint32[] memory ago = new uint32[](2);
        ago[0] = 30;
        try IPoolLive(pool).observe(ago) returns (int56[] memory c, uint160[] memory) {
            r.twapOk = true;
            r.twapTick = (c[1] - c[0]) / 30;
        } catch {}
    }

    /// @dev v1.1 lists a v3 pool only with cardinalityNext > 900 (emergency TWAP); the keeper grows it first.
    function _grow(address pool) internal {
        if (_probe(pool).cardNext > 900) return;
        (bool ok,) = pool.call(abi.encodeWithSignature("increaseObservationCardinalityNext(uint16)", uint16(1000)));
        require(ok, "grow");
    }

    function _log(string memory name, address pool, PoolInfo memory r) internal pure {
        console2.log("---", name, pool);
        console2.log("  factory", r.factory);
        console2.log("  slot0 words / spot tick", r.slot0Words, vm.toString(int256(r.spotTick)));
        console2.log("  observationCardinality / next", r.card, r.cardNext);
        console2.log("  observe([30,0]) ok / twap tick", r.twapOk, vm.toString(int256(r.twapTick)));
    }

    /// Forge's fork does not run Nitro precompiles, so the live answer comes from script/rh-live-check.ps1;
    /// here we only pin down what the fork itself does so the other fork tests read correctly.
    function test_fork_arbsys_seen_from_forge() public onlyFork {
        assertEq(block.chainid, 4663);
        (bool ok, bytes memory ret) =
            address(100).staticcall{gas: 50_000}(abi.encodeWithSignature("arbBlockNumber()"));
        console2.log("0x64 code length on the fork", address(100).code.length);
        console2.log("ArbSys staticcall ok / return length", ok, ret.length);
        uint256 g = gasleft();
        InversePool p = new InversePool(WETH, address(this));
        console2.log("deploy gas on the fork", g - gasleft());
        assertLt(g - gasleft(), 10_000_000, "the ArbSys probe must not eat the deploy gas");
        console2.log("USE_ARBSYS when deployed on the fork", p.USE_ARBSYS());
        console2.log("block.number on the fork", vm.getBlockNumber());
        if (!p.USE_ARBSYS()) assertEq(p.blockNumber(), vm.getBlockNumber());
    }

    /// observe([30, 0]) on live Uniswap v3, Aero Slipstream and launchpad v3-fork pools, plus their cardinality.
    function test_fork_observe_live_pools() public onlyFork {
        address[9] memory pools = [
            UNI_WETH_USDG,
            UNI_MEMELORD,
            UNI_SPY,
            UNI_SPCX,
            AERO_WETH_USDG,
            FORK_1AC9_WETH_USDG,
            FORK_E519_WETH_USDG,
            FORK_E0C4_WETH_USDG,
            FORK_1649_WETH_SPY
        ];
        string[9] memory names = [
            "uni WETH/USDG",
            "uni Memelord/WETH",
            "uni SPY/WETH",
            "uni SPCX/WETH",
            "aero WETH/USDG",
            "fork 0x1ac9 WETH/USDG",
            "fork 0xE519 WETH/USDG",
            "fork 0xE0c4 WETH/USDG",
            "fork 0x1649 WETH/SPY"
        ];
        for (uint256 i; i < pools.length; ++i) {
            PoolInfo memory r = _probe(pools[i]);
            _log(names[i], pools[i], r);
            if (r.twapOk && r.slot0Ok) {
                int256 d = int256(r.twapTick) - int256(r.spotTick);
                assertLt(d < 0 ? -d : d, 2_000, "30 s TWAP tick far from spot"); // ~20 %
            }
        }
        // deep pools with a large cardinality must answer
        assertTrue(_probe(UNI_WETH_USDG).twapOk, "uni WETH/USDG observe");
        assertTrue(_probe(UNI_SPY).twapOk, "uni SPY observe");
        assertTrue(_probe(AERO_WETH_USDG).twapOk, "aero WETH/USDG observe");
    }

    /// Cardinality-1 pools (observe fails within 30 s of a swap) can be grown by anyone before listing.
    function test_fork_cardinality_can_be_raised_by_anyone() public onlyFork {
        assertEq(_probe(UNI_MEMELORD).cardNext, 1);
        vm.prank(address(0xC0FFEE));
        (bool ok,) = UNI_MEMELORD.call(abi.encodeWithSignature("increaseObservationCardinalityNext(uint16)", uint16(64)));
        assertTrue(ok);
        PoolInfo memory r = _probe(UNI_MEMELORD);
        assertEq(r.cardNext, 64);
        assertEq(r.card, 1, "takes effect slot by slot as later swaps write observations");
    }

    /// The contract verifies live pools at the real factories and reads a sane WAD price through them.
    function test_fork_inversepool_reads_live_pools() public onlyFork {
        InversePool p = new InversePool(WETH, address(this));
        p.setFactory(UNI_FACTORY, 1);
        p.setFactory(AERO_CL_FACTORY, 2);

        uint256 mUsd = p.addMarket(USDG, 6, UNI_WETH_USDG, bytes32(0));
        (bool ok, uint256 uniUsd) = p.oraclePrice(mUsd);
        assertTrue(ok, "uni USDG twap");
        // wei of ETH per 1 USDG: ETH between $300 and $30 000
        assertGt(uniUsd, uint256(1e18) / 30_000);
        assertLt(uniUsd, uint256(1e18) / 300);
        console2.log("uni: wei per 1 USDG", uniUsd, " -> ETH/USD", 1e18 / uniUsd);

        _grow(AERO_WETH_USDG); // 900 slots on 29.10: one short of the v1.1 rule
        p.setMarketSource(mUsd, AERO_WETH_USDG, bytes32(0)); // tickSpacing-keyed verification at the real CLFactory
        (bool ok2, uint256 aeroUsd) = p.oraclePrice(mUsd);
        assertTrue(ok2, "aero USDG twap");
        assertApproxEqRel(aeroUsd, uniUsd, 0.02e18, "uni vs aero");
        console2.log("aero: wei per 1 USDG", aeroUsd);

        address spy = IPoolLive(UNI_SPY).token0() == WETH ? IPoolLive(UNI_SPY).token1() : IPoolLive(UNI_SPY).token0();
        uint256 mSpy = p.addMarket(spy, IERC20Dec(spy).decimals(), UNI_SPY, bytes32(0));
        (bool ok3, uint256 spyPx) = p.oraclePrice(mSpy);
        assertTrue(ok3, "SPY twap");
        console2.log("SPY: wei per token", spyPx);

        // a v3 pool from another factory is refused until that factory is approved
        vm.expectRevert(InversePool.BadPool.selector);
        p.addMarket(address(0x1234), 18, FORK_E519_WETH_USDG, bytes32(0));
    }

    /// A full open -> close against a live pool's observe(): the contract's oracle path end to end.
    function test_fork_trade_against_live_twap() public onlyFork {
        InversePool p = new InversePool(WETH, address(this));
        p.setFactory(UNI_FACTORY, 1);
        uint256 m = p.addMarket(USDG, 6, UNI_WETH_USDG, bytes32(0));
        vm.deal(address(this), 102 ether);
        p.addLiquidity{value: 100 ether}();
        p.deposit{value: 1.01 ether}();

        uint256 id = p.requestOpen(m, true, 2, 1 ether, 0, 0, address(0));
        uint256 rb = p.blockNumber();
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 1);
        uint256 pb = p.blockNumber();
        assertGt(pb, rb, "the contract's block number must advance with the chain");
        (, uint256 px) = p.oraclePrice(m);
        p.executeOpen(id, px, pb, 10, type(uint256).max);

        vm.warp(vm.getBlockTimestamp() + 10);
        p.requestClose(id);
        vm.roll(vm.getBlockNumber() + 1);
        (, uint256 px2) = p.oraclePrice(m);
        p.executeClose(id, px2, p.blockNumber(), InversePool.CloseReason.USER);
        assertEq(uint8(p.getPosition(id).status), uint8(InversePool.Status.Closed));
        assertEq(p.accountingSurplus(), 0);
        console2.log("entry / exit wei per USDG", px, px2);
    }

    /// Which factory kind (fee- or tickSpacing-keyed) each launchpad v3 fork uses, and whether the
    /// contract accepts its pools once that factory is approved.
    function test_fork_launchpad_factories() public onlyFork {
        address[4] memory pools =
            [FORK_1AC9_WETH_USDG, FORK_E519_WETH_USDG, FORK_E0C4_WETH_USDG, FORK_1649_WETH_SPY];
        for (uint256 i; i < pools.length; ++i) {
            address pool = pools[i];
            address f = IPoolLive(pool).factory();
            address t0 = IPoolLive(pool).token0();
            address t1 = IPoolLive(pool).token1();
            uint8 kind;
            (bool okFee, bytes memory feeRet) = pool.staticcall(abi.encodeWithSignature("fee()"));
            if (okFee && feeRet.length == 32) {
                (bool okG, bytes memory g) = f.staticcall(
                    abi.encodeWithSignature("getPool(address,address,uint24)", t0, t1, uint24(_word(feeRet, 0)))
                );
                if (okG && g.length == 32 && address(uint160(_word(g, 0))) == pool) kind = 1;
            }
            if (kind == 0) {
                (bool okTs, bytes memory tsRet) = pool.staticcall(abi.encodeWithSignature("tickSpacing()"));
                if (okTs && tsRet.length == 32) {
                    (bool okG, bytes memory g) = f.staticcall(
                        abi.encodeWithSignature(
                            "getPool(address,address,int24)", t0, t1, int24(int256(_word(tsRet, 0)))
                        )
                    );
                    if (okG && g.length == 32 && address(uint160(_word(g, 0))) == pool) kind = 2;
                }
            }
            console2.log("--- pool / factory", pool, f);
            console2.log("  verified kind (1 fee, 2 tickSpacing, 0 none)", kind);
            if (kind == 0) continue;
            InversePool p = new InversePool(WETH, address(this));
            p.setFactory(f, kind);
            address token = t0 == WETH ? t1 : t0;
            _grow(pool);
            uint256 m = p.addMarket(token, IERC20Dec(token).decimals(), pool, bytes32(0));
            (bool ok, uint256 px) = p.oraclePrice(m);
            console2.log("  InversePool oraclePrice ok / wei per token", ok, px);
        }
    }

    /// Aero Slipstream memecoin/WETH pools (the busiest pools above are WETH/USDG): cardinality and observe.
    function test_fork_aero_meme_pools() public onlyFork {
        ICLFactoryList f = ICLFactoryList(AERO_CL_FACTORY);
        uint256 n = f.allPoolsLength();
        console2.log("aero CL pools", n);
        uint256 seen;
        for (uint256 i = n; i > 0 && seen < 8 && n - i < 60; --i) {
            address pool = f.allPools(i - 1);
            address t0 = IPoolLive(pool).token0();
            address t1 = IPoolLive(pool).token1();
            if (t0 != WETH && t1 != WETH) continue;
            if (t0 == USDG || t1 == USDG) continue;
            ++seen;
            _log("aero x/WETH", pool, _probe(pool));
        }
    }
}
