use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

// ── Program + market addresses ─────────────────────────────────────────────────
pub const SOLEND_PROGRAM: Pubkey = pubkey!("So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo");

pub mod main_pool {
    use anchor_lang::prelude::{pubkey, Pubkey};
    // Main Solend lending market
    pub const LENDING_MARKET:       Pubkey = pubkey!("4UpD2fh7xH3VP9QQaXtsS1YY3bxzWhtfpks7FatyKvdY");
    // USDC reserve in main pool
    pub const USDC_RESERVE:         Pubkey = pubkey!("BgxfHJDzm44T7XG68MYKx7YisTjZu73tVovyZSjJMpmw");
    pub const USDC_LIQUIDITY_SUPPLY:Pubkey = pubkey!("8SheGtsopRUDzdiD6v6BR9a6bqZ9QwywYQY99Fp5meNf");
    pub const USDC_COLLATERAL_MINT: Pubkey = pubkey!("993dVFL2uXWYeoXuEBFXR4BijeXdTv4s6BzsCjJZuwqk"); // cUSDC
    pub const USDC_ORACLE:          Pubkey = pubkey!("ExzpbWgczTgd8J58BrnESndmzBkRVfc6PhyfpdGgLjkf");  // Pyth USDC/USD
    // Market authority PDA: [lending_market] with Solend program, bump in market state
    // TODO: verify market authority PDA at mainnet launch
}

// ── Instruction tags (SPL Token Lending — NOT Anchor, 1-byte enum) ─────────────
const REFRESH_RESERVE_TAG:           u8 = 3;
const DEPOSIT_RESERVE_LIQUIDITY_TAG: u8 = 4;
const REDEEM_RESERVE_COLLATERAL_TAG: u8 = 5;

// ── Account contexts ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct SolendDeposit<'info> {
    /// Vault authority — sends tokens, receives cTokens.
    /// CHECK: seeds verified in parent
    #[account(mut)]
    pub vault_authority: AccountInfo<'info>,

    /// Vault's source token account (USDC).
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Vault's cToken account (cUSDC). Receives collateral receipt tokens.
    #[account(mut)]
    pub vault_collateral_account: Account<'info, TokenAccount>,

    /// Solend reserve state account.
    /// CHECK: Solend validates
    #[account(mut)]
    pub reserve: AccountInfo<'info>,

    /// Reserve's liquidity supply token account.
    /// CHECK: Solend validates
    #[account(mut)]
    pub reserve_liquidity_supply: AccountInfo<'info>,

    /// Reserve's collateral mint (cToken mint).
    #[account(mut)]
    pub reserve_collateral_mint: Account<'info, Mint>,

    /// Lending market state.
    /// CHECK: Solend validates
    pub lending_market: AccountInfo<'info>,

    /// Lending market authority PDA.
    /// CHECK: Solend validates
    pub lending_market_authority: AccountInfo<'info>,

    /// Price oracle for refreshing reserve.
    /// CHECK: Solend validates
    pub pyth_oracle: AccountInfo<'info>,

    /// Switchboard oracle for refreshing reserve. Pass the System Program ID
    /// when the reserve has no switchboard oracle configured (verified via
    /// Solend's public reserve config for the USDC main-pool reserve).
    /// CHECK: Solend validates
    pub switchboard_oracle: AccountInfo<'info>,

    /// CHECK: clock sysvar
    #[account(address = anchor_lang::solana_program::sysvar::clock::ID)]
    pub clock_sysvar: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: Solend program
    #[account(address = SOLEND_PROGRAM)]
    pub solend_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct SolendWithdraw<'info> {
    /// Vault authority — burns cTokens, receives tokens.
    /// CHECK: seeds verified in parent
    #[account(mut)]
    pub vault_authority: AccountInfo<'info>,

    /// Vault's cToken account (source, burned).
    #[account(mut)]
    pub vault_collateral_account: Account<'info, TokenAccount>,

    /// Vault's destination token account (receives USDC).
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Solend reserve state.
    /// CHECK: Solend validates
    #[account(mut)]
    pub reserve: AccountInfo<'info>,

    /// Reserve collateral mint (cToken mint, burned from).
    #[account(mut)]
    pub reserve_collateral_mint: Account<'info, Mint>,

    /// Reserve's liquidity supply (source of USDC returned).
    /// CHECK: Solend validates
    #[account(mut)]
    pub reserve_liquidity_supply: AccountInfo<'info>,

    /// Lending market.
    /// CHECK: Solend validates
    pub lending_market: AccountInfo<'info>,

    /// Lending market authority PDA.
    /// CHECK: Solend validates
    pub lending_market_authority: AccountInfo<'info>,

    /// Price oracle.
    /// CHECK: Solend validates
    pub pyth_oracle: AccountInfo<'info>,

    /// Switchboard oracle — System Program ID when unconfigured (see SolendDeposit).
    /// CHECK: Solend validates
    pub switchboard_oracle: AccountInfo<'info>,

    /// CHECK: clock
    #[account(address = anchor_lang::solana_program::sysvar::clock::ID)]
    pub clock_sysvar: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: Solend program
    #[account(address = SOLEND_PROGRAM)]
    pub solend_program: AccountInfo<'info>,
}

