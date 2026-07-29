use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer as SystemTransfer};
use anchor_lang::solana_program::sysvar::instructions::{
    load_instruction_at_checked, ID as INSTRUCTIONS_SYSVAR_ID,
};
use anchor_spl::{
    associated_token::{self, AssociatedToken, Create},
    token::{self, Mint, MintTo, Token, TokenAccount, Transfer, Burn, CloseAccount, SyncNative},
};

// sha256("global:withdraw")[0..8] — the Anchor instruction discriminator for
// `withdraw`, precomputed rather than pulled from the auto-generated
// `crate::instruction` module so this doesn't depend on that module's exact
// shape across Anchor versions. Used by verify_paired_withdraw below.
const WITHDRAW_DISCRIMINATOR: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];

/// Called by recall_from_* when the signer is NOT the vault's keeper: confirms
/// a `withdraw` instruction for this exact (vault, user) pair exists elsewhere
/// in the same transaction. This is what makes opening recall up to any signer
/// safe — a non-keeper caller can only ever trigger a recall as an inseparable
/// part of their own real, share-burning withdrawal in the same atomic
/// transaction, never as a standalone free action (which would otherwise let
/// anyone force-undeploy the vault's funds — see PR discussion). The keeper's
/// own routine rebalancing recalls are unaffected: they're never paired with a
/// withdraw, so this function is only reached when the caller isn't the keeper.
fn verify_paired_withdraw<'info>(
    instructions_sysvar: &AccountInfo<'info>,
    expected_vault: &Pubkey,
    expected_caller: &Pubkey,
) -> Result<()> {
    require_keys_eq!(
        *instructions_sysvar.key,
        INSTRUCTIONS_SYSVAR_ID,
        VaultError::InvalidInstructionsSysvar
    );

    let mut i: u16 = 0;
    loop {
        // load_instruction_at_checked errors once i runs past the last
        // instruction in this transaction — that's our loop terminator.
        let ix = match load_instruction_at_checked(i as usize, instructions_sysvar) {
            Ok(ix) => ix,
            Err(_) => break,
        };
        // Withdraw's account order (see the Withdraw accounts struct):
        // [0] = user (Signer), [1] = vault.
        if ix.program_id == crate::ID
            && ix.data.len() >= 8
            && ix.data[0..8] == WITHDRAW_DISCRIMINATOR
            && ix.accounts.len() >= 2
            && ix.accounts[0].pubkey == *expected_caller
            && ix.accounts[1].pubkey == *expected_vault
        {
            return Ok(());
        }
        i += 1;
        if i > 32 { break; } // sane upper bound — no real transaction has this many instructions
    }
    err!(VaultError::RecallRequiresPairedWithdraw)
}


/// Settle a recall's accounting for one protocol slot.
///
/// `received`          — underlying actually returned to the vault by the CPI
/// `receipt_before`    — receipt/LST units held BEFORE the CPI
/// `receipt_remaining` — receipt/LST units STILL held after the CPI (0 == we fully exited)
///
/// One proportional model: deployed_balance is reduced by the fraction of receipt tokens
/// removed, and the gain/loss on the recalled portion (received vs its cost basis) is booked
/// into total_deposits. Full exit is just the receipt_remaining == 0 case.
///
/// WHY THE MIDDLE CASE EXISTS (added 2026-07-17). It previously fell into the last branch,
/// so the fee stayed in `deployed_balance` as PHANTOM deployed capital — the vault went on
/// claiming money it had already paid away. Proven on mainnet: after a full recall the
/// receipt account read **0** while `deployed_balance` still claimed 0.000154 SOL, exactly
/// the fees Marinade and Jito had charged. There was no code path anywhere that could
/// recognise a realized LOSS; only gains were ever booked.
///
/// Why it mattered, both real:
///   1. `withdraw()` values a share against `idle + total_deployed()`, so the phantom
///      inflated total_value above the recoverable amount and `require!(idle >= amount_out)`
///      rejected ANY withdrawal within a fee's width of 100%. Nobody could fully exit; the
///      frontend had to cap MAX below the ceiling to compensate.
///   2. It accumulated on ABANDONED protocols specifically. A slot the router rotates away
///      from is never redeployed, so nothing overwrites the residue — whereas an active slot
///      "self-heals" the moment the next deploy re-backs it with real receipts. A yield
///      router abandons venues for a living, so this grew precisely where nobody was looking.
///
/// Deliberately keyed on the RECEIPT balance rather than comparing amounts: only "do we
/// still hold a claim on that protocol?" distinguishes a partial recall from a full exit.
/// Sizes can't — a fee and a partial withdrawal both just look like `received < deployed`.
fn settle_recall(
    v: &mut Vault,
    idx: usize,
    received: u64,
    receipt_before: u64,
    receipt_remaining: u64,
) -> Result<()> {
    let deployed = v.protocols[idx].deployed_balance;

    // ONE proportional model for every recall, full OR partial.
    //
    // Remaining deployed cost-basis scales with the fraction of RECEIPT tokens still held.
    // The earlier version handled partial recalls with `deployed - received`, mixing
    // underlying units into a receipt-token operation, so exit-fee residue stayed baked into
    // deployed_balance and ACCUMULATED over repeated partial recalls — only ever fully cleared
    // by a 100% exit. Now deployed_balance is reduced strictly in proportion to the receipt
    // tokens removed, and the real gain/loss on the recalled portion is booked into
    // total_deposits every time. (Updated 2026-07-28; keeps deployed_balance honest under
    // partial recalls, not just full ones.)
    //
    // u128 intermediate so `deployed * receipt_remaining` can't overflow u64.
    let new_deployed: u64 = if receipt_before == 0 {
        0
    } else {
        ((deployed as u128) * (receipt_remaining as u128) / (receipt_before as u128)) as u64
    };
    let cost_basis_recalled = deployed.saturating_sub(new_deployed);

    if received >= cost_basis_recalled {
        // Realized yield on the recalled portion.
        let gain = received - cost_basis_recalled;
        v.total_deposits = v.total_deposits.checked_add(gain).ok_or(VaultError::MathOverflow)?;
    } else {
        // Realized loss (exit fee / slippage). saturating_sub: a loss can never underflow the vault.
        let loss = cost_basis_recalled - received;
        v.total_deposits = v.total_deposits.saturating_sub(loss);
    }
    v.protocols[idx].deployed_balance = new_deployed;
    Ok(())
}

// WSOL mint — used to recreate the vault's SOL token account after a full
// unwrap-for-Marinade cycle (see deploy_to_marinade).
const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

pub mod adapters;
use adapters::{
    kamino::{KaminoDeposit, KaminoWithdraw, kamino_deposit, kamino_withdraw, KAMINO_LENDING_PROGRAM_ID},
    marinade::{MarinadeDeposit, MarinadeUnstake, marinade_deposit, marinade_liquid_unstake},
    spl_stake_pool::{SplStakePoolDeposit, SplStakePoolWithdraw, spl_stake_pool_deposit, spl_stake_pool_withdraw},
    solend::{SolendDeposit, SolendWithdraw, solend_deposit, solend_withdraw},
    {AdapterError, ProtocolAdapter, ProtocolKind, assert_state_matches},
};

// Program ID differs by network — devnet and mainnet are separate deployments
// with separate addresses (the devnet address was never usable on mainnet;
// see project memory for why). PDA derivations implicitly use this ID, so it
// must match whichever address the binary is actually deployed to.
#[cfg(not(feature = "mainnet"))]
declare_id!("8c7Boyk91MWkn5jabf5CnYD8DrG6p4hYm9eDdAAWXEKH");
#[cfg(feature = "mainnet")]
declare_id!("3tAEmHXZ51YVLe9ts8b9cMcgQPgaSamLxLtxR31VpREi");

// ── Constants ─────────────────────────────────────────────────────────────────

const BPS_DENOM: u64          = 10_000;
const MAX_PROTOCOLS: usize    = 6; // trimmed from 8 (2026-07-16): Vault.protocols array was pushing BorshDeserialize::deserialize_reader 64 bytes over the 4096 BPF stack frame limit (flagged by cargo-build-sbf as a real undefined-behavior risk). Only 2 protocols are registered per vault today; 6 leaves 4x headroom.
const COMPOUND_INTERVAL: i64  = 3_600;        // 1 hour
const MIN_FIRST_DEPOSIT: u64  = 1_000_000;    // $1 minimum first deposit (anti-donation-attack)
// Keeper must leave at least 10% of total deposits idle at all times.
// Prevents keeper from deploying 100% of funds, which would block all withdrawals.
const MIN_IDLE_BPS: u64       = 1_000;        // 10%

// Token-gate tier thresholds (number of gate tokens required)
const GOLD_THRESHOLD:   u64 = 1_000_000;     // 1M tokens  → unlimited deposits, 0% fee
const SILVER_THRESHOLD: u64 =   100_000;     // 100k tokens → $10k cap, 3% fee
const BRONZE_THRESHOLD: u64 =    10_000;     // 10k tokens  → $1k cap, 6% fee

// Minimum time between update_tier_thresholds calls — prevents thresholds being
// spiked right before a specific withdrawal to force a worse fee tier onto a user
// who held a good tier for their whole deposit (withdraw fee uses the worse of
// current-tier vs tier-at-deposit, so a same-block admin change could otherwise
// override that snapshot's intent).
const TIER_THRESHOLD_COOLDOWN_SECS: i64 = 30 * 24 * 60 * 60; // 30 days

// Tiered performance fees (in bps). Applied on profit at withdrawal.
const GOLD_FEE_BPS:   u64 =   0; // 0%
const SILVER_FEE_BPS: u64 = 300; // 3%
const BRONZE_FEE_BPS:    u64 = 600; // 6%
const STANDARD_FEE_BPS:  u64 = 900; // 9% — Tier 4 (sub 0.1% or no gate token)

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum HolderTier { Gold, Silver, Bronze, None }

// ── Program ───────────────────────────────────────────────────────────────────

#[program]
pub mod yieldpilot {
    use super::*;

    // ── Vault lifecycle ───────────────────────────────────────────────────────

    pub fn initialize_vault(ctx: Context<InitializeVault>, params: InitVaultParams) -> Result<()> {
        require!(params.name.len() <= 32, VaultError::NameTooLong);
        require!(params.tvl_cap >= MIN_FIRST_DEPOSIT, VaultError::TvlCapTooLow);

        let v = &mut ctx.accounts.vault;
        v.admin               = ctx.accounts.admin.key();
        v.keeper              = params.keeper;
        v.mint                = ctx.accounts.mint.key();
        v.vault_token_account = ctx.accounts.vault_token_account.key();
        v.shares_mint         = ctx.accounts.shares_mint.key();
        v.treasury  = params.treasury;
        v.gold_threshold   = GOLD_THRESHOLD;
        v.silver_threshold = SILVER_THRESHOLD;
        v.bronze_threshold = BRONZE_THRESHOLD;
        // Normalize: zero pubkey also means no gating
        v.gate_mint = if params.gate_mint == Pubkey::default() {
            anchor_lang::solana_program::system_program::ID
        } else {
            params.gate_mint
        };
        v.pending_admin       = Pubkey::default();
        v.total_deposits      = 0;
        v.total_shares        = 0;
        v.auto_compound       = params.auto_compound;
        v.auto_rebalance      = params.auto_rebalance;
        v.last_compound_ts    = Clock::get()?.unix_timestamp;
        v.last_threshold_update_ts = 0; // 0 = never updated; first update_tier_thresholds call is never blocked
        v.name                = params.name;
        v.bump                = ctx.bumps.vault;
        v.authority_bump      = ctx.bumps.vault_authority;
        v.protocol_count      = 0;
        v.protocols           = [ProtocolAdapter::default(); MAX_PROTOCOLS];
        v.paused              = false;
        v.tvl_cap             = params.tvl_cap;
        // Unique per-lifecycle stamp: lets deposit() tell apart a genuinely fresh
        // position from a stale one left over by a prior vault at the same PDA
        // (same mint+admin seeds can be reinitialized after close_vault).
        v.created_at          = Clock::get()?.unix_timestamp;

        emit!(VaultInitialized { vault: v.key(), admin: v.admin, mint: v.mint });
        Ok(())
    }

