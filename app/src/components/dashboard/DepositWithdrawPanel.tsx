"use client";
import { useState, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { Button, fmt } from "@/components/ui";
import type { VaultInfo } from "@/hooks/useYieldPilot";
import type { ProtocolApy } from "@/hooks/useApys";

const DECIMALS: Record<string, number> = {
  USDC: 6, USDT: 6, SOL: 9, ETH: 8,
};

const WSOL_MINT = "So11111111111111111111111111111111111111112";

function mintToSymbol(mint: string): string {
  if (mint === WSOL_MINT) return "SOL";
  if (mint === "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU") return "USDC";
  return mint.slice(0, 4);
}

interface Props {
  vault: VaultInfo;
  apys: ProtocolApy[];
  onDeposit: (vaultAddress: string, mint: string, amount: anchor.BN) => Promise<any>;
  onWithdraw: (vaultAddress: string, mint: string, shares: anchor.BN) => Promise<any>;
  userShares: number;
  userCurrentValue?: number;
  mode: "deposit" | "withdraw";
}

export function DepositWithdrawPanel({ vault, apys, onDeposit, onWithdraw, userShares, userCurrentValue, mode }: Props) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const tab = mode;
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);

  const asset = mintToSymbol(vault.mint);
  const decimals = DECIMALS[asset] || 6;
  const isNativeSOL = vault.mint === WSOL_MINT;
  const bestApy = apys.sort((a, b) => b.apyBps - a.apyBps)[0];

  // Estimated token amount the user would get back if they withdraw everything
  const estimatedAll = userCurrentValue ? userCurrentValue / (isNativeSOL ? 1e9 : 1e6) : null;

  useEffect(() => { fetchBalance(); }, [publicKey, vault.mint]);

  const fetchBalance = async () => {
    if (!publicKey) return;
    try {
      if (isNativeSOL) {
        const lamports = await connection.getBalance(publicKey);
        setWalletBalance(lamports / 1e9);
      } else {
        const { PublicKey } = await import("@solana/web3.js");
        const ata = await getAssociatedTokenAddress(new PublicKey(vault.mint), publicKey);
        const info = await connection.getTokenAccountBalance(ata);
        setWalletBalance(info.value.uiAmount || 0);
      }
    } catch {
      setWalletBalance(0);
    }
  };

  const handleDeposit = async () => {
    if (!amount || busy) return;
    setBusy(true);
    try {
      const raw = new anchor.BN(Math.floor(parseFloat(amount) * 10 ** decimals));
      await onDeposit(vault.address, vault.mint, raw);
      setAmount("");
    } finally {
      setBusy(false);
    }
  };

  const handleWithdraw = async (allShares?: boolean) => {
    if (busy) return;
    if (!allShares && !amount) return;
    setBusy(true);
    try {
      const shares = allShares
        ? new anchor.BN(userShares)
        : new anchor.BN(Math.floor(parseFloat(amount) * 10 ** decimals));
      await onWithdraw(vault.address, vault.mint, shares);
      setAmount("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 24, maxWidth: 400 }}>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 20 }}>{vault.name}</div>

      {/* Amount input */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <label style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {tab === "deposit" ? "Amount to deposit" : "Amount to withdraw"}
          </label>
          {walletBalance !== null && tab === "deposit" && (
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              Balance: {walletBalance.toFixed(decimals === 9 ? 5 : 2)} {asset}
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
              borderRadius: 8, padding: "12px 60px 12px 14px", color: "var(--text)",
              fontSize: 18, fontFamily: "var(--mono)", outline: "none", boxSizing: "border-box",
            }}
          />
          {walletBalance !== null && tab === "deposit" && (
            <button
              onClick={() => setAmount(String(walletBalance))}
              style={{
                position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
                background: "var(--surface-2)", border: "none", color: "var(--purple-light)",
                fontSize: 11, fontWeight: 700, padding: "4px 8px", borderRadius: 4, cursor: "pointer",
              }}
            >MAX</button>
          )}
        </div>
      </div>

      {/* Route preview */}
      {tab === "deposit" && bestApy && (
        <div style={{ background: "var(--bg)", borderRadius: 8, padding: "12px 14px", marginBottom: 20 }}>
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 4 }}>Auto-routed to best APY</div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span>{bestApy.name} · {bestApy.asset}</span>
            <span style={{ color: "var(--green)", fontWeight: 700 }}>{fmt(bestApy.apyPercent)}% APY</span>
          </div>
        </div>
      )}

      {/* Withdraw info + Withdraw All */}
      {tab === "withdraw" && (
        <div style={{ background: "var(--bg)", borderRadius: 8, padding: "12px 14px", marginBottom: 20, fontSize: 13 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ color: "var(--text-muted)" }}>Available to withdraw</span>
            <span style={{ fontFamily: "var(--mono)", fontWeight: 600 }}>
              {estimatedAll !== null ? `~${estimatedAll.toFixed(decimals === 9 ? 5 : 2)} ${asset}` : "—"}
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--text-muted)" }}>Perf fee (on profit)</span>
            <span>{(vault.perfFeeBps / 100).toFixed(1)}%</span>
          </div>
          <button
            onClick={() => handleWithdraw(true)}
            disabled={busy || userShares === 0}
            style={{
              marginTop: 12, width: "100%", padding: "9px 0",
              background: "transparent", border: "1px solid var(--border)",
              borderRadius: 8, color: userShares === 0 ? "var(--text-muted)" : "var(--text)",
              fontWeight: 600, fontSize: 13,
              cursor: (busy || userShares === 0) ? "not-allowed" : "pointer",
              fontFamily: "Inter, sans-serif",
              opacity: (busy || userShares === 0) ? 0.5 : 1,
            }}
          >
            {busy ? "Processing..." : estimatedAll !== null ? `Withdraw All (~${estimatedAll.toFixed(decimals === 9 ? 5 : 2)} ${asset})` : "Withdraw All"}
          </button>
        </div>
      )}

      {tab === "deposit" ? (
        <Button
          fullWidth
          size="lg"
          onClick={handleDeposit}
          disabled={!publicKey || !amount || parseFloat(amount) <= 0 || busy}
        >
          {!publicKey ? "Connect wallet first" : busy ? "Processing..." : `Deposit ${amount || "0"} ${asset}`}
        </Button>
      ) : (
        <Button
          fullWidth
          size="lg"
          onClick={() => handleWithdraw(false)}
          disabled={!publicKey || !amount || parseFloat(amount) <= 0 || busy}
        >
          {!publicKey ? "Connect wallet first" : busy ? "Processing..." : `Withdraw ${amount || "0"} ${asset}`}
        </Button>
      )}

      {!publicKey && (
        <p style={{ color: "var(--text-muted)", fontSize: 12, textAlign: "center", marginTop: 10 }}>
          Connect your Phantom or Solflare wallet to continue
        </p>
      )}
    </div>
  );
}
