"use client";

export const dynamic = "force-dynamic";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useConnection } from "@solana/wallet-adapter-react";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { Card, CardHeader, Button, TxBanner, fmt } from "@/components/ui";
import { useApys } from "@/hooks/useApys";
import IDL from "@/idl/yieldpilot.json";

const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID || "8c7Boyk91MWkn5jabf5CnYD8DrG6p4hYm9eDdAAWXEKH"
);
const VAULT_ADDRESSES = (process.env.NEXT_PUBLIC_VAULT_ADDRESSES || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const ADMIN_WALLET = process.env.NEXT_PUBLIC_ADMIN_WALLET || "8i7kydJHwi3Cdp46Xugyux2vWJmTScYDvnJrBiBihBnP";

type TxStatus = "idle" | "signing" | "confirming" | "success" | "error";

export default function AdminPage() {
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const { connection } = useConnection();
  const { apys } = useApys();

  const [txStatus, setTxStatus] = useState<TxStatus>("idle");
  const [txError, setTxError] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);

  // Form state
  const [newGateMint, setNewGateMint] = useState("");
  const [newTreasury, setNewTreasury] = useState("");
  const [pauseVaultIdx, setPauseVaultIdx] = useState(0);
  const [newTvlCap, setNewTvlCap] = useState("");
  const [rebalanceAllocs, setRebalanceAllocs] = useState("8000,2000");

  const isAdmin = connected && publicKey?.toBase58() === ADMIN_WALLET;

  const getProgram = () => {
    const wallet = {
      publicKey: publicKey!,
      signTransaction: async (tx: any) => tx,
      signAllTransactions: async (txs: any[]) => txs,
    };
    const provider = new anchor.AnchorProvider(connection, wallet as any, { commitment: "confirmed" });
    return new anchor.Program(IDL as any, provider);
  };

  const wrapTx = async (fn: () => Promise<string>) => {
    setTxStatus("signing");
    setTxError(null);
    try {
      setTxStatus("confirming");
      const sig = await fn();
      setLastSig(sig);
      setTxStatus("success");
      setTimeout(() => setTxStatus("idle"), 5000);
    } catch (e: any) {
      setTxError(e.message || "Transaction failed");
      setTxStatus("error");
      setTimeout(() => setTxStatus("idle"), 6000);
    }
  };

  const handleSetGateMint = () => wrapTx(async () => {
    const program = getProgram();
    const vault = new PublicKey(VAULT_ADDRESSES[0]);
    return program.methods.setGateMint(new PublicKey(newGateMint))
      .accounts({ admin: publicKey!, vault }).rpc();
  });

  const handleSetTreasury = () => wrapTx(async () => {
    const program = getProgram();
    const vault = new PublicKey(VAULT_ADDRESSES[0]);
    return program.methods.setTreasury(new PublicKey(newTreasury))
      .accounts({ admin: publicKey!, vault }).rpc();
  });

  const handlePause = (paused: boolean) => wrapTx(async () => {
    const program = getProgram();
    const vault = new PublicKey(VAULT_ADDRESSES[pauseVaultIdx]);
    return program.methods.setPaused(paused)
      .accounts({ admin: publicKey!, vault }).rpc();
  });

  const handleSetTvlCap = () => wrapTx(async () => {
    const program = getProgram();
    const vault = new PublicKey(VAULT_ADDRESSES[0]);
    const cap = new anchor.BN(Math.floor(parseFloat(newTvlCap) * 1e6));
    return program.methods.setTvlCap(cap)
      .accounts({ admin: publicKey!, vault }).rpc();
  });

  const handleRebalance = () => wrapTx(async () => {
    const program = getProgram();
    const vault = new PublicKey(VAULT_ADDRESSES[0]);
    const allocs = rebalanceAllocs.split(",").map(s => new anchor.BN(parseInt(s.trim())));
    return program.methods.rebalance(allocs)
      .accounts({ admin: publicKey!, vault }).rpc();
  });

  if (!connected) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "70vh", gap: 16 }}>
        <div style={{ fontSize: 40 }}>🔐</div>
        <div style={{ fontWeight: 700, fontSize: 20 }}>Admin Access Required</div>
        <div style={{ color: "var(--text-muted)", fontSize: 14 }}>Connect the admin wallet to continue.</div>
        <Button onClick={() => setVisible(true)}>Connect Wallet</Button>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "70vh", gap: 16 }}>
        <div style={{ fontSize: 40 }}>⛔</div>
        <div style={{ fontWeight: 700, fontSize: 20 }}>Not Authorized</div>
        <div style={{ color: "var(--text-muted)", fontSize: 14 }}>
          Connected wallet is not the vault admin.
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-dim)" }}>
          {publicKey?.toBase58()}
        </div>
      </div>
    );
  }

  const inputStyle: React.CSSProperties = {
    width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
    borderRadius: 8, padding: "10px 14px", color: "var(--text)", fontSize: 13,
    fontFamily: "var(--mono)", outline: "none", boxSizing: "border-box",
  };
  const labelStyle: React.CSSProperties = {
    color: "var(--text-muted)", fontSize: 11, fontWeight: 700,
    textTransform: "uppercase", letterSpacing: "0.08em", display: "block", marginBottom: 6,
  };

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "32px 16px 80px" }}>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>⚙️ Admin Panel</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14, marginTop: 4 }}>
          Vault: <span style={{ fontFamily: "var(--mono)", color: "var(--purple-light)" }}>
            {VAULT_ADDRESSES[0]?.slice(0, 8)}...{VAULT_ADDRESSES[0]?.slice(-8)}
          </span>
        </p>
      </div>

      <TxBanner status={txStatus} error={txError} sig={lastSig} />

      <div className="admin-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>

        {/* Token Gate */}
        <Card>
          <CardHeader title="Token Gate" />
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label style={labelStyle}>Gate Token Mint (pump.fun)</label>
              <input style={inputStyle} value={newGateMint} onChange={e => setNewGateMint(e.target.value)}
                placeholder="Mint address or 11111...1 to disable" />
            </div>
            <div style={{ background: "var(--bg)", borderRadius: 8, padding: "10px 12px", fontSize: 12, color: "var(--text-muted)" }}>
              <div>🥇 Gold (1M+ tokens) — unlimited</div>
              <div>🥈 Silver (100k+) — $10k cap</div>
              <div>🥉 Bronze (10k+) — $1k cap</div>
              <div style={{ marginTop: 4 }}>Set to SystemProgram to disable gating.</div>
            </div>
            <Button onClick={handleSetGateMint} disabled={!newGateMint}>Update Gate Mint</Button>
          </div>
        </Card>

        {/* Treasury */}
        <Card>
          <CardHeader title="Performance Fee Treasury" />
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label style={labelStyle}>Treasury Wallet Address</label>
              <input style={inputStyle} value={newTreasury} onChange={e => setNewTreasury(e.target.value)}
                placeholder="Wallet that receives perf fees" />
            </div>
            <div style={{ background: "var(--bg)", borderRadius: 8, padding: "10px 12px", fontSize: 12, color: "var(--text-muted)" }}>
              Performance fees are collected on every withdrawal (5% of profit only).
              Set to your wallet to receive them.
            </div>
            <Button onClick={handleSetTreasury} disabled={!newTreasury}>Update Treasury</Button>
          </div>
        </Card>

        {/* Vault Controls */}
        <Card>
          <CardHeader title="Vault Controls" />
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", gap: 10 }}>
              <Button onClick={() => handlePause(true)} variant="secondary">⏸ Pause</Button>
              <Button onClick={() => handlePause(false)}>▶ Unpause</Button>
            </div>
            <div style={{ height: 1, background: "var(--border)" }} />
            <div>
              <label style={labelStyle}>TVL Cap (USDC)</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input style={{ ...inputStyle, flex: 1 }} type="number" value={newTvlCap}
                  onChange={e => setNewTvlCap(e.target.value)} placeholder="e.g. 100000" />
                <Button onClick={handleSetTvlCap} disabled={!newTvlCap}>Set</Button>
              </div>
            </div>
          </div>
        </Card>

        {/* Manual Rebalance */}
        <Card>
          <CardHeader title="Manual Rebalance" />
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label style={labelStyle}>Allocations (bps, comma-separated, must sum to 10000)</label>
              <input style={inputStyle} value={rebalanceAllocs} onChange={e => setRebalanceAllocs(e.target.value)}
                placeholder="8000,2000" />
            </div>
            <div style={{ background: "var(--bg)", borderRadius: 8, padding: "10px 12px", fontSize: 12, color: "var(--text-muted)" }}>
              {rebalanceAllocs.split(",").map((v, i) => (
                <div key={i}>Protocol {i + 1}: {parseInt(v.trim()) / 100 || 0}%</div>
              ))}
              <div style={{ marginTop: 4, color: rebalanceAllocs.split(",").reduce((s, v) => s + parseInt(v.trim() || "0"), 0) === 10000 ? "var(--green)" : "var(--red)" }}>
                Total: {rebalanceAllocs.split(",").reduce((s, v) => s + parseInt(v.trim() || "0"), 0) / 100}%
                {rebalanceAllocs.split(",").reduce((s, v) => s + parseInt(v.trim() || "0"), 0) !== 10000 && " ⚠ must equal 100%"}
              </div>
            </div>
            <Button onClick={handleRebalance}>Trigger Rebalance</Button>
          </div>
        </Card>
      </div>

      {/* Live APY snapshot */}
      <Card>
        <CardHeader title="Live APY Snapshot" right={
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Auto-refreshes every 60s</span>
        } />
        <div style={{ padding: "0 20px" }}>
          {apys.sort((a, b) => b.apyBps - a.apyBps).map(p => (
            <div key={p.protocolId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderTop: "1px solid var(--border)" }}>
              <div>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</span>
                <span style={{ color: "var(--text-muted)", fontSize: 12, marginLeft: 8 }}>{p.asset}</span>
              </div>
              <span style={{ fontFamily: "var(--mono)", color: "var(--green)", fontWeight: 700 }}>{fmt(p.apyPercent)}%</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
