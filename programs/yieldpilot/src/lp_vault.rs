//! LP vault — opt-in, dual-asset liquidity provision (Orca Whirlpools or
//! Raydium CLMM).
//!
//! Deliberately a SEPARATE product from the main single-asset `Vault`: it
//! accepts two tokens directly from the depositor (no swap step, no added
//! price-impact risk stacked onto impermanent loss) and is not part of the
//! core auto-routing promise. See project memory / whitepaper Phase 2.
//!
//! Protocol-agnostic design: `LpVault` holds a `protocol: LpProtocolKind`
//! field and generic account fields (`pool`, `position`, etc.) shared by
//! both integrations — share accounting, the IL-acknowledgment gate, and
//! the reposition flow are all written once. What ISN'T shared is the
//! actual CPI account list per instruction: Orca and Raydium's real
//! accounts genuinely differ (Raydium has an extra `protocol_position`
//! layer and an NFT-metadata dependency Orca doesn't), so each protocol
//! gets its own instructions (deposit_orca_lp vs deposit_raydium_lp) rather
//! than forcing a single Anchor Accounts struct to express both — the same
//! pattern the main Vault already uses for Kamino/Marinade/Solend/Jito
//! (one instruction per protocol, not a generic dispatcher).
//!
//! v1 scope, deliberately kept simple:
//! - Fixed price range, chosen once at vault init by admin (no active
//!   rebalancing yet — a real tradeoff: rebalancing is more capital-efficient
//!   but adds keeper complexity + rebalancing cost. Flagged as future work).
//! - `liquidity_amount` for deposit/withdraw is supplied by the caller
//!   (computed off-chain via each protocol's own SDK from desired token
//!   amounts and the pool's current price) rather than derived on-chain —
//!   keeps the Solana program's math simple and auditable; `token_max_a/b`
//!   / `token_min_a/b` are the on-chain slippage guard regardless of how
//!   the caller computed the liquidity figure.
//! - Deposits require an explicit on-chain acknowledgment of impermanent
//!   loss risk (`acknowledge_impermanent_loss: bool`, must be true) — a
//!   real, enforced gate, not just a frontend disclaimer.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount, Transfer};

use crate::adapters::orca::{
    OrcaClosePosition, OrcaCollectFees, OrcaModifyLiquidity, OrcaOpenPosition, WHIRLPOOL_PROGRAM_ID,
    orca_close_position, orca_collect_fees, orca_decrease_liquidity, orca_increase_liquidity,
    orca_open_position, orca_update_fees_and_rewards,
};
use crate::adapters::raydium::{
    METADATA_PROGRAM_ID, RAYDIUM_CLMM_PROGRAM_ID, RaydiumClosePosition, RaydiumModifyLiquidity,
    RaydiumOpenPosition, TICK_ARRAY_BITMAP_EXTENSION_SEED, raydium_close_position,
    raydium_decrease_liquidity, raydium_increase_liquidity, raydium_open_position,
};

// ── State ─────────────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum LpProtocolKind {
    Orca    = 0,
    Raydium = 1,
}

impl Default for LpProtocolKind {
    fn default() -> Self { LpProtocolKind::Orca }
}

#[account]
pub struct LpVault {
    pub admin:                    Pubkey,
    pub keeper:                   Pubkey,
    pub treasury:                 Pubkey,
    pub protocol:                 LpProtocolKind,
    /// Orca: the Whirlpool account. Raydium: the pool_state account.
    pub pool:                     Pubkey,
    /// Orca: the Position state account. Raydium: the PersonalPositionState
    /// account.
    pub position:                 Pubkey,
    /// Raydium only (Pubkey::default() for Orca vaults) — the shared
    /// per-tick-range ProtocolPositionState account Raydium requires on
    /// every liquidity-modifying call. See adapters/raydium.rs's PDA seed
    /// notes; marked "deprecated" in Raydium's own source but still
    /// mandatory.
    pub protocol_position:        Pubkey,
    pub position_mint:            Pubkey,
    pub position_token_account:   Pubkey,
    pub token_a_mint:             Pubkey,
    pub token_b_mint:             Pubkey,
    pub vault_token_a_account:    Pubkey,
    pub vault_token_b_account:    Pubkey,
    pub lp_shares_mint:           Pubkey,
    pub tick_lower_index:         i32,
    pub tick_upper_index:         i32,
    /// Total liquidity units currently contributed to the position (each
    /// protocol's own u128 liquidity unit — NOT a token amount).
    pub total_liquidity:          u128,
    pub total_shares:             u64,
    pub paused:                   bool,
    /// False between exit_*_lp_position and open_new_*_lp_position — the
    /// vault holds idle tokens but has no live protocol position.
    /// deposit_*_lp and withdraw_*_lp both require this to be true.
    pub position_active:          bool,
    pub bump:                     u8,
    pub authority_bump:           u8,
    pub name:                     String,
    /// Lifetime raw token amounts collected from Orca/Raydium swap fees and
    /// immediately re-deployed back into the position (auto-compound, same model
    /// the safe vaults already use for lending yield — no separate per-user claim,
    /// share value just reflects it). Added 2026-08-27 alongside collect_*_lp_fees;
    /// only ever increases, survives exits/reopens, so it answers "how much has
    /// this position actually earned" the same way Vault.lifetime_gains does for
    /// the safe vaults. Carved out of the existing padding below — no realloc
    /// needed, LpVault::LEN is unchanged.
    pub lifetime_fees_a:          u64,
    pub lifetime_fees_b:          u64,
    /// Idle-capital lending backstop (added 2026-09-03, see project memory
    /// project_lp_idle_capital_lending_backstop): raw token amount of the B
    /// leg (USDC) currently deposited in Solend earning lending yield instead
    /// of sitting idle. The matching cToken receipt account is a PDA, never
    /// stored here -- derived from [b"lp_lending_receipt_b", lp_vault] --
    /// so this costs only 8 bytes, not 8+32. A leg is 0 when nothing is
    /// deployed. Carved from the same padding lifetime_fees_a/b used; no
    /// realloc needed, LpVault::LEN unchanged.
    pub lending_deployed_b:       u64,
    /// Two-step admin transfer (propose_lp_admin/accept_lp_admin), same pattern as
    /// Vault.pending_admin. Added 2026-09-28 after a real incident: LP vaults had NO
    /// admin-transfer mechanism at all, so when the admin key was compromised
    /// (see project memory, project_yieldpilot_critical_keys.md) every LP vault's
    /// admin/treasury was permanently stuck pointing at the burned key with no way to
    /// migrate it — flagged and deliberately deprioritized while LP vaults were empty,
    /// then a real deposit landed before this got fixed. Carved from the existing
    /// padding below — no realloc needed, LpVault::LEN unchanged.
    /// Pubkey::default() = no pending transfer.
    pub pending_admin:            Pubkey,
    /// Performance-fee gate/tier config, mirroring Vault's gate_mint + threshold fields
    /// exactly (see lib.rs, resolve_lp_fee_bps above). Added 2026-09-29 alongside the
    /// fee logic itself -- see LpUserPosition.deposited_amount_a/b's doc comment for the
    /// full incident writeup (withdraw_orca_lp/withdraw_raydium_lp had NO fee logic at
    /// all before this). gate_mint == SystemProgram means disabled (always standard
    /// rate), same convention as the Safe vault. Present in LpVault::LEN from this
    /// program's very first deploy -- every vault gets these fields set correctly at
    /// initialize_orca_lp_vault/initialize_raydium_lp_vault, no migration ever needed.
    pub gate_mint:                Pubkey,
    pub gold_threshold:           u64,
    pub silver_threshold:         u64,
    pub bronze_threshold:         u64,
}

impl LpVault {
    pub const LEN: usize = 8
        + 32 * 13   // pubkeys (admin, keeper, treasury, pool, position, protocol_position, position_mint, position_token_account, token_a_mint, token_b_mint, vault_token_a_account, vault_token_b_account, lp_shares_mint)
        + 1         // protocol (LpProtocolKind, single-byte enum)
        + 4 * 2     // tick indices (i32)
        + 16        // total_liquidity (u128)
        + 8         // total_shares
        + 2         // paused + position_active
        + 2         // bumps
        + 4 + 32    // name
        + 8 * 2     // lifetime_fees_a, lifetime_fees_b
        + 8         // lending_deployed_b
        + 32        // pending_admin
        + 32        // gate_mint
        + 8 * 3     // gold_threshold, silver_threshold, bronze_threshold
        + 8;        // padding for future fields (was 8, unchanged -- gating fields grow the account instead)
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
    /// Real per-token deposited amounts, used as the actual cost basis for the
    /// performance-fee-on-profit charged at withdrawal. Added 2026-09-29 after a real
    /// incident: withdraw_orca_lp/withdraw_raydium_lp had NO fee logic at all since the
    /// LP vault instructions were first shipped -- every LP withdrawal, ever, paid zero
    /// performance fee regardless of profit. liquidity_at_deposit (above) can't serve as
    /// a cost basis on its own -- it's mathematically tautological with the current
    /// proportional share of liquidity, since shares are minted proportional to
    /// liquidity (see project memory). Tracked per-token rather than as a single USD
    /// value deliberately: an on-chain price oracle would add a real manipulation
    /// surface (a temporarily-skewed price at withdrawal time could zero out or inflate
    /// the reported profit) for a problem that doesn't need one -- profit in token A and
    /// profit in token B, charged independently in their own units, is exactly as
    /// correct and has no oracle dependency at all. Carved from the account's own
    /// existing padding -- no realloc needed, LpUserPosition::LEN unchanged.
    pub deposited_amount_a: u64,
    pub deposited_amount_b: u64,
    /// Snapshotted fee tier at deposit time (0=gold..3=standard), same anti-flash-loan
    /// purpose as UserPosition.tier_at_deposit on the Safe vault: the WORSE (higher-fee)
    /// of this and the live tier at withdrawal is always used, so gate tokens borrowed
    /// right before withdrawing can't retroactively cheapen a fee already locked in.
    pub tier_at_deposit: u8,
}

impl LpUserPosition {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 16 + 1 + 8 * 2 + 1 + 15;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitLpVaultParams {
    pub keeper:           Pubkey,
    pub treasury:         Pubkey,
    pub tick_lower_index: i32,
    pub tick_upper_index: i32,
    /// Raydium only — the start index of each tick array (a DIFFERENT value
    /// than tick_lower_index/tick_upper_index; see adapters/raydium.rs PDA
    /// seed notes). Ignored for Orca vaults.
    pub tick_array_lower_start_index: i32,
    pub tick_array_upper_start_index: i32,
    pub name:             String,
}

// ── Errors ────────────────────────────────────────────────────────────────────

// Explicit discriminant on the first variant: #[error_code] enums each default to
// starting at 6000, and this program already has three others (VaultError,
// AdapterError, KaminoError) claiming that range. Without this, e.g.
// LpVaultError::MustAcknowledgeImpermanentLoss and VaultError::Unauthorized are both
// numerically "6000" — harmless today since no single instruction can throw from two
// enums at once, but ambiguous to anything that maps a bare code back to a message
// without also knowing which vault type it came from. VaultError runs up to ~6036, so
// 6100 leaves headroom.
#[error_code]
pub enum LpVaultError {
    #[msg("Must explicitly acknowledge impermanent loss risk to deposit")]
    MustAcknowledgeImpermanentLoss = 6100,
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
    #[msg("No active protocol position — vault is mid-reposition")]
    NoActivePosition,
    #[msg("Position still has liquidity — exit it fully before reopening")]
    PositionStillActive,
    #[msg("Vault does not hold enough idle balance for this redeploy amount")]
    InsufficientIdleBalance,
    #[msg("No pending LP vault admin transfer")]
    NoPendingLpAdmin,
    #[msg("Caller is not the pending LP vault admin")]
    NotPendingLpAdmin,
    #[msg("Treasury token account required when a performance fee is owed")]
    LpTreasuryRequired,
    #[msg("Treasury token account is not owned by the vault's registered treasury wallet")]
    LpTreasuryOwnerMismatch,
    #[msg("Gate account mint/owner does not match the caller")]
    InvalidLpGateAccount,
    #[msg("LP vault still has liquidity or an active position — exit and withdraw everything before closing")]
    LpVaultNotEmpty,
    #[msg("LP position still has shares — withdraw everything before closing")]
    LpPositionNotEmpty,
}

// Same tier structure and rates as the Safe vault's GOLD/SILVER/BRONZE/STANDARD_FEE_BPS
// (see lib.rs) -- defined separately here rather than imported cross-module, but MUST be
// kept numerically identical. Inert (gate_mint defaults to SystemProgram, same convention
// as the Safe vault) until the $YPILOT gate token exists -- see project memory,
// project_inert_features.md -- but the scaffolding has to be real from day one, not
// bolted on later, exactly like the Safe vault already has it.
const LP_GOLD_FEE_BPS: u64 = 0;
const LP_SILVER_FEE_BPS: u64 = 300;
const LP_BRONZE_FEE_BPS: u64 = 600;
const LP_STANDARD_FEE_BPS: u64 = 900;
const LP_FEE_BPS_DENOM: u64 = 10_000;

/// Resolves the effective fee tier exactly like the Safe vault's withdraw() does: live
/// gate-token balance against the vault's OWN thresholds, floored by the WORSE
/// (higher-fee) of that and the tier snapshotted at deposit time -- so nobody can flash-
/// borrow gate tokens right before withdrawing to retroactively cheapen a fee they
/// already locked in. Disabled entirely (always standard rate) when gate_mint is the
/// default SystemProgram placeholder, same convention as the Safe vault.
fn resolve_lp_fee_bps(
    gate_mint: Pubkey,
    gold_threshold: u64,
    silver_threshold: u64,
    bronze_threshold: u64,
    gate_balance: u64,
    tier_at_deposit: u8,
) -> u64 {
    if gate_mint == anchor_lang::solana_program::system_program::ID {
        return LP_STANDARD_FEE_BPS;
    }
    let current_tier_u8: u8 = if gate_balance >= gold_threshold { 0 }
        else if gate_balance >= silver_threshold { 1 }
        else if gate_balance >= bronze_threshold { 2 }
        else { 3 };
    let effective_tier = current_tier_u8.max(tier_at_deposit);
    match effective_tier {
        0 => LP_GOLD_FEE_BPS,
        1 => LP_SILVER_FEE_BPS,
        2 => LP_BRONZE_FEE_BPS,
        _ => LP_STANDARD_FEE_BPS,
    }
}

#[cfg(test)]
mod lp_fee_tests {
    use super::*;

