//! LP vault — opt-in, dual-asset liquidity provision (Orca Whirlpools or
//! Raydium CLMM).
//!
//! Deliberately a SEPARATE product from the main single-asset `Vault`: it
//! accepts two tokens directly from the depositor (no swap step, no added
//! price-impact risk stacked onto impermanent loss) and is not part of the
//! core auto-routing promise. See project memory / whitepaper Phase 2.
//!
//! Protocol-agnostic design: `LpVault` holds a `protocol: LpProtocolKind`
//! field and generic account fields (`pool`, `position`, etc.) shared by
//! both integrations — share accounting, the IL-acknowledgment gate, and
//! the reposition flow are all written once. What ISN'T shared is the
//! actual CPI account list per instruction: Orca and Raydium's real
//! accounts genuinely differ (Raydium has an extra `protocol_position`
//! layer and an NFT-metadata dependency Orca doesn't), so each protocol
//! gets its own instructions (deposit_orca_lp vs deposit_raydium_lp) rather
//! than forcing a single Anchor Accounts struct to express both — the same
//! pattern the main Vault already uses for Kamino/Marinade/Solend/Jito
//! (one instruction per protocol, not a generic dispatcher).
//!
//! v1 scope, deliberately kept simple:
//! - Fixed price range, chosen once at vault init by admin (no active
//!   rebalancing yet — a real tradeoff: rebalancing is more capital-efficient
//!   but adds keeper complexity + rebalancing cost. Flagged as future work).
//! - `liquidity_amount` for deposit/withdraw is supplied by the caller
//!   (computed off-chain via each protocol's own SDK from desired token
//!   amounts and the pool's current price) rather than derived on-chain —
//!   keeps the Solana program's math simple and auditable; `token_max_a/b`
//!   / `token_min_a/b` are the on-chain slippage guard regardless of how
//!   the caller computed the liquidity figure.
//! - Deposits require an explicit on-chain acknowledgment of impermanent
//!   loss risk (`acknowledge_impermanent_loss: bool`, must be true) — a
//!   real, enforced gate, not just a frontend disclaimer.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount, Transfer};

use crate::adapters::orca::{
    OrcaClosePosition, OrcaModifyLiquidity, OrcaOpenPosition, WHIRLPOOL_PROGRAM_ID,
    orca_close_position, orca_decrease_liquidity, orca_increase_liquidity, orca_open_position,
};
use crate::adapters::raydium::{
    METADATA_PROGRAM_ID, RAYDIUM_CLMM_PROGRAM_ID, RaydiumClosePosition, RaydiumModifyLiquidity,
    RaydiumOpenPosition, raydium_close_position, raydium_decrease_liquidity,
    raydium_increase_liquidity, raydium_open_position,
};

// ── State ─────────────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum LpProtocolKind {
    Orca    = 0,
    Raydium = 1,
}

impl Default for LpProtocolKind {
    fn default() -> Self { LpProtocolKind::Orca }
}

#[account]
pub struct LpVault {
    pub admin:                    Pubkey,
    pub keeper:                   Pubkey,
    pub treasury:                 Pubkey,
    pub protocol:                 LpProtocolKind,
    /// Orca: the Whirlpool account. Raydium: the pool_state account.
    pub pool:                     Pubkey,
    /// Orca: the Position state account. Raydium: the PersonalPositionState
    /// account.
    pub position:                 Pubkey,
    /// Raydium only (Pubkey::default() for Orca vaults) — the shared
    /// per-tick-range ProtocolPositionState account Raydium requires on
    /// every liquidity-modifying call. See adapters/raydium.rs's PDA seed
    /// notes; marked "deprecated" in Raydium's own source but still
    /// mandatory.
    pub protocol_position:        Pubkey,
    pub position_mint:            Pubkey,
    pub position_token_account:   Pubkey,
    pub token_a_mint:             Pubkey,
    pub token_b_mint:             Pubkey,
    pub vault_token_a_account:    Pubkey,
    pub vault_token_b_account:    Pubkey,
    pub lp_shares_mint:           Pubkey,
    pub tick_lower_index:         i32,
    pub tick_upper_index:         i32,
    /// Total liquidity units currently contributed to the position (each
    /// protocol's own u128 liquidity unit — NOT a token amount).
    pub total_liquidity:          u128,
    pub total_shares:             u64,
    pub paused:                   bool,
    /// False between exit_*_lp_position and open_new_*_lp_position — the
    /// vault holds idle tokens but has no live protocol position.
    /// deposit_*_lp and withdraw_*_lp both require this to be true.
    pub position_active:          bool,
    pub bump:                     u8,
    pub authority_bump:           u8,
    pub name:                     String,
}

impl LpVault {
    pub const LEN: usize = 8
        + 32 * 13   // pubkeys (admin, keeper, treasury, pool, position, protocol_position, position_mint, position_token_account, token_a_mint, token_b_mint, vault_token_a_account, vault_token_b_account, lp_shares_mint)
        + 1         // protocol (LpProtocolKind, single-byte enum)
        + 4 * 2     // tick indices (i32)
        + 16        // total_liquidity (u128)
        + 8         // total_shares
        + 2         // paused + position_active
        + 2         // bumps
        + 4 + 32    // name
        + 64;       // padding for future fields
}

/// Per-user LP position ledger — mirrors UserPosition's cost-basis-tracking
/// pattern from the main vault, but tracks liquidity units instead of a
/// single token amount (there's no single "amount deposited" for a two-sided
/// LP position).
#[account]
pub struct LpUserPosition {
    pub owner:            Pubkey,
    pub lp_vault:         Pubkey,
    pub shares:           u64,
    pub liquidity_at_deposit: u128,
    pub bump:             u8,
}

impl LpUserPosition {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 16 + 1 + 32;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitLpVaultParams {
    pub keeper:           Pubkey,
    pub treasury:         Pubkey,
    pub tick_lower_index: i32,
    pub tick_upper_index: i32,
    /// Raydium only — the start index of each tick array (a DIFFERENT value
    /// than tick_lower_index/tick_upper_index; see adapters/raydium.rs PDA
    /// seed notes). Ignored for Orca vaults.
    pub tick_array_lower_start_index: i32,
    pub tick_array_upper_start_index: i32,
    pub name:             String,
}

// ── Errors ────────────────────────────────────────────────────────────────────

#[error_code]
pub enum LpVaultError {
    #[msg("Must explicitly acknowledge impermanent loss risk to deposit")]
    MustAcknowledgeImpermanentLoss,
    #[msg("LP vault is paused")]
    LpVaultPaused,
    #[msg("Amount must be > 0")]
    ZeroAmount,
    #[msg("Zero shares calculated")]
    ZeroShares,
    #[msg("Insufficient shares")]
    InsufficientShares,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Name too long (max 32 chars)")]
    NameTooLong,
    #[msg("Output below minimum — slippage exceeded")]
    SlippageExceeded,
    #[msg("No active protocol position — vault is mid-reposition")]
    NoActivePosition,
    #[msg("Position still has liquidity — exit it fully before reopening")]
    PositionStillActive,
    #[msg("Vault does not hold enough idle balance for this redeploy amount")]
    InsufficientIdleBalance,
}

// ── Shared math helpers ────────────────────────────────────────────────────────
// Identical share-price logic for both protocols — extracted once so
// Orca/Raydium handlers can't silently drift apart on something this
// correctness-sensitive.

/// Shares to mint for a deposit of `liquidity_amount`, given current
/// vault totals. First depositor mints 1:1; later depositors mint
/// proportional to existing liquidity, same pattern as the main Vault's
/// share math.
fn calculate_deposit_shares(liquidity_amount: u128, total_liquidity: u128, total_shares: u64) -> Result<u64> {
    let shares: u64 = if total_shares == 0 || total_liquidity == 0 {
        // u128 liquidity down-scaled defensively; real precision handling is
        // a follow-up item once real pool liquidity magnitudes are known.
        liquidity_amount.min(u64::MAX as u128) as u64
    } else {
        (liquidity_amount
            .checked_mul(total_shares as u128)
            .and_then(|x| x.checked_div(total_liquidity))
            .ok_or(LpVaultError::MathOverflow)?) as u64
    };
    require!(shares > 0, LpVaultError::ZeroShares);
    Ok(shares)
}

/// Liquidity to remove for a withdrawal of `shares`, given current vault
/// totals.
fn calculate_withdraw_liquidity(shares: u64, total_liquidity: u128, total_shares: u64) -> Result<u128> {
    (shares as u128)
        .checked_mul(total_liquidity)
        .and_then(|x| x.checked_div(total_shares as u128))
        .ok_or(LpVaultError::MathOverflow.into())
}

// ── Events ────────────────────────────────────────────────────────────────────

#[event] pub struct LpVaultInitialized { pub lp_vault: Pubkey, pub protocol: LpProtocolKind, pub pool: Pubkey }
#[event] pub struct LpDeposited        { pub lp_vault: Pubkey, pub user: Pubkey, pub liquidity_amount: u128, pub shares_minted: u64 }
#[event] pub struct LpWithdrawn        { pub lp_vault: Pubkey, pub user: Pubkey, pub shares_burned: u64, pub liquidity_amount: u128 }
#[event] pub struct LpPositionExited   { pub lp_vault: Pubkey, pub liquidity_removed: u128 }
#[event] pub struct LpPositionReopened { pub lp_vault: Pubkey, pub tick_lower_index: i32, pub tick_upper_index: i32 }
#[event] pub struct LpLiquidityRedeployed { pub lp_vault: Pubkey, pub liquidity_amount: u128 }

pub mod orca_lp {
    //! Orca Whirlpool-specific LP vault instructions.
    use super::*;

    // ── Account contexts ──────────────────────────────────────────────────

    #[derive(Accounts)]
    #[instruction(params: InitLpVaultParams)]
    pub struct InitializeOrcaLpVault<'info> {
        #[account(mut)]
        pub admin: Signer<'info>,

