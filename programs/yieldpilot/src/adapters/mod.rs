use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum ProtocolKind {
    Kamino   = 0,
    Marinade = 1,
}

impl Default for ProtocolKind {
    fn default() -> Self { ProtocolKind::Kamino }
}

/// Per-protocol slot stored inside the Vault account.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct ProtocolAdapter {
    pub kind:                  ProtocolKind,
    /// Kamino → reserve pubkey.  Marinade → state pubkey.
    pub external_state:        Pubkey,
    /// Vault's receipt-token ATA (kUSDC for Kamino, mSOL for Marinade).
    pub vault_receipt_account: Pubkey,
    /// Base-asset lamports currently deployed here.
    pub deployed_balance:      u64,
    /// Target share of vault in basis points.
    pub target_bps:            u64,
    /// Human-readable label, null-terminated UTF-8.
    pub label:                 [u8; 24],
}

impl ProtocolAdapter {
    pub const SIZE: usize = 1 + 32 + 32 + 8 + 8 + 24; // 105, round to 112

    pub fn label_str(&self) -> &str {
        let end = self.label.iter().position(|&b| b == 0).unwrap_or(24);
        core::str::from_utf8(&self.label[..end]).unwrap_or("?")
    }
}

/// Compute deposit/withdraw delta for one protocol to hit its target.
/// Returns (deposit_needed, withdraw_needed) — exactly one will be > 0.
pub fn compute_delta(adapter: &ProtocolAdapter, total: u64, bps_denom: u64) -> (u64, u64) {
    let target = (total as u128)
        .saturating_mul(adapter.target_bps as u128)
        .saturating_div(bps_denom as u128) as u64;
    if target > adapter.deployed_balance {
        (target - adapter.deployed_balance, 0)
    } else {
        (0, adapter.deployed_balance - target)
    }
}

pub fn assert_state_matches(adapter: &ProtocolAdapter, supplied: &Pubkey) -> Result<()> {
    require_keys_eq!(adapter.external_state, *supplied, AdapterError::StateMismatch);
    Ok(())
}

#[error_code]
pub enum AdapterError {
    #[msg("Unsupported protocol kind")]
    UnsupportedProtocol,
    #[msg("Protocol state account mismatch")]
    StateMismatch,
    #[msg("Insufficient deployed balance for recall")]
    InsufficientDeployedBalance,
    #[msg("Vault is paused")]
    VaultPaused,
}

pub mod kamino;
pub mod marinade;
pub mod spl_stake_pool;
pub mod solend;
pub mod marginfi;
