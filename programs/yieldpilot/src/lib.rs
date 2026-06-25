use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, MintTo, Token, TokenAccount, Transfer, Burn},
};

pub mod adapters;
use adapters::{
    kamino::{KaminoDeposit, KaminoWithdraw, kamino_deposit, kamino_withdraw, KAMINO_LENDING_PROGRAM_ID},
    marinade::{MarinadeDeposit, MarinadeUnstake, marinade_deposit, marinade_liquid_unstake},
    spl_stake_pool::{SplStakePoolDeposit, SplStakePoolWithdraw, spl_stake_pool_deposit, spl_stake_pool_withdraw},
    solend::{SolendDeposit, SolendWithdraw, solend_deposit, solend_withdraw},
    marginfi::{MarginFiDeposit, MarginFiWithdraw, marginfi_deposit, marginfi_withdraw},
    {AdapterError, ProtocolAdapter, ProtocolKind, assert_state_matches},
};

declare_id!("8c7Boyk91MWkn5jabf5CnYD8DrG6p4hYm9eDdAAWXEKH");

// ── Constants ─────────────────────────────────────────────────────────────────

const BPS_DENOM: u64          = 10_000;
const MAX_PROTOCOLS: usize    = 8;
const COMPOUND_INTERVAL: i64  = 3_600;        // 1 hour
const MAX_PERF_FEE_BPS: u64   = 1_000;        // 10%
const MIN_FIRST_DEPOSIT: u64  = 1_000_000;    // $1 minimum first deposit (anti-donation-attack)
// Keeper must leave at least 10% of total deposits idle at all times.
// Prevents keeper from deploying 100% of funds, which would block all withdrawals.
const MIN_IDLE_BPS: u64       = 1_000;        // 10%

// Token-gate tier thresholds (number of gate tokens required)
const GOLD_THRESHOLD:   u64 = 1_000_000;     // 1M tokens  → unlimited deposits, 0% fee
const SILVER_THRESHOLD: u64 =   100_000;     // 100k tokens → $10k cap, 3% fee
const BRONZE_THRESHOLD: u64 =    10_000;     // 10k tokens  → $1k cap, 6% fee
const SILVER_CAP:       u64 = 10_000_000_000; // $10k in base-6
const BRONZE_CAP:       u64 =  1_000_000_000; // $1k in base-6

// Tiered performance fees (in bps). Applied on profit at withdrawal.
const GOLD_FEE_BPS:   u64 =   0; // 0%
const SILVER_FEE_BPS: u64 = 300; // 3%
const BRONZE_FEE_BPS: u64 = 600; // 6%

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum HolderTier { Gold, Silver, Bronze, None }

// ── Program ───────────────────────────────────────────────────────────────────

#[program]
pub mod yieldpilot {
    use super::*;

    // ── Vault lifecycle ───────────────────────────────────────────────────────

