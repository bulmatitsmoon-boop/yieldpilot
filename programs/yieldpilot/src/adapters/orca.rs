use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

// Orca Whirlpools (concentrated liquidity AMM) mainnet program ID.
pub const WHIRLPOOL_PROGRAM_ID: Pubkey = pubkey!("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");

// Anchor global-namespace discriminators: sha256("global:<ix_name>")[..8].
// Verified by direct computation against Orca's real instruction names
// (github.com/orca-so/whirlpools, programs/whirlpool/src/instructions/).
const OPEN_POSITION_IX:      [u8; 8] = [135, 128, 47, 77, 15, 152, 240, 49];
const INCREASE_LIQUIDITY_IX: [u8; 8] = [46, 156, 243, 118, 13, 205, 251, 178];
const DECREASE_LIQUIDITY_IX: [u8; 8] = [160, 38, 208, 111, 104, 91, 44, 1];
const CLOSE_POSITION_IX:     [u8; 8] = [123, 134, 81, 0, 49, 68, 98, 98];
const COLLECT_FEES_IX:       [u8; 8] = [164, 152, 207, 99, 30, 186, 19, 182];
const UPDATE_FEES_AND_REWARDS_IX: [u8; 8] = [154, 230, 250, 13, 236, 209, 75, 223];

// ── Account contexts ──────────────────────────────────────────────────────────
//
// NOTE: these mirror Orca's real Anchor account structs (verified against
// orca-so/whirlpools source, 2026-07-08) but are NOT yet wired into any
// lib.rs instruction. This is groundwork for a future opt-in, dual-asset
// "LP vault" product (see project memory) — deliberately kept separate from
// the existing single-asset Vault so it can't affect live vault logic.
// Still needed before this is usable: a position-opening flow that decides
// tick_lower_index/tick_upper_index (price range), tick-array account
// derivation (PDA seeds depend on whirlpool + tick spacing + start index —
// not yet implemented here), and the new LpVault program state itself.

#[derive(Accounts)]
pub struct OrcaOpenPosition<'info> {
    /// Vault authority — pays for the new position + position mint, becomes
    /// the position NFT's owner.
    /// CHECK: seeds verified in parent instruction
    #[account(mut)]
    pub vault_authority: AccountInfo<'info>,

    /// New position state account (Anchor `init`, PDA seeds ["position", position_mint]).
    /// CHECK: Whirlpool program validates + initializes
    #[account(mut)]
    pub position: AccountInfo<'info>,

    /// New position NFT mint (0 decimals, 1 unit ever minted). Must be a
    /// fresh signer keypair at the client level (Anchor `init` on a Mint).
    #[account(mut)]
    /// CHECK: does not exist yet - Orca inits this mint inside open_position.
    pub position_mint: AccountInfo<'info>,

    /// Vault-owned ATA that will hold the position NFT (proof of ownership).
    #[account(mut)]
    /// CHECK: does not exist yet - created by open_position as an ATA.
    pub position_token_account: AccountInfo<'info>,

    /// The Whirlpool (pool state) this position belongs to.
    /// CHECK: Whirlpool program validates
    pub whirlpool: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    /// CHECK: associated token program
    pub associated_token_program: AccountInfo<'info>,

    /// CHECK: program ID verified by constraint
    #[account(address = WHIRLPOOL_PROGRAM_ID)]
    pub whirlpool_program: AccountInfo<'info>,
}