// ── CPI functions ─────────────────────────────────────────────────────────────

/// Deposit liquidity into Solend, receive cTokens. Refreshes reserve first.
pub fn solend_deposit<'info>(
    ctx: CpiContext<'_, '_, '_, 'info, SolendDeposit<'info>>,
    amount: u64,
    authority_seeds: &[&[u8]],
) -> Result<()> {
    // 1. RefreshReserve (required before deposit)
    let refresh_data = vec![REFRESH_RESERVE_TAG];
    let refresh_metas = vec![
        AccountMeta::new(*ctx.accounts.reserve.key, false),
        AccountMeta::new_readonly(*ctx.accounts.pyth_oracle.key, false),
        AccountMeta::new_readonly(*ctx.accounts.switchboard_oracle.key, false),
        AccountMeta::new_readonly(*ctx.accounts.clock_sysvar.key, false),
    ];
    anchor_lang::solana_program::program::invoke(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *ctx.accounts.solend_program.key,
            accounts: refresh_metas,
            data: refresh_data,
        },
        &[
            ctx.accounts.reserve.clone(),
            ctx.accounts.pyth_oracle.clone(),
            ctx.accounts.switchboard_oracle.clone(),
            ctx.accounts.clock_sysvar.clone(),
        ],
    )?;

    // 2. DepositReserveLiquidity
    let mut deposit_data = vec![DEPOSIT_RESERVE_LIQUIDITY_TAG];
    deposit_data.extend_from_slice(&amount.to_le_bytes());

    let deposit_metas = vec![
        AccountMeta::new(ctx.accounts.vault_token_account.key(), false),     // source_liquidity
        AccountMeta::new(ctx.accounts.vault_collateral_account.key(), false), // destination_collateral
        AccountMeta::new(*ctx.accounts.reserve.key, false),
        AccountMeta::new(*ctx.accounts.reserve_liquidity_supply.key, false),
        AccountMeta::new(ctx.accounts.reserve_collateral_mint.key(), false),
        AccountMeta::new_readonly(*ctx.accounts.lending_market.key, false),
        AccountMeta::new_readonly(*ctx.accounts.lending_market_authority.key, false),
        AccountMeta::new_readonly(*ctx.accounts.vault_authority.key, true),  // user_transfer_authority (signer, NOT writable per Solend spec)
        AccountMeta::new_readonly(*ctx.accounts.token_program.key, false),
    ];

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *ctx.accounts.solend_program.key,
            accounts: deposit_metas,
            data: deposit_data,
        },
        &[
            ctx.accounts.vault_token_account.to_account_info(),
            ctx.accounts.vault_collateral_account.to_account_info(),
            ctx.accounts.reserve.clone(),
            ctx.accounts.reserve_liquidity_supply.clone(),
            ctx.accounts.reserve_collateral_mint.to_account_info(),
            ctx.accounts.lending_market.clone(),
            ctx.accounts.lending_market_authority.clone(),
            ctx.accounts.vault_authority.clone(),
            ctx.accounts.token_program.to_account_info(),
        ],
        &[authority_seeds],
    )?;

    msg!("solend_deposit: {} → cTokens", amount);
    Ok(())
}