        #[account(
            init, payer = admin, space = LpVault::LEN,
            seeds = [b"lp_vault", token_a_mint.key().as_ref(), token_b_mint.key().as_ref(), admin.key().as_ref()],
            bump,
        )]
        pub lp_vault: Box<Account<'info, LpVault>>,

        /// CHECK: PDA, verified by seeds. MUST be `mut`: the open_position CPI passes
        /// this as Orca's `funder` (writable + signer), and a CPI cannot escalate an
        /// account to writable if the outer instruction declared it read-only.
        /// Found by the local harness 2026-07-20 ("writable privilege escalated").
        #[account(mut, seeds = [b"lp_vault_authority", lp_vault.key().as_ref()], bump)]
        pub vault_authority: UncheckedAccount<'info>,

        pub token_a_mint: Box<Account<'info, Mint>>,
        pub token_b_mint: Box<Account<'info, Mint>>,

        #[account(
            init, payer = admin,
            associated_token::mint = token_a_mint, associated_token::authority = vault_authority,
        )]
        pub vault_token_a_account: Box<Account<'info, TokenAccount>>,
        #[account(
            init, payer = admin,
            associated_token::mint = token_b_mint, associated_token::authority = vault_authority,
        )]
        pub vault_token_b_account: Box<Account<'info, TokenAccount>>,

        #[account(
            init, payer = admin, mint::decimals = 9, mint::authority = vault_authority,
        )]
        pub lp_shares_mint: Box<Account<'info, Mint>>,

        // ── Orca open_position accounts (see adapters::orca::OrcaOpenPosition) ──
        /// CHECK: Whirlpool program validates + initializes
        #[account(mut)]
        pub position: UncheckedAccount<'info>,
        /// Position NFT mint. Does NOT exist yet - Orca's open_position inits it,
        /// so this must be an unvalidated Signer, never Account<Mint>. Typing it as
        /// Account<Mint> made Anchor deserialize it BEFORE the instruction body ran,
        /// failing with AccountNotInitialized (3012) and making this instruction
        /// permanently unreachable. Found by the local harness 2026-07-20 on the
        /// first ever execution of this code path.
        #[account(mut)]
        pub position_mint: Signer<'info>,
        /// CHECK: created by the open_position CPI as an ATA for position_mint owned
        /// by vault_authority. Same reason as above - cannot be Account<TokenAccount>
        /// because it does not exist when Anchor validates accounts.
        #[account(mut)]
        pub position_token_account: UncheckedAccount<'info>,
        /// CHECK: Whirlpool program validates
        pub whirlpool: UncheckedAccount<'info>,

        pub token_program: Program<'info, Token>,
        pub system_program: Program<'info, System>,
        pub rent: Sysvar<'info, Rent>,
        /// CHECK: associated token program
        pub associated_token_program: UncheckedAccount<'info>,
        /// CHECK: address verified in adapter
        #[account(address = WHIRLPOOL_PROGRAM_ID)]
        pub whirlpool_program: UncheckedAccount<'info>,
    }

    #[derive(Accounts)]
    pub struct DepositOrcaLp<'info> {
        #[account(mut)]
        pub user: Signer<'info>,

        #[account(mut, constraint = !lp_vault.paused @ LpVaultError::LpVaultPaused)]
        pub lp_vault: Box<Account<'info, LpVault>>,

        /// CHECK: PDA, verified by seeds
        #[account(seeds = [b"lp_vault_authority", lp_vault.key().as_ref()], bump = lp_vault.authority_bump)]
        pub vault_authority: UncheckedAccount<'info>,

        #[account(
            init_if_needed, payer = user,
            seeds = [b"lp_position", lp_vault.key().as_ref(), user.key().as_ref()],
            bump, space = LpUserPosition::LEN,
        )]
        pub user_position: Box<Account<'info, LpUserPosition>>,

        #[account(mut, constraint = user_token_a_account.owner == user.key())]
        pub user_token_a_account: Box<Account<'info, TokenAccount>>,
        #[account(mut, constraint = user_token_b_account.owner == user.key())]
        pub user_token_b_account: Box<Account<'info, TokenAccount>>,
        #[account(mut, constraint = user_shares_account.owner == user.key())]
        pub user_shares_account: Box<Account<'info, TokenAccount>>,

        #[account(mut, address = lp_vault.vault_token_a_account)]
        pub vault_token_a_account: Box<Account<'info, TokenAccount>>,
        #[account(mut, address = lp_vault.vault_token_b_account)]
        pub vault_token_b_account: Box<Account<'info, TokenAccount>>,
        #[account(mut, address = lp_vault.lp_shares_mint)]
        pub lp_shares_mint: Box<Account<'info, Mint>>,

        /// CHECK: Whirlpool program validates
        #[account(mut, address = lp_vault.pool)]
        pub whirlpool: UncheckedAccount<'info>,
        /// CHECK: Whirlpool program validates
        #[account(mut, address = lp_vault.position)]
        pub position: UncheckedAccount<'info>,
        #[account(address = lp_vault.position_token_account)]
        pub position_token_account: Box<Account<'info, TokenAccount>>,
        /// CHECK: Whirlpool program validates
        #[account(mut)]
        pub token_vault_a: UncheckedAccount<'info>,
        /// CHECK: Whirlpool program validates
        #[account(mut)]
        pub token_vault_b: UncheckedAccount<'info>,
        /// CHECK: Whirlpool program validates
        #[account(mut)]
        pub tick_array_lower: UncheckedAccount<'info>,
        /// CHECK: Whirlpool program validates
        #[account(mut)]
        pub tick_array_upper: UncheckedAccount<'info>,

        pub token_program: Program<'info, Token>,
        /// CHECK: address verified in adapter
        #[account(address = WHIRLPOOL_PROGRAM_ID)]
        pub whirlpool_program: UncheckedAccount<'info>,
        pub system_program: Program<'info, System>,
    }

    #[derive(Accounts)]
    pub struct WithdrawOrcaLp<'info> {
        #[account(mut)]
        pub user: Signer<'info>,

        #[account(mut)]
        pub lp_vault: Box<Account<'info, LpVault>>,

        /// CHECK: PDA, verified by seeds
        #[account(seeds = [b"lp_vault_authority", lp_vault.key().as_ref()], bump = lp_vault.authority_bump)]
        pub vault_authority: UncheckedAccount<'info>,

        #[account(
            mut,
            seeds = [b"lp_position", lp_vault.key().as_ref(), user.key().as_ref()],
            bump = user_position.bump,
            constraint = user_position.owner == user.key() @ LpVaultError::Unauthorized,
        )]
        pub user_position: Box<Account<'info, LpUserPosition>>,

        #[account(mut, constraint = user_token_a_account.owner == user.key())]
        pub user_token_a_account: Box<Account<'info, TokenAccount>>,
        #[account(mut, constraint = user_token_b_account.owner == user.key())]
        pub user_token_b_account: Box<Account<'info, TokenAccount>>,
        #[account(mut, constraint = user_shares_account.owner == user.key())]
        pub user_shares_account: Box<Account<'info, TokenAccount>>,

        #[account(mut, address = lp_vault.vault_token_a_account)]
        pub vault_token_a_account: Box<Account<'info, TokenAccount>>,
        #[account(mut, address = lp_vault.vault_token_b_account)]
        pub vault_token_b_account: Box<Account<'info, TokenAccount>>,
        #[account(mut, address = lp_vault.lp_shares_mint)]
        pub lp_shares_mint: Box<Account<'info, Mint>>,

        /// CHECK: Whirlpool program validates
        #[account(mut, address = lp_vault.pool)]
        pub whirlpool: UncheckedAccount<'info>,
        /// CHECK: Whirlpool program validates
        #[account(mut, address = lp_vault.position)]
        pub position: UncheckedAccount<'info>,
        #[account(address = lp_vault.position_token_account)]
        pub position_token_account: Box<Account<'info, TokenAccount>>,
        /// CHECK: Whirlpool program validates
        #[account(mut)]
        pub token_vault_a: UncheckedAccount<'info>,
        /// CHECK: Whirlpool program validates
        #[account(mut)]
        pub token_vault_b: UncheckedAccount<'info>,
        /// CHECK: Whirlpool program validates
        #[account(mut)]
        pub tick_array_lower: UncheckedAccount<'info>,
        /// CHECK: Whirlpool program validates
        #[account(mut)]
        pub tick_array_upper: UncheckedAccount<'info>,

        pub token_program: Program<'info, Token>,
        /// CHECK: address verified in adapter
        #[account(address = WHIRLPOOL_PROGRAM_ID)]
        pub whirlpool_program: UncheckedAccount<'info>,
    }

    #[derive(Accounts)]
    pub struct ExitOrcaLpPosition<'info> {
        #[account(mut, constraint = keeper.key() == lp_vault.keeper @ LpVaultError::Unauthorized)]
        pub keeper: Signer<'info>,

        #[account(mut, constraint = lp_vault.position_active @ LpVaultError::NoActivePosition)]
        pub lp_vault: Box<Account<'info, LpVault>>,

        /// CHECK: PDA, verified by seeds
        #[account(mut, seeds = [b"lp_vault_authority", lp_vault.key().as_ref()], bump = lp_vault.authority_bump)]
        pub vault_authority: UncheckedAccount<'info>,

        #[account(mut, address = lp_vault.vault_token_a_account)]
        pub vault_token_a_account: Box<Account<'info, TokenAccount>>,
        #[account(mut, address = lp_vault.vault_token_b_account)]
        pub vault_token_b_account: Box<Account<'info, TokenAccount>>,

        /// CHECK: Whirlpool program validates
        #[account(mut, address = lp_vault.pool)]
        pub whirlpool: UncheckedAccount<'info>,
        /// CHECK: Whirlpool program validates (close = vault_authority)
        #[account(mut, address = lp_vault.position)]
        pub position: UncheckedAccount<'info>,
        /// CHECK: Whirlpool program validates (address = position.position_mint)
        #[account(mut, address = lp_vault.position_mint)]
        pub position_mint: UncheckedAccount<'info>,
        #[account(mut, address = lp_vault.position_token_account)]
        pub position_token_account: Box<Account<'info, TokenAccount>>,
        /// CHECK: Whirlpool program validates
        #[account(mut)]
        pub token_vault_a: UncheckedAccount<'info>,
        /// CHECK: Whirlpool program validates
        #[account(mut)]
        pub token_vault_b: UncheckedAccount<'info>,
        /// CHECK: Whirlpool program validates
        #[account(mut)]
        pub tick_array_lower: UncheckedAccount<'info>,
        /// CHECK: Whirlpool program validates
        #[account(mut)]
        pub tick_array_upper: UncheckedAccount<'info>,

        pub token_program: Program<'info, Token>,
        /// CHECK: address verified in adapter
        #[account(address = WHIRLPOOL_PROGRAM_ID)]
        pub whirlpool_program: UncheckedAccount<'info>,
    }

    #[derive(Accounts)]
    pub struct OpenNewOrcaLpPosition<'info> {
        /// Either the admin or the keeper. The keeper MUST be able to open a position:
        /// it is the thing that exits on a reposition, and if it cannot re-enter the
        /// vault sits in cash until a human intervenes.
        #[account(
            mut,
            constraint = authority.key() == lp_vault.admin || authority.key() == lp_vault.keeper
                @ LpVaultError::Unauthorized
        )]
        pub authority: Signer<'info>,

        #[account(mut, constraint = !lp_vault.position_active @ LpVaultError::PositionStillActive)]
        pub lp_vault: Box<Account<'info, LpVault>>,

        /// CHECK: PDA, verified by seeds
        #[account(mut, seeds = [b"lp_vault_authority", lp_vault.key().as_ref()], bump = lp_vault.authority_bump)]
        pub vault_authority: UncheckedAccount<'info>,

        /// CHECK: Whirlpool program validates + initializes
        #[account(mut)]
        pub position: UncheckedAccount<'info>,
        /// Position NFT mint. Does NOT exist yet - Orca's open_position inits it,
        /// so this must be an unvalidated Signer, never Account<Mint>. Typing it as
        /// Account<Mint> made Anchor deserialize it BEFORE the instruction body ran,
        /// failing with AccountNotInitialized (3012) and making this instruction
        /// permanently unreachable. Found by the local harness 2026-07-20 on the
        /// first ever execution of this code path.
        #[account(mut)]
        pub position_mint: Signer<'info>,
        /// CHECK: created by the open_position CPI as an ATA for position_mint owned
        /// by vault_authority. Same reason as above - cannot be Account<TokenAccount>
        /// because it does not exist when Anchor validates accounts.
        #[account(mut)]
        pub position_token_account: UncheckedAccount<'info>,
        /// CHECK: Whirlpool program validates; must match lp_vault.pool
        #[account(address = lp_vault.pool)]
        pub whirlpool: UncheckedAccount<'info>,

        pub token_program: Program<'info, Token>,
        pub system_program: Program<'info, System>,
        pub rent: Sysvar<'info, Rent>,
        /// CHECK: associated token program
        pub associated_token_program: UncheckedAccount<'info>,
        /// CHECK: address verified in adapter
        #[account(address = WHIRLPOOL_PROGRAM_ID)]
        pub whirlpool_program: UncheckedAccount<'info>,
    }

    #[derive(Accounts)]
    pub struct RedeployOrcaLpLiquidity<'info> {
        #[account(constraint = keeper.key() == lp_vault.keeper @ LpVaultError::Unauthorized)]
        pub keeper: Signer<'info>,

        #[account(mut, constraint = lp_vault.position_active @ LpVaultError::NoActivePosition)]
        pub lp_vault: Box<Account<'info, LpVault>>,

        /// CHECK: PDA, verified by seeds
        #[account(seeds = [b"lp_vault_authority", lp_vault.key().as_ref()], bump = lp_vault.authority_bump)]
        pub vault_authority: UncheckedAccount<'info>,

        #[account(mut, address = lp_vault.vault_token_a_account)]
        pub vault_token_a_account: Box<Account<'info, TokenAccount>>,
        #[account(mut, address = lp_vault.vault_token_b_account)]
        pub vault_token_b_account: Box<Account<'info, TokenAccount>>,

        /// CHECK: Whirlpool program validates
        #[account(mut, address = lp_vault.pool)]
        pub whirlpool: UncheckedAccount<'info>,
        /// CHECK: Whirlpool program validates
        #[account(mut, address = lp_vault.position)]
        pub position: UncheckedAccount<'info>,
        #[account(address = lp_vault.position_token_account)]
        pub position_token_account: Box<Account<'info, TokenAccount>>,
        /// CHECK: Whirlpool program validates
        #[account(mut)]
        pub token_vault_a: UncheckedAccount<'info>,
        /// CHECK: Whirlpool program validates
        #[account(mut)]
        pub token_vault_b: UncheckedAccount<'info>,
        /// CHECK: Whirlpool program validates
        #[account(mut)]
        pub tick_array_lower: UncheckedAccount<'info>,
        /// CHECK: Whirlpool program validates
        #[account(mut)]
        pub tick_array_upper: UncheckedAccount<'info>,

        pub token_program: Program<'info, Token>,
        /// CHECK: address verified in adapter
        #[account(address = WHIRLPOOL_PROGRAM_ID)]
        pub whirlpool_program: UncheckedAccount<'info>,
    }

    // ── Handlers ────────────────────────────────────────────────────────────

    pub fn initialize_orca_lp_vault_handler(
        ctx: Context<InitializeOrcaLpVault>,
        params: InitLpVaultParams,
    ) -> Result<()> {
        require!(params.name.len() <= 32, LpVaultError::NameTooLong);

        let lp_vault_key = ctx.accounts.lp_vault.key();
        let authority_bump = ctx.bumps.vault_authority;
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];

        orca_open_position(
            CpiContext::new_with_signer(
                ctx.accounts.whirlpool_program.to_account_info(),
                OrcaOpenPosition {
                    vault_authority:          ctx.accounts.vault_authority.to_account_info(),
                    position:                 ctx.accounts.position.to_account_info(),
                    position_mint:            ctx.accounts.position_mint.to_account_info(),
                    position_token_account:   ctx.accounts.position_token_account.to_account_info(),
                    whirlpool:                ctx.accounts.whirlpool.to_account_info(),
                    token_program:            ctx.accounts.token_program.clone(),
                    system_program:           ctx.accounts.system_program.clone(),
                    rent:                     ctx.accounts.rent.clone(),
                    associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
                    whirlpool_program:        ctx.accounts.whirlpool_program.to_account_info(),
                },
                &[seeds],
            ),
            params.tick_lower_index,
            params.tick_upper_index,
            seeds,
        )?;

        let v = &mut ctx.accounts.lp_vault;
        v.admin                  = ctx.accounts.admin.key();
        v.keeper                 = params.keeper;
        v.treasury               = params.treasury;
        v.protocol                = LpProtocolKind::Orca;
        v.pool                    = ctx.accounts.whirlpool.key();
        v.position                = ctx.accounts.position.key();
        v.protocol_position       = Pubkey::default(); // unused for Orca
        v.position_mint           = ctx.accounts.position_mint.key();
        v.position_token_account  = ctx.accounts.position_token_account.key();
        v.token_a_mint            = ctx.accounts.token_a_mint.key();
        v.token_b_mint            = ctx.accounts.token_b_mint.key();
        v.vault_token_a_account   = ctx.accounts.vault_token_a_account.key();
        v.vault_token_b_account   = ctx.accounts.vault_token_b_account.key();
        v.lp_shares_mint          = ctx.accounts.lp_shares_mint.key();
        v.tick_lower_index        = params.tick_lower_index;
        v.tick_upper_index        = params.tick_upper_index;
        v.total_liquidity         = 0;
        v.total_shares            = 0;
        v.paused                  = false;
        v.position_active         = true;
        v.bump                    = ctx.bumps.lp_vault;
        v.authority_bump          = authority_bump;
        v.name                    = params.name;

        emit!(LpVaultInitialized { lp_vault: lp_vault_key, protocol: LpProtocolKind::Orca, pool: v.pool });
        Ok(())
    }

    pub fn deposit_orca_lp_handler(
        ctx: Context<DepositOrcaLp>,
        liquidity_amount: u128,
        token_max_a: u64,
        token_max_b: u64,
        acknowledge_impermanent_loss: bool,
    ) -> Result<()> {
        require!(liquidity_amount > 0, LpVaultError::ZeroAmount);
        require!(acknowledge_impermanent_loss, LpVaultError::MustAcknowledgeImpermanentLoss);
        require!(ctx.accounts.lp_vault.position_active, LpVaultError::NoActivePosition);

        let lp_vault_key = ctx.accounts.lp_vault.key();
        let authority_bump = ctx.accounts.lp_vault.authority_bump;
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];

        // Pull both tokens from the user into the vault's staging accounts BEFORE
        // adding liquidity — Orca's increase_liquidity pulls from these vault-owned
        // accounts, not directly from the user.
        anchor_spl::token::transfer(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer {
                from: ctx.accounts.user_token_a_account.to_account_info(),
                to: ctx.accounts.vault_token_a_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            }),
            token_max_a,
        )?;
        anchor_spl::token::transfer(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer {
                from: ctx.accounts.user_token_b_account.to_account_info(),
                to: ctx.accounts.vault_token_b_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            }),
            token_max_b,
        )?;

        orca_increase_liquidity(
            CpiContext::new_with_signer(
                ctx.accounts.whirlpool_program.to_account_info(),
                OrcaModifyLiquidity {
                    vault_authority:      ctx.accounts.vault_authority.to_account_info(),
                    whirlpool:            ctx.accounts.whirlpool.to_account_info(),
                    token_program:        ctx.accounts.token_program.clone(),
                    position_authority:   ctx.accounts.vault_authority.to_account_info(),
                    position:             ctx.accounts.position.to_account_info(),
                    position_token_account: (*ctx.accounts.position_token_account).clone(),
                    token_owner_account_a: (*ctx.accounts.vault_token_a_account).clone(),
                    token_owner_account_b: (*ctx.accounts.vault_token_b_account).clone(),
                    token_vault_a:        ctx.accounts.token_vault_a.to_account_info(),
                    token_vault_b:        ctx.accounts.token_vault_b.to_account_info(),
                    tick_array_lower:     ctx.accounts.tick_array_lower.to_account_info(),
                    tick_array_upper:     ctx.accounts.tick_array_upper.to_account_info(),
                    whirlpool_program:    ctx.accounts.whirlpool_program.to_account_info(),
                },
                &[seeds],
            ),
            liquidity_amount,
            token_max_a,
            token_max_b,
            seeds,
        )?;

        // Refund the unconsumed remainder to the user.
        //
        // `token_max_a`/`token_max_b` are slippage CAPS, not amounts: we transfer the
        // full cap in up front because Orca pulls from the vault's staging accounts,
        // but increase_liquidity consumes only what `liquidity_amount` actually needs.
        // Without this refund the difference is stranded in the vault with NO shares
        // minted against it — shares are calculated from `liquidity_amount`, so the
        // leftover belongs to nobody and withdraw (which only redeems from the
        // Whirlpool position) can never return it.
        //
        // Measured on the harness before this fix: depositing 2 SOL + 500 USDC with
        // generous caps put 0.000000523 SOL + 0.000851 USDC into the position and
        // stranded the rest; burning 100% of shares returned almost nothing.
        //
        // The staging accounts are pure pass-through, so refunding their ENTIRE
        // post-CPI balance is correct and self-healing: they always end at zero.
        ctx.accounts.vault_token_a_account.reload()?;
        ctx.accounts.vault_token_b_account.reload()?;

        let refund_a = ctx.accounts.vault_token_a_account.amount;
        if refund_a > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_token_a_account.to_account_info(),
                        to: ctx.accounts.user_token_a_account.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    &[seeds],
                ),
                refund_a,
            )?;
        }

        let refund_b = ctx.accounts.vault_token_b_account.amount;
        if refund_b > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_token_b_account.to_account_info(),
                        to: ctx.accounts.user_token_b_account.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    &[seeds],
                ),
                refund_b,
            )?;
        }
        msg!("deposit_orca_lp: refunded {} token_a / {} token_b to user", refund_a, refund_b);

        let v = &mut ctx.accounts.lp_vault;
        let shares_to_mint = calculate_deposit_shares(liquidity_amount, v.total_liquidity, v.total_shares)?;

        anchor_spl::token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::MintTo {
                    mint: ctx.accounts.lp_shares_mint.to_account_info(),
                    to: ctx.accounts.user_shares_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[seeds],
            ),
            shares_to_mint,
        )?;

        v.total_liquidity = v.total_liquidity.checked_add(liquidity_amount).ok_or(LpVaultError::MathOverflow)?;
        v.total_shares = v.total_shares.checked_add(shares_to_mint).ok_or(LpVaultError::MathOverflow)?;

        let pos = &mut ctx.accounts.user_position;
        if pos.owner == Pubkey::default() {
            pos.owner = ctx.accounts.user.key();
            pos.lp_vault = lp_vault_key;
            pos.bump = ctx.bumps.user_position;
        }
        pos.shares = pos.shares.checked_add(shares_to_mint).ok_or(LpVaultError::MathOverflow)?;
        pos.liquidity_at_deposit = pos.liquidity_at_deposit.checked_add(liquidity_amount).ok_or(LpVaultError::MathOverflow)?;

        emit!(LpDeposited { lp_vault: lp_vault_key, user: ctx.accounts.user.key(), liquidity_amount, shares_minted: shares_to_mint });
        Ok(())
    }

    pub fn withdraw_orca_lp_handler(
        ctx: Context<WithdrawOrcaLp>,
        shares: u64,
        token_min_a: u64,
        token_min_b: u64,
    ) -> Result<()> {
        require!(shares > 0, LpVaultError::ZeroAmount);
        require!(ctx.accounts.user_position.shares >= shares, LpVaultError::InsufficientShares);
        require!(ctx.accounts.lp_vault.position_active, LpVaultError::NoActivePosition);

        let lp_vault_key = ctx.accounts.lp_vault.key();
        let authority_bump = ctx.accounts.lp_vault.authority_bump;
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];

        let v = &ctx.accounts.lp_vault;
        let total_shares_before = v.total_shares;
        let liquidity_amount = calculate_withdraw_liquidity(shares, v.total_liquidity, v.total_shares)?;

        let vault_a_before = ctx.accounts.vault_token_a_account.amount;
        let vault_b_before = ctx.accounts.vault_token_b_account.amount;

        orca_decrease_liquidity(
            CpiContext::new_with_signer(
                ctx.accounts.whirlpool_program.to_account_info(),
                OrcaModifyLiquidity {
                    vault_authority:      ctx.accounts.vault_authority.to_account_info(),
                    whirlpool:            ctx.accounts.whirlpool.to_account_info(),
                    token_program:        ctx.accounts.token_program.clone(),
                    position_authority:   ctx.accounts.vault_authority.to_account_info(),
                    position:             ctx.accounts.position.to_account_info(),
                    position_token_account: (*ctx.accounts.position_token_account).clone(),
                    token_owner_account_a: (*ctx.accounts.vault_token_a_account).clone(),
                    token_owner_account_b: (*ctx.accounts.vault_token_b_account).clone(),
                    token_vault_a:        ctx.accounts.token_vault_a.to_account_info(),
                    token_vault_b:        ctx.accounts.token_vault_b.to_account_info(),
                    tick_array_lower:     ctx.accounts.tick_array_lower.to_account_info(),
                    tick_array_upper:     ctx.accounts.tick_array_upper.to_account_info(),
                    whirlpool_program:    ctx.accounts.whirlpool_program.to_account_info(),
                },
                &[seeds],
            ),
            liquidity_amount,
            token_min_a,
            token_min_b,
            seeds,
        )?;

        anchor_spl::token::burn(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), anchor_spl::token::Burn {
                mint: ctx.accounts.lp_shares_mint.to_account_info(),
                from: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            }),
            shares,
        )?;

        ctx.accounts.vault_token_a_account.reload()?;
        ctx.accounts.vault_token_b_account.reload()?;
        let received_a = ctx.accounts.vault_token_a_account.amount.saturating_sub(vault_a_before);
        let received_b = ctx.accounts.vault_token_b_account.amount.saturating_sub(vault_b_before);
        require!(received_a >= token_min_a, LpVaultError::SlippageExceeded);
        require!(received_b >= token_min_b, LpVaultError::SlippageExceeded);

        // Pro-rata slice of the vault's IDLE tokens (the balance that was already there
        // before this CPI). Shares represent a claim on the whole vault, not just on the
        // deployed position — exit parks liquidity here, and without this the difference
        // is unredeemable. Uses the PRE-burn share count deliberately.
        let idle_a = vault_a_before
            .checked_mul(shares).and_then(|x| x.checked_div(total_shares_before)).unwrap_or(0);
        let idle_b = vault_b_before
            .checked_mul(shares).and_then(|x| x.checked_div(total_shares_before)).unwrap_or(0);
        let payout_a = received_a.saturating_add(idle_a);
        let payout_b = received_b.saturating_add(idle_b);
        msg!("lp withdraw: position {}/{} + idle {}/{}", received_a, received_b, idle_a, idle_b);

        if payout_a > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
                    from: ctx.accounts.vault_token_a_account.to_account_info(),
                    to: ctx.accounts.user_token_a_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                }, &[seeds]),
                payout_a,
            )?;
        }
        if payout_b > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
                    from: ctx.accounts.vault_token_b_account.to_account_info(),
                    to: ctx.accounts.user_token_b_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                }, &[seeds]),
                payout_b,
            )?;
        }

        let v = &mut ctx.accounts.lp_vault;
        v.total_liquidity = v.total_liquidity.saturating_sub(liquidity_amount);
        v.total_shares = v.total_shares.saturating_sub(shares);

        let pos = &mut ctx.accounts.user_position;
        pos.shares = pos.shares.saturating_sub(shares);
        pos.liquidity_at_deposit = pos.liquidity_at_deposit.saturating_sub(liquidity_amount);

        emit!(LpWithdrawn { lp_vault: lp_vault_key, user: ctx.accounts.user.key(), shares_burned: shares, liquidity_amount });
        Ok(())
    }

    pub fn exit_orca_lp_position_handler(ctx: Context<ExitOrcaLpPosition>) -> Result<()> {
        let lp_vault_key = ctx.accounts.lp_vault.key();
        let authority_bump = ctx.accounts.lp_vault.authority_bump;
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];
        let total_liquidity = ctx.accounts.lp_vault.total_liquidity;

        if total_liquidity > 0 {
            orca_decrease_liquidity(
                CpiContext::new_with_signer(
                    ctx.accounts.whirlpool_program.to_account_info(),
                    OrcaModifyLiquidity {
                        vault_authority:      ctx.accounts.vault_authority.to_account_info(),
                        whirlpool:            ctx.accounts.whirlpool.to_account_info(),
                        token_program:        ctx.accounts.token_program.clone(),
                        position_authority:   ctx.accounts.vault_authority.to_account_info(),
                        position:             ctx.accounts.position.to_account_info(),
                        position_token_account: (*ctx.accounts.position_token_account).clone(),
                        token_owner_account_a: (*ctx.accounts.vault_token_a_account).clone(),
                        token_owner_account_b: (*ctx.accounts.vault_token_b_account).clone(),
                        token_vault_a:        ctx.accounts.token_vault_a.to_account_info(),
                        token_vault_b:        ctx.accounts.token_vault_b.to_account_info(),
                        tick_array_lower:     ctx.accounts.tick_array_lower.to_account_info(),
                        tick_array_upper:     ctx.accounts.tick_array_upper.to_account_info(),
                        whirlpool_program:    ctx.accounts.whirlpool_program.to_account_info(),
                    },
                    &[seeds],
                ),
                total_liquidity,
                0,
                0,
                seeds,
            )?;
        }

        orca_close_position(
            CpiContext::new_with_signer(
                ctx.accounts.whirlpool_program.to_account_info(),
                OrcaClosePosition {
                    vault_authority:        ctx.accounts.vault_authority.to_account_info(),
                    receiver:               ctx.accounts.vault_authority.to_account_info(),
                    position:               ctx.accounts.position.to_account_info(),
                    position_mint:          ctx.accounts.position_mint.to_account_info(),
                    position_token_account: (*ctx.accounts.position_token_account).clone(),
                    token_program:          ctx.accounts.token_program.clone(),
                    whirlpool_program:      ctx.accounts.whirlpool_program.to_account_info(),
                },
                &[seeds],
            ),
            seeds,
        )?;

        let v = &mut ctx.accounts.lp_vault;
        v.total_liquidity = 0;
        v.position_active = false;

        emit!(LpPositionExited { lp_vault: lp_vault_key, liquidity_removed: total_liquidity });
        Ok(())
    }

    pub fn open_new_orca_lp_position_handler(
        ctx: Context<OpenNewOrcaLpPosition>,
        tick_lower_index: i32,
        tick_upper_index: i32,
    ) -> Result<()> {
        let lp_vault_key = ctx.accounts.lp_vault.key();
        let authority_bump = ctx.accounts.lp_vault.authority_bump;
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];

        orca_open_position(
            CpiContext::new_with_signer(
                ctx.accounts.whirlpool_program.to_account_info(),
                OrcaOpenPosition {
                    vault_authority:          ctx.accounts.vault_authority.to_account_info(),
                    position:                 ctx.accounts.position.to_account_info(),
                    position_mint:            ctx.accounts.position_mint.to_account_info(),
                    position_token_account:   ctx.accounts.position_token_account.to_account_info(),
                    whirlpool:                ctx.accounts.whirlpool.to_account_info(),
                    token_program:            ctx.accounts.token_program.clone(),
                    system_program:           ctx.accounts.system_program.clone(),
                    rent:                     ctx.accounts.rent.clone(),
                    associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
                    whirlpool_program:        ctx.accounts.whirlpool_program.to_account_info(),
                },
                &[seeds],
            ),
            tick_lower_index,
            tick_upper_index,
            seeds,
        )?;

        let v = &mut ctx.accounts.lp_vault;
        v.position               = ctx.accounts.position.key();
        v.position_mint          = ctx.accounts.position_mint.key();
        v.position_token_account = ctx.accounts.position_token_account.key();
        v.tick_lower_index       = tick_lower_index;
        v.tick_upper_index       = tick_upper_index;
        v.position_active        = true;

        emit!(LpPositionReopened { lp_vault: lp_vault_key, tick_lower_index, tick_upper_index });
        Ok(())
    }

    pub fn redeploy_orca_lp_liquidity_handler(
        ctx: Context<RedeployOrcaLpLiquidity>,
        liquidity_amount: u128,
        token_max_a: u64,
        token_max_b: u64,
    ) -> Result<()> {
        require!(liquidity_amount > 0, LpVaultError::ZeroAmount);

        // CLAMP the slippage caps to what the vault actually holds — do NOT require the
        // vault to hold the full cap.
        //
        // token_max_{a,b} are UPPER BOUNDS ("never spend more than this"), not amounts.
        // The old guard demanded `idle >= token_max`, so the keeper's reposition failed
        // for any realistic cap: it would have had to set the cap exactly equal to its
        // idle balance, which defeats the purpose of a cap. Found by the local harness
        // 2026-07-20 — the vault held 0.178 USDC and a 500 USDC cap was rejected even
        // though the redeploy needed a tiny fraction of that.
        //
        // The check was also redundant: increase_liquidity fails on its own if it needs
        // more than the token accounts hold, so clamping is strictly safer AND correct —
        // the caller's intent (an upper bound) is preserved, and we never ask the pool to
        // pull more than exists.
        let token_max_a = token_max_a.min(ctx.accounts.vault_token_a_account.amount);
        let token_max_b = token_max_b.min(ctx.accounts.vault_token_b_account.amount);

        let lp_vault_key = ctx.accounts.lp_vault.key();
        let authority_bump = ctx.accounts.lp_vault.authority_bump;
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];

        orca_increase_liquidity(
            CpiContext::new_with_signer(
                ctx.accounts.whirlpool_program.to_account_info(),
                OrcaModifyLiquidity {
                    vault_authority:      ctx.accounts.vault_authority.to_account_info(),
                    whirlpool:            ctx.accounts.whirlpool.to_account_info(),
                    token_program:        ctx.accounts.token_program.clone(),
                    position_authority:   ctx.accounts.vault_authority.to_account_info(),
                    position:             ctx.accounts.position.to_account_info(),
                    position_token_account: (*ctx.accounts.position_token_account).clone(),
                    token_owner_account_a: (*ctx.accounts.vault_token_a_account).clone(),
                    token_owner_account_b: (*ctx.accounts.vault_token_b_account).clone(),
                    token_vault_a:        ctx.accounts.token_vault_a.to_account_info(),
                    token_vault_b:        ctx.accounts.token_vault_b.to_account_info(),
                    tick_array_lower:     ctx.accounts.tick_array_lower.to_account_info(),
                    tick_array_upper:     ctx.accounts.tick_array_upper.to_account_info(),
                    whirlpool_program:    ctx.accounts.whirlpool_program.to_account_info(),
                },
                &[seeds],
            ),
            liquidity_amount,
            token_max_a,
            token_max_b,
            seeds,
        )?;

        let v = &mut ctx.accounts.lp_vault;
        v.total_liquidity = v.total_liquidity.checked_add(liquidity_amount).ok_or(LpVaultError::MathOverflow)?;

        emit!(LpLiquidityRedeployed { lp_vault: lp_vault_key, liquidity_amount });
        Ok(())
    }
}

