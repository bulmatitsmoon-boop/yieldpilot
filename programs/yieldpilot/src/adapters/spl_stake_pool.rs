use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

// ── SPL Stake Pool program ────────────────────────────────────────────────────
// SPL Stake Pool program. Jito uses a fork — same interface, different program ID.
pub const SPL_STAKE_POOL_PROGRAM: Pubkey = pubkey!("SPoo1Ku8WFXoNDMHPsrGSTx1iKKoGJ8GHC4NKVFJN3F");

// ── Known LST pool addresses ──────────────────────────────────────────────────
// withdraw_authority is PDA: [pool, "withdraw"] with the respective program.
// reserve_stake and manager_fee_account are read from the pool state by the keeper.

pub mod jito {
    use anchor_lang::prelude::{pubkey, Pubkey};
    // Jito uses their own fork of SPL Stake Pool — verified from mainnet tx 3WUKLZFZSGJNZG...
    pub const PROGRAM:    Pubkey = pubkey!("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy"); // Jito fork (NOT standard SPL)
    pub const POOL:       Pubkey = pubkey!("Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb"); // verified: withdraw auth = 6iQKfEyh...
    pub const JITOSOL_MINT: Pubkey = pubkey!("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");
}

// ── Instruction tags (SPL Stake Pool uses 1-byte enum, not Anchor discriminators) ──
pub const DEPOSIT_SOL_TAG:  u8 = 14; // DepositSol
pub const WITHDRAW_SOL_TAG: u8 = 16; // WithdrawSol

// ── Account contexts ──────────────────────────────────────────────────────────

/// Accounts for depositing SOL into an SPL Stake Pool (Jito).
/// The keeper reads the pool state to populate reserve_stake and manager_fee_account.
#[derive(Accounts)]
pub struct SplStakePoolDeposit<'info> {
    /// Vault authority PDA — sends SOL and receives LST.
    /// CHECK: seeds verified in parent instruction
    #[account(mut)]
    pub vault_authority: AccountInfo<'info>,

    /// Vault's LST token account (jitoSOL ATA).
    #[account(mut)]
    pub vault_lst_account: Account<'info, TokenAccount>,

    /// SPL Stake Pool state account.
    /// CHECK: validated by stake pool program
    #[account(mut)]
    pub stake_pool: AccountInfo<'info>,

    /// Stake pool withdraw authority PDA — [pool, "withdraw"].
    /// CHECK: validated by stake pool program
    pub withdraw_authority: AccountInfo<'info>,

    /// Reserve stake account (from pool state).
    /// CHECK: validated by stake pool program
    #[account(mut)]
    pub reserve_stake: AccountInfo<'info>,

    /// Manager fee account (receives fee in LST tokens, from pool state).
    #[account(mut)]
    pub manager_fee_account: Account<'info, TokenAccount>,

    /// LST pool mint (jitoSOL).
    #[account(mut)]
    pub pool_mint: Account<'info, Mint>,

    /// CHECK: Solana clock
    #[account(address = anchor_lang::solana_program::sysvar::clock::ID)]
    pub clock_sysvar: AccountInfo<'info>,

    /// CHECK: Stake history
    #[account(address = anchor_lang::solana_program::sysvar::stake_history::ID)]
    pub stake_history_sysvar: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,

    /// CHECK: Stake pool program (SPL or Jito fork)
    pub stake_pool_program: AccountInfo<'info>,
}

/// Accounts for withdrawing SOL from an SPL Stake Pool (Jito).
#[derive(Accounts)]
pub struct SplStakePoolWithdraw<'info> {
    /// Vault authority PDA — burns LST tokens, receives SOL.
    /// CHECK: seeds verified in parent instruction
    #[account(mut)]
    pub vault_authority: AccountInfo<'info>,

    /// Vault's LST token account — LST burned from here.
    #[account(mut)]
    pub vault_lst_account: Account<'info, TokenAccount>,

    /// SPL Stake Pool state account.
    /// CHECK: validated by stake pool program
    #[account(mut)]
    pub stake_pool: AccountInfo<'info>,

    /// Stake pool withdraw authority PDA — [pool, "withdraw"].
    /// CHECK: validated by stake pool program
    pub withdraw_authority: AccountInfo<'info>,

    /// Reserve stake account (from pool state).
    /// CHECK: validated by stake pool program
    #[account(mut)]
    pub reserve_stake: AccountInfo<'info>,

    /// Manager fee account (receives fee, from pool state).
    #[account(mut)]
    pub manager_fee_account: Account<'info, TokenAccount>,

    /// LST pool mint.
    #[account(mut)]
    pub pool_mint: Account<'info, Mint>,

    /// CHECK: Solana clock
    #[account(address = anchor_lang::solana_program::sysvar::clock::ID)]
    pub clock_sysvar: AccountInfo<'info>,

    /// CHECK: Stake history
    #[account(address = anchor_lang::solana_program::sysvar::stake_history::ID)]
    pub stake_history_sysvar: AccountInfo<'info>,

    /// CHECK: Native stake program
    #[account(address = anchor_lang::solana_program::stake::program::ID)]
    pub stake_program: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: Stake pool program
    pub stake_pool_program: AccountInfo<'info>,
}

