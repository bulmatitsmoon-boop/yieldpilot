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

  const primaryVault = vaults[0];
  const primaryPosition = positions[0];

  // ── Global vault stats ────────────────────────────────────────────────────
  const totalTvl = vaults.reduce((s, v) => s + v.totalDeposits, 0);
  const totalTvlUsd = totalTvl / 1e6; // USDC vault is 6 decimals; approximate for display
  const lastCompound = primaryVault ? new Date(primaryVault.lastCompoundTs * 1000) : null;
  const minutesSinceCompound = lastCompound ? Math.floor((Date.now() - lastCompound.getTime()) / 60000) : null;
  const onChainAllocation = primaryVault?.protocols.filter(p => p.targetBps > 0) || [];
  // Fall back to APY-derived 80/20 allocation if on-chain hasn't rebalanced yet
  const topApys = [...apys].sort((a, b) => b.apyPercent - a.apyPercent).slice(0, 2);
  const currentAllocation = onChainAllocation.length > 0
    ? onChainAllocation
    : topApys.length >= 2
      ? [{ name: topApys[0].name, targetBps: 8000 }, { name: topApys[1].name, targetBps: 2000 }]
      : topApys.length === 1
        ? [{ name: topApys[0].name, targetBps: 10000 }]
        : [];

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
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "60px 16px 80px", display: "flex", flexDirection: "column", alignItems: "center", gap: 0, textAlign: "center" }}>

        {/* Hero */}
        <div style={{ marginBottom: 48 }}>
          <div style={{ width: 56, height: 56, borderRadius: 14, background: "linear-gradient(135deg, #7c3aed, #06b6d4)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
            <svg width="28" height="28" viewBox="0 0 14 14" fill="none"><path d="M7 1L12 4V10L7 13L2 10V4L7 1Z" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round"/><circle cx="7" cy="7" r="2" fill="#fff"/></svg>
          </div>
          <h1 style={{ fontSize: 36, fontWeight: 900, letterSpacing: "-0.03em", lineHeight: 1.1, marginBottom: 16 }}>
            Earn the best yield<br />on Solana, automatically.
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 16, maxWidth: 420, margin: "0 auto 28px", lineHeight: 1.6 }}>
            YieldPilot routes your USDC and SOL across top Solana protocols — rebalancing every 15 minutes to maximize your APY.
          </p>
          <button
            onClick={() => setVisible(true)}
            style={{
              background: "linear-gradient(135deg, #7c3aed, #06b6d4)",
              color: "#fff", border: "none", padding: "14px 36px", borderRadius: 12,
              fontWeight: 700, fontSize: 16, cursor: "pointer", fontFamily: "Inter, sans-serif",
            }}
          >
            Connect Wallet to Start
          </button>
          <p style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 10 }}>Works with Phantom & Solflare</p>
        </div>

        {/* Live vault stats */}
        <div style={{ width: "100%", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, padding: "24px 28px", marginBottom: 32 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 20 }}>Live Vault Stats</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 24 }}>
            <div style={{ textAlign: "left" }}>
              <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "var(--mono)", color: "var(--text)" }}>
                ${totalTvlUsd > 0 ? totalTvlUsd.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—"}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>Total Value Locked</div>
            </div>
            <div style={{ textAlign: "left" }}>
              <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "var(--mono)", color: "var(--green)" }}>
                {bestApy > 0 ? `${bestApy.toFixed(2)}%` : "—"}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>
                Best APY {bestProtocol ? `· ${bestProtocol.name}` : ""}
              </div>
            </div>
            <div style={{ textAlign: "left" }}>
              <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "var(--mono)", color: "var(--purple-light)" }}>
                {minutesSinceCompound !== null ? `${minutesSinceCompound}m ago` : "—"}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>Last Compounded</div>
            </div>
            <div style={{ textAlign: "left" }}>
              <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "var(--mono)", color: "var(--yellow)" }}>
                15 min
              </div>
              <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>Rebalance Interval</div>
            </div>
          </div>

          {/* Current allocation breakdown */}
          {currentAllocation.length > 0 && (
            <div style={{ marginTop: 24, paddingTop: 20, borderTop: "1px solid var(--border)" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14 }}>Current Allocation</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {currentAllocation.map((p, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 13, color: "var(--text-muted)", minWidth: 120, textAlign: "left" }}>{p.name}</div>
                    <div style={{ flex: 1, height: 6, background: "var(--bg)", borderRadius: 99, overflow: "hidden" }}>
                      <div style={{ width: `${p.targetBps / 100}%`, height: "100%", background: i === 0 ? "var(--purple)" : "var(--purple-light)", borderRadius: 99 }} />
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "var(--mono)", color: "var(--text)", minWidth: 40, textAlign: "right" }}>{(p.targetBps / 100).toFixed(0)}%</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Protocol preview */}
        <div style={{ width: "100%" }}>
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

          {/* Live vault stats */}
          <Card>
            <CardHeader title="Live Vault Stats" />
            <div style={{ padding: "16px 20px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 20, marginBottom: currentAllocation.length > 0 ? 20 : 0 }}>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 800, fontFamily: "var(--mono)" }}>
                    ${totalTvlUsd > 0 ? totalTvlUsd.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—"}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 3 }}>Total Value Locked</div>
                </div>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 800, fontFamily: "var(--mono)", color: "var(--green)" }}>
                    {bestApy > 0 ? `${bestApy.toFixed(2)}%` : "—"}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 3 }}>Best APY {bestProtocol ? `· ${bestProtocol.name}` : ""}</div>
                </div>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 800, fontFamily: "var(--mono)", color: "var(--purple-light)" }}>
                    {minutesSinceCompound !== null ? `${minutesSinceCompound}m ago` : "—"}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 3 }}>Last Compounded</div>
                </div>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 800, fontFamily: "var(--mono)", color: "var(--yellow)" }}>15 min</div>
                  <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 3 }}>Rebalance Interval</div>
                </div>
              </div>
              {currentAllocation.length > 0 && (
                <div style={{ paddingTop: 16, borderTop: "1px solid var(--border)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>Current Allocation</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {currentAllocation.map((p, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ fontSize: 13, color: "var(--text-muted)", minWidth: 120 }}>{p.name}</div>
                        <div style={{ flex: 1, height: 6, background: "var(--bg)", borderRadius: 99, overflow: "hidden" }}>
                          <div style={{ width: `${p.targetBps / 100}%`, height: "100%", background: i === 0 ? "var(--purple)" : "var(--purple-light)", borderRadius: 99 }} />
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "var(--mono)", minWidth: 40, textAlign: "right" }}>{(p.targetBps / 100).toFixed(0)}%</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Card>

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