pub mod raydium_lp {
    //! Raydium CLMM-specific LP vault instructions.
    use super::*;

    // ── Account contexts ──────────────────────────────────────────────────

    #[derive(Accounts)]
    #[instruction(params: InitLpVaultParams)]
    pub struct InitializeRaydiumLpVault<'info> {
        #[account(mut)]
        pub admin: Signer<'info>,

        #[account(
            init, payer = admin, space = LpVault::LEN,
            seeds = [b"lp_vault", token_a_mint.key().as_ref(), token_b_mint.key().as_ref(), admin.key().as_ref()],
            bump,
        )]
        pub lp_vault: Box<Account<'info, LpVault>>,

        /// CHECK: PDA, verified by seeds. MUST be `mut`: the open_position CPI passes
        /// this as the funder (writable + signer), and a CPI cannot escalate an account
        /// to writable if the outer instruction declared it read-only. Mirrors the Orca
        /// fix, which was proven on the harness 2026-07-20.
        #[account(mut, seeds = [b"lp_vault_authority", lp_vault.key().as_ref()], bump)]
        pub vault_authority: UncheckedAccount<'info>,

        pub token_a_mint: Box<Account<'info, Mint>>,
        pub token_b_mint: Box<Account<'info, Mint>>,

        #[account(
            init, payer = admin,
            associated_token::mint = token_a_mint, associated_token::authority = vault_authority,
        )]
        pub vault_token_a_account: Box<Account<'info, TokenAccount>>,
        #[account(
            init, payer = admin,
            associated_token::mint = token_b_mint, associated_token::authority = vault_authority,
        )]
        pub vault_token_b_account: Box<Account<'info, TokenAccount>>,

        #[account(
            init, payer = admin, mint::decimals = 9, mint::authority = vault_authority,
        )]
        pub lp_shares_mint: Box<Account<'info, Mint>>,

        // ── Raydium open_position accounts (see adapters::raydium::RaydiumOpenPosition) ──
        /// Position NFT mint. Does NOT exist yet — Raydium's open_position inits it,
        /// so it must be an unvalidated Signer. Typing it Account<Mint> makes Anchor
        /// deserialize it before the body runs (AccountNotInitialized 3012) AND leaves
        /// isSigner=false so the outer tx cannot carry the signature Raydium needs.
        /// Identical to the Orca bug proven on the harness 2026-07-20.
        #[account(mut)]
        pub position_nft_mint: Signer<'info>,
        /// CHECK: created by the open_position CPI; does not exist at validation time.
        #[account(mut)]
        pub position_nft_account: UncheckedAccount<'info>,
        /// CHECK: Metaplex program validates + initializes
        #[account(mut)]
        pub metadata_account: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (zero-copy on-chain)
        #[account(mut)]
        pub pool_state: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (deprecated but still required —
        /// see adapters/raydium.rs PDA seed notes). MUST be `mut`: open_position
        /// initializes it on first use for a tick range, and every liquidity change
        /// writes to it.
        #[account(mut)]
        pub protocol_position: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_lower: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_upper: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates + initializes (PDA)
        #[account(mut)]
        pub personal_position: UncheckedAccount<'info>,

        #[account(mut)]
        pub token_account_0: Box<Account<'info, TokenAccount>>,
        #[account(mut)]
        pub token_account_1: Box<Account<'info, TokenAccount>>,
        /// CHECK: Raydium validates against pool_state.token_vault_0
        #[account(mut)]
        pub token_vault_0: UncheckedAccount<'info>,
        /// CHECK: Raydium validates against pool_state.token_vault_1
        #[account(mut)]
        pub token_vault_1: UncheckedAccount<'info>,

        pub rent: Sysvar<'info, Rent>,
        pub system_program: Program<'info, System>,
        pub token_program: Program<'info, Token>,
        /// CHECK: associated token program
        pub associated_token_program: UncheckedAccount<'info>,
        /// CHECK: address verified in adapter
        #[account(address = METADATA_PROGRAM_ID)]
        pub metadata_program: UncheckedAccount<'info>,
        /// CHECK: address verified in adapter
        #[account(address = RAYDIUM_CLMM_PROGRAM_ID)]
        pub raydium_program: UncheckedAccount<'info>,
    }

    #[derive(Accounts)]
    pub struct DepositRaydiumLp<'info> {
        #[account(mut)]
        pub user: Signer<'info>,

        #[account(mut, constraint = !lp_vault.paused @ LpVaultError::LpVaultPaused)]
        pub lp_vault: Box<Account<'info, LpVault>>,

        /// CHECK: PDA, verified by seeds
        #[account(seeds = [b"lp_vault_authority", lp_vault.key().as_ref()], bump = lp_vault.authority_bump)]
        pub vault_authority: UncheckedAccount<'info>,

        #[account(
            init_if_needed, payer = user,
            seeds = [b"lp_position", lp_vault.key().as_ref(), user.key().as_ref()],
            bump, space = LpUserPosition::LEN,
        )]
        pub user_position: Box<Account<'info, LpUserPosition>>,

        #[account(mut, constraint = user_token_a_account.owner == user.key())]
        pub user_token_a_account: Box<Account<'info, TokenAccount>>,
        #[account(mut, constraint = user_token_b_account.owner == user.key())]
        pub user_token_b_account: Box<Account<'info, TokenAccount>>,
        #[account(mut, constraint = user_shares_account.owner == user.key())]
        pub user_shares_account: Box<Account<'info, TokenAccount>>,

        #[account(mut, address = lp_vault.vault_token_a_account)]
        pub vault_token_a_account: Box<Account<'info, TokenAccount>>,
        #[account(mut, address = lp_vault.vault_token_b_account)]
        pub vault_token_b_account: Box<Account<'info, TokenAccount>>,
        #[account(mut, address = lp_vault.lp_shares_mint)]
        pub lp_shares_mint: Box<Account<'info, Mint>>,

        #[account(constraint = nft_account.amount == 1)]
        pub nft_account: Box<Account<'info, TokenAccount>>,
        /// CHECK: Raydium program validates
        #[account(mut, address = lp_vault.pool)]
        pub pool_state: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (deprecated but still required)
        /// CHECK: Raydium validates. MUST be `mut` — every liquidity change writes to
        /// the protocol position's accumulators; a CPI cannot escalate a read-only
        /// account to writable.
        #[account(mut, address = lp_vault.protocol_position)]
        pub protocol_position: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates
        #[account(mut, address = lp_vault.position)]
        pub personal_position: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_lower: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_upper: UncheckedAccount<'info>,
        /// CHECK: Raydium validates against pool_state.token_vault_0
        #[account(mut)]
        pub token_vault_0: UncheckedAccount<'info>,
        /// CHECK: Raydium validates against pool_state.token_vault_1
        #[account(mut)]
        pub token_vault_1: UncheckedAccount<'info>,

        pub token_program: Program<'info, Token>,
        pub system_program: Program<'info, System>,
        /// CHECK: address verified in adapter
        #[account(address = RAYDIUM_CLMM_PROGRAM_ID)]
        pub raydium_program: UncheckedAccount<'info>,
    }

    #[derive(Accounts)]
    pub struct WithdrawRaydiumLp<'info> {
        #[account(mut)]
        pub user: Signer<'info>,

        #[account(mut)]
        pub lp_vault: Box<Account<'info, LpVault>>,

        /// CHECK: PDA, verified by seeds
        #[account(seeds = [b"lp_vault_authority", lp_vault.key().as_ref()], bump = lp_vault.authority_bump)]
        pub vault_authority: UncheckedAccount<'info>,

        #[account(
            mut,
            seeds = [b"lp_position", lp_vault.key().as_ref(), user.key().as_ref()],
            bump = user_position.bump,
            constraint = user_position.owner == user.key() @ LpVaultError::Unauthorized,
        )]
        pub user_position: Box<Account<'info, LpUserPosition>>,

        #[account(mut, constraint = user_token_a_account.owner == user.key())]
        pub user_token_a_account: Box<Account<'info, TokenAccount>>,
        #[account(mut, constraint = user_token_b_account.owner == user.key())]
        pub user_token_b_account: Box<Account<'info, TokenAccount>>,
        #[account(mut, constraint = user_shares_account.owner == user.key())]
        pub user_shares_account: Box<Account<'info, TokenAccount>>,

        #[account(mut, address = lp_vault.vault_token_a_account)]
        pub vault_token_a_account: Box<Account<'info, TokenAccount>>,
        #[account(mut, address = lp_vault.vault_token_b_account)]
        pub vault_token_b_account: Box<Account<'info, TokenAccount>>,
        #[account(mut, address = lp_vault.lp_shares_mint)]
        pub lp_shares_mint: Box<Account<'info, Mint>>,

        #[account(constraint = nft_account.amount == 1)]
        pub nft_account: Box<Account<'info, TokenAccount>>,
        /// CHECK: Raydium program validates
        #[account(mut, address = lp_vault.pool)]
        pub pool_state: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (deprecated but still required)
        /// CHECK: Raydium validates. MUST be `mut` — every liquidity change writes to
        /// the protocol position's accumulators; a CPI cannot escalate a read-only
        /// account to writable.
        #[account(mut, address = lp_vault.protocol_position)]
        pub protocol_position: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates
        #[account(mut, address = lp_vault.position)]
        pub personal_position: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_lower: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_upper: UncheckedAccount<'info>,
        /// CHECK: Raydium validates against pool_state.token_vault_0
        #[account(mut)]
        pub token_vault_0: UncheckedAccount<'info>,
        /// CHECK: Raydium validates against pool_state.token_vault_1
        #[account(mut)]
        pub token_vault_1: UncheckedAccount<'info>,

        pub token_program: Program<'info, Token>,
        /// CHECK: address verified in adapter
        #[account(address = RAYDIUM_CLMM_PROGRAM_ID)]
        pub raydium_program: UncheckedAccount<'info>,
    }

    #[derive(Accounts)]
    pub struct ExitRaydiumLpPosition<'info> {
        #[account(mut, constraint = keeper.key() == lp_vault.keeper @ LpVaultError::Unauthorized)]
        pub keeper: Signer<'info>,

        #[account(mut, constraint = lp_vault.position_active @ LpVaultError::NoActivePosition)]
        pub lp_vault: Box<Account<'info, LpVault>>,

        /// CHECK: PDA, verified by seeds
        #[account(mut, seeds = [b"lp_vault_authority", lp_vault.key().as_ref()], bump = lp_vault.authority_bump)]
        pub vault_authority: UncheckedAccount<'info>,

        #[account(mut, address = lp_vault.vault_token_a_account)]
        pub vault_token_a_account: Box<Account<'info, TokenAccount>>,
        #[account(mut, address = lp_vault.vault_token_b_account)]
        pub vault_token_b_account: Box<Account<'info, TokenAccount>>,

        #[account(mut, constraint = position_nft_account.amount == 1, address = lp_vault.position_token_account)]
        pub position_nft_account: Box<Account<'info, TokenAccount>>,
        /// CHECK: Raydium program validates
        #[account(mut, address = lp_vault.pool)]
        pub pool_state: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (deprecated but still required)
        /// CHECK: Raydium validates. MUST be `mut` — every liquidity change writes to
        /// the protocol position's accumulators; a CPI cannot escalate a read-only
        /// account to writable.
        #[account(mut, address = lp_vault.protocol_position)]
        pub protocol_position: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates
        #[account(mut, address = lp_vault.position)]
        pub personal_position: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (address = personal_position.nft_mint)
        #[account(mut, address = lp_vault.position_mint)]
        pub position_nft_mint: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_lower: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_upper: UncheckedAccount<'info>,
        /// CHECK: Raydium validates against pool_state.token_vault_0
        #[account(mut)]
        pub token_vault_0: UncheckedAccount<'info>,
        /// CHECK: Raydium validates against pool_state.token_vault_1
        #[account(mut)]
        pub token_vault_1: UncheckedAccount<'info>,

        pub system_program: Program<'info, System>,
        pub token_program: Program<'info, Token>,
        /// CHECK: address verified in adapter
        #[account(address = RAYDIUM_CLMM_PROGRAM_ID)]
        pub raydium_program: UncheckedAccount<'info>,
    }

    #[derive(Accounts)]
    pub struct OpenNewRaydiumLpPosition<'info> {
        /// Either the admin or the keeper. The keeper MUST be able to open a position:
        /// it is the thing that exits on a reposition, and if it cannot re-enter the
        /// vault sits in cash until a human intervenes.
        #[account(
            mut,
            constraint = authority.key() == lp_vault.admin || authority.key() == lp_vault.keeper
                @ LpVaultError::Unauthorized
        )]
        pub authority: Signer<'info>,

        #[account(mut, constraint = !lp_vault.position_active @ LpVaultError::PositionStillActive)]
        pub lp_vault: Box<Account<'info, LpVault>>,

        /// CHECK: PDA, verified by seeds
        #[account(mut, seeds = [b"lp_vault_authority", lp_vault.key().as_ref()], bump = lp_vault.authority_bump)]
        pub vault_authority: UncheckedAccount<'info>,

        #[account(mut)]
        /// Fresh position NFT mint for the NEW position — does not exist yet; Raydium's
        /// open_position inits it. Must be a Signer for the same reason as the init
        /// handler (AccountNotInitialized 3012, and isSigner must be true).
        pub position_nft_mint: Signer<'info>,
        #[account(mut)]
        /// CHECK: created by the open_position CPI; does not exist at validation time.
        pub position_nft_account: UncheckedAccount<'info>,
        /// CHECK: Metaplex program validates + initializes
        #[account(mut)]
        pub metadata_account: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates; must match lp_vault.pool
        #[account(mut, address = lp_vault.pool)]
        pub pool_state: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (deprecated but still required). MUST be
        /// `mut`: this is the NEW range's protocol position, which Raydium initializes
        /// on first use and writes to on every liquidity change.
        #[account(mut)]
        pub protocol_position: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_lower: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_upper: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates + initializes (PDA)
        #[account(mut)]
        pub personal_position: UncheckedAccount<'info>,

        #[account(mut, address = lp_vault.vault_token_a_account)]
        pub token_account_0: Box<Account<'info, TokenAccount>>,
        #[account(mut, address = lp_vault.vault_token_b_account)]
        pub token_account_1: Box<Account<'info, TokenAccount>>,
        /// CHECK: Raydium validates against pool_state.token_vault_0
        #[account(mut)]
        pub token_vault_0: UncheckedAccount<'info>,
        /// CHECK: Raydium validates against pool_state.token_vault_1
        #[account(mut)]
        pub token_vault_1: UncheckedAccount<'info>,

        pub rent: Sysvar<'info, Rent>,
        pub system_program: Program<'info, System>,
        pub token_program: Program<'info, Token>,
        /// CHECK: associated token program
        pub associated_token_program: UncheckedAccount<'info>,
        /// CHECK: address verified in adapter
        #[account(address = METADATA_PROGRAM_ID)]
        pub metadata_program: UncheckedAccount<'info>,
        /// CHECK: address verified in adapter
        #[account(address = RAYDIUM_CLMM_PROGRAM_ID)]
        pub raydium_program: UncheckedAccount<'info>,
    }

    #[derive(Accounts)]
    pub struct RedeployRaydiumLpLiquidity<'info> {
        #[account(constraint = keeper.key() == lp_vault.keeper @ LpVaultError::Unauthorized)]
        pub keeper: Signer<'info>,

        #[account(mut, constraint = lp_vault.position_active @ LpVaultError::NoActivePosition)]
        pub lp_vault: Box<Account<'info, LpVault>>,

        /// CHECK: PDA, verified by seeds
        #[account(seeds = [b"lp_vault_authority", lp_vault.key().as_ref()], bump = lp_vault.authority_bump)]
        pub vault_authority: UncheckedAccount<'info>,

        #[account(mut, address = lp_vault.vault_token_a_account)]
        pub vault_token_a_account: Box<Account<'info, TokenAccount>>,
        #[account(mut, address = lp_vault.vault_token_b_account)]
        pub vault_token_b_account: Box<Account<'info, TokenAccount>>,

        #[account(constraint = nft_account.amount == 1)]
        pub nft_account: Box<Account<'info, TokenAccount>>,
        /// CHECK: Raydium program validates
        #[account(mut, address = lp_vault.pool)]
        pub pool_state: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (deprecated but still required)
        /// CHECK: Raydium validates. MUST be `mut` — every liquidity change writes to
        /// the protocol position's accumulators; a CPI cannot escalate a read-only
        /// account to writable.
        #[account(mut, address = lp_vault.protocol_position)]
        pub protocol_position: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates
        #[account(mut, address = lp_vault.position)]
        pub personal_position: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_lower: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_upper: UncheckedAccount<'info>,
        /// CHECK: Raydium validates against pool_state.token_vault_0
        #[account(mut)]
        pub token_vault_0: UncheckedAccount<'info>,
        /// CHECK: Raydium validates against pool_state.token_vault_1
        #[account(mut)]
        pub token_vault_1: UncheckedAccount<'info>,

        pub token_program: Program<'info, Token>,
        /// CHECK: address verified in adapter
        #[account(address = RAYDIUM_CLMM_PROGRAM_ID)]
        pub raydium_program: UncheckedAccount<'info>,
    }

    // ── Handlers ────────────────────────────────────────────────────────────

    pub fn initialize_raydium_lp_vault_handler(
        ctx: Context<InitializeRaydiumLpVault>,
        params: InitLpVaultParams,
    ) -> Result<()> {
        require!(params.name.len() <= 32, LpVaultError::NameTooLong);

        let lp_vault_key = ctx.accounts.lp_vault.key();
        let authority_bump = ctx.bumps.vault_authority;
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];

        // Opened with zero initial liquidity, mirroring the Orca vault's
        // two-step flow (open, then deposit_*_lp for the first real
        // deposit) — even though Raydium's own instruction supports
        // depositing liquidity in the same call, keeping both protocols'
        // vault-creation semantics identical is worth more than saving one
        // instruction.
        raydium_open_position(
            CpiContext::new_with_signer(
                ctx.accounts.raydium_program.to_account_info(),
                RaydiumOpenPosition {
                    vault_authority:          ctx.accounts.vault_authority.to_account_info(),
                    position_nft_mint:        ctx.accounts.position_nft_mint.to_account_info(),
                    position_nft_account:     ctx.accounts.position_nft_account.to_account_info(),
                    metadata_account:         ctx.accounts.metadata_account.to_account_info(),
                    pool_state:               ctx.accounts.pool_state.to_account_info(),
                    protocol_position:        ctx.accounts.protocol_position.to_account_info(),
                    tick_array_lower:         ctx.accounts.tick_array_lower.to_account_info(),
                    tick_array_upper:         ctx.accounts.tick_array_upper.to_account_info(),
                    personal_position:        ctx.accounts.personal_position.to_account_info(),
                    token_account_0:          (*ctx.accounts.token_account_0).clone(),
                    token_account_1:          (*ctx.accounts.token_account_1).clone(),
                    token_vault_0:            ctx.accounts.token_vault_0.to_account_info(),
                    token_vault_1:            ctx.accounts.token_vault_1.to_account_info(),
                    rent:                     ctx.accounts.rent.clone(),
                    system_program:           ctx.accounts.system_program.clone(),
                    token_program:            ctx.accounts.token_program.clone(),
                    associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
                    metadata_program:         ctx.accounts.metadata_program.to_account_info(),
                    raydium_program:          ctx.accounts.raydium_program.to_account_info(),
                },
                &[seeds],
            ),
            params.tick_lower_index,
            params.tick_upper_index,
            params.tick_array_lower_start_index,
            params.tick_array_upper_start_index,
            0, // liquidity — opened empty, see comment above
            0, // amount_0_max
            0, // amount_1_max
            seeds,
        )?;

        let v = &mut ctx.accounts.lp_vault;
        v.admin                  = ctx.accounts.admin.key();
        v.keeper                 = params.keeper;
        v.treasury               = params.treasury;
        v.protocol                = LpProtocolKind::Raydium;
        v.pool                    = ctx.accounts.pool_state.key();
        v.position                = ctx.accounts.personal_position.key();
        v.protocol_position       = ctx.accounts.protocol_position.key();
        v.position_mint           = ctx.accounts.position_nft_mint.key();
        v.position_token_account  = ctx.accounts.position_nft_account.key();
        v.token_a_mint            = ctx.accounts.token_a_mint.key();
        v.token_b_mint            = ctx.accounts.token_b_mint.key();
        v.vault_token_a_account   = ctx.accounts.vault_token_a_account.key();
        v.vault_token_b_account   = ctx.accounts.vault_token_b_account.key();
        v.lp_shares_mint          = ctx.accounts.lp_shares_mint.key();
        v.tick_lower_index        = params.tick_lower_index;
        v.tick_upper_index        = params.tick_upper_index;
        v.total_liquidity         = 0;
        v.total_shares            = 0;
        v.paused                  = false;
        v.position_active         = true;
        v.bump                    = ctx.bumps.lp_vault;
        v.authority_bump          = authority_bump;
        v.name                    = params.name;

        emit!(LpVaultInitialized { lp_vault: lp_vault_key, protocol: LpProtocolKind::Raydium, pool: v.pool });
        Ok(())
    }

    pub fn deposit_raydium_lp_handler(
        ctx: Context<DepositRaydiumLp>,
        liquidity_amount: u128,
        token_max_a: u64,
        token_max_b: u64,
        acknowledge_impermanent_loss: bool,
    ) -> Result<()> {
        require!(liquidity_amount > 0, LpVaultError::ZeroAmount);
        require!(acknowledge_impermanent_loss, LpVaultError::MustAcknowledgeImpermanentLoss);
        require!(ctx.accounts.lp_vault.position_active, LpVaultError::NoActivePosition);

        let lp_vault_key = ctx.accounts.lp_vault.key();
        let authority_bump = ctx.accounts.lp_vault.authority_bump;
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];

        anchor_spl::token::transfer(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer {
                from: ctx.accounts.user_token_a_account.to_account_info(),
                to: ctx.accounts.vault_token_a_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            }),
            token_max_a,
        )?;
        anchor_spl::token::transfer(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer {
                from: ctx.accounts.user_token_b_account.to_account_info(),
                to: ctx.accounts.vault_token_b_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            }),
            token_max_b,
        )?;

        raydium_increase_liquidity(
            CpiContext::new_with_signer(
                ctx.accounts.raydium_program.to_account_info(),
                RaydiumModifyLiquidity {
                    vault_authority:   ctx.accounts.vault_authority.to_account_info(),
                    nft_account:       (*ctx.accounts.nft_account).clone(),
                    pool_state:        ctx.accounts.pool_state.to_account_info(),
                    protocol_position: ctx.accounts.protocol_position.to_account_info(),
                    personal_position: ctx.accounts.personal_position.to_account_info(),
                    tick_array_lower:  ctx.accounts.tick_array_lower.to_account_info(),
                    tick_array_upper:  ctx.accounts.tick_array_upper.to_account_info(),
                    token_account_0:   (*ctx.accounts.vault_token_a_account).clone(),
                    token_account_1:   (*ctx.accounts.vault_token_b_account).clone(),
                    token_vault_0:     ctx.accounts.token_vault_0.to_account_info(),
                    token_vault_1:     ctx.accounts.token_vault_1.to_account_info(),
                    token_program:     ctx.accounts.token_program.clone(),
                    raydium_program:   ctx.accounts.raydium_program.to_account_info(),
                },
                &[seeds],
            ),
            liquidity_amount,
            token_max_a,
            token_max_b,
            seeds,
        )?;

        // Refund the unconsumed remainder — see deposit_orca_lp_handler for full
        // reasoning. token_max_{a,b} are slippage CAPS, not amounts; without this the
        // difference is stranded in the vault with no shares against it, and withdraw
        // (which only redeems from the position) can never return it.
        ctx.accounts.vault_token_a_account.reload()?;
        ctx.accounts.vault_token_b_account.reload()?;

        let refund_a = ctx.accounts.vault_token_a_account.amount;
        if refund_a > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_token_a_account.to_account_info(),
                        to: ctx.accounts.user_token_a_account.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    &[seeds],
                ),
                refund_a,
            )?;
        }

        let refund_b = ctx.accounts.vault_token_b_account.amount;
        if refund_b > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_token_b_account.to_account_info(),
                        to: ctx.accounts.user_token_b_account.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    &[seeds],
                ),
                refund_b,
            )?;
        }
        msg!("deposit_raydium_lp: refunded {} token_a / {} token_b to user", refund_a, refund_b);

        let v = &mut ctx.accounts.lp_vault;
        let shares_to_mint = calculate_deposit_shares(liquidity_amount, v.total_liquidity, v.total_shares)?;

        anchor_spl::token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::MintTo {
                    mint: ctx.accounts.lp_shares_mint.to_account_info(),
                    to: ctx.accounts.user_shares_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[seeds],
            ),
            shares_to_mint,
        )?;

        v.total_liquidity = v.total_liquidity.checked_add(liquidity_amount).ok_or(LpVaultError::MathOverflow)?;
        v.total_shares = v.total_shares.checked_add(shares_to_mint).ok_or(LpVaultError::MathOverflow)?;

        let pos = &mut ctx.accounts.user_position;
        if pos.owner == Pubkey::default() {
            pos.owner = ctx.accounts.user.key();
            pos.lp_vault = lp_vault_key;
            pos.bump = ctx.bumps.user_position;
        }
        pos.shares = pos.shares.checked_add(shares_to_mint).ok_or(LpVaultError::MathOverflow)?;
        pos.liquidity_at_deposit = pos.liquidity_at_deposit.checked_add(liquidity_amount).ok_or(LpVaultError::MathOverflow)?;

        emit!(LpDeposited { lp_vault: lp_vault_key, user: ctx.accounts.user.key(), liquidity_amount, shares_minted: shares_to_mint });
        Ok(())
    }

    pub fn withdraw_raydium_lp_handler<'info>(
        ctx: Context<'_, '_, '_, 'info, WithdrawRaydiumLp<'info>>,
        shares: u64,
        token_min_a: u64,
        token_min_b: u64,
    ) -> Result<()> {
        require!(shares > 0, LpVaultError::ZeroAmount);
        require!(ctx.accounts.user_position.shares >= shares, LpVaultError::InsufficientShares);
        require!(ctx.accounts.lp_vault.position_active, LpVaultError::NoActivePosition);

        let lp_vault_key = ctx.accounts.lp_vault.key();
        let authority_bump = ctx.accounts.lp_vault.authority_bump;
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];

        let v = &ctx.accounts.lp_vault;
        let total_shares_before = v.total_shares;
        let liquidity_amount = calculate_withdraw_liquidity(shares, v.total_liquidity, v.total_shares)?;

        let vault_a_before = ctx.accounts.vault_token_a_account.amount;
        let vault_b_before = ctx.accounts.vault_token_b_account.amount;

        raydium_decrease_liquidity(
            CpiContext::new_with_signer(
                ctx.accounts.raydium_program.to_account_info(),
                RaydiumModifyLiquidity {
                    vault_authority:   ctx.accounts.vault_authority.to_account_info(),
                    nft_account:       (*ctx.accounts.nft_account).clone(),
                    pool_state:        ctx.accounts.pool_state.to_account_info(),
                    protocol_position: ctx.accounts.protocol_position.to_account_info(),
                    personal_position: ctx.accounts.personal_position.to_account_info(),
                    tick_array_lower:  ctx.accounts.tick_array_lower.to_account_info(),
                    tick_array_upper:  ctx.accounts.tick_array_upper.to_account_info(),
                    token_account_0:   (*ctx.accounts.vault_token_a_account).clone(),
                    token_account_1:   (*ctx.accounts.vault_token_b_account).clone(),
                    token_vault_0:     ctx.accounts.token_vault_0.to_account_info(),
                    token_vault_1:     ctx.accounts.token_vault_1.to_account_info(),
                    token_program:     ctx.accounts.token_program.clone(),
                    raydium_program:   ctx.accounts.raydium_program.to_account_info(),
                },
                &[seeds],
            )
            // Raydium validates remaining_accounts against the pool's initialized
            // reward count; a CpiContext only carries them if the caller attaches
            // them, so forward this instruction's own.
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            liquidity_amount,
            token_min_a,
            token_min_b,
            seeds,
        )?;

        anchor_spl::token::burn(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), anchor_spl::token::Burn {
                mint: ctx.accounts.lp_shares_mint.to_account_info(),
                from: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            }),
            shares,
        )?;

        ctx.accounts.vault_token_a_account.reload()?;
        ctx.accounts.vault_token_b_account.reload()?;
        let received_a = ctx.accounts.vault_token_a_account.amount.saturating_sub(vault_a_before);
        let received_b = ctx.accounts.vault_token_b_account.amount.saturating_sub(vault_b_before);
        require!(received_a >= token_min_a, LpVaultError::SlippageExceeded);
        require!(received_b >= token_min_b, LpVaultError::SlippageExceeded);

        // Pro-rata slice of the vault's IDLE tokens (the balance that was already there
        // before this CPI). Shares represent a claim on the whole vault, not just on the
        // deployed position — exit parks liquidity here, and without this the difference
        // is unredeemable. Uses the PRE-burn share count deliberately.
        let idle_a = vault_a_before
            .checked_mul(shares).and_then(|x| x.checked_div(total_shares_before)).unwrap_or(0);
        let idle_b = vault_b_before
            .checked_mul(shares).and_then(|x| x.checked_div(total_shares_before)).unwrap_or(0);
        let payout_a = received_a.saturating_add(idle_a);
        let payout_b = received_b.saturating_add(idle_b);
        msg!("lp withdraw: position {}/{} + idle {}/{}", received_a, received_b, idle_a, idle_b);

        if payout_a > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
                    from: ctx.accounts.vault_token_a_account.to_account_info(),
                    to: ctx.accounts.user_token_a_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                }, &[seeds]),
                payout_a,
            )?;
        }
        if payout_b > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
                    from: ctx.accounts.vault_token_b_account.to_account_info(),
                    to: ctx.accounts.user_token_b_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                }, &[seeds]),
                payout_b,
            )?;
        }

        let v = &mut ctx.accounts.lp_vault;
        v.total_liquidity = v.total_liquidity.saturating_sub(liquidity_amount);
        v.total_shares = v.total_shares.saturating_sub(shares);

        let pos = &mut ctx.accounts.user_position;
        pos.shares = pos.shares.saturating_sub(shares);
        pos.liquidity_at_deposit = pos.liquidity_at_deposit.saturating_sub(liquidity_amount);

        emit!(LpWithdrawn { lp_vault: lp_vault_key, user: ctx.accounts.user.key(), shares_burned: shares, liquidity_amount });
        Ok(())
    }

    pub fn exit_raydium_lp_position_handler<'info>(
        ctx: Context<'_, '_, '_, 'info, ExitRaydiumLpPosition<'info>>,
    ) -> Result<()> {
        let lp_vault_key = ctx.accounts.lp_vault.key();
        let authority_bump = ctx.accounts.lp_vault.authority_bump;
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];
        let total_liquidity = ctx.accounts.lp_vault.total_liquidity;

        if total_liquidity > 0 {
            raydium_decrease_liquidity(
                CpiContext::new_with_signer(
                    ctx.accounts.raydium_program.to_account_info(),
                    RaydiumModifyLiquidity {
                        vault_authority:   ctx.accounts.vault_authority.to_account_info(),
                        nft_account:       (*ctx.accounts.position_nft_account).clone(),
                        pool_state:        ctx.accounts.pool_state.to_account_info(),
                        protocol_position: ctx.accounts.protocol_position.to_account_info(),
                        personal_position: ctx.accounts.personal_position.to_account_info(),
                        tick_array_lower:  ctx.accounts.tick_array_lower.to_account_info(),
                        tick_array_upper:  ctx.accounts.tick_array_upper.to_account_info(),
                        token_account_0:   (*ctx.accounts.vault_token_a_account).clone(),
                        token_account_1:   (*ctx.accounts.vault_token_b_account).clone(),
                        token_vault_0:     ctx.accounts.token_vault_0.to_account_info(),
                        token_vault_1:     ctx.accounts.token_vault_1.to_account_info(),
                        token_program:     ctx.accounts.token_program.clone(),
                        raydium_program:   ctx.accounts.raydium_program.to_account_info(),
                    },
                    &[seeds],
                )
                // Raydium validates remaining_accounts against the pool's initialized
                // reward count; a CpiContext only carries them if the caller attaches
                // them, so forward this instruction's own.
                .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
                total_liquidity,
                0,
                0,
                seeds,
            )?;
        }

        raydium_close_position(
            CpiContext::new_with_signer(
                ctx.accounts.raydium_program.to_account_info(),
                RaydiumClosePosition {
                    vault_authority:        ctx.accounts.vault_authority.to_account_info(),
                    position_nft_mint:      ctx.accounts.position_nft_mint.to_account_info(),
                    position_nft_account:   (*ctx.accounts.position_nft_account).clone(),
                    personal_position:      ctx.accounts.personal_position.to_account_info(),
                    system_program:         ctx.accounts.system_program.clone(),
                    token_program:          ctx.accounts.token_program.clone(),
                    raydium_program:        ctx.accounts.raydium_program.to_account_info(),
                },
                &[seeds],
            ),
            seeds,
        )?;

        let v = &mut ctx.accounts.lp_vault;
        v.total_liquidity = 0;
        v.position_active = false;

        emit!(LpPositionExited { lp_vault: lp_vault_key, liquidity_removed: total_liquidity });
        Ok(())
    }

    pub fn open_new_raydium_lp_position_handler(
        ctx: Context<OpenNewRaydiumLpPosition>,
        tick_lower_index: i32,
        tick_upper_index: i32,
        tick_array_lower_start_index: i32,
        tick_array_upper_start_index: i32,
    ) -> Result<()> {
        let lp_vault_key = ctx.accounts.lp_vault.key();
        let authority_bump = ctx.accounts.lp_vault.authority_bump;
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];

        raydium_open_position(
            CpiContext::new_with_signer(
                ctx.accounts.raydium_program.to_account_info(),
                RaydiumOpenPosition {
                    vault_authority:          ctx.accounts.vault_authority.to_account_info(),
                    position_nft_mint:        ctx.accounts.position_nft_mint.to_account_info(),
                    position_nft_account:     ctx.accounts.position_nft_account.to_account_info(),
                    metadata_account:         ctx.accounts.metadata_account.to_account_info(),
                    pool_state:               ctx.accounts.pool_state.to_account_info(),
                    protocol_position:        ctx.accounts.protocol_position.to_account_info(),
                    tick_array_lower:         ctx.accounts.tick_array_lower.to_account_info(),
                    tick_array_upper:         ctx.accounts.tick_array_upper.to_account_info(),
                    personal_position:        ctx.accounts.personal_position.to_account_info(),
                    token_account_0:          (*ctx.accounts.token_account_0).clone(),
                    token_account_1:          (*ctx.accounts.token_account_1).clone(),
                    token_vault_0:            ctx.accounts.token_vault_0.to_account_info(),
                    token_vault_1:            ctx.accounts.token_vault_1.to_account_info(),
                    rent:                     ctx.accounts.rent.clone(),
                    system_program:           ctx.accounts.system_program.clone(),
                    token_program:            ctx.accounts.token_program.clone(),
                    associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
                    metadata_program:         ctx.accounts.metadata_program.to_account_info(),
                    raydium_program:          ctx.accounts.raydium_program.to_account_info(),
                },
                &[seeds],
            ),
            tick_lower_index,
            tick_upper_index,
            tick_array_lower_start_index,
            tick_array_upper_start_index,
            0,
            0,
            0,
            seeds,
        )?;

        let v = &mut ctx.accounts.lp_vault;
        v.position                = ctx.accounts.personal_position.key();
        v.protocol_position       = ctx.accounts.protocol_position.key();
        v.position_mint           = ctx.accounts.position_nft_mint.key();
        v.position_token_account  = ctx.accounts.position_nft_account.key();
        v.tick_lower_index        = tick_lower_index;
        v.tick_upper_index        = tick_upper_index;
        v.position_active         = true;

        emit!(LpPositionReopened { lp_vault: lp_vault_key, tick_lower_index, tick_upper_index });
        Ok(())
    }

    pub fn redeploy_raydium_lp_liquidity_handler(
        ctx: Context<RedeployRaydiumLpLiquidity>,
        liquidity_amount: u128,
        token_max_a: u64,
        token_max_b: u64,
    ) -> Result<()> {
        require!(liquidity_amount > 0, LpVaultError::ZeroAmount);

        // CLAMP the slippage caps to what the vault actually holds — do NOT require the
        // vault to hold the full cap.
        //
        // token_max_{a,b} are UPPER BOUNDS ("never spend more than this"), not amounts.
        // The old guard demanded `idle >= token_max`, so the keeper's reposition failed
        // for any realistic cap: it would have had to set the cap exactly equal to its
        // idle balance, which defeats the purpose of a cap. Found by the local harness
        // 2026-07-20 — the vault held 0.178 USDC and a 500 USDC cap was rejected even
        // though the redeploy needed a tiny fraction of that.
        //
        // The check was also redundant: increase_liquidity fails on its own if it needs
        // more than the token accounts hold, so clamping is strictly safer AND correct —
        // the caller's intent (an upper bound) is preserved, and we never ask the pool to
        // pull more than exists.
        let token_max_a = token_max_a.min(ctx.accounts.vault_token_a_account.amount);
        let token_max_b = token_max_b.min(ctx.accounts.vault_token_b_account.amount);

        let lp_vault_key = ctx.accounts.lp_vault.key();
        let authority_bump = ctx.accounts.lp_vault.authority_bump;
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];

        raydium_increase_liquidity(
            CpiContext::new_with_signer(
                ctx.accounts.raydium_program.to_account_info(),
                RaydiumModifyLiquidity {
                    vault_authority:   ctx.accounts.vault_authority.to_account_info(),
                    nft_account:       (*ctx.accounts.nft_account).clone(),
                    pool_state:        ctx.accounts.pool_state.to_account_info(),
                    protocol_position: ctx.accounts.protocol_position.to_account_info(),
                    personal_position: ctx.accounts.personal_position.to_account_info(),
                    tick_array_lower:  ctx.accounts.tick_array_lower.to_account_info(),
                    tick_array_upper:  ctx.accounts.tick_array_upper.to_account_info(),
                    token_account_0:   (*ctx.accounts.vault_token_a_account).clone(),
                    token_account_1:   (*ctx.accounts.vault_token_b_account).clone(),
                    token_vault_0:     ctx.accounts.token_vault_0.to_account_info(),
                    token_vault_1:     ctx.accounts.token_vault_1.to_account_info(),
                    token_program:     ctx.accounts.token_program.clone(),
                    raydium_program:   ctx.accounts.raydium_program.to_account_info(),
                },
                &[seeds],
            ),
            liquidity_amount,
            token_max_a,
            token_max_b,
            seeds,
        )?;

        let v = &mut ctx.accounts.lp_vault;
        v.total_liquidity = v.total_liquidity.checked_add(liquidity_amount).ok_or(LpVaultError::MathOverflow)?;

        emit!(LpLiquidityRedeployed { lp_vault: lp_vault_key, liquidity_amount });
        Ok(())
    }
}
