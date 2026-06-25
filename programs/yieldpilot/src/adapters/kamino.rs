use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

// Kamino Lending v2 mainnet program ID
pub const KAMINO_LENDING_PROGRAM_ID: Pubkey = pubkey!("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

// Correct discriminators from @kamino-finance/klend-sdk @codegen/klend/instructions/
const REFRESH_RESERVE_IX:  [u8; 8] = [2, 218, 138, 235, 79, 201, 25, 102];
const DEPOSIT_RESERVE_IX:  [u8; 8] = [169, 201, 30, 126, 6, 205, 102, 68];
const WITHDRAW_RESERVE_IX: [u8; 8] = [234, 117, 181, 125, 185, 142, 220, 29];

// Account contexts

#[derive(Accounts)]
pub struct KaminoDeposit<'info> {
    /// Vault PDA authority - signs the CPI.
    /// CHECK: seeds verified in parent instruction
    pub vault_authority: AccountInfo<'info>,

    /// Kamino reserve (mut for interest accrual).
    /// CHECK: Kamino validates ownership
    #[account(mut, owner = KAMINO_LENDING_PROGRAM_ID)]
    pub kamino_reserve: AccountInfo<'info>,

    /// Kamino lending market.
    /// CHECK: Kamino validates
    pub kamino_lending_market: AccountInfo<'info>,

    /// Kamino lending market authority PDA.
    /// CHECK: Kamino validates
    pub kamino_lending_market_authority: AccountInfo<'info>,

    /// The liquidity token mint (USDC).
    /// CHECK: Kamino validates
    pub reserve_liquidity_mint: AccountInfo<'info>,

    /// Kamino's internal USDC vault.
    /// CHECK: Kamino validates
    #[account(mut)]
    pub kamino_reserve_liquidity_supply: AccountInfo<'info>,

    /// cToken mint (kUSDC) - Kamino mints to depositors.
    /// CHECK: Kamino validates
    #[account(mut)]
    pub kamino_collateral_mint: AccountInfo<'info>,

    /// Vault's USDC token account (source).
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Vault's kUSDC ATA (destination).
    #[account(mut)]
    pub vault_collateral_account: Account<'info, TokenAccount>,

    /// Token program for kUSDC (collateral).
    /// CHECK: Kamino validates
    pub collateral_token_program: AccountInfo<'info>,

    /// Token program for USDC (liquidity).
    pub liquidity_token_program: Program<'info, Token>,

    /// Sysvar instructions account required by Kamino.
    /// CHECK: address is Sysvar1nstructions...
    pub instruction_sysvar: AccountInfo<'info>,

    /// CHECK: program ID verified by constraint
    #[account(address = KAMINO_LENDING_PROGRAM_ID)]
    pub kamino_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct KaminoWithdraw<'info> {
    /// CHECK: seeds verified in parent
    pub vault_authority: AccountInfo<'info>,

    /// CHECK: Kamino validates
    pub kamino_lending_market: AccountInfo<'info>,

    /// CHECK: owner verified
    #[account(mut, owner = KAMINO_LENDING_PROGRAM_ID)]
    pub kamino_reserve: AccountInfo<'info>,

    /// CHECK: Kamino validates
    pub kamino_lending_market_authority: AccountInfo<'info>,

    /// The liquidity token mint (USDC).
    /// CHECK: Kamino validates
    pub reserve_liquidity_mint: AccountInfo<'info>,

    /// cToken mint (kUSDC).
    /// CHECK: Kamino validates
    #[account(mut)]
    pub kamino_collateral_mint: AccountInfo<'info>,

    /// Kamino's internal USDC vault (destination for redeemed USDC).
    /// CHECK: Kamino validates
    #[account(mut)]
    pub kamino_reserve_liquidity_supply: AccountInfo<'info>,

    /// Vault's kUSDC ATA (source of collateral being redeemed).
    #[account(mut)]
    pub vault_collateral_account: Account<'info, TokenAccount>,

    /// Vault's USDC token account (destination).
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Token program for kUSDC (collateral).
    /// CHECK: Kamino validates
    pub collateral_token_program: AccountInfo<'info>,

    /// Token program for USDC (liquidity).
    pub liquidity_token_program: Program<'info, Token>,

    /// Sysvar instructions account required by Kamino.
    /// CHECK: address is Sysvar1nstructions...
    pub instruction_sysvar: AccountInfo<'info>,

    /// CHECK: address constraint
    #[account(address = KAMINO_LENDING_PROGRAM_ID)]
    pub kamino_program: AccountInfo<'info>,
}

// Refresh

/// Refresh the Kamino reserve before deposit/withdraw so interest accrues.
pub fn refresh_kamino_reserve<'info>(
    kamino_program: &AccountInfo<'info>,
    reserve: &AccountInfo<'info>,
    lending_market: &AccountInfo<'info>,
    oracle_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    let data = REFRESH_RESERVE_IX.to_vec();
    let mut metas = vec![
        AccountMeta::new(*reserve.key, false),
        AccountMeta::new_readonly(*lending_market.key, false),
    ];
    for o in oracle_accounts {
        metas.push(AccountMeta::new_readonly(*o.key, false));
    }
    let mut infos = vec![reserve.clone(), lending_market.clone()];
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

// Deposit

