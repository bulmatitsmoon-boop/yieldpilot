// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DualPoolHook} from "../alf/DualPoolHook.sol";

/// @title YieldPilotHoodVaultV2
/// @notice YieldPilot's wrapper around a single Uniswap `DualPoolHook` pool on Robinhood Chain.
///         Users deposit into THIS contract; it is the sole LP of record on the hook and keeps
///         its own per-user ledger, the same relationship the Solana program has with its
///         `UserPosition` accounts.
///
///         V2 changes vs V1 (both found after V1 went live):
///         1. PERFORMANCE FEE ON PROFIT ONLY. V1 charged 9% of the whole withdrawal (principal
///            included). V2 tracks each user's cost basis and charges `STANDARD_FEE_BPS` only on
///            the amount by which the withdrawn value exceeds the cost basis of the shares
///            burned. No profit => no fee. Whitelisted wallets pay nothing.
///         2. SHARE-MINT ACCOUNTING FIX. V1 divided by the hook's share total AFTER the new
///            liquidity was added, under-crediting every new depositor (and over-crediting
///            existing holders). V2 uses the total from BEFORE the deposit.
///
///         Profit is measured on the COMBINED value of both tokens, each normalised to 18
///         decimals and treated as $1 (both pool assets are USD stablecoins), so the pool
///         rebalancing between the two tokens is not mistaken for profit or loss. The fee is
///         taken in kind, pro rata from both tokens. If either token ever depegs materially this
///         assumption must be revisited -- there is deliberately no oracle here.
///
///         Non-upgradeable by design. Fee, treasury and whitelist logic lives ONLY here; the
///         hook and the Morpho vaults behind it stay feeless.
contract YieldPilotHoodVaultV2 {
    using SafeERC20 for IERC20;

    error NotAdmin();
    error NotPendingAdmin();
    error VaultPaused();
    error ZeroShares();
    error SlippageExceeded();
    error AlreadyBootstrapped();
    error NotBootstrapped();
    error ZeroAddress();
    error Reentrancy();
    error UnsupportedDecimals();

    DualPoolHook public immutable hook;
    IERC20 public immutable token0;
    IERC20 public immutable token1;
    /// @dev 10 ** (18 - decimals): multiplies a raw token amount into 18-decimal "USD value".
    uint256 public immutable scale0;
    uint256 public immutable scale1;
    PoolKey public poolKey;

    /// @dev 9% performance fee, on PROFIT only. Same rate as the Solana vaults.
    uint16 public constant STANDARD_FEE_BPS = 900;
    uint16 public constant BPS_DENOM = 10_000;

    address public admin;
    address public pendingAdmin;
    address public treasury;
    bool public paused;
    bool public bootstrapped;
    uint256 private _lock = 1;

    mapping(address => bool) public whitelist;

    /// @notice This vault's own ledger of user claims (not transferable).
    mapping(address => uint256) public userShares;
    uint256 public totalShares;

    /// @notice 18-decimal USD value each user has deposited and not yet withdrawn (cost basis).
    mapping(address => uint256) public costBasis;

    event Deposited(address indexed user, uint256 amount0, uint256 amount1, uint256 sharesMinted);
    event Withdrawn(address indexed user, uint256 amount0, uint256 amount1, uint256 sharesBurned, uint256 feeBps);
    event FeeCharged(address indexed user, uint256 profitValue, uint256 fee0, uint256 fee1);
    event AdminProposed(address indexed newAdmin);
    event AdminAccepted(address indexed newAdmin);
    event TreasurySet(address indexed newTreasury);
    event WhitelistSet(address indexed account, bool allowed);
    event PausedSet(bool paused);
    event Bootstrapped(uint256 amount0, uint256 amount1, uint256 hookShares);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert VaultPaused();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(DualPoolHook _hook, PoolKey memory _key, address _admin, address _treasury) {
        if (_admin == address(0) || _treasury == address(0)) revert ZeroAddress();
        hook = _hook;
        poolKey = _key;
        token0 = IERC20(Currency.unwrap(_key.currency0));
        token1 = IERC20(Currency.unwrap(_key.currency1));
        uint8 d0 = IERC20Metadata(Currency.unwrap(_key.currency0)).decimals();
        uint8 d1 = IERC20Metadata(Currency.unwrap(_key.currency1)).decimals();
        if (d0 > 18 || d1 > 18) revert UnsupportedDecimals();
        scale0 = 10 ** (18 - d0);
        scale1 = 10 ** (18 - d1);
        admin = _admin;
        treasury = _treasury;
    }

    // ------------------------------------------------------------------ admin

    /// @notice Passthrough to the hook's owner-only `initializePool` (this contract is the hook's
    ///         owner, fixed at hook deploy time), callable only by this vault's admin.
    function initializePool(DualPoolHook.PoolConfig calldata config) external onlyAdmin returns (int24 tick) {
        tick = hook.initializePool(poolKey, config);
    }

    /// @notice One-time initial LP deposit. The admin's cost basis is what it puts in.
    function bootstrap(uint256 amount0, uint256 amount1) external onlyAdmin nonReentrant {
        if (bootstrapped) revert AlreadyBootstrapped();
        bootstrapped = true;

        token0.safeTransferFrom(admin, address(this), amount0);
        token1.safeTransferFrom(admin, address(this), amount1);
        token0.forceApprove(address(hook), amount0);
        token1.forceApprove(address(hook), amount1);

        uint256 hookShares = hook.bootstrap(poolKey, amount0, amount1);

        totalShares = hookShares;
        userShares[admin] = hookShares;
        costBasis[admin] = amount0 * scale0 + amount1 * scale1;
        emit Bootstrapped(amount0, amount1, hookShares);
    }

    function proposeAdmin(address newAdmin) external onlyAdmin {
        pendingAdmin = newAdmin;
        emit AdminProposed(newAdmin);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminAccepted(admin);
    }

    function setTreasury(address newTreasury) external onlyAdmin {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
        emit TreasurySet(newTreasury);
    }

    function setWhitelist(address account, bool allowed) external onlyAdmin {
        whitelist[account] = allowed;
        emit WhitelistSet(account, allowed);
    }

    function setPaused(bool _paused) external onlyAdmin {
        paused = _paused;
        emit PausedSet(_paused);
    }

    // ------------------------------------------------------------------ users

    /// @notice Deposit token0+token1 proportional to the pool's current ratio. No fee on the way
    ///         in. `sharesToMint` is in HOOK shares (compute off-chain from `getReserves` and
    ///         `hook.sharesOf`); the vault mints its own shares proportionally.
    function deposit(uint256 sharesToMint, uint256 maxAmount0, uint256 maxAmount1, uint256 deadline)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 minted)
    {
        if (!bootstrapped) revert NotBootstrapped();

        // FIX vs V1: read the hook-share total BEFORE adding liquidity.
        uint256 hookSharesBefore = _hookShares();

        token0.forceApprove(address(hook), maxAmount0);
        token1.forceApprove(address(hook), maxAmount1);
        token0.safeTransferFrom(msg.sender, address(this), maxAmount0);
        token1.safeTransferFrom(msg.sender, address(this), maxAmount1);

        (uint256 amount0, uint256 amount1) = hook.addLiquidity(poolKey, sharesToMint, maxAmount0, maxAmount1, deadline);

        if (maxAmount0 > amount0) token0.safeTransfer(msg.sender, maxAmount0 - amount0);
        if (maxAmount1 > amount1) token1.safeTransfer(msg.sender, maxAmount1 - amount1);

        minted = (sharesToMint * totalShares) / hookSharesBefore;
        if (minted == 0) revert ZeroShares();
        userShares[msg.sender] += minted;
        totalShares += minted;
        costBasis[msg.sender] += amount0 * scale0 + amount1 * scale1;

        emit Deposited(msg.sender, amount0, amount1, minted);
    }

    /// @notice Withdraw. The performance fee applies ONLY to profit: the withdrawn value minus the
    ///         cost basis of the shares being burned. Whitelisted wallets pay 0. Fee goes to
    ///         `treasury`, never `admin`.
    function withdraw(uint256 sharesToBurn, uint256 minAmount0, uint256 minAmount1, uint256 deadline)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 netAmount0, uint256 netAmount1)
    {
        uint256 userTotal = userShares[msg.sender];
        if (sharesToBurn == 0 || sharesToBurn > userTotal) revert ZeroShares();

        uint256 hookSharesToBurn = (sharesToBurn * _hookShares()) / totalShares;

        // Cost basis of exactly the slice being withdrawn (all of it when withdrawing everything).
        uint256 basisPortion = sharesToBurn == userTotal
            ? costBasis[msg.sender]
            : (costBasis[msg.sender] * sharesToBurn) / userTotal;
        costBasis[msg.sender] -= basisPortion;
        userShares[msg.sender] = userTotal - sharesToBurn;
        totalShares -= sharesToBurn;

        (uint256 amount0, uint256 amount1) = hook.removeLiquidity(poolKey, hookSharesToBurn, 0, 0, deadline);

        uint256 value = amount0 * scale0 + amount1 * scale1;
        uint256 profit = value > basisPortion ? value - basisPortion : 0;
        uint16 feeBps = whitelist[msg.sender] ? 0 : STANDARD_FEE_BPS;
        uint256 feeValue = (profit * feeBps) / BPS_DENOM;

        // Take the fee in kind, pro rata from both tokens (feeValue <= value, so never > amount).
        uint256 fee0 = value == 0 ? 0 : (amount0 * feeValue) / value;
        uint256 fee1 = value == 0 ? 0 : (amount1 * feeValue) / value;
        netAmount0 = amount0 - fee0;
        netAmount1 = amount1 - fee1;

        if (netAmount0 < minAmount0 || netAmount1 < minAmount1) revert SlippageExceeded();

        if (fee0 > 0) token0.safeTransfer(treasury, fee0);
        if (fee1 > 0) token1.safeTransfer(treasury, fee1);
        token0.safeTransfer(msg.sender, netAmount0);
        token1.safeTransfer(msg.sender, netAmount1);

        emit Withdrawn(msg.sender, netAmount0, netAmount1, sharesToBurn, feeBps);
        if (feeValue > 0) emit FeeCharged(msg.sender, profit, fee0, fee1);
    }

    // ------------------------------------------------------------------ views

    function _hookShares() internal view returns (uint256) {
        return hook.sharesOf(poolKey, address(this));
    }

    /// @notice A user's proportional claim on the vault's position, in hook-share terms.
    function previewUserHookShares(address user) external view returns (uint256) {
        if (totalShares == 0) return 0;
        return (userShares[user] * _hookShares()) / totalShares;
    }
}