/// Shared by increase_liquidity and decrease_liquidity — Orca uses the
/// identical `ModifyLiquidity` account set for both (verified against
/// orca-so/whirlpools source, 2026-07-08).
#[derive(Accounts)]
pub struct OrcaModifyLiquidity<'info> {
    /// CHECK: seeds verified in parent
    pub vault_authority: AccountInfo<'info>,

    /// CHECK: Whirlpool program validates
    #[account(mut)]
    pub whirlpool: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,

    /// Vault authority again, but in its role as position owner/signer for
    /// this specific CPI (Orca calls this `position_authority`).
    /// CHECK: seeds verified in parent; same account as vault_authority
    pub position_authority: AccountInfo<'info>,

    /// CHECK: Whirlpool program validates (has_one = whirlpool)
    #[account(mut)]
    pub position: AccountInfo<'info>,

    /// Vault-owned ATA holding the position NFT (must hold exactly 1 unit).
    #[account(constraint = position_token_account.amount == 1)]
    pub position_token_account: Account<'info, TokenAccount>,

    /// Vault's token A (e.g. USDC) staging account.
    #[account(mut)]
    pub token_owner_account_a: Account<'info, TokenAccount>,
    /// Vault's token B (e.g. SOL/WSOL) staging account.
    #[account(mut)]
    pub token_owner_account_b: Account<'info, TokenAccount>,

    /// Pool's token A vault.
    /// CHECK: Whirlpool validates against whirlpool.token_vault_a
    #[account(mut)]
    pub token_vault_a: AccountInfo<'info>,
    /// Pool's token B vault.
    /// CHECK: Whirlpool validates against whirlpool.token_vault_b
    #[account(mut)]
    pub token_vault_b: AccountInfo<'info>,

    /// Lower-bound tick array for this position's price range.
    /// CHECK: Whirlpool validates
    #[account(mut)]
    pub tick_array_lower: AccountInfo<'info>,
    /// Upper-bound tick array for this position's price range.
    /// CHECK: Whirlpool validates
    #[account(mut)]
    pub tick_array_upper: AccountInfo<'info>,

    /// CHECK: program ID verified by constraint
    #[account(address = WHIRLPOOL_PROGRAM_ID)]
    pub whirlpool_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct OrcaClosePosition<'info> {
    /// CHECK: seeds verified in parent
    pub vault_authority: AccountInfo<'info>,

    /// Rent from the closed position + mint accounts lands here.
    /// CHECK: seeds verified in parent; typically vault_authority itself
    #[account(mut)]
    pub receiver: AccountInfo<'info>,

    /// CHECK: Whirlpool program validates + closes (close = receiver)
    #[account(mut)]
    pub position: AccountInfo<'info>,

    /// CHECK: Whirlpool program validates (address = position.position_mint)
    #[account(mut)]
    pub position_mint: AccountInfo<'info>,

    #[account(constraint = position_token_account.amount == 1)]
    pub position_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,

    /// CHECK: program ID verified by constraint
    #[account(address = WHIRLPOOL_PROGRAM_ID)]
    pub whirlpool_program: AccountInfo<'info>,
}

/// Accounts for Orca's `collect_fees`.
///
/// NOTE the account order in `orca_collect_fees` is NOT the same as
/// `ModifyLiquidity`: CollectFees interleaves owner/vault
/// (owner_a, vault_a, owner_b, vault_b) where ModifyLiquidity groups them
/// (owner_a, owner_b, vault_a, vault_b). Verified against orca-so/whirlpools
/// `instructions/collect_fees.rs`, 2026-07-21. Copying the ModifyLiquidity
/// meta order here silently swaps two accounts and the CPI fails.
#[derive(Accounts)]
pub struct OrcaCollectFees<'info> {
    /// CHECK: Whirlpool program validates (position has_one = whirlpool)
    pub whirlpool: AccountInfo<'info>,

    /// Vault PDA, signing as the position owner.
    /// CHECK: seeds verified in parent
    pub position_authority: AccountInfo<'info>,

    /// CHECK: Whirlpool program validates
    #[account(mut)]
    pub position: AccountInfo<'info>,

    #[account(constraint = position_token_account.amount == 1)]
    pub position_token_account: Account<'info, TokenAccount>,

    /// Vault's token A account — fees land here.
    #[account(mut)]
    pub token_owner_account_a: Account<'info, TokenAccount>,
    /// CHECK: Whirlpool validates against whirlpool.token_vault_a
    #[account(mut)]
    pub token_vault_a: AccountInfo<'info>,
    /// Vault's token B account — fees land here.
    #[account(mut)]
    pub token_owner_account_b: Account<'info, TokenAccount>,
    /// CHECK: Whirlpool validates against whirlpool.token_vault_b
    #[account(mut)]
    pub token_vault_b: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: program ID verified by constraint
    #[account(address = WHIRLPOOL_PROGRAM_ID)]
    pub whirlpool_program: AccountInfo<'info>,
}