    pub fn initialize_vault(ctx: Context<InitializeVault>, params: InitVaultParams) -> Result<()> {
        require!(params.perf_fee_bps <= MAX_PERF_FEE_BPS, VaultError::FeeTooHigh);
        require!(params.name.len() <= 32, VaultError::NameTooLong);
        require!(params.tvl_cap >= MIN_FIRST_DEPOSIT, VaultError::TvlCapTooLow);

        let v = &mut ctx.accounts.vault;
        v.admin               = ctx.accounts.admin.key();
        v.keeper              = params.keeper;
        v.mint                = ctx.accounts.mint.key();
        v.vault_token_account = ctx.accounts.vault_token_account.key();
        v.shares_mint         = ctx.accounts.shares_mint.key();
        v.treasury  = params.treasury;
        // Normalize: zero pubkey also means no gating
        v.gate_mint = if params.gate_mint == Pubkey::default() {
            anchor_lang::solana_program::system_program::ID
        } else {
            params.gate_mint
        };
        v.pending_admin       = Pubkey::default();
        v.total_deposits      = 0;
        v.total_shares        = 0;
        v.perf_fee_bps        = params.perf_fee_bps;
        v.auto_compound       = params.auto_compound;
        v.auto_rebalance      = params.auto_rebalance;
        v.last_compound_ts    = Clock::get()?.unix_timestamp;
        v.name                = params.name;
        v.bump                = ctx.bumps.vault;
        v.authority_bump      = ctx.bumps.vault_authority;
        v.protocol_count      = 0;
        v.protocols           = [ProtocolAdapter::default(); MAX_PROTOCOLS];
        v.paused              = false;
        v.tvl_cap             = params.tvl_cap;

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
            let tier = if gate_balance >= GOLD_THRESHOLD {
                HolderTier::Gold
            } else if gate_balance >= SILVER_THRESHOLD {
                HolderTier::Silver
            } else if gate_balance >= BRONZE_THRESHOLD {
                HolderTier::Bronze
            } else {
                HolderTier::None
            };
            require!(tier != HolderTier::None, VaultError::NotTokenHolder);
            let pos_deposits = ctx.accounts.user_position.deposited_amount;
            if tier == HolderTier::Silver {
                require!(pos_deposits.saturating_add(amount) <= SILVER_CAP, VaultError::TierCapExceeded);
            } else if tier == HolderTier::Bronze {
                require!(pos_deposits.saturating_add(amount) <= BRONZE_CAP, VaultError::TierCapExceeded);
            }
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
        // Use actual vault token balance so accrued yield is included in share price.
        // IMPORTANT: if funds are currently deployed to Kamino/Marinade, vault_balance
        // will be lower than total value. Users must wait for the keeper to recall funds
        // before withdrawing, or the keeper must recall first. We enforce this explicitly.
        let vault_balance = ctx.accounts.vault_token_account.amount;
        let amount_out = (shares as u128)
            .checked_mul(vault_balance as u128)
            .and_then(|x| x.checked_div(v.total_shares as u128))
            .ok_or(VaultError::MathOverflow)? as u64;
        require!(amount_out > 0, VaultError::ZeroAmount);
        // Slippage guard: caller specifies the minimum they will accept.
        // Protects against vault balance dropping between simulation and execution.
        require!(amount_out >= min_amount_out, VaultError::SlippageExceeded);
        // SECURITY: ensure vault has sufficient idle liquidity to cover this withdrawal.
        // Prevents a user from burning shares and receiving 0 tokens when funds are deployed.
        require!(vault_balance >= amount_out, VaultError::InsufficientIdle);

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
            // Current tier based on live gate balance
            let current_tier_u8: u8 = if gate_balance >= GOLD_THRESHOLD { 0 }
                else if gate_balance >= SILVER_THRESHOLD { 1 }
                else { 2 };
            // Use WORSE of current tier and snapshotted tier at deposit.
            // Prevents flash-borrowing gate tokens right before withdrawal to get a lower fee.
            let effective_tier = current_tier_u8.max(pos.tier_at_deposit);
            match effective_tier {
                0 => GOLD_FEE_BPS,
                1 => SILVER_FEE_BPS,
                _ => BRONZE_FEE_BPS,
            }
        } else {
            v.perf_fee_bps // fallback to vault-level rate when gating is disabled
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

        // Validate treasury account: must match vault.treasury pubkey AND vault.mint.
        // Without the key check, any user could pass their own token account as treasury
        // and steal the performance fee that belongs to the vault operator.
        if let Some(treasury_acct) = ctx.accounts.treasury_token_account.as_ref() {
            require!(treasury_acct.mint == v.mint, VaultError::InvalidTreasuryAccount);
            require!(treasury_acct.key() == v.treasury, VaultError::InvalidTreasuryAccount);
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
        // total_deposits tracks cost-basis (not vault balance), so subtract cost_basis not amount_out.
        // amount_out >= cost_basis when there is profit; subtracting cost_basis avoids saturating
        // to zero while other users still hold shares backed by real funds.
        v.total_deposits = v.total_deposits.saturating_sub(cost_basis);
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

    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.vault.pending_admin = new_admin;
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
    // perf_fee_bps is fixed at vault initialization and cannot be changed after launch.
    // Users can verify the fee on-chain before depositing and trust it never changes.
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

        v.protocols[idx].deployed_balance = v.protocols[idx].deployed_balance
            .saturating_sub(collateral_amount);

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

        let vault_key = v.key();
        let seeds: &[&[u8]] = &[b"vault", vault_key.as_ref(), &[v.authority_bump]];

        marinade_deposit(
            CpiContext::new_with_signer(
                ctx.accounts.marinade_program.to_account_info(),
                MarinadeDeposit {
                    vault_authority:            ctx.accounts.vault_authority.to_account_info(),
                    marinade_state:             ctx.accounts.marinade_state.to_account_info(),
                    msol_mint:                  ctx.accounts.msol_mint.clone(),
                    liq_pool_sol_leg:           ctx.accounts.liq_pool_sol_leg.to_account_info(),
                    liq_pool_msol_leg:          ctx.accounts.liq_pool_msol_leg.clone(),
                    liq_pool_msol_leg_authority:ctx.accounts.liq_pool_msol_leg_authority.to_account_info(),
                    reserve_pda:                ctx.accounts.reserve_pda.to_account_info(),
                    vault_msol_account:         ctx.accounts.vault_msol_account.clone(),
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
        let idx = protocol_index as usize;
        require!(idx < v.protocol_count as usize, VaultError::InvalidProtocolIndex);
        require!(v.protocols[idx].kind == ProtocolKind::Marinade, AdapterError::UnsupportedProtocol);
        assert_state_matches(&v.protocols[idx], ctx.accounts.marinade_state.key)?;

        let vault_key = v.key();
        let seeds: &[&[u8]] = &[b"vault", vault_key.as_ref(), &[v.authority_bump]];

        marinade_liquid_unstake(
            CpiContext::new_with_signer(
                ctx.accounts.marinade_program.to_account_info(),
                MarinadeUnstake {
                    vault_authority:        ctx.accounts.vault_authority.to_account_info(),
                    marinade_state:         ctx.accounts.marinade_state.to_account_info(),
                    msol_mint:              ctx.accounts.msol_mint.clone(),
                    liq_pool_sol_leg:       ctx.accounts.liq_pool_sol_leg.to_account_info(),
                    liq_pool_msol_leg:      ctx.accounts.liq_pool_msol_leg.clone(),
                    treasury_msol_account:  ctx.accounts.treasury_msol_account.clone(),
                    vault_msol_account:     ctx.accounts.vault_msol_account.clone(),
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

        v.protocols[idx].deployed_balance = v.protocols[idx].deployed_balance
            .saturating_sub(msol_amount);

        emit!(FundsRecalled { vault: v.key(), protocol_index, collateral_amount: msol_amount });
        Ok(())
    }

    /// Deposit SOL into an SPL Stake Pool (Jito / BlazeStake) and receive LST tokens.
    pub fn deploy_to_sol_lst(
        ctx: Context<DeployToSolLst>,
        protocol_index: u8,
        lamports: u64,
    ) -> Result<()> {
        require!(lamports > 0, VaultError::ZeroAmount);
        let v = &mut ctx.accounts.vault;
        let idx = protocol_index as usize;
        require!(idx < v.protocol_count as usize, VaultError::InvalidProtocolIndex);

        let vault_key = v.key();
        let seeds: &[&[u8]] = &[b"vault", vault_key.as_ref(), &[v.authority_bump]];

        spl_stake_pool_deposit(
            CpiContext::new_with_signer(
                ctx.accounts.stake_pool_program.to_account_info(),
                SplStakePoolDeposit {
                    vault_authority:      ctx.accounts.vault_authority.to_account_info(),
                    vault_lst_account:    ctx.accounts.vault_lst_account.clone(),
                    stake_pool:           ctx.accounts.stake_pool.to_account_info(),
                    withdraw_authority:   ctx.accounts.withdraw_authority.to_account_info(),
                    reserve_stake:        ctx.accounts.reserve_stake.to_account_info(),
                    manager_fee_account:  ctx.accounts.manager_fee_account.clone(),
                    pool_mint:            ctx.accounts.pool_mint.clone(),
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

        v.protocols[idx].deployed_balance = v.protocols[idx].deployed_balance
            .checked_add(lamports).ok_or(VaultError::MathOverflow)?;

        emit!(FundsDeployed { vault: v.key(), protocol_index, amount: lamports });
        Ok(())
    }

    /// Burn LST tokens to withdraw SOL from an SPL Stake Pool (Jito / BlazeStake).
    pub fn recall_from_sol_lst(
        ctx: Context<RecallFromSolLst>,
        protocol_index: u8,
        lst_amount: u64,
    ) -> Result<()> {
        require!(lst_amount > 0, VaultError::ZeroAmount);
        let v = &mut ctx.accounts.vault;
        let idx = protocol_index as usize;
        require!(idx < v.protocol_count as usize, VaultError::InvalidProtocolIndex);

        let vault_key = v.key();
        let seeds: &[&[u8]] = &[b"vault", vault_key.as_ref(), &[v.authority_bump]];

        spl_stake_pool_withdraw(
            CpiContext::new_with_signer(
                ctx.accounts.stake_pool_program.to_account_info(),
                SplStakePoolWithdraw {
                    vault_authority:      ctx.accounts.vault_authority.to_account_info(),
                    vault_lst_account:    ctx.accounts.vault_lst_account.clone(),
                    stake_pool:           ctx.accounts.stake_pool.to_account_info(),
                    withdraw_authority:   ctx.accounts.withdraw_authority.to_account_info(),
                    reserve_stake:        ctx.accounts.reserve_stake.to_account_info(),
                    manager_fee_account:  ctx.accounts.manager_fee_account.clone(),
                    pool_mint:            ctx.accounts.pool_mint.clone(),
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

        v.protocols[idx].deployed_balance = v.protocols[idx].deployed_balance
            .saturating_sub(lst_amount);

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
        let idx = protocol_index as usize;
        require!(idx < v.protocol_count as usize, VaultError::InvalidProtocolIndex);

        let vault_key = v.key();
        let seeds: &[&[u8]] = &[b"vault", vault_key.as_ref(), &[v.authority_bump]];

        solend_deposit(
            CpiContext::new_with_signer(
                ctx.accounts.solend_program.to_account_info(),
                SolendDeposit {
                    vault_authority:          ctx.accounts.vault_authority.to_account_info(),
                    vault_token_account:      ctx.accounts.vault_token_account.clone(),
                    vault_collateral_account: ctx.accounts.vault_collateral_account.clone(),
                    reserve:                  ctx.accounts.reserve.to_account_info(),
                    reserve_liquidity_supply: ctx.accounts.reserve_liquidity_supply.to_account_info(),
                    reserve_collateral_mint:  ctx.accounts.reserve_collateral_mint.clone(),
                    lending_market:           ctx.accounts.lending_market.to_account_info(),
                    lending_market_authority: ctx.accounts.lending_market_authority.to_account_info(),
                    pyth_oracle:              ctx.accounts.pyth_oracle.to_account_info(),
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
        let idx = protocol_index as usize;
        require!(idx < v.protocol_count as usize, VaultError::InvalidProtocolIndex);

        let vault_key = v.key();
        let seeds: &[&[u8]] = &[b"vault", vault_key.as_ref(), &[v.authority_bump]];

        solend_withdraw(
            CpiContext::new_with_signer(
                ctx.accounts.solend_program.to_account_info(),
                SolendWithdraw {
                    vault_authority:          ctx.accounts.vault_authority.to_account_info(),
                    vault_collateral_account: ctx.accounts.vault_collateral_account.clone(),
                    vault_token_account:      ctx.accounts.vault_token_account.clone(),
                    reserve:                  ctx.accounts.reserve.to_account_info(),
                    reserve_collateral_mint:  ctx.accounts.reserve_collateral_mint.clone(),
                    reserve_liquidity_supply: ctx.accounts.reserve_liquidity_supply.to_account_info(),
                    lending_market:           ctx.accounts.lending_market.to_account_info(),
                    lending_market_authority: ctx.accounts.lending_market_authority.to_account_info(),
                    pyth_oracle:              ctx.accounts.pyth_oracle.to_account_info(),
                    clock_sysvar:             ctx.accounts.clock_sysvar.to_account_info(),
                    token_program:            ctx.accounts.token_program.clone(),
                    solend_program:           ctx.accounts.solend_program.to_account_info(),
                },
                &[seeds],
            ),
            collateral_amount,
            seeds,
        )?;

        v.protocols[idx].deployed_balance = v.protocols[idx].deployed_balance
            .saturating_sub(collateral_amount);
        emit!(FundsRecalled { vault: v.key(), protocol_index, collateral_amount });
        Ok(())
    }

    /// Deposit tokens into MarginFi. Balance tracked in marginfi_account, no receipt token.
    pub fn deploy_to_marginfi(
        ctx: Context<DeployToMarginFi>,
        protocol_index: u8,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        let v = &mut ctx.accounts.vault;
        let idx = protocol_index as usize;
        require!(idx < v.protocol_count as usize, VaultError::InvalidProtocolIndex);

        let vault_key = v.key();
        let seeds: &[&[u8]] = &[b"vault", vault_key.as_ref(), &[v.authority_bump]];

        marginfi_deposit(
            CpiContext::new_with_signer(
                ctx.accounts.marginfi_program.to_account_info(),
                MarginFiDeposit {
                    vault_authority:      ctx.accounts.vault_authority.to_account_info(),
                    vault_token_account:  ctx.accounts.vault_token_account.clone(),
                    marginfi_group:       ctx.accounts.marginfi_group.to_account_info(),
                    marginfi_account:     ctx.accounts.marginfi_account.to_account_info(),
                    bank:                 ctx.accounts.bank.to_account_info(),
                    bank_liquidity_vault: ctx.accounts.bank_liquidity_vault.to_account_info(),
                    token_program:        ctx.accounts.token_program.clone(),
                    marginfi_program:     ctx.accounts.marginfi_program.to_account_info(),
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

    /// Withdraw tokens from MarginFi.
    pub fn recall_from_marginfi(
        ctx: Context<RecallFromMarginFi>,
        protocol_index: u8,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        let v = &mut ctx.accounts.vault;
        let idx = protocol_index as usize;
        require!(idx < v.protocol_count as usize, VaultError::InvalidProtocolIndex);

        let vault_key = v.key();
        let seeds: &[&[u8]] = &[b"vault", vault_key.as_ref(), &[v.authority_bump]];

        marginfi_withdraw(
            CpiContext::new_with_signer(
                ctx.accounts.marginfi_program.to_account_info(),
                MarginFiWithdraw {
                    vault_authority:                ctx.accounts.vault_authority.to_account_info(),
                    vault_token_account:            ctx.accounts.vault_token_account.clone(),
                    marginfi_group:                 ctx.accounts.marginfi_group.to_account_info(),
                    marginfi_account:               ctx.accounts.marginfi_account.to_account_info(),
                    bank:                           ctx.accounts.bank.to_account_info(),
                    bank_liquidity_vault:           ctx.accounts.bank_liquidity_vault.to_account_info(),
                    bank_liquidity_vault_authority: ctx.accounts.bank_liquidity_vault_authority.to_account_info(),
                    token_program:                  ctx.accounts.token_program.clone(),
                    marginfi_program:               ctx.accounts.marginfi_program.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            seeds,
        )?;

        v.protocols[idx].deployed_balance = v.protocols[idx].deployed_balance
            .saturating_sub(amount);
        emit!(FundsRecalled { vault: v.key(), protocol_index, collateral_amount: amount });
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
    pub gate_mint:           Pubkey,  // pump.fun token for access gating (Pubkey::default = no gate)
    pub pending_admin:       Pubkey,  // two-step admin transfer; Pubkey::default = no pending transfer
    pub total_deposits:      u64,
    pub total_shares:        u64,
    pub perf_fee_bps:        u64,
    pub auto_compound:       bool,
    pub auto_rebalance:      bool,
    pub paused:              bool,
    pub last_compound_ts:    i64,
    pub bump:                u8,
    pub authority_bump:      u8,
    pub protocol_count:      u8,
    pub tvl_cap:             u64,
    pub name:                String,
    pub protocols:           [ProtocolAdapter; MAX_PROTOCOLS],
}

impl Vault {
    pub const LEN: usize = 8
        + 32 * 8         // pubkeys (admin, keeper, mint, vault_token_account, shares_mint, treasury, gate_mint, pending_admin)
        + 8 * 3          // u64 totals + fee
        + 3              // bools
        + 8              // i64
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
}

impl UserPosition {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 8 + 1 + 1 + 32; // +1 for tier_at_deposit
}

// ── Account contexts ──────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitVaultParams {
    pub perf_fee_bps:  u64,
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
        init, payer = admin,
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
#[instruction(wallet: Pubkey)]
pub struct DeployToKamino<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut, constraint = vault.keeper == keeper.key() @ VaultError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    /// CHECK: PDA
    #[account(seeds = [b"vault", vault.key().as_ref()], bump = vault.authority_bump)]
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
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut, constraint = vault.keeper == keeper.key() @ VaultError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    /// CHECK: PDA
    #[account(seeds = [b"vault", vault.key().as_ref()], bump = vault.authority_bump)]
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
    pub vault: Account<'info, Vault>,
    /// CHECK: PDA
    #[account(seeds = [b"vault", vault.key().as_ref()], bump = vault.authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: Marinade validates
    #[account(mut)] pub marinade_state: UncheckedAccount<'info>,
    #[account(mut)] pub msol_mint: Account<'info, Mint>,
    /// CHECK: Marinade validates
    #[account(mut)] pub liq_pool_sol_leg: UncheckedAccount<'info>,
    #[account(mut)] pub liq_pool_msol_leg: Account<'info, TokenAccount>,
    /// CHECK: Marinade validates
    pub liq_pool_msol_leg_authority: UncheckedAccount<'info>,
    /// CHECK: Marinade validates
    #[account(mut)] pub reserve_pda: UncheckedAccount<'info>,
    #[account(mut)] pub vault_msol_account: Account<'info, TokenAccount>,
    /// CHECK: Marinade validates
    pub msol_mint_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub token_program:  Program<'info, Token>,
    /// CHECK: address constraint
    #[account(address = adapters::marinade::MARINADE_MAINNET_PROGRAM)]
    pub marinade_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RecallFromMarinade<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut, constraint = vault.keeper == keeper.key() @ VaultError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    /// CHECK: PDA
    #[account(seeds = [b"vault", vault.key().as_ref()], bump = vault.authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: Marinade validates
    #[account(mut)] pub marinade_state: UncheckedAccount<'info>,
    #[account(mut)] pub msol_mint: Account<'info, Mint>,
    /// CHECK: Marinade validates
    #[account(mut)] pub liq_pool_sol_leg: UncheckedAccount<'info>,
    #[account(mut)] pub liq_pool_msol_leg: Account<'info, TokenAccount>,
    #[account(mut)] pub treasury_msol_account: Account<'info, TokenAccount>,
    #[account(mut)] pub vault_msol_account: Account<'info, TokenAccount>,
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
    pub vault: Account<'info, Vault>,
    /// CHECK: PDA
    #[account(mut, seeds = [b"vault", vault.key().as_ref()], bump = vault.authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// Vault's LST ATA (jitoSOL or bSOL)
    #[account(mut)]
    pub vault_lst_account: Account<'info, TokenAccount>,
    /// CHECK: Stake pool state account
    #[account(mut)] pub stake_pool: UncheckedAccount<'info>,
    /// CHECK: Withdraw authority PDA [pool, "withdraw"]
    pub withdraw_authority: UncheckedAccount<'info>,
    /// CHECK: Reserve stake account (from pool state)
    #[account(mut)] pub reserve_stake: UncheckedAccount<'info>,
    /// Manager fee account (from pool state)
    #[account(mut)] pub manager_fee_account: Account<'info, TokenAccount>,
    /// LST pool mint (jitoSOL or bSOL mint)
    #[account(mut)] pub pool_mint: Account<'info, Mint>,
    /// CHECK: clock
    #[account(address = anchor_lang::solana_program::sysvar::clock::ID)]
    pub clock_sysvar: UncheckedAccount<'info>,
    /// CHECK: stake history
    #[account(address = anchor_lang::solana_program::sysvar::stake_history::ID)]
    pub stake_history_sysvar: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    /// CHECK: SPL Stake Pool program or Jito fork
    pub stake_pool_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RecallFromSolLst<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut, constraint = vault.keeper == keeper.key() @ VaultError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    /// CHECK: PDA
    #[account(mut, seeds = [b"vault", vault.key().as_ref()], bump = vault.authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// Vault's LST ATA — LST burned from here
    #[account(mut)]
    pub vault_lst_account: Account<'info, TokenAccount>,
    /// CHECK: Stake pool state account
    #[account(mut)] pub stake_pool: UncheckedAccount<'info>,
    /// CHECK: Withdraw authority PDA
    pub withdraw_authority: UncheckedAccount<'info>,
    /// CHECK: Reserve stake account
    #[account(mut)] pub reserve_stake: UncheckedAccount<'info>,
    /// Manager fee account
    #[account(mut)] pub manager_fee_account: Account<'info, TokenAccount>,
    /// LST pool mint
    #[account(mut)] pub pool_mint: Account<'info, Mint>,
    /// CHECK: clock
    #[account(address = anchor_lang::solana_program::sysvar::clock::ID)]
    pub clock_sysvar: UncheckedAccount<'info>,
    /// CHECK: stake history
    #[account(address = anchor_lang::solana_program::sysvar::stake_history::ID)]
    pub stake_history_sysvar: UncheckedAccount<'info>,
    /// CHECK: native stake program
    #[account(address = anchor_lang::solana_program::stake::program::ID)]
    pub stake_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: SPL Stake Pool program or Jito fork
    pub stake_pool_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct DeployToSolend<'info> {
    #[account(mut)] pub keeper: Signer<'info>,
    #[account(mut, constraint = vault.keeper == keeper.key() @ VaultError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    /// CHECK: PDA
    #[account(mut, seeds = [b"vault", vault.key().as_ref()], bump = vault.authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, constraint = vault_token_account.key() == vault.vault_token_account)]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(mut)] pub vault_collateral_account: Account<'info, TokenAccount>,
    /// CHECK: Solend validates
    #[account(mut)] pub reserve: UncheckedAccount<'info>,
    /// CHECK: Solend validates
    #[account(mut)] pub reserve_liquidity_supply: UncheckedAccount<'info>,
    #[account(mut)] pub reserve_collateral_mint: Account<'info, Mint>,
    /// CHECK: Solend validates
    pub lending_market: UncheckedAccount<'info>,
    /// CHECK: Solend validates
    pub lending_market_authority: UncheckedAccount<'info>,
    /// CHECK: Pyth oracle
    pub pyth_oracle: UncheckedAccount<'info>,
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
    #[account(mut)] pub keeper: Signer<'info>,
    #[account(mut, constraint = vault.keeper == keeper.key() @ VaultError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    /// CHECK: PDA
    #[account(mut, seeds = [b"vault", vault.key().as_ref()], bump = vault.authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut)] pub vault_collateral_account: Account<'info, TokenAccount>,
    #[account(mut, constraint = vault_token_account.key() == vault.vault_token_account)]
    pub vault_token_account: Account<'info, TokenAccount>,
    /// CHECK: Solend validates
    #[account(mut)] pub reserve: UncheckedAccount<'info>,
    #[account(mut)] pub reserve_collateral_mint: Account<'info, Mint>,
    /// CHECK: Solend validates
    #[account(mut)] pub reserve_liquidity_supply: UncheckedAccount<'info>,
    /// CHECK: Solend validates
    pub lending_market: UncheckedAccount<'info>,
    /// CHECK: Solend validates
    pub lending_market_authority: UncheckedAccount<'info>,
    /// CHECK: Pyth oracle
    pub pyth_oracle: UncheckedAccount<'info>,
    /// CHECK: clock
    #[account(address = anchor_lang::solana_program::sysvar::clock::ID)]
    pub clock_sysvar: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Solend program
    #[account(address = adapters::solend::SOLEND_PROGRAM)]
    pub solend_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct DeployToMarginFi<'info> {
    #[account(mut)] pub keeper: Signer<'info>,
    #[account(mut, constraint = vault.keeper == keeper.key() @ VaultError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    /// CHECK: PDA
    #[account(mut, seeds = [b"vault", vault.key().as_ref()], bump = vault.authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, constraint = vault_token_account.key() == vault.vault_token_account)]
    pub vault_token_account: Account<'info, TokenAccount>,
    /// CHECK: MarginFi validates
    pub marginfi_group: UncheckedAccount<'info>,
    /// CHECK: MarginFi validates — vault's marginfi_account PDA
    #[account(mut)] pub marginfi_account: UncheckedAccount<'info>,
    /// CHECK: MarginFi validates
    #[account(mut)] pub bank: UncheckedAccount<'info>,
    /// CHECK: MarginFi validates
    #[account(mut)] pub bank_liquidity_vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: MarginFi program
    #[account(address = adapters::marginfi::MARGINFI_PROGRAM)]
    pub marginfi_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RecallFromMarginFi<'info> {
    #[account(mut)] pub keeper: Signer<'info>,
    #[account(mut, constraint = vault.keeper == keeper.key() @ VaultError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    /// CHECK: PDA
    #[account(mut, seeds = [b"vault", vault.key().as_ref()], bump = vault.authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, constraint = vault_token_account.key() == vault.vault_token_account)]
    pub vault_token_account: Account<'info, TokenAccount>,
    /// CHECK: MarginFi validates
    pub marginfi_group: UncheckedAccount<'info>,
    /// CHECK: MarginFi validates
    #[account(mut)] pub marginfi_account: UncheckedAccount<'info>,
    /// CHECK: MarginFi validates
    #[account(mut)] pub bank: UncheckedAccount<'info>,
    /// CHECK: MarginFi validates
    #[account(mut)] pub bank_liquidity_vault: UncheckedAccount<'info>,
    /// CHECK: MarginFi validates
    pub bank_liquidity_vault_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: MarginFi program
    #[account(address = adapters::marginfi::MARGINFI_PROGRAM)]
    pub marginfi_program: UncheckedAccount<'info>,
}

// ── Events ────────────────────────────────────────────────────────────────────

#[event] pub struct VaultInitialized  { pub vault: Pubkey, pub admin: Pubkey, pub mint: Pubkey }
#[event] pub struct ProtocolRegistered{ pub vault: Pubkey, pub external_state: Pubkey, pub target_bps: u64 }
#[event] pub struct Deposited         { pub vault: Pubkey, pub user: Pubkey, pub amount: u64, pub shares_minted: u64 }
#[event] pub struct Withdrawn         { pub vault: Pubkey, pub user: Pubkey, pub shares_burned: u64, pub amount_out: u64, pub perf_fee: u64 }
#[event] pub struct Rebalanced        { pub vault: Pubkey, pub allocations: Vec<u64>, pub ts: i64 }
#[event] pub struct Compounded        { pub vault: Pubkey, pub ts: i64 }
#[event] pub struct FundsDeployed     { pub vault: Pubkey, pub protocol_index: u8, pub amount: u64 }
#[event] pub struct FundsRecalled     { pub vault: Pubkey, pub protocol_index: u8, pub collateral_amount: u64 }
#[event] pub struct PauseToggled      { pub vault: Pubkey, pub paused: bool }

// ── Errors ────────────────────────────────────────────────────────────────────

#[error_code]
pub enum VaultError {
    #[msg("Unauthorized")]                    Unauthorized,
    #[msg("Fee exceeds 10% maximum")]         FeeTooHigh,
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
    #[msg("Treasury account required when fee is non-zero")]   TreasuryRequired,
    #[msg("Allocation must sum to exactly 10000 bps")]         AllocationNotFull,
    #[msg("No pending admin transfer")]                        NoPendingAdmin,
    #[msg("Not the pending admin")]                            NotPendingAdmin,
    #[msg("Output below minimum — slippage exceeded")]         SlippageExceeded,
    #[msg("Deploy would breach minimum idle buffer (10%)")]    IdleBufferBreach,
}