    const NO_GATE: Pubkey = anchor_lang::solana_program::system_program::ID;
    // Any non-default pubkey stands in for a real gate mint in these tests.
    const GATE: Pubkey = Pubkey::new_from_array([7u8; 32]);
    const GOLD_T: u64 = 1_000_000;
    const SILVER_T: u64 = 100_000;
    const BRONZE_T: u64 = 10_000;

    #[test]
    fn disabled_gating_always_charges_standard_rate() {
        // This is the current mainnet reality: gate_mint == SystemProgram on every LP
        // vault today, since no $YPILOT gate token exists yet. Must charge the full
        // 900bps regardless of any balance/tier snapshot passed in -- the user's own
        // real withdrawal (0% fee taken, pre-fix) must NOT be reproduced by the fixed code.
        assert_eq!(resolve_lp_fee_bps(NO_GATE, GOLD_T, SILVER_T, BRONZE_T, 999_999_999, 0), LP_STANDARD_FEE_BPS);
        assert_eq!(resolve_lp_fee_bps(NO_GATE, GOLD_T, SILVER_T, BRONZE_T, 0, 3), LP_STANDARD_FEE_BPS);
    }

    #[test]
    fn tier_scales_with_live_gate_balance() {
        // The exact thing Lloyd was worried I'd forget: the rate is NOT a flat 9%, it
        // scales down as the wallet holds more of the native gate token.
        assert_eq!(resolve_lp_fee_bps(GATE, GOLD_T, SILVER_T, BRONZE_T, GOLD_T, 0), LP_GOLD_FEE_BPS);
        assert_eq!(resolve_lp_fee_bps(GATE, GOLD_T, SILVER_T, BRONZE_T, SILVER_T, 0), LP_SILVER_FEE_BPS);
        assert_eq!(resolve_lp_fee_bps(GATE, GOLD_T, SILVER_T, BRONZE_T, BRONZE_T, 0), LP_BRONZE_FEE_BPS);
        assert_eq!(resolve_lp_fee_bps(GATE, GOLD_T, SILVER_T, BRONZE_T, 0, 0), LP_STANDARD_FEE_BPS);
        // Just below a threshold falls to the next tier down.
        assert_eq!(resolve_lp_fee_bps(GATE, GOLD_T, SILVER_T, BRONZE_T, GOLD_T - 1, 0), LP_SILVER_FEE_BPS);
        assert_eq!(resolve_lp_fee_bps(GATE, GOLD_T, SILVER_T, BRONZE_T, SILVER_T - 1, 0), LP_BRONZE_FEE_BPS);
        assert_eq!(resolve_lp_fee_bps(GATE, GOLD_T, SILVER_T, BRONZE_T, BRONZE_T - 1, 0), LP_STANDARD_FEE_BPS);
    }

    #[test]
    fn worse_of_live_and_deposit_snapshot_wins() {
        // Anti-flash-loan: even if the wallet holds gold-tier balance live, a worse
        // (higher-fee) tier snapshotted at deposit time still applies.
        assert_eq!(resolve_lp_fee_bps(GATE, GOLD_T, SILVER_T, BRONZE_T, GOLD_T, 3), LP_STANDARD_FEE_BPS);
        assert_eq!(resolve_lp_fee_bps(GATE, GOLD_T, SILVER_T, BRONZE_T, GOLD_T, 1), LP_SILVER_FEE_BPS);
        // And the reverse: gold snapshotted at deposit doesn't help if the wallet has
        // since drained its gate tokens -- the WORSE of the two always wins either way.
        assert_eq!(resolve_lp_fee_bps(GATE, GOLD_T, SILVER_T, BRONZE_T, 0, 0), LP_STANDARD_FEE_BPS);
    }

    // Cost-basis / profit-decomposition math used directly in both withdraw handlers,
    // extracted here as pure arithmetic so it's testable without a live CPI/validator.
    fn profit_and_fee(deposited: u64, shares_withdrawn: u64, shares_total: u64, payout: u64, fee_bps: u64) -> (u64, u64) {
        let cost_basis = deposited.checked_mul(shares_withdrawn).and_then(|x| x.checked_div(shares_total)).unwrap_or(0);
        let profit = payout.saturating_sub(cost_basis);
        let fee = profit.checked_mul(fee_bps).and_then(|x| x.checked_div(LP_FEE_BPS_DENOM)).unwrap_or(0);
        (profit, fee)
    }

    #[test]
    fn no_fee_when_withdrawing_at_or_below_cost_basis() {
        // Full withdrawal, payout exactly equals cost basis -- zero profit, zero fee.
        let (profit, fee) = profit_and_fee(1_000, 500, 500, 1_000, LP_STANDARD_FEE_BPS);
        assert_eq!(profit, 0);
        assert_eq!(fee, 0);
        // Payout below cost basis (a real loss) must not underflow or charge a fee.
        let (profit, fee) = profit_and_fee(1_000, 500, 500, 800, LP_STANDARD_FEE_BPS);
        assert_eq!(profit, 0);
        assert_eq!(fee, 0);
    }

    #[test]
    fn fee_charged_only_on_the_profit_slice_at_standard_rate() {
        // Deposited 1000, full withdrawal returns 1300 -> 300 profit, 9% of that = 27.
        let (profit, fee) = profit_and_fee(1_000, 500, 500, 1_300, LP_STANDARD_FEE_BPS);
        assert_eq!(profit, 300);
        assert_eq!(fee, 27);
    }

    #[test]
    fn partial_withdrawal_uses_pro_rata_cost_basis() {
        // Deposited 1000 total, withdrawing half the shares: cost basis is 500, not 1000.
        // Payout of 700 on that half -> 200 profit, 900bps fee = 18.
        let (profit, fee) = profit_and_fee(1_000, 250, 500, 700, LP_STANDARD_FEE_BPS);
        assert_eq!(profit, 200);
        assert_eq!(fee, 18);
    }
}

// ── Shared math helpers ────────────────────────────────────────────────────────
// Identical share-price logic for both protocols — extracted once so
// Orca/Raydium handlers can't silently drift apart on something this
// correctness-sensitive.

/// Shares to mint for a deposit of `liquidity_amount`, given current
/// vault totals. First depositor mints 1:1; later depositors mint
/// proportional to existing liquidity, same pattern as the main Vault's
/// share math.
fn calculate_deposit_shares(liquidity_amount: u128, total_liquidity: u128, total_shares: u64) -> Result<u64> {
    let shares: u64 = if total_shares == 0 || total_liquidity == 0 {
        // u128 liquidity down-scaled defensively; real precision handling is
        // a follow-up item once real pool liquidity magnitudes are known.
        liquidity_amount.min(u64::MAX as u128) as u64
    } else {
        (liquidity_amount
            .checked_mul(total_shares as u128)
            .and_then(|x| x.checked_div(total_liquidity))
            .ok_or(LpVaultError::MathOverflow)?) as u64
    };
    require!(shares > 0, LpVaultError::ZeroShares);
    Ok(shares)
}

/// Liquidity to remove for a withdrawal of `shares`, given current vault
/// totals.
fn calculate_withdraw_liquidity(shares: u64, total_liquidity: u128, total_shares: u64) -> Result<u128> {
    (shares as u128)
        .checked_mul(total_liquidity)
        .and_then(|x| x.checked_div(total_shares as u128))
        .ok_or(LpVaultError::MathOverflow.into())
}

// ── Events ────────────────────────────────────────────────────────────────────

#[event] pub struct LpVaultInitialized { pub lp_vault: Pubkey, pub protocol: LpProtocolKind, pub pool: Pubkey }
#[event] pub struct LpDeposited        { pub lp_vault: Pubkey, pub user: Pubkey, pub liquidity_amount: u128, pub shares_minted: u64 }
#[event] pub struct LpWithdrawn        { pub lp_vault: Pubkey, pub user: Pubkey, pub shares_burned: u64, pub liquidity_amount: u128 }
#[event] pub struct LpPositionExited   { pub lp_vault: Pubkey, pub liquidity_removed: u128 }
#[event] pub struct LpPositionReopened { pub lp_vault: Pubkey, pub tick_lower_index: i32, pub tick_upper_index: i32 }
#[event] pub struct LpLiquidityRedeployed { pub lp_vault: Pubkey, pub liquidity_amount: u128 }
#[event] pub struct LpFeesCollected    { pub lp_vault: Pubkey, pub fees_a: u64, pub fees_b: u64 }

pub mod lending_lp {
    //! Idle-capital lending backstop for the LP vault (Phase 1, USDC leg only).
    //! See project memory project_lp_idle_capital_lending_backstop for the
    //! full design and project_lp_fee_collection_missing for why this needed
    //! Raydium's fee-collection path proven first (repositioning depends on it).
    //!
    //! Scope, deliberately minimal for a first cut:
    //! - Only the B leg (USDC) routes to lending, via the same Solend adapter
    //!   the main Vault already runs in production. The A leg (SOL) needs
    //!   Marinade's native-SOL unwrap/rewrap dance (see deploy_to_marinade in
    //!   lib.rs) -- real extra complexity, deliberately deferred to a follow-up
    //!   rather than rushed in alongside this.
    //! - No protocol registry, no multi-protocol choice: always Solend's main
    //!   USDC pool. The keeper decides how much to deploy/recall each cycle;
    //!   this instruction pair is the mechanical plumbing, not the policy.
    //! - The cToken receipt account is a PDA the program itself owns (seeds
    //!   below), never a keeper-supplied address -- so there's no equivalent
    //!   of the "vault_receipt_account redirection" risk the main Vault's
    //!   adapters guard against with an explicit constraint; it cannot be
    //!   anything other than this exact PDA.
    use anchor_lang::prelude::*;
    use anchor_lang::solana_program::sysvar::instructions::ID as INSTRUCTIONS_SYSVAR_ID;
    use anchor_spl::token::{Mint, Token, TokenAccount};
    use anchor_spl::associated_token::AssociatedToken;

    use crate::adapters::solend::{
        SolendDeposit, SolendWithdraw, solend_deposit, solend_withdraw, SOLEND_PROGRAM,
    };
    use super::{LpVault, LpVaultError};

    pub const LP_LENDING_RECEIPT_B_SEED: &[u8] = b"lp_lending_receipt_b";

    #[event] pub struct LpIdleDeployed { pub lp_vault: Pubkey, pub amount: u64 }
    #[event] pub struct LpIdleRecalled { pub lp_vault: Pubkey, pub collateral_amount: u64, pub received: u64 }