// ── CPI functions ─────────────────────────────────────────────────────────────

/// Deposit `lamports` of SOL into an SPL Stake Pool, receive LST tokens.
pub fn spl_stake_pool_deposit<'info>(
    ctx: CpiContext<'_, '_, '_, 'info, SplStakePoolDeposit<'info>>,
    lamports: u64,
    authority_seeds: &[&[u8]],
) -> Result<()> {
    // DepositSol instruction: 1-byte tag + u64 lamports
    let mut data = vec![DEPOSIT_SOL_TAG];
    data.extend_from_slice(&lamports.to_le_bytes());

    // Real SPL Stake Pool DepositSol takes exactly 10 accounts with no clock sysvar —
    // an earlier version of this code inserted clock_sysvar here, which shifted
    // system_program/token_program one slot too late and caused IncorrectProgramId
    // on mainnet (confirmed live 2026-07-06).
    let metas = vec![
        AccountMeta::new(*ctx.accounts.stake_pool.key, false),
        AccountMeta::new_readonly(*ctx.accounts.withdraw_authority.key, false),
        AccountMeta::new(*ctx.accounts.reserve_stake.key, false),
        AccountMeta::new(*ctx.accounts.vault_authority.key, true),       // lamports_from (signer)
        AccountMeta::new(ctx.accounts.vault_lst_account.key(), false),   // pool_tokens_to
        AccountMeta::new(ctx.accounts.manager_fee_account.key(), false),
        AccountMeta::new(ctx.accounts.vault_lst_account.key(), false),   // referral = same as dest
        AccountMeta::new(ctx.accounts.pool_mint.key(), false),
        AccountMeta::new_readonly(*ctx.accounts.system_program.key, false),
        AccountMeta::new_readonly(*ctx.accounts.token_program.key, false),
    ];

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *ctx.accounts.stake_pool_program.key,
            accounts: metas,
            data,
        },
        &[
            ctx.accounts.stake_pool.clone(),
            ctx.accounts.withdraw_authority.clone(),
            ctx.accounts.reserve_stake.clone(),
            ctx.accounts.vault_authority.clone(),
            ctx.accounts.vault_lst_account.to_account_info(),
            ctx.accounts.manager_fee_account.to_account_info(),
            ctx.accounts.vault_lst_account.to_account_info(),
            ctx.accounts.pool_mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
        &[authority_seeds],
    )?;

    msg!("spl_stake_pool_deposit: {} lamports → LST", lamports);
    Ok(())
}

/// Burn `lst_amount` LST tokens to withdraw SOL from an SPL Stake Pool.
pub fn spl_stake_pool_withdraw<'info>(
    ctx: CpiContext<'_, '_, '_, 'info, SplStakePoolWithdraw<'info>>,
    lst_amount: u64,
    authority_seeds: &[&[u8]],
) -> Result<()> {
    // WithdrawSol instruction: 1-byte tag + u64 pool_tokens
    let mut data = vec![WITHDRAW_SOL_TAG];
    data.extend_from_slice(&lst_amount.to_le_bytes());

    let metas = vec![
        AccountMeta::new(*ctx.accounts.stake_pool.key, false),
        AccountMeta::new_readonly(*ctx.accounts.withdraw_authority.key, false),
        AccountMeta::new(*ctx.accounts.vault_authority.key, true),       // user_transfer_authority (signer)
        AccountMeta::new(ctx.accounts.vault_lst_account.key(), false),   // pool_tokens_from
        AccountMeta::new(*ctx.accounts.reserve_stake.key, false),
        AccountMeta::new(*ctx.accounts.vault_authority.key, false),      // lamports_to
        AccountMeta::new(ctx.accounts.manager_fee_account.key(), false),
        AccountMeta::new(ctx.accounts.pool_mint.key(), false),
        AccountMeta::new_readonly(*ctx.accounts.clock_sysvar.key, false),
        AccountMeta::new_readonly(*ctx.accounts.stake_history_sysvar.key, false),
        AccountMeta::new_readonly(*ctx.accounts.stake_program.key, false),
        AccountMeta::new_readonly(*ctx.accounts.token_program.key, false),
    ];

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *ctx.accounts.stake_pool_program.key,
            accounts: metas,
            data,
        },
        &[
            ctx.accounts.stake_pool.clone(),
            ctx.accounts.withdraw_authority.clone(),
            ctx.accounts.vault_authority.clone(),
            ctx.accounts.vault_lst_account.to_account_info(),
            ctx.accounts.reserve_stake.clone(),
            ctx.accounts.vault_authority.clone(),
            ctx.accounts.manager_fee_account.to_account_info(),
            ctx.accounts.pool_mint.to_account_info(),
            ctx.accounts.clock_sysvar.clone(),
            ctx.accounts.stake_history_sysvar.clone(),
            ctx.accounts.stake_program.clone(),
            ctx.accounts.token_program.to_account_info(),
        ],
        &[authority_seeds],
    )?;

    msg!("spl_stake_pool_withdraw: {} LST → SOL", lst_amount);
    Ok(())
}
