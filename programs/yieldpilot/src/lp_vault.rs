//! LP vault — opt-in, dual-asset liquidity provision (Orca Whirlpools).
//!
//! Deliberately a SEPARATE product from the main single-asset `Vault`: it
//! accepts two tokens directly from the depositor (no swap step, no added
//! price-impact risk stacked onto impermanent loss) and is not part of the
//! core auto-routing promise. See project memory / whitepaper Phase 2.
//!
//! v1 scope, deliberately kept simple:
//! - Fixed price range, chosen once at vault init by admin (no active
//!   rebalancing yet — a real tradeoff: rebalancing is more capital-efficient
//!   but adds keeper complexity + rebalancing cost. Flagged as future work).
//! - `liquidity_amount` for deposit/withdraw is supplied by the caller
//!   (computed off-chain via Orca's SDK from desired token amounts and the
//!   pool's current price) rather than derived on-chain — keeps the Solana
//!   program's math simple and auditable; `token_max_a/b` / `token_min_a/b`
//!   are the on-chain slippage guard regardless of how the caller computed
//!   the liquidity figure.
//! - Deposits require an explicit on-chain acknowledgment of impermanent
//!   loss risk (`acknowledge_impermanent_loss: bool`, must be true) — a
//!   real, enforced gate, not just a frontend disclaimer.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount, Transfer};

use crate::adapters::orca::{
    OrcaClosePosition, OrcaModifyLiquidity, OrcaOpenPosition, WHIRLPOOL_PROGRAM_ID,
    orca_close_position, orca_decrease_liquidity, orca_increase_liquidity, orca_open_position,
};

// ── State ─────────────────────────────────────────────────────────────────────

#[account]
pub struct LpVault {
    pub admin:                    Pubkey,
    pub keeper:                   Pubkey,
    pub treasury:                 Pubkey,
    pub whirlpool:                Pubkey,
    pub position:                 Pubkey,
    pub position_mint:            Pubkey,
    pub position_token_account:   Pubkey,
    pub token_a_mint:              Pubkey,
    pub token_b_mint:              Pubkey,
    pub vault_token_a_account:    Pubkey,
    pub vault_token_b_account:    Pubkey,
    pub lp_shares_mint:           Pubkey,
    pub tick_lower_index:         i32,
    pub tick_upper_index:         i32,
    /// Total liquidity units currently contributed to the Whirlpool position
    /// (Orca's own u128 liquidity unit — NOT a token amount).
    pub total_liquidity:          u128,
    pub total_shares:             u64,
    pub paused:                   bool,
    /// False between exit_lp_position and open_new_lp_position — the vault
    /// holds idle tokens but has no live Whirlpool position. deposit_lp and
    /// withdraw_lp both require this to be true (see their constraints).
    pub position_active:         bool,
    pub bump:                     u8,
    pub authority_bump:           u8,
    pub name:                     String,
}

impl LpVault {
    pub const LEN: usize = 8
        + 32 * 11   // pubkeys
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
    #[msg("No active Whirlpool position — vault is mid-reposition")]
    NoActivePosition,
    #[msg("Position still has liquidity — exit it fully before reopening")]
    PositionStillActive,
}

// ── Account contexts ──────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(params: InitLpVaultParams)]
pub struct InitializeLpVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init, payer = admin, space = LpVault::LEN,
        seeds = [b"lp_vault", token_a_mint.key().as_ref(), token_b_mint.key().as_ref(), admin.key().as_ref()],
        bump,
    )]
    pub lp_vault: Box<Account<'info, LpVault>>,

    /// CHECK: PDA, verified by seeds
    #[account(seeds = [b"lp_vault_authority", lp_vault.key().as_ref()], bump)]
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
    #[account(mut)]
    pub position_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub position_token_account: Box<Account<'info, TokenAccount>>,
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
pub struct DepositLp<'info> {
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

    // ── Orca modify_liquidity accounts ──
    /// CHECK: Whirlpool program validates
    #[account(mut, address = lp_vault.whirlpool)]
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
pub struct WithdrawLp<'info> {
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
    #[account(mut, address = lp_vault.whirlpool)]
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

// ── Handlers ──────────────────────────────────────────────────────────────────

