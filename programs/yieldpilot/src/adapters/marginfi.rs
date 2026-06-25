use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

// ── Program + group addresses ─────────────────────────────────────────────────
pub const MARGINFI_PROGRAM: Pubkey = pubkey!("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");

pub mod main_group {
    use anchor_lang::prelude::{pubkey, Pubkey};
    // MarginFi main group (verified from @mrgnlabs/marginfi-client-v2)
    pub const GROUP: Pubkey = pubkey!("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8");

    // USDC bank in main group
    // TODO: verify — fetch via `getProgramAccounts(MARGINFI_PROGRAM, { filters: [{ memcmp: { offset: 8+32, bytes: USDC_MINT } }] })`
    pub const USDC_BANK: Pubkey = pubkey!("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHnd9RQ");

    // SOL bank in main group
    // TODO: verify at mainnet launch
    pub const SOL_BANK: Pubkey = pubkey!("CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh");
}

// ── Instruction discriminators (Anchor — sha256("global:<name>")[:8]) ──────────
// Verified: sha256("global:lending_account_deposit")[:8]
pub const DEPOSIT_IX:  [u8; 8] = [0xab, 0x5e, 0xeb, 0x67, 0x52, 0x40, 0xd4, 0x8c];
// Verified: sha256("global:lending_account_withdraw")[:8]
pub const WITHDRAW_IX: [u8; 8] = [0x24, 0x48, 0x4a, 0x13, 0xd2, 0xd2, 0xc0, 0xc0];

// ── Account contexts ──────────────────────────────────────────────────────────
// MarginFi v2 does NOT use receipt SPL tokens. Balances are tracked inside the
// `marginfi_account` PDA. The vault must have a `marginfi_account` created for it
// (via `marginfi_account_initialize`) before depositing. Store the marginfi_account
// address as `protocol.external_state` in the Vault.

#[derive(Accounts)]
pub struct MarginFiDeposit<'info> {
    /// Vault authority PDA — signer for the CPI.
    /// CHECK: seeds verified in parent
    #[account(mut)]
    pub vault_authority: AccountInfo<'info>,

    /// Vault's token account (source, USDC or SOL).
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// MarginFi group (contains market-level config).
    /// CHECK: MarginFi validates
    pub marginfi_group: AccountInfo<'info>,

    /// Vault's MarginFi account PDA (tracks balance — no receipt token).
    /// CHECK: MarginFi validates; stored as protocol.external_state in vault
    #[account(mut)]
    pub marginfi_account: AccountInfo<'info>,

    /// The MarginFi bank for this asset (USDC or SOL).
    /// CHECK: MarginFi validates
    #[account(mut)]
    pub bank: AccountInfo<'info>,

    /// Bank's liquidity vault token account (receives deposited tokens).
    /// CHECK: MarginFi validates
    #[account(mut)]
    pub bank_liquidity_vault: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: MarginFi program
    #[account(address = MARGINFI_PROGRAM)]
    pub marginfi_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct MarginFiWithdraw<'info> {
    /// Vault authority PDA — signer.
    /// CHECK: seeds verified in parent
    #[account(mut)]
    pub vault_authority: AccountInfo<'info>,

    /// Vault's token account (destination, receives USDC or SOL).
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// MarginFi group.
    /// CHECK: MarginFi validates
    pub marginfi_group: AccountInfo<'info>,

    /// Vault's MarginFi account.
    /// CHECK: MarginFi validates
    #[account(mut)]
    pub marginfi_account: AccountInfo<'info>,

    /// The MarginFi bank.
    /// CHECK: MarginFi validates
    #[account(mut)]
    pub bank: AccountInfo<'info>,

    /// Bank's liquidity vault.
    /// CHECK: MarginFi validates
    #[account(mut)]
    pub bank_liquidity_vault: AccountInfo<'info>,

    /// Bank's liquidity vault authority PDA (signs transfers out).
    /// CHECK: MarginFi validates
    pub bank_liquidity_vault_authority: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: MarginFi program
    #[account(address = MARGINFI_PROGRAM)]
    pub marginfi_program: AccountInfo<'info>,
}