    #[derive(Accounts)]
    pub struct DeployLpIdleBToSolend<'info> {
        #[account(mut)] pub keeper: Signer<'info>,
        #[account(mut)]
        pub lp_vault: Box<Account<'info, LpVault>>,
        /// CHECK: PDA
        #[account(mut, seeds = [b"lp_vault_authority", lp_vault.key().as_ref()], bump = lp_vault.authority_bump)]
        pub vault_authority: UncheckedAccount<'info>,
        #[account(mut, constraint = vault_token_b_account.key() == lp_vault.vault_token_b_account)]
        pub vault_token_b_account: Box<Account<'info, TokenAccount>>,
        /// The vault's own cUSDC receipt account -- a PDA this program controls,
        /// created on first use. Never keeper-supplied.
        #[account(
            init_if_needed, payer = keeper,
            seeds = [LP_LENDING_RECEIPT_B_SEED, lp_vault.key().as_ref()], bump,
            token::mint = reserve_collateral_mint, token::authority = vault_authority,
        )]
        pub lending_receipt_b: Box<Account<'info, TokenAccount>>,
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
        /// CHECK: Switchboard oracle -- System Program ID when reserve has none configured
        pub switchboard_oracle: UncheckedAccount<'info>,
        /// CHECK: clock
        #[account(address = anchor_lang::solana_program::sysvar::clock::ID)]
        pub clock_sysvar: UncheckedAccount<'info>,
        pub token_program: Program<'info, Token>,
        pub associated_token_program: Program<'info, AssociatedToken>,
        pub system_program: Program<'info, System>,
        pub rent: Sysvar<'info, Rent>,
        /// CHECK: address-constrained to the real sysvar
        #[account(address = INSTRUCTIONS_SYSVAR_ID)]
        pub tx_instructions_sysvar: UncheckedAccount<'info>,
        /// CHECK: Solend program
        #[account(address = SOLEND_PROGRAM)]
        pub solend_program: UncheckedAccount<'info>,
    }

    pub fn deploy_lp_idle_b_to_solend_handler(
        ctx: Context<DeployLpIdleBToSolend>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, LpVaultError::ZeroAmount);
        let lv = &mut ctx.accounts.lp_vault;
        require!(!lv.paused, LpVaultError::LpVaultPaused);
        require!(
            ctx.accounts.vault_token_b_account.amount >= amount,
            LpVaultError::InsufficientIdleBalance
        );

        let lp_vault_key = lv.key();
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[lv.authority_bump]];

        solend_deposit(
            CpiContext::new_with_signer(
                ctx.accounts.solend_program.to_account_info(),
                SolendDeposit {
                    vault_authority:          ctx.accounts.vault_authority.to_account_info(),
                    vault_token_account:      (*ctx.accounts.vault_token_b_account).clone(),
                    vault_collateral_account: (*ctx.accounts.lending_receipt_b).clone(),
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

        lv.lending_deployed_b = lv.lending_deployed_b
            .checked_add(amount).ok_or(LpVaultError::MathOverflow)?;
        emit!(LpIdleDeployed { lp_vault: lv.key(), amount });
        Ok(())
    }

    #[derive(Accounts)]
    pub struct RecallLpIdleBFromSolend<'info> {
        #[account(mut)] pub keeper: Signer<'info>,
        #[account(mut)]
        pub lp_vault: Box<Account<'info, LpVault>>,
        /// CHECK: PDA
        #[account(mut, seeds = [b"lp_vault_authority", lp_vault.key().as_ref()], bump = lp_vault.authority_bump)]
        pub vault_authority: UncheckedAccount<'info>,
        #[account(
            mut,
            seeds = [LP_LENDING_RECEIPT_B_SEED, lp_vault.key().as_ref()], bump,
        )]
        pub lending_receipt_b: Box<Account<'info, TokenAccount>>,
        #[account(mut, constraint = vault_token_b_account.key() == lp_vault.vault_token_b_account)]
        pub vault_token_b_account: Box<Account<'info, TokenAccount>>,
        /// CHECK: Solend validates
        #[account(mut)] pub reserve: UncheckedAccount<'info>,
        #[account(mut)] pub reserve_collateral_mint: Box<Account<'info, Mint>>,
        /// CHECK: Solend validates
        #[account(mut)] pub reserve_liquidity_supply: UncheckedAccount<'info>,
        /// CHECK: Solend validates
        #[account(mut)]
        pub lending_market: UncheckedAccount<'info>,
        /// CHECK: Solend validates
        pub lending_market_authority: UncheckedAccount<'info>,
        /// CHECK: Pyth oracle
        pub pyth_oracle: UncheckedAccount<'info>,
        /// CHECK: Switchboard oracle -- System Program ID when reserve has none configured
        pub switchboard_oracle: UncheckedAccount<'info>,
        /// CHECK: clock
        #[account(address = anchor_lang::solana_program::sysvar::clock::ID)]
        pub clock_sysvar: UncheckedAccount<'info>,
        pub token_program: Program<'info, Token>,
        /// CHECK: address-constrained to the real sysvar
        #[account(address = INSTRUCTIONS_SYSVAR_ID)]
        pub tx_instructions_sysvar: UncheckedAccount<'info>,
        /// CHECK: Solend program
        #[account(address = SOLEND_PROGRAM)]
        pub solend_program: UncheckedAccount<'info>,
    }

    pub fn recall_lp_idle_b_from_solend_handler(
        ctx: Context<RecallLpIdleBFromSolend>,
        collateral_amount: u64,
    ) -> Result<()> {
        require!(collateral_amount > 0, LpVaultError::ZeroAmount);
        let lv = &mut ctx.accounts.lp_vault;

        let lp_vault_key = lv.key();
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[lv.authority_bump]];

        let underlying_before = ctx.accounts.vault_token_b_account.amount;

        solend_withdraw(
            CpiContext::new_with_signer(
                ctx.accounts.solend_program.to_account_info(),
                SolendWithdraw {
                    vault_authority:          ctx.accounts.vault_authority.to_account_info(),
                    vault_collateral_account: (*ctx.accounts.lending_receipt_b).clone(),
                    vault_token_account:      (*ctx.accounts.vault_token_b_account).clone(),
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

        ctx.accounts.vault_token_b_account.reload()?;
        let received = ctx.accounts.vault_token_b_account.amount.saturating_sub(underlying_before);

        // Track only what was actually principal, not any yield realized on
        // exit -- mirrors settle_recall's shape in lib.rs without needing its
        // full generality (single protocol, no phantom-balance bookkeeping
        // yet; that's real future work once this is proven live).
        lv.lending_deployed_b = lv.lending_deployed_b.saturating_sub(
            std::cmp::min(lv.lending_deployed_b, received)
        );
        emit!(LpIdleRecalled { lp_vault: lv.key(), collateral_amount, received });
        Ok(())
    }
}

pub mod orca_lp {
    //! Orca Whirlpool-specific LP vault instructions.
    use super::*;

    // ── Account contexts ──────────────────────────────────────────────────

    /// Protocol-agnostic despite living in this module (LpVault.keeper is shared by
    /// both Orca and Raydium vaults) — placed here rather than a new top-level
    /// section purely to match the existing pattern of every LP instruction living
    /// inside one of the two protocol modules.
    ///
    /// WHY THIS EXISTS: LpVault never had a keeper setter (unlike the main Vault
    /// type's set_keeper), so a vault's `keeper` field was fixed forever at
    /// whatever init_*_lp_vault was called with. The first hand-created Orca vault
    /// (2026-08-27) was initialized with keeper == admin for convenience during
    /// testing — meaning the actual keeper bot's wallet (see keeper-cron.yml) gets
    /// Unauthorized on every collect_orca_lp_fees / redeploy_orca_lp_liquidity call
    /// against it, confirmed live 2026-09-01. This lets an existing vault be pointed
    /// at the real keeper wallet after the fact instead of only at init time.
    #[derive(Accounts)]
    pub struct SetLpKeeper<'info> {
        #[account(constraint = admin.key() == lp_vault.admin @ LpVaultError::Unauthorized)]
        pub admin: Signer<'info>,

        #[account(mut)]
        pub lp_vault: Box<Account<'info, LpVault>>,
    }

    pub fn set_lp_keeper_handler(ctx: Context<SetLpKeeper>, new_keeper: Pubkey) -> Result<()> {
        ctx.accounts.lp_vault.keeper = new_keeper;
        Ok(())
    }

    /// Two-step admin transfer for LP vaults, mirroring Vault's propose_admin/accept_admin
    /// exactly (see lib.rs). Added 2026-09-28 -- see LpVault.pending_admin's doc comment
    /// for why this didn't exist until now.
    #[derive(Accounts)]
    pub struct ProposeLpAdmin<'info> {
        #[account(constraint = admin.key() == lp_vault.admin @ LpVaultError::Unauthorized)]
        pub admin: Signer<'info>,

        #[account(mut)]
        pub lp_vault: Box<Account<'info, LpVault>>,
    }

    pub fn propose_lp_admin_handler(ctx: Context<ProposeLpAdmin>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.lp_vault.pending_admin = new_admin;
        Ok(())
    }

    #[derive(Accounts)]
    pub struct AcceptLpAdmin<'info> {
        pub new_admin: Signer<'info>,

        #[account(mut, constraint = lp_vault.pending_admin == new_admin.key() @ LpVaultError::NotPendingLpAdmin)]
        pub lp_vault: Box<Account<'info, LpVault>>,
    }

    pub fn accept_lp_admin_handler(ctx: Context<AcceptLpAdmin>) -> Result<()> {
        let v = &mut ctx.accounts.lp_vault;
        require!(v.pending_admin != Pubkey::default(), LpVaultError::NoPendingLpAdmin);
        v.admin = ctx.accounts.new_admin.key();
        v.pending_admin = Pubkey::default();
        Ok(())
    }

    /// Admin-closable: reclaims an LpVault's own rent once it's fully wound down. Added
    /// 2026-10-06 -- no close path ever existed for this account type (confirmed live:
    /// both LP vaults on the pre-relaunch program were permanently unclosable, ~0.0096 SOL
    /// of rent each abandoned when that program was closed). Requires the vault be
    /// genuinely empty (no liquidity, no shares) AND have no still-open external
    /// Whirlpool/Raydium position -- closing while position_active is true would abandon
    /// a real, possibly nonzero-value position with no account left to track it. Mirrors
    /// close_vault's zero-balance safety check on the Safe vault.
    pub fn close_lp_vault_handler(ctx: Context<CloseLpVault>) -> Result<()> {
        let v = &ctx.accounts.lp_vault;
        require!(v.total_liquidity == 0, LpVaultError::LpVaultNotEmpty);
        require!(v.total_shares == 0, LpVaultError::LpVaultNotEmpty);
        require!(!v.position_active, LpVaultError::LpVaultNotEmpty);
        Ok(())
    }

    #[derive(Accounts)]
    pub struct CloseLpVault<'info> {
        #[account(mut)]
        pub admin: Signer<'info>,
        #[account(
            mut,
            close = admin,
            constraint = lp_vault.admin == admin.key() @ LpVaultError::Unauthorized,
        )]
        pub lp_vault: Box<Account<'info, LpVault>>,
    }

    /// User-closable: reclaims an LpUserPosition's own rent once it's fully withdrawn.
    /// Same rationale and pattern as close_user_position on the Safe vault -- see that
    /// instruction's doc comment in lib.rs for the full incident writeup.
    pub fn close_lp_user_position_handler(ctx: Context<CloseLpUserPosition>) -> Result<()> {
        require!(ctx.accounts.user_position.shares == 0, LpVaultError::LpPositionNotEmpty);
        Ok(())
    }

    #[derive(Accounts)]
    pub struct CloseLpUserPosition<'info> {
        #[account(mut)]
        pub user: Signer<'info>,
        pub lp_vault: Box<Account<'info, LpVault>>,
        #[account(
            mut,
            close = user,
            seeds = [b"lp_position", lp_vault.key().as_ref(), user.key().as_ref()],
            bump = user_position.bump,
            constraint = user_position.owner == user.key() @ LpVaultError::Unauthorized,
            constraint = user_position.lp_vault == lp_vault.key() @ LpVaultError::Unauthorized,
        )]
        pub user_position: Box<Account<'info, LpUserPosition>>,
    }

    #[derive(Accounts)]
    #[instruction(params: InitLpVaultParams)]
    pub struct InitializeOrcaLpVault<'info> {
        #[account(mut)]
        pub admin: Signer<'info>,

        // Trailing protocol byte (0 = Orca) keeps this PDA distinct from a Raydium vault
        // on the identical (token_a, token_b, admin) triple — without it the two
        // instructions would derive the SAME address and only one protocol could ever
        // have a vault on a given pair. Found before either protocol had a live vault
        // on any pair, so no existing PDA needed migrating.
        #[account(
            init, payer = admin, space = LpVault::LEN,
            seeds = [b"lp_vault", token_a_mint.key().as_ref(), token_b_mint.key().as_ref(), admin.key().as_ref(), &[0u8]],
            bump,
        )]
        pub lp_vault: Box<Account<'info, LpVault>>,

        /// CHECK: PDA, verified by seeds. MUST be `mut`: the open_position CPI passes
        /// this as Orca's `funder` (writable + signer), and a CPI cannot escalate an
        /// account to writable if the outer instruction declared it read-only.
        /// Found by the local harness 2026-07-20 ("writable privilege escalated").
        #[account(mut, seeds = [b"lp_vault_authority", lp_vault.key().as_ref()], bump)]
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
        /// Position NFT mint. Does NOT exist yet - Orca's open_position inits it,
        /// so this must be an unvalidated Signer, never Account<Mint>. Typing it as
        /// Account<Mint> made Anchor deserialize it BEFORE the instruction body ran,
        /// failing with AccountNotInitialized (3012) and making this instruction
        /// permanently unreachable. Found by the local harness 2026-07-20 on the
        /// first ever execution of this code path.
        #[account(mut)]
        pub position_mint: Signer<'info>,
        /// CHECK: created by the open_position CPI as an ATA for position_mint owned
        /// by vault_authority. Same reason as above - cannot be Account<TokenAccount>
        /// because it does not exist when Anchor validates accounts.
        #[account(mut)]
        pub position_token_account: UncheckedAccount<'info>,
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
    pub struct DepositOrcaLp<'info> {
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

        /// CHECK: Whirlpool program validates
        #[account(mut, address = lp_vault.pool)]
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

        /// Live gate-token balance, read to snapshot tier_at_deposit. Same convention as
        /// the Safe vault's Deposit context: absent/None is valid whenever gating is
        /// disabled (gate_mint == SystemProgram), which is every LP vault today.
        #[account(constraint = user_gate_account.owner == user.key() && user_gate_account.mint == lp_vault.gate_mint @ LpVaultError::InvalidLpGateAccount)]
        pub user_gate_account: Option<Box<Account<'info, TokenAccount>>>,
    }

    #[derive(Accounts)]
    pub struct WithdrawOrcaLp<'info> {
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
        #[account(mut, address = lp_vault.pool)]
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

        /// Required only when a performance fee is actually owed (checked at runtime in the
        /// handler, since whether a fee is owed depends on profit which isn't known until
        /// the CPI executes). Added 2026-09-29 alongside the LP fee fix -- see
        /// LpUserPosition.deposited_amount_a/b's doc comment for the incident this closes.
        #[account(mut, constraint = treasury_token_a_account.owner == lp_vault.treasury @ LpVaultError::LpTreasuryOwnerMismatch)]
        pub treasury_token_a_account: Option<Box<Account<'info, TokenAccount>>>,
        #[account(mut, constraint = treasury_token_b_account.owner == lp_vault.treasury @ LpVaultError::LpTreasuryOwnerMismatch)]
        pub treasury_token_b_account: Option<Box<Account<'info, TokenAccount>>>,
        /// Live gate-token balance, read to resolve the current fee tier. Same
        /// gate_mint/owner validation as the Safe vault's withdraw() gate account.
        #[account(constraint = user_gate_account.owner == user.key() && user_gate_account.mint == lp_vault.gate_mint @ LpVaultError::InvalidLpGateAccount)]
        pub user_gate_account: Option<Box<Account<'info, TokenAccount>>>,
    }

    #[derive(Accounts)]
    pub struct ExitOrcaLpPosition<'info> {
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
        #[account(mut, address = lp_vault.pool)]
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

    #[derive(Accounts)]
    pub struct OpenNewOrcaLpPosition<'info> {
        /// Either the admin or the keeper. The keeper MUST be able to open a position:
        /// it is the thing that exits on a reposition, and if it cannot re-enter the
        /// vault sits in cash until a human intervenes.
        #[account(
            mut,
            constraint = authority.key() == lp_vault.admin || authority.key() == lp_vault.keeper
                @ LpVaultError::Unauthorized
        )]
        pub authority: Signer<'info>,

        #[account(mut, constraint = !lp_vault.position_active @ LpVaultError::PositionStillActive)]
        pub lp_vault: Box<Account<'info, LpVault>>,

        /// CHECK: PDA, verified by seeds
        #[account(mut, seeds = [b"lp_vault_authority", lp_vault.key().as_ref()], bump = lp_vault.authority_bump)]
        pub vault_authority: UncheckedAccount<'info>,

        /// CHECK: Whirlpool program validates + initializes
        #[account(mut)]
        pub position: UncheckedAccount<'info>,
        /// Position NFT mint. Does NOT exist yet - Orca's open_position inits it,
        /// so this must be an unvalidated Signer, never Account<Mint>. Typing it as
        /// Account<Mint> made Anchor deserialize it BEFORE the instruction body ran,
        /// failing with AccountNotInitialized (3012) and making this instruction
        /// permanently unreachable. Found by the local harness 2026-07-20 on the
        /// first ever execution of this code path.
        #[account(mut)]
        pub position_mint: Signer<'info>,
        /// CHECK: created by the open_position CPI as an ATA for position_mint owned
        /// by vault_authority. Same reason as above - cannot be Account<TokenAccount>
        /// because it does not exist when Anchor validates accounts.
        #[account(mut)]
        pub position_token_account: UncheckedAccount<'info>,
        /// CHECK: Whirlpool program validates; must match lp_vault.pool
        #[account(address = lp_vault.pool)]
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
    pub struct RedeployOrcaLpLiquidity<'info> {
        #[account(constraint = keeper.key() == lp_vault.keeper @ LpVaultError::Unauthorized)]
        pub keeper: Signer<'info>,

        #[account(mut, constraint = lp_vault.position_active @ LpVaultError::NoActivePosition)]
        pub lp_vault: Box<Account<'info, LpVault>>,

        /// CHECK: PDA, verified by seeds
        #[account(seeds = [b"lp_vault_authority", lp_vault.key().as_ref()], bump = lp_vault.authority_bump)]
        pub vault_authority: UncheckedAccount<'info>,

        #[account(mut, address = lp_vault.vault_token_a_account)]
        pub vault_token_a_account: Box<Account<'info, TokenAccount>>,
        #[account(mut, address = lp_vault.vault_token_b_account)]
        pub vault_token_b_account: Box<Account<'info, TokenAccount>>,

        /// CHECK: Whirlpool program validates
        #[account(mut, address = lp_vault.pool)]
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

    // ── Handlers ────────────────────────────────────────────────────────────

    pub fn initialize_orca_lp_vault_handler(
        ctx: Context<InitializeOrcaLpVault>,
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
                    position_mint:            ctx.accounts.position_mint.to_account_info(),
                    position_token_account:   ctx.accounts.position_token_account.to_account_info(),
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
        v.protocol                = LpProtocolKind::Orca;
        v.pool                    = ctx.accounts.whirlpool.key();
        v.position                = ctx.accounts.position.key();
        v.protocol_position       = Pubkey::default(); // unused for Orca
        v.position_mint           = ctx.accounts.position_mint.key();
        v.position_token_account  = ctx.accounts.position_token_account.key();
        v.token_a_mint            = ctx.accounts.token_a_mint.key();
        v.token_b_mint            = ctx.accounts.token_b_mint.key();
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
        v.pending_admin           = Pubkey::default(); // explicit, matching Vault's own init pattern
        v.gate_mint               = anchor_lang::solana_program::system_program::ID; // disabled by default, same convention as the Safe vault
        v.gold_threshold          = 0;
        v.silver_threshold        = 0;
        v.bronze_threshold        = 0;

        emit!(LpVaultInitialized { lp_vault: lp_vault_key, protocol: LpProtocolKind::Orca, pool: v.pool });
        Ok(())
    }

    pub fn deposit_orca_lp_handler(
        ctx: Context<DepositOrcaLp>,
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

        // Refund the unconsumed remainder to the user.
        //
        // `token_max_a`/`token_max_b` are slippage CAPS, not amounts: we transfer the
        // full cap in up front because Orca pulls from the vault's staging accounts,
        // but increase_liquidity consumes only what `liquidity_amount` actually needs.
        // Without this refund the difference is stranded in the vault with NO shares
        // minted against it — shares are calculated from `liquidity_amount`, so the
        // leftover belongs to nobody and withdraw (which only redeems from the
        // Whirlpool position) can never return it.
        //
        // Measured on the harness before this fix: depositing 2 SOL + 500 USDC with
        // generous caps put 0.000000523 SOL + 0.000851 USDC into the position and
        // stranded the rest; burning 100% of shares returned almost nothing.
        //
        // The staging accounts are pure pass-through, so refunding their ENTIRE
        // post-CPI balance is correct and self-healing: they always end at zero.
        ctx.accounts.vault_token_a_account.reload()?;
        ctx.accounts.vault_token_b_account.reload()?;

        let refund_a = ctx.accounts.vault_token_a_account.amount;
        if refund_a > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_token_a_account.to_account_info(),
                        to: ctx.accounts.user_token_a_account.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    &[seeds],
                ),
                refund_a,
            )?;
        }

        let refund_b = ctx.accounts.vault_token_b_account.amount;
        if refund_b > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_token_b_account.to_account_info(),
                        to: ctx.accounts.user_token_b_account.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    &[seeds],
                ),
                refund_b,
            )?;
        }
        msg!("deposit_orca_lp: refunded {} token_a / {} token_b to user", refund_a, refund_b);

        // Real amount actually consumed into the position -- token_max_a/b are caps, the
        // refund is whatever the CPI didn't use, so the difference is the real deposit.
        // This becomes the cost basis for the performance fee at withdrawal.
        let consumed_a = token_max_a.saturating_sub(refund_a);
        let consumed_b = token_max_b.saturating_sub(refund_b);

        let v = &mut ctx.accounts.lp_vault;
        let shares_to_mint = calculate_deposit_shares(liquidity_amount, v.total_liquidity, v.total_shares)?;

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
        let gate_mint = v.gate_mint;
        let gold_threshold = v.gold_threshold;
        let silver_threshold = v.silver_threshold;
        let bronze_threshold = v.bronze_threshold;

        let pos = &mut ctx.accounts.user_position;
        if pos.owner == Pubkey::default() {
            pos.owner = ctx.accounts.user.key();
            pos.lp_vault = lp_vault_key;
            pos.bump = ctx.bumps.user_position;
        }
        pos.shares = pos.shares.checked_add(shares_to_mint).ok_or(LpVaultError::MathOverflow)?;
        pos.liquidity_at_deposit = pos.liquidity_at_deposit.checked_add(liquidity_amount).ok_or(LpVaultError::MathOverflow)?;
        pos.deposited_amount_a = pos.deposited_amount_a.checked_add(consumed_a).ok_or(LpVaultError::MathOverflow)?;
        pos.deposited_amount_b = pos.deposited_amount_b.checked_add(consumed_b).ok_or(LpVaultError::MathOverflow)?;

        // Snapshot fee tier (worse of current vs. existing) -- same anti-flash-loan logic
        // as the Safe vault's deposit(). No-op while gating is disabled.
        if gate_mint != anchor_lang::solana_program::system_program::ID {
            let gate_balance = ctx.accounts.user_gate_account.as_ref().map_or(0, |a| a.amount);
            let tier_u8: u8 = if gate_balance >= gold_threshold { 0 }
                else if gate_balance >= silver_threshold { 1 }
                else if gate_balance >= bronze_threshold { 2 }
                else { 3 };
            pos.tier_at_deposit = pos.tier_at_deposit.max(tier_u8);
        }

        emit!(LpDeposited { lp_vault: lp_vault_key, user: ctx.accounts.user.key(), liquidity_amount, shares_minted: shares_to_mint });
        Ok(())
    }

    pub fn withdraw_orca_lp_handler(
        ctx: Context<WithdrawOrcaLp>,
        shares: u64,
        token_min_a: u64,
        token_min_b: u64,
    ) -> Result<()> {
        require!(shares > 0, LpVaultError::ZeroAmount);
        require!(ctx.accounts.user_position.shares >= shares, LpVaultError::InsufficientShares);
        require!(ctx.accounts.lp_vault.position_active, LpVaultError::NoActivePosition);

        let lp_vault_key = ctx.accounts.lp_vault.key();
        let authority_bump = ctx.accounts.lp_vault.authority_bump;
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];

        let v = &ctx.accounts.lp_vault;
        let total_shares_before = v.total_shares;
        let liquidity_amount = calculate_withdraw_liquidity(shares, v.total_liquidity, v.total_shares)?;

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

        anchor_spl::token::burn(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), anchor_spl::token::Burn {
                mint: ctx.accounts.lp_shares_mint.to_account_info(),
                from: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            }),
            shares,
        )?;

        ctx.accounts.vault_token_a_account.reload()?;
        ctx.accounts.vault_token_b_account.reload()?;
        let received_a = ctx.accounts.vault_token_a_account.amount.saturating_sub(vault_a_before);
        let received_b = ctx.accounts.vault_token_b_account.amount.saturating_sub(vault_b_before);
        require!(received_a >= token_min_a, LpVaultError::SlippageExceeded);
        require!(received_b >= token_min_b, LpVaultError::SlippageExceeded);

        // Pro-rata slice of the vault's IDLE tokens (the balance that was already there
        // before this CPI). Shares represent a claim on the whole vault, not just on the
        // deployed position — exit parks liquidity here, and without this the difference
        // is unredeemable. Uses the PRE-burn share count deliberately.
        let idle_a = vault_a_before
            .checked_mul(shares).and_then(|x| x.checked_div(total_shares_before)).unwrap_or(0);
        let idle_b = vault_b_before
            .checked_mul(shares).and_then(|x| x.checked_div(total_shares_before)).unwrap_or(0);
        let mut payout_a = received_a.saturating_add(idle_a);
        let mut payout_b = received_b.saturating_add(idle_b);
        msg!("lp withdraw: position {}/{} + idle {}/{}", received_a, received_b, idle_a, idle_b);

        // Performance fee on profit only, tiered by live gate-token balance (worse of live
        // vs. tier_at_deposit -- same anti-flash-loan logic as the Safe vault). Cost basis is
        // the pro-rata slice of this position's OWN real deposited amounts, not the pool's
        // current price, so it has no oracle dependency -- see LpUserPosition's doc comment.
        let pos_shares_before = ctx.accounts.user_position.shares;
        let cost_basis_a = ctx.accounts.user_position.deposited_amount_a
            .checked_mul(shares).and_then(|x| x.checked_div(pos_shares_before)).unwrap_or(0);
        let cost_basis_b = ctx.accounts.user_position.deposited_amount_b
            .checked_mul(shares).and_then(|x| x.checked_div(pos_shares_before)).unwrap_or(0);
        let profit_a = payout_a.saturating_sub(cost_basis_a);
        let profit_b = payout_b.saturating_sub(cost_basis_b);

        let gate_balance = ctx.accounts.user_gate_account.as_ref().map_or(0, |a| a.amount);
        let v_ro = &ctx.accounts.lp_vault;
        let fee_bps = resolve_lp_fee_bps(
            v_ro.gate_mint, v_ro.gold_threshold, v_ro.silver_threshold, v_ro.bronze_threshold,
            gate_balance, ctx.accounts.user_position.tier_at_deposit,
        );
        let fee_a = profit_a.checked_mul(fee_bps).and_then(|x| x.checked_div(LP_FEE_BPS_DENOM)).unwrap_or(0);
        let fee_b = profit_b.checked_mul(fee_bps).and_then(|x| x.checked_div(LP_FEE_BPS_DENOM)).unwrap_or(0);

        if fee_a > 0 || fee_b > 0 {
            require!(
                ctx.accounts.treasury_token_a_account.is_some() && ctx.accounts.treasury_token_b_account.is_some(),
                LpVaultError::LpTreasuryRequired
            );
        }
        payout_a = payout_a.saturating_sub(fee_a);
        payout_b = payout_b.saturating_sub(fee_b);

        if payout_a > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
                    from: ctx.accounts.vault_token_a_account.to_account_info(),
                    to: ctx.accounts.user_token_a_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                }, &[seeds]),
                payout_a,
            )?;
        }
        if payout_b > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
                    from: ctx.accounts.vault_token_b_account.to_account_info(),
                    to: ctx.accounts.user_token_b_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                }, &[seeds]),
                payout_b,
            )?;
        }
        if fee_a > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
                    from: ctx.accounts.vault_token_a_account.to_account_info(),
                    to: ctx.accounts.treasury_token_a_account.as_ref().unwrap().to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                }, &[seeds]),
                fee_a,
            )?;
        }
        if fee_b > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
                    from: ctx.accounts.vault_token_b_account.to_account_info(),
                    to: ctx.accounts.treasury_token_b_account.as_ref().unwrap().to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                }, &[seeds]),
                fee_b,
            )?;
        }

        let v = &mut ctx.accounts.lp_vault;
        v.total_liquidity = v.total_liquidity.saturating_sub(liquidity_amount);
        v.total_shares = v.total_shares.saturating_sub(shares);

        let pos = &mut ctx.accounts.user_position;
        pos.shares = pos.shares.saturating_sub(shares);
        pos.liquidity_at_deposit = pos.liquidity_at_deposit.saturating_sub(liquidity_amount);
        pos.deposited_amount_a = pos.deposited_amount_a.saturating_sub(cost_basis_a);
        pos.deposited_amount_b = pos.deposited_amount_b.saturating_sub(cost_basis_b);

        emit!(LpWithdrawn { lp_vault: lp_vault_key, user: ctx.accounts.user.key(), shares_burned: shares, liquidity_amount });
        Ok(())
    }

    pub fn exit_orca_lp_position_handler(ctx: Context<ExitOrcaLpPosition>) -> Result<()> {
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
                0,
                0,
                seeds,
            )?;
        }

        // Orca gates close_position on `is_position_empty`, which requires
        // fee_owed_a == 0 && fee_owed_b == 0 — NOT just zero liquidity. Any position
        // that earned fees would therefore refuse to close, stranding the exit and
        // leaving the vault's funds idle. Sweep the fees into the vault's token
        // accounts first; they are then redeployed with the principal on re-entry,
        // which is what makes LP yield actually compound.
        //
        // Unconditional on purpose: fees can be owed even when total_liquidity is 0
        // (earned before an earlier full withdraw), and collecting zero is a no-op.
        //
        // Rewards are the other half of `is_position_empty`. The SOL/USDC whirlpool
        // has emissions DISABLED (emissions_per_second = 0, active = false, checked
        // 2026-07-21), so reward_amount_owed stays 0 and close succeeds. If Orca ever
        // re-enables emissions this will start failing the same way — the fix is a
        // matching collect_reward CPI per active reward slot.
        orca_collect_fees(
            CpiContext::new_with_signer(
                ctx.accounts.whirlpool_program.to_account_info(),
                OrcaCollectFees {
                    whirlpool:              ctx.accounts.whirlpool.to_account_info(),
                    position_authority:     ctx.accounts.vault_authority.to_account_info(),
                    position:               ctx.accounts.position.to_account_info(),
                    position_token_account: (*ctx.accounts.position_token_account).clone(),
                    token_owner_account_a:  (*ctx.accounts.vault_token_a_account).clone(),
                    token_vault_a:          ctx.accounts.token_vault_a.to_account_info(),
                    token_owner_account_b:  (*ctx.accounts.vault_token_b_account).clone(),
                    token_vault_b:          ctx.accounts.token_vault_b.to_account_info(),
                    token_program:          ctx.accounts.token_program.clone(),
                    whirlpool_program:      ctx.accounts.whirlpool_program.to_account_info(),
                },
                &[seeds],
            ),
            seeds,
        )?;

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

    pub fn open_new_orca_lp_position_handler(
        ctx: Context<OpenNewOrcaLpPosition>,
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
                    position_mint:            ctx.accounts.position_mint.to_account_info(),
                    position_token_account:   ctx.accounts.position_token_account.to_account_info(),
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

        emit!(LpPositionReopened { lp_vault: lp_vault_key, tick_lower_index, tick_upper_index });
        Ok(())
    }

    pub fn redeploy_orca_lp_liquidity_handler(
        ctx: Context<RedeployOrcaLpLiquidity>,
        liquidity_amount: u128,
        token_max_a: u64,
        token_max_b: u64,
    ) -> Result<()> {
        require!(liquidity_amount > 0, LpVaultError::ZeroAmount);

        // CLAMP the slippage caps to what the vault actually holds — do NOT require the
        // vault to hold the full cap.
        //
        // token_max_{a,b} are UPPER BOUNDS ("never spend more than this"), not amounts.
        // The old guard demanded `idle >= token_max`, so the keeper's reposition failed
        // for any realistic cap: it would have had to set the cap exactly equal to its
        // idle balance, which defeats the purpose of a cap. Found by the local harness
        // 2026-07-20 — the vault held 0.178 USDC and a 500 USDC cap was rejected even
        // though the redeploy needed a tiny fraction of that.
        //
        // The check was also redundant: increase_liquidity fails on its own if it needs
        // more than the token accounts hold, so clamping is strictly safer AND correct —
        // the caller's intent (an upper bound) is preserved, and we never ask the pool to
        // pull more than exists.
        let token_max_a = token_max_a.min(ctx.accounts.vault_token_a_account.amount);
        let token_max_b = token_max_b.min(ctx.accounts.vault_token_b_account.amount);

        let lp_vault_key = ctx.accounts.lp_vault.key();
        let authority_bump = ctx.accounts.lp_vault.authority_bump;
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];

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

        let v = &mut ctx.accounts.lp_vault;
        v.total_liquidity = v.total_liquidity.checked_add(liquidity_amount).ok_or(LpVaultError::MathOverflow)?;

        emit!(LpLiquidityRedeployed { lp_vault: lp_vault_key, liquidity_amount });
        Ok(())
    }

    /// Harvest accrued swap fees from the position and immediately redeploy them as
    /// added liquidity — auto-compound, same model Vault::compound already uses for
    /// safe-vault lending yield. No separate per-user claim: share value simply
    /// reflects the compounded fees from here on.
    ///
    /// Reuses RedeployOrcaLpLiquidity's account set as-is: collect_fees needs exactly
    /// the same accounts increase_liquidity does (position, whirlpool, vault token
    /// accounts, token_vault_a/b, token_program), so no new Accounts struct is needed.
    ///
    /// Two CPIs, in order:
    ///  1. decrease_liquidity with liquidity_amount=0 — Orca only checkpoints
    ///     fee_owed_a/b onto the position when a liquidity-modifying instruction runs;
    ///     a zero-amount decrease is the standard way to sync fees without touching
    ///     principal (see orca_collect_fees's own doc comment on this).
    ///  2. collect_fees — transfers the now-checkpointed fee_owed_a/b out of the
    ///     position into the vault's own token accounts.
    ///
    /// The collected amount is measured directly from the vault token accounts'
    /// balance delta (not trusted from any CPI return value) — reading real state
    /// before/after is the same principle every other balance-sensitive handler in
    /// this program already follows.
    pub fn collect_orca_lp_fees_handler(ctx: Context<RedeployOrcaLpLiquidity>) -> Result<()> {
        let lp_vault_key = ctx.accounts.lp_vault.key();
        let authority_bump = ctx.accounts.lp_vault.authority_bump;
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];

        let balance_a_before = ctx.accounts.vault_token_a_account.amount;
        let balance_b_before = ctx.accounts.vault_token_b_account.amount;

        // NOT orca_decrease_liquidity(0, ...) — Orca's decrease_liquidity hard-rejects
        // a zero liquidity_amount (LiquidityZero), confirmed live against a real
        // mainnet position 2026-09-01. update_fees_and_rewards is Orca's own
        // purpose-built "checkpoint fee_owed without touching liquidity" instruction —
        // see its doc comment in adapters/orca.rs for the full story.
        orca_update_fees_and_rewards(
            &ctx.accounts.whirlpool_program.to_account_info(),
            &ctx.accounts.whirlpool.to_account_info(),
            &ctx.accounts.position.to_account_info(),
            &ctx.accounts.tick_array_lower.to_account_info(),
            &ctx.accounts.tick_array_upper.to_account_info(),
        )?;

        orca_collect_fees(
            CpiContext::new_with_signer(
                ctx.accounts.whirlpool_program.to_account_info(),
                OrcaCollectFees {
                    whirlpool:              ctx.accounts.whirlpool.to_account_info(),
                    position_authority:     ctx.accounts.vault_authority.to_account_info(),
                    position:               ctx.accounts.position.to_account_info(),
                    position_token_account: (*ctx.accounts.position_token_account).clone(),
                    token_owner_account_a:  (*ctx.accounts.vault_token_a_account).clone(),
                    token_vault_a:          ctx.accounts.token_vault_a.to_account_info(),
                    token_owner_account_b:  (*ctx.accounts.vault_token_b_account).clone(),
                    token_vault_b:          ctx.accounts.token_vault_b.to_account_info(),
                    token_program:          ctx.accounts.token_program.clone(),
                    whirlpool_program:      ctx.accounts.whirlpool_program.to_account_info(),
                },
                &[seeds],
            ),
            seeds,
        )?;

        ctx.accounts.vault_token_a_account.reload()?;
        ctx.accounts.vault_token_b_account.reload()?;
        let fees_a = ctx.accounts.vault_token_a_account.amount.saturating_sub(balance_a_before);
        let fees_b = ctx.accounts.vault_token_b_account.amount.saturating_sub(balance_b_before);

        let v = &mut ctx.accounts.lp_vault;
        v.lifetime_fees_a = v.lifetime_fees_a.saturating_add(fees_a);
        v.lifetime_fees_b = v.lifetime_fees_b.saturating_add(fees_b);

        emit!(LpFeesCollected { lp_vault: lp_vault_key, fees_a, fees_b });
        Ok(())
    }
}

