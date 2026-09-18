// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DualPoolHook} from "../alf/DualPoolHook.sol";

/// @title YieldPilotHoodVault
/// @notice YieldPilot's own wrapper around a single Uniswap `DualPoolHook` pool on Robinhood
///         Chain. Mirrors the existing Solana vault's design exactly: users deposit into THIS
///         contract (never touch the hook directly), it is the sole LP of record on the hook
///         (all hook shares are held by `address(this)`), and individual users get an internal
///         proportional claim tracked here — the same relationship the Solana program has with
///         its `UserPosition` PDAs sitting on top of a Kamino/Solend CPI.
///
///         Fee + treasury + whitelist logic lives ENTIRELY here, not in the hook or the Morpho
///         vaults behind it (those must stay feeless — see the real on-chain proof this design
///         is based on). This contract is the only place YieldPilot's cut is taken.
contract YieldPilotHoodVault {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------
    error NotAdmin();
    error NotPendingAdmin();
    error VaultPaused();
    error ZeroShares();
    error SlippageExceeded();
    error AlreadyBootstrapped();
    error NotBootstrapped();
    error ZeroAddress();

    // ---------------------------------------------------------------------
    // Immutables / constants
    // ---------------------------------------------------------------------
    DualPoolHook public immutable hook;
    IERC20 public immutable token0;
    IERC20 public immutable token1;
    PoolKey public poolKey;

    /// @dev Same 900 bps (9%) standard fee as the Solana vaults, for product consistency.
    ///      Whitelisted depositors pay 0, identical semantics to the Solana side.
    uint16 public constant STANDARD_FEE_BPS = 900;
    uint16 public constant BPS_DENOM = 10_000;

    // ---------------------------------------------------------------------
    // Admin / treasury (mirrors the Solana vault's admin/pending_admin/treasury fields)
    // ---------------------------------------------------------------------
    address public admin;
    address public pendingAdmin;
    address public treasury;
    bool public paused;
    bool public bootstrapped;

    mapping(address => bool) public whitelist;

    // ---------------------------------------------------------------------
    // Internal share accounting — this vault's OWN ledger, separate from the hook's own
    // `sharesOf(key, address(this))`. A user's claim on the hook position is
    // `userShares[user] * hook.sharesOf(key, address(this)) / totalShares`.
    // ---------------------------------------------------------------------
    mapping(address => uint256) public userShares;
    uint256 public totalShares;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------
    event Deposited(address indexed user, uint256 amount0, uint256 amount1, uint256 sharesMinted);
    event Withdrawn(address indexed user, uint256 amount0, uint256 amount1, uint256 sharesBurned, uint256 feeBps);
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

    constructor(DualPoolHook _hook, PoolKey memory _key, address _admin, address _treasury) {
        if (_admin == address(0) || _treasury == address(0)) revert ZeroAddress();
        hook = _hook;
        poolKey = _key;
        token0 = IERC20(Currency.unwrap(_key.currency0));
        token1 = IERC20(Currency.unwrap(_key.currency1));
        admin = _admin;
        treasury = _treasury;
    }

    // =========================================================================================
    // Admin
    // =========================================================================================

    /// @notice Passthrough to the hook's owner-only `initializePool` — the hook's owner is set
    ///         to THIS contract's address at deploy time (predicted via CREATE nonce math before
    ///         either exists), so only this contract can ever call it, and only the wrapper's
    ///         `admin` can trigger that call.
    function initializePool(DualPoolHook.PoolConfig calldata config) external onlyAdmin returns (int24 tick) {
        tick = hook.initializePool(poolKey, config);
    }

    /// @notice One-time initial LP deposit, mirrors the hook's own `bootstrap` being owner-only.
    ///         Pulls token0/token1 from the admin, deposits into the hook, and the FIRST
    ///         depositor's shares here are minted 1:1 with hook shares received (same bootstrap
    ///         convention as the mock/real Morpho testnet proof).
    function bootstrap(uint256 amount0, uint256 amount1) external onlyAdmin {
        if (bootstrapped) revert AlreadyBootstrapped();
        bootstrapped = true;

        token0.safeTransferFrom(admin, address(this), amount0);
        token1.safeTransferFrom(admin, address(this), amount1);
        token0.forceApprove(address(hook), amount0);
        token1.forceApprove(address(hook), amount1);

        uint256 hookShares = hook.bootstrap(poolKey, amount0, amount1);

        totalShares = hookShares;
        userShares[admin] = hookShares;
        emit Bootstrapped(amount0, amount1, hookShares);
    }

    /// @notice Two-step admin transfer, identical safety property to the Solana vault's
    ///         `propose_admin`/`accept_admin` (never a single-tx takeover).
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

    // =========================================================================================
    // User deposit / withdraw
    // =========================================================================================

    /// @notice Deposit token0+token1 proportional to the pool's current ratio. Mirrors the
    ///         Solana vault's `deposit()`: no fee on the way in, shares priced at current NAV.
    /// @param sharesToMint  Hook-level shares to request — use `previewDeposit` off-chain
    ///                      (compute from `getReserves`/`hook.sharesOf`) same as the hook itself
    ///                      expects; this contract does not re-derive it to avoid a second
    ///                      source of truth diverging from the hook's own math.
    function deposit(uint256 sharesToMint, uint256 maxAmount0, uint256 maxAmount1, uint256 deadline)
        external
        whenNotPaused
        returns (uint256 minted)
    {
        if (!bootstrapped) revert NotBootstrapped();

        IERC20 c0 = _token0();
        IERC20 c1 = _token1();
        c0.forceApprove(address(hook), maxAmount0);
        c1.forceApprove(address(hook), maxAmount1);
        c0.safeTransferFrom(msg.sender, address(this), maxAmount0);
        c1.safeTransferFrom(msg.sender, address(this), maxAmount1);

        (uint256 amount0, uint256 amount1) = hook.addLiquidity(poolKey, sharesToMint, maxAmount0, maxAmount1, deadline);

        // Refund any unused approved/pulled amount back to the depositor.
        if (maxAmount0 > amount0) c0.safeTransfer(msg.sender, maxAmount0 - amount0);
        if (maxAmount1 > amount1) c1.safeTransfer(msg.sender, maxAmount1 - amount1);

        // Mint this vault's OWN shares proportional to the hook shares just added, same NAV
        // convention as the Solana vault's share-price math.
        minted = totalShares == 0 ? sharesToMint : (sharesToMint * totalShares) / _hookShares();
        if (minted == 0) revert ZeroShares();
        userShares[msg.sender] += minted;
        totalShares += minted;

        emit Deposited(msg.sender, amount0, amount1, minted);
    }

    /// @notice Withdraw, fee-gated exactly like the Solana vault: whitelisted wallets pay 0,
    ///         everyone else pays `STANDARD_FEE_BPS` on the withdrawn amounts, routed to
    ///         `treasury` (never `admin`, same separation already proven on the Solana side).
    function withdraw(uint256 sharesToBurn, uint256 minAmount0, uint256 minAmount1, uint256 deadline)
        external
        whenNotPaused
        returns (uint256 netAmount0, uint256 netAmount1)
    {
        if (sharesToBurn == 0 || sharesToBurn > userShares[msg.sender]) revert ZeroShares();

        uint256 hookSharesToBurn = (sharesToBurn * _hookShares()) / totalShares;
        userShares[msg.sender] -= sharesToBurn;
        totalShares -= sharesToBurn;

        (uint256 amount0, uint256 amount1) =
            hook.removeLiquidity(poolKey, hookSharesToBurn, 0, 0, deadline);

        uint16 feeBps = whitelist[msg.sender] ? 0 : STANDARD_FEE_BPS;
        uint256 fee0 = (amount0 * feeBps) / BPS_DENOM;
        uint256 fee1 = (amount1 * feeBps) / BPS_DENOM;
        netAmount0 = amount0 - fee0;
        netAmount1 = amount1 - fee1;

        if (netAmount0 < minAmount0 || netAmount1 < minAmount1) revert SlippageExceeded();

        if (fee0 > 0) _token0().safeTransfer(treasury, fee0);
        if (fee1 > 0) _token1().safeTransfer(treasury, fee1);
        _token0().safeTransfer(msg.sender, netAmount0);
        _token1().safeTransfer(msg.sender, netAmount1);

        emit Withdrawn(msg.sender, netAmount0, netAmount1, sharesToBurn, feeBps);
    }

    // =========================================================================================
    // Views
    // =========================================================================================

    function _hookShares() internal view returns (uint256) {
        return hook.sharesOf(poolKey, address(this));
    }

    function _token0() internal view returns (IERC20) {
        return token0;
    }

    function _token1() internal view returns (IERC20) {
        return token1;
    }

    /// @notice A user's proportional claim on the vault's total position, in hook-share terms.
    function previewUserHookShares(address user) external view returns (uint256) {
        if (totalShares == 0) return 0;
        return (userShares[user] * _hookShares()) / totalShares;
    }
}
