# YieldPilot

**Live on Solana mainnet:** [yieldpilot.fund](https://yieldpilot.fund)

YieldPilot is a non-custodial Solana vault that automatically routes deposited USDC or SOL to whichever supported lending/staking protocol is currently paying the best rate, and rebalances on an ongoing basis as rates change. Deposit once; a keeper bot handles moving funds between protocols from there.

- **Program ID:** `3tAEmHXZ51YVLe9ts8b9cMcgQPgaSamLxLtxR31VpREi` — [view on Solscan](https://solscan.io/account/3tAEmHXZ51YVLe9ts8b9cMcgQPgaSamLxLtxR31VpREi)
- **Non-custodial:** funds move only through the instructions defined in the on-chain program — no admin withdrawal path exists.
- **Performance fee only:** a tiered fee (0–9%) is charged on profit at exit, scaled down by how much of the $YPILOT token you hold. No deposit or management fees, no deposit caps at any tier.
- **Currently supported protocols:** Kamino, Marinade, Jito, Solend.

Full mechanics, fee schedule, and architecture are documented in the [whitepaper](https://yieldpilot.fund/whitepaper).

## Status

Live and operating on mainnet. Phase 2 (opt-in Orca/Raydium liquidity-provision vaults, carrying impermanent-loss risk on top of the base yield model) exists in this repo but is not yet publicly promoted. A third-party smart contract audit is planned, pending demonstrated demand — see the whitepaper's roadmap for the current phase breakdown.

## Repository layout

```
programs/yieldpilot/   Anchor program (Rust) — the on-chain vault logic
app/                   Next.js frontend (yieldpilot.fund)
keeper/                Keeper bot — polls rates, rebalances, runs on a GitHub Actions cron
tests/                 Anchor integration tests + local-validator harness scripts
```

## Building locally

Requires Rust, the Solana CLI, and Anchor 0.31.0.

```bash
# Program
cd programs/yieldpilot
cargo-build-sbf --manifest-path Cargo.toml --features no-idl

# Frontend
cd app
npm install
npm run dev

# Keeper
cd keeper
npm install
npm run build
```

Deploys (devnet and mainnet) and the keeper's production runs are handled entirely through this repo's GitHub Actions workflows (`.github/workflows/`) — there's no manual deploy script to run by hand.

## Security

The on-chain program is the sole source of truth for what this protocol can and cannot do with deposited funds — no off-chain component (including the keeper bot or the team) has a path to move user funds outside of the instructions the program itself exposes. If you find a security issue, please report it privately rather than opening a public issue.