pub mod raydium_lp {
    //! Raydium CLMM-specific LP vault instructions.
    use super::*;

    // ── Account contexts ──────────────────────────────────────────────────

    #[derive(Accounts)]
    #[instruction(params: InitLpVaultParams)]
    pub struct InitializeRaydiumLpVault<'info> {
        #[account(mut)]
        pub admin: Signer<'info>,

        // Trailing protocol byte (1 = Raydium) — see InitializeOrcaLpVault's identical
        // seed for why this exists: without it, an Orca and a Raydium vault on the same
        // (token_a, token_b, admin) triple would derive the identical PDA.
        #[account(
            init, payer = admin, space = LpVault::LEN,
            seeds = [b"lp_vault", token_a_mint.key().as_ref(), token_b_mint.key().as_ref(), admin.key().as_ref(), &[1u8]],
            bump,
        )]
        pub lp_vault: Box<Account<'info, LpVault>>,

        /// CHECK: PDA, verified by seeds. MUST be `mut`: the open_position CPI passes
        /// this as the funder (writable + signer), and a CPI cannot escalate an account
        /// to writable if the outer instruction declared it read-only. Mirrors the Orca
        /// fix, which was proven on the harness 2026-07-20.
        #[account(mut, seeds = [b"lp_vault_authority", lp_vault.key().as_ref()], bump)]
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

        // ── Raydium open_position accounts (see adapters::raydium::RaydiumOpenPosition) ──
        /// Position NFT mint. Does NOT exist yet — Raydium's open_position inits it,
        /// so it must be an unvalidated Signer. Typing it Account<Mint> makes Anchor
        /// deserialize it before the body runs (AccountNotInitialized 3012) AND leaves
        /// isSigner=false so the outer tx cannot carry the signature Raydium needs.
        /// Identical to the Orca bug proven on the harness 2026-07-20.
        #[account(mut)]
        pub position_nft_mint: Signer<'info>,
        /// CHECK: created by the open_position CPI; does not exist at validation time.
        #[account(mut)]
        pub position_nft_account: UncheckedAccount<'info>,
        /// CHECK: Metaplex program validates + initializes
        #[account(mut)]
        pub metadata_account: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (zero-copy on-chain)
        #[account(mut)]
        pub pool_state: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (deprecated but still required —
        /// see adapters/raydium.rs PDA seed notes). MUST be `mut`: open_position
        /// initializes it on first use for a tick range, and every liquidity change
        /// writes to it.
        #[account(mut)]
        pub protocol_position: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_lower: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_upper: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates + initializes (PDA)
        #[account(mut)]
        pub personal_position: UncheckedAccount<'info>,

        #[account(mut)]
        pub token_account_0: Box<Account<'info, TokenAccount>>,
        #[account(mut)]
        pub token_account_1: Box<Account<'info, TokenAccount>>,
        /// CHECK: Raydium validates against pool_state.token_vault_0
        #[account(mut)]
        pub token_vault_0: UncheckedAccount<'info>,
        /// CHECK: Raydium validates against pool_state.token_vault_1
        #[account(mut)]
        pub token_vault_1: UncheckedAccount<'info>,

        pub rent: Sysvar<'info, Rent>,
        pub system_program: Program<'info, System>,
        pub token_program: Program<'info, Token>,
        /// CHECK: associated token program
        pub associated_token_program: UncheckedAccount<'info>,
        /// CHECK: address verified in adapter
        #[account(address = METADATA_PROGRAM_ID)]
        pub metadata_program: UncheckedAccount<'info>,
        /// CHECK: address verified in adapter
        #[account(address = RAYDIUM_CLMM_PROGRAM_ID)]
        pub raydium_program: UncheckedAccount<'info>,

        /// Always required by Raydium's open_position once the chosen tick range falls
        /// outside its default in-place bitmap (see adapters/raydium.rs's module-level
        /// note) — created automatically by Raydium's own create_pool, so every real
        /// pool already has one; this program only derives + forwards it.
        /// CHECK: seeds verified; Raydium validates the account itself
        #[account(mut, seeds = [TICK_ARRAY_BITMAP_EXTENSION_SEED, pool_state.key().as_ref()], bump, seeds::program = RAYDIUM_CLMM_PROGRAM_ID)]
        pub tick_array_bitmap_extension: UncheckedAccount<'info>,
    }

    #[derive(Accounts)]
    pub struct DepositRaydiumLp<'info> {
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

        #[account(constraint = nft_account.amount == 1)]
        pub nft_account: Box<Account<'info, TokenAccount>>,
        /// CHECK: Raydium program validates
        #[account(mut, address = lp_vault.pool)]
        pub pool_state: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (deprecated but still required)
        /// CHECK: Raydium validates. MUST be `mut` — every liquidity change writes to
        /// the protocol position's accumulators; a CPI cannot escalate a read-only
        /// account to writable.
        #[account(mut, address = lp_vault.protocol_position)]
        pub protocol_position: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates
        #[account(mut, address = lp_vault.position)]
        pub personal_position: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_lower: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_upper: UncheckedAccount<'info>,
        /// CHECK: Raydium validates against pool_state.token_vault_0
        #[account(mut)]
        pub token_vault_0: UncheckedAccount<'info>,
        /// CHECK: Raydium validates against pool_state.token_vault_1
        #[account(mut)]
        pub token_vault_1: UncheckedAccount<'info>,

        pub token_program: Program<'info, Token>,
        pub system_program: Program<'info, System>,
        /// CHECK: address verified in adapter
        #[account(address = RAYDIUM_CLMM_PROGRAM_ID)]
        pub raydium_program: UncheckedAccount<'info>,

        /// See InitializeRaydiumLpVault's identical field — increase_liquidity has the
        /// same remaining_accounts[0] requirement as open_position.
        /// CHECK: seeds verified; Raydium validates the account itself
        #[account(mut, seeds = [TICK_ARRAY_BITMAP_EXTENSION_SEED, pool_state.key().as_ref()], bump, seeds::program = RAYDIUM_CLMM_PROGRAM_ID)]
        pub tick_array_bitmap_extension: UncheckedAccount<'info>,

        /// Same tier-snapshot purpose as DepositOrcaLp's identical field.
        #[account(constraint = user_gate_account.owner == user.key() && user_gate_account.mint == lp_vault.gate_mint @ LpVaultError::InvalidLpGateAccount)]
        pub user_gate_account: Option<Box<Account<'info, TokenAccount>>>,
    }

    #[derive(Accounts)]
    pub struct WithdrawRaydiumLp<'info> {
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

        #[account(constraint = nft_account.amount == 1)]
        pub nft_account: Box<Account<'info, TokenAccount>>,
        /// CHECK: Raydium program validates
        #[account(mut, address = lp_vault.pool)]
        pub pool_state: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (deprecated but still required)
        /// CHECK: Raydium validates. MUST be `mut` — every liquidity change writes to
        /// the protocol position's accumulators; a CPI cannot escalate a read-only
        /// account to writable.
        #[account(mut, address = lp_vault.protocol_position)]
        pub protocol_position: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates
        #[account(mut, address = lp_vault.position)]
        pub personal_position: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_lower: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_upper: UncheckedAccount<'info>,
        /// CHECK: Raydium validates against pool_state.token_vault_0
        #[account(mut)]
        pub token_vault_0: UncheckedAccount<'info>,
        /// CHECK: Raydium validates against pool_state.token_vault_1
        #[account(mut)]
        pub token_vault_1: UncheckedAccount<'info>,

        pub token_program: Program<'info, Token>,
        /// CHECK: address verified in adapter
        #[account(address = RAYDIUM_CLMM_PROGRAM_ID)]
        pub raydium_program: UncheckedAccount<'info>,

        /// decrease_liquidity finds this by KEY MATCH anywhere among the accounts it's
        /// given (unlike open_position/increase_liquidity's rigid remaining_accounts[0]
        /// — verified against Raydium's own source), so position relative to any reward
        /// accounts here doesn't matter.
        /// CHECK: seeds verified; Raydium validates the account itself
        #[account(mut, seeds = [TICK_ARRAY_BITMAP_EXTENSION_SEED, pool_state.key().as_ref()], bump, seeds::program = RAYDIUM_CLMM_PROGRAM_ID)]
        pub tick_array_bitmap_extension: UncheckedAccount<'info>,

        /// Same performance-fee accounts as WithdrawOrcaLp -- see that struct's doc comment.
        #[account(mut, constraint = treasury_token_a_account.owner == lp_vault.treasury @ LpVaultError::LpTreasuryOwnerMismatch)]
        pub treasury_token_a_account: Option<Box<Account<'info, TokenAccount>>>,
        #[account(mut, constraint = treasury_token_b_account.owner == lp_vault.treasury @ LpVaultError::LpTreasuryOwnerMismatch)]
        pub treasury_token_b_account: Option<Box<Account<'info, TokenAccount>>>,
        #[account(constraint = user_gate_account.owner == user.key() && user_gate_account.mint == lp_vault.gate_mint @ LpVaultError::InvalidLpGateAccount)]
        pub user_gate_account: Option<Box<Account<'info, TokenAccount>>>,
    }

    #[derive(Accounts)]
    pub struct ExitRaydiumLpPosition<'info> {
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

        #[account(mut, constraint = position_nft_account.amount == 1, address = lp_vault.position_token_account)]
        pub position_nft_account: Box<Account<'info, TokenAccount>>,
        /// CHECK: Raydium program validates
        #[account(mut, address = lp_vault.pool)]
        pub pool_state: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (deprecated but still required)
        /// CHECK: Raydium validates. MUST be `mut` — every liquidity change writes to
        /// the protocol position's accumulators; a CPI cannot escalate a read-only
        /// account to writable.
        #[account(mut, address = lp_vault.protocol_position)]
        pub protocol_position: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates
        #[account(mut, address = lp_vault.position)]
        pub personal_position: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (address = personal_position.nft_mint)
        #[account(mut, address = lp_vault.position_mint)]
        pub position_nft_mint: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_lower: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_upper: UncheckedAccount<'info>,
        /// CHECK: Raydium validates against pool_state.token_vault_0
        #[account(mut)]
        pub token_vault_0: UncheckedAccount<'info>,
        /// CHECK: Raydium validates against pool_state.token_vault_1
        #[account(mut)]
        pub token_vault_1: UncheckedAccount<'info>,

        pub system_program: Program<'info, System>,
        pub token_program: Program<'info, Token>,
        /// CHECK: address verified in adapter
        #[account(address = RAYDIUM_CLMM_PROGRAM_ID)]
        pub raydium_program: UncheckedAccount<'info>,

        /// See WithdrawRaydiumLp's identical field — decrease_liquidity finds this by
        /// key match, so it works alongside any reward accounts too.
        /// CHECK: seeds verified; Raydium validates the account itself
        #[account(mut, seeds = [TICK_ARRAY_BITMAP_EXTENSION_SEED, pool_state.key().as_ref()], bump, seeds::program = RAYDIUM_CLMM_PROGRAM_ID)]
        pub tick_array_bitmap_extension: UncheckedAccount<'info>,
    }

    #[derive(Accounts)]
    pub struct OpenNewRaydiumLpPosition<'info> {
        /// Either the admin or the keeper. The keeper MUST be able to open a position:
        /// it is the thing that exits on a reposition, and if it cannot re-enter the
        /// vault sits in cash until a human intervenes.
        #[account(
            mut,
            constraint = authority.key() == lp_vault.admin || authority.key() == lp_vault.keeper
                @ LpVaultError::Unauthorized
        )]
        pub authority: Signer<'info>,

        #[account(mut, constraint = !lp_vault.position_active @ LpVaultError::PositionStillActive)]
        pub lp_vault: Box<Account<'info, LpVault>>,

        /// CHECK: PDA, verified by seeds
        #[account(mut, seeds = [b"lp_vault_authority", lp_vault.key().as_ref()], bump = lp_vault.authority_bump)]
        pub vault_authority: UncheckedAccount<'info>,

        #[account(mut)]
        /// Fresh position NFT mint for the NEW position — does not exist yet; Raydium's
        /// open_position inits it. Must be a Signer for the same reason as the init
        /// handler (AccountNotInitialized 3012, and isSigner must be true).
        pub position_nft_mint: Signer<'info>,
        #[account(mut)]
        /// CHECK: created by the open_position CPI; does not exist at validation time.
        pub position_nft_account: UncheckedAccount<'info>,
        /// CHECK: Metaplex program validates + initializes
        #[account(mut)]
        pub metadata_account: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates; must match lp_vault.pool
        #[account(mut, address = lp_vault.pool)]
        pub pool_state: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (deprecated but still required). MUST be
        /// `mut`: this is the NEW range's protocol position, which Raydium initializes
        /// on first use and writes to on every liquidity change.
        #[account(mut)]
        pub protocol_position: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_lower: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_upper: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates + initializes (PDA)
        #[account(mut)]
        pub personal_position: UncheckedAccount<'info>,

        #[account(mut, address = lp_vault.vault_token_a_account)]
        pub token_account_0: Box<Account<'info, TokenAccount>>,
        #[account(mut, address = lp_vault.vault_token_b_account)]
        pub token_account_1: Box<Account<'info, TokenAccount>>,
        /// CHECK: Raydium validates against pool_state.token_vault_0
        #[account(mut)]
        pub token_vault_0: UncheckedAccount<'info>,
        /// CHECK: Raydium validates against pool_state.token_vault_1
        #[account(mut)]
        pub token_vault_1: UncheckedAccount<'info>,

        pub rent: Sysvar<'info, Rent>,
        pub system_program: Program<'info, System>,
        pub token_program: Program<'info, Token>,
        /// CHECK: associated token program
        pub associated_token_program: UncheckedAccount<'info>,
        /// CHECK: address verified in adapter
        #[account(address = METADATA_PROGRAM_ID)]
        pub metadata_program: UncheckedAccount<'info>,
        /// CHECK: address verified in adapter
        #[account(address = RAYDIUM_CLMM_PROGRAM_ID)]
        pub raydium_program: UncheckedAccount<'info>,

        /// See InitializeRaydiumLpVault's identical field for why this is always
        /// required, not conditional.
        /// CHECK: seeds verified; Raydium validates the account itself
        #[account(mut, seeds = [TICK_ARRAY_BITMAP_EXTENSION_SEED, pool_state.key().as_ref()], bump, seeds::program = RAYDIUM_CLMM_PROGRAM_ID)]
        pub tick_array_bitmap_extension: UncheckedAccount<'info>,
    }

    #[derive(Accounts)]
    pub struct RedeployRaydiumLpLiquidity<'info> {
        #[account(constraint = keeper.key() == lp_vault.keeper @ LpVaultError::Unauthorized)]
        pub keeper: Signer<'info>,

        #[account(mut, constraint = lp_vault.position_active @ LpVaultError::NoActivePosition)]
        pub lp_vault: Box<Account<'info, LpVault>>,

        /// CHECK: PDA, verified by seeds
        #[account(seeds = [b"lp_vault_authority", lp_vault.key().as_ref()], bump = lp_vault.authority_bump)]
        pub vault_authority: UncheckedAccount<'info>,

        #[account(mut, address = lp_vault.vault_token_a_account)]
        pub vault_token_a_account: Box<Account<'info, TokenAccount>>,
        #[account(mut, address = lp_vault.vault_token_b_account)]
        pub vault_token_b_account: Box<Account<'info, TokenAccount>>,

        #[account(constraint = nft_account.amount == 1)]
        pub nft_account: Box<Account<'info, TokenAccount>>,
        /// CHECK: Raydium program validates
        #[account(mut, address = lp_vault.pool)]
        pub pool_state: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (deprecated but still required)
        /// CHECK: Raydium validates. MUST be `mut` — every liquidity change writes to
        /// the protocol position's accumulators; a CPI cannot escalate a read-only
        /// account to writable.
        #[account(mut, address = lp_vault.protocol_position)]
        pub protocol_position: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates
        #[account(mut, address = lp_vault.position)]
        pub personal_position: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_lower: UncheckedAccount<'info>,
        /// CHECK: Raydium program validates (PDA)
        #[account(mut)]
        pub tick_array_upper: UncheckedAccount<'info>,
        /// CHECK: Raydium validates against pool_state.token_vault_0
        #[account(mut)]
        pub token_vault_0: UncheckedAccount<'info>,
        /// CHECK: Raydium validates against pool_state.token_vault_1
        #[account(mut)]
        pub token_vault_1: UncheckedAccount<'info>,

        pub token_program: Program<'info, Token>,
        /// CHECK: address verified in adapter
        #[account(address = RAYDIUM_CLMM_PROGRAM_ID)]
        pub raydium_program: UncheckedAccount<'info>,

        /// See DepositRaydiumLp's identical field — increase_liquidity has the same
        /// remaining_accounts[0] requirement as open_position.
        /// CHECK: seeds verified; Raydium validates the account itself
        #[account(mut, seeds = [TICK_ARRAY_BITMAP_EXTENSION_SEED, pool_state.key().as_ref()], bump, seeds::program = RAYDIUM_CLMM_PROGRAM_ID)]
        pub tick_array_bitmap_extension: UncheckedAccount<'info>,
    }

    // ── Handlers ────────────────────────────────────────────────────────────

    pub fn initialize_raydium_lp_vault_handler(
        ctx: Context<InitializeRaydiumLpVault>,
        params: InitLpVaultParams,
    ) -> Result<()> {
        require!(params.name.len() <= 32, LpVaultError::NameTooLong);

        let lp_vault_key = ctx.accounts.lp_vault.key();
        let authority_bump = ctx.bumps.vault_authority;
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];

        // Opened with zero initial liquidity, mirroring the Orca vault's
        // two-step flow (open, then deposit_*_lp for the first real
        // deposit) — even though Raydium's own instruction supports
        // depositing liquidity in the same call, keeping both protocols'
        // vault-creation semantics identical is worth more than saving one
        // instruction.
        raydium_open_position(
            CpiContext::new_with_signer(
                ctx.accounts.raydium_program.to_account_info(),
                RaydiumOpenPosition {
                    vault_authority:          ctx.accounts.vault_authority.to_account_info(),
                    position_nft_mint:        ctx.accounts.position_nft_mint.to_account_info(),
                    position_nft_account:     ctx.accounts.position_nft_account.to_account_info(),
                    metadata_account:         ctx.accounts.metadata_account.to_account_info(),
                    pool_state:               ctx.accounts.pool_state.to_account_info(),
                    protocol_position:        ctx.accounts.protocol_position.to_account_info(),
                    tick_array_lower:         ctx.accounts.tick_array_lower.to_account_info(),
                    tick_array_upper:         ctx.accounts.tick_array_upper.to_account_info(),
                    personal_position:        ctx.accounts.personal_position.to_account_info(),
                    token_account_0:          (*ctx.accounts.token_account_0).clone(),
                    token_account_1:          (*ctx.accounts.token_account_1).clone(),
                    token_vault_0:            ctx.accounts.token_vault_0.to_account_info(),
                    token_vault_1:            ctx.accounts.token_vault_1.to_account_info(),
                    rent:                     ctx.accounts.rent.clone(),
                    system_program:           ctx.accounts.system_program.clone(),
                    token_program:            ctx.accounts.token_program.clone(),
                    associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
                    metadata_program:         ctx.accounts.metadata_program.to_account_info(),
                    raydium_program:          ctx.accounts.raydium_program.to_account_info(),
                    tick_array_bitmap_extension: ctx.accounts.tick_array_bitmap_extension.to_account_info(),
                },
                &[seeds],
            ),
            params.tick_lower_index,
            params.tick_upper_index,
            params.tick_array_lower_start_index,
            params.tick_array_upper_start_index,
            0, // liquidity — opened empty, see comment above
            0, // amount_0_max
            0, // amount_1_max
            seeds,
        )?;

        let v = &mut ctx.accounts.lp_vault;
        v.admin                  = ctx.accounts.admin.key();
        v.keeper                 = params.keeper;
        v.treasury               = params.treasury;
        v.protocol                = LpProtocolKind::Raydium;
        v.pool                    = ctx.accounts.pool_state.key();
        v.position                = ctx.accounts.personal_position.key();
        v.protocol_position       = ctx.accounts.protocol_position.key();
        v.position_mint           = ctx.accounts.position_nft_mint.key();
        v.position_token_account  = ctx.accounts.position_nft_account.key();
        v.token_a_mint            = ctx.accounts.token_a_mint.key();
        v.token_b_mint            = ctx.accounts.token_b_mint.key();
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
        v.pending_admin           = Pubkey::default(); // explicit, matching Vault's own init pattern
        v.gate_mint               = anchor_lang::solana_program::system_program::ID; // disabled by default, same convention as the Safe vault
        v.gold_threshold          = 0;
        v.silver_threshold        = 0;
        v.bronze_threshold        = 0;

        emit!(LpVaultInitialized { lp_vault: lp_vault_key, protocol: LpProtocolKind::Raydium, pool: v.pool });
        Ok(())
    }

    pub fn deposit_raydium_lp_handler(
        ctx: Context<DepositRaydiumLp>,
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

        raydium_increase_liquidity(
            CpiContext::new_with_signer(
                ctx.accounts.raydium_program.to_account_info(),
                RaydiumModifyLiquidity {
                    vault_authority:   ctx.accounts.vault_authority.to_account_info(),
                    nft_account:       (*ctx.accounts.nft_account).clone(),
                    pool_state:        ctx.accounts.pool_state.to_account_info(),
                    protocol_position: ctx.accounts.protocol_position.to_account_info(),
                    personal_position: ctx.accounts.personal_position.to_account_info(),
                    tick_array_lower:  ctx.accounts.tick_array_lower.to_account_info(),
                    tick_array_upper:  ctx.accounts.tick_array_upper.to_account_info(),
                    token_account_0:   (*ctx.accounts.vault_token_a_account).clone(),
                    token_account_1:   (*ctx.accounts.vault_token_b_account).clone(),
                    token_vault_0:     ctx.accounts.token_vault_0.to_account_info(),
                    token_vault_1:     ctx.accounts.token_vault_1.to_account_info(),
                    token_program:     ctx.accounts.token_program.clone(),
                    raydium_program:   ctx.accounts.raydium_program.to_account_info(),
                },
                &[seeds],
            ).with_remaining_accounts(vec![ctx.accounts.tick_array_bitmap_extension.to_account_info()]),
            liquidity_amount,
            token_max_a,
            token_max_b,
            seeds,
        )?;

        // Refund the unconsumed remainder — see deposit_orca_lp_handler for full
        // reasoning. token_max_{a,b} are slippage CAPS, not amounts; without this the
        // difference is stranded in the vault with no shares against it, and withdraw
        // (which only redeems from the position) can never return it.
        ctx.accounts.vault_token_a_account.reload()?;
        ctx.accounts.vault_token_b_account.reload()?;

        let refund_a = ctx.accounts.vault_token_a_account.amount;
        if refund_a > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_token_a_account.to_account_info(),
                        to: ctx.accounts.user_token_a_account.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    &[seeds],
                ),
                refund_a,
            )?;
        }

        let refund_b = ctx.accounts.vault_token_b_account.amount;
        if refund_b > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_token_b_account.to_account_info(),
                        to: ctx.accounts.user_token_b_account.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    &[seeds],
                ),
                refund_b,
            )?;
        }
        msg!("deposit_raydium_lp: refunded {} token_a / {} token_b to user", refund_a, refund_b);

        // Real amount actually consumed -- see deposit_orca_lp_handler for full reasoning.
        let consumed_a = token_max_a.saturating_sub(refund_a);
        let consumed_b = token_max_b.saturating_sub(refund_b);

        let v = &mut ctx.accounts.lp_vault;
        let shares_to_mint = calculate_deposit_shares(liquidity_amount, v.total_liquidity, v.total_shares)?;

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
        let gate_mint = v.gate_mint;
        let gold_threshold = v.gold_threshold;
        let silver_threshold = v.silver_threshold;
        let bronze_threshold = v.bronze_threshold;

        let pos = &mut ctx.accounts.user_position;
        if pos.owner == Pubkey::default() {
            pos.owner = ctx.accounts.user.key();
            pos.lp_vault = lp_vault_key;
            pos.bump = ctx.bumps.user_position;
        }
        pos.shares = pos.shares.checked_add(shares_to_mint).ok_or(LpVaultError::MathOverflow)?;
        pos.liquidity_at_deposit = pos.liquidity_at_deposit.checked_add(liquidity_amount).ok_or(LpVaultError::MathOverflow)?;
        pos.deposited_amount_a = pos.deposited_amount_a.checked_add(consumed_a).ok_or(LpVaultError::MathOverflow)?;
        pos.deposited_amount_b = pos.deposited_amount_b.checked_add(consumed_b).ok_or(LpVaultError::MathOverflow)?;

        if gate_mint != anchor_lang::solana_program::system_program::ID {
            let gate_balance = ctx.accounts.user_gate_account.as_ref().map_or(0, |a| a.amount);
            let tier_u8: u8 = if gate_balance >= gold_threshold { 0 }
                else if gate_balance >= silver_threshold { 1 }
                else if gate_balance >= bronze_threshold { 2 }
                else { 3 };
            pos.tier_at_deposit = pos.tier_at_deposit.max(tier_u8);
        }

        emit!(LpDeposited { lp_vault: lp_vault_key, user: ctx.accounts.user.key(), liquidity_amount, shares_minted: shares_to_mint });
        Ok(())
    }

    pub fn withdraw_raydium_lp_handler<'info>(
        ctx: Context<'_, '_, '_, 'info, WithdrawRaydiumLp<'info>>,
        shares: u64,
        token_min_a: u64,
        token_min_b: u64,
    ) -> Result<()> {
        require!(shares > 0, LpVaultError::ZeroAmount);
        require!(ctx.accounts.user_position.shares >= shares, LpVaultError::InsufficientShares);
        require!(ctx.accounts.lp_vault.position_active, LpVaultError::NoActivePosition);

        let lp_vault_key = ctx.accounts.lp_vault.key();
        let authority_bump = ctx.accounts.lp_vault.authority_bump;
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];

        let v = &ctx.accounts.lp_vault;
        let total_shares_before = v.total_shares;
        let liquidity_amount = calculate_withdraw_liquidity(shares, v.total_liquidity, v.total_shares)?;

        let vault_a_before = ctx.accounts.vault_token_a_account.amount;
        let vault_b_before = ctx.accounts.vault_token_b_account.amount;

        raydium_decrease_liquidity(
            CpiContext::new_with_signer(
                ctx.accounts.raydium_program.to_account_info(),
                RaydiumModifyLiquidity {
                    vault_authority:   ctx.accounts.vault_authority.to_account_info(),
                    nft_account:       (*ctx.accounts.nft_account).clone(),
                    pool_state:        ctx.accounts.pool_state.to_account_info(),
                    protocol_position: ctx.accounts.protocol_position.to_account_info(),
                    personal_position: ctx.accounts.personal_position.to_account_info(),
                    tick_array_lower:  ctx.accounts.tick_array_lower.to_account_info(),
                    tick_array_upper:  ctx.accounts.tick_array_upper.to_account_info(),
                    token_account_0:   (*ctx.accounts.vault_token_a_account).clone(),
                    token_account_1:   (*ctx.accounts.vault_token_b_account).clone(),
                    token_vault_0:     ctx.accounts.token_vault_0.to_account_info(),
                    token_vault_1:     ctx.accounts.token_vault_1.to_account_info(),
                    token_program:     ctx.accounts.token_program.clone(),
                    raydium_program:   ctx.accounts.raydium_program.to_account_info(),
                },
                &[seeds],
            )
            // Raydium validates remaining_accounts against the pool's initialized
            // reward count; a CpiContext only carries them if the caller attaches
            // them, so forward this instruction's own. tick_array_bitmap_extension is
            // appended too — decrease_liquidity finds it by key match anywhere in this
            // list (unlike open_position/increase_liquidity's rigid [0] index), so
            // order relative to reward accounts doesn't matter.
            .with_remaining_accounts({
                let mut accs = ctx.remaining_accounts.to_vec();
                accs.push(ctx.accounts.tick_array_bitmap_extension.to_account_info());
                accs
            }),
            liquidity_amount,
            token_min_a,
            token_min_b,
            seeds,
        )?;

        anchor_spl::token::burn(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), anchor_spl::token::Burn {
                mint: ctx.accounts.lp_shares_mint.to_account_info(),
                from: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            }),
            shares,
        )?;

        ctx.accounts.vault_token_a_account.reload()?;
        ctx.accounts.vault_token_b_account.reload()?;
        let received_a = ctx.accounts.vault_token_a_account.amount.saturating_sub(vault_a_before);
        let received_b = ctx.accounts.vault_token_b_account.amount.saturating_sub(vault_b_before);
        require!(received_a >= token_min_a, LpVaultError::SlippageExceeded);
        require!(received_b >= token_min_b, LpVaultError::SlippageExceeded);

        // Pro-rata slice of the vault's IDLE tokens (the balance that was already there
        // before this CPI). Shares represent a claim on the whole vault, not just on the
        // deployed position — exit parks liquidity here, and without this the difference
        // is unredeemable. Uses the PRE-burn share count deliberately.
        let idle_a = vault_a_before
            .checked_mul(shares).and_then(|x| x.checked_div(total_shares_before)).unwrap_or(0);
        let idle_b = vault_b_before
            .checked_mul(shares).and_then(|x| x.checked_div(total_shares_before)).unwrap_or(0);
        let mut payout_a = received_a.saturating_add(idle_a);
        let mut payout_b = received_b.saturating_add(idle_b);
        msg!("lp withdraw: position {}/{} + idle {}/{}", received_a, received_b, idle_a, idle_b);

        // Performance fee on profit only, tiered by live gate-token balance -- see
        // withdraw_orca_lp_handler's identical logic for the full rationale.
        let pos_shares_before = ctx.accounts.user_position.shares;
        let cost_basis_a = ctx.accounts.user_position.deposited_amount_a
            .checked_mul(shares).and_then(|x| x.checked_div(pos_shares_before)).unwrap_or(0);
        let cost_basis_b = ctx.accounts.user_position.deposited_amount_b
            .checked_mul(shares).and_then(|x| x.checked_div(pos_shares_before)).unwrap_or(0);
        let profit_a = payout_a.saturating_sub(cost_basis_a);
        let profit_b = payout_b.saturating_sub(cost_basis_b);

        let gate_balance = ctx.accounts.user_gate_account.as_ref().map_or(0, |a| a.amount);
        let v_ro = &ctx.accounts.lp_vault;
        let fee_bps = resolve_lp_fee_bps(
            v_ro.gate_mint, v_ro.gold_threshold, v_ro.silver_threshold, v_ro.bronze_threshold,
            gate_balance, ctx.accounts.user_position.tier_at_deposit,
        );
        let fee_a = profit_a.checked_mul(fee_bps).and_then(|x| x.checked_div(LP_FEE_BPS_DENOM)).unwrap_or(0);
        let fee_b = profit_b.checked_mul(fee_bps).and_then(|x| x.checked_div(LP_FEE_BPS_DENOM)).unwrap_or(0);

        if fee_a > 0 || fee_b > 0 {
            require!(
                ctx.accounts.treasury_token_a_account.is_some() && ctx.accounts.treasury_token_b_account.is_some(),
                LpVaultError::LpTreasuryRequired
            );
        }
        payout_a = payout_a.saturating_sub(fee_a);
        payout_b = payout_b.saturating_sub(fee_b);

        if payout_a > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
                    from: ctx.accounts.vault_token_a_account.to_account_info(),
                    to: ctx.accounts.user_token_a_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                }, &[seeds]),
                payout_a,
            )?;
        }
        if payout_b > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
                    from: ctx.accounts.vault_token_b_account.to_account_info(),
                    to: ctx.accounts.user_token_b_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                }, &[seeds]),
                payout_b,
            )?;
        }
        if fee_a > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
                    from: ctx.accounts.vault_token_a_account.to_account_info(),
                    to: ctx.accounts.treasury_token_a_account.as_ref().unwrap().to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                }, &[seeds]),
                fee_a,
            )?;
        }
        if fee_b > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
                    from: ctx.accounts.vault_token_b_account.to_account_info(),
                    to: ctx.accounts.treasury_token_b_account.as_ref().unwrap().to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                }, &[seeds]),
                fee_b,
            )?;
        }

        let v = &mut ctx.accounts.lp_vault;
        v.total_liquidity = v.total_liquidity.saturating_sub(liquidity_amount);
        v.total_shares = v.total_shares.saturating_sub(shares);

        let pos = &mut ctx.accounts.user_position;
        pos.shares = pos.shares.saturating_sub(shares);
        pos.liquidity_at_deposit = pos.liquidity_at_deposit.saturating_sub(liquidity_amount);
        pos.deposited_amount_a = pos.deposited_amount_a.saturating_sub(cost_basis_a);
        pos.deposited_amount_b = pos.deposited_amount_b.saturating_sub(cost_basis_b);

        emit!(LpWithdrawn { lp_vault: lp_vault_key, user: ctx.accounts.user.key(), shares_burned: shares, liquidity_amount });
        Ok(())
    }

    pub fn exit_raydium_lp_position_handler<'info>(
        ctx: Context<'_, '_, '_, 'info, ExitRaydiumLpPosition<'info>>,
    ) -> Result<()> {
        let lp_vault_key = ctx.accounts.lp_vault.key();
        let authority_bump = ctx.accounts.lp_vault.authority_bump;
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];
        let total_liquidity = ctx.accounts.lp_vault.total_liquidity;

        if total_liquidity > 0 {
            raydium_decrease_liquidity(
                CpiContext::new_with_signer(
                    ctx.accounts.raydium_program.to_account_info(),
                    RaydiumModifyLiquidity {
                        vault_authority:   ctx.accounts.vault_authority.to_account_info(),
                        nft_account:       (*ctx.accounts.position_nft_account).clone(),
                        pool_state:        ctx.accounts.pool_state.to_account_info(),
                        protocol_position: ctx.accounts.protocol_position.to_account_info(),
                        personal_position: ctx.accounts.personal_position.to_account_info(),
                        tick_array_lower:  ctx.accounts.tick_array_lower.to_account_info(),
                        tick_array_upper:  ctx.accounts.tick_array_upper.to_account_info(),
                        token_account_0:   (*ctx.accounts.vault_token_a_account).clone(),
                        token_account_1:   (*ctx.accounts.vault_token_b_account).clone(),
                        token_vault_0:     ctx.accounts.token_vault_0.to_account_info(),
                        token_vault_1:     ctx.accounts.token_vault_1.to_account_info(),
                        token_program:     ctx.accounts.token_program.clone(),
                        raydium_program:   ctx.accounts.raydium_program.to_account_info(),
                    },
                    &[seeds],
                )
                // Raydium validates remaining_accounts against the pool's initialized
                // reward count; a CpiContext only carries them if the caller attaches
                // them, so forward this instruction's own. tick_array_bitmap_extension
                // is appended too — see WithdrawRaydiumLp's identical handler for why
                // key-match ordering doesn't matter here.
                .with_remaining_accounts({
                    let mut accs = ctx.remaining_accounts.to_vec();
                    accs.push(ctx.accounts.tick_array_bitmap_extension.to_account_info());
                    accs
                }),
                total_liquidity,
                0,
                0,
                seeds,
            )?;
        }

        raydium_close_position(
            CpiContext::new_with_signer(
                ctx.accounts.raydium_program.to_account_info(),
                RaydiumClosePosition {
                    vault_authority:        ctx.accounts.vault_authority.to_account_info(),
                    position_nft_mint:      ctx.accounts.position_nft_mint.to_account_info(),
                    position_nft_account:   (*ctx.accounts.position_nft_account).clone(),
                    personal_position:      ctx.accounts.personal_position.to_account_info(),
                    system_program:         ctx.accounts.system_program.clone(),
                    token_program:          ctx.accounts.token_program.clone(),
                    raydium_program:        ctx.accounts.raydium_program.to_account_info(),
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

    pub fn open_new_raydium_lp_position_handler(
        ctx: Context<OpenNewRaydiumLpPosition>,
        tick_lower_index: i32,
        tick_upper_index: i32,
        tick_array_lower_start_index: i32,
        tick_array_upper_start_index: i32,
    ) -> Result<()> {
        let lp_vault_key = ctx.accounts.lp_vault.key();
        let authority_bump = ctx.accounts.lp_vault.authority_bump;
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];

        raydium_open_position(
            CpiContext::new_with_signer(
                ctx.accounts.raydium_program.to_account_info(),
                RaydiumOpenPosition {
                    vault_authority:          ctx.accounts.vault_authority.to_account_info(),
                    position_nft_mint:        ctx.accounts.position_nft_mint.to_account_info(),
                    position_nft_account:     ctx.accounts.position_nft_account.to_account_info(),
                    metadata_account:         ctx.accounts.metadata_account.to_account_info(),
                    pool_state:               ctx.accounts.pool_state.to_account_info(),
                    protocol_position:        ctx.accounts.protocol_position.to_account_info(),
                    tick_array_lower:         ctx.accounts.tick_array_lower.to_account_info(),
                    tick_array_upper:         ctx.accounts.tick_array_upper.to_account_info(),
                    personal_position:        ctx.accounts.personal_position.to_account_info(),
                    token_account_0:          (*ctx.accounts.token_account_0).clone(),
                    token_account_1:          (*ctx.accounts.token_account_1).clone(),
                    token_vault_0:            ctx.accounts.token_vault_0.to_account_info(),
                    token_vault_1:            ctx.accounts.token_vault_1.to_account_info(),
                    rent:                     ctx.accounts.rent.clone(),
                    system_program:           ctx.accounts.system_program.clone(),
                    token_program:            ctx.accounts.token_program.clone(),
                    associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
                    metadata_program:         ctx.accounts.metadata_program.to_account_info(),
                    raydium_program:          ctx.accounts.raydium_program.to_account_info(),
                    tick_array_bitmap_extension: ctx.accounts.tick_array_bitmap_extension.to_account_info(),
                },
                &[seeds],
            ),
            tick_lower_index,
            tick_upper_index,
            tick_array_lower_start_index,
            tick_array_upper_start_index,
            0,
            0,
            0,
            seeds,
        )?;

        let v = &mut ctx.accounts.lp_vault;
        v.position                = ctx.accounts.personal_position.key();
        v.protocol_position       = ctx.accounts.protocol_position.key();
        v.position_mint           = ctx.accounts.position_nft_mint.key();
        v.position_token_account  = ctx.accounts.position_nft_account.key();
        v.tick_lower_index        = tick_lower_index;
        v.tick_upper_index        = tick_upper_index;
        v.position_active         = true;

        emit!(LpPositionReopened { lp_vault: lp_vault_key, tick_lower_index, tick_upper_index });
        Ok(())
    }

    pub fn redeploy_raydium_lp_liquidity_handler(
        ctx: Context<RedeployRaydiumLpLiquidity>,
        liquidity_amount: u128,
        token_max_a: u64,
        token_max_b: u64,
    ) -> Result<()> {
        require!(liquidity_amount > 0, LpVaultError::ZeroAmount);

        // CLAMP the slippage caps to what the vault actually holds — do NOT require the
        // vault to hold the full cap.
        //
        // token_max_{a,b} are UPPER BOUNDS ("never spend more than this"), not amounts.
        // The old guard demanded `idle >= token_max`, so the keeper's reposition failed
        // for any realistic cap: it would have had to set the cap exactly equal to its
        // idle balance, which defeats the purpose of a cap. Found by the local harness
        // 2026-07-20 — the vault held 0.178 USDC and a 500 USDC cap was rejected even
        // though the redeploy needed a tiny fraction of that.
        //
        // The check was also redundant: increase_liquidity fails on its own if it needs
        // more than the token accounts hold, so clamping is strictly safer AND correct —
        // the caller's intent (an upper bound) is preserved, and we never ask the pool to
        // pull more than exists.
        let token_max_a = token_max_a.min(ctx.accounts.vault_token_a_account.amount);
        let token_max_b = token_max_b.min(ctx.accounts.vault_token_b_account.amount);

        let lp_vault_key = ctx.accounts.lp_vault.key();
        let authority_bump = ctx.accounts.lp_vault.authority_bump;
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];

        raydium_increase_liquidity(
            CpiContext::new_with_signer(
                ctx.accounts.raydium_program.to_account_info(),
                RaydiumModifyLiquidity {
                    vault_authority:   ctx.accounts.vault_authority.to_account_info(),
                    nft_account:       (*ctx.accounts.nft_account).clone(),
                    pool_state:        ctx.accounts.pool_state.to_account_info(),
                    protocol_position: ctx.accounts.protocol_position.to_account_info(),
                    personal_position: ctx.accounts.personal_position.to_account_info(),
                    tick_array_lower:  ctx.accounts.tick_array_lower.to_account_info(),
                    tick_array_upper:  ctx.accounts.tick_array_upper.to_account_info(),
                    token_account_0:   (*ctx.accounts.vault_token_a_account).clone(),
                    token_account_1:   (*ctx.accounts.vault_token_b_account).clone(),
                    token_vault_0:     ctx.accounts.token_vault_0.to_account_info(),
                    token_vault_1:     ctx.accounts.token_vault_1.to_account_info(),
                    token_program:     ctx.accounts.token_program.clone(),
                    raydium_program:   ctx.accounts.raydium_program.to_account_info(),
                },
                &[seeds],
            ).with_remaining_accounts(vec![ctx.accounts.tick_array_bitmap_extension.to_account_info()]),
            liquidity_amount,
            token_max_a,
            token_max_b,
            seeds,
        )?;

        let v = &mut ctx.accounts.lp_vault;
        v.total_liquidity = v.total_liquidity.checked_add(liquidity_amount).ok_or(LpVaultError::MathOverflow)?;

        emit!(LpLiquidityRedeployed { lp_vault: lp_vault_key, liquidity_amount });
        Ok(())
    }

    /// Harvest accrued swap fees + reward emissions from the position and immediately
    /// redeploy them as added liquidity — auto-compound, same model Vault::compound
    /// already uses for safe-vault lending yield, and the same design as
    /// collect_orca_lp_fees_handler above.
    ///
    /// Unlike Orca (which needs a separate collect_fees CPI), Raydium's own
    /// decrease_liquidity ALWAYS collects accrued fees and rewards as part of any
    /// liquidity change — confirmed against Raydium's real source this project
    /// already read closely for the tick_array_bitmap_extension fix. A liquidity_amount
    /// of 0 changes no principal but still triggers that same collection, landing the
    /// harvested tokens directly in the vault's own token accounts. One CPI, not two.
    ///
    /// Reuses RedeployRaydiumLpLiquidity's account set as-is — decrease_liquidity needs
    /// exactly the same accounts increase_liquidity does.
    pub fn collect_raydium_lp_fees_handler<'info>(ctx: Context<'_, '_, '_, 'info, RedeployRaydiumLpLiquidity<'info>>) -> Result<()> {
        let lp_vault_key = ctx.accounts.lp_vault.key();
        let authority_bump = ctx.accounts.lp_vault.authority_bump;
        let seeds: &[&[u8]] = &[b"lp_vault_authority", lp_vault_key.as_ref(), &[authority_bump]];

        let balance_a_before = ctx.accounts.vault_token_a_account.amount;
        let balance_b_before = ctx.accounts.vault_token_b_account.amount;

        raydium_decrease_liquidity(
            CpiContext::new_with_signer(
                ctx.accounts.raydium_program.to_account_info(),
                RaydiumModifyLiquidity {
                    vault_authority:   ctx.accounts.vault_authority.to_account_info(),
                    nft_account:       (*ctx.accounts.nft_account).clone(),
                    pool_state:        ctx.accounts.pool_state.to_account_info(),
                    protocol_position: ctx.accounts.protocol_position.to_account_info(),
                    personal_position: ctx.accounts.personal_position.to_account_info(),
                    tick_array_lower:  ctx.accounts.tick_array_lower.to_account_info(),
                    tick_array_upper:  ctx.accounts.tick_array_upper.to_account_info(),
                    token_account_0:   (*ctx.accounts.vault_token_a_account).clone(),
                    token_account_1:   (*ctx.accounts.vault_token_b_account).clone(),
                    token_vault_0:     ctx.accounts.token_vault_0.to_account_info(),
                    token_vault_1:     ctx.accounts.token_vault_1.to_account_info(),
                    token_program:     ctx.accounts.token_program.clone(),
                    raydium_program:   ctx.accounts.raydium_program.to_account_info(),
                },
                &[seeds],
            )
            // Same as withdraw_raydium_lp_handler: forward this instruction's own
            // remaining_accounts (reward vault + recipient pairs, set up client-side)
            // plus tick_array_bitmap_extension, which decrease_liquidity finds by key
            // match anywhere in this list.
            .with_remaining_accounts({
                let mut accs = ctx.remaining_accounts.to_vec();
                accs.push(ctx.accounts.tick_array_bitmap_extension.to_account_info());
                accs
            }),
            0, 0, 0, seeds,
        )?;

        ctx.accounts.vault_token_a_account.reload()?;
        ctx.accounts.vault_token_b_account.reload()?;
        let fees_a = ctx.accounts.vault_token_a_account.amount.saturating_sub(balance_a_before);
        let fees_b = ctx.accounts.vault_token_b_account.amount.saturating_sub(balance_b_before);

        let v = &mut ctx.accounts.lp_vault;
        v.lifetime_fees_a = v.lifetime_fees_a.saturating_add(fees_a);
        v.lifetime_fees_b = v.lifetime_fees_b.saturating_add(fees_b);

        emit!(LpFeesCollected { lp_vault: lp_vault_key, fees_a, fees_b });
        Ok(())
    }
}