/// Redeem cTokens from Solend, receive liquidity. Refreshes reserve first.
pub fn solend_withdraw<'info>(
    ctx: CpiContext<'_, '_, '_, 'info, SolendWithdraw<'info>>,
    collateral_amount: u64,
    authority_seeds: &[&[u8]],
) -> Result<()> {
    // 1. RefreshReserve
    let refresh_data = vec![REFRESH_RESERVE_TAG];
    let refresh_metas = vec![
        AccountMeta::new(*ctx.accounts.reserve.key, false),
        AccountMeta::new_readonly(*ctx.accounts.pyth_oracle.key, false),
        AccountMeta::new_readonly(*ctx.accounts.switchboard_oracle.key, false),
        AccountMeta::new_readonly(*ctx.accounts.clock_sysvar.key, false),
    ];
    anchor_lang::solana_program::program::invoke(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *ctx.accounts.solend_program.key,
            accounts: refresh_metas,
            data: refresh_data,
        },
        &[
            ctx.accounts.reserve.clone(),
            ctx.accounts.pyth_oracle.clone(),
            ctx.accounts.switchboard_oracle.clone(),
            ctx.accounts.clock_sysvar.clone(),
        ],
    )?;

    // 2. RedeemReserveCollateral
    let mut redeem_data = vec![REDEEM_RESERVE_COLLATERAL_TAG];
    redeem_data.extend_from_slice(&collateral_amount.to_le_bytes());

    let redeem_metas = vec![
        AccountMeta::new(ctx.accounts.vault_collateral_account.key(), false), // source_collateral
        AccountMeta::new(ctx.accounts.vault_token_account.key(), false),      // destination_liquidity
        AccountMeta::new(*ctx.accounts.reserve.key, false),
        AccountMeta::new(ctx.accounts.reserve_collateral_mint.key(), false),
        AccountMeta::new(*ctx.accounts.reserve_liquidity_supply.key, false),
        // WRITABLE on redeem: a redeem is an OUTFLOW, and Solend records it in the
        // lending market RateLimiter (rate_limiter.cur_qty), so Solend writes to this
        // account. Passing it read-only fails with:
        //   "instruction modified data of a read-only account"
        // Deposit is an INFLOW, never touches the limiter, and correctly stays readonly.
        AccountMeta::new(*ctx.accounts.lending_market.key, false),
        AccountMeta::new_readonly(*ctx.accounts.lending_market_authority.key, false),
        AccountMeta::new_readonly(*ctx.accounts.vault_authority.key, true),   // user_transfer_authority (signer, NOT writable per Solend spec)
        AccountMeta::new_readonly(*ctx.accounts.token_program.key, false),
    ];

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *ctx.accounts.solend_program.key,
            accounts: redeem_metas,
            data: redeem_data,
        },
        &[
            ctx.accounts.vault_collateral_account.to_account_info(),
            ctx.accounts.vault_token_account.to_account_info(),
            ctx.accounts.reserve.clone(),
            ctx.accounts.reserve_collateral_mint.to_account_info(),
            ctx.accounts.reserve_liquidity_supply.clone(),
            ctx.accounts.lending_market.clone(),
            ctx.accounts.lending_market_authority.clone(),
            ctx.accounts.vault_authority.clone(),
            ctx.accounts.token_program.to_account_info(),
        ],
        &[authority_seeds],
    )?;

    msg!("solend_withdraw: {} cTokens → liquidity", collateral_amount);
    Ok(())
}
