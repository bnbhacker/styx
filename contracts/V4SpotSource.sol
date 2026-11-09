// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InversePool, IPriceSource, FullMath} from "./InversePool.sol";

/// @notice Uniswap v4 PoolManager exposes its storage through extsload.
interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @title V4SpotSource
/// @notice v1.1 price band for markets priced from a Uniswap v4 pool (launchpad memecoins on Elysium). It does not
///         price anything itself: it reads the pool's current sqrtPrice and refuses a keeper price that is more
///         than `favBps` better for the trader, or more than `worseBps` worse, than that spot. Defensive closes
///         (SL, CAP_WIN, CAP_LOSS, RUG) use the tighter `defensiveWorseBps`, so with InversePool's own trigger check
///         the spot itself must be within that distance of the trigger. A band catches forged prices; it is not
///         an oracle (a keeper can still pick a price inside it), see STYX-ELYSIUM.md §3.3.
/// @dev Feeds are set by a keeper of the pool, but only for a full PoolKey whose hook the pool's owner allowed,
///      with the market's token against native HYPE or the pool's WETH. The PoolId is derived here, so a keeper
///      cannot point a market at a pool of some other token. The key's `fee` is not checked: Elysium launchpad
///      pools declare fee 0 and take their fee inside the hook (checked 06.11.2026 on every 0xd492…/0xda60… pool),
///      so the hook allowlist is the gate and the keeper sizes notional from the hook's real fee.
contract V4SpotSource is IPriceSource {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct Feed {
        address manager;
        bytes32 poolId;
        bool tokenIs0;
        uint8 decimals;
    }

    uint256 internal constant BPS = 10_000;
    uint256 internal constant POOLS_SLOT = 6; // PoolManager: mapping(PoolId => Pool.State) _pools (checked on Elysium)
    uint8 internal constant OPEN_REASON = 255;
    uint8 internal constant REASON_USER = 0;
    uint8 internal constant REASON_TP = 1;

    InversePool public immutable POOL;
    address public immutable WETH;

    uint16 public favBps = 200; // keeper price at most 2 % better for the trader than spot
    uint16 public worseBps = 500; // ... and at most 5 % worse (opens, USER and TP closes)
    uint16 public defensiveWorseBps = 300; // SL / CAP / RUG: at most 3 % worse

    mapping(address => mapping(address => bool)) public hookAllowed; // manager => hooks => allowed
    mapping(uint256 => Feed) public feeds; // InversePool marketId => feed

    event HookAllowed(address indexed manager, address indexed hooks, bool allowed);
    event FeedSet(uint256 indexed marketId, address indexed manager, bytes32 poolId, bool tokenIs0, uint8 decimals);
    event BandsSet(uint16 favBps, uint16 worseBps, uint16 defensiveWorseBps);

    error Unauthorized();
    error BadKey();
    error NoFeed();
    error NoSpot();
    error OutOfBand();
    error BadBands();

    constructor(InversePool pool) {
        POOL = pool;
        WETH = pool.WETH();
    }

    // ───────────── admin ─────────────

    /// @dev The pool's owner (multisig behind the timelock) governs the adapter too: one trust root.
    modifier onlyPoolOwner() {
        if (msg.sender != POOL.owner()) revert Unauthorized();
        _;
    }

    function setHookAllowed(address manager, address hooks, bool allowed) external onlyPoolOwner {
        hookAllowed[manager][hooks] = allowed;
        emit HookAllowed(manager, hooks, allowed);
    }

    function setBands(uint16 fav, uint16 worse, uint16 defensiveWorse) external onlyPoolOwner {
        if (fav > 1000 || worse > 2000 || defensiveWorse > worse) revert BadBands();
        favBps = fav;
        worseBps = worse;
        defensiveWorseBps = defensiveWorse;
        emit BandsSet(fav, worse, defensiveWorse);
    }

    /// @notice Point a market at its main v4 pool. A keeper may set a market's first feed (listing is its job);
    ///         re-pointing a live feed is the owner's call, or a keeper key could move the band's reference to a
    ///         thin pool of its own under an allowed hook (review 06.11).
    function setFeed(uint256 marketId, address manager, PoolKey calldata key) external {
        bool isOwner = msg.sender == POOL.owner();
        if (!isOwner && (!POOL.isKeeper(msg.sender) || feeds[marketId].manager != address(0))) revert Unauthorized();
        if (!hookAllowed[manager][key.hooks]) revert BadKey();
        InversePool.Market memory m = POOL.getMarket(marketId);
        address token = m.token;
        uint8 decimals = m.decimals;
        if (token == address(0)) revert BadKey();
        bool tokenIs0;
        if (key.currency1 == token && (key.currency0 == address(0) || key.currency0 == WETH)) tokenIs0 = false;
        else if (key.currency0 == token && key.currency1 == WETH) tokenIs0 = true;
        else revert BadKey();
        bytes32 id = keccak256(abi.encode(key));
        feeds[marketId] = Feed(manager, id, tokenIs0, decimals);
        if (_sqrtPrice(manager, id) == 0) revert NoSpot(); // pool must exist
        emit FeedSet(marketId, manager, id, tokenIs0, decimals);
    }

    // ───────────── price ─────────────

    /// @notice WAD price (native wei per 1 whole token) in the market's v4 pool right now.
    function spot(uint256 marketId) public view returns (uint256) {
        Feed memory f = feeds[marketId];
        if (f.manager == address(0)) revert NoFeed();
        uint256 s = _sqrtPrice(f.manager, f.poolId);
        if (s == 0) revert NoSpot();
        uint256 base = 10 ** uint256(f.decimals);
        // price of currency0 in currency1 = s^2 / 2^192 (raw units), same math as InversePool._quoteAtTick
        if (s <= type(uint128).max) {
            uint256 r = s * s;
            return f.tokenIs0 ? FullMath.mulDiv(r, base, 1 << 192) : FullMath.mulDiv(1 << 192, base, r);
        }
        uint256 r128 = FullMath.mulDiv(s, s, 1 << 64);
        return f.tokenIs0 ? FullMath.mulDiv(r128, base, 1 << 128) : FullMath.mulDiv(1 << 128, base, r128);
    }

    /// @inheritdoc IPriceSource
    function quote(uint256 marketId, uint256 keeperPrice, bool isLong, bool isOpen, uint8 reason)
        external
        view
        returns (uint256 fillPrice, uint256 refPrice)
    {
        uint256 s = spot(marketId);
        bool lowerIsBetter = isLong == isOpen; // the trader buys: long open or short close
        uint256 worse = isOpen || reason == REASON_USER || reason == REASON_TP ? worseBps : defensiveWorseBps;
        uint256 lo = s * (BPS - (lowerIsBetter ? favBps : worse)) / BPS;
        uint256 hi = s * (BPS + (lowerIsBetter ? worse : favBps)) / BPS;
        if (keeperPrice < lo || keeperPrice > hi) revert OutOfBand();
        return (keeperPrice, s);
    }

    function _sqrtPrice(address manager, bytes32 poolId) internal view returns (uint256) {
        bytes32 w = IExtsload(manager).extsload(keccak256(abi.encode(poolId, POOLS_SLOT)));
        return uint256(w) & type(uint160).max;
    }
}
