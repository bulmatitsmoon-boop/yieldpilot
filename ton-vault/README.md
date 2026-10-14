# YieldPilot — Phase 3: TON-Native Vault

Early-stage exploration of a TON-native yield vault — a separate product from the
Solana vaults, not a bridge adapter. This directory tracks real, verified progress
only; nothing here is claimed as more complete than it is.

## Why TON

Re-verified live, first-party, same day as this commit:

| Source | Rate | Notes |
|---|---|---|
| Tonstakers (TON staking) | **12.86% APY** | $187.6M TVL, 143,456 stakers — live on tonstakers.com |
| Kamino USDC (Solana, best comparable) | 5.88% APY | riskScore ≤1, excludes volatile LP pools |
| Marinade SOL (Solana) | 5.07% APY | Same risk tier |

TON leads the best comparable Solana rate by roughly 2.2x.

## Verified integration facts

Pulled directly from Tonstakers' own SDK source (`github.com/tonstakers/tonstakers-sdk`):

- Staking pool (mainnet): `EQCkWxfyhAkim3g2DjKQQg8T5P4g-Q1-K_jErGcDJZ4i-vqR`
- tsTON jetton master: `EQC98_qAmNEptUtPc7W6xdHh_ZHrBUFpw5Ft_IzNU20QAJav`
- Stake opcode: `0x47d54391`
- Unstake opcode: `0x595f07bc`
- STON.fi tsTON/TON pool liquidity: $243,704.85 ($29,866.94 24h volume)

**Finding:** raw unstaking from the Tonstakers pool is round-based (`cycle_start`/`cycle_end`/`withdrawal_payout`), not instant. The "instant withdrawal" the protocol advertises is powered by a separate DEX swap (tsTON → TON against open-market liquidity), not the protocol's own unstake path. The vault's v1 withdraw uses that DEX-swap path for speed, which means real slippage risk against current pool depth — this needs a slippage-tolerance parameter and a max-withdrawal-size guard before it's safe to ship.

## Status

- **Toolchain:** proven end-to-end. [Acton](https://ton-blockchain.github.io/acton/) 1.2.1 installed, Tolk (Tact is deprecated as of 2026) confirmed working via a scaffolded counter contract — `acton build` and `acton test` both pass (8/8 tests).
- **This directory:** the scaffolded toolchain-proof contract only. The real vault contract (deposit/withdraw message flow, shares accounting) has not been written yet.

## Open decisions

- Per-user child contract vs. shares-jetton-only accounting.
- Slippage tolerance + max withdrawal size for the DEX-swap withdraw path.
- Bounced-message recovery if a stake confirmation never arrives.

## Toolchain-proof contract

`contracts/src/Counter.tolk` is the standard Acton scaffold template, kept here only
to prove the build pipeline works on this project before real vault code is written.
It is not part of the vault itself.