pub fn initialize_lp_vault_handler(
    ctx: Context<InitializeLpVault>,
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
                position_mint:            (*ctx.accounts.position_mint).clone(),
                position_token_account:   (*ctx.accounts.position_token_account).clone(),
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
    v.whirlpool               = ctx.accounts.whirlpool.key();
    v.position                = ctx.accounts.position.key();
    v.position_mint           = ctx.accounts.position_mint.key();
    v.position_token_account  = ctx.accounts.position_token_account.key();
    v.token_a_mint             = ctx.accounts.token_a_mint.key();
    v.token_b_mint             = ctx.accounts.token_b_mint.key();
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

    emit!(LpVaultInitialized { lp_vault: lp_vault_key, whirlpool: v.whirlpool });
    Ok(())
}

pub fn deposit_lp_handler(
    ctx: Context<DepositLp>,
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

    // TODO: any leftover in vault_token_{a,b}_account after the CPI (Orca
    // won't consume more than needed for `liquidity_amount`) should be
    // refunded to the user rather than left idle — not yet implemented.

    let v = &mut ctx.accounts.lp_vault;
    // Share price = total_liquidity / total_shares. First depositor mints
    // 1:1; later depositors mint proportional to existing liquidity, same
    // pattern as the main Vault's share math.
    let shares_to_mint: u64 = if v.total_shares == 0 || v.total_liquidity == 0 {
        // u128 liquidity down-scaled defensively; real precision handling is
        // a follow-up item once real pool liquidity magnitudes are known.
        liquidity_amount.min(u64::MAX as u128) as u64
    } else {
        ((liquidity_amount as u128)
            .checked_mul(v.total_shares as u128)
            .and_then(|x| x.checked_div(v.total_liquidity))
            .ok_or(LpVaultError::MathOverflow)?) as u64
    };
    require!(shares_to_mint > 0, LpVaultError::ZeroShares);

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

pub fn withdraw_lp_handler(
    ctx: Context<WithdrawLp>,
    shares: u64,
    token_min_a: u64,
    token_min_b: u64,
) -> Result<()> {
    require!(shares > 0, LpVaultError::ZeroAmount);
    require!(ctx.accounts.user_position.shares >= shares, LpVaultError::InsufficientShares);
    // NOTE: while a reposition is in progress (position_active == false),
    // withdrawals are briefly blocked — there's no live Whirlpool position
    // to decrease liquidity from. This is a deliberate, honest tradeoff for
    // a rare, short-lived admin action, not silently swallowed as a
    // different/confusing on-chain failure.
    require!(ctx.accounts.lp_vault.position_active, LpVaultError::NoActivePosition);

    let lp_vault_key = ctx.accounts.lp_vault.key();
    let authority_bump = ctx.accounts.lp_vault.authority_bump;
    let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];

    let v = &ctx.accounts.lp_vault;
    let liquidity_amount = (shares as u128)
        .checked_mul(v.total_liquidity)
        .and_then(|x| x.checked_div(v.total_shares as u128))
        .ok_or(LpVaultError::MathOverflow)?;

    // Measure vault staging-account balances before the CPI so we know
    // exactly how much of each token the pool actually returned — the real
    // amounts depend on the pool's live price at execution time, not just
    // the liquidity_amount we requested (same before/after pattern used by
    // recall_from_kamino / recall_from_marinade in the main vault).
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

    // Burn shares first (checks-effects-interactions).
    anchor_spl::token::burn(
        CpiContext::new(ctx.accounts.token_program.to_account_info(), anchor_spl::token::Burn {
            mint: ctx.accounts.lp_shares_mint.to_account_info(),
            from: ctx.accounts.user_shares_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        }),
        shares,
    )?;

    // Measure what the CPI actually deposited into the vault's staging
    // accounts, then enforce the caller's slippage guard against the REAL
    // amounts (not the requested liquidity_amount) before sending anything.
    ctx.accounts.vault_token_a_account.reload()?;
    ctx.accounts.vault_token_b_account.reload()?;
    let received_a = ctx.accounts.vault_token_a_account.amount.saturating_sub(vault_a_before);
    let received_b = ctx.accounts.vault_token_b_account.amount.saturating_sub(vault_b_before);
    require!(received_a >= token_min_a, LpVaultError::SlippageExceeded);
    require!(received_b >= token_min_b, LpVaultError::SlippageExceeded);

    let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];
    if received_a > 0 {
        anchor_spl::token::transfer(
            CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
                from: ctx.accounts.vault_token_a_account.to_account_info(),
                to: ctx.accounts.user_token_a_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            }, &[seeds]),
            received_a,
        )?;
    }
    if received_b > 0 {
        anchor_spl::token::transfer(
            CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
                from: ctx.accounts.vault_token_b_account.to_account_info(),
                to: ctx.accounts.user_token_b_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            }, &[seeds]),
            received_b,
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