// ── CPI functions ─────────────────────────────────────────────────────────────

/// Deposit tokens into MarginFi. Balance is tracked in `marginfi_account`, not an SPL receipt token.
pub fn marginfi_deposit<'info>(
    ctx: CpiContext<'_, '_, '_, 'info, MarginFiDeposit<'info>>,
    amount: u64,
    authority_seeds: &[&[u8]],
) -> Result<()> {
    let mut data = DEPOSIT_IX.to_vec();
    data.extend_from_slice(&amount.to_le_bytes());

    let metas = vec![
        AccountMeta::new_readonly(*ctx.accounts.marginfi_group.key, false),
        AccountMeta::new(*ctx.accounts.marginfi_account.key, false),
        AccountMeta::new(*ctx.accounts.vault_authority.key, true),       // signer
        AccountMeta::new(*ctx.accounts.bank.key, false),
        AccountMeta::new(ctx.accounts.vault_token_account.key(), false), // signer_token_account
        AccountMeta::new(*ctx.accounts.bank_liquidity_vault.key, false),
        AccountMeta::new_readonly(*ctx.accounts.token_program.key, false),
    ];

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *ctx.accounts.marginfi_program.key,
            accounts: metas,
            data,
        },
        &[
            ctx.accounts.marginfi_group.clone(),
            ctx.accounts.marginfi_account.clone(),
            ctx.accounts.vault_authority.clone(),
            ctx.accounts.bank.clone(),
            ctx.accounts.vault_token_account.to_account_info(),
            ctx.accounts.bank_liquidity_vault.clone(),
            ctx.accounts.token_program.to_account_info(),
        ],
        &[authority_seeds],
    )?;

    msg!("marginfi_deposit: {} tokens", amount);
    Ok(())
}

/// Withdraw tokens from MarginFi. Pass u64::MAX as amount to withdraw all.
pub fn marginfi_withdraw<'info>(
    ctx: CpiContext<'_, '_, '_, 'info, MarginFiWithdraw<'info>>,
    amount: u64,
    authority_seeds: &[&[u8]],
) -> Result<()> {
    let mut data = WITHDRAW_IX.to_vec();
    data.extend_from_slice(&amount.to_le_bytes());
    // withdraw_all flag (bool, 1 byte): true when amount == u64::MAX
    data.push(if amount == u64::MAX { 1 } else { 0 });

    let metas = vec![
        AccountMeta::new_readonly(*ctx.accounts.marginfi_group.key, false),
        AccountMeta::new(*ctx.accounts.marginfi_account.key, false),
        AccountMeta::new(*ctx.accounts.vault_authority.key, true),       // signer
        AccountMeta::new(*ctx.accounts.bank.key, false),
        AccountMeta::new(ctx.accounts.vault_token_account.key(), false), // destination_token_account
        AccountMeta::new(*ctx.accounts.bank_liquidity_vault.key, false),
        AccountMeta::new_readonly(*ctx.accounts.bank_liquidity_vault_authority.key, false),
        AccountMeta::new_readonly(*ctx.accounts.token_program.key, false),
    ];

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *ctx.accounts.marginfi_program.key,
            accounts: metas,
            data,
        },
        &[
            ctx.accounts.marginfi_group.clone(),
            ctx.accounts.marginfi_account.clone(),
            ctx.accounts.vault_authority.clone(),
            ctx.accounts.bank.clone(),
            ctx.accounts.vault_token_account.to_account_info(),
            ctx.accounts.bank_liquidity_vault.clone(),
            ctx.accounts.bank_liquidity_vault_authority.clone(),
            ctx.accounts.token_program.to_account_info(),
        ],
        &[authority_seeds],
    )?;

    msg!("marginfi_withdraw: {} tokens", amount);
    Ok(())
}
