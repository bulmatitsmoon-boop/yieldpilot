# ⚡ YieldPilot — Launch Runbook

Complete step-by-step guide from zero to live on Solana devnet, then mainnet.
Estimated time: 2–3 hours for devnet, 1 hour for mainnet (after devnet is working).

---

## Prerequisites checklist

- [ ] Rust + Anchor CLI installed (`anchor --version` shows 0.30.0)
- [ ] Solana CLI installed (`solana --version` shows ≥1.18)
- [ ] Node.js 18+ and npm/yarn
- [ ] Phantom wallet browser extension installed
- [ ] Admin keypair at `~/.config/solana/id.json`

---

## Phase 1 — Devnet

### 1.1 Fund your wallet

```bash
solana config set --url devnet
solana airdrop 2                    # get 2 devnet SOL
solana balance                      # confirm ≥ 1.5 SOL
```

### 1.2 Get devnet USDC

Visit https://faucet.circle.com and request devnet USDC.
Token mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`

### 1.3 Build the program

```bash
cd yieldpilot-final
yarn install
anchor build
```

Expected: `target/deploy/yieldpilot.so` and `target/idl/yieldpilot.json` created.

### 1.4 Run tests (local validator)

```bash
anchor test
```

Expected: all 10 tests passing. If any fail, fix before deploying.

### 1.5 Deploy to devnet

```bash
anchor deploy --provider.cluster devnet
# Note the program ID printed — copy it!
```

Update `Anchor.toml`:
```toml
[programs.devnet]
yieldpilot = "YOUR_PROGRAM_ID_HERE"
```

Update `programs/yieldpilot/src/lib.rs`:
```rust
declare_id!("YOUR_PROGRAM_ID_HERE");
```

Rebuild: `anchor build` (IDL will now have correct program ID)

### 1.6 Initialize vault on devnet

```bash
cp .env.example .env
# Edit .env: set PROGRAM_ID to your deployed program ID

npm run deploy:devnet
```

Expected output:
```
✓ Vault initialized
✓ Kamino registered at 70% (skipped on devnet — Kamino not on devnet)
✓ Marinade registered at 30%

PROGRAM_ID=...
VAULT_ADDRESSES=...
```

Copy those values into:
- `app/.env.local`
- `keeper/.env`

### 1.7 Copy IDL to app and keeper

```bash
cp target/idl/yieldpilot.json app/src/idl/
cp target/idl/yieldpilot.json keeper/src/idl/
```

### 1.8 Start the frontend

```bash
cd app
npm install
cp .env.local.example .env.local
# Fill in PROGRAM_ID and VAULT_ADDRESSES
npm run dev
```

Open http://localhost:3000 — connect Phantom wallet (devnet mode).

### 1.9 Start the keeper

```bash
cd keeper
npm install
cp .env.example .env
# Fill in PROGRAM_ID, VAULT_ADDRESSES, KEEPER_KEYPAIR_PATH
npm run dev
```

Expected: logs show APY poll every 15min, compound check every hour.

### 1.10 Devnet smoke test

1. Connect Phantom (set to devnet in Phantom settings)
2. Deposit $5 USDC
3. Wait for position to appear
4. Check keeper logs — should see "No rebalance needed"
5. Withdraw $5 — confirm you get it back

---

## Phase 2 — Mainnet

Only proceed after devnet is stable for ≥ 24 hours.

### 2.1 Create a dedicated admin keypair (hardware wallet recommended)

```bash
# Software keypair (minimum):
solana-keygen new --outfile ~/.config/solana/mainnet-admin.json

# OR use Ledger (recommended):
# Set up Ledger, then:
solana config set --keypair usb://ledger
```

Fund with ~0.5 SOL for deployment and transaction fees.

### 2.2 Create a dedicated keeper keypair

```bash
solana-keygen new --outfile ~/.config/solana/mainnet-keeper.json
# Fund with 0.1 SOL — keeper pays tiny tx fees (<<0.01 SOL/day)
```

### 2.3 Get a paid RPC endpoint

Public RPC rate-limits will break the keeper. Sign up for a free tier:
- **Helius** (recommended): https://www.helius.dev — 1M credits/month free
- **QuickNode**: https://www.quicknode.com

### 2.4 Deploy to mainnet

```bash
anchor deploy --provider.cluster mainnet-beta \
  --provider.wallet ~/.config/solana/mainnet-admin.json
