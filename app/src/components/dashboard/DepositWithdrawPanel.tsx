"use client";
import { useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddress } from "@solana/spl-token";
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
}

export function DepositWithdrawPanel({ vault, apys, onDeposit, onWithdraw, userShares, depositedAmount = 0, initialTab = "deposit" }: Props) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [tab, setTab] = useState<"deposit" | "withdraw">(initialTab);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);

  const asset = vault.name.toUpperCase().includes("SOL") ? "SOL" : "USDC";
  const decimals = DECIMALS[asset] || 6;
  const bestApy = [...apys].sort((a, b) => b.apyBps - a.apyBps)[0];

  // Derive user's position value in tokens from shares
  const sharePrice = vault.totalShares > 0 ? vault.totalDeposits / vault.totalShares : 1;
  const positionTokens = (userShares * sharePrice) / 10 ** decimals; // ui amount
  const positionRaw = userShares * sharePrice; // in raw units (same decimals as totalDeposits)

  // Convert a token ui-amount to shares to burn
  const tokenAmountToShares = (uiAmount: number): anchor.BN => {
    if (vault.totalDeposits === 0 || vault.totalShares === 0) return new anchor.BN(0);
    const rawAmount = uiAmount * 10 ** decimals;
    const shares = Math.floor((rawAmount / vault.totalDeposits) * vault.totalShares);
    return new anchor.BN(shares);
  };

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

  const setMax = () => {
    if (tab === "deposit" && walletBalance !== null) {
      setAmount(String(walletBalance));
    } else if (tab === "withdraw") {
      setAmount(positionTokens.toFixed(decimals === 9 ? 4 : 2));
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
    const fee = profitBeingWithdrawn * (vault.perfFeeBps / 10000);
    return Math.max(0, parsedAmount - fee);
  })() : null;

  const tabStyle = (t: string): React.CSSProperties => ({
    flex: 1, padding: "9px 0", border: "none", cursor: "pointer",
    background: tab === t ? "var(--surface-2)" : "transparent",
    color: tab === t ? "var(--text)" : "var(--text-muted)",
    fontWeight: 600, fontSize: 13, borderRadius: 6, fontFamily: "Inter, sans-serif",
    transition: "all 0.15s",
  });

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 24, minWidth: 340, maxWidth: 420 }}>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 20 }}>{vault.name}</div>

      {/* Tab switcher */}
      <div style={{ display: "flex", background: "var(--bg)", padding: 3, borderRadius: 8, marginBottom: 20, gap: 3 }}>
        <button onClick={() => { setTab("deposit"); setAmount(""); }} style={tabStyle("deposit")}>Deposit</button>
        <button onClick={() => { setTab("withdraw"); setAmount(""); }} style={tabStyle("withdraw")}>Withdraw</button>
      </div>

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
            <span style={{ color: "var(--text-muted)" }}>Performance fee</span>
            <span>{(vault.perfFeeBps / 100).toFixed(1)}% on profit only</span>
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
            <span style={{ color: "var(--green)", fontWeight: 700 }}>{fmt(bestApy.apyPercent)}% APY</span>
          </div>
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