// ── CPI functions ─────────────────────────────────────────────────────────────

/// Open a new zero-liquidity position in a Whirlpool at the given tick range.
/// Caller must derive `tick_lower_index`/`tick_upper_index` to be valid
/// multiples of the pool's tick spacing before calling this.
pub fn orca_open_position<'info>(
    ctx: CpiContext<'_, '_, '_, 'info, OrcaOpenPosition<'info>>,
    tick_lower_index: i32,
    tick_upper_index: i32,
    authority_seeds: &[&[u8]],
) -> Result<()> {
    let mut data = OPEN_POSITION_IX.to_vec();
    // OpenPositionBumps is a single-field struct { position_bump: u8 } in Orca's
    // IDL — Anchor's client resolves this automatically; the raw instruction
    // still expects it serialized first, then the two tick indices.
    data.push(0u8); // position_bump placeholder — Anchor's `init` derives+writes the real seed bump on-chain regardless of this value
    data.extend_from_slice(&tick_lower_index.to_le_bytes());
    data.extend_from_slice(&tick_upper_index.to_le_bytes());

    let metas = vec![
        AccountMeta::new(*ctx.accounts.vault_authority.key, true),
        AccountMeta::new_readonly(*ctx.accounts.vault_authority.key, false), // owner (position NFT owner) — vault itself
        AccountMeta::new(*ctx.accounts.position.key, false),
        AccountMeta::new(ctx.accounts.position_mint.key(), true),
        AccountMeta::new(ctx.accounts.position_token_account.key(), false),
        AccountMeta::new_readonly(*ctx.accounts.whirlpool.key, false),
        AccountMeta::new_readonly(*ctx.accounts.token_program.key, false),
        AccountMeta::new_readonly(*ctx.accounts.system_program.key, false),
        AccountMeta::new_readonly(anchor_lang::solana_program::sysvar::rent::ID, false),
        AccountMeta::new_readonly(*ctx.accounts.associated_token_program.key, false),
    ];

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *ctx.accounts.whirlpool_program.key,
            accounts: metas,
            data,
        },
        &[
            ctx.accounts.vault_authority.clone(),
            ctx.accounts.vault_authority.clone(),
            ctx.accounts.position.clone(),
            ctx.accounts.position_mint.to_account_info(),
            ctx.accounts.position_token_account.to_account_info(),
            ctx.accounts.whirlpool.clone(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.rent.to_account_info(),
            ctx.accounts.associated_token_program.clone(),
        ],
        &[authority_seeds],
    )?;

    msg!("orca_open_position: ticks [{}, {}]", tick_lower_index, tick_upper_index);
    Ok(())
}

/// Add liquidity to an existing position. `token_max_a`/`token_max_b` are
/// slippage guards — the CPI fails if it would need to pull more than these.
pub fn orca_increase_liquidity<'info>(
    ctx: CpiContext<'_, '_, '_, 'info, OrcaModifyLiquidity<'info>>,
    liquidity_amount: u128,
    token_max_a: u64,
    token_max_b: u64,
    authority_seeds: &[&[u8]],
) -> Result<()> {
    let mut data = INCREASE_LIQUIDITY_IX.to_vec();
    data.extend_from_slice(&liquidity_amount.to_le_bytes());
    data.extend_from_slice(&token_max_a.to_le_bytes());
    data.extend_from_slice(&token_max_b.to_le_bytes());

    invoke_modify_liquidity(&ctx, data, authority_seeds)?;
    msg!("orca_increase_liquidity: {} liquidity", liquidity_amount);
    Ok(())
}

