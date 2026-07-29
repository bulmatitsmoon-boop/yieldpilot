"use client";
import { useState, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";

const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID || "3tAEmHXZ51YVLe9ts8b9cMcgQPgaSamLxLtxR31VpREi"
);
import { Button, fmt } from "@/components/ui";
import type { VaultInfo } from "@/hooks/useYieldPilot";
import type { ProtocolApy } from "@/hooks/useApys";

const DECIMALS: Record<string, number> = {
  USDC: 6, USDT: 6, SOL: 9, ETH: 8,
};

interface Props {
  vault: VaultInfo;
  apys: ProtocolApy[];
  onDeposit: (vaultAddress: string, mint: string, amount: anchor.BN) => Promise<any>;
  onWithdraw: (vaultAddress: string, mint: string, shares: anchor.BN) => Promise<any>;
  userShares: number;
  depositedAmount?: number; // raw on-chain units — used for accurate fee preview
  initialTab?: "deposit" | "withdraw";
  userGateBalance?: number; // raw gate token balance for tier calculation
}

export function DepositWithdrawPanel({ vault, apys, onDeposit, onWithdraw, userShares, depositedAmount = 0, initialTab = "deposit", userGateBalance = 0 }: Props) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const tab = initialTab;
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [isWhitelisted, setIsWhitelisted] = useState(false);

  const asset = vault.name.toUpperCase().includes("SOL") ? "SOL" : "USDC";
  const decimals = DECIMALS[asset] || 6;
  const bestApy = [...apys].sort((a, b) => b.apyBps - a.apyBps)[0];
  const SYSTEM_PROGRAM = '11111111111111111111111111111111';
  const gatingActive = vault.gateMint && vault.gateMint !== SYSTEM_PROGRAM && vault.gateMint !== '';
  // Tier-based fee: compare raw gate token balance against vault thresholds
  const effectiveFeeBps = (() => {
    if (isWhitelisted) return 0;
    if (!gatingActive) return 900; // STANDARD_FEE_BPS — ungated vault = 9%
    if (userGateBalance >= (vault.goldThreshold ?? 1_000_000)) return 0;
    if (userGateBalance >= (vault.silverThreshold ?? 100_000)) return 300;
    if (userGateBalance >= (vault.bronzeThreshold ?? 10_000)) return 600;
    return 900; // STANDARD_FEE_BPS (below Bronze) = 9%
  })();
  const tierLabel = (() => {
    if (isWhitelisted) return "Whitelisted";
    if (!gatingActive) return null;
    if (userGateBalance >= (vault.goldThreshold ?? 1_000_000)) return "Gold";
    if (userGateBalance >= (vault.silverThreshold ?? 100_000)) return "Silver";
    if (userGateBalance >= (vault.bronzeThreshold ?? 10_000)) return "Bronze";
    return null;
  })();

  // Derive user's position value in tokens from shares
  const sharePrice = vault.totalShares > 0 ? vault.totalDeposits / vault.totalShares : 1;
  const positionTokens = (userShares * sharePrice) / 10 ** decimals; // ui amount
  const positionRaw = userShares * sharePrice; // in raw units (same decimals as totalDeposits)

  // ── Withdrawal ceiling ─────────────────────────────────────────────────────
  // A withdrawal is paid from the vault's IDLE balance. When idle can't cover it,
  // useYieldPilot bundles recall_from_* ahead of withdraw() in the same transaction —
  // but a recall returns slightly LESS than it withdrew, because the protocol charges
  // an exit fee. recall_from_* decrements deployed_balance by the SOL actually
  // RECEIVED, so that fee is left behind as PHANTOM deployed_balance.
  //
  // withdraw() values a share against `idle + total_deployed`, so the phantom inflates
  // total_value above the real recoverable amount, and `require!(idle >= amount_out)`
  // rejects any withdrawal within a fee's width of 100%. MAX previously filled in the
  // user's FULL position — an amount that CANNOT settle — so the most common action in
  // the app always failed. Measured live on the round-8 SOL vault: 99.8% succeeds,
  // 99.9% and 100% revert with InsufficientIdle.
  //
  // The ceiling is therefore total_value minus the exit fees a full recall would incur.
  // Basis points below mirror the keeper's EXIT_COST_BPS (rebalancer.ts) — keep in sync.
  // These are empirically confirmed, not guesses: the local harness measured jito 0.1%
  // and marinade 0.17%, and a real mainnet recall on 2026-07-17 returned 7,986,399 of
  // 8,000,000 requested — 0.17% to the basis point.
  //
  // Lending protocols are 0: no exit fee, so no phantom, so 100% genuinely works and
  // this cap correctly collapses to the full position (e.g. the Kamino-only USDC vault).
  //
  // The real fix is program-side (zero deployed_balance on a full recall and book the
  // fee as a realized loss); until that upgrade ships, promise only what can settle.
  const EXIT_COST_BPS: Record<string, number> = {
    "kamino-usdc": 0,
    "kamino-sol": 0,
    "solend-usdc": 0,
    "marinade-sol": 30, // ~0.3% liquid-unstake fee (max; measured 0.17%)
    "jito-sol": 10,     // ~0.1% to exit jitoSOL
    "psol-sol": 10,     // same SPL stake-pool WithdrawSol path as jito — ~0.1% exit
  };
  const phantomRaw = vault.protocols.reduce(
    (sum, p) => sum + (p.currentBalance * (EXIT_COST_BPS[p.name] ?? 0)) / 10000,
    0
  );
  // Cap the PAYOUT (not the share count): amount_out must be <= idle after recalls,
  // and idle-after-recalls == total_value - fees.
  const vaultCeilingTokens = Math.max(0, vault.totalDeposits - phantomRaw) / 10 ** decimals;
  const maxWithdrawTokens = Math.min(positionTokens, vaultCeilingTokens);
  // True when the phantom actually binds — i.e. the user cannot take their whole position.
  const withdrawCappedByFees = tab === "withdraw" && maxWithdrawTokens < positionTokens - 1e-12;

  // Convert a token ui-amount to shares to burn
  const tokenAmountToShares = (uiAmount: number): anchor.BN => {
    if (vault.totalDeposits === 0 || vault.totalShares === 0) return new anchor.BN(0);
    const rawAmount = uiAmount * 10 ** decimals;
    const shares = Math.floor((rawAmount / vault.totalDeposits) * vault.totalShares);
    return new anchor.BN(shares);
  };

  useEffect(() => { if (publicKey) fetchBalance(); }, [publicKey, vault.address]);

  useEffect(() => {
    if (!publicKey) { setIsWhitelisted(false); return; }
    const vaultPubkey = new PublicKey(vault.address);
    const [whitelistPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("wl"), vaultPubkey.toBuffer(), publicKey.toBuffer()],
      PROGRAM_ID
    );
    connection.getAccountInfo(whitelistPda)
      .then(info => setIsWhitelisted(!!info))
      .catch(() => setIsWhitelisted(false));
  }, [publicKey, vault.address, connection]);

  const fetchBalance = async () => {
    if (!publicKey) return;
    try {
      if (asset === "SOL") {
        const lamports = await connection.getBalance(publicKey);
        setWalletBalance(lamports / 1e9);
      } else {
        const ata = await getAssociatedTokenAddress(
          new (await import("@solana/web3.js")).PublicKey(vault.mint),
          publicKey
        );
        const info = await connection.getTokenAccountBalance(ata);
        setWalletBalance(info.value.uiAmount || 0);
      }
    } catch {
      setWalletBalance(0);
    }
  };

  const handleAction = async () => {
    if (!amount || busy) return;
    setBusy(true);
    try {
      const uiAmount = parseFloat(amount);
      if (tab === "deposit") {
        const raw = new anchor.BN(Math.floor(uiAmount * 10 ** decimals));
        await onDeposit(vault.address, vault.mint, raw);
      } else {
        const shares = tokenAmountToShares(uiAmount);
        await onWithdraw(vault.address, vault.mint, shares);
      }
      setAmount("");
    } finally {
      setBusy(false);
    }
  };

  // A SOL deposit wraps native SOL into a WSOL account, which the deposit tx transfers
  // into the vault. That wrap can never take 100% of the wallet: it needs lamports left
  // for the tx fee AND, if the user has no WSOL ATA yet, that account's rent-exempt
  // minimum (~0.00204 SOL). So "MAX" on a SOL DEPOSIT must hold back a reserve, or the
  // transfer leaves nothing for rent+fee and the whole tx reverts — the deposit-side twin
  // of the withdraw MAX bug fixed in #109. USDC is unaffected: its balance is separate
  // from the SOL that pays fees. 0.01 SOL comfortably covers WSOL rent + fee + headroom
  // for a couple of priority-fee'd retries; anyone depositing SOL has far more than that.
  const SOL_DEPOSIT_RESERVE = 0.01;
  const maxDeposit = asset === "SOL" && walletBalance !== null
    ? Math.max(0, walletBalance - SOL_DEPOSIT_RESERVE)
    : walletBalance;

  // Precision to floor MAX at. Math.floor only ever rounds DOWN, so it can't round above
  // a ceiling; the open question is how much precision to keep.
  //
  // The old code floored at a flat 2 dp (USDC) / 4 dp (SOL). For USDC that threw away up
  // to 0.01 — on a ~1 USDC position it stranded ~1% and showed MAX = 0.99 for a real
  // position of 0.999999666. So finer is better... EXCEPT when a recall will pay an exit
  // fee. Empirically (simulated on the live SOL vault): a MAX withdraw settles at 4 dp
  // (0.1000) but REVERTS at 5–6 dp (0.10008 / 0.100083). The coarse floor is load-bearing
  // safety margin there, not cosmetics — because withdraw() values shares against the
  // vault's deployed_balance at FACE value while a recall returns face-minus-fee, so the
  // settleable max sits a hair below the computed ceiling by an amount only ~4 dp of slack
  // reliably clears.
  //
  // Discriminator: phantomRaw > 0 means fee-bearing capital is deployed, so a MAX withdraw
  // will recall-and-lose-fee -> keep the proven 4 dp margin. phantomRaw == 0 (e.g. the
  // USDC vault: Kamino/Solend both zero exit cost) means no recall fee -> native precision
  // is safe and fixes the stranding. Deposits never touch a ceiling, so always native.
  const withdrawFloorDp = phantomRaw > 0 ? 4 : decimals;
  const setMax = () => {
    if (tab === "deposit" && maxDeposit !== null) {
      setAmount((Math.floor(maxDeposit * 10 ** decimals) / 10 ** decimals).toFixed(decimals));
    } else if (tab === "withdraw") {
      const dp = withdrawFloorDp;
      setAmount((Math.floor(maxWithdrawTokens * 10 ** dp) / 10 ** dp).toFixed(dp));
    }
  };

  const parsedAmount = parseFloat(amount) || 0;
  const estimatedReceive = tab === "withdraw" && parsedAmount > 0 ? (() => {
    // Fee applies only to profit, not principal
    const originalTokens = depositedAmount / 10 ** decimals; // what user put in
    const profitTokens = Math.max(0, positionTokens - originalTokens); // yield earned
    // Fraction of position being withdrawn
    const withdrawFraction = positionTokens > 0 ? Math.min(parsedAmount / positionTokens, 1) : 0;
    const profitBeingWithdrawn = profitTokens * withdrawFraction;
    const fee = profitBeingWithdrawn * (effectiveFeeBps / 10000);
    return Math.max(0, parsedAmount - fee);
  })() : null;

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 24, minWidth: 340, maxWidth: 420 }}>

      {/* Withdraw: position summary */}
      {tab === "withdraw" && (
        <div style={{ background: "var(--bg)", borderRadius: 8, padding: "12px 14px", marginBottom: 16, fontSize: 13 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ color: "var(--text-muted)" }}>Your position</span>
            <span style={{ fontFamily: "var(--mono)", fontWeight: 700 }}>
              {userShares > 0 ? `${fmt(positionTokens, decimals === 9 ? 4 : 2)} ${asset}` : "No position"}
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--text-muted)" }}>Performance fee{tierLabel ? <span style={{ marginLeft: 6, fontSize: 10, background: tierLabel === "Whitelisted" ? "var(--green)" : tierLabel === "Gold" ? "#c9a227" : tierLabel === "Silver" ? "#aaa" : "#cd7f32", color: "#fff", borderRadius: 4, padding: "1px 5px" }}>{tierLabel}</span> : null}</span>
            <span>{(effectiveFeeBps / 100).toFixed(1)}% on profit only</span>
          </div>
        </div>
      )}

      {/* Amount input */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <label style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {tab === "deposit" ? `Amount to deposit` : `Amount to withdraw`}
          </label>
          {tab === "deposit" && walletBalance !== null && (
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              Balance: {fmt(walletBalance)} {asset}
            </span>
          )}
        </div>
        <div style={{ position: "relative" }}>
          <input
            type="number"
            value={amount}
            onFocus={fetchBalance}
            onChange={e => setAmount(e.target.value)}
            placeholder="0.00"
            style={{
              width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
              borderRadius: 8, padding: "12px 70px 12px 14px", color: "var(--text)",
              fontSize: 18, fontFamily: "var(--mono)", outline: "none", boxSizing: "border-box",
            }}
          />
          <span style={{ position: "absolute", right: 52, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", fontSize: 13, fontWeight: 600 }}>
            {asset}
          </span>
          {(tab === "deposit" ? walletBalance !== null : userShares > 0) && (
            <button
              onClick={setMax}
              style={{
                position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
                background: "var(--surface-2)", border: "none", color: "var(--purple-light)",
                fontSize: 11, fontWeight: 700, padding: "4px 8px", borderRadius: 4, cursor: "pointer",
              }}
            >MAX</button>
          )}
        </div>
      </div>

      {/* Deposit: route preview */}
      {tab === "deposit" && bestApy && (
        <div style={{ background: "var(--bg)", borderRadius: 8, padding: "12px 14px", marginBottom: 20 }}>
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 4 }}>Auto-routed to best APY</div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span>{bestApy.name} · {bestApy.asset}</span>
            <span style={{ color: "var(--green)", fontWeight: 700 }}>{bestApy.stale ? "— APY" : `${fmt(bestApy.apyPercent)}% APY`}</span>
          </div>
        </div>
      )}

      {/* Withdraw: explain why MAX is below the user's position.
          Without this, MAX fills 0.0997 against a position that reads 0.1 and the
          user reasonably assumes the app is short-changing them. It isn't — the
          remainder is unreachable until the protocol exit fees stop being left
          behind as phantom deployed_balance (a program-side fix). Say so plainly
          rather than letting them guess. */}
      {withdrawCappedByFees && (
        <div style={{ background: "var(--bg)", borderRadius: 8, padding: "10px 14px", marginBottom: 12, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
          Max withdrawable is{" "}
          <span style={{ fontFamily: "var(--mono)", color: "var(--text)" }}>
            {fmt(maxWithdrawTokens, decimals === 9 ? 4 : 2)} {asset}
          </span>{" "}
          of your {fmt(positionTokens, decimals === 9 ? 4 : 2)} {asset} position — the difference covers
          the exit fees charged by the protocols your funds are staked in.
        </div>
      )}

      {/* Withdraw: estimated receive */}
      {tab === "withdraw" && parsedAmount > 0 && estimatedReceive !== null && (
        <div style={{ background: "var(--bg)", borderRadius: 8, padding: "12px 14px", marginBottom: 20, fontSize: 13 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--text-muted)" }}>You will receive ~</span>
            <span style={{ fontFamily: "var(--mono)", fontWeight: 700, color: "var(--green)" }}>
              {fmt(estimatedReceive, decimals === 9 ? 4 : 2)} {asset}
            </span>
          </div>
        </div>
      )}

      <Button
        fullWidth
        size="lg"
        onClick={handleAction}
        disabled={!publicKey || !amount || parsedAmount <= 0 || busy || (tab === "withdraw" && userShares === 0)}
      >
        {!publicKey
          ? "Connect wallet first"
          : busy
          ? "Processing..."
          : tab === "deposit"
          ? `Deposit ${parsedAmount > 0 ? fmt(parsedAmount, decimals === 9 ? 4 : 2) : "0"} ${asset}`
          : userShares === 0
          ? "No position to withdraw"
          : `Withdraw ${parsedAmount > 0 ? fmt(parsedAmount, decimals === 9 ? 4 : 2) : "0"} ${asset}`}
      </Button>

      {!publicKey && (
        <p style={{ color: "var(--text-muted)", fontSize: 12, textAlign: "center", marginTop: 10 }}>
          Connect your Phantom or Solflare wallet to continue
        </p>
      )}
    </div>
  );
}
