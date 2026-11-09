// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Uniswap-v3-like pool whose observe() reports a constant tick over any window.
contract MockV3Pool {
    address public token0;
    address public token1;
    address public factory;
    uint24 public fee;
    int24 public tickSpacing;
    int24 public tick;
    bool public broken;
    bool public raw;
    int56 public raw0;
    int56 public raw1;
    uint16 public cardinalityNext = 1000; // v1.1 listing needs > emergencyTwapWindow (900)

    constructor(address t0, address t1, address f, uint24 fee_, int24 spacing) {
        token0 = t0;
        token1 = t1;
        factory = f;
        fee = fee_;
        tickSpacing = spacing;
    }

    function setCardinalityNext(uint16 c) external {
        cardinalityNext = c;
    }

    /// @dev Uniswap v3 slot0 layout; only observationCardinalityNext (word 4) matters to InversePool.
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (uint160(1) << 96, tick, 0, cardinalityNext, cardinalityNext, 0, true);
    }

    function setTick(int24 t) external {
        tick = t;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    /// @dev Return these two cumulatives verbatim (for rounding checks).
    function setRaw(int56 c0, int56 c1) external {
        raw = true;
        raw0 = c0;
        raw1 = c1;
    }

    function observe(uint32[] calldata ago)
        external
        view
        returns (int56[] memory cum, uint160[] memory spl)
    {
        require(!broken, "OLD");
        cum = new int56[](ago.length);
        spl = new uint160[](ago.length);
        if (raw) {
            cum[0] = raw0;
            cum[1] = raw1;
            return (cum, spl);
        }
        int56 nowT = int56(uint56(block.timestamp));
        for (uint256 i; i < ago.length; ++i) {
            cum[i] = int56(tick) * (nowT - int56(uint56(ago[i])));
        }
    }
}

/// @dev Fee-keyed factory (Uniswap v3 getPool(a, b, fee)).
contract MockV3Factory {
    mapping(bytes32 => address) internal _pools;

    function setPool(address a, address b, uint24 fee, address pool) external {
        _pools[keccak256(abi.encode(a, b, fee))] = pool;
        _pools[keccak256(abi.encode(b, a, fee))] = pool;
    }

    function getPool(address a, address b, uint24 fee) external view returns (address) {
        return _pools[keccak256(abi.encode(a, b, fee))];
    }
}

/// @dev TickSpacing-keyed factory (Aero Slipstream getPool(a, b, tickSpacing)).
contract MockCLFactory {
    mapping(bytes32 => address) internal _pools;

    function setPool(address a, address b, int24 spacing, address pool) external {
        _pools[keccak256(abi.encode(a, b, spacing))] = pool;
        _pools[keccak256(abi.encode(b, a, spacing))] = pool;
    }

    function getPool(address a, address b, int24 spacing) external view returns (address) {
        return _pools[keccak256(abi.encode(a, b, spacing))];
    }
}

/// @dev Stand-in for the Nitro ArbSys precompile at 0x64.
contract MockArbSys {
    uint256 public bn;

    function set(uint256 b) external {
        bn = b;
    }

    function arbBlockNumber() external view returns (uint256) {
        return bn;
    }
}

/// @dev Receiver that re-enters withdraw() from its receive hook.
interface IWithdraw {
    function withdraw(uint256) external;
    function deposit() external payable;
}

contract Reenterer {
    IWithdraw public immutable target;
    bool public reentered;

    constructor(IWithdraw t) {
        target = t;
    }

    function depositAndWithdraw(uint256 amount) external payable {
        target.deposit{value: msg.value}();
        target.withdraw(amount);
    }

    receive() external payable {
        if (!reentered) {
            reentered = true;
            target.withdraw(1);
        }
    }
}