/// Remove liquidity from an existing position. `token_min_a`/`token_min_b`
/// are slippage guards — the CPI fails if it would return less than these.
pub fn orca_decrease_liquidity<'info>(
    ctx: CpiContext<'_, '_, '_, 'info, OrcaModifyLiquidity<'info>>,
    liquidity_amount: u128,
    token_min_a: u64,
    token_min_b: u64,
    authority_seeds: &[&[u8]],
) -> Result<()> {
    let mut data = DECREASE_LIQUIDITY_IX.to_vec();
    data.extend_from_slice(&liquidity_amount.to_le_bytes());
    data.extend_from_slice(&token_min_a.to_le_bytes());
    data.extend_from_slice(&token_min_b.to_le_bytes());

    invoke_modify_liquidity(&ctx, data, authority_seeds)?;
    msg!("orca_decrease_liquidity: {} liquidity", liquidity_amount);
    Ok(())
}

fn invoke_modify_liquidity<'info>(
    ctx: &CpiContext<'_, '_, '_, 'info, OrcaModifyLiquidity<'info>>,
    data: Vec<u8>,
    authority_seeds: &[&[u8]],
) -> Result<()> {
    let metas = vec![
        AccountMeta::new(*ctx.accounts.whirlpool.key, false),
        AccountMeta::new_readonly(*ctx.accounts.token_program.key, false),
        AccountMeta::new_readonly(*ctx.accounts.position_authority.key, true),
        AccountMeta::new(*ctx.accounts.position.key, false),
        AccountMeta::new_readonly(ctx.accounts.position_token_account.key(), false),
        AccountMeta::new(ctx.accounts.token_owner_account_a.key(), false),
        AccountMeta::new(ctx.accounts.token_owner_account_b.key(), false),
        AccountMeta::new(*ctx.accounts.token_vault_a.key, false),
        AccountMeta::new(*ctx.accounts.token_vault_b.key, false),
        AccountMeta::new(*ctx.accounts.tick_array_lower.key, false),
        AccountMeta::new(*ctx.accounts.tick_array_upper.key, false),
    ];

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *ctx.accounts.whirlpool_program.key,
            accounts: metas,
            data,
        },
        &[
            ctx.accounts.whirlpool.clone(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.position_authority.clone(),
            ctx.accounts.position.clone(),
            ctx.accounts.position_token_account.to_account_info(),
            ctx.accounts.token_owner_account_a.to_account_info(),
            ctx.accounts.token_owner_account_b.to_account_info(),
            ctx.accounts.token_vault_a.clone(),
            ctx.accounts.token_vault_b.clone(),
            ctx.accounts.tick_array_lower.clone(),
            ctx.accounts.tick_array_upper.clone(),
        ],
        &[authority_seeds],
    )?;
    Ok(())
}

/// Sweep accrued swap fees out of the position and into the vault's token accounts.
///
/// This is REQUIRED before `close_position`: Orca gates closing on
/// `is_position_empty`, which demands `fee_owed_a == 0 && fee_owed_b == 0` (and
/// zero rewards owed) as well as zero liquidity. Without this, exiting a position
/// that has earned even one lamport of fees reverts — which means a reposition
/// can never complete and the vault's funds sit idle.
///
/// Unlike Raydium, whose `decrease_liquidity` collects fees automatically, Orca
/// keeps fees owed on the position until this instruction is called explicitly.
///
/// Call AFTER decreasing liquidity: `decrease_liquidity` updates the position's
/// accrued-fee counters, so collecting last captures fees earned right up to exit.
pub fn orca_collect_fees<'info>(
    ctx: CpiContext<'_, '_, '_, 'info, OrcaCollectFees<'info>>,
    authority_seeds: &[&[u8]],
) -> Result<()> {
    let data = COLLECT_FEES_IX.to_vec();

    let metas = vec![
        AccountMeta::new_readonly(*ctx.accounts.whirlpool.key, false),
        AccountMeta::new_readonly(*ctx.accounts.position_authority.key, true),
        AccountMeta::new(*ctx.accounts.position.key, false),
        AccountMeta::new_readonly(ctx.accounts.position_token_account.key(), false),
        AccountMeta::new(ctx.accounts.token_owner_account_a.key(), false),
        AccountMeta::new(*ctx.accounts.token_vault_a.key, false),
        AccountMeta::new(ctx.accounts.token_owner_account_b.key(), false),
        AccountMeta::new(*ctx.accounts.token_vault_b.key, false),
        AccountMeta::new_readonly(*ctx.accounts.token_program.key, false),
    ];

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *ctx.accounts.whirlpool_program.key,
            accounts: metas,
            data,
        },
        &[
            ctx.accounts.whirlpool.clone(),
            ctx.accounts.position_authority.clone(),
            ctx.accounts.position.clone(),
            ctx.accounts.position_token_account.to_account_info(),
            ctx.accounts.token_owner_account_a.to_account_info(),
            ctx.accounts.token_vault_a.clone(),
            ctx.accounts.token_owner_account_b.to_account_info(),
            ctx.accounts.token_vault_b.clone(),
            ctx.accounts.token_program.to_account_info(),
        ],
        &[authority_seeds],
    )?;

    msg!("orca_collect_fees");
    Ok(())
}

