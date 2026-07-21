use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

// Raydium CLMM (concentrated liquidity AMM) mainnet program ID.
pub const RAYDIUM_CLMM_PROGRAM_ID: Pubkey = pubkey!("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
// Metaplex Token Metadata program — required by open_position (mints a real
// NFT with metadata for the position).
pub const METADATA_PROGRAM_ID: Pubkey = pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// Anchor global-namespace discriminators: sha256("global:<ix_name>")[..8].
// Computed directly, verified against Raydium's real instruction names in
// programs/amm/src/lib.rs's #[program] block (github.com/raydium-io/raydium-clmm,
// 2026-07-09). Using the non-V2 instruction variants (open_position,
// increase_liquidity, decrease_liquidity) — the simpler, legacy-SPL-Token-only
// forms, matching every other adapter in this program (Kamino/Marinade/Solend/
// Jito/Orca are all legacy SPL Token, none need Token-2022). The V2 variants
// add Token-2022 support we don't need — a future extension, not now.
const OPEN_POSITION_IX:      [u8; 8] = [135, 128, 47, 77, 15, 152, 240, 49];
const INCREASE_LIQUIDITY_IX: [u8; 8] = [46, 156, 243, 118, 13, 205, 251, 178];
const DECREASE_LIQUIDITY_IX: [u8; 8] = [160, 38, 208, 111, 104, 91, 44, 1];
const CLOSE_POSITION_IX:     [u8; 8] = [123, 134, 81, 0, 49, 68, 98, 98];

// ── PDA seed notes (for the caller — this program does not derive these) ──
//
// tick_array:        ["tick_array", pool_state, start_tick_index.to_be_bytes()]
// personal_position:  ["position", position_nft_mint]
// protocol_position:  ["position", pool_state, tick_lower_index.to_be_bytes(), tick_upper_index.to_be_bytes()]
//   (marked "deprecated, kept for compatibility" in Raydium's own source, but
//   STILL REQUIRED as a real account on every call — not optional.)
//
// IMPORTANT: Raydium encodes tick indices as BIG-ENDIAN bytes (to_be_bytes()),
// unlike Orca's decimal-string encoding (see adapters/orca.rs) — a detail
// that would silently derive the wrong address if the two were confused.

// ── Account contexts ──────────────────────────────────────────────────────────
//
// NOTE: mirrors Raydium's real Anchor account structs (verified against
// raydium-io/raydium-clmm source, 2026-07-09) but is NOT yet wired into any
// lib.rs instruction — groundwork only, same pattern as adapters/orca.rs.
// Unlike Orca, Raydium's open_position combines position-creation AND the
// first liquidity deposit into a single instruction (no separate
// zero-liquidity "open" step).

#[derive(Accounts)]
pub struct RaydiumOpenPosition<'info> {
    /// Vault authority — pays for the new position + NFT, becomes the
    /// position NFT's owner.
    /// CHECK: seeds verified in parent instruction
    #[account(mut)]
    pub vault_authority: AccountInfo<'info>,

    /// New position NFT mint (0 decimals, 1 unit ever minted) — fresh
    /// keypair at the client level (Anchor `init` on a Mint).
    #[account(mut)]
    /// CHECK: does not exist yet — Raydium inits this mint inside open_position.
    pub position_nft_mint: AccountInfo<'info>,

    /// Vault-owned ATA that will hold the position NFT.
    #[account(mut)]
    /// CHECK: does not exist yet — created by open_position as an ATA.
    pub position_nft_account: AccountInfo<'info>,

    /// Metaplex metadata account for the position NFT (PDA, standard
    /// Metaplex seeds: ["metadata", metadata_program, position_nft_mint]).
    /// CHECK: Metaplex program validates + initializes
    #[account(mut)]
    pub metadata_account: AccountInfo<'info>,

    /// CHECK: Raydium program validates (zero-copy AccountLoader on-chain)
    #[account(mut)]
    pub pool_state: AccountInfo<'info>,

    /// Deprecated by Raydium but still required on every call — see PDA
    /// seed notes above.
    /// CHECK: Raydium program validates
    pub protocol_position: AccountInfo<'info>,

    /// CHECK: Raydium program validates (PDA, see seed notes above)
    #[account(mut)]
    pub tick_array_lower: AccountInfo<'info>,
    /// CHECK: Raydium program validates (PDA, see seed notes above)
    #[account(mut)]
    pub tick_array_upper: AccountInfo<'info>,

    /// New position state account (Anchor `init`, PDA seeds
    /// ["position", position_nft_mint]).
    /// CHECK: Raydium program validates + initializes
    #[account(mut)]
    pub personal_position: AccountInfo<'info>,

    /// Vault's token A staging account.
    #[account(mut)]
    pub token_account_0: Account<'info, TokenAccount>,
    /// Vault's token B staging account.
    #[account(mut)]
    pub token_account_1: Account<'info, TokenAccount>,
    /// Pool's token A vault.
    /// CHECK: Raydium validates against pool_state.token_vault_0
    #[account(mut)]
    pub token_vault_0: AccountInfo<'info>,
    /// Pool's token B vault.
    /// CHECK: Raydium validates against pool_state.token_vault_1
    #[account(mut)]
    pub token_vault_1: AccountInfo<'info>,

    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    /// CHECK: associated token program
    pub associated_token_program: AccountInfo<'info>,
    /// CHECK: Metaplex Token Metadata program
    #[account(address = METADATA_PROGRAM_ID)]
    pub metadata_program: AccountInfo<'info>,

    /// CHECK: program ID verified by constraint
    #[account(address = RAYDIUM_CLMM_PROGRAM_ID)]
    pub raydium_program: AccountInfo<'info>,
}