    pub fn register_protocol(
        ctx: Context<AdminOnly>,
        kind: u8,
        external_state: Pubkey,
        vault_receipt_account: Pubkey,
        target_bps: u64,
        label: String,
    ) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        require!(!v.paused, AdapterError::VaultPaused);
        require!(v.protocol_count < MAX_PROTOCOLS as u8, VaultError::TooManyProtocols);
        require!(label.len() <= 24, VaultError::NameTooLong);

        let current_total: u64 = v.protocols[..v.protocol_count as usize]
            .iter().map(|p| p.target_bps).sum();
        require!(current_total + target_bps <= BPS_DENOM, VaultError::AllocationExceeded);

        let kind = match kind {
            0 => ProtocolKind::Kamino,
            1 => ProtocolKind::Marinade,
            2 => ProtocolKind::Solend,
            3 => ProtocolKind::Jito,
            _ => return err!(AdapterError::UnsupportedProtocol),
        };

        let mut label_bytes = [0u8; 24];
        label_bytes[..label.len()].copy_from_slice(label.as_bytes());

        let idx = v.protocol_count as usize;
        v.protocols[idx] = ProtocolAdapter {
            kind,
            external_state,
            vault_receipt_account,
            deployed_balance: 0,
            target_bps,
            label: label_bytes,
        };
        v.protocol_count += 1;

