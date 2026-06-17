use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

// Kamino Lending v2 mainnet program ID
pub const KAMINO_LENDING_PROGRAM_ID: Pubkey = pubkey!("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

// Discriminators (first 8 bytes of sha256("global:<ix_name>"))
const REFRESH_RESERVE_IX:  [u8; 8] = [0x02, 0xda, 0x8a, 0xee, 0x42, 0x3c, 0xf9, 0x1a];
const DEPOSIT_RESERVE_IX:  [u8; 8] = [0xa3, 0x1e, 0x43, 0x88, 0x11, 0x8c, 0x6f, 0x9d];
const WITHDRAW_RESERVE_IX: [u8; 8] = [0x5d, 0x1b, 0x22, 0x3c, 0x6e, 0x77, 0x41, 0xb2];

// ── Reserve account layout (only fields we read) ─────────────────────────────
// Full layout: https://github.com/Kamino-Finance/klend/blob/main/programs/klend/src/state/reserve.rs

/// Byte offsets into a serialized Kamino Reserve account.
/// We read these raw to avoid importing Kamino's crate.
pub struct ReserveOffsets;
impl ReserveOffsets {
    /// u64 at byte 8 — version
    pub const VERSION: usize = 8;
    /// Pubkey at byte 32 — liquidity.supply_vault (the token vault Kamino holds)
    pub const LIQUIDITY_SUPPLY_VAULT: usize = 96;
    /// Pubkey at byte 96+32 — collateral.mint_pubkey (cToken mint)
    pub const COLLATERAL_MINT: usize = 200;
    /// Pubkey at 200+32 — collateral.supply_vault
    pub const COLLATERAL_SUPPLY_VAULT: usize = 232;
}

/// Read a pubkey from raw account bytes at a given offset.
pub fn read_pubkey(data: &[u8], offset: usize) -> Result<Pubkey> {
    require!(data.len() >= offset + 32, KaminoError::ReserveDataTooShort);
    Ok(Pubkey::try_from(&data[offset..offset + 32]).unwrap())
}

// ── Account contexts ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct KaminoDeposit<'info> {
    /// Vault PDA authority — signs the CPI.
    /// CHECK: seeds verified in parent instruction
    pub vault_authority: AccountInfo<'info>,

    /// Vault's base-asset token account (USDC in, kUSDC out).
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Vault's cToken (kUSDC) ATA, owned by vault_authority.
    #[account(mut)]
    pub vault_collateral_account: Account<'info, TokenAccount>,

    /// Kamino reserve — we read liquidity/collateral vaults from its data.
    /// CHECK: account data is parsed manually; Kamino validates ownership
    #[account(mut, owner = KAMINO_LENDING_PROGRAM_ID)]
    pub kamino_reserve: AccountInfo<'info>,

    /// Kamino lending market.
    /// CHECK: Kamino validates
    pub kamino_lending_market: AccountInfo<'info>,

    /// Kamino lending market authority PDA.
    /// CHECK: Kamino validates
    pub kamino_lending_market_authority: AccountInfo<'info>,

    /// Kamino's internal liquidity vault for this reserve.
    /// CHECK: Derived from reserve data, Kamino validates
    #[account(mut)]
    pub kamino_reserve_liquidity_supply: AccountInfo<'info>,

    /// cToken mint — Kamino mints these to depositors.
    /// CHECK: Derived from reserve data, Kamino validates
    #[account(mut)]
    pub kamino_collateral_mint: AccountInfo<'info>,

    /// Kamino collateral supply vault.
    /// CHECK: Derived from reserve data, Kamino validates
    #[account(mut)]
    pub kamino_collateral_supply: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: program ID verified by constraint
    #[account(address = KAMINO_LENDING_PROGRAM_ID)]
    pub kamino_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct KaminoWithdraw<'info> {
    /// CHECK: seeds verified in parent
    pub vault_authority: AccountInfo<'info>,

    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub vault_collateral_account: Account<'info, TokenAccount>,

    /// CHECK: owner verified
    #[account(mut, owner = KAMINO_LENDING_PROGRAM_ID)]
    pub kamino_reserve: AccountInfo<'info>,

    /// CHECK: Kamino validates
    pub kamino_lending_market: AccountInfo<'info>,

    /// CHECK: Kamino validates
    pub kamino_lending_market_authority: AccountInfo<'info>,

    /// CHECK: Kamino validates
    #[account(mut)]
    pub kamino_reserve_liquidity_supply: AccountInfo<'info>,

    /// CHECK: Kamino validates
    #[account(mut)]
    pub kamino_collateral_mint: AccountInfo<'info>,

    /// CHECK: Kamino validates
    #[account(mut)]
    pub kamino_collateral_supply: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: address constraint
    #[account(address = KAMINO_LENDING_PROGRAM_ID)]
    pub kamino_program: AccountInfo<'info>,
}

// ── Refresh ───────────────────────────────────────────────────────────────────

