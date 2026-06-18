"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { StatCard, Card, CardHeader, Toggle, TxBanner, fmt, fmtAddr } from "@/components/ui";
import { ProtocolTable } from "@/components/dashboard/ProtocolTable";
import { DepositWithdrawPanel } from "@/components/dashboard/DepositWithdrawPanel";
import { useYieldPilot } from "@/hooks/useYieldPilot";
import { useApys } from "@/hooks/useApys";

// Load vault addresses from env
const VAULT_ADDRESSES = (process.env.NEXT_PUBLIC_VAULT_ADDRESSES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

type Tab = "overview" | "protocols" | "deposit";

export default function Dashboard() {
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  const { vaults, positions, loading, txStatus, txError, lastTxSig, deposit, withdraw, refresh } =
    useYieldPilot(VAULT_ADDRESSES);
  const { apys, loading: apyLoading } = useApys();

  // ── Derived stats ─────────────────────────────────────────────────────────
  const totalDeposited = positions.reduce((s, p) => s + p.currentValue / 1e6, 0);
  const totalEarned    = positions.reduce((s, p) => s + p.earnedValue / 1e6, 0);
  const avgApy = apys.length ? apys.reduce((s, a) => s + a.apyPercent, 0) / apys.length : 0;
  const bestApy = apys.length ? Math.max(...apys.map((a) => a.apyPercent)) : 0;
  const bestProtocol = apys.find((a) => a.apyPercent === bestApy);

  const [selectedVaultIdx, setSelectedVaultIdx] = useState(0);
  const primaryVault = vaults[selectedVaultIdx] ?? vaults[0];
  const primaryPosition = positions[selectedVaultIdx] ?? positions[0];

  // ── Tabs ──────────────────────────────────────────────────────────────────
  const tabStyle = (t: Tab): React.CSSProperties => ({
    padding: "8px 16px", borderRadius: 7, border: "none", cursor: "pointer",
    background: activeTab === t ? "var(--purple)" : "transparent",
    color: activeTab === t ? "#fff" : "var(--text-muted)",
    fontWeight: 600, fontSize: 13, fontFamily: "Inter, sans-serif", transition: "all 0.15s",
  });

  // ── Landing (not connected) ───────────────────────────────────────────────
  if (!connected) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "80vh", gap: 20, padding: 24, textAlign: "center" }}>
        <div style={{ fontSize: 52 }}>⚡</div>
        <h1 style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1.1 }}>
          Earn the best yield<br />on Solana, automatically.
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 16, maxWidth: 420 }}>
          YieldPilot moves your tokens across Kamino, Marinade, Raydium, and more —
          chasing the highest APY without you lifting a finger.
        </p>
        <button
          onClick={() => setVisible(true)}
          style={{
            marginTop: 8, background: "linear-gradient(135deg, #7c3aed, #06b6d4)",
            color: "#fff", border: "none", padding: "14px 36px", borderRadius: 12,
            fontWeight: 700, fontSize: 16, cursor: "pointer", fontFamily: "Inter, sans-serif",
          }}
        >
          Connect Wallet to Start
        </button>
        <p style={{ color: "var(--text-dim)", fontSize: 12 }}>Works with Phantom & Solflare</p>

        {/* Protocol preview */}
        <div style={{ marginTop: 32, width: "100%", maxWidth: 640 }}>
          <ProtocolTable apys={apys} loading={apyLoading} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1020, margin: "0 auto", padding: "32px 16px 80px" }}>
      {/* Tx status */}
      <TxBanner status={txStatus} error={txError} sig={lastTxSig} />

      {/* Stats row */}
      <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
        <StatCard label="Your Deposits" value={`$${fmt(totalDeposited)}`} sub={positions.length ? `${positions.length} active position${positions.length > 1 ? "s" : ""}` : "No positions yet"} />
        <StatCard label="Total Earned" value={`$${fmt(totalEarned)}`} sub="all time" accent="var(--green)" />
        <StatCard label="Avg Protocol APY" value={`${fmt(avgApy)}%`} sub="across protocols" accent="var(--purple-light)" />
        <StatCard label="Best Available" value={`${fmt(bestApy)}%`} sub={bestProtocol ? `${bestProtocol.name} · ${bestProtocol.asset}` : ""} accent="var(--yellow)" />
      </div>

      {/* Automation toggles */}
      {primaryVault && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 24px", marginBottom: 20, display: "flex", gap: 32, flexWrap: "wrap" }}>
          <Toggle
            value={primaryVault.autoCompound}
            onChange={() => {}} // admin-only on-chain; UI reflects state
            label="Auto-Compound"
            sub="Reinvests rewards hourly"
          />
          <Toggle
            value={primaryVault.autoRebalance}
            onChange={() => {}}
            label="Auto-Rebalance"
            sub="Keeper moves funds to best APY"
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
            <button
              onClick={refresh}
              style={{ background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text-muted)", padding: "6px 12px", borderRadius: 7, fontSize: 12, cursor: "pointer", fontFamily: "Inter" }}
            >
              ↻ Refresh
            </button>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 20, background: "var(--surface)", padding: 4, borderRadius: 10, border: "1px solid var(--border)", width: "fit-content" }}>
        {(["overview", "protocols", "deposit"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setActiveTab(t)} style={tabStyle(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* ── Overview ─────────────────────────────────────────────────────── */}
      {activeTab === "overview" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Positions */}
          <Card>
            <CardHeader title="Your Positions" />
            {positions.length === 0 ? (
              <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-muted)" }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>📭</div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>No positions yet</div>
                <div style={{ fontSize: 13 }}>Deposit to start earning yield automatically.</div>
                <button onClick={() => setActiveTab("deposit")} style={{ marginTop: 14, background: "var(--purple)", color: "#fff", border: "none", padding: "8px 18px", borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "Inter" }}>
                  Make your first deposit →
                </button>
              </div>
            ) : (
              positions.map((pos, i) => {
                const vault = vaults.find((v) => v.address === pos.vault);
                return (
                  <div key={i} style={{ padding: "16px 20px", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                    <div style={{ width: 38, height: 38, borderRadius: 8, background: "var(--surface-2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>💵</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>{vault?.name || "Vault"}</div>
                      <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
                        {fmt(pos.depositedAmount / 1e6)} deposited · {fmtAddr(pos.vault)}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ color: "var(--green)", fontWeight: 700, fontFamily: "var(--mono)" }}>
                        +${fmt(pos.earnedValue / 1e6, 4)} earned
                      </div>
                      <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
                        ${fmt(pos.currentValue / 1e6)} current value
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </Card>

          {/* Protocol snapshot */}
          <ProtocolTable apys={apys} loading={apyLoading} />
        </div>
      )}

      {/* ── Protocols ────────────────────────────────────────────────────── */}
      {activeTab === "protocols" && (
        <ProtocolTable apys={apys} loading={apyLoading} />
      )}

      {/* ── Deposit/Withdraw ─────────────────────────────────────────────── */}
      {activeTab === "deposit" && (
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div style={{ width: "100%", display: "flex", gap: 8, marginBottom: 4 }}>
            {vaults.map((v, i) => (
              <button
                key={v.address}
                onClick={() => setSelectedVaultIdx(i)}
                style={{
                  padding: "8px 20px", borderRadius: 8, border: "1px solid var(--border)",
                  cursor: "pointer", fontWeight: 600, fontSize: 13, fontFamily: "Inter, sans-serif",
                  background: selectedVaultIdx === i ? "var(--purple)" : "var(--surface)",
                  color: selectedVaultIdx === i ? "#fff" : "var(--text-muted)",
                  transition: "all 0.15s",
                }}
              >
                {v.name}
              </button>
            ))}
          </div>
          {primaryVault ? (
            <DepositWithdrawPanel
              vault={primaryVault}
              apys={apys}
              onDeposit={deposit}
              onWithdraw={withdraw}
              userShares={primaryPosition?.shares || 0}
            />
          ) : (
            <div style={{ color: "var(--text-muted)", padding: 20 }}>
              {loading ? "Loading vault..." : "No vault configured. Set NEXT_PUBLIC_VAULT_ADDRESSES in .env.local"}
            </div>
          )}

          {/* Info panel */}
          <div style={{ flex: 1, minWidth: 260 }}>
            <Card>
              <CardHeader title="How it works" />
              <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
                {[
                  ["1. Deposit", "You deposit tokens into the vault. You receive shares representing your ownership."],
                  ["2. Auto-optimize", "The keeper bot moves funds to highest-yield protocols every 15 minutes."],
                  ["3. Auto-compound", "Rewards are harvested and reinvested every hour, growing your position."],
                  ["4. Withdraw anytime", "Burn your shares to receive your tokens plus earned yield, minus a small performance fee."],
                ].map(([title, desc]) => (
                  <div key={title}>
                    <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>{title}</div>
                    <div style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.5 }}>{desc}</div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