        emit!(ProtocolRegistered { vault: v.key(), external_state, target_bps });
        Ok(())
    }

    // ── User instructions ─────────────────────────────────────────────────────

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.vault.paused, AdapterError::VaultPaused);
        require!(amount > 0, VaultError::ZeroAmount);

        let v = &mut ctx.accounts.vault;

        // Token-gate: gate_mint == SystemProgram means no gating
        if v.gate_mint != anchor_lang::solana_program::system_program::ID {
            // Validate gate account belongs to user and uses the correct mint
            if let Some(gate_acct) = ctx.accounts.user_gate_account.as_ref() {
                require!(gate_acct.mint == v.gate_mint, VaultError::InvalidGateAccount);
                require!(gate_acct.owner == ctx.accounts.user.key(), VaultError::InvalidGateAccount);
            }
            let gate_balance = ctx.accounts.user_gate_account
                .as_ref()
                .map(|a| a.amount)
                .unwrap_or(0);
            let tier = if gate_balance >= v.gold_threshold {
                HolderTier::Gold
            } else if gate_balance >= v.silver_threshold {
                HolderTier::Silver
            } else if gate_balance >= v.bronze_threshold {
                HolderTier::Bronze
            } else {
                HolderTier::None
            };
            // No per-tier deposit cap: every tier can deposit any amount. The tier
            // only ever affects the performance fee rate charged on profit at exit.
            // Snapshot tier for withdrawal fee calculation (anti-flash-loan)
            let tier_u8: u8 = match tier {
                HolderTier::Gold   => 0,
                HolderTier::Silver => 1,
                HolderTier::Bronze => 2,
                HolderTier::None   => 3,
            };
            // Store the WORSE tier (higher number = worse) so borrowing tokens for one tx
            // cannot retroactively improve the fee on an existing position.
            let existing = ctx.accounts.user_position.tier_at_deposit;
            ctx.accounts.user_position.tier_at_deposit = existing.max(tier_u8);
        }

        // TVL cap check
        require!(
            v.total_deposits.saturating_add(amount) <= v.tvl_cap,
            VaultError::TvlCapExceeded
        );

        // Anti-donation attack: first depositor must deposit at least MIN_FIRST_DEPOSIT
        if v.total_shares == 0 {
            require!(amount >= MIN_FIRST_DEPOSIT, VaultError::FirstDepositTooSmall);
        }

        // Share calculation
        let shares_to_mint: u64 = if v.total_shares == 0 || v.total_deposits == 0 {
            amount
        } else {
            (amount as u128)
                .checked_mul(v.total_shares as u128)
                .and_then(|x| x.checked_div(v.total_deposits as u128))
                .ok_or(VaultError::MathOverflow)? as u64
        };
        require!(shares_to_mint > 0, VaultError::ZeroShares);

        // Transfer tokens from user → vault
        token::transfer(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer {
                from:      ctx.accounts.user_token_account.to_account_info(),
                to:        ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            }),
            amount,
        )?;

        // Mint shares to user
        let vault_key = v.key();
        let signer_seeds: &[&[u8]] = &[b"vault", vault_key.as_ref(), &[v.authority_bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint:      ctx.accounts.shares_mint.to_account_info(),
                    to:        ctx.accounts.user_shares_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[signer_seeds],
            ),
            shares_to_mint,
        )?;

        // Update state
        v.total_deposits = v.total_deposits.checked_add(amount).ok_or(VaultError::MathOverflow)?;
        v.total_shares   = v.total_shares.checked_add(shares_to_mint).ok_or(VaultError::MathOverflow)?;

        // Create/update position
        let pos = &mut ctx.accounts.user_position;
        if pos.owner == Pubkey::default() {
            pos.owner = ctx.accounts.user.key();
            pos.vault = v.key();
            pos.bump  = ctx.bumps.user_position;
        }
        // Clear any phantom shares/deposited_amount left over from a previous vault
        // lifecycle at this same PDA (close_vault only closes the Vault account,
        // never the UserPosition PDAs — a reinitialized vault with the same
        // mint+admin seeds would otherwise inherit every past depositor's stale
        // balance, not just the very first one back). Compare against the vault's
        // own creation stamp rather than "am I the first depositor", since that
        // stale-detection only ever caught the first depositor after a reset.
        if pos.vault_created_at != v.created_at {
            pos.shares           = 0;
            pos.deposited_amount = 0;
            pos.vault_created_at = v.created_at;
        }
        pos.shares           = pos.shares.checked_add(shares_to_mint).ok_or(VaultError::MathOverflow)?;
        pos.deposited_amount = pos.deposited_amount.checked_add(amount).ok_or(VaultError::MathOverflow)?;
        pos.last_deposit_ts  = Clock::get()?.unix_timestamp;

        emit!(Deposited { vault: v.key(), user: ctx.accounts.user.key(), amount, shares_minted: shares_to_mint });
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, shares: u64, min_amount_out: u64) -> Result<()> {
        // Note: withdrawal is allowed even when paused so users can always exit
        require!(shares > 0, VaultError::ZeroAmount);

        let pos = &mut ctx.accounts.user_position;
        require!(pos.shares >= shares, VaultError::InsufficientShares);

        let v = &mut ctx.accounts.vault;
        require!(v.total_shares > 0, VaultError::ZeroShares);

        // How many base tokens does this share represent?
        // A share is a claim on the vault's TOTAL value, not just the idle portion.
        // Value it against idle balance + funds currently deployed to protocols —
        // otherwise, whenever the keeper has funds deployed (up to 90% of TVL), a
        // withdrawer would be paid only their fraction of the ~10% idle balance and
        // silently lose the rest to the remaining holders. deployed_balance tracks
        // deployed principal (accrued yield is realized into total_deposits on
        // recall), so idle + total_deployed is a conservative floor on true value:
        // it never over-values a share, so it can never drain the vault.
        let idle_balance = ctx.accounts.vault_token_account.amount;
        let total_value = idle_balance
            .checked_add(v.total_deployed())
            .ok_or(VaultError::MathOverflow)?;
        let amount_out = (shares as u128)
            .checked_mul(total_value as u128)
            .and_then(|x| x.checked_div(v.total_shares as u128))
            .ok_or(VaultError::MathOverflow)? as u64;
        require!(amount_out > 0, VaultError::ZeroAmount);
        // Slippage guard: caller specifies the minimum they will accept.
        // Protects against vault balance dropping between simulation and execution.
        require!(amount_out >= min_amount_out, VaultError::SlippageExceeded);
        // SECURITY: the payout is drawn from the idle balance only. If funds are
        // deployed and idle can't cover the fair amount, revert so the keeper
        // recalls first — never underpay the user by valuing against idle alone.
        require!(idle_balance >= amount_out, VaultError::InsufficientIdle);

        // Cost basis for this share tranche (for fee calculation)
        let cost_basis = (shares as u128)
            .checked_mul(pos.deposited_amount as u128)
            .and_then(|x| x.checked_div(pos.shares as u128))
            .unwrap_or(0) as u64;

        // Determine fee rate by tier (gate_mint == default means no gating → use vault default)
        let fee_bps = if v.gate_mint != anchor_lang::solana_program::system_program::ID {
            // Validate gate account mint and owner before trusting balance
            if let Some(gate_acct) = ctx.accounts.user_gate_account.as_ref() {
                require!(gate_acct.mint == v.gate_mint, VaultError::InvalidGateAccount);
                require!(gate_acct.owner == ctx.accounts.user.key(), VaultError::InvalidGateAccount);
            }
            let gate_balance = ctx.accounts.user_gate_account
                .as_ref()
                .map(|a| a.amount)
                .unwrap_or(0);
            // Current tier based on live gate balance. Must use the vault's configurable
            // thresholds (not the hardcoded constants) so update_tier_thresholds actually
            // affects withdrawal fees, matching the tier assignment logic in deposit().
            let current_tier_u8: u8 = if gate_balance >= v.gold_threshold { 0 }
                else if gate_balance >= v.silver_threshold { 1 }
                else if gate_balance >= v.bronze_threshold { 2 }
                else { 3 };
            // Use WORSE of current tier and snapshotted tier at deposit.
            // Prevents flash-borrowing gate tokens right before withdrawal to get a lower fee.
            let effective_tier = current_tier_u8.max(pos.tier_at_deposit);
            match effective_tier {
                0 => GOLD_FEE_BPS,
                1 => SILVER_FEE_BPS,
                2 => BRONZE_FEE_BPS,
                _ => STANDARD_FEE_BPS,
            }
        } else {
            STANDARD_FEE_BPS // no gate token active — standard fee rate when gating is disabled
        };

        // Whitelist check: waive fee entirely for whitelisted wallets
        let is_whitelisted = ctx.accounts.whitelist_entry.is_some();

        // Performance fee: only on profit, and only for non-whitelisted users
        let perf_fee = if is_whitelisted {
            0
        } else if amount_out > cost_basis {
            let profit = amount_out - cost_basis;
            profit.checked_mul(fee_bps)
                .and_then(|x| x.checked_div(BPS_DENOM))
                .unwrap_or(0)
        } else { 0 };

        let amount_after_fee = amount_out.saturating_sub(perf_fee);

        // Burn shares
        let vault_key = v.key();
        let signer_seeds: &[&[u8]] = &[b"vault", vault_key.as_ref(), &[v.authority_bump]];
        token::burn(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), Burn {
                mint:      ctx.accounts.shares_mint.to_account_info(),
                from:      ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            }),
            shares,
        )?;

        // Validate treasury account: must be OWNED by vault.treasury and use vault.mint.
        // Without the owner check, any user could pass their own token account as treasury
        // and steal the performance fee that belongs to the vault operator.
        //
        // BUG FIX: v.treasury stores the treasury WALLET address ("wallet that receives
        // performance fees" per InitVaultParams), not a specific token account's own
        // address — so this must check ownership, not exact account-key equality. The
        // old `.key() == v.treasury` check could never pass for any real treasury wallet
        // (their token account's address never equals their wallet address), meaning
        // performance-fee routing was structurally broken any time perf_fee > 0. This is
        // the same failure the team hit on SOL withdraws in earlier rounds (round 2/3).
        if let Some(treasury_acct) = ctx.accounts.treasury_token_account.as_ref() {
            require!(treasury_acct.mint == v.mint, VaultError::InvalidTreasuryAccount);
            require!(treasury_acct.owner == v.treasury, VaultError::TreasuryOwnerMismatch);
        }

        // Transfer perf fee → treasury (required when fee > 0)
        if perf_fee > 0 {
            let treasury_account = ctx.accounts.treasury_token_account.as_ref()
                .ok_or(VaultError::TreasuryRequired)?;
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from:      ctx.accounts.vault_token_account.to_account_info(),
                        to:        treasury_account.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    &[signer_seeds],
                ),
                perf_fee,
            )?;
        }

        // Transfer tokens from vault → user (vault authority signs)
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.vault_token_account.to_account_info(),
                    to:        ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount_after_fee,
        )?;

        // Update state.
        //
        // Subtract amount_out (the value that actually LEFT the vault), not cost_basis.
        //
        // The old comment here claimed "total_deposits tracks cost-basis (not vault balance)",
        // but nothing else in the program agrees with that:
        //   * recall's settle_recall ADDS realized yield to total_deposits, so it is not a
        //     cost basis the moment any yield is realized;
        //   * every deploy guard computes idle as `total_deposits - total_deployed()`, which
        //     is only meaningful if total_deposits is vault VALUE;
        //   * min_idle, the TVL cap, and the UI's share price all read it as value.
        // So value went IN via recall but only cost-basis came OUT here, and the difference was
        // stranded permanently.
        //
        // Observed live 2026-07-17: after withdrawing 100% of shares the USDC vault read
        // total_shares = 0 but total_deposits = 148 — precisely the realized yield, owned by
        // nobody. With shares at 0 the UI's `shares * total_deposits / total_shares` then
        // misprices the next depositor's position.
        //
        // The old comment's fear was backwards. Take A and B each depositing 5 (total_deposits
        // 10, shares 10) and 2 of yield realized (total_deposits 12). A withdraws 5 shares, so
        // amount_out = 5*12/10 = 6 and cost_basis = 5:
        //   subtract cost_basis -> total_deposits 7, shares 5 -> price 1.4, but the vault holds
        //                          only 6. B's position OVER-states, which is the actual hazard.
        //   subtract amount_out -> total_deposits 6, shares 5 -> price 1.2. Correct.
        // Subtracting amount_out cannot strand value and cannot over-credit the remaining holders.
        //
        // amount_out (gross), not amount_after_fee: perf_fee is transferred to the treasury just
        // above, so BOTH legs leave the vault and the vault's value drops by the full amount_out.
        //
        // Fees are unaffected: they are computed from pos.deposited_amount (the per-user basis),
        // never from total_deposits. cost_basis is still used for pos.deposited_amount below.
        //
        // saturating_sub is kept: a donation directly into vault_token_account can push real
        // value above the accounted total, making amount_out exceed total_deposits. Saturating is
        // the safe direction (MIN_FIRST_DEPOSIT is the actual donation-attack guard).
        v.total_deposits = v.total_deposits.saturating_sub(amount_out);
        v.total_shares   = v.total_shares.saturating_sub(shares);
        pos.shares           = pos.shares.saturating_sub(shares);
        pos.deposited_amount = pos.deposited_amount.saturating_sub(cost_basis);

        emit!(Withdrawn { vault: v.key(), user: ctx.accounts.user.key(), shares_burned: shares, amount_out: amount_after_fee, perf_fee });
        Ok(())
    }

    // ── Admin / keeper instructions ───────────────────────────────────────────

    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.vault.paused = paused;
        emit!(PauseToggled { vault: ctx.accounts.vault.key(), paused });
        Ok(())
    }

    // set_treasury, set_gate_mint, and set_tvl_cap are intentionally removed.
    //
    // treasury is fixed at vault initialization and cannot be redirected — this
    // guarantees fee destinations cannot be switched to steal user funds.
    //
    // gate_mint is fixed at initialization — access rules cannot be changed to
    // silently block all depositors after launch.
    //
    // tvl_cap can only increase, never decrease — admin cannot weaponize it to
    // block deposits after users have committed funds.
    pub fn raise_tvl_cap(ctx: Context<AdminOnly>, new_cap: u64) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        require!(new_cap > v.tvl_cap, VaultError::TvlCapTooLow);
        v.tvl_cap = new_cap;
        Ok(())
    }

    pub fn set_keeper(ctx: Context<AdminOnly>, new_keeper: Pubkey) -> Result<()> {
        ctx.accounts.vault.keeper = new_keeper;
        Ok(())
    }

    /// Change where performance fees are routed.
    ///
    /// WHY THIS EXISTS: `treasury` was previously written once in `initialize_vault` and
    /// had no setter, making it immutable for the life of a vault. Round 8 shipped with
    /// `treasury == admin` on both vaults, which meant (a) fee revenue accrued to the same
    /// wallet that holds the upgrade authority and the deploy SOL, and (b) the perf-fee
    /// routing fixed in PR #64 could never be VERIFIED — the fee and the user's payout
    /// landed in the same account, so the two were indistinguishable. Fixing that required
    /// this instruction, hence the upgrade.
    ///
    /// One-step, unlike the admin handover (`propose_admin`/`accept_admin`): a wrong
    /// treasury is recoverable — the admin simply calls this again — whereas a wrong admin
    /// is permanent loss of control. It is NOT harmless, though: `withdraw()` enforces
    /// `treasury_acct.owner == v.treasury` and refuses to pay out when a non-zero fee has
    /// nowhere to go (`TreasuryRequired`), so pointing this at an address whose token
    /// account doesn't exist BRICKS every PROFITABLE withdrawal until it's corrected.
    /// Principal-only withdrawals (perf_fee == 0) are unaffected. Set this to a wallet you
    /// control and create its ATA for the vault's mint before any profitable withdrawal.
    pub fn set_treasury(ctx: Context<AdminOnly>, new_treasury: Pubkey) -> Result<()> {
        // system_program::ID is this codebase's "unset" sentinel — it IS Pubkey::default()
        // (32 zero bytes), and gate_mint uses it the same way. Accepting it here would
        // silently point fees at an address nobody controls and brick profitable
        // withdrawals, so reject it rather than allow a treasury to be "unset".
        require!(
            new_treasury != anchor_lang::solana_program::system_program::ID,
            VaultError::InvalidTreasury
        );
        // No-op guard: re-setting the same treasury is pointless but harmless; allow it
        // rather than error, so idempotent admin scripts don't need special-casing.
        ctx.accounts.vault.treasury = new_treasury;
        Ok(())
    }

    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.vault.pending_admin = new_admin;
        Ok(())
    }

    pub fn emergency_close(ctx: Context<EmergencyClose>) -> Result<()> {
        // SECURITY: vault must be empty. Without this, admin could delete a live vault's
        // share/position bookkeeping while user funds remain stranded in vault_token_account.
        require!(ctx.accounts.vault.total_shares == 0, VaultError::VaultNotEmpty);
        // Drain lamports back to admin
        let vault_info = ctx.accounts.vault.to_account_info();
        let admin_info = ctx.accounts.admin.to_account_info();
        let lamports = vault_info.lamports();
        **vault_info.try_borrow_mut_lamports()? -= lamports;
        **admin_info.try_borrow_mut_lamports()? += lamports;
        vault_info.assign(&anchor_lang::solana_program::system_program::ID);
        vault_info.realloc(0, false)?;
        Ok(())
    }

    pub fn close_vault(ctx: Context<CloseVault>) -> Result<()> {
        let vault = &ctx.accounts.vault;
        require!(vault.total_shares == 0, VaultError::VaultNotEmpty);
        Ok(())
    }

    pub fn set_gate_mint(ctx: Context<AdminOnly>, gate_mint: Pubkey) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        require!(
            v.gate_mint == anchor_lang::solana_program::system_program::ID,
            VaultError::GateMintAlreadySet
        );
        v.gate_mint = gate_mint;
        Ok(())
    }

    pub fn update_tier_thresholds(ctx: Context<UpdateTierThresholds>, gold: u64, silver: u64, bronze: u64) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        let now = Clock::get()?.unix_timestamp;
        require!(
            now - v.last_threshold_update_ts >= TIER_THRESHOLD_COOLDOWN_SECS,
            VaultError::ThresholdCooldownActive
        );
        v.gold_threshold = gold;
        v.silver_threshold = silver;
        v.bronze_threshold = bronze;
        v.last_threshold_update_ts = now;
        Ok(())
    }

    pub fn add_to_whitelist(ctx: Context<AddToWhitelist>, _wallet: Pubkey) -> Result<()> {
        ctx.accounts.whitelist_entry.bump = ctx.bumps.whitelist_entry;
        Ok(())
    }

    pub fn remove_from_whitelist(_ctx: Context<RemoveFromWhitelist>, _wallet: Pubkey) -> Result<()> {
        Ok(())
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        require!(v.pending_admin != Pubkey::default(), VaultError::NoPendingAdmin);
        require!(v.pending_admin == ctx.accounts.new_admin.key(), VaultError::NotPendingAdmin);
        v.admin = ctx.accounts.new_admin.key();
        v.pending_admin = Pubkey::default();
        Ok(())
    }

    // update_settings controls only operational behaviour — no financial parameters.
    pub fn update_settings(
        ctx: Context<AdminOnly>,
        auto_compound: bool,
        auto_rebalance: bool,
    ) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        v.auto_compound  = auto_compound;
        v.auto_rebalance = auto_rebalance;
        Ok(())
    }

    pub fn rebalance(ctx: Context<KeeperOnly>, new_allocations: Vec<u64>) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        require!(!v.paused, AdapterError::VaultPaused);
        require!(new_allocations.len() == v.protocol_count as usize, VaultError::AllocationMismatch);
        let total: u64 = new_allocations.iter().sum();
        require!(total == BPS_DENOM, VaultError::AllocationNotFull);
        for (i, &bps) in new_allocations.iter().enumerate() {
            v.protocols[i].target_bps = bps;
        }
        emit!(Rebalanced { vault: v.key(), allocations: new_allocations, ts: Clock::get()?.unix_timestamp });
        Ok(())
    }

    pub fn compound(ctx: Context<KeeperOnly>) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        require!(!v.paused, AdapterError::VaultPaused);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= v.last_compound_ts + COMPOUND_INTERVAL, VaultError::CompoundTooEarly);
        v.last_compound_ts = now;
        emit!(Compounded { vault: v.key(), ts: now });
        Ok(())
    }

    /// Snap total_deposits back to what the vault ACTUALLY holds: idle + deployed principal.
    ///
    /// WHY THIS IS SAFE TO EXPOSE (and could even be permissionless): it writes NOTHING it
    /// doesn't already read from THIS vault's own on-chain state — the vault_token_account
    /// balance and total_deployed(), both of which any instruction here already trusts. It
    /// does NOT decode Kamino/Marinade/Jito state, does NOT read an exchange rate, invents
    /// no number. So it cannot over-value a share: the value it computes is the same
    /// conservative floor withdraw() already uses (see the long note in withdraw() — "idle +
    /// total_deployed is a conservative floor... it never over-values a share, so it can
    /// never drain the vault"). It can only ever make total_deposits MORE accurate.
    ///
    /// WHAT IT FIXES: withdraw() subtracts amount_out and recall books realized gains/losses,
    /// but rounding and the historical cost-basis bug can leave total_deposits drifted a few
    /// units off the real (idle + deployed) value — "orphaned" accounting with no funds
    /// behind it. Observed live 2026-07-17: after a full withdrawal the USDC vault read
    /// total_shares = 0 with total_deposits = 148. Because the UI prices positions as
    /// shares * total_deposits / total_shares, that drift misprices the next depositor.
    /// reconcile() clears it and makes the accounting self-healing against any future drift.
    ///
    /// Kept KeeperOnly (not permissionless) only for symmetry with compound/rebalance and to
    /// keep the admin surface legible; there is no security reason it must be gated, since it
    /// can only move total_deposits toward the truth. Allowed while paused: reconciling a
    /// halted vault is strictly safe and may be exactly what an operator wants mid-incident.
    pub fn reconcile(ctx: Context<Reconcile>) -> Result<()> {
        let idle = ctx.accounts.vault_token_account.amount;
        let v = &mut ctx.accounts.vault;
        require!(
            ctx.accounts.vault_token_account.key() == v.vault_token_account,
            VaultError::InvalidTokenAccount
        );
        let true_value = idle
            .checked_add(v.total_deployed())
            .ok_or(VaultError::MathOverflow)?;
        let old = v.total_deposits;
        v.total_deposits = true_value;
        emit!(Reconciled { vault: v.key(), old_total_deposits: old, new_total_deposits: true_value });
        Ok(())
    }

    // ── Protocol deployment ───────────────────────────────────────────────────

    pub fn deploy_to_kamino<'info>(
        ctx: Context<'_, '_, '_, 'info, DeployToKamino<'info>>,
        protocol_index: u8,
        amount: u64,
    ) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        require!(v.keeper == ctx.accounts.keeper.key(), VaultError::Unauthorized);
        require!(!v.paused, AdapterError::VaultPaused);
        require!(amount > 0, VaultError::ZeroAmount);
        let idx = protocol_index as usize;
        require!(idx < v.protocol_count as usize, VaultError::InvalidProtocolIndex);
        require!(v.protocols[idx].kind == ProtocolKind::Kamino, AdapterError::UnsupportedProtocol);
        assert_state_matches(&v.protocols[idx], ctx.accounts.kamino_reserve.key)?;
        // SECURITY: validate collateral receipt account matches the one registered for this protocol.
        // Without this, an admin could accidentally (or maliciously) route collateral tokens elsewhere.
        require!(
            ctx.accounts.vault_collateral_account.key() == v.protocols[idx].vault_receipt_account,
            VaultError::InvalidTokenAccount
        );

        let idle = v.total_deposits.saturating_sub(v.total_deployed());
        // Enforce minimum idle buffer: keeper cannot deploy funds if doing so would leave
        // less than MIN_IDLE_BPS (10%) of total deposits idle. This guarantees users can
        // always withdraw at least 10% of vault TVL without waiting for a recall.
        let min_idle = v.total_deposits
            .checked_mul(MIN_IDLE_BPS)
            .and_then(|x| x.checked_div(BPS_DENOM))
            .unwrap_or(0);
        require!(idle.saturating_sub(amount) >= min_idle, VaultError::InsufficientIdle);

        let vault_key = v.key();
        let seeds: &[&[u8]] = &[b"vault", vault_key.as_ref(), &[v.authority_bump]];

        kamino_deposit(
            CpiContext::new_with_signer(
                ctx.accounts.kamino_program.to_account_info(),
                KaminoDeposit {
                    vault_authority:                ctx.accounts.vault_authority.to_account_info(),
                    kamino_reserve:                 ctx.accounts.kamino_reserve.to_account_info(),
                    kamino_lending_market:          ctx.accounts.kamino_lending_market.to_account_info(),
                    kamino_lending_market_authority: ctx.accounts.kamino_market_authority.to_account_info(),
                    reserve_liquidity_mint:         ctx.accounts.kamino_liquidity_mint.to_account_info(),
                    kamino_reserve_liquidity_supply: ctx.accounts.kamino_liquidity_supply.to_account_info(),
                    kamino_collateral_mint:         ctx.accounts.kamino_collateral_mint.to_account_info(),
                    vault_token_account:            ctx.accounts.vault_token_account.clone(),
                    vault_collateral_account:       ctx.accounts.vault_collateral_account.clone(),
                    collateral_token_program:       ctx.accounts.token_program.to_account_info(),
                    liquidity_token_program:        ctx.accounts.token_program.clone(),
                    instruction_sysvar:             ctx.accounts.instruction_sysvar.to_account_info(),
                    kamino_program:                 ctx.accounts.kamino_program.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            seeds,
            ctx.remaining_accounts, // Pyth oracle accounts
        )?;

        v.protocols[idx].deployed_balance = v.protocols[idx].deployed_balance
            .checked_add(amount).ok_or(VaultError::MathOverflow)?;

        emit!(FundsDeployed { vault: v.key(), protocol_index, amount });
        Ok(())
    }

    pub fn recall_from_kamino<'info>(
        ctx: Context<'_, '_, '_, 'info, RecallFromKamino<'info>>,
        protocol_index: u8,
        collateral_amount: u64,
    ) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        if v.keeper != ctx.accounts.keeper.key() {
            verify_paired_withdraw(
                &ctx.accounts.tx_instructions_sysvar.to_account_info(),
                &v.key(),
                &ctx.accounts.keeper.key(),
            )?;
        }
        let idx = protocol_index as usize;
        require!(idx < v.protocol_count as usize, VaultError::InvalidProtocolIndex);
        require!(v.protocols[idx].kind == ProtocolKind::Kamino, AdapterError::UnsupportedProtocol);
        assert_state_matches(&v.protocols[idx], ctx.accounts.kamino_reserve.key)?;
        // SECURITY: validate collateral account matches registry
        require!(
            ctx.accounts.vault_collateral_account.key() == v.protocols[idx].vault_receipt_account,
            VaultError::InvalidTokenAccount
        );
        // Note: we do NOT check collateral_amount <= deployed_balance here because deployed_balance
        // tracks underlying tokens deposited, while collateral_amount is in kTokens (cTokens). These
        // are not 1:1 — kToken value increases as yield accrues. Kamino's own program enforces that
        // the vault's collateral account has sufficient balance; we trust that CPI to validate amount.

        let vault_key = v.key();
        let seeds: &[&[u8]] = &[b"vault", vault_key.as_ref(), &[v.authority_bump]];

        let underlying_before = ctx.accounts.vault_token_account.amount;

        kamino_withdraw(
            CpiContext::new_with_signer(
                ctx.accounts.kamino_program.to_account_info(),
                KaminoWithdraw {
                    vault_authority:                ctx.accounts.vault_authority.to_account_info(),
                    kamino_lending_market:          ctx.accounts.kamino_lending_market.to_account_info(),
                    kamino_reserve:                 ctx.accounts.kamino_reserve.to_account_info(),
                    kamino_lending_market_authority: ctx.accounts.kamino_market_authority.to_account_info(),
                    reserve_liquidity_mint:         ctx.accounts.kamino_liquidity_mint.to_account_info(),
                    kamino_collateral_mint:         ctx.accounts.kamino_collateral_mint.to_account_info(),
                    kamino_reserve_liquidity_supply: ctx.accounts.kamino_liquidity_supply.to_account_info(),
                    vault_collateral_account:       ctx.accounts.vault_collateral_account.clone(),
                    vault_token_account:            ctx.accounts.vault_token_account.clone(),
                    collateral_token_program:       ctx.accounts.token_program.to_account_info(),
                    liquidity_token_program:        ctx.accounts.token_program.clone(),
                    instruction_sysvar:             ctx.accounts.instruction_sysvar.to_account_info(),
                    kamino_program:                 ctx.accounts.kamino_program.to_account_info(),
                },
                &[seeds],
            ),
            collateral_amount,
            seeds,
            ctx.remaining_accounts,
        )?;

        // Real underlying returned may exceed what's recorded as deployed (kToken
        // value grows as yield accrues) — realize that excess into total_deposits
        // instead of silently discarding it. deployed_balance was previously
        // decremented by collateral_amount (kToken units), a unit mismatch against
        // its own underlying-token accounting.
        ctx.accounts.vault_token_account.reload()?;
        let received = ctx.accounts.vault_token_account.amount.saturating_sub(underlying_before);
        // Reload the RECEIPT account before settling: whether we still hold receipt units
        // is the only thing that distinguishes "partially recalled, remainder still
        // deployed" from "fully exited, and the shortfall is a fee we already paid".
        // `.amount` here is still the PRE-CPI balance (reload not yet called) — capture
        // it as receipt_before so settle_recall can size the recall proportionally.
        let receipt_before = ctx.accounts.vault_collateral_account.amount;
        ctx.accounts.vault_collateral_account.reload()?;
        let receipt_remaining = ctx.accounts.vault_collateral_account.amount;
        settle_recall(v, idx, received, receipt_before, receipt_remaining)?;

        emit!(FundsRecalled { vault: v.key(), protocol_index, collateral_amount });
        Ok(())
    }

    pub fn deploy_to_marinade(
        ctx: Context<DeployToMarinade>,
        protocol_index: u8,
        lamports: u64,
    ) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        require!(!v.paused, AdapterError::VaultPaused);
        require!(lamports > 0, VaultError::ZeroAmount);
        let idx = protocol_index as usize;
        require!(idx < v.protocol_count as usize, VaultError::InvalidProtocolIndex);
        require!(v.protocols[idx].kind == ProtocolKind::Marinade, AdapterError::UnsupportedProtocol);
        assert_state_matches(&v.protocols[idx], ctx.accounts.marinade_state.key)?;
        // SECURITY: validate the mSOL receipt account matches the one registered for
        // this protocol index. Without this, a compromised keeper could redirect the
        // mSOL minted by this deposit to an account they control — the real SOL still
        // leaves the vault, but the vault's actual claim on it (the mSOL) never lands
        // in vault_msol_account, silently draining value while deployed_balance still
        // looks correct. Same protection deploy_to_kamino already has; this and the
        // other two protocol adapters (Solend, SPL Stake Pool) were missing it.
        require!(
            ctx.accounts.vault_msol_account.key() == v.protocols[idx].vault_receipt_account,
            VaultError::InvalidTokenAccount
        );

        // SECURITY: enforce the same minimum idle liquidity buffer as deploy_to_kamino,
        // so this protocol can't be used to deploy 100% of funds and block withdrawals.
        let idle = v.total_deposits.saturating_sub(v.total_deployed());
        let min_idle = v.total_deposits
            .checked_mul(MIN_IDLE_BPS)
            .and_then(|x| x.checked_div(BPS_DENOM))
            .unwrap_or(0);
        require!(idle.saturating_sub(lamports) >= min_idle, VaultError::InsufficientIdle);

        let vault_key = v.key();
        let seeds: &[&[u8]] = &[b"vault", vault_key.as_ref(), &[v.authority_bump]];

        // ── Unwrap: Marinade's deposit_sol needs NATIVE SOL, but the vault's
        // idle balance is held as wrapped SOL (an SPL token). SPL Token's
        // Transfer instruction doesn't move real lamports for any mint
        // (including native) — only CloseAccount does, and it drains the
        // WHOLE account. So: close the account entirely (all its lamports
        // land as native SOL on vault_authority), do the Marinade deposit,
        // then recreate the same account and re-wrap whatever's left over.
        // This whole sequence is one atomic instruction — if any step fails,
        // Solana reverts everything, so there's no possibility of ending up
        // half-unwrapped.
        let total_idle = ctx.accounts.vault_token_account.amount;
        require!(total_idle >= lamports, VaultError::InsufficientIdle);
        let remainder = total_idle - lamports;

        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account:     ctx.accounts.vault_token_account.to_account_info(),
                destination: ctx.accounts.vault_authority.to_account_info(),
                authority:   ctx.accounts.vault_authority.to_account_info(),
            },
            &[seeds],
        ))?;

        marinade_deposit(
            CpiContext::new_with_signer(
                ctx.accounts.marinade_program.to_account_info(),
                MarinadeDeposit {
                    vault_authority:            ctx.accounts.vault_authority.to_account_info(),
                    marinade_state:             ctx.accounts.marinade_state.to_account_info(),
                    msol_mint:                  (*ctx.accounts.msol_mint).clone(),
                    liq_pool_sol_leg:           ctx.accounts.liq_pool_sol_leg.to_account_info(),
                    liq_pool_msol_leg:          (*ctx.accounts.liq_pool_msol_leg).clone(),
                    liq_pool_msol_leg_authority:ctx.accounts.liq_pool_msol_leg_authority.to_account_info(),
                    reserve_pda:                ctx.accounts.reserve_pda.to_account_info(),
                    vault_msol_account:         (*ctx.accounts.vault_msol_account).clone(),
                    msol_mint_authority:        ctx.accounts.msol_mint_authority.to_account_info(),
                    system_program:             ctx.accounts.system_program.clone(),
                    token_program:              ctx.accounts.token_program.clone(),
                    marinade_program:           ctx.accounts.marinade_program.to_account_info(),
                },
                &[seeds],
            ),
            lamports,
            seeds,
        )?;

        // ── Recreate the vault's WSOL account at the same (deterministic ATA)
        // address, then re-wrap the leftover idle balance into it.
        associated_token::create(CpiContext::new_with_signer(
            ctx.accounts.associated_token_program.to_account_info(),
            Create {
                payer:            ctx.accounts.vault_authority.to_account_info(),
                associated_token: ctx.accounts.vault_token_account.to_account_info(),
                authority:        ctx.accounts.vault_authority.to_account_info(),
                mint:             ctx.accounts.wsol_mint.to_account_info(),
                system_program:   ctx.accounts.system_program.to_account_info(),
                token_program:    ctx.accounts.token_program.to_account_info(),
            },
            &[seeds],
        ))?;

        if remainder > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    SystemTransfer {
                        from: ctx.accounts.vault_authority.to_account_info(),
                        to:   ctx.accounts.vault_token_account.to_account_info(),
                    },
                    &[seeds],
                ),
                remainder,
            )?;
            token::sync_native(CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                SyncNative { account: ctx.accounts.vault_token_account.to_account_info() },
            ))?;
        }

        v.protocols[idx].deployed_balance = v.protocols[idx].deployed_balance
            .checked_add(lamports).ok_or(VaultError::MathOverflow)?;

        emit!(FundsDeployed { vault: v.key(), protocol_index, amount: lamports });
        Ok(())
    }

    pub fn recall_from_marinade(
        ctx: Context<RecallFromMarinade>,
        protocol_index: u8,
        msol_amount: u64,
    ) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        if v.keeper != ctx.accounts.keeper.key() {
            verify_paired_withdraw(
                &ctx.accounts.tx_instructions_sysvar.to_account_info(),
                &v.key(),
                &ctx.accounts.keeper.key(),
            )?;
        }
        let idx = protocol_index as usize;
        require!(idx < v.protocol_count as usize, VaultError::InvalidProtocolIndex);
        require!(v.protocols[idx].kind == ProtocolKind::Marinade, AdapterError::UnsupportedProtocol);
        assert_state_matches(&v.protocols[idx], ctx.accounts.marinade_state.key)?;
        // SECURITY: same registry check as deploy_to_marinade — burn mSOL from the
        // registered account, not an arbitrary one the keeper supplies.
        require!(
            ctx.accounts.vault_msol_account.key() == v.protocols[idx].vault_receipt_account,
            VaultError::InvalidTokenAccount
        );

        let vault_key = v.key();
        let seeds: &[&[u8]] = &[b"vault", vault_key.as_ref(), &[v.authority_bump]];

        // Measure native SOL received by vault_authority across the CPI (the
        // exact amount depends on Marinade's live exchange rate, not known
        // in advance) so we know exactly how much to wrap back into the
        // vault's WSOL account afterward.
        let lamports_before = ctx.accounts.vault_authority.lamports();

        marinade_liquid_unstake(
            CpiContext::new_with_signer(
                ctx.accounts.marinade_program.to_account_info(),
                MarinadeUnstake {
                    vault_authority:        ctx.accounts.vault_authority.to_account_info(),
                    marinade_state:         ctx.accounts.marinade_state.to_account_info(),
                    msol_mint:              (*ctx.accounts.msol_mint).clone(),
                    liq_pool_sol_leg:       ctx.accounts.liq_pool_sol_leg.to_account_info(),
                    liq_pool_msol_leg:      (*ctx.accounts.liq_pool_msol_leg).clone(),
                    treasury_msol_account:  (*ctx.accounts.treasury_msol_account).clone(),
                    vault_msol_account:     (*ctx.accounts.vault_msol_account).clone(),
                    transfer_sol_to:        ctx.accounts.vault_authority.to_account_info(),
                    system_program:         ctx.accounts.system_program.clone(),
                    token_program:          ctx.accounts.token_program.clone(),
                    marinade_program:       ctx.accounts.marinade_program.to_account_info(),
                },
                &[seeds],
            ),
            msol_amount,
            seeds,
        )?;

        let received = ctx.accounts.vault_authority.lamports().saturating_sub(lamports_before);

        // ── Wrap the received native SOL back into the vault's WSOL account.
        // No close/recreate needed here — the account is already open, this
        // is just topping it up.
        if received > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    SystemTransfer {
                        from: ctx.accounts.vault_authority.to_account_info(),
                        to:   ctx.accounts.vault_token_account.to_account_info(),
                    },
                    &[seeds],
                ),
                received,
            )?;
            token::sync_native(CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                SyncNative { account: ctx.accounts.vault_token_account.to_account_info() },
            ))?;
        }

        // received (real underlying SOL, computed above from the lamports diff
        // around the CPI) may exceed what's recorded as deployed — kToken-style
        // exchange-rate growth from accrued yield. Realize the excess into
        // total_deposits instead of discarding it. Previously decremented by
        // msol_amount (mSOL units), a unit mismatch against underlying-token
        // accounting.
        // Reload the RECEIPT account before settling: whether we still hold receipt units
        // is the only thing that distinguishes "partially recalled, remainder still
        // deployed" from "fully exited, and the shortfall is a fee we already paid".
        // `.amount` here is still the PRE-CPI balance (reload not yet called) — capture
        // it as receipt_before so settle_recall can size the recall proportionally.
        let receipt_before = ctx.accounts.vault_msol_account.amount;
        ctx.accounts.vault_msol_account.reload()?;
        let receipt_remaining = ctx.accounts.vault_msol_account.amount;
        settle_recall(v, idx, received, receipt_before, receipt_remaining)?;

        emit!(FundsRecalled { vault: v.key(), protocol_index, collateral_amount: msol_amount });
        Ok(())
    }

    /// Deposit SOL into an SPL Stake Pool (Jito) and receive LST tokens.
    pub fn deploy_to_sol_lst(
        ctx: Context<DeployToSolLst>,
        protocol_index: u8,
        lamports: u64,
    ) -> Result<()> {
        require!(lamports > 0, VaultError::ZeroAmount);
        let v = &mut ctx.accounts.vault;
        require!(!v.paused, AdapterError::VaultPaused);
        let idx = protocol_index as usize;
        require!(idx < v.protocol_count as usize, VaultError::InvalidProtocolIndex);
        require!(v.protocols[idx].kind == ProtocolKind::Jito, AdapterError::UnsupportedProtocol);
        // SECURITY: validate the stake pool passed matches what's registered for this
        // index — same check every other protocol (Kamino/Marinade/Solend) already has.
        assert_state_matches(&v.protocols[idx], ctx.accounts.stake_pool.key)?;
        // SECURITY: validate the LST receipt account matches the one registered for
        // this protocol index — same reasoning as deploy_to_marinade's equivalent
        // check (without it, a compromised keeper could redirect the jitoSOL minted
        // by this deposit to an account they control).
        require!(
            ctx.accounts.vault_lst_account.key() == v.protocols[idx].vault_receipt_account,
            VaultError::InvalidTokenAccount
        );

        // SECURITY: enforce the same minimum idle liquidity buffer as deploy_to_kamino,
        // so this protocol can't be used to deploy 100% of funds and block withdrawals.
        let idle = v.total_deposits.saturating_sub(v.total_deployed());
        let min_idle = v.total_deposits
            .checked_mul(MIN_IDLE_BPS)
            .and_then(|x| x.checked_div(BPS_DENOM))
            .unwrap_or(0);
        require!(idle.saturating_sub(lamports) >= min_idle, VaultError::InsufficientIdle);

        let vault_key = v.key();
        let seeds: &[&[u8]] = &[b"vault", vault_key.as_ref(), &[v.authority_bump]];

        // ── Unwrap (same pattern as deploy_to_marinade — see its comments for
        // the full explanation): SPL Stake Pool's DepositSol needs native SOL,
        // but the vault holds it as wrapped SOL. Close the WSOL account fully,
        // deposit into the stake pool, recreate the account, re-wrap the rest.
        // All atomic — any failure reverts the whole thing.
        let total_idle = ctx.accounts.vault_token_account.amount;
        require!(total_idle >= lamports, VaultError::InsufficientIdle);
        let remainder = total_idle - lamports;

        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account:     ctx.accounts.vault_token_account.to_account_info(),
                destination: ctx.accounts.vault_authority.to_account_info(),
                authority:   ctx.accounts.vault_authority.to_account_info(),
            },
            &[seeds],
        ))?;

        spl_stake_pool_deposit(
            CpiContext::new_with_signer(
                ctx.accounts.stake_pool_program.to_account_info(),
                SplStakePoolDeposit {
                    vault_authority:      ctx.accounts.vault_authority.to_account_info(),
                    vault_lst_account:    (*ctx.accounts.vault_lst_account).clone(),
                    stake_pool:           ctx.accounts.stake_pool.to_account_info(),
                    withdraw_authority:   ctx.accounts.withdraw_authority.to_account_info(),
                    reserve_stake:        ctx.accounts.reserve_stake.to_account_info(),
                    manager_fee_account:  (*ctx.accounts.manager_fee_account).clone(),
                    pool_mint:            (*ctx.accounts.pool_mint).clone(),
                    clock_sysvar:         ctx.accounts.clock_sysvar.to_account_info(),
                    stake_history_sysvar: ctx.accounts.stake_history_sysvar.to_account_info(),
                    system_program:       ctx.accounts.system_program.clone(),
                    token_program:        ctx.accounts.token_program.clone(),
                    stake_pool_program:   ctx.accounts.stake_pool_program.to_account_info(),
                },
                &[seeds],
            ),
            lamports,
            seeds,
        )?;

        associated_token::create(CpiContext::new_with_signer(
            ctx.accounts.associated_token_program.to_account_info(),
            Create {
                payer:            ctx.accounts.vault_authority.to_account_info(),
                associated_token: ctx.accounts.vault_token_account.to_account_info(),
                authority:        ctx.accounts.vault_authority.to_account_info(),
                mint:             ctx.accounts.wsol_mint.to_account_info(),
                system_program:   ctx.accounts.system_program.to_account_info(),
                token_program:    ctx.accounts.token_program.to_account_info(),
            },
            &[seeds],
        ))?;

        if remainder > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    SystemTransfer {
                        from: ctx.accounts.vault_authority.to_account_info(),
                        to:   ctx.accounts.vault_token_account.to_account_info(),
                    },
                    &[seeds],
                ),
                remainder,
            )?;
            token::sync_native(CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                SyncNative { account: ctx.accounts.vault_token_account.to_account_info() },
            ))?;
        }

        v.protocols[idx].deployed_balance = v.protocols[idx].deployed_balance
            .checked_add(lamports).ok_or(VaultError::MathOverflow)?;

        emit!(FundsDeployed { vault: v.key(), protocol_index, amount: lamports });
        Ok(())
    }

    /// Burn LST tokens to withdraw SOL from an SPL Stake Pool (Jito).
    pub fn recall_from_sol_lst(
        ctx: Context<RecallFromSolLst>,
        protocol_index: u8,
        lst_amount: u64,
    ) -> Result<()> {
        require!(lst_amount > 0, VaultError::ZeroAmount);
        let v = &mut ctx.accounts.vault;
        if v.keeper != ctx.accounts.keeper.key() {
            verify_paired_withdraw(
                &ctx.accounts.tx_instructions_sysvar.to_account_info(),
                &v.key(),
                &ctx.accounts.keeper.key(),
            )?;
        }
        let idx = protocol_index as usize;
        require!(idx < v.protocol_count as usize, VaultError::InvalidProtocolIndex);
        require!(v.protocols[idx].kind == ProtocolKind::Jito, AdapterError::UnsupportedProtocol);
        // SECURITY: validate the stake pool passed matches what's registered for this
        // index — same check every other protocol (Kamino/Marinade/Solend) already has.
        assert_state_matches(&v.protocols[idx], ctx.accounts.stake_pool.key)?;
        // SECURITY: same registry check as deploy_to_sol_lst — burn LST from the
        // registered account, not an arbitrary one the keeper supplies.
        require!(
            ctx.accounts.vault_lst_account.key() == v.protocols[idx].vault_receipt_account,
            VaultError::InvalidTokenAccount
        );

        let vault_key = v.key();
        let seeds: &[&[u8]] = &[b"vault", vault_key.as_ref(), &[v.authority_bump]];

        let lamports_before = ctx.accounts.vault_authority.lamports();

        spl_stake_pool_withdraw(
            CpiContext::new_with_signer(
                ctx.accounts.stake_pool_program.to_account_info(),
                SplStakePoolWithdraw {
                    vault_authority:      ctx.accounts.vault_authority.to_account_info(),
                    vault_lst_account:    (*ctx.accounts.vault_lst_account).clone(),
                    stake_pool:           ctx.accounts.stake_pool.to_account_info(),
                    withdraw_authority:   ctx.accounts.withdraw_authority.to_account_info(),
                    reserve_stake:        ctx.accounts.reserve_stake.to_account_info(),
                    manager_fee_account:  (*ctx.accounts.manager_fee_account).clone(),
                    pool_mint:            (*ctx.accounts.pool_mint).clone(),
                    clock_sysvar:         ctx.accounts.clock_sysvar.to_account_info(),
                    stake_history_sysvar: ctx.accounts.stake_history_sysvar.to_account_info(),
                    stake_program:        ctx.accounts.stake_program.to_account_info(),
                    token_program:        ctx.accounts.token_program.clone(),
                    stake_pool_program:   ctx.accounts.stake_pool_program.to_account_info(),
                },
                &[seeds],
            ),
            lst_amount,
            seeds,
        )?;

        // Wrap the received native SOL back into the vault's WSOL account —
        // same pattern as recall_from_marinade.
        let received = ctx.accounts.vault_authority.lamports().saturating_sub(lamports_before);
        if received > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    SystemTransfer {
                        from: ctx.accounts.vault_authority.to_account_info(),
                        to:   ctx.accounts.vault_token_account.to_account_info(),
                    },
                    &[seeds],
                ),
                received,
            )?;
            token::sync_native(CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                SyncNative { account: ctx.accounts.vault_token_account.to_account_info() },
            ))?;
        }

        // Same unit-mismatch fix as recall_from_marinade — see its comments.
        // Reload the RECEIPT account before settling: whether we still hold receipt units
        // is the only thing that distinguishes "partially recalled, remainder still
        // deployed" from "fully exited, and the shortfall is a fee we already paid".
        // `.amount` here is still the PRE-CPI balance (reload not yet called) — capture
        // it as receipt_before so settle_recall can size the recall proportionally.
        let receipt_before = ctx.accounts.vault_lst_account.amount;
        ctx.accounts.vault_lst_account.reload()?;
        let receipt_remaining = ctx.accounts.vault_lst_account.amount;
        settle_recall(v, idx, received, receipt_before, receipt_remaining)?;

        emit!(FundsRecalled { vault: v.key(), protocol_index, collateral_amount: lst_amount });
        Ok(())
    }

    /// Deposit tokens into Solend, receive cTokens.
    pub fn deploy_to_solend(
        ctx: Context<DeployToSolend>,
        protocol_index: u8,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        let v = &mut ctx.accounts.vault;
        require!(!v.paused, AdapterError::VaultPaused);
        let idx = protocol_index as usize;
        require!(idx < v.protocol_count as usize, VaultError::InvalidProtocolIndex);
        require!(v.protocols[idx].kind == ProtocolKind::Solend, AdapterError::UnsupportedProtocol);
        // SECURITY: deploy_to_solend was missing BOTH checks every other protocol has —
        // the reserve wasn't validated against the registry at all, and neither was the
        // cToken receipt destination. Without the first, a compromised keeper could
        // deposit into an arbitrary Solend reserve instead of the registered one
        // (deployed_balance would then track the wrong market). Without the second,
        // same fund-diversion risk as deploy_to_marinade/deploy_to_sol_lst above — the
        // minted cTokens could be redirected to an account the keeper controls while
        // the real USDC still leaves the vault.
        assert_state_matches(&v.protocols[idx], ctx.accounts.reserve.key)?;
        require!(
            ctx.accounts.vault_collateral_account.key() == v.protocols[idx].vault_receipt_account,
            VaultError::InvalidTokenAccount
        );

        // SECURITY: enforce the same minimum idle liquidity buffer as deploy_to_kamino,
        // so this protocol can't be used to deploy 100% of funds and block withdrawals.
        let idle = v.total_deposits.saturating_sub(v.total_deployed());
        let min_idle = v.total_deposits
            .checked_mul(MIN_IDLE_BPS)
            .and_then(|x| x.checked_div(BPS_DENOM))
            .unwrap_or(0);
        require!(idle.saturating_sub(amount) >= min_idle, VaultError::InsufficientIdle);

        let vault_key = v.key();
        let seeds: &[&[u8]] = &[b"vault", vault_key.as_ref(), &[v.authority_bump]];

        solend_deposit(
            CpiContext::new_with_signer(
                ctx.accounts.solend_program.to_account_info(),
                SolendDeposit {
                    vault_authority:          ctx.accounts.vault_authority.to_account_info(),
                    vault_token_account:      (*ctx.accounts.vault_token_account).clone(),
                    vault_collateral_account: (*ctx.accounts.vault_collateral_account).clone(),
                    reserve:                  ctx.accounts.reserve.to_account_info(),
                    reserve_liquidity_supply: ctx.accounts.reserve_liquidity_supply.to_account_info(),
                    reserve_collateral_mint:  (*ctx.accounts.reserve_collateral_mint).clone(),
                    lending_market:           ctx.accounts.lending_market.to_account_info(),
                    lending_market_authority: ctx.accounts.lending_market_authority.to_account_info(),
                    pyth_oracle:              ctx.accounts.pyth_oracle.to_account_info(),
                    switchboard_oracle:       ctx.accounts.switchboard_oracle.to_account_info(),
                    clock_sysvar:             ctx.accounts.clock_sysvar.to_account_info(),
                    token_program:            ctx.accounts.token_program.clone(),
                    solend_program:           ctx.accounts.solend_program.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            seeds,
        )?;

        v.protocols[idx].deployed_balance = v.protocols[idx].deployed_balance
            .checked_add(amount).ok_or(VaultError::MathOverflow)?;
        emit!(FundsDeployed { vault: v.key(), protocol_index, amount });
        Ok(())
    }

    /// Redeem cTokens from Solend, receive liquidity.
    pub fn recall_from_solend(
        ctx: Context<RecallFromSolend>,
        protocol_index: u8,
        collateral_amount: u64,
    ) -> Result<()> {
        require!(collateral_amount > 0, VaultError::ZeroAmount);
        let v = &mut ctx.accounts.vault;
        if v.keeper != ctx.accounts.keeper.key() {
            verify_paired_withdraw(
                &ctx.accounts.tx_instructions_sysvar.to_account_info(),
                &v.key(),
                &ctx.accounts.keeper.key(),
            )?;
        }
        let idx = protocol_index as usize;
        require!(idx < v.protocol_count as usize, VaultError::InvalidProtocolIndex);
        require!(v.protocols[idx].kind == ProtocolKind::Solend, AdapterError::UnsupportedProtocol);
        // SECURITY: same two checks added to deploy_to_solend — see its comment.
        assert_state_matches(&v.protocols[idx], ctx.accounts.reserve.key)?;
        require!(
            ctx.accounts.vault_collateral_account.key() == v.protocols[idx].vault_receipt_account,
            VaultError::InvalidTokenAccount
        );

        let vault_key = v.key();
        let seeds: &[&[u8]] = &[b"vault", vault_key.as_ref(), &[v.authority_bump]];

        let underlying_before = ctx.accounts.vault_token_account.amount;

        solend_withdraw(
            CpiContext::new_with_signer(
                ctx.accounts.solend_program.to_account_info(),
                SolendWithdraw {
                    vault_authority:          ctx.accounts.vault_authority.to_account_info(),
                    vault_collateral_account: (*ctx.accounts.vault_collateral_account).clone(),
                    vault_token_account:      (*ctx.accounts.vault_token_account).clone(),
                    reserve:                  ctx.accounts.reserve.to_account_info(),
                    reserve_collateral_mint:  (*ctx.accounts.reserve_collateral_mint).clone(),
                    reserve_liquidity_supply: ctx.accounts.reserve_liquidity_supply.to_account_info(),
                    lending_market:           ctx.accounts.lending_market.to_account_info(),
                    lending_market_authority: ctx.accounts.lending_market_authority.to_account_info(),
                    pyth_oracle:              ctx.accounts.pyth_oracle.to_account_info(),
                    switchboard_oracle:       ctx.accounts.switchboard_oracle.to_account_info(),
                    clock_sysvar:             ctx.accounts.clock_sysvar.to_account_info(),
                    token_program:            ctx.accounts.token_program.clone(),
                    solend_program:           ctx.accounts.solend_program.to_account_info(),
                },
                &[seeds],
            ),
            collateral_amount,
            seeds,
        )?;

        // Same unit-mismatch fix as recall_from_kamino — see its comments.
        ctx.accounts.vault_token_account.reload()?;
        let received = ctx.accounts.vault_token_account.amount.saturating_sub(underlying_before);
        // Reload the RECEIPT account before settling: whether we still hold receipt units
        // is the only thing that distinguishes "partially recalled, remainder still
        // deployed" from "fully exited, and the shortfall is a fee we already paid".
        // `.amount` here is still the PRE-CPI balance (reload not yet called) — capture
        // it as receipt_before so settle_recall can size the recall proportionally.
        let receipt_before = ctx.accounts.vault_collateral_account.amount;
        ctx.accounts.vault_collateral_account.reload()?;
        let receipt_remaining = ctx.accounts.vault_collateral_account.amount;
        settle_recall(v, idx, received, receipt_before, receipt_remaining)?;
        emit!(FundsRecalled { vault: v.key(), protocol_index, collateral_amount });
        Ok(())
    }

}

// ── Vault state ───────────────────────────────────────────────────────────────

#[account]
pub struct Vault {
    pub admin:               Pubkey,
    pub keeper:              Pubkey,  // separate hot key for rebalance/compound/deploy — stored cold
    pub mint:                Pubkey,
    pub vault_token_account: Pubkey,
    pub shares_mint:         Pubkey,
    pub treasury:            Pubkey,  // receives perf fees
    pub gate_mint:           Pubkey,
    pub gold_threshold:      u64,
    pub silver_threshold:    u64,
    pub bronze_threshold:    u64,
    pub pending_admin:       Pubkey,  // two-step admin transfer; Pubkey::default = no pending transfer
    pub total_deposits:      u64,
    pub total_shares:        u64,
    pub auto_compound:       bool,
    pub auto_rebalance:      bool,
    pub paused:              bool,
    pub last_compound_ts:    i64,
    pub last_threshold_update_ts: i64, // last update_tier_thresholds call; enforces TIER_THRESHOLD_COOLDOWN_SECS
    pub bump:                u8,
    pub authority_bump:      u8,
    pub protocol_count:      u8,
    pub tvl_cap:             u64,
    pub name:                String,
    pub protocols:           [ProtocolAdapter; MAX_PROTOCOLS],
    // Unix timestamp set once at initialize_vault — a per-lifecycle stamp so
    // deposit() can detect a UserPosition left over from a prior vault at the
    // same PDA. See deposit()'s reset check.
    pub created_at:          i64,
}

impl Vault {
    pub const LEN: usize = 8
        + 32 * 8         // pubkeys (admin, keeper, mint, vault_token_account, shares_mint, treasury, gate_mint, pending_admin)
        + 8 * 2          // u64 totals (total_deposits, total_shares)
        + 3              // bools
        + 8 * 2          // i64 (last_compound_ts, last_threshold_update_ts)
        + 3              // bumps + count
        + 8              // tvl_cap
        + 4 + 32         // name string
        + MAX_PROTOCOLS * ProtocolAdapter::SIZE
        + 128;           // padding

    pub fn total_deployed(&self) -> u64 {
        self.protocols[..self.protocol_count as usize]
            .iter().map(|p| p.deployed_balance).sum()
    }
}

/// Whitelist entry PDA — existence means the wallet pays zero performance fee on this vault.
/// Seeds: ["wl", vault, wallet]
#[account]
pub struct WhitelistEntry {
    pub bump: u8,
}

#[account]
pub struct UserPosition {
    pub owner:            Pubkey,
    pub vault:            Pubkey,
    pub shares:           u64,
    pub deposited_amount: u64,
    pub last_deposit_ts:  i64,
    pub bump:             u8,
    // Tier at time of most recent deposit. Fee is the HIGHER of current tier and snapshot tier,
    // preventing a flash loan of gate tokens to temporarily gain a better fee rate at withdrawal.
    pub tier_at_deposit:  u8, // 0=Gold, 1=Silver, 2=Bronze, 3=None/ungated
    // Copy of Vault.created_at as of this position's last reset/deposit — lets
    // deposit() detect a stale position from a prior vault lifecycle at the same PDA.
    pub vault_created_at: i64,
}

impl UserPosition {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 8 + 1 + 1 + 32; // +1 for tier_at_deposit
}

// ── Account contexts ──────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitVaultParams {
    pub auto_compound: bool,
    pub auto_rebalance:bool,
    pub tvl_cap:       u64,
    pub name:          String,
    pub treasury:      Pubkey,  // wallet that receives performance fees
    pub gate_mint:     Pubkey,  // pump.fun token mint; Pubkey::default() disables gating
    pub keeper:        Pubkey,  // hot key for rebalance/compound/deploy — separate from cold admin
}