/// Shared by increase_liquidity and decrease_liquidity — Raydium uses
/// near-identical account sets for both (verified against raydium-io/
/// raydium-clmm source, 2026-07-09; decrease_liquidity uses separate
/// "recipient" token accounts instead of "token_account_0/1", but they play
/// the same structural role).
#[derive(Accounts)]
pub struct RaydiumModifyLiquidity<'info> {
    /// Vault authority — owns the position NFT, must sign.
    /// CHECK: seeds verified in parent
    pub vault_authority: AccountInfo<'info>,

    /// Vault-owned ATA holding the position NFT (must hold exactly 1 unit).
    #[account(constraint = nft_account.amount == 1)]
    pub nft_account: Account<'info, TokenAccount>,

    /// CHECK: Raydium program validates
    #[account(mut)]
    pub pool_state: AccountInfo<'info>,

    /// CHECK: Raydium program validates (deprecated but still required)
    pub protocol_position: AccountInfo<'info>,

    /// CHECK: Raydium program validates
    #[account(mut)]
    pub personal_position: AccountInfo<'info>,

    /// CHECK: Raydium program validates (PDA, see seed notes in this module)
    #[account(mut)]
    pub tick_array_lower: AccountInfo<'info>,
    /// CHECK: Raydium program validates (PDA, see seed notes in this module)
    #[account(mut)]
    pub tick_array_upper: AccountInfo<'info>,

    /// Vault's token A account (deposit source / withdrawal destination).
    #[account(mut)]
    pub token_account_0: Account<'info, TokenAccount>,
    /// Vault's token B account (deposit source / withdrawal destination).
    #[account(mut)]
    pub token_account_1: Account<'info, TokenAccount>,
    /// CHECK: Raydium validates against pool_state.token_vault_0
    #[account(mut)]
    pub token_vault_0: AccountInfo<'info>,
    /// CHECK: Raydium validates against pool_state.token_vault_1
    #[account(mut)]
    pub token_vault_1: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: program ID verified by constraint
    #[account(address = RAYDIUM_CLMM_PROGRAM_ID)]
    pub raydium_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct RaydiumClosePosition<'info> {
    /// CHECK: seeds verified in parent
    #[account(mut)]
    pub vault_authority: AccountInfo<'info>,

    /// CHECK: Raydium program validates (address = personal_position.nft_mint)
    #[account(mut)]
    pub position_nft_mint: AccountInfo<'info>,

    #[account(mut, constraint = position_nft_account.amount == 1)]
    pub position_nft_account: Account<'info, TokenAccount>,

    /// CHECK: Raydium program validates + closes (close = vault_authority)
    #[account(mut)]
    pub personal_position: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,

    /// CHECK: program ID verified by constraint
    #[account(address = RAYDIUM_CLMM_PROGRAM_ID)]
    pub raydium_program: AccountInfo<'info>,
}

// ── CPI functions ─────────────────────────────────────────────────────────────

