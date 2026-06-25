use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

// ── Program IDs ───────────────────────────────────────────────────────────────

pub const MARINADE_MAINNET_PROGRAM: Pubkey = pubkey!("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");
pub const MARINADE_DEVNET_PROGRAM:  Pubkey = pubkey!("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD"); // same on devnet

// ── Well-known mainnet accounts (verified from Marinade docs + on-chain) ──────
// Source: https://docs.marinade.finance/marinade-protocol/system-overview/smart-contract-addresses

pub mod mainnet {
    use anchor_lang::prelude::pubkey;
    use anchor_lang::prelude::Pubkey;
    pub const STATE:             Pubkey = pubkey!("8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC");
    pub const MSOL_MINT:         Pubkey = pubkey!("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");
    pub const LIQ_POOL_SOL_LEG:  Pubkey = pubkey!("UefNb6z6yvArqe4cJHTXCqStRsKmWhGxnZzuHbikP5Q");
    pub const LIQ_POOL_MSOL_LEG: Pubkey = pubkey!("7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE");
    pub const LIQ_POOL_MSOL_AUTH:Pubkey = pubkey!("JCDfVPvoz71ciFV2dy6gfazgja3ZMQKXkqkm5J6HP2j5"); // PDA seed "liq_pool_msol_mint"
    pub const RESERVE_PDA:       Pubkey = pubkey!("Du3Ysj1wKbxPKkuPPnvzQLQh8oMSVifs3jGZjJWXFmHN"); // PDA seed "reserve"
    pub const MSOL_MINT_AUTH:    Pubkey = pubkey!("3JLPCS1qM2zRw3Dp6V4hZnYHd4toMNPkNesXdX9tg6KM"); // PDA seed "st_mint"
    pub const TREASURY_MSOL_ACC: Pubkey = pubkey!("B1aLzaNMeFVAyQ6f3XbbUyKcH2YPHu2fqiEagmiF23VR");
}

// Devnet Marinade uses the same program but different state accounts.
// Source: https://github.com/marinade-finance/marinade-ts-cli (devnet config)
pub mod devnet {
    use anchor_lang::prelude::pubkey;
    use anchor_lang::prelude::Pubkey;
    pub const STATE:             Pubkey = pubkey!("8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC"); // devnet mirrors mainnet in Marinade v2
    pub const MSOL_MINT:         Pubkey = pubkey!("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");
    pub const LIQ_POOL_SOL_LEG:  Pubkey = pubkey!("UefNb6z6yvArqe4cJHTXCqStRsKmWhGxnZzuHbikP5Q");
    pub const LIQ_POOL_MSOL_LEG: Pubkey = pubkey!("7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE");
    pub const LIQ_POOL_MSOL_AUTH:Pubkey = pubkey!("JCDfVPvoz71ciFV2dy6gfazgja3ZMQKXkqkm5J6HP2j5"); // PDA seed "liq_pool_msol_mint"
    pub const RESERVE_PDA:       Pubkey = pubkey!("Du3Ysj1wKbxPKkuPPnvzQLQh8oMSVifs3jGZjJWXFmHN"); // PDA seed "reserve"
    pub const MSOL_MINT_AUTH:    Pubkey = pubkey!("3JLPCS1qM2zRw3Dp6V4hZnYHd4toMNPkNesXdX9tg6KM"); // PDA seed "st_mint"
    pub const TREASURY_MSOL_ACC: Pubkey = pubkey!("B1aLzaNMeFVAyQ6f3XbbUyKcH2YPHu2fqiEagmiF23VR");
}

// Instruction discriminators from Marinade IDL
const DEPOSIT_SOL_IX:      [u8; 8] = [0xf2, 0x23, 0xc6, 0x89, 0x52, 0xe1, 0xf2, 0xb6];
const LIQUID_UNSTAKE_IX:   [u8; 8] = [0x5c, 0x56, 0x68, 0xe7, 0x89, 0x5e, 0xb4, 0xc6]; // sha256("global:liquidUnstake")[:8]

// ── Account contexts ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct MarinadeDeposit<'info> {
    /// YieldPilot vault PDA — SOL payer + authority.
    /// CHECK: seeds verified in parent
    #[account(mut)]
    pub vault_authority: AccountInfo<'info>,

    /// CHECK: Marinade validates
    #[account(mut)]
    pub marinade_state: AccountInfo<'info>,

    /// mSOL mint.
    #[account(mut)]
    pub msol_mint: Account<'info, Mint>,

    /// Marinade liquid pool SOL leg (receives SOL).
    /// CHECK: Marinade validates
    #[account(mut)]
    pub liq_pool_sol_leg: AccountInfo<'info>,

    /// Marinade liquid pool mSOL leg.
    #[account(mut)]
    pub liq_pool_msol_leg: Account<'info, TokenAccount>,

    /// mSOL leg authority.
    /// CHECK: Marinade validates
    pub liq_pool_msol_leg_authority: AccountInfo<'info>,

    /// Marinade reserve — receives excess SOL.
    /// CHECK: Marinade validates
    #[account(mut)]
    pub reserve_pda: AccountInfo<'info>,

    /// Vault's mSOL ATA — receives minted mSOL.
    #[account(mut)]
    pub vault_msol_account: Account<'info, TokenAccount>,

    /// mSOL mint authority PDA.
    /// CHECK: Marinade validates
    pub msol_mint_authority: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,

    /// CHECK: address constraint
    #[account(address = MARINADE_MAINNET_PROGRAM)]
    pub marinade_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct MarinadeUnstake<'info> {
    /// CHECK: seeds verified in parent
    pub vault_authority: AccountInfo<'info>,

    /// CHECK: Marinade validates
    #[account(mut)]
    pub marinade_state: AccountInfo<'info>,

    #[account(mut)]
    pub msol_mint: Account<'info, Mint>,

    /// CHECK: Marinade validates
    #[account(mut)]
    pub liq_pool_sol_leg: AccountInfo<'info>,

    #[account(mut)]
    pub liq_pool_msol_leg: Account<'info, TokenAccount>,

    /// Marinade treasury — receives protocol fee in mSOL.
    #[account(mut)]
    pub treasury_msol_account: Account<'info, TokenAccount>,

    /// Vault's mSOL ATA — mSOL burned from here.
    #[account(mut)]
    pub vault_msol_account: Account<'info, TokenAccount>,

    /// SOL returned to vault authority's system account.
    /// CHECK: any writable account
    #[account(mut)]
    pub transfer_sol_to: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,

    /// CHECK: address constraint
    #[account(address = MARINADE_MAINNET_PROGRAM)]
    pub marinade_program: AccountInfo<'info>,
}