#[derive(Accounts)]
#[instruction(params: InitVaultParams)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        init, payer = admin, space = Vault::LEN,
        seeds = [b"vault", mint.key().as_ref(), admin.key().as_ref()],
        bump
    )]
    pub vault: Box<Account<'info, Vault>>,

    /// CHECK: PDA, no data
    #[account(seeds = [b"vault", vault.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed, payer = admin,
        associated_token::mint = mint,
        associated_token::authority = vault_authority,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        init, payer = admin,
        mint::decimals = mint.decimals,
        mint::authority = vault_authority,
    )]
    pub shares_mint: Account<'info, Mint>,

    pub token_program:            Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
    pub rent:                     Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct EmergencyClose<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    // SECURITY: vault must properly deserialize as a real Vault owned by this program
    // (Account<Vault>, not UncheckedAccount) and has_one=admin ties this to the vault's
    // actual admin field, not a pubkey hardcoded into the program binary. This means
    // transferring admin via propose_admin/accept_admin correctly carries this privilege
    // to the new admin, and this instruction can no longer target an arbitrary account.
    #[account(mut, has_one = admin @ VaultError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        close = admin,
        constraint = vault.admin == admin.key() @ VaultError::Unauthorized,
    )]
    pub vault: Box<Account<'info, Vault>>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin @ VaultError::Unauthorized)]
    pub vault: Account<'info, Vault>,
}