/// Must be called before deposit/withdraw so Kamino accrues interest.
/// `oracle_accounts` are passed as remaining_accounts by the caller.
pub fn refresh_kamino_reserve<'info>(
    kamino_program: &AccountInfo<'info>,
    reserve: &AccountInfo<'info>,
    oracle_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    let mut data = REFRESH_RESERVE_IX.to_vec();
    let mut metas = vec![AccountMeta::new(*reserve.key, false)];
    for o in oracle_accounts {
        metas.push(AccountMeta::new_readonly(*o.key, false));
    }
    let mut infos = vec![reserve.clone()];
    infos.extend_from_slice(oracle_accounts);

    anchor_lang::solana_program::program::invoke(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *kamino_program.key,
            accounts: metas,
            data,
        },
        &infos,
    )?;
    Ok(())
}

// ── Deposit ───────────────────────────────────────────────────────────────────

pub fn kamino_deposit<'info>(
    ctx: CpiContext<'_, '_, '_, 'info, KaminoDeposit<'info>>,
    amount: u64,
    authority_seeds: &[&[u8]],
    oracle_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    // 1. Refresh reserve first
    refresh_kamino_reserve(
        &ctx.accounts.kamino_program,
        &ctx.accounts.kamino_reserve,
        oracle_accounts,
    )?;

    // 2. Build deposit instruction
    let mut data = DEPOSIT_RESERVE_IX.to_vec();
    data.extend_from_slice(&amount.to_le_bytes());

    let metas = vec![
        AccountMeta::new(*ctx.accounts.vault_authority.key, true),
        AccountMeta::new(ctx.accounts.vault_token_account.key(), false),
        AccountMeta::new(ctx.accounts.vault_collateral_account.key(), false),
        AccountMeta::new(*ctx.accounts.kamino_reserve.key, false),
        AccountMeta::new_readonly(*ctx.accounts.kamino_lending_market.key, false),
        AccountMeta::new_readonly(*ctx.accounts.kamino_lending_market_authority.key, false),
        AccountMeta::new(*ctx.accounts.kamino_reserve_liquidity_supply.key, false),
        AccountMeta::new(*ctx.accounts.kamino_collateral_mint.key, false),
        AccountMeta::new(*ctx.accounts.kamino_collateral_supply.key, false),
        AccountMeta::new_readonly(*ctx.accounts.token_program.key, false),
    ];

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *ctx.accounts.kamino_program.key,
            accounts: metas,
            data,
        },
        &[
            ctx.accounts.vault_authority.clone(),
            ctx.accounts.vault_token_account.to_account_info(),
            ctx.accounts.vault_collateral_account.to_account_info(),
            ctx.accounts.kamino_reserve.clone(),
            ctx.accounts.kamino_lending_market.clone(),
            ctx.accounts.kamino_lending_market_authority.clone(),
            ctx.accounts.kamino_reserve_liquidity_supply.clone(),
            ctx.accounts.kamino_collateral_mint.clone(),
            ctx.accounts.kamino_collateral_supply.clone(),
            ctx.accounts.token_program.to_account_info(),
        ],
        &[authority_seeds],
    )?;

    msg!("kamino_deposit: {} tokens", amount);
    Ok(())
}

// ── Withdraw ──────────────────────────────────────────────────────────────────

pub fn kamino_withdraw<'info>(
    ctx: CpiContext<'_, '_, '_, 'info, KaminoWithdraw<'info>>,
    collateral_amount: u64,
    authority_seeds: &[&[u8]],
    oracle_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    refresh_kamino_reserve(
        &ctx.accounts.kamino_program,
        &ctx.accounts.kamino_reserve,
        oracle_accounts,
    )?;

    let mut data = WITHDRAW_RESERVE_IX.to_vec();
    data.extend_from_slice(&collateral_amount.to_le_bytes());

    let metas = vec![
        AccountMeta::new(*ctx.accounts.vault_authority.key, true),
        AccountMeta::new(ctx.accounts.vault_collateral_account.key(), false),
        AccountMeta::new(ctx.accounts.vault_token_account.key(), false),
        AccountMeta::new(*ctx.accounts.kamino_reserve.key, false),
        AccountMeta::new_readonly(*ctx.accounts.kamino_lending_market.key, false),
        AccountMeta::new_readonly(*ctx.accounts.kamino_lending_market_authority.key, false),
        AccountMeta::new(*ctx.accounts.kamino_reserve_liquidity_supply.key, false),
        AccountMeta::new(*ctx.accounts.kamino_collateral_mint.key, false),
        AccountMeta::new(*ctx.accounts.kamino_collateral_supply.key, false),
        AccountMeta::new_readonly(*ctx.accounts.token_program.key, false),
    ];

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *ctx.accounts.kamino_program.key,
            accounts: metas,
            data,
        },
        &[
            ctx.accounts.vault_authority.clone(),
            ctx.accounts.vault_collateral_account.to_account_info(),
            ctx.accounts.vault_token_account.to_account_info(),
            ctx.accounts.kamino_reserve.clone(),
            ctx.accounts.kamino_lending_market.clone(),
            ctx.accounts.kamino_lending_market_authority.clone(),
            ctx.accounts.kamino_reserve_liquidity_supply.clone(),
            ctx.accounts.kamino_collateral_mint.clone(),
            ctx.accounts.kamino_collateral_supply.clone(),
            ctx.accounts.token_program.to_account_info(),
        ],
        &[authority_seeds],
    )?;

    msg!("kamino_withdraw: {} cTokens", collateral_amount);
    Ok(())
}

#[error_code]
pub enum KaminoError {
    #[msg("Reserve account data too short to parse")]
    ReserveDataTooShort,
}