/// Open a new position AND deposit initial liquidity in one instruction
/// (unlike Orca, Raydium doesn't support opening a zero-liquidity position).
/// Caller must derive `tick_array_lower_start_index`/`tick_array_upper_start_index`
/// (the START of each tick array, not the position's own tick bounds) — see
/// this module's PDA seed notes.
pub fn raydium_open_position<'info>(
    ctx: CpiContext<'_, '_, '_, 'info, RaydiumOpenPosition<'info>>,
    tick_lower_index: i32,
    tick_upper_index: i32,
    tick_array_lower_start_index: i32,
    tick_array_upper_start_index: i32,
    liquidity: u128,
    amount_0_max: u64,
    amount_1_max: u64,
    authority_seeds: &[&[u8]],
) -> Result<()> {
    let mut data = OPEN_POSITION_IX.to_vec();
    data.extend_from_slice(&tick_lower_index.to_le_bytes());
    data.extend_from_slice(&tick_upper_index.to_le_bytes());
    data.extend_from_slice(&tick_array_lower_start_index.to_le_bytes());
    data.extend_from_slice(&tick_array_upper_start_index.to_le_bytes());
    data.extend_from_slice(&liquidity.to_le_bytes());
    data.extend_from_slice(&amount_0_max.to_le_bytes());
    data.extend_from_slice(&amount_1_max.to_le_bytes());

    let metas = vec![
        AccountMeta::new(*ctx.accounts.vault_authority.key, true),
        AccountMeta::new_readonly(*ctx.accounts.vault_authority.key, false), // position_nft_owner
        AccountMeta::new(ctx.accounts.position_nft_mint.key(), true),
        AccountMeta::new(ctx.accounts.position_nft_account.key(), false),
        AccountMeta::new(*ctx.accounts.metadata_account.key, false),
        AccountMeta::new(*ctx.accounts.pool_state.key, false),
        AccountMeta::new(*ctx.accounts.protocol_position.key, false),
        AccountMeta::new(*ctx.accounts.tick_array_lower.key, false),
        AccountMeta::new(*ctx.accounts.tick_array_upper.key, false),
        AccountMeta::new(*ctx.accounts.personal_position.key, false),
        AccountMeta::new(ctx.accounts.token_account_0.key(), false),
        AccountMeta::new(ctx.accounts.token_account_1.key(), false),
        AccountMeta::new(*ctx.accounts.token_vault_0.key, false),
        AccountMeta::new(*ctx.accounts.token_vault_1.key, false),
        AccountMeta::new_readonly(anchor_lang::solana_program::sysvar::rent::ID, false),
        AccountMeta::new_readonly(*ctx.accounts.system_program.key, false),
        AccountMeta::new_readonly(*ctx.accounts.token_program.key, false),
        AccountMeta::new_readonly(*ctx.accounts.associated_token_program.key, false),
        AccountMeta::new_readonly(*ctx.accounts.metadata_program.key, false),
    ];

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *ctx.accounts.raydium_program.key,
            accounts: metas,
            data,
        },
        &[
            ctx.accounts.vault_authority.clone(),
            ctx.accounts.vault_authority.clone(),
            ctx.accounts.position_nft_mint.to_account_info(),
            ctx.accounts.position_nft_account.to_account_info(),
            ctx.accounts.metadata_account.clone(),
            ctx.accounts.pool_state.clone(),
            ctx.accounts.protocol_position.clone(),
            ctx.accounts.tick_array_lower.clone(),
            ctx.accounts.tick_array_upper.clone(),
            ctx.accounts.personal_position.clone(),
            ctx.accounts.token_account_0.to_account_info(),
            ctx.accounts.token_account_1.to_account_info(),
            ctx.accounts.token_vault_0.clone(),
            ctx.accounts.token_vault_1.clone(),
            ctx.accounts.rent.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.associated_token_program.clone(),
            ctx.accounts.metadata_program.clone(),
        ],
        &[authority_seeds],
    )?;

    msg!("raydium_open_position: ticks [{}, {}], liquidity {}", tick_lower_index, tick_upper_index, liquidity);
    Ok(())
}

pub fn raydium_increase_liquidity<'info>(
    ctx: CpiContext<'_, '_, '_, 'info, RaydiumModifyLiquidity<'info>>,
    liquidity: u128,
    amount_0_max: u64,
    amount_1_max: u64,
    authority_seeds: &[&[u8]],
) -> Result<()> {
    let mut data = INCREASE_LIQUIDITY_IX.to_vec();
    data.extend_from_slice(&liquidity.to_le_bytes());
    data.extend_from_slice(&amount_0_max.to_le_bytes());
    data.extend_from_slice(&amount_1_max.to_le_bytes());

    invoke_modify_liquidity(&ctx, data, authority_seeds, true)?;
    msg!("raydium_increase_liquidity: {} liquidity", liquidity);
    Ok(())
}

pub fn raydium_decrease_liquidity<'info>(
    ctx: CpiContext<'_, '_, '_, 'info, RaydiumModifyLiquidity<'info>>,
    liquidity: u128,
    amount_0_min: u64,
    amount_1_min: u64,
    authority_seeds: &[&[u8]],
) -> Result<()> {
    let mut data = DECREASE_LIQUIDITY_IX.to_vec();
    data.extend_from_slice(&liquidity.to_le_bytes());
    data.extend_from_slice(&amount_0_min.to_le_bytes());
    data.extend_from_slice(&amount_1_min.to_le_bytes());

    invoke_modify_liquidity(&ctx, data, authority_seeds, false)?;
    msg!("raydium_decrease_liquidity: {} liquidity", liquidity);
    Ok(())
}

