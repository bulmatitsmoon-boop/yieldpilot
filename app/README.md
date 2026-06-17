# ⚡ YieldPilot App — Next.js Frontend

React/Next.js frontend for YieldPilot. Connects to Phantom/Solflare, reads live vault state on-chain, and signs deposit/withdraw transactions directly.

---

## Prerequisites

- Node.js 18+
- Deployed YieldPilot program (from Step 1)
- At least one vault initialized on-chain
- Phantom or Solflare browser extension

---

## Setup

```bash
cd yieldpilot-app
npm install

cp .env.local.example .env.local
# Fill in your PROGRAM_ID and VAULT_ADDRESSES
```

### `.env.local`

```env
NEXT_PUBLIC_SOLANA_NETWORK=devnet
NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_PROGRAM_ID=<your program ID from anchor deploy>
NEXT_PUBLIC_VAULT_ADDRESSES=<vault pubkey from initialize_vault>
```

### Copy IDL

```bash
# After `anchor build` in the program directory:
cp ../yieldpilot/target/idl/yieldpilot.json src/idl/
```

---

## Run

```bash
npm run dev
# Open http://localhost:3000
```

---

## Deploy to Vercel

```bash
npm install -g vercel
vercel

# Set environment variables in Vercel dashboard
# or via CLI:
vercel env add NEXT_PUBLIC_PROGRAM_ID
vercel env add NEXT_PUBLIC_VAULT_ADDRESSES
vercel env add NEXT_PUBLIC_RPC_URL
```

---

## Architecture

```
src/
├── app/
│   ├── layout.tsx              ← Wallet providers, header
│   ├── page.tsx                ← Redirects to /dashboard
│   ├── dashboard/page.tsx      ← Main dashboard UI
│   └── api/apys/route.ts       ← Server-side APY proxy (Kamino, Marinade, etc.)
├── components/
│   ├── WalletProvider.tsx      ← ConnectionProvider + WalletProvider + Modal
│   ├── Header.tsx              ← Nav with wallet connect button
│   ├── ui/index.tsx            ← StatCard, Pill, Toggle, Button, TxBanner
│   └── dashboard/
│       ├── ProtocolTable.tsx   ← Live APY table
│       └── DepositWithdrawPanel.tsx  ← Deposit/withdraw form + tx signing
├── hooks/
│   ├── useYieldPilot.ts        ← Fetches vault state, wraps deposit/withdraw
│   └── useApys.ts              ← SWR hook for live protocol APYs
└── idl/
    └── yieldpilot.json         ← Copy from anchor build output
```

---

## Key flows

### Deposit flow
1. User enters amount, clicks Deposit
2. `useYieldPilot.deposit()` builds the Anchor instruction
3. Wallet adapter prompts user to sign
4. Transaction sent + confirmed on-chain
5. `TxBanner` shows Solscan link
6. Vault state refreshes after 2s

### APY data
- `/api/apys` route fetches Kamino and Marinade server-side
- Falls back to hardcoded recent averages if APIs are down
- Cached for 60 seconds via `Cache-Control`
- Client refreshes every 60 seconds via SWR

---

## Production checklist

- [ ] Switch `NEXT_PUBLIC_SOLANA_NETWORK` to `mainnet-beta`
- [ ] Use a paid RPC (Helius recommended — `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`)
- [ ] Audit the smart contract before mainnet (Neodyme, OtterSec)
- [ ] Set up error monitoring (Sentry)
- [ ] Add rate limiting to `/api/apys` if you expect high traffic
