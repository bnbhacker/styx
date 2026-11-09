// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// InversePool (Styx) — leveraged long/short house pool for memecoins on Arbitrum Nitro chains
// (Robinhood Chain 4663, Elysium 99801). Implements inverse-rh/SPEC.md §2, §4–§9, §11 plus the v1.1 changes
// of inverse-rh/STYX-ELYSIUM.md §3.3. NOT AUDITED. Foundry tests in ./test (see README.md).

/// @notice Uniswap-v3-style pool surface shared by Uniswap v3, Aero Slipstream CL and v3 forks.
interface IV3PoolLike {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function factory() external view returns (address);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

/// @notice Uniswap v3 factory: pools keyed by fee tier.
interface IV3FactoryLike {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

/// @notice Aerodrome Slipstream factory: pools keyed by tick spacing.
interface ICLFactoryLike {
    function getPool(address tokenA, address tokenB, int24 tickSpacing) external view returns (address);
}

/// @notice Arbitrum Nitro precompile at 0x64. On Nitro `block.number` is the PARENT-chain block,
///         so L2 block numbers (the ones eth_getLogs reports) must come from here.
interface IArbSys {
    function arbBlockNumber() external view returns (uint256);
}

/// @notice v1.1 price adapter, set per market by the owner (behind a timelock). Called with STATICCALL on every
///         keeper fill of that market; it may only check or replace the keeper's price and must revert to refuse.
///         `reason` is uint8(CloseReason) for closes and OPEN_REASON (255) for opens.
interface IPriceSource {
    function quote(uint256 marketId, uint256 keeperPrice, bool isLong, bool isOpen, uint8 reason)
        external
        view
        returns (uint256 fillPrice, uint256 refPrice);
}

/// @notice 512-bit multiply-then-divide (Remco Bloemen, Uniswap FullMath, 0.8 port).
library FullMath {
    /// @dev floor(a * b / denominator). Reverts if denominator == 0 or the result overflows uint256.
    function mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly ("memory-safe") {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) {
                require(denominator > 0);
                assembly ("memory-safe") {
                    result := div(prod0, denominator)
                }
                return result;
            }
            require(denominator > prod1);
            uint256 remainder;
            assembly ("memory-safe") {
                remainder := mulmod(a, b, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = (0 - denominator) & denominator;
            assembly ("memory-safe") {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inv = (3 * denominator) ^ 2;
            inv *= 2 - denominator * inv; // 2^8
            inv *= 2 - denominator * inv; // 2^16
            inv *= 2 - denominator * inv; // 2^32
            inv *= 2 - denominator * inv; // 2^64
            inv *= 2 - denominator * inv; // 2^128
            inv *= 2 - denominator * inv; // 2^256
            result = prod0 * inv;
        }
    }
}

/// @notice Port of Uniswap v3 TickMath.getSqrtRatioAtTick.
library TickMath {
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;

    error TickOutOfRange();

    /// @return sqrtPriceX96 sqrt(1.0001^tick) * 2^96
    function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        unchecked {
            uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
            if (absTick > uint256(int256(MAX_TICK))) revert TickOutOfRange();

            uint256 ratio = absTick & 0x1 != 0
                ? 0xfffcb933bd6fad37aa2d162d1a594001
                : 0x100000000000000000000000000000000;
            if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

            if (tick > 0) ratio = type(uint256).max / ratio;

            // Q128.128 -> Q64.96, rounding up so getTickAtSqrtRatio stays consistent.
            sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
        }
    }
}

/// @title InversePool
/// @notice On-chain book, balances and LP pool for 2x/5x/10x long/short on memecoins against a house pool.
///         Traders hold native-ETH internal balances; a keeper fills two-step requests with a price taken
///         strictly after the request block. The contract checks every keeper action it can check.
/// @dev Prices are uint256 WAD: wei of ETH per 1 whole token (10**decimals units).
contract InversePool {
    // ───────────────────────────── constants ─────────────────────────────

    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_SESSION = 24 hours;
    uint256 internal constant MAX_PRICE = type(uint128).max;
    uint256 internal constant MAX_STAKE = type(uint96).max;
    uint256 internal constant DEAD_SHARES = 1_000;
    uint8 internal constant FACTORY_V3 = 1; // getPool(a, b, uint24 fee)
    uint8 internal constant FACTORY_CL = 2; // getPool(a, b, int24 tickSpacing)
    uint8 internal constant OPEN_REASON = 255; // IPriceSource.quote reason for opens
    address internal constant ARBSYS = address(100);

    // ───────────────────────────── types ─────────────────────────────

    enum Status {
        None,
        PendingOpen,
        Open,
        PendingClose,
        Closed,
        Cancelled
    }

    enum CloseReason {
        USER,
        TP,
        SL,
        CAP_WIN,
        CAP_LOSS,
        RUG,
        POOL_GONE,
        EMERGENCY
    }

    /// @notice Tunables. Fee splits are bps of the fee; liability limits are bps of the pool.
    struct Params {
        uint256 minStake; // 0.001 ether
        uint256 openFeeBps; // 100 = 1 % of stake
        uint256 closeFeeBps; // 100 = 1 % of returned amount
        uint256 referrerBps; // 1000 = 10 % of fee (to pool if no referrer)
        uint256 prizeBps; // 1000 = 10 % of fee to the weekly prize pot
        uint256 opsBps; // 500 = 5 % of fee to keeper gas; pool gets the rest (75 %)
        uint256 maxWinBps; // 20000 = win cap +200 % of stake
        uint256 rugCapBps; // 2000 = shorts capped at +20 % in a rugged market
        uint256 rugDropBps; // 8000 = rug means a drop of >= 80 %
        uint256 rugWindowBlocks; // 300 blocks (~30 s: RH makes ~9.6 blocks/s, measured 29.10.2026)
        uint256 rugLock; // 1 h market lock after a rug
        uint256 minHold; // 10 s before USER close / TP
        uint256 cancelDelay; // 60 s of keeper silence before cancelRequest
        uint256 marketLiabilityBps; // 500 = 5 %: sum of max-wins per market per side
        uint256 totalLiabilityBps; // 5000 = 50 %: sum of all max-wins
        uint256 twapWindow; // 30 s for v3 observe()
        uint256 twapToleranceBps; // 300 = keeper price within 3 % of TWAP
        uint256 maxPriceAgeBlocks; // 600 blocks (~60 s): how old a priceBlock may be
        uint256 removeDelay; // 24 h LP exit delay
        uint256 removeWindow; // 24 h to execute a matured exit; later the request expires (no standing exit option)
        uint256 emergencyDelay; // 24 h keeper silence -> anyone may close positions
        uint256 lpEmergencyDelay; // 7 d keeper silence -> LP exit without delay
        uint256 reportMaxAge; // 1 h freshness of the unrealized-PnL snapshot
        uint256 pauseLossBps; // 1000 = pause opens when pool loses > 10 % in a window
        uint256 pauseWindow; // 1 h loss window
        uint256 pauseDuration; // 1 h pause
        // ── v1.1 (Elysium). Constructor defaults keep v1 behaviour; the deploy script sets per-chain values.
        uint256 minExecDelayBlocks; // 1: open/USER-close price block >= requestBlock + this
        uint256 maxExecDelayBlocks; // 600 (Elysium 20 ≈ 2 s): ... and <= requestBlock + this
        uint256 notionalCapMax; // 0 = none; otherwise the keeper's notionalCap is clamped to it
        uint256 keeperBlockRate; // L2 blocks per HOUR, 0 = off: keeper silence also needs delay * rate / 3600 blocks
        uint256 emergencyTwapWindow; // 900 s: v3 TWAP for emergencyClose; v3 pools need cardinalityNext > it
        uint256 maxPoolCash; // 0 = none: guarded launch cap on LP deposits
    }

    struct Market {
        address token;
        address v3Pool; // 0 = no on-chain TWAP check (v4 pools)
        bool tokenIsToken0;
        uint8 decimals;
        bool enabled;
        uint64 lockedUntil; // rug lock
        bytes32 priceSource; // main pool: v3 address or v4 PoolId, echoed in every price event
        uint256 lastPrice;
        uint64 lastPriceTime;
        uint64 lastPriceBlock;
        uint256 notionalLong;
        uint256 notionalShort;
        uint256 maxWinLong;
        uint256 maxWinShort;
        address priceAdapter; // v1.1: 0 = none; else IPriceSource checks/sets every keeper fill
    }

    struct Position {
        address trader;
        uint32 marketId;
        bool isLong;
        uint8 leverage;
        Status status;
        uint96 stake;
        uint96 openFee; // locked while PendingOpen
        uint64 requestBlock; // L2 block of the pending request (open or close)
        uint64 requestTime;
        uint64 openTime;
        uint64 entryBlock; // priceBlock of the entry price
        uint128 maxWin; // reserved max win
        uint256 entryPrice;
        uint256 tp; // 0 = none
        uint256 sl; // 0 = none
    }

    struct Session {
        address key;
        uint64 expiry;
    }

    struct RemoveRequest {
        address lp;
        uint128 shares;
        uint64 time;
    }

    struct OpenOrder {
        uint256 marketId;
        bool isLong;
        uint8 leverage;
        uint256 stake;
        uint256 tp;
        uint256 sl;
        address referrer;
    }

    struct Fill {
        uint256 price;
        uint256 priceBlock;
        uint256 oracle;
        CloseReason reason;
    }

    // ───────────────────────────── storage ─────────────────────────────

    address public immutable WETH;
    bool public immutable USE_ARBSYS;

    address public owner;
    address public pendingOwner;
    mapping(address => bool) public isKeeper;
    mapping(address => uint8) public factoryKind;
    uint256 private _locked = 1;

    Params internal _params;
    bool public paused; // owner switch for new opens
    uint64 public opensPausedUntil; // automatic loss pause
    uint64 public lastKeeperActivity;
    uint64 public lastKeeperBlock; // L2 block of the last keeper action (second clock for keeper silence)

    // traders
    mapping(address => uint256) public balanceOf;
    mapping(address => Session) public sessionOf;
    mapping(address => address) public referrerOf;

    // markets & positions
    uint256 public marketCount;
    mapping(address => uint256) public marketIdOf;
    mapping(uint256 => Market) internal _markets;
    uint256 public positionCount;
    mapping(uint256 => Position) internal _positions;

    // pool
    uint256 public poolCash; // ETH owned by LPs
    uint256 public totalReserved; // sum of max-wins of open positions
    uint256 public totalOpenStake; // sum of stakes of open positions
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;
    uint256 public removeCount;
    mapping(uint256 => RemoveRequest) public removeRequests;
    int256 public reportedUnrealized; // traders' aggregate unrealized PnL (+ = traders winning)
    uint64 public reportedAsOf;

    // loss window
    uint64 public windowStart;
    uint256 public windowBase;
    int256 public windowNet;

    // other buckets (accounting: balance == totalBalances + poolCash + totalEscrow + prizePool + opsBalance)
    uint256 public totalBalances;
    uint256 public totalEscrow; // pending stakes+fees and open stakes
    uint256 public prizePool;
    uint256 public opsBalance;

    // v1.1 roles and guarded launch
    address public guardian; // may only pause opens (fast stop without the owner's timelock)
    address public treasury; // besides keepers, the only withdrawOps destination
    address public rebateSource; // native transfers from it go to the prize pot, not to a deposit
    address public defaultAdapter; // IPriceSource for every market with neither a v3 pool nor its own adapter
    bool public lpGate; // true = only lpAllowed addresses may add liquidity
    mapping(address => bool) public lpAllowed;

    // ───────────────────────────── events ─────────────────────────────

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event KeeperSet(address indexed keeper, bool allowed);
    event FactorySet(address indexed factory, uint8 kind);
    /// @dev v1.1: the hash of abi.encode(Params) instead of the whole struct (bytecode); read values via getParams().
    event ParamsUpdated(bytes32 paramsHash);
    event PausedSet(bool paused);
    event LossPauseCleared();

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event SessionKeySet(address indexed trader, address indexed key, uint64 expiry);
    event ReferrerSet(address indexed trader, address indexed referrer);

    event MarketAdded(uint256 indexed marketId, address indexed token, uint8 decimals);
    event MarketUpdated(uint256 indexed marketId, address v3Pool, bool tokenIsToken0, bytes32 priceSource, bool enabled);
    event RugFlagged(
        uint256 indexed marketId,
        uint256 priceBefore,
        uint256 blockBefore,
        uint256 priceAfter,
        uint256 blockAfter,
        bytes32 priceSource,
        uint64 lockedUntil
    );

    event OpenRequested(
        uint256 indexed id,
        address indexed trader,
        uint256 indexed marketId,
        bool isLong,
        uint8 leverage,
        uint256 stake,
        uint256 fee,
        uint256 tp,
        uint256 sl,
        uint256 requestBlock
    );
    event PositionOpened(
        uint256 indexed id,
        uint256 indexed marketId,
        uint256 price,
        uint256 priceBlock,
        bytes32 priceSource,
        uint256 oraclePrice,
        uint256 maxWin
    );
    event CloseRequested(uint256 indexed id, address indexed by, uint256 requestBlock);
    event PositionClosed(
        uint256 indexed id,
        uint256 indexed marketId,
        CloseReason indexed reason,
        uint256 price,
        uint256 priceBlock,
        bytes32 priceSource,
        uint256 oraclePrice,
        int256 pnl,
        uint256 payout
    );
    event RequestCancelled(uint256 indexed id, address indexed by, bool wasOpen);
    event RequestRejected(uint256 indexed id, uint8 code, bool wasOpen);
    event FeeSplit(
        uint256 indexed id, uint256 fee, uint256 toPool, address referrer, uint256 toReferrer, uint256 toPrize, uint256 toOps
    );

    event UnrealizedReported(int256 value, uint256 asOf, uint256 poolCash, uint256 nav);
    event LiquidityAdded(address indexed lp, uint256 amount, uint256 shares, uint256 nav);
    event RemoveRequested(uint256 indexed rid, address indexed lp, uint256 shares, uint256 executableAt);
    event RemoveExecuted(uint256 indexed rid, address indexed lp, uint256 shares, uint256 amount, uint256 nav);
    event RemoveCancelled(uint256 indexed rid, address indexed lp, uint256 shares);
    event OpensPaused(uint256 until, int256 windowNet, uint256 windowBase);
    event PrizePaid(address indexed winner, uint256 amount);
    event OpsWithdrawn(address indexed to, uint256 amount);
    event RolesSet(address guardian, address treasury, address rebateSource, address defaultAdapter);
    event PriceAdapterSet(uint256 indexed marketId, address adapter);
    event LpAllowedSet(address indexed lp, bool allowed); // lp == 0: the gate itself
    event ToPrizePool(address indexed from, uint256 amount); // rebate or swept surplus

    // ───────────────────────────── errors ─────────────────────────────

    error Unauthorized();
    error Reentrancy();
    error ZeroAmount();
    error InsufficientBalance();
    error TransferFailed();
    error BadSessionKey();
    error UnknownMarket();
    error MarketClosed();
    error BadLeverage();
    error BadStake();
    error BadPrice();
    error BadStatus();
    error BadPriceBlock();
    error TooEarly();
    error OpensDisabled();
    error NotionalCap();
    error MarketLiability();
    error PoolLiability();
    error OracleUnavailable();
    error PriceDeviation();
    error BadReason();
    error BadRug();
    error BadReport();
    error StaleReport();
    error ZeroNav();
    error InsufficientShares();
    error InsufficientFreeCash();
    error RemoveExpired();
    error KeeperAlive();
    error BadMarket();
    error BadPool();
    error BadParams();
    error LowCardinality();
    error PoolCap();

    // ───────────────────────────── modifiers ─────────────────────────────

    // Modifier bodies live in internal functions so they are not inlined at every use (bytecode size).

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    modifier onlyKeeper() {
        _onlyKeeper();
        _;
    }

    modifier onlyOwnerOrKeeper() {
        _onlyOwnerOrKeeper();
        _;
    }

    modifier nonReentrant() {
        _enter();
        _;
        _locked = 1;
    }

    function _onlyOwner() internal view {
        if (msg.sender != owner) revert Unauthorized();
    }

    function _onlyKeeper() internal view {
        if (!isKeeper[msg.sender]) revert Unauthorized();
    }

    function _onlyOwnerOrKeeper() internal view {
        if (msg.sender != owner && !isKeeper[msg.sender]) revert Unauthorized();
    }

    function _enter() internal {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
    }

    // ───────────────────────────── constructor ─────────────────────────────

    /// @param weth WETH of the chain (v3 pools must pair the token with it).
    /// @param keeper Initial keeper (may be zero).
    constructor(address weth, address keeper) {
        if (weth == address(0)) revert BadParams();
        WETH = weth;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        if (keeper != address(0)) {
            isKeeper[keeper] = true;
            emit KeeperSet(keeper, true);
        }
        // Gas-capped: on a fork without Nitro precompiles (anvil/forge) 0x64 holds INVALID (0xfe), and an
        // uncapped call there burns 63/64 of the deploy gas.
        (bool ok, bytes memory ret) =
            ARBSYS.staticcall{gas: 50_000}(abi.encodeWithSelector(IArbSys.arbBlockNumber.selector));
        USE_ARBSYS = ok && ret.length == 32;

        Params storage p = _params;
        p.minStake = 0.001 ether;
        p.openFeeBps = 100;
        p.closeFeeBps = 100;
        p.referrerBps = 1000;
        p.prizeBps = 1000;
        p.opsBps = 500;
        p.maxWinBps = 20_000;
        p.rugCapBps = 2000;
        p.rugDropBps = 8000;
        p.rugWindowBlocks = 300;
        p.rugLock = 1 hours;
        p.minHold = 10;
        p.cancelDelay = 60;
        p.marketLiabilityBps = 500;
        p.totalLiabilityBps = 5000;
        p.twapWindow = 30;
        p.twapToleranceBps = 300;
        p.maxPriceAgeBlocks = 600;
        p.removeDelay = 24 hours;
        p.removeWindow = 24 hours;
        p.emergencyDelay = 24 hours;
        p.lpEmergencyDelay = 7 days;
        p.reportMaxAge = 1 hours;
        p.pauseLossBps = 1000;
        p.pauseWindow = 1 hours;
        p.pauseDuration = 1 hours;
        p.minExecDelayBlocks = 1;
        p.maxExecDelayBlocks = 600;
        p.emergencyTwapWindow = 900;
        _validateParams(p);

        _touchKeeper();
        windowStart = uint64(block.timestamp);
    }

    // ───────────────────────────── §2 money ─────────────────────────────

    /// @notice Plain native transfers are deposits, except from `rebateSource` (e.g. the chain's builder-revenue
    ///         share), which goes to the prize pot so it cannot get stuck as somebody's deposit.
    receive() external payable {
        if (msg.sender == rebateSource) {
            prizePool += msg.value;
            emit ToPrizePool(msg.sender, msg.value);
        } else {
            deposit();
        }
    }

    /// @notice Anyone may move untracked native (selfdestruct, coinbase, stray pushes) into the prize pot.
    function sweepSurplus() external nonReentrant {
        uint256 tracked = totalBalances + poolCash + totalEscrow + prizePool + opsBalance;
        uint256 bal = address(this).balance;
        if (bal <= tracked) revert ZeroAmount();
        prizePool += bal - tracked;
        emit ToPrizePool(address(this), bal - tracked);
    }

    /// @notice Credit msg.value to the caller's internal balance.
    function deposit() public payable {
        if (msg.value == 0) revert ZeroAmount();
        _credit(msg.sender, msg.value);
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Withdraw free internal balance. No keeper or operator involved.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _debit(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ───────────────────────────── §5 session keys ─────────────────────────────

    /// @notice Authorise `key` to open/close/cancel on the caller's internal balance until `expiry`
    ///         (<= 24 h ahead). `key == address(0)` revokes. A key can never withdraw or set keys for its owner.
    function setSessionKey(address key, uint64 expiry) external {
        if (key == address(0)) {
            delete sessionOf[msg.sender];
            emit SessionKeySet(msg.sender, address(0), 0);
            return;
        }
        if (key == msg.sender || expiry <= block.timestamp || expiry > block.timestamp + MAX_SESSION) {
            revert BadSessionKey();
        }
        sessionOf[msg.sender] = Session(key, expiry);
        emit SessionKeySet(msg.sender, key, expiry);
    }

    // ───────────────────────────── §4–§5 trading ─────────────────────────────

    /// @notice Request a position for msg.sender. Locks stake + open fee; the keeper fills at a later block.
    /// @param tp Take-profit price (WAD, 0 = none). @param sl Stop-loss price (WAD, 0 = none).
    /// @param referrer Recorded once per trader (first non-zero value wins).
    function requestOpen(
        uint256 marketId,
        bool isLong,
        uint8 leverage,
        uint256 stake,
        uint256 tp,
        uint256 sl,
        address referrer
    ) external nonReentrant returns (uint256) {
        return _requestOpen(msg.sender, OpenOrder(marketId, isLong, leverage, stake, tp, sl, referrer));
    }

    /// @notice Same as requestOpen, on behalf of `trader`; callable by the trader or its live session key.
    function requestOpenFor(
        address trader,
        uint256 marketId,
        bool isLong,
        uint8 leverage,
        uint256 stake,
        uint256 tp,
        uint256 sl,
        address referrer
    ) external nonReentrant returns (uint256) {
        _auth(trader);
        return _requestOpen(trader, OpenOrder(marketId, isLong, leverage, stake, tp, sl, referrer));
    }

    /// @notice Ask the keeper to close an open position (after the minimum hold).
    function requestClose(uint256 id) external nonReentrant {
        Position storage p = _positions[id];
        _auth(p.trader);
        if (p.status != Status.Open) revert BadStatus();
        if (block.timestamp < uint256(p.openTime) + _params.minHold) revert TooEarly();
        uint256 bn = _blockNumber();
        p.status = Status.PendingClose;
        p.requestBlock = uint64(bn);
        p.requestTime = uint64(block.timestamp);
        emit CloseRequested(id, msg.sender, bn);
    }

    /// @notice Cancel a pending request after `cancelDelay` of keeper silence.
    ///         Pending opens refund stake + fee (immediately if the market is closed or opens are paused);
    ///         pending closes revert to Open.
    function cancelRequest(uint256 id) external nonReentrant {
        Position storage p = _positions[id];
        _auth(p.trader);
        bool early = block.timestamp < uint256(p.requestTime) + _params.cancelDelay;
        if (p.status == Status.PendingOpen) {
            Market storage m = _markets[p.marketId];
            bool blocked = !m.enabled || m.lockedUntil > block.timestamp || !_opensAllowed();
            if (early && !blocked) revert TooEarly();
            _refundOpen(p);
            emit RequestCancelled(id, msg.sender, true);
        } else if (p.status == Status.PendingClose) {
            if (early) revert TooEarly();
            p.status = Status.Open;
            emit RequestCancelled(id, msg.sender, false);
        } else {
            revert BadStatus();
        }
    }

    // ───────────────────────────── §5–§9 keeper ─────────────────────────────

    /// @notice Fill a pending open.
    /// @param price Fill price (WAD), the worse of spot and 30-s average for the trader (engine rule).
    /// @param priceBlock L2 block the price is taken from: within [requestBlock + minExecDelayBlocks,
    ///        requestBlock + maxExecDelayBlocks], so the keeper cannot shop for a price across a long window.
    /// @param maxLeverage Highest leverage the market allows now (from D10); 0 = closed.
    /// @param notionalCap Max per-market per-side notional (stake * leverage), clamped to notionalCapMax.
    function executeOpen(uint256 id, uint256 price, uint256 priceBlock, uint8 maxLeverage, uint256 notionalCap)
        external
        onlyKeeper
        nonReentrant
    {
        Position storage p = _positions[id];
        if (p.status != Status.PendingOpen) revert BadStatus();
        _checkExecWindow(p.requestBlock, priceBlock);
        if (!_opensAllowed()) revert OpensDisabled();
        if (p.leverage > maxLeverage) revert BadLeverage();
        uint256 marketId = p.marketId;
        Market storage m = _markets[marketId];
        if (!m.enabled || m.lockedUntil > block.timestamp) revert MarketClosed();
        uint256 oracle;
        (price, oracle) = _price(m, marketId, price, p.isLong, true, OPEN_REASON);

        uint256 stake = p.stake;
        uint256 maxWin = stake * _params.maxWinBps / BPS;
        uint256 capMax = _params.notionalCapMax;
        if (capMax != 0 && notionalCap > capMax) notionalCap = capMax;
        _reserve(m, p.isLong, stake * p.leverage, maxWin, notionalCap);

        uint256 fee = p.openFee;
        p.status = Status.Open;
        p.openFee = 0;
        p.maxWin = uint128(maxWin);
        p.entryPrice = price;
        p.entryBlock = uint64(priceBlock);
        p.openTime = uint64(block.timestamp);
        totalEscrow -= fee;
        totalOpenStake += stake;
        _setLastPrice(m, price, priceBlock);
        _touchKeeper();
        _distributeFee(id, fee, referrerOf[p.trader]);
        emit PositionOpened(id, p.marketId, price, priceBlock, m.priceSource, oracle, maxWin);
    }

    /// @notice Close a position. USER needs a pending close request and a price after it; TP/SL/CAP/RUG
    ///         may be used on any open position when the price satisfies the condition. POOL_GONE closes
    ///         a disabled market at its lastPrice (the passed price is ignored). EMERGENCY is not allowed here.
    function executeClose(uint256 id, uint256 price, uint256 priceBlock, CloseReason reason)
        external
        onlyKeeper
        nonReentrant
    {
        Position storage p = _positions[id];
        Status st = p.status;
        if (st != Status.Open && st != Status.PendingClose) revert BadStatus();
        Market storage m = _markets[p.marketId];
        uint256 oracle;
        if (reason == CloseReason.POOL_GONE) {
            if (m.enabled) revert BadReason();
            price = m.lastPrice;
            priceBlock = m.lastPriceBlock;
        } else {
            if (reason == CloseReason.EMERGENCY) revert BadReason();
            if (priceBlock < p.entryBlock) revert BadPriceBlock();
            if (reason == CloseReason.USER) {
                if (st != Status.PendingClose) revert BadReason();
                _checkExecWindow(p.requestBlock, priceBlock);
            } else {
                _checkPriceBlock(priceBlock);
            }
            (price, oracle) = _price(m, p.marketId, price, p.isLong, false, uint8(reason));
            _checkReason(p, m, price, reason);
            _setLastPrice(m, price, priceBlock);
        }
        _touchKeeper();
        _settle(id, Fill(price, priceBlock, oracle, reason));
    }

    /// @notice Refuse a pending request (admission failed, limits hit, market locked...).
    ///         Opens are refunded in full; closes revert to Open.
    function rejectRequest(uint256 id, uint8 code) external onlyKeeper nonReentrant {
        Position storage p = _positions[id];
        bool wasOpen = p.status == Status.PendingOpen;
        if (wasOpen) {
            _refundOpen(p);
        } else if (p.status == Status.PendingClose) {
            p.status = Status.Open;
        } else {
            revert BadStatus();
        }
        _touchKeeper();
        emit RequestRejected(id, code, wasOpen);
    }

    /// @notice §8 rug guard: main-pool price fell >= rugDropBps within rugWindowBlocks. Locks the market
    ///         for rugLock (no opens, pending opens cancellable at once) and caps every short closed during
    ///         the lock at +rugCapBps. Both prices and blocks are emitted for off-chain verification.
    /// @dev v1.1: the prices are NOT stored as lastPrice. They are unchecked, and POOL_GONE / emergency closes
    ///      settle at lastPrice, so storing them let a keeper key pay any price around the band (review 06.11).
    ///      lastPrice now only comes from banded or TWAP-checked fills.
    function flagRug(uint256 marketId, uint256 priceBefore, uint256 blockBefore, uint256 priceAfter, uint256 blockAfter)
        external
        onlyKeeper
    {
        Market storage m = _market(marketId);
        if (blockAfter <= blockBefore || blockAfter - blockBefore > _params.rugWindowBlocks) revert BadRug();
        _checkPriceBlock(blockAfter);
        if (priceAfter == 0 || priceBefore > MAX_PRICE) revert BadPrice();
        if (priceAfter * BPS > priceBefore * (BPS - _params.rugDropBps)) revert BadRug();
        uint64 until = uint64(block.timestamp + _params.rugLock);
        m.lockedUntil = until;
        _touchKeeper();
        emit RugFlagged(marketId, priceBefore, blockBefore, priceAfter, blockAfter, m.priceSource, until);
    }

    /// @notice Keeper snapshot of traders' aggregate unrealized PnL (positive = pool owes). Bounded on-chain
    ///         to [-totalOpenStake, totalReserved].
    function reportUnrealized(int256 value, uint256 asOf) external onlyKeeper {
        if (asOf > block.timestamp || asOf < reportedAsOf) revert BadReport();
        if (value > int256(totalReserved) || value < -int256(totalOpenStake)) revert BadReport();
        reportedUnrealized = value;
        reportedAsOf = uint64(asOf);
        _touchKeeper();
        emit UnrealizedReported(value, asOf, poolCash, _nav());
    }

    // ───────────────────────────── §11 emergency ─────────────────────────────

    /// @notice After `emergencyDelay` without any keeper activity (by both clocks, see _keeperSilent) anyone may
    ///         close any open position: v3 markets at their `emergencyTwapWindow` TWAP (reverts while observe()
    ///         cannot answer; retry later — a short TWAP could be held off by a manipulator), other markets at
    ///         lastPrice. Proceeds go to internal balances.
    function emergencyClose(uint256 id) external nonReentrant {
        if (!_keeperSilent(_params.emergencyDelay)) revert KeeperAlive();
        Position storage p = _positions[id];
        if (p.status != Status.Open && p.status != Status.PendingClose) revert BadStatus();
        Market storage m = _markets[p.marketId];
        uint256 price = m.lastPrice;
        uint256 priceBlock = m.lastPriceBlock;
        uint256 oracle;
        if (m.v3Pool != address(0)) {
            (bool ok, uint256 twap) = _twapPrice(m, _params.emergencyTwapWindow);
            if (!ok || twap == 0 || twap > MAX_PRICE) revert OracleUnavailable();
            price = twap;
            priceBlock = _blockNumber();
            oracle = twap;
        }
        _settle(id, Fill(price, priceBlock, oracle, CloseReason.EMERGENCY));
    }

    // ───────────────────────────── §9 LP pool ─────────────────────────────

    /// @notice Deposit ETH into the house pool for shares at current NAV.
    ///         With open positions a fresh unrealized-PnL report is required (no minting at a stale NAV).
    function addLiquidity() external payable nonReentrant returns (uint256 shares) {
        uint256 amount = msg.value;
        if (amount == 0) revert ZeroAmount();
        if (lpGate && !lpAllowed[msg.sender]) revert Unauthorized();
        uint256 cap = _params.maxPoolCash;
        if (cap != 0 && poolCash + amount > cap) revert PoolCap();
        uint256 ts = totalShares;
        uint256 navBefore;
        if (ts == 0) {
            if (amount <= DEAD_SHARES) revert ZeroAmount();
            shares = amount - DEAD_SHARES;
            sharesOf[address(0)] = DEAD_SHARES; // inflation guard
            totalShares = amount;
        } else {
            if (totalReserved != 0 && !_reportFresh()) revert StaleReport();
            navBefore = _nav();
            if (navBefore == 0) revert ZeroNav();
            shares = FullMath.mulDiv(amount, ts, navBefore);
            if (shares == 0) revert ZeroAmount();
            totalShares = ts + shares;
        }
        sharesOf[msg.sender] += shares;
        uint256 cash = poolCash;
        poolCash = cash + amount;
        _rescaleWindow(cash, cash + amount);
        emit LiquidityAdded(msg.sender, amount, shares, navBefore);
    }

    /// @notice Escrow shares for withdrawal; executable after removeDelay at the NAV of that moment.
    function requestRemove(uint256 shares) external nonReentrant returns (uint256 rid) {
        uint256 have = sharesOf[msg.sender];
        if (shares == 0 || shares > have) revert InsufficientShares();
        sharesOf[msg.sender] = have - shares;
        rid = ++removeCount;
        removeRequests[rid] = RemoveRequest(msg.sender, uint128(shares), uint64(block.timestamp));
        emit RemoveRequested(rid, msg.sender, shares, block.timestamp + _params.removeDelay);
    }

    /// @notice Redeem escrowed shares at current NAV into the LP's internal balance, within removeWindow after
    ///         removeDelay (an expired request must be cancelled and made again). Delay and expiry are waived
    ///         after lpEmergencyDelay of keeper silence. Cannot dip into cash reserved for open max-wins.
    function executeRemove(uint256 rid) external nonReentrant returns (uint256 amount) {
        RemoveRequest memory r = removeRequests[rid];
        if (r.lp != msg.sender) revert Unauthorized();
        bool keeperGone = _keeperSilent(_params.lpEmergencyDelay);
        if (!keeperGone) {
            uint256 ready = uint256(r.time) + _params.removeDelay;
            if (block.timestamp < ready) revert TooEarly();
            if (block.timestamp > ready + _params.removeWindow) revert RemoveExpired();
        }
        uint256 navNow = _nav();
        amount = FullMath.mulDiv(r.shares, navNow, totalShares);
        uint256 cash = poolCash;
        if (amount + totalReserved > cash) revert InsufficientFreeCash();
        delete removeRequests[rid];
        totalShares -= r.shares;
        poolCash = cash - amount;
        _rescaleWindow(cash, cash - amount);
        _credit(msg.sender, amount);
        emit RemoveExecuted(rid, msg.sender, r.shares, amount, navNow);
    }

    /// @notice Return escrowed shares.
    function cancelRemove(uint256 rid) external nonReentrant {
        RemoveRequest memory r = removeRequests[rid];
        if (r.lp != msg.sender) revert Unauthorized();
        delete removeRequests[rid];
        sharesOf[msg.sender] += r.shares;
        emit RemoveCancelled(rid, msg.sender, r.shares);
    }

    // ───────────────────────────── markets ─────────────────────────────

    /// @notice Register a token. `v3Pool` (optional) must be a WETH pair from an approved factory; it enables
    ///         the on-chain TWAP check. `priceSource` identifies the main pool for events (v4 PoolId etc.);
    ///         defaults to the v3 pool address.
    function addMarket(address token, uint8 decimals, address v3Pool, bytes32 priceSource)
        external
        onlyOwnerOrKeeper
        returns (uint256 id)
    {
        if (token == address(0) || token == WETH || marketIdOf[token] != 0 || decimals > 36) revert BadMarket();
        id = ++marketCount;
        marketIdOf[token] = id;
        Market storage m = _markets[id];
        m.token = token;
        m.decimals = decimals;
        m.enabled = true;
        _setPool(m, v3Pool, priceSource);
        emit MarketAdded(id, token, decimals);
        emit MarketUpdated(id, m.v3Pool, m.tokenIsToken0, m.priceSource, true);
    }

    /// @notice Change the main pool. A keeper may only swap one verified v3 pool for another; switching between
    ///         the v3 TWAP check and the default adapter's band (either way) is the owner's call — otherwise a
    ///         keeper key could swap a v4 market's band for a dust v3 pool it controls (review 06.11).
    function setMarketSource(uint256 marketId, address v3Pool, bytes32 priceSource) external onlyOwnerOrKeeper {
        Market storage m = _market(marketId);
        if ((v3Pool == address(0)) != (m.v3Pool == address(0)) && msg.sender != owner) revert Unauthorized();
        _setPool(m, v3Pool, priceSource);
        emit MarketUpdated(marketId, m.v3Pool, m.tokenIsToken0, m.priceSource, m.enabled);
    }

    /// @notice Enable/disable new opens on a market. Disabled markets can be closed with POOL_GONE.
    function setMarketEnabled(uint256 marketId, bool enabled) external onlyOwnerOrKeeper {
        Market storage m = _market(marketId);
        m.enabled = enabled;
        emit MarketUpdated(marketId, m.v3Pool, m.tokenIsToken0, m.priceSource, enabled);
    }

    // ───────────────────────────── owner ─────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        isKeeper[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    /// @notice Approve a v3-style factory for pool verification (kind 1 = fee-keyed, 2 = tickSpacing-keyed, 0 = off).
    function setFactory(address factory, uint8 kind) external onlyOwner {
        if (kind > FACTORY_CL) revert BadParams();
        factoryKind[factory] = kind;
        emit FactorySet(factory, kind);
    }

    function setParams(Params calldata p) external onlyOwner {
        _validateParams(p);
        _params = p;
        emit ParamsUpdated(keccak256(msg.data[4:]));
    }

    /// @notice Owner switch for new opens; the guardian may only switch them off. Closes, cancels, withdrawals
    ///         always work.
    function setPaused(bool p) external {
        if (msg.sender != owner && !(p && msg.sender == guardian)) revert Unauthorized();
        paused = p;
        emit PausedSet(p);
    }

    /// @notice v1.1 roles. The owner is meant to be a multisig behind a timelock; the guardian is the fast stop.
    ///         `defaultAdapter` (e.g. V4SpotSource) bands the keeper price of every market without a v3 pool,
    ///         so new v4 coins list without a timelock round per market.
    function setRoles(address guardian_, address treasury_, address rebateSource_, address defaultAdapter_)
        external
        onlyOwner
    {
        guardian = guardian_;
        treasury = treasury_;
        rebateSource = rebateSource_;
        defaultAdapter = defaultAdapter_;
        emit RolesSet(guardian_, treasury_, rebateSource_, defaultAdapter_);
    }

    /// @notice Attach (or with 0 detach) an IPriceSource that checks or sets every keeper fill of the market.
    function setPriceAdapter(uint256 marketId, address adapter) external onlyOwner {
        _market(marketId).priceAdapter = adapter;
        emit PriceAdapterSet(marketId, adapter);
    }

    /// @notice Guarded launch. `lp == address(0)` switches the gate itself (while on, only allowed addresses may
    ///         add liquidity); any other `lp` is allowed or removed.
    function setLpAllowed(address lp, bool allowed) external onlyOwner {
        if (lp == address(0)) lpGate = allowed;
        else lpAllowed[lp] = allowed;
        emit LpAllowedSet(lp, allowed);
    }

    function clearLossPause() external onlyOwner {
        opensPausedUntil = 0;
        emit LossPauseCleared();
    }

    /// @notice Pay the weekly contest from the prize pot into internal balances.
    function distributePrizes(address[] calldata winners, uint256[] calldata amounts) external onlyOwner nonReentrant {
        if (winners.length != amounts.length) revert BadParams();
        uint256 total;
        for (uint256 i; i < winners.length; ++i) {
            if (winners[i] == address(0)) revert BadParams();
            total += amounts[i];
            _credit(winners[i], amounts[i]);
            emit PrizePaid(winners[i], amounts[i]);
        }
        if (total > prizePool) revert InsufficientBalance();
        prizePool -= total;
    }

    /// @notice Withdraw the ops share (keeper gas, KNTQ buybacks) — only to a keeper or the treasury.
    function withdrawOps(address payable to, uint256 amount) external onlyOwner nonReentrant {
        if (!isKeeper[to] && (to != treasury || to == address(0))) revert Unauthorized();
        if (amount > opsBalance) revert InsufficientBalance();
        opsBalance -= amount;
        emit OpsWithdrawn(to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ───────────────────────────── views ─────────────────────────────

    function getParams() external view returns (Params memory) {
        return _params;
    }

    function getMarket(uint256 marketId) external view returns (Market memory) {
        return _markets[marketId];
    }

    function getPosition(uint256 id) external view returns (Position memory) {
        return _positions[id];
    }

    /// @notice Pool value: poolCash - unrealized (fresh report, clamped) or poolCash - totalReserved (stale).
    function nav() external view returns (uint256) {
        return _nav();
    }

    // v1.1 removed liabilityBase() = min(poolCash, nav()) and lpValue(lp) = sharesOf[lp] * nav() / totalShares
    // to make room in the 24 576-byte limit; compute them off-chain from the public getters.

    function opensAllowed() external view returns (bool) {
        return _opensAllowed();
    }

    /// @notice L2 block number used for request/price blocks (ArbSys on Nitro, block.number elsewhere).
    function blockNumber() external view returns (uint256) {
        return _blockNumber();
    }

    function isSessionKey(address trader, address key) external view returns (bool) {
        return _isSession(trader, key);
    }

    /// @notice v3 TWAP price (WAD) of a market over twapWindow; ok = false if no pool or observe() fails.
    function oraclePrice(uint256 marketId) external view returns (bool ok, uint256 price) {
        Market storage m = _markets[marketId];
        if (m.v3Pool == address(0)) return (false, 0);
        return _twapPrice(m, _params.twapWindow);
    }

    /// @notice Clamped PnL, payout and close fee of a position at `price` (ignores rug cap).
    function previewClose(uint256 id, uint256 price) external view returns (int256 pnl, uint256 payout, uint256 fee) {
        Position storage p = _positions[id];
        if (p.entryPrice == 0 || price == 0 || price > MAX_PRICE) return (0, 0, 0);
        pnl = _pnl(p, price);
        uint256 gross = uint256(int256(uint256(p.stake)) + pnl);
        fee = gross * _params.closeFeeBps / BPS;
        payout = gross - fee;
    }

    /// @notice address(this).balance minus all tracked buckets; must never be negative.
    function accountingSurplus() external view returns (int256) {
        return int256(address(this).balance)
            - int256(totalBalances + poolCash + totalEscrow + prizePool + opsBalance);
    }

    // ───────────────────────────── internal: trading ─────────────────────────────

    function _requestOpen(address trader, OpenOrder memory o) internal returns (uint256 id) {
        if (!_opensAllowed()) revert OpensDisabled();
        Market storage m = _market(o.marketId);
        if (!m.enabled || m.lockedUntil > block.timestamp) revert MarketClosed();
        if (o.leverage != 2 && o.leverage != 5 && o.leverage != 10) revert BadLeverage();
        if (o.stake < _params.minStake || o.stake > MAX_STAKE) revert BadStake();
        if (o.tp > MAX_PRICE || o.sl > MAX_PRICE) revert BadPrice();

        uint256 fee = o.stake * _params.openFeeBps / BPS;
        _debit(trader, o.stake + fee);
        totalEscrow += o.stake + fee;

        // Only the trader may bind a referrer: a session key must not tie its owner to itself for good.
        if (o.referrer != address(0) && o.referrer != trader && msg.sender == trader && referrerOf[trader] == address(0))
        {
            referrerOf[trader] = o.referrer;
            emit ReferrerSet(trader, o.referrer);
        }

        id = ++positionCount;
        Position storage p = _positions[id];
        p.trader = trader;
        p.marketId = uint32(o.marketId);
        p.isLong = o.isLong;
        p.leverage = o.leverage;
        p.status = Status.PendingOpen;
        p.stake = uint96(o.stake);
        p.openFee = uint96(fee);
        p.requestBlock = uint64(_blockNumber());
        p.requestTime = uint64(block.timestamp);
        p.tp = o.tp;
        p.sl = o.sl;
        emit OpenRequested(id, trader, o.marketId, o.isLong, o.leverage, o.stake, fee, o.tp, o.sl, p.requestBlock);
    }

    /// @dev Enforces keeper notional cap and the 5 % / 50 % max-win limits, then books the reservation.
    function _reserve(Market storage m, bool isLong, uint256 notional, uint256 maxWin, uint256 notionalCap) internal {
        uint256 base = _liabilityBase();
        uint256 sideNotional = (isLong ? m.notionalLong : m.notionalShort) + notional;
        if (sideNotional > notionalCap) revert NotionalCap();
        uint256 sideWin = (isLong ? m.maxWinLong : m.maxWinShort) + maxWin;
        if (sideWin * BPS > base * _params.marketLiabilityBps) revert MarketLiability();
        uint256 total = totalReserved + maxWin;
        if (total * BPS > base * _params.totalLiabilityBps) revert PoolLiability();
        if (isLong) {
            m.notionalLong = sideNotional;
            m.maxWinLong = sideWin;
        } else {
            m.notionalShort = sideNotional;
            m.maxWinShort = sideWin;
        }
        totalReserved = total;
    }

    function _release(Market storage m, bool isLong, uint256 notional, uint256 maxWin) internal {
        if (isLong) {
            m.notionalLong -= notional;
            m.maxWinLong -= maxWin;
        } else {
            m.notionalShort -= notional;
            m.maxWinShort -= maxWin;
        }
        totalReserved -= maxWin;
    }

    /// @dev Validates a keeper close reason against the passed price.
    function _checkReason(Position storage p, Market storage m, uint256 price, CloseReason reason) internal view {
        if (reason == CloseReason.USER) return;
        bool isLong = p.isLong;
        if (reason == CloseReason.TP) {
            uint256 tp = p.tp;
            if (tp == 0 || (isLong ? price < tp : price > tp)) revert BadReason();
            if (block.timestamp < uint256(p.openTime) + _params.minHold) revert TooEarly();
        } else if (reason == CloseReason.SL) {
            uint256 sl = p.sl;
            if (sl == 0 || (isLong ? price > sl : price < sl)) revert BadReason();
        } else if (reason == CloseReason.CAP_WIN) {
            (bool gain, uint256 mag) = _rawPnl(p, price);
            if (!gain || mag < p.maxWin) revert BadReason();
        } else if (reason == CloseReason.CAP_LOSS) {
            (bool gain, uint256 mag) = _rawPnl(p, price);
            if (gain || mag < p.stake) revert BadReason();
        } else if (reason == CloseReason.RUG) {
            if (isLong || m.lockedUntil <= block.timestamp) revert BadReason();
        } else {
            revert BadReason();
        }
    }

    /// @dev Books the close: releases reservations, moves PnL between pool and trader, charges the close fee.
    function _settle(uint256 id, Fill memory f) internal {
        Position storage p = _positions[id];
        Market storage m = _markets[p.marketId];
        uint256 stake = p.stake;
        int256 pnl = _pnl(p, f.price);
        if (!p.isLong && m.lockedUntil > block.timestamp) {
            int256 cap = int256(stake * _params.rugCapBps / BPS);
            if (pnl > cap) pnl = cap;
        }

        p.status = Status.Closed;
        _release(m, p.isLong, stake * p.leverage, p.maxWin);
        totalOpenStake -= stake;
        totalEscrow -= stake;
        // The last report still holds this position's PnL; once realized into poolCash it must leave the report,
        // or NAV counts it twice until the next report (realized PnL stands in for the PnL at report time).
        if (p.openTime <= reportedAsOf) reportedUnrealized -= pnl;
        _poolDelta(-pnl); // pool pays winners / keeps losses; solvent because poolCash >= totalReserved

        uint256 gross = uint256(int256(stake) + pnl);
        uint256 fee = gross * _params.closeFeeBps / BPS;
        _credit(p.trader, gross - fee);
        _distributeFee(id, fee, referrerOf[p.trader]);
        emit PositionClosed(
            id, p.marketId, f.reason, f.price, f.priceBlock, m.priceSource, f.oracle, pnl, gross - fee
        );
    }

    function _refundOpen(Position storage p) internal {
        uint256 amount = uint256(p.stake) + p.openFee;
        p.status = Status.Cancelled;
        p.openFee = 0;
        totalEscrow -= amount;
        _credit(p.trader, amount);
    }

    /// @dev Fee split: referrer / prize / ops by bps, the remainder (75 % or 85 % without referrer) to the pool.
    function _distributeFee(uint256 id, uint256 fee, address ref) internal {
        if (fee == 0) return;
        uint256 toRef = ref == address(0) ? 0 : fee * _params.referrerBps / BPS;
        uint256 toPrize = fee * _params.prizeBps / BPS;
        uint256 toOps = fee * _params.opsBps / BPS;
        uint256 toPool = fee - toRef - toPrize - toOps;
        if (toRef != 0) _credit(ref, toRef);
        prizePool += toPrize;
        opsBalance += toOps;
        _poolDelta(int256(toPool));
        emit FeeSplit(id, fee, toPool, ref, toRef, toPrize, toOps);
    }

    /// @dev Applies a realized pool gain/loss and trips the loss pause (> pauseLossBps of the window base).
    function _poolDelta(int256 d) internal {
        if (block.timestamp >= uint256(windowStart) + _params.pauseWindow || windowBase == 0) {
            windowStart = uint64(block.timestamp);
            windowBase = poolCash;
            windowNet = 0;
        }
        if (d >= 0) poolCash += uint256(d);
        else poolCash -= uint256(-d);
        int256 net = windowNet + d;
        windowNet = net;
        uint256 base = windowBase;
        if (net < 0 && base != 0 && uint256(-net) * BPS > base * _params.pauseLossBps) {
            uint64 until = uint64(block.timestamp + _params.pauseDuration);
            if (until > opensPausedUntil) {
                opensPausedUntil = until;
                emit OpensPaused(until, net, base);
            }
        }
    }

    /// @dev LP deposits/exits inside a live loss window scale its base and net together, so the pause keeps
    ///      measuring the loss of capital that was in the pool (a big exit must not dilute the -10 % trigger).
    function _rescaleWindow(uint256 cashBefore, uint256 cashAfter) internal {
        uint256 base = windowBase;
        if (base == 0 || cashBefore == 0 || block.timestamp >= uint256(windowStart) + _params.pauseWindow) return;
        windowBase = FullMath.mulDiv(base, cashAfter, cashBefore);
        int256 net = windowNet;
        uint256 mag = FullMath.mulDiv(net < 0 ? uint256(-net) : uint256(net), cashAfter, cashBefore);
        windowNet = net < 0 ? -int256(mag) : int256(mag);
    }

    // ───────────────────────────── internal: pricing ─────────────────────────────

    /// @dev Clamped PnL = stake * lev * (exit/entry - 1) * side, in [-stake, +maxWin].
    function _pnl(Position storage p, uint256 price) internal view returns (int256) {
        (bool gain, uint256 mag) = _rawPnl(p, price);
        if (gain) {
            uint256 cap = p.maxWin;
            return int256(mag > cap ? cap : mag);
        }
        uint256 stake = p.stake;
        return -int256(mag > stake ? stake : mag);
    }

    /// @dev Unclamped |PnL| and its sign. stake < 2^96, lev <= 10, prices <= 2^128: no overflow.
    function _rawPnl(Position storage p, uint256 price) internal view returns (bool gain, uint256 mag) {
        uint256 entry = p.entryPrice;
        bool up = price >= entry;
        uint256 diff = up ? price - entry : entry - price;
        mag = uint256(p.stake) * p.leverage * diff / entry;
        gain = (up == p.isLong) && mag != 0;
    }

    /// @dev Fill price for a keeper action: the market's IPriceSource (if set) checks or replaces the keeper
    ///      price; then the range check and, for v3 markets, the twapToleranceBps check against the TWAP.
    ///      Returns the price to book and the reference emitted as oraclePrice (TWAP, else the adapter's ref).
    function _price(Market storage m, uint256 marketId, uint256 price, bool isLong, bool isOpen, uint8 reason)
        internal
        view
        returns (uint256 fill, uint256 ref)
    {
        address a = m.priceAdapter;
        if (a == address(0) && m.v3Pool == address(0)) a = defaultAdapter;
        if (a != address(0)) (price, ref) = IPriceSource(a).quote(marketId, price, isLong, isOpen, reason);
        if (price == 0 || price > MAX_PRICE) revert BadPrice();
        fill = price;
        if (m.v3Pool == address(0)) return (fill, ref);
        (bool ok, uint256 twap) = _twapPrice(m, _params.twapWindow);
        if (!ok || twap == 0) revert OracleUnavailable();
        uint256 d = price > twap ? price - twap : twap - price;
        if (d > FullMath.mulDiv(twap, _params.twapToleranceBps, BPS)) revert PriceDeviation();
        ref = twap;
    }

    /// @dev Arithmetic-mean tick over `window` seconds via observe([window, 0]) -> WAD price of 1 whole token in ETH.
    function _twapPrice(Market storage m, uint256 window_) internal view returns (bool ok, uint256 price) {
        uint32 window = uint32(window_); // <= 1 h by _validateParams
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        try IV3PoolLike(m.v3Pool).observe(ago) returns (int56[] memory cum, uint160[] memory) {
            if (cum.length != 2) return (false, 0);
            int56 w = int56(uint56(window));
            int56 delta = cum[1] - cum[0];
            int56 t = delta / w;
            if (delta < 0 && delta % w != 0) t--;
            if (t < TickMath.MIN_TICK || t > TickMath.MAX_TICK) return (false, 0);
            return (true, _quoteAtTick(int24(t), m.decimals, m.tokenIsToken0));
        } catch {
            return (false, 0);
        }
    }

    /// @dev WETH wei for 10**decimals token units at `tick` (OracleLibrary.getQuoteAtTick).
    function _quoteAtTick(int24 tick, uint8 decimals, bool tokenIsToken0) internal pure returns (uint256) {
        uint160 sqrtP = TickMath.getSqrtRatioAtTick(tick);
        uint256 baseAmount = 10 ** uint256(decimals);
        if (sqrtP <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtP) * sqrtP;
            return tokenIsToken0
                ? FullMath.mulDiv(ratioX192, baseAmount, 1 << 192)
                : FullMath.mulDiv(1 << 192, baseAmount, ratioX192);
        }
        uint256 ratioX128 = FullMath.mulDiv(sqrtP, sqrtP, 1 << 64);
        return tokenIsToken0
            ? FullMath.mulDiv(ratioX128, baseAmount, 1 << 128)
            : FullMath.mulDiv(1 << 128, baseAmount, ratioX128);
    }

    function _setLastPrice(Market storage m, uint256 price, uint256 priceBlock) internal {
        if (priceBlock < m.lastPriceBlock) return; // keep the newest by block
        m.lastPrice = price;
        m.lastPriceBlock = uint64(priceBlock);
        m.lastPriceTime = uint64(block.timestamp);
    }

    /// @dev Pool must be token/WETH and registered at an approved factory under its own fee/tickSpacing.
    function _setPool(Market storage m, address pool, bytes32 source) internal {
        if (pool != address(0)) {
            m.tokenIsToken0 = _verifyPool(pool, m.token);
            if (source == bytes32(0)) source = bytes32(uint256(uint160(pool)));
        }
        m.v3Pool = pool;
        m.priceSource = source;
    }

    function _verifyPool(address pool, address token) internal view returns (bool tokenIsToken0) {
        IV3PoolLike pl = IV3PoolLike(pool);
        address f = pl.factory();
        uint8 kind = factoryKind[f];
        address t0 = pl.token0();
        address t1 = pl.token1();
        if (t0 == token && t1 == WETH) tokenIsToken0 = true;
        else if (!(t0 == WETH && t1 == token)) revert BadPool();
        address real;
        if (kind == FACTORY_V3) real = IV3FactoryLike(f).getPool(t0, t1, pl.fee());
        else if (kind == FACTORY_CL) real = ICLFactoryLike(f).getPool(t0, t1, pl.tickSpacing());
        else revert BadPool();
        if (real != pool) revert BadPool();
        // Uniswap v3 and Slipstream write one observation per second: the emergency TWAP needs window + 1 slots.
        // Word 4 of slot0 is observationCardinalityNext in both layouts. Anyone can raise it before listing.
        (bool ok, bytes memory s0) = pool.staticcall(abi.encodeWithSignature("slot0()"));
        uint256 next;
        if (ok && s0.length >= 160) {
            assembly ("memory-safe") {
                next := mload(add(s0, 160))
            }
        }
        if (next <= _params.emergencyTwapWindow) revert LowCardinality();
    }

    // ───────────────────────────── internal: misc ─────────────────────────────

    function _nav() internal view returns (uint256) {
        int256 u;
        if (_reportFresh()) {
            u = reportedUnrealized;
            int256 hi = int256(totalReserved);
            int256 lo = -int256(totalOpenStake);
            if (u > hi) u = hi;
            else if (u < lo) u = lo;
        } else {
            u = int256(totalReserved); // conservative: every open position at its max win
        }
        int256 n = int256(poolCash) - u;
        return n > 0 ? uint256(n) : 0;
    }

    function _liabilityBase() internal view returns (uint256) {
        uint256 n = _nav();
        uint256 c = poolCash;
        return n < c ? n : c;
    }

    function _reportFresh() internal view returns (bool) {
        return reportedAsOf != 0 && block.timestamp <= uint256(reportedAsOf) + _params.reportMaxAge;
    }

    function _opensAllowed() internal view returns (bool) {
        return !paused && block.timestamp >= opensPausedUntil;
    }

    function _checkPriceBlock(uint256 priceBlock) internal view {
        uint256 bn = _blockNumber();
        if (priceBlock > bn || bn - priceBlock > _params.maxPriceAgeBlocks) revert BadPriceBlock();
    }

    /// @dev Price of an open / USER close must come from [requestBlock + minExecDelay, requestBlock + maxExecDelay]
    ///      and be fresh. Nobody knows that price when the request lands, and the keeper can't pick it from a minute.
    function _checkExecWindow(uint256 requestBlock, uint256 priceBlock) internal view {
        if (
            priceBlock < requestBlock + _params.minExecDelayBlocks
                || priceBlock > requestBlock + _params.maxExecDelayBlocks
        ) revert BadPriceBlock();
        _checkPriceBlock(priceBlock);
    }

    function _blockNumber() internal view returns (uint256) {
        return USE_ARBSYS ? IArbSys(ARBSYS).arbBlockNumber() : block.number;
    }

    function _touchKeeper() internal {
        lastKeeperActivity = uint64(block.timestamp);
        lastKeeperBlock = uint64(_blockNumber());
    }

    /// @dev Keeper silent for `delay` seconds AND (with keeperBlockRate on) for delay * rate / 3600 L2 blocks. A
    ///      stalled sequencer moves the clock on resume but produces no blocks, so its downtime is not keeper
    ///      silence. Nitro only builds blocks for transactions, so the rate is a floor per hour and set low.
    function _keeperSilent(uint256 delay) internal view returns (bool) {
        if (block.timestamp < uint256(lastKeeperActivity) + delay) return false;
        uint256 rate = _params.keeperBlockRate;
        return rate == 0 || _blockNumber() >= uint256(lastKeeperBlock) + delay * rate / 3600;
    }

    function _market(uint256 marketId) internal view returns (Market storage m) {
        m = _markets[marketId];
        if (m.token == address(0)) revert UnknownMarket();
    }

    function _isSession(address trader, address key) internal view returns (bool) {
        Session memory s = sessionOf[trader];
        return s.key == key && key != address(0) && s.expiry >= block.timestamp;
    }

    function _auth(address trader) internal view {
        if (trader == address(0) || (msg.sender != trader && !_isSession(trader, msg.sender))) revert Unauthorized();
    }

    function _credit(address a, uint256 amount) internal {
        balanceOf[a] += amount;
        totalBalances += amount;
    }

    function _debit(address a, uint256 amount) internal {
        uint256 b = balanceOf[a];
        if (b < amount) revert InsufficientBalance();
        balanceOf[a] = b - amount;
        totalBalances -= amount;
    }

    function _validateParams(Params memory p) internal pure {
        if (p.minStake == 0 || p.openFeeBps > 500 || p.closeFeeBps > 500) revert BadParams();
        if (uint256(p.referrerBps) + p.prizeBps + p.opsBps > BPS) revert BadParams();
        // Upper bounds below also keep the close path free of overflows, so a bad setParams cannot brick closes.
        if (p.maxWinBps == 0 || p.maxWinBps > 100_000 || p.rugCapBps > p.maxWinBps) revert BadParams();
        if (p.rugDropBps == 0 || p.rugDropBps >= BPS || p.rugWindowBlocks == 0 || p.rugLock > 1 days) revert BadParams();
        if (p.marketLiabilityBps > p.totalLiabilityBps || p.totalLiabilityBps > BPS) revert BadParams();
        if (p.twapWindow == 0 || p.twapWindow > 1 hours || p.twapToleranceBps > 2000) revert BadParams();
        if (p.maxPriceAgeBlocks == 0 || p.minHold > 1 hours || p.cancelDelay > 1 hours) revert BadParams();
        if (p.removeDelay > 7 days || p.removeWindow < 1 hours || p.removeWindow > 7 days) revert BadParams();
        if (p.emergencyDelay < 1 hours || p.emergencyDelay > 7 days) revert BadParams();
        if (p.lpEmergencyDelay > 30 days || p.reportMaxAge == 0 || p.reportMaxAge > 1 days) revert BadParams();
        if (p.pauseWindow == 0 || p.pauseWindow > 1 days || p.pauseDuration > 7 days || p.pauseLossBps > BPS) {
            revert BadParams();
        }
        if (p.minExecDelayBlocks == 0 || p.maxExecDelayBlocks < p.minExecDelayBlocks) revert BadParams();
        if (p.maxExecDelayBlocks > 100_000 || p.keeperBlockRate > 360_000) revert BadParams();
        if (p.emergencyTwapWindow < p.twapWindow || p.emergencyTwapWindow > 1 hours) revert BadParams();
    }
}