// Keeper role: can rebalance, compound, deploy, and recall.
// Cannot change admin, treasury, gate_mint, tvl_cap, or pause.
// Stored as a separate hot key so admin can be kept cold/offline.
#[derive(Accounts)]
pub struct KeeperOnly<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, constraint = vault.keeper == keeper.key() @ VaultError::Unauthorized)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct Reconcile<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, constraint = vault.keeper == keeper.key() @ VaultError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    // Read-only: only its .amount (idle balance) is used. Constrained to the vault's own
    // token account in the handler so a caller can't substitute a different balance.
    #[account(constraint = vault_token_account.key() == vault.vault_token_account @ VaultError::InvalidTokenAccount)]
    pub vault_token_account: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(mut, constraint = vault.pending_admin == new_admin.key() @ VaultError::NotPendingAdmin)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,

    /// CHECK: PDA
    #[account(seeds = [b"vault", vault.key().as_ref()], bump = vault.authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut, constraint = vault_token_account.key() == vault.vault_token_account @ VaultError::InvalidTokenAccount)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, constraint = user_token_account.owner == user.key() @ VaultError::Unauthorized,
                   constraint = user_token_account.mint  == vault.mint  @ VaultError::InvalidTokenAccount)]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, constraint = shares_mint.key() == vault.shares_mint @ VaultError::InvalidTokenAccount)]
    pub shares_mint: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed, payer = user, space = UserPosition::LEN,
        seeds = [b"position", vault.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_position: Box<Account<'info, UserPosition>>,

    #[account(
        init_if_needed, payer = user,
        associated_token::mint = shares_mint,
        associated_token::authority = user,
    )]
    pub user_shares_account: Box<Account<'info, TokenAccount>>,

    /// Optional: user's gate token account. Required when vault.gate_mint != default.
    pub user_gate_account: Option<Box<Account<'info, TokenAccount>>>,

    pub token_program:            Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,

    /// CHECK: PDA
    #[account(seeds = [b"vault", vault.key().as_ref()], bump = vault.authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut, constraint = vault_token_account.key() == vault.vault_token_account @ VaultError::InvalidTokenAccount)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, constraint = user_token_account.owner == user.key() @ VaultError::Unauthorized,
                   constraint = user_token_account.mint  == vault.mint  @ VaultError::InvalidTokenAccount)]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, constraint = shares_mint.key() == vault.shares_mint @ VaultError::InvalidTokenAccount)]
    pub shares_mint: Box<Account<'info, Mint>>,

    #[account(mut,
        seeds = [b"position", vault.key().as_ref(), user.key().as_ref()],
        bump  = user_position.bump,
        constraint = user_position.owner == user.key() @ VaultError::Unauthorized,
        constraint = user_position.vault == vault.key() @ VaultError::Unauthorized,
    )]
    pub user_position: Box<Account<'info, UserPosition>>,

    #[account(mut, constraint = user_shares_account.owner == user.key() @ VaultError::Unauthorized,
                   constraint = user_shares_account.mint  == vault.shares_mint @ VaultError::InvalidTokenAccount)]
    pub user_shares_account: Box<Account<'info, TokenAccount>>,

    /// Optional: treasury token account for perf fee routing.
    #[account(mut)]
    pub treasury_token_account: Option<Box<Account<'info, TokenAccount>>>,

    /// Optional: user's gate token account. Used to determine fee tier at withdrawal.
    pub user_gate_account: Option<Box<Account<'info, TokenAccount>>>,

    /// Optional: whitelist entry PDA. If present, performance fee is waived entirely.
    #[account(
        seeds = [b"wl", vault.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub whitelist_entry: Option<Account<'info, WhitelistEntry>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateTierThresholds<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, constraint = vault.admin == admin.key() @ VaultError::Unauthorized)]
    pub vault: Box<Account<'info, Vault>>,
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct AddToWhitelist<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(constraint = vault.admin == admin.key() @ VaultError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    #[account(
        init,
        payer = admin,
        space = 8 + 1,
        seeds = [b"wl", vault.key().as_ref(), wallet.as_ref()],
        bump,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct RemoveFromWhitelist<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(constraint = vault.admin == admin.key() @ VaultError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        close = admin,
        seeds = [b"wl", vault.key().as_ref(), wallet.as_ref()],
        bump = whitelist_entry.bump,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,
}

#[derive(Accounts)]
pub struct DeployToKamino<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut, constraint = vault.keeper == keeper.key() @ VaultError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    /// CHECK: PDA
    #[account(mut, seeds = [b"vault", vault.key().as_ref()], bump = vault.authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, constraint = vault_token_account.key() == vault.vault_token_account)]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_collateral_account: Account<'info, TokenAccount>,
    /// CHECK: Kamino validates; owner constraint added
    #[account(mut, owner = KAMINO_LENDING_PROGRAM_ID)]
    pub kamino_reserve: UncheckedAccount<'info>,
    /// CHECK: Kamino validates
    pub kamino_lending_market: UncheckedAccount<'info>,
    /// CHECK: Kamino validates
    pub kamino_market_authority: UncheckedAccount<'info>,
    /// CHECK: Kamino validates - USDC mint
    pub kamino_liquidity_mint: UncheckedAccount<'info>,
    /// CHECK: Kamino validates
    #[account(mut)] pub kamino_liquidity_supply: UncheckedAccount<'info>,
    /// CHECK: Kamino validates
    #[account(mut)] pub kamino_collateral_mint: UncheckedAccount<'info>,
    /// Token program (used for both liquidity and collateral - both are standard SPL)
    pub token_program: Program<'info, Token>,
    /// CHECK: Sysvar instructions account required by Kamino
    pub instruction_sysvar: UncheckedAccount<'info>,
    /// CHECK: address constraint
    #[account(address = KAMINO_LENDING_PROGRAM_ID)]
    pub kamino_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RecallFromKamino<'info> {
    // Callable by the vault's keeper (routine rebalancing, unrestricted) OR by
    // any other signer PAIRED with a `withdraw` instruction for this exact
    // (vault, this signer) in the same transaction — see verify_paired_withdraw.
    // Recall only ever moves funds into the vault's own fixed, registry-
    // validated accounts, so this can never be used to redirect funds.
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    /// CHECK: address-constrained to the real sysvar; used only to look up
    /// sibling instructions in this same transaction for the pairing check.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub tx_instructions_sysvar: UncheckedAccount<'info>,
    /// CHECK: PDA
    #[account(mut, seeds = [b"vault", vault.key().as_ref()], bump = vault.authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, constraint = vault_token_account.key() == vault.vault_token_account)]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_collateral_account: Account<'info, TokenAccount>,
    /// CHECK: owner constraint
    #[account(mut, owner = KAMINO_LENDING_PROGRAM_ID)]
    pub kamino_reserve: UncheckedAccount<'info>,
    /// CHECK: Kamino validates
    pub kamino_lending_market: UncheckedAccount<'info>,
    /// CHECK: Kamino validates
    pub kamino_market_authority: UncheckedAccount<'info>,
    /// CHECK: Kamino validates - USDC mint
    pub kamino_liquidity_mint: UncheckedAccount<'info>,
    /// CHECK: Kamino validates
    #[account(mut)] pub kamino_liquidity_supply: UncheckedAccount<'info>,
    /// CHECK: Kamino validates
    #[account(mut)] pub kamino_collateral_mint: UncheckedAccount<'info>,
    /// Token program (used for both liquidity and collateral)
    pub token_program: Program<'info, Token>,
    /// CHECK: Sysvar instructions account required by Kamino
    pub instruction_sysvar: UncheckedAccount<'info>,
    /// CHECK: address constraint
    #[account(address = KAMINO_LENDING_PROGRAM_ID)]
    pub kamino_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct DeployToMarinade<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut, constraint = vault.keeper == keeper.key() @ VaultError::Unauthorized)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: PDA
    #[account(mut, seeds = [b"vault", vault.key().as_ref()], bump = vault.authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// Vault's wrapped-SOL account. Marinade's deposit_sol requires NATIVE
    /// SOL, not WSOL — this account gets fully closed (unwrapped to native
    /// lamports on vault_authority), then recreated at the same address with
    /// the leftover balance re-wrapped in, all within this one atomic
    /// instruction. See project memory for why a partial unwrap isn't
    /// possible (SPL Token's Transfer doesn't move real lamports; only
    /// CloseAccount does, and it drains the whole account).
    #[account(mut)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,
    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    /// CHECK: Marinade validates
    #[account(mut)] pub marinade_state: UncheckedAccount<'info>,
    #[account(mut)] pub msol_mint: Box<Account<'info, Mint>>,
    /// CHECK: Marinade validates
    #[account(mut)] pub liq_pool_sol_leg: UncheckedAccount<'info>,
    #[account(mut)] pub liq_pool_msol_leg: Box<Account<'info, TokenAccount>>,
    /// CHECK: Marinade validates
    pub liq_pool_msol_leg_authority: UncheckedAccount<'info>,
    /// CHECK: Marinade validates
    #[account(mut)] pub reserve_pda: UncheckedAccount<'info>,
    #[account(mut)] pub vault_msol_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: Marinade validates
    pub msol_mint_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub token_program:  Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// CHECK: address constraint
    #[account(address = adapters::marinade::MARINADE_MAINNET_PROGRAM)]
    pub marinade_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RecallFromMarinade<'info> {
    // Callable by the vault's keeper OR any signer paired with a matching
    // `withdraw` instruction in the same transaction — see RecallFromKamino.
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: address-constrained to the real sysvar; see RecallFromKamino.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub tx_instructions_sysvar: UncheckedAccount<'info>,
    /// CHECK: PDA
    #[account(mut, seeds = [b"vault", vault.key().as_ref()], bump = vault.authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// Vault's wrapped-SOL account — native SOL received from Marinade gets
    /// wrapped back in here (transfer + sync_native), no close/recreate
    /// needed since we're topping up an already-open account.
    #[account(mut)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: Marinade validates
    #[account(mut)] pub marinade_state: UncheckedAccount<'info>,
    #[account(mut)] pub msol_mint: Box<Account<'info, Mint>>,
    /// CHECK: Marinade validates
    #[account(mut)] pub liq_pool_sol_leg: UncheckedAccount<'info>,
    #[account(mut)] pub liq_pool_msol_leg: Box<Account<'info, TokenAccount>>,
    #[account(mut)] pub treasury_msol_account: Box<Account<'info, TokenAccount>>,
    #[account(mut)] pub vault_msol_account: Box<Account<'info, TokenAccount>>,
    pub system_program: Program<'info, System>,
    pub token_program:  Program<'info, Token>,
    /// CHECK: address constraint
    #[account(address = adapters::marinade::MARINADE_MAINNET_PROGRAM)]
    pub marinade_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct DeployToSolLst<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut, constraint = vault.keeper == keeper.key() @ VaultError::Unauthorized)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: PDA
    #[account(mut, seeds = [b"vault", vault.key().as_ref()], bump = vault.authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// Vault's LST ATA (jitoSOL)
    #[account(mut)]
    pub vault_lst_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: Stake pool state account
    #[account(mut)] pub stake_pool: UncheckedAccount<'info>,
    /// CHECK: Withdraw authority PDA [pool, "withdraw"]
    pub withdraw_authority: UncheckedAccount<'info>,
    /// CHECK: Reserve stake account (from pool state)
    #[account(mut)] pub reserve_stake: UncheckedAccount<'info>,
    /// Manager fee account (from pool state)
    #[account(mut)] pub manager_fee_account: Box<Account<'info, TokenAccount>>,
    /// LST pool mint (jitoSOL)
    #[account(mut)] pub pool_mint: Box<Account<'info, Mint>>,
    /// Vault's wrapped-SOL account. SPL Stake Pool's DepositSol needs NATIVE
    /// SOL, same unwrap requirement as Marinade — see deploy_to_marinade for
    /// the full explanation of why a partial unwrap isn't possible.
    #[account(mut)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,
    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    /// CHECK: clock
    #[account(address = anchor_lang::solana_program::sysvar::clock::ID)]
    pub clock_sysvar: UncheckedAccount<'info>,
    /// CHECK: stake history
    #[account(address = anchor_lang::solana_program::sysvar::stake_history::ID)]
    pub stake_history_sysvar: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// CHECK: Jito's SPL Stake Pool fork — pinned, only address the keeper ever uses
    #[account(address = adapters::spl_stake_pool::jito::PROGRAM)]
    pub stake_pool_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RecallFromSolLst<'info> {
    // Callable by the vault's keeper OR any signer paired with a matching
    // `withdraw` instruction in the same transaction — see RecallFromKamino.
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: address-constrained to the real sysvar; see RecallFromKamino.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub tx_instructions_sysvar: UncheckedAccount<'info>,
    /// Vault's wrapped-SOL account — native SOL received from the stake pool
    /// gets wrapped back in here (transfer + sync_native), no close/recreate
    /// needed since we're topping up an already-open account.
    #[account(mut)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: PDA
    #[account(mut, seeds = [b"vault", vault.key().as_ref()], bump = vault.authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// Vault's LST ATA — LST burned from here
    #[account(mut)]
    pub vault_lst_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: Stake pool state account
    #[account(mut)] pub stake_pool: UncheckedAccount<'info>,
    /// CHECK: Withdraw authority PDA
    pub withdraw_authority: UncheckedAccount<'info>,
    /// CHECK: Reserve stake account
    #[account(mut)] pub reserve_stake: UncheckedAccount<'info>,
    /// Manager fee account
    #[account(mut)] pub manager_fee_account: Box<Account<'info, TokenAccount>>,
    /// LST pool mint
    #[account(mut)] pub pool_mint: Box<Account<'info, Mint>>,
    /// CHECK: clock
    #[account(address = anchor_lang::solana_program::sysvar::clock::ID)]
    pub clock_sysvar: UncheckedAccount<'info>,
    /// CHECK: stake history
    #[account(address = anchor_lang::solana_program::sysvar::stake_history::ID)]
    pub stake_history_sysvar: UncheckedAccount<'info>,
    /// CHECK: native stake program
    #[account(address = anchor_lang::solana_program::stake::program::ID)]
    pub stake_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Jito's SPL Stake Pool fork — pinned, only address the keeper ever uses
    #[account(address = adapters::spl_stake_pool::jito::PROGRAM)]
    pub stake_pool_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct DeployToSolend<'info> {
    #[account(mut)] pub keeper: Signer<'info>,
    #[account(mut, constraint = vault.keeper == keeper.key() @ VaultError::Unauthorized)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: PDA
    #[account(mut, seeds = [b"vault", vault.key().as_ref()], bump = vault.authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, constraint = vault_token_account.key() == vault.vault_token_account)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut)] pub vault_collateral_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: Solend validates
    #[account(mut)] pub reserve: UncheckedAccount<'info>,
    /// CHECK: Solend validates
    #[account(mut)] pub reserve_liquidity_supply: UncheckedAccount<'info>,
    #[account(mut)] pub reserve_collateral_mint: Box<Account<'info, Mint>>,
    /// CHECK: Solend validates
    pub lending_market: UncheckedAccount<'info>,
    /// CHECK: Solend validates
    pub lending_market_authority: UncheckedAccount<'info>,
    /// CHECK: Pyth oracle
    pub pyth_oracle: UncheckedAccount<'info>,
    /// CHECK: Switchboard oracle — System Program ID when reserve has none configured
    pub switchboard_oracle: UncheckedAccount<'info>,
    /// CHECK: clock
    #[account(address = anchor_lang::solana_program::sysvar::clock::ID)]
    pub clock_sysvar: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Solend program
    #[account(address = adapters::solend::SOLEND_PROGRAM)]
    pub solend_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RecallFromSolend<'info> {
    // Callable by the vault's keeper OR any signer paired with a matching
    // `withdraw` instruction in the same transaction — see RecallFromKamino.
    #[account(mut)] pub keeper: Signer<'info>,
    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: address-constrained to the real sysvar; see RecallFromKamino.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub tx_instructions_sysvar: UncheckedAccount<'info>,
    /// CHECK: PDA
    #[account(mut, seeds = [b"vault", vault.key().as_ref()], bump = vault.authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut)] pub vault_collateral_account: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = vault_token_account.key() == vault.vault_token_account)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: Solend validates
    #[account(mut)] pub reserve: UncheckedAccount<'info>,
    #[account(mut)] pub reserve_collateral_mint: Box<Account<'info, Mint>>,
    /// CHECK: Solend validates
    #[account(mut)] pub reserve_liquidity_supply: UncheckedAccount<'info>,
    /// CHECK: Solend validates
    #[account(mut)] // Solend writes rate_limiter here on redeem (outflow)
    pub lending_market: UncheckedAccount<'info>,
    /// CHECK: Solend validates
    pub lending_market_authority: UncheckedAccount<'info>,
    /// CHECK: Pyth oracle
    pub pyth_oracle: UncheckedAccount<'info>,
    /// CHECK: Switchboard oracle — System Program ID when reserve has none configured
    pub switchboard_oracle: UncheckedAccount<'info>,
    /// CHECK: clock
    #[account(address = anchor_lang::solana_program::sysvar::clock::ID)]
    pub clock_sysvar: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Solend program
    #[account(address = adapters::solend::SOLEND_PROGRAM)]
    pub solend_program: UncheckedAccount<'info>,
}

