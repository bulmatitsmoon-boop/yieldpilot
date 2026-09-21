// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";

interface IV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory, uint160[] memory);
}

interface INPM {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function mint(MintParams calldata p) external returns (uint256 tokenId, uint128 liquidity, uint256 a0, uint256 a1);
    struct IncreaseParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct DecreaseParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function increaseLiquidity(IncreaseParams calldata p)
        external
        returns (uint128 liquidity, uint256 amount0, uint256 amount1);
    function decreaseLiquidity(DecreaseParams calldata p) external returns (uint256 amount0, uint256 amount1);
    function collect(CollectParams calldata p) external returns (uint256 amount0, uint256 amount1);
    function burn(uint256 tokenId) external;
    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 fgi0,
            uint256 fgi1,
            uint128 owed0,
            uint128 owed1
        );
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut);
}

/// @title YieldPilotV3LpVault
/// @notice One vault per Uniswap v3 pool (USDG / X). Users deposit and withdraw ONLY USDG; the vault
///         swaps into the other token itself, holds a single wide-range NPM position, and charges a
///         performance fee on PROFIT only (cost-basis accounting, same idea as the Hood wrapper V2).
/// @dev EXPERIMENTAL and unaudited. All valuation uses a 30 min TWAP and every state-changing path
///      reverts if spot has moved more than MAX_DEV_TICKS from the TWAP, which bounds sandwich losses.
///      The admin can NOT withdraw user funds: it can only pause deposits, set the cap / treasury /
///      fee whitelist, and rebalance the range or compound (both must keep NAV within MAX_LOSS_BPS).
contract YieldPilotV3LpVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant FEE_BPS = 900; // 9% of PROFIT
    uint256 public constant SLIPPAGE_BPS = 100; // 1% floor on swaps / liquidity removal vs TWAP
    uint256 public constant MAX_LOSS_BPS = 150; // max NAV loss tolerated on a deposit zap / admin action
    uint32 public constant TWAP_WINDOW = 1800;
    int24 public constant MAX_DEV_TICKS = 100; // ~1% spot-vs-TWAP deviation
    uint256 public constant REBALANCE_COOLDOWN = 12 hours;
    uint256 public constant COMPOUND_COOLDOWN = 6 hours;
    uint256 public constant COMPOUND_MIN_BPS = 10; // idle fees >= 0.1% of NAV
    uint256 public constant DUST = 10_000; // 0.01 USDG; below this we don't bother swapping
    uint256 public constant MIN_SHARES_LOCK = 1_000;
    address public constant DEAD = address(0xdead);
    uint256 private constant Q96 = 1 << 96;

    IV3Pool public immutable pool;
    INPM public immutable npm;
    ISwapRouter02 public immutable router;
    IERC20 public immutable usdg;
    IERC20 public immutable other;
    bool public immutable usdgIsToken0;
    uint24 public immutable poolFee;
    int24 public immutable tickSpacing;

    address public admin;
    address public treasury;
    address public keeper;
    uint256 public lastRebalance;
    uint256 public lastCompound;
    uint256 public depositCap; // max NAV in USDG units (6 dec)
    bool public depositsPaused;
    int24 public tickLower;
    int24 public tickUpper;
    uint256 public tokenId;

    mapping(address => uint256) public shares;
    mapping(address => uint256) public costBasis; // USDG units
    mapping(address => bool) public feeWhitelisted;
    uint256 public totalShares;

    event Deposited(address indexed user, uint256 usdgIn, uint256 valueAdded, uint256 sharesOut);
    event Withdrawn(address indexed user, uint256 sharesBurned, uint256 gross, uint256 fee, uint256 net);
    event Maintained(uint8 action, int24 tickLower, int24 tickUpper, uint256 navBefore, uint256 navAfter);

    error NotAdmin();
    error NotKeeper();
    error NothingToDo();
    error Paused();
    error CapExceeded();
    error PriceDeviates();
    error TooMuchLoss();
    error BadTicks();
    error ZeroAmount();
    error InsufficientShares();

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(
        address _pool,
        address _npm,
        address _router,
        address _usdg,
        address _admin,
        address _keeper,
        address _treasury,
        uint256 _cap,
        int24 _tickLower,
        int24 _tickUpper
    ) {
        pool = IV3Pool(_pool);
        npm = INPM(_npm);
        router = ISwapRouter02(_router);
        usdg = IERC20(_usdg);
        address t0 = IV3Pool(_pool).token0();
        address t1 = IV3Pool(_pool).token1();
        usdgIsToken0 = (t0 == _usdg);
        require(usdgIsToken0 || t1 == _usdg, "usdg not in pool");
        other = IERC20(usdgIsToken0 ? t1 : t0);
        poolFee = IV3Pool(_pool).fee();
        tickSpacing = IV3Pool(_pool).tickSpacing();
        admin = _admin;
        keeper = _keeper;
        lastRebalance = block.timestamp;
        lastCompound = block.timestamp;
        treasury = _treasury;
        depositCap = _cap;
        _setTicks(_tickLower, _tickUpper);
        IERC20(t0).forceApprove(_npm, type(uint256).max);
        IERC20(t1).forceApprove(_npm, type(uint256).max);
        IERC20(t0).forceApprove(_router, type(uint256).max);
        IERC20(t1).forceApprove(_router, type(uint256).max);
    }

    // ───────────────────────────── user actions ─────────────────────────────

    function deposit(uint256 usdgIn) external nonReentrant returns (uint256 sharesOut) {
        if (depositsPaused) revert Paused();
        if (usdgIn < DUST) revert ZeroAmount();
        (uint160 sp, int24 twapTick) = _twap();
        _checkSpot(twapTick);
        _poke();
        uint256 navBefore = _nav(sp);

        usdg.safeTransferFrom(msg.sender, address(this), usdgIn);
        _deployAll(sp);

        uint256 navAfter = _nav(sp);
        if (navAfter > depositCap) revert CapExceeded();
        uint256 added = navAfter - navBefore;
        if (added < (usdgIn * (BPS - MAX_LOSS_BPS)) / BPS) revert TooMuchLoss();

        if (totalShares == 0) {
            totalShares = added;
            shares[DEAD] = MIN_SHARES_LOCK;
            sharesOut = added - MIN_SHARES_LOCK;
        } else {
            require(navBefore > 0, "vault empty");
            sharesOut = (added * totalShares) / navBefore;
            totalShares += sharesOut;
        }
        shares[msg.sender] += sharesOut;
        costBasis[msg.sender] += usdgIn; // basis = what the user actually paid, so zap loss is never taxed as profit
        emit Deposited(msg.sender, usdgIn, added, sharesOut);
    }

    function withdraw(uint256 sharesIn) external nonReentrant returns (uint256 net) {
        uint256 userShares = shares[msg.sender];
        if (sharesIn == 0) revert ZeroAmount();
        if (sharesIn > userShares) revert InsufficientShares();
        (uint160 sp, int24 twapTick) = _twap();
        _checkSpot(twapTick);
        _poke();

        uint256 total = totalShares;
        uint256 idle0 = _bal0();
        uint256 idle1 = _bal1();
        uint256 a0 = (idle0 * sharesIn) / total;
        uint256 a1 = (idle1 * sharesIn) / total;

        if (tokenId != 0) {
            (,,,,,,, uint128 liq,,,,) = npm.positions(tokenId);
            uint128 rm = uint128((uint256(liq) * sharesIn) / total);
            if (rm > 0) {
                (uint256 c0, uint256 c1) = _removeLiquidity(rm, sp);
                a0 += c0;
                a1 += c1;
            }
        }

        uint256 usdgPart = usdgIsToken0 ? a0 : a1;
        uint256 otherPart = usdgIsToken0 ? a1 : a0;
        uint256 gross = usdgPart;
        if (otherPart > 0) {
            uint256 minOut = (_toUsdg(otherPart, sp) * (BPS - SLIPPAGE_BPS)) / BPS;
            gross += _swap(address(other), address(usdg), otherPart, minOut);
        }

        uint256 basisPortion = (costBasis[msg.sender] * sharesIn) / userShares;
        costBasis[msg.sender] -= basisPortion;
        shares[msg.sender] = userShares - sharesIn;
        totalShares = total - sharesIn;

        uint256 fee;
        if (!feeWhitelisted[msg.sender] && gross > basisPortion) {
            fee = ((gross - basisPortion) * FEE_BPS) / BPS;
        }
        net = gross - fee;
        if (fee > 0) usdg.safeTransfer(treasury, fee);
        usdg.safeTransfer(msg.sender, net);
        emit Withdrawn(msg.sender, sharesIn, gross, fee, net);
    }

    // ───────────────────────────── admin actions ─────────────────────────────

    /// @notice Automated upkeep, callable ONLY by the keeper bot. The contract decides what is allowed:
    ///         (1) recenter the same-width range on the TWAP when price is in the outer 10% of the range
    ///         or out of it (12h cooldown); else (2) compound idle fees once they are >= 0.1% of NAV (6h
    ///         cooldown). Anything else reverts NothingToDo. NAV may not drop more than MAX_LOSS_BPS.
    function maintain() external onlyKeeper nonReentrant returns (uint8 action) {
        (uint160 sp, int24 twapTick) = _twap();
        _checkSpot(twapTick);
        _poke();
        uint256 navBefore = _nav(sp);

        int24 width = tickUpper - tickLower;
        int24 edge = width / 10;
        bool nearEdge = twapTick <= tickLower + edge || twapTick >= tickUpper - edge;

        if (nearEdge && block.timestamp >= lastRebalance + REBALANCE_COOLDOWN) {
            if (tokenId != 0) {
                (,,,,,,, uint128 liq,,,,) = npm.positions(tokenId);
                if (liq > 0) _removeLiquidity(liq, sp);
                npm.burn(tokenId);
                tokenId = 0;
            }
            int24 newLo = _floorToSpacing(twapTick - width / 2);
            _setTicks(newLo, newLo + width);
            lastRebalance = block.timestamp;
            lastCompound = block.timestamp;
            action = 1;
        } else if (block.timestamp >= lastCompound + COMPOUND_COOLDOWN && _idleValue(sp) * BPS >= navBefore * COMPOUND_MIN_BPS) {
            lastCompound = block.timestamp;
            action = 2;
        } else {
            revert NothingToDo();
        }

        _deployAll(sp);
        uint256 navAfter = _nav(sp);
        if (navAfter < (navBefore * (BPS - MAX_LOSS_BPS)) / BPS) revert TooMuchLoss();
        emit Maintained(action, tickLower, tickUpper, navBefore, navAfter);
    }

    function setKeeper(address k) external onlyAdmin {
        keeper = k;
    }

    function setDepositsPaused(bool p) external onlyAdmin {
        depositsPaused = p;
    }

    function setDepositCap(uint256 c) external onlyAdmin {
        depositCap = c;
    }

    function setTreasury(address t) external onlyAdmin {
        require(t != address(0), "zero");
        treasury = t;
    }

    function setFeeWhitelisted(address a, bool w) external onlyAdmin {
        feeWhitelisted[a] = w;
    }

    function transferAdmin(address a) external onlyAdmin {
        require(a != address(0), "zero");
        admin = a;
    }

    // ───────────────────────────── views ─────────────────────────────

    /// @notice Vault NAV in USDG units, valued at the 30 min TWAP.
    function totalAssets() external view returns (uint256) {
        (uint160 sp,) = _twap();
        return _nav(sp);
    }

    /// @notice Current USDG value of a user's shares (before the profit fee).
    function valueOf(address user) external view returns (uint256) {
        if (totalShares == 0) return 0;
        (uint160 sp,) = _twap();
        return (_nav(sp) * shares[user]) / totalShares;
    }

    // ───────────────────────────── internals ─────────────────────────────

    /// Remove  from the position and collect. Token amounts may shift when spot is slightly off TWAP,
    /// so the guard is on VALUE (at TWAP) rather than on each token amount.
    function _removeLiquidity(uint128 liq, uint160 sp) internal returns (uint256 c0, uint256 c1) {
        (uint256 e0, uint256 e1) = _expected(sp, liq);
        npm.decreaseLiquidity(INPM.DecreaseParams(tokenId, liq, 0, 0, block.timestamp));
        (c0, c1) = npm.collect(INPM.CollectParams(tokenId, address(this), type(uint128).max, type(uint128).max));
        uint256 expV = (usdgIsToken0 ? e0 : e1) + _toUsdg(usdgIsToken0 ? e1 : e0, sp);
        uint256 gotV = (usdgIsToken0 ? c0 : c1) + _toUsdg(usdgIsToken0 ? c1 : c0, sp);
        if (gotV < (expV * (BPS - SLIPPAGE_BPS)) / BPS) revert TooMuchLoss();
    }

    function _floorToSpacing(int24 t) internal view returns (int24) {
        int24 r = t % tickSpacing;
        if (r < 0) r += tickSpacing;
        return t - r;
    }

    function _idleValue(uint160 sp) internal view returns (uint256) {
        return usdg.balanceOf(address(this)) + _toUsdg(other.balanceOf(address(this)), sp);
    }

    function _bal0() internal view returns (uint256) {
        return IERC20(usdgIsToken0 ? address(usdg) : address(other)).balanceOf(address(this));
    }

    function _bal1() internal view returns (uint256) {
        return IERC20(usdgIsToken0 ? address(other) : address(usdg)).balanceOf(address(this));
    }

    function _setTicks(int24 lo, int24 hi) internal {
        if (
            lo >= hi || lo % tickSpacing != 0 || hi % tickSpacing != 0 || lo < TickMath.MIN_TICK
                || hi > TickMath.MAX_TICK
        ) revert BadTicks();
        tickLower = lo;
        tickUpper = hi;
    }

    function _twap() internal view returns (uint160 sqrtP, int24 tick) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = TWAP_WINDOW;
        ago[1] = 0;
        (int56[] memory cum,) = pool.observe(ago);
        int56 delta = cum[1] - cum[0];
        tick = int24(delta / int56(uint56(TWAP_WINDOW)));
        if (delta < 0 && (delta % int56(uint56(TWAP_WINDOW)) != 0)) tick--;
        sqrtP = TickMath.getSqrtPriceAtTick(tick);
    }

    function _checkSpot(int24 twapTick) internal view {
        (, int24 spot,,,,,) = pool.slot0();
        int24 d = spot > twapTick ? spot - twapTick : twapTick - spot;
        if (d > MAX_DEV_TICKS) revert PriceDeviates();
    }

    /// value of `amt` of the OTHER token, in USDG units, at sqrt price sp
    function _toUsdg(uint256 amt, uint160 sp) internal view returns (uint256) {
        if (usdgIsToken0) {
            // other = token1; token0 per token1 = Q96^2 / sp^2
            return FullMath.mulDiv(FullMath.mulDiv(amt, Q96, sp), Q96, sp);
        }
        return FullMath.mulDiv(FullMath.mulDiv(amt, sp, Q96), sp, Q96);
    }

    /// amount of OTHER token worth `u` USDG units at sqrt price sp
    function _fromUsdg(uint256 u, uint160 sp) internal view returns (uint256) {
        if (usdgIsToken0) {
            return FullMath.mulDiv(FullMath.mulDiv(u, sp, Q96), sp, Q96);
        }
        return FullMath.mulDiv(FullMath.mulDiv(u, Q96, sp), Q96, sp);
    }

    function _expected(uint160 sp, uint128 liq) internal view returns (uint256 a0, uint256 a1) {
        uint160 sa = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sb = TickMath.getSqrtPriceAtTick(tickUpper);
        if (sp <= sa) {
            a0 = SqrtPriceMath.getAmount0Delta(sa, sb, liq, false);
        } else if (sp < sb) {
            a0 = SqrtPriceMath.getAmount0Delta(sp, sb, liq, false);
            a1 = SqrtPriceMath.getAmount1Delta(sa, sp, liq, false);
        } else {
            a1 = SqrtPriceMath.getAmount1Delta(sa, sb, liq, false);
        }
    }

    function _nav(uint160 sp) internal view returns (uint256 v) {
        uint256 u = usdg.balanceOf(address(this));
        uint256 o = other.balanceOf(address(this));
        if (tokenId != 0) {
            (,,,,,,, uint128 liq,,, uint128 owed0, uint128 owed1) = npm.positions(tokenId);
            (uint256 a0, uint256 a1) = _expected(sp, liq);
            a0 += owed0;
            a1 += owed1;
            u += usdgIsToken0 ? a0 : a1;
            o += usdgIsToken0 ? a1 : a0;
        }
        v = u + _toUsdg(o, sp);
    }

    function _poke() internal {
        if (tokenId != 0) npm.collect(INPM.CollectParams(tokenId, address(this), type(uint128).max, type(uint128).max));
    }

    function _swap(address tin, address tout, uint256 amtIn, uint256 minOut) internal returns (uint256) {
        return router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams(tin, tout, poolFee, address(this), amtIn, minOut, 0)
        );
    }

    /// Rebalance all vault balances to the range's token ratio (valued at TWAP) and put them into the position.
    function _deployAll(uint160 sp) internal {
        uint256 u = usdg.balanceOf(address(this));
        uint256 o = other.balanceOf(address(this));

        (uint256 r0, uint256 r1) = _expected(sp, uint128(1e24));
        uint256 rU = usdgIsToken0 ? r0 : r1;
        uint256 rO = usdgIsToken0 ? r1 : r0;
        uint256 vO = _toUsdg(rO, sp);
        uint256 oVal = _toUsdg(o, sp);
        uint256 total = u + oVal;
        uint256 targetO = (rU + vO) == 0 ? 0 : (total * vO) / (rU + vO);

        if (targetO > oVal + DUST) {
            uint256 inU = targetO - oVal;
            if (inU > u) inU = u;
            uint256 minOut = (_fromUsdg(inU, sp) * (BPS - SLIPPAGE_BPS)) / BPS;
            _swap(address(usdg), address(other), inU, minOut);
        } else if (oVal > targetO + DUST) {
            uint256 inO = _fromUsdg(oVal - targetO, sp);
            if (inO > o) inO = o;
            uint256 minOut = (_toUsdg(inO, sp) * (BPS - SLIPPAGE_BPS)) / BPS;
            _swap(address(other), address(usdg), inO, minOut);
        }

        uint256 b0 = _bal0();
        uint256 b1 = _bal1();
        if (b0 == 0 && b1 == 0) return;
        if (tokenId == 0) {
            (uint256 id,,,) = npm.mint(
                INPM.MintParams(
                    usdgIsToken0 ? address(usdg) : address(other),
                    usdgIsToken0 ? address(other) : address(usdg),
                    poolFee,
                    tickLower,
                    tickUpper,
                    b0,
                    b1,
                    0,
                    0,
                    address(this),
                    block.timestamp
                )
            );
            tokenId = id;
        } else {
            npm.increaseLiquidity(INPM.IncreaseParams(tokenId, b0, b1, 0, 0, block.timestamp));
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