fn invoke_modify_liquidity<'info>(
    ctx: &CpiContext<'_, '_, '_, 'info, RaydiumModifyLiquidity<'info>>,
    data: Vec<u8>,
    authority_seeds: &[&[u8]],
    increase: bool,
) -> Result<()> {
    // protocol_position is written by the runtime even though Raydium's own Anchor
    // struct has no #[account(mut)] on it (UncheckedAccount gets no auto mutability
    // hint), so the client must mark it writable regardless of the IDL.
    //
    // NOTE: increase and decrease take DIFFERENT account orders. Do not merge these.
    let metas = if increase {
        vec![
            AccountMeta::new_readonly(*ctx.accounts.vault_authority.key, true),
            AccountMeta::new_readonly(ctx.accounts.nft_account.key(), false),
            AccountMeta::new(*ctx.accounts.pool_state.key, false),
            AccountMeta::new(*ctx.accounts.protocol_position.key, false),
            AccountMeta::new(*ctx.accounts.personal_position.key, false),
            AccountMeta::new(*ctx.accounts.tick_array_lower.key, false),
            AccountMeta::new(*ctx.accounts.tick_array_upper.key, false),
            AccountMeta::new(ctx.accounts.token_account_0.key(), false),
            AccountMeta::new(ctx.accounts.token_account_1.key(), false),
            AccountMeta::new(*ctx.accounts.token_vault_0.key, false),
            AccountMeta::new(*ctx.accounts.token_vault_1.key, false),
            AccountMeta::new_readonly(*ctx.accounts.token_program.key, false),
        ]
    } else {
        vec![
            AccountMeta::new_readonly(*ctx.accounts.vault_authority.key, true),
            AccountMeta::new_readonly(ctx.accounts.nft_account.key(), false),
            AccountMeta::new(*ctx.accounts.personal_position.key, false),
            AccountMeta::new(*ctx.accounts.pool_state.key, false),
            AccountMeta::new(*ctx.accounts.protocol_position.key, false),
            AccountMeta::new(*ctx.accounts.token_vault_0.key, false),
            AccountMeta::new(*ctx.accounts.token_vault_1.key, false),
            AccountMeta::new(*ctx.accounts.tick_array_lower.key, false),
            AccountMeta::new(*ctx.accounts.tick_array_upper.key, false),
            AccountMeta::new(ctx.accounts.token_account_0.key(), false),
            AccountMeta::new(ctx.accounts.token_account_1.key(), false),
            AccountMeta::new_readonly(*ctx.accounts.token_program.key, false),
        ]
    };

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *ctx.accounts.raydium_program.key,
            accounts: metas,
            data,
        },
        &[
            ctx.accounts.vault_authority.clone(),
            ctx.accounts.nft_account.to_account_info(),
            ctx.accounts.protocol_position.clone(),
            ctx.accounts.personal_position.clone(),
            ctx.accounts.pool_state.clone(),
            ctx.accounts.tick_array_lower.clone(),
            ctx.accounts.tick_array_upper.clone(),
            ctx.accounts.token_account_0.to_account_info(),
            ctx.accounts.token_account_1.to_account_info(),
            ctx.accounts.token_vault_0.clone(),
            ctx.accounts.token_vault_1.clone(),
            ctx.accounts.token_program.to_account_info(),
        ],
        &[authority_seeds],
    )?;
    Ok(())
}

/// Close a fully-drained (zero-liquidity) position, reclaiming its rent.
pub fn raydium_close_position<'info>(
    ctx: CpiContext<'_, '_, '_, 'info, RaydiumClosePosition<'info>>,
    authority_seeds: &[&[u8]],
) -> Result<()> {
    let data = CLOSE_POSITION_IX.to_vec();

    let metas = vec![
        AccountMeta::new(*ctx.accounts.vault_authority.key, true),
        AccountMeta::new(*ctx.accounts.position_nft_mint.key, false),
        AccountMeta::new(ctx.accounts.position_nft_account.key(), false),
        AccountMeta::new(*ctx.accounts.personal_position.key, false),
        AccountMeta::new_readonly(*ctx.accounts.system_program.key, false),
        AccountMeta::new_readonly(*ctx.accounts.token_program.key, false),
    ];

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: *ctx.accounts.raydium_program.key,
            accounts: metas,
            data,
        },
        &[
            ctx.accounts.vault_authority.clone(),
            ctx.accounts.position_nft_mint.clone(),
            ctx.accounts.position_nft_account.to_account_info(),
            ctx.accounts.personal_position.clone(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
        &[authority_seeds],
    )?;

    msg!("raydium_close_position");
    Ok(())
}