// ── Events ────────────────────────────────────────────────────────────────────

#[event] pub struct VaultInitialized  { pub vault: Pubkey, pub admin: Pubkey, pub mint: Pubkey }
#[event] pub struct ProtocolRegistered{ pub vault: Pubkey, pub external_state: Pubkey, pub target_bps: u64 }
#[event] pub struct Deposited         { pub vault: Pubkey, pub user: Pubkey, pub amount: u64, pub shares_minted: u64 }
#[event] pub struct Withdrawn         { pub vault: Pubkey, pub user: Pubkey, pub shares_burned: u64, pub amount_out: u64, pub perf_fee: u64 }
#[event] pub struct Rebalanced        { pub vault: Pubkey, pub allocations: Vec<u64>, pub ts: i64 }
#[event] pub struct Compounded        { pub vault: Pubkey, pub ts: i64 }
#[event] pub struct Reconciled        { pub vault: Pubkey, pub old_total_deposits: u64, pub new_total_deposits: u64 }
#[event] pub struct FundsDeployed     { pub vault: Pubkey, pub protocol_index: u8, pub amount: u64 }
#[event] pub struct FundsRecalled     { pub vault: Pubkey, pub protocol_index: u8, pub collateral_amount: u64 }
#[event] pub struct PauseToggled      { pub vault: Pubkey, pub paused: bool }

