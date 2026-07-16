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
import IDL from "@/idl/yieldpilot.mainnet.json";

const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID || "3tAEmHXZ51YVLe9ts8b9cMcgQPgaSamLxLtxR31VpREi"
);
const VAULT_ADDRESSES = (process.env.NEXT_PUBLIC_VAULT_ADDRESSES || "5XpzWiE8jb53CShYv19UoXcY2AywjeXpfwCff8mgrNYn,7MJGAiZmTre6VmVQXgYRK6vqoQeoMW1jwEL9jEXZgRy3")
  .split(",").map(s => s.trim()).filter(Boolean);
const ADMIN_WALLET = process.env.NEXT_PUBLIC_ADMIN_WALLET || "8i7kydJHwi3Cdp46Xugyux2vWJmTScYDvnJrBiBihBnP";

type TxStatus = "idle" | "signing" | "confirming" | "success" | "error";

export default function AdminPage() {
  const { publicKey, connected, signTransaction, signAllTransactions } = useWallet();
  const { setVisible } = useWalletModal();
  const { connection } = useConnection();
  const { apys } = useApys();

  const [txStatus, setTxStatus] = useState<TxStatus>("idle");
  const [txError, setTxError] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);

  // Form state
  const [newGateMint, setNewGateMint] = useState("");
  const [pauseVaultIdx, setPauseVaultIdx] = useState(0);
  const [newTvlCap, setNewTvlCap] = useState("");
  const [rebalanceAllocs, setRebalanceAllocs] = useState("8000,2000");
  const [whitelistAddr, setWhitelistAddr] = useState("");
  const [whitelistCheckAddr, setWhitelistCheckAddr] = useState("");
  const [whitelistCheckResult, setWhitelistCheckResult] = useState<string | null>(null);

  const isAdmin = connected && publicKey?.toBase58() === ADMIN_WALLET;

  const getProgram = () => {
    const wallet = {
      publicKey: publicKey!,
      signTransaction,
      signAllTransactions,
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

  const handlePause = (paused: boolean) => wrapTx(async () => {
    const program = getProgram();
    const vault = new PublicKey(VAULT_ADDRESSES[pauseVaultIdx]);
    return program.methods.setPaused(paused)
      .accounts({ admin: publicKey!, vault }).rpc();
  });

  // Real instruction is raise_tvl_cap — one-directional, can only increase.
  // (set_tvl_cap/set_treasury don't exist on-chain; both were intentionally
  // removed so the cap can't be weaponized to block deposits and treasury
  // can't be redirected to steal fees — see lib.rs's comments.)
  const handleRaiseTvlCap = () => wrapTx(async () => {
    const program = getProgram();
    const vault = new PublicKey(VAULT_ADDRESSES[0]);
    const cap = new anchor.BN(Math.floor(parseFloat(newTvlCap) * 1e6));
    return program.methods.raiseTvlCap(cap)
      .accounts({ admin: publicKey!, vault }).rpc();
  });

  const handleRebalance = () => wrapTx(async () => {
    const program = getProgram();
    const vault = new PublicKey(VAULT_ADDRESSES[0]);
    const allocs = rebalanceAllocs.split(",").map(s => new anchor.BN(parseInt(s.trim())));
    return program.methods.rebalance(allocs)
      .accounts({ admin: publicKey!, vault }).rpc();
  });

  const whitelistPda = (wallet: string) => {
    const vault = new PublicKey(VAULT_ADDRESSES[0]);
    const walletPubkey = new PublicKey(wallet);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("wl"), vault.toBuffer(), walletPubkey.toBuffer()],
      PROGRAM_ID
    );
    return pda;
  };

  const handleAddWhitelist = () => wrapTx(async () => {
    const program = getProgram();
    const vault = new PublicKey(VAULT_ADDRESSES[0]);
    const walletPubkey = new PublicKey(whitelistAddr);
    const pda = whitelistPda(whitelistAddr);
    return program.methods.addToWhitelist(walletPubkey)
      .accounts({ admin: publicKey!, vault, whitelistEntry: pda, systemProgram: anchor.web3.SystemProgram.programId })
      .rpc();
  });

  const handleRemoveWhitelist = () => wrapTx(async () => {
    const program = getProgram();
    const vault = new PublicKey(VAULT_ADDRESSES[0]);
    const walletPubkey = new PublicKey(whitelistAddr);
    const pda = whitelistPda(whitelistAddr);
    return program.methods.removeFromWhitelist(walletPubkey)
      .accounts({ admin: publicKey!, vault, whitelistEntry: pda })
      .rpc();
  });

  const handleCheckWhitelist = async () => {
    if (!whitelistCheckAddr.trim()) return;
    try {
      const pda = whitelistPda(whitelistCheckAddr.trim());
      const info = await connection.getAccountInfo(pda);
      setWhitelistCheckResult(info ? "✓ Whitelisted (0% fee)" : "✗ Not whitelisted");
    } catch {
      setWhitelistCheckResult("Invalid address");
    }
  };

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
              <label style={labelStyle}>Raise TVL Cap (USDC) — one-directional, can only increase</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input style={{ ...inputStyle, flex: 1 }} type="number" value={newTvlCap}
                  onChange={e => setNewTvlCap(e.target.value)} placeholder="e.g. 100000" />
                <Button onClick={handleRaiseTvlCap} disabled={!newTvlCap}>Raise</Button>
              </div>
            </div>
            <div style={{ background: "var(--bg)", borderRadius: 8, padding: "10px 12px", fontSize: 12, color: "var(--text-muted)" }}>
              Treasury and performance fee tiers are fixed at vault creation and cannot be changed afterward — this is a deliberate on-chain protection, not a missing feature. Performance fees are tiered by gate-token tier (Gold 0% / Silver 3% / Bronze 6% / Standard 9%), charged on profit only.
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

        {/* Whitelist */}
        <Card>
          <CardHeader title="Whitelist Management" />
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label style={labelStyle}>Wallet Address</label>
              <input style={inputStyle} value={whitelistAddr} onChange={e => setWhitelistAddr(e.target.value)}
                placeholder="Wallet to add or remove" />
            </div>
            <div style={{ background: "var(--bg)", borderRadius: 8, padding: "10px 12px", fontSize: 12, color: "var(--text-muted)" }}>
              Whitelisted wallets pay zero performance fee on withdrawal.
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <Button onClick={handleAddWhitelist} disabled={!whitelistAddr}>Add to Whitelist</Button>
              <Button onClick={handleRemoveWhitelist} disabled={!whitelistAddr} variant="secondary">Remove</Button>
            </div>
          </div>
        </Card>

        {/* Check whitelist status */}
        <Card>
          <CardHeader title="Check Whitelist Status" />
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label style={labelStyle}>Wallet Address</label>
              <input style={inputStyle} value={whitelistCheckAddr} onChange={e => setWhitelistCheckAddr(e.target.value)}
                placeholder="Wallet address to check" />
            </div>
            <Button onClick={handleCheckWhitelist} disabled={!whitelistCheckAddr} variant="secondary">Check Status</Button>
            {whitelistCheckResult && (
              <div style={{ fontSize: 13, fontWeight: 600, color: whitelistCheckResult.startsWith("✓") ? "var(--green)" : "var(--text-muted)" }}>
                {whitelistCheckResult}
              </div>
            )}
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
              <span style={{ fontFamily: "var(--mono)", color: "var(--green)", fontWeight: 700 }}>{p.stale ? "—" : `${fmt(p.apyPercent)}%`}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