pub fn kamino_deposit<'info>(
    ctx: CpiContext<'_, '_, '_, 'info, KaminoDeposit<'info>>,
    amount: u64,
    authority_seeds: &[&[u8]],
    oracle_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    refresh_kamino_reserve(
        &ctx.accounts.kamino_program,
        &ctx.accounts.kamino_reserve,
        &ctx.accounts.kamino_lending_market,
        oracle_accounts,
    )?;

    // depositReserveLiquidity account order (from klend-sdk):
    // [0] owner (signer), [1] reserve(mut), [2] lendingMarket, [3] lendingMarketAuthority,
    // [4] reserveLiquidityMint, [5] reserveLiquiditySupply(mut), [6] reserveCollateralMint(mut),
    // [7] userSourceLiquidity(mut), [8] userDestinationCollateral(mut),
    // [9] collateralTokenProgram, [10] liquidityTokenProgram, [11] instructionSysvarAccount
    let mut data = DEPOSIT_RESERVE_IX.to_vec();
    data.extend_from_slice(&amount.to_le_bytes());

    let metas = vec![
        AccountMeta::new(*ctx.accounts.vault_authority.key, true),
        AccountMeta::new(*ctx.accounts.kamino_reserve.key, false),
        AccountMeta::new_readonly(*ctx.accounts.kamino_lending_market.key, false),
        AccountMeta::new_readonly(*ctx.accounts.kamino_lending_market_authority.key, false),
        AccountMeta::new_readonly(*ctx.accounts.reserve_liquidity_mint.key, false),
        AccountMeta::new(*ctx.accounts.kamino_reserve_liquidity_supply.key, false),
        AccountMeta::new(*ctx.accounts.kamino_collateral_mint.key, false),
        AccountMeta::new(ctx.accounts.vault_token_account.key(), false),
        AccountMeta::new(ctx.accounts.vault_collateral_account.key(), false),
        AccountMeta::new_readonly(*ctx.accounts.collateral_token_program.key, false),
        AccountMeta::new_readonly(*ctx.accounts.liquidity_token_program.key, false),
        AccountMeta::new_readonly(*ctx.accounts.instruction_sysvar.key, false),
    ];

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *ctx.accounts.kamino_program.key,
            accounts: metas,
            data,
        },
        &[
            ctx.accounts.vault_authority.clone(),
            ctx.accounts.kamino_reserve.clone(),
            ctx.accounts.kamino_lending_market.clone(),
            ctx.accounts.kamino_lending_market_authority.clone(),
            ctx.accounts.reserve_liquidity_mint.clone(),
            ctx.accounts.kamino_reserve_liquidity_supply.clone(),
            ctx.accounts.kamino_collateral_mint.clone(),
            ctx.accounts.vault_token_account.to_account_info(),
            ctx.accounts.vault_collateral_account.to_account_info(),
            ctx.accounts.collateral_token_program.clone(),
            ctx.accounts.liquidity_token_program.to_account_info(),
            ctx.accounts.instruction_sysvar.clone(),
        ],
        &[authority_seeds],
    )?;

    msg!("kamino_deposit: {} tokens", amount);
    Ok(())
}

// Withdraw

pub fn kamino_withdraw<'info>(
    ctx: CpiContext<'_, '_, '_, 'info, KaminoWithdraw<'info>>,
    collateral_amount: u64,
    authority_seeds: &[&[u8]],
    oracle_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    refresh_kamino_reserve(
        &ctx.accounts.kamino_program,
        &ctx.accounts.kamino_reserve,
        &ctx.accounts.kamino_lending_market,
        oracle_accounts,
    )?;

    // redeemReserveCollateral account order (from klend-sdk):
    // [0] owner (signer), [1] lendingMarket, [2] reserve(mut), [3] lendingMarketAuthority,
    // [4] reserveLiquidityMint, [5] reserveCollateralMint(mut), [6] reserveLiquiditySupply(mut),
    // [7] userSourceCollateral(mut), [8] userDestinationLiquidity(mut),
    // [9] collateralTokenProgram, [10] liquidityTokenProgram, [11] instructionSysvarAccount
    let mut data = WITHDRAW_RESERVE_IX.to_vec();
    data.extend_from_slice(&collateral_amount.to_le_bytes());

    let metas = vec![
        AccountMeta::new(*ctx.accounts.vault_authority.key, true),
        AccountMeta::new_readonly(*ctx.accounts.kamino_lending_market.key, false),
        AccountMeta::new(*ctx.accounts.kamino_reserve.key, false),
        AccountMeta::new_readonly(*ctx.accounts.kamino_lending_market_authority.key, false),
        AccountMeta::new_readonly(*ctx.accounts.reserve_liquidity_mint.key, false),
        AccountMeta::new(*ctx.accounts.kamino_collateral_mint.key, false),
        AccountMeta::new(*ctx.accounts.kamino_reserve_liquidity_supply.key, false),
        AccountMeta::new(ctx.accounts.vault_collateral_account.key(), false),
        AccountMeta::new(ctx.accounts.vault_token_account.key(), false),
        AccountMeta::new_readonly(*ctx.accounts.collateral_token_program.key, false),
        AccountMeta::new_readonly(*ctx.accounts.liquidity_token_program.key, false),
        AccountMeta::new_readonly(*ctx.accounts.instruction_sysvar.key, false),
    ];

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *ctx.accounts.kamino_program.key,
            accounts: metas,
            data,
        },
        &[
            ctx.accounts.vault_authority.clone(),
            ctx.accounts.kamino_lending_market.clone(),
            ctx.accounts.kamino_reserve.clone(),
            ctx.accounts.kamino_lending_market_authority.clone(),
            ctx.accounts.reserve_liquidity_mint.clone(),
            ctx.accounts.kamino_collateral_mint.clone(),
            ctx.accounts.kamino_reserve_liquidity_supply.clone(),
            ctx.accounts.vault_collateral_account.to_account_info(),
            ctx.accounts.vault_token_account.to_account_info(),
            ctx.accounts.collateral_token_program.clone(),
            ctx.accounts.liquidity_token_program.to_account_info(),
            ctx.accounts.instruction_sysvar.clone(),
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