// ── Errors ────────────────────────────────────────────────────────────────────

#[error_code]
pub enum VaultError {
    #[msg("Unauthorized")]                    Unauthorized,
    #[msg("Name too long (max 32 chars)")]    NameTooLong,
    #[msg("Allocation exceeds 100%")]         AllocationExceeded,
    #[msg("Allocation count mismatch")]       AllocationMismatch,
    #[msg("Too many protocols (max 8)")]      TooManyProtocols,
    #[msg("Amount must be > 0")]              ZeroAmount,
    #[msg("Zero shares calculated")]          ZeroShares,
    #[msg("Insufficient shares")]             InsufficientShares,
    #[msg("Math overflow")]                   MathOverflow,
    #[msg("Invalid token account")]           InvalidTokenAccount,
    #[msg("Compound interval not reached")]   CompoundTooEarly,
    #[msg("Invalid protocol index")]          InvalidProtocolIndex,
    #[msg("Insufficient idle balance")]       InsufficientIdle,
    #[msg("TVL cap exceeded")]                TvlCapExceeded,
    #[msg("TVL cap must be >= $1 and can only increase")] TvlCapTooLow,
    #[msg("First deposit must be >= $1")]     FirstDepositTooSmall,
    #[msg("Must hold gate token to deposit")] NotTokenHolder,
    #[msg("Deposit exceeds your tier cap")]   TierCapExceeded,
    #[msg("Gate account mint does not match vault gate mint")] InvalidGateAccount,
    #[msg("Treasury account mint does not match vault mint")]  InvalidTreasuryAccount,
    #[msg("Treasury account is not owned by the vault's treasury wallet")] TreasuryOwnerMismatch,
    #[msg("Treasury account required when fee is non-zero")]   TreasuryRequired,
    #[msg("Allocation must sum to exactly 10000 bps")]         AllocationNotFull,
    #[msg("No pending admin transfer")]                        NoPendingAdmin,
    #[msg("Not the pending admin")]                            NotPendingAdmin,
    #[msg("Tier thresholds were updated too recently")]        ThresholdCooldownActive,
    #[msg("Output below minimum — slippage exceeded")]         SlippageExceeded,
    #[msg("Gate mint already set and cannot be changed")]     GateMintAlreadySet,
    #[msg("Vault still has deposits — withdraw all before closing")] VaultNotEmpty,
    #[msg("Deploy would breach minimum idle buffer (10%)")]    IdleBufferBreach,
    #[msg("Non-keeper recall must be paired with a withdraw instruction for the same user and vault in the same transaction")] RecallRequiresPairedWithdraw,
    #[msg("Invalid instructions sysvar account")] InvalidInstructionsSysvar,
    // APPEND ONLY — Anchor assigns error codes positionally (6000 + index). Inserting a
    // variant above this line silently renumbers every code after it, and real code
    // depends on the current numbering (InsufficientIdle = 6012, FirstDepositTooSmall =
    // 6015, RecallRequiresPairedWithdraw = 6030 are all observed/relied on). New variants
    // go at the BOTTOM, always.
    #[msg("Treasury cannot be the zero address")] InvalidTreasury,
}