// ── Reposition: manual, keeper/admin-triggered price-range change ────────────
//
// v1 price-range strategy: fixed at init, no automated rebalancing (real
// concentrated-liquidity market-making — deciding WHEN to move ranges based
// on price action — is a much bigger, riskier undertaking involving price
// oracles and timing heuristics; not something to guess at blind). Instead,
// the range can be manually repositioned in two explicit steps, mirroring
// how the main Vault already separates recall from deploy as distinct
// keeper-callable actions rather than one risky all-in-one instruction:
//
//   1. exit_lp_position (keeper) — fully exits the current position
//      (decrease ALL liquidity, close the position, reclaim its rent).
//      Vault's tokens end up idle in vault_token_{a,b}_account.
//      LP shares/user positions are untouched — they're a claim on the
//      vault's total token value, not tied to a specific Whirlpool position.
//   2. open_new_lp_position (admin) — opens a fresh position at a new tick
//      range. Vault is left with idle tokens NOT yet redeployed.
//
// Redeploying the idle tokens into the new position reuses deposit_lp's own
// increase_liquidity path is NOT correct (deposit_lp pulls from a user, not
// from the vault's own idle balance) — a dedicated "redeploy idle liquidity"
// instruction is a known follow-up, not yet implemented. Until then, exiting
// a position intentionally leaves it idle (safe — no funds lost/at risk that
// aren't already in vault-owned accounts) rather than risk an
// under-specified implementation moving real money incorrectly.

#[derive(Accounts)]
pub struct ExitLpPosition<'info> {
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
    #[account(mut, address = lp_vault.whirlpool)]
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

pub fn exit_lp_position_handler(ctx: Context<ExitLpPosition>) -> Result<()> {
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
            // No slippage guard here: this is a full, deliberate exit (not a
            // user withdrawal), and blocking it on a min-output threshold
            // would defeat the point of an emergency/administrative exit.
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

#[derive(Accounts)]
pub struct OpenNewLpPosition<'info> {
    #[account(constraint = admin.key() == lp_vault.admin @ LpVaultError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(mut, constraint = !lp_vault.position_active @ LpVaultError::PositionStillActive)]
    pub lp_vault: Box<Account<'info, LpVault>>,

    /// CHECK: PDA, verified by seeds
    #[account(mut, seeds = [b"lp_vault_authority", lp_vault.key().as_ref()], bump = lp_vault.authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: Whirlpool program validates + initializes
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    #[account(mut)]
    pub position_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub position_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: Whirlpool program validates; must match lp_vault.whirlpool
    #[account(address = lp_vault.whirlpool)]
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

pub fn open_new_lp_position_handler(
    ctx: Context<OpenNewLpPosition>,
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
                position_mint:            (*ctx.accounts.position_mint).clone(),
                position_token_account:   (*ctx.accounts.position_token_account).clone(),
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
    // total_liquidity stays 0 until a follow-up "redeploy idle liquidity"
    // instruction (not yet implemented) moves the vault's idle tokens in.

    emit!(LpPositionReopened { lp_vault: lp_vault_key, tick_lower_index, tick_upper_index });
    Ok(())
}

// ── Events ────────────────────────────────────────────────────────────────────

#[event] pub struct LpVaultInitialized { pub lp_vault: Pubkey, pub whirlpool: Pubkey }
#[event] pub struct LpDeposited        { pub lp_vault: Pubkey, pub user: Pubkey, pub liquidity_amount: u128, pub shares_minted: u64 }
#[event] pub struct LpWithdrawn        { pub lp_vault: Pubkey, pub user: Pubkey, pub shares_burned: u64, pub liquidity_amount: u128 }
#[event] pub struct LpPositionExited   { pub lp_vault: Pubkey, pub liquidity_removed: u128 }
#[event] pub struct LpPositionReopened { pub lp_vault: Pubkey, pub tick_lower_index: i32, pub tick_upper_index: i32 }