// ── CPI functions ─────────────────────────────────────────────────────────────

/// Deposit SOL into Marinade, receive mSOL.
/// `lamports` is the amount of SOL (in lamports) to stake.
pub fn marinade_deposit<'info>(
    ctx: CpiContext<'_, '_, '_, 'info, MarinadeDeposit<'info>>,
    lamports: u64,
    authority_seeds: &[&[u8]],
) -> Result<()> {
    let mut data = DEPOSIT_SOL_IX.to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());

    let metas = vec![
        AccountMeta::new(*ctx.accounts.marinade_state.key, false),
        AccountMeta::new(ctx.accounts.msol_mint.key(), false),
        AccountMeta::new(*ctx.accounts.liq_pool_sol_leg.key, false),
        AccountMeta::new(ctx.accounts.liq_pool_msol_leg.key(), false),
        AccountMeta::new_readonly(*ctx.accounts.liq_pool_msol_leg_authority.key, false),
        AccountMeta::new(*ctx.accounts.reserve_pda.key, false),
        AccountMeta::new(*ctx.accounts.vault_authority.key, true),      // transfer_from
        AccountMeta::new(ctx.accounts.vault_msol_account.key(), false), // mint_to
        AccountMeta::new_readonly(*ctx.accounts.msol_mint_authority.key, false),
        AccountMeta::new_readonly(*ctx.accounts.system_program.key, false),
        AccountMeta::new_readonly(*ctx.accounts.token_program.key, false),
    ];

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *ctx.accounts.marinade_program.key,
            accounts: metas,
            data,
        },
        &[
            ctx.accounts.marinade_state.clone(),
            ctx.accounts.msol_mint.to_account_info(),
            ctx.accounts.liq_pool_sol_leg.clone(),
            ctx.accounts.liq_pool_msol_leg.to_account_info(),
            ctx.accounts.liq_pool_msol_leg_authority.clone(),
            ctx.accounts.reserve_pda.clone(),
            ctx.accounts.vault_authority.clone(),
            ctx.accounts.vault_msol_account.to_account_info(),
            ctx.accounts.msol_mint_authority.clone(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
        &[authority_seeds],
    )?;

    msg!("marinade_deposit: {} lamports → mSOL", lamports);
    Ok(())
}

/// Liquid unstake mSOL → SOL instantly (fee: typically ~0.1–0.3%).
pub fn marinade_liquid_unstake<'info>(
    ctx: CpiContext<'_, '_, '_, 'info, MarinadeUnstake<'info>>,
    msol_amount: u64,
    authority_seeds: &[&[u8]],
) -> Result<()> {
    let mut data = LIQUID_UNSTAKE_IX.to_vec();
    data.extend_from_slice(&msol_amount.to_le_bytes());

    let metas = vec![
        AccountMeta::new(*ctx.accounts.marinade_state.key, false),
        AccountMeta::new(ctx.accounts.msol_mint.key(), false),
        AccountMeta::new(*ctx.accounts.liq_pool_sol_leg.key, false),
        AccountMeta::new(ctx.accounts.liq_pool_msol_leg.key(), false),
        AccountMeta::new(ctx.accounts.treasury_msol_account.key(), false),
        AccountMeta::new(ctx.accounts.vault_msol_account.key(), false),
        AccountMeta::new(*ctx.accounts.vault_authority.key, true),
        AccountMeta::new(*ctx.accounts.transfer_sol_to.key, false),
        AccountMeta::new_readonly(*ctx.accounts.system_program.key, false),
        AccountMeta::new_readonly(*ctx.accounts.token_program.key, false),
    ];

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *ctx.accounts.marinade_program.key,
            accounts: metas,
            data,
        },
        &[
            ctx.accounts.marinade_state.clone(),
            ctx.accounts.msol_mint.to_account_info(),
            ctx.accounts.liq_pool_sol_leg.clone(),
            ctx.accounts.liq_pool_msol_leg.to_account_info(),
            ctx.accounts.treasury_msol_account.to_account_info(),
            ctx.accounts.vault_msol_account.to_account_info(),
            ctx.accounts.vault_authority.clone(),
            ctx.accounts.transfer_sol_to.clone(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
        &[authority_seeds],
    )?;

    msg!("marinade_liquid_unstake: {} mSOL → SOL", msol_amount);
    Ok(())
}

/// Compute the SOL value of an mSOL amount using Marinade's price.
/// msol_price is stored as (lamports * 2^32) / msol_units in the state account.
pub fn msol_to_lamports(msol_amount: u64, msol_price: u64) -> u64 {
    ((msol_amount as u128) * (msol_price as u128) >> 32) as u64
}