```

Update `Anchor.toml` with the mainnet program ID, rebuild.

### 2.5 Initialize vault on mainnet

```bash
export CLUSTER=mainnet-beta
export RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
export KEEPER_KEYPAIR_PATH=~/.config/solana/mainnet-admin.json
npm run deploy:mainnet
```

**Starting TVL cap: $500 USDC.**
Increase cap manually via `set_tvl_cap` instruction after each stability period:
- Week 1: $500
- Week 2: $2,000
- Month 2: $10,000
- Month 3+: raise based on confidence

### 2.6 Deploy frontend to Vercel

```bash
cd app
npm install -g vercel
vercel
# Set env vars in Vercel dashboard:
#   NEXT_PUBLIC_SOLANA_NETWORK=mainnet-beta
#   NEXT_PUBLIC_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
#   NEXT_PUBLIC_PROGRAM_ID=...
#   NEXT_PUBLIC_VAULT_ADDRESSES=...
```

### 2.7 Deploy keeper to Railway

```bash
cd keeper
npm install -g @railway/cli
railway login
railway init
railway up

# Set env vars in Railway:
railway variables set RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
railway variables set PROGRAM_ID=...
railway variables set VAULT_ADDRESSES=...
railway variables set KEEPER_KEYPAIR_PATH=/app/keeper.json
# Upload keeper keypair as a file secret in Railway dashboard
```

### 2.8 Mainnet smoke test

1. Deposit $1 USDC (minimum)
2. Wait 5 minutes — keeper should deploy to Kamino
3. Check Solscan for your vault's token accounts
4. Withdraw $1 — verify you receive it

---

## Monitoring

### Keeper health

```bash
# Tail keeper logs (Railway)
railway logs

# Watch for:
# ✓ APY fetch: shows protocol rates
# ✓ Compound: fires every hour
# ⚠ Balance low: fund keeper with more SOL
```

### On-chain verification

```bash
# Check vault state
solana account VAULT_ADDRESS --output json

# Watch vault token balance
spl-token balance --owner VAULT_AUTHORITY_ADDRESS USDC_MINT
```

### Solscan

Bookmark:
- Vault account: `https://solscan.io/account/VAULT_ADDRESS`
- Program: `https://solscan.io/account/PROGRAM_ID`

---

## Emergency procedures

### Pause deposits immediately

```bash
# From admin keypair:
ts-node scripts/pause.ts --cluster mainnet-beta
# OR via Anchor CLI:
anchor idl type -o /tmp/idl.json # then use Anchor CLI or a UI
```

Users can **always withdraw** even while paused.

### Raise TVL cap gradually

```bash
ts-node scripts/set-tvl-cap.ts --amount 10000 --cluster mainnet-beta
```

### Transfer admin to multisig (recommended for >$10k TVL)

Use Squads Protocol (https://squads.so) to create a 2/3 multisig,
then `update_settings` with new admin = Squads vault address.

---

## Known limitations (pre-audit)

1. **Kamino cToken accounting** — deployed_balance tracks lamports in, not cTokens held.
   After interest accrues, deployed_balance understates true value.
   Fix: read cToken balance from vault_collateral_account and recompute.

2. **Marinade unstake fee** — not deducted from deployed_balance on recall.
   Keeper should read Marinade state to compute exact fee before unstaking.

3. **Oracle manipulation (Kamino)** — Kamino uses Pyth oracles.
   If Pyth is stale, Kamino's refresh_reserve may fail.
   Keeper should retry with longer interval.

4. **No slippage protection on rebalance** — large rebalances could be sandwiched.
   Mitigation: keep individual rebalance amounts small (<5% of TVL per tx).

5. **Single admin key** — admin key compromise = game over.
   Migrate to Squads multisig after launch.