/// Refresh a position's `fee_owed_a`/`fee_owed_b` checkpoint against the pool's
/// current fee-growth accounting, WITHOUT changing liquidity or moving any tokens.
///
/// Needed because `decrease_liquidity` — the CPI this program used everywhere else
/// to trigger that same checkpoint — HARD-REJECTS a zero liquidity_amount
/// (`LiquidityZero`, confirmed live against a real mainnet position 2026-09-01: a
/// `decrease_liquidity(0, 0, 0)` call, otherwise harmless, reverted the whole
/// transaction before `collect_fees` ever ran). Orca ships this dedicated
/// instruction for exactly this "checkpoint only, no principal change" case —
/// it's fully permissionless (no position_authority signer, no token accounts at
/// all), matching its own Anchor account struct
/// (programs/whirlpool/src/instructions/update_fees_and_rewards.rs upstream).
///
/// Call BEFORE `orca_collect_fees`: collect only pays out whatever is already
/// checkpointed into fee_owed, so this has to run first or collect sweeps stale
/// (zero, on a position nothing else has touched) numbers.
pub fn orca_update_fees_and_rewards<'info>(
    whirlpool_program: &AccountInfo<'info>,
    whirlpool: &AccountInfo<'info>,
    position: &AccountInfo<'info>,
    tick_array_lower: &AccountInfo<'info>,
    tick_array_upper: &AccountInfo<'info>,
) -> Result<()> {
    let metas = vec![
        AccountMeta::new(*whirlpool.key, false),
        AccountMeta::new(*position.key, false),
        AccountMeta::new_readonly(*tick_array_lower.key, false),
        AccountMeta::new_readonly(*tick_array_upper.key, false),
    ];

    anchor_lang::solana_program::program::invoke(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *whirlpool_program.key,
            accounts: metas,
            data: UPDATE_FEES_AND_REWARDS_IX.to_vec(),
        },
        &[
            whirlpool.clone(),
            position.clone(),
            tick_array_lower.clone(),
            tick_array_upper.clone(),
        ],
    )?;

    msg!("orca_update_fees_and_rewards");
    Ok(())
}

/// Close a fully-drained (zero-liquidity) position, reclaiming its rent.
pub fn orca_close_position<'info>(
    ctx: CpiContext<'_, '_, '_, 'info, OrcaClosePosition<'info>>,
    authority_seeds: &[&[u8]],
) -> Result<()> {
    let data = CLOSE_POSITION_IX.to_vec();

    let metas = vec![
        AccountMeta::new_readonly(*ctx.accounts.vault_authority.key, true),
        AccountMeta::new(*ctx.accounts.receiver.key, false),
        AccountMeta::new(*ctx.accounts.position.key, false),
        AccountMeta::new(*ctx.accounts.position_mint.key, false),
        AccountMeta::new(ctx.accounts.position_token_account.key(), false),
        AccountMeta::new_readonly(*ctx.accounts.token_program.key, false),
    ];

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *ctx.accounts.whirlpool_program.key,
            accounts: metas,
            data,
        },
        &[
            ctx.accounts.vault_authority.clone(),
            ctx.accounts.receiver.clone(),
            ctx.accounts.position.clone(),
            ctx.accounts.position_mint.clone(),
            ctx.accounts.position_token_account.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
        &[authority_seeds],
    )?;

    msg!("orca_close_position");
    Ok(())
}
