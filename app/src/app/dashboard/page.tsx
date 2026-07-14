"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { StatCard, Card, CardHeader, Toggle, TxBanner, fmt, fmtAddr } from "@/components/ui";
import { ProtocolTable } from "@/components/dashboard/ProtocolTable";
import { DepositWithdrawPanel } from "@/components/dashboard/DepositWithdrawPanel";
import { RecentTransactions } from "@/components/dashboard/RecentTransactions";
import { useYieldPilot } from "@/hooks/useYieldPilot";
import { useApys } from "@/hooks/useApys";
import { useSolPrice } from "@/hooks/useSolPrice";

// Load vault addresses from env
const VAULT_ADDRESSES = (process.env.NEXT_PUBLIC_VAULT_ADDRESSES || "F1r513ZZdofz4tjhRfhNAYDK5hsmc8uCZbMmg2tkPJ6e,8KcoRt5DcCbXBaqDVDorEbW2J6GofTrRyy9Afzb8wwaE")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

type Tab = "overview" | "protocols" | "deposit" | "withdraw";

const ADMIN_PUBKEY = "8i7kydJHwi3Cdp46Xugyux2vWJmTScYDvnJrBiBihBnP";
const REBALANCE_INTERVAL_SEC = 15 * 60;

function Countdown({ lastCompoundTs }: { lastCompoundTs: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  // Approximate: countdown to the next 15-min boundary since we don't expose the
  // keeper's exact next-poll timestamp. Good enough for the "alive" feel.
  const elapsed = Math.floor(now / 1000) % REBALANCE_INTERVAL_SEC;
  const remaining = REBALANCE_INTERVAL_SEC - elapsed;
  const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
  const ss = String(remaining % 60).padStart(2, "0");
  return (
    <span className="mono-num" style={{ color: remaining <= 10 ? "var(--warn)" : "var(--text-hi)" }}>
      {mm}:{ss}
    </span>
  );
}

export default function Dashboard() {
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const isAdmin = publicKey?.toBase58() === ADMIN_PUBKEY;
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [selectedVaultAddr, setSelectedVaultAddr] = useState<string | null>(null);

  const { vaults, positions, loading, txStatus, txError, vaultError, lastTxSig, userGateBalance, deposit, withdraw, updateSettings, refresh } =
    useYieldPilot(VAULT_ADDRESSES);
  const { apys, loading: apyLoading } = useApys();
  const solPrice = useSolPrice();

  // ── Derived stats ─────────────────────────────────────────────────────────
  const usdcPosition = positions.find(p => vaults.find(v => v.address === p.vault)?.name.toUpperCase().includes("USDC"));
  const solPosition  = positions.find(p => vaults.find(v => v.address === p.vault)?.name.toUpperCase().includes("SOL"));
  const usdcDeposited = usdcPosition ? usdcPosition.currentValue / 1e6 : null;
  const solDeposited  = solPosition  ? solPosition.currentValue  / 1e9 : null;
  const depositLabel = [
    usdcDeposited !== null ? `${usdcDeposited.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC` : null,
    solDeposited  !== null ? `${solDeposited.toLocaleString("en-US",  { minimumFractionDigits: 4, maximumFractionDigits: 4 })} SOL`  : null,
  ].filter(Boolean).join(" · ") || "—";

  const lendingApys = apys.filter(a => a.riskScore <= 1);
  const avgApy = lendingApys.length ? lendingApys.reduce((s, a) => s + a.apyPercent, 0) / lendingApys.length : 0;
  const bestApy = lendingApys.length ? Math.max(...lendingApys.map((a) => a.apyPercent)) : 0;
  const bestProtocol = lendingApys.find((a) => a.apyPercent === bestApy);

  const totalEarned = positions.reduce((s, p) => {
    const v = vaults.find(v => v.address === p.vault);
    const decimals = v?.name.toUpperCase().includes("SOL") ? 1e9 : 1e6;
    if (p.earnedValue > 0) return s + p.earnedValue / decimals;
    if (p.lastDepositTs > 0 && bestApy > 0) {
      const secsElapsed = Math.max(0, Date.now() / 1000 - p.lastDepositTs);
      const yearFraction = secsElapsed / 31_536_000;
      const depositUsd = (p.depositedAmount / decimals) * (v?.name.toUpperCase().includes("SOL") ? solPrice : 1);
      return s + depositUsd * (bestApy / 100) * yearFraction;
    }
    return s;
  }, 0);
  const isProjected = positions.length > 0 && positions.every(p => p.earnedValue === 0);

  const primaryVault = vaults[0];

  const usdcVault = vaults.find(v => v.name.toUpperCase().includes("USDC"));
  const solVault  = vaults.find(v => v.name.toUpperCase().includes("SOL"));
  const usdcTvl = usdcVault ? usdcVault.totalDeposits / 1e6 : null;
  const solTvl  = solVault  ? solVault.totalDeposits  / 1e9 : null;
  const hasTvl  = usdcTvl !== null || solTvl !== null;
  const lastCompound = primaryVault && primaryVault.lastCompoundTs > 0 ? new Date(primaryVault.lastCompoundTs * 1000) : null;
  const minutesSinceCompound = lastCompound ? Math.floor((Date.now() - lastCompound.getTime()) / 60000) : null;
  const onChainAllocation = primaryVault?.protocols.filter(p => p.targetBps > 0) || [];
  const topApys = [...apys].filter(a => a.riskScore <= 1).sort((a, b) => b.apyPercent - a.apyPercent).slice(0, 2);
  const currentAllocation = onChainAllocation.length > 0
    ? onChainAllocation
    : topApys.length >= 2
      ? [{ name: topApys[0].name, targetBps: 8000 }, { name: topApys[1].name, targetBps: 2000 }]
      : topApys.length === 1
        ? [{ name: topApys[0].name, targetBps: 10000 }]
        : [];

  const tierLabel = userGateBalance >= (primaryVault?.goldThreshold ?? 1_000_000) ? "Gold"
    : userGateBalance >= (primaryVault?.silverThreshold ?? 100_000) ? "Silver"
    : userGateBalance >= (primaryVault?.bronzeThreshold ?? 10_000) ? "Bronze"
    : "Standard";
  const tierColor = tierLabel === "Gold" ? "var(--token)" : tierLabel === "Silver" ? "var(--text-mid)" : tierLabel === "Bronze" ? "#CD7F32" : "var(--text-low)";

  const tabStyle = (t: Tab): React.CSSProperties => ({
    padding: "8px 16px", borderRadius: 7, border: "none", cursor: "pointer",
    background: activeTab === t ? "var(--signal)" : "transparent",
    color: activeTab === t ? "var(--ink-900)" : "var(--text-mid)",
    fontWeight: 600, fontSize: 13, fontFamily: "var(--font-body)", transition: "all 0.15s",
  });

  // ── Disconnected: preview state ───────────────────────────────────────────
  if (!connected) {
    return (
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "60px 16px 80px", display: "flex", flexDirection: "column", alignItems: "center", gap: 0, textAlign: "center", position: "relative" }}>
        <div className="aurora-bg" />

        <div style={{ marginBottom: 48, position: "relative", zIndex: 1 }}>
          <div style={{ width: 56, height: 56, borderRadius: 14, background: "var(--ink-800)", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
            <svg width="28" height="28" viewBox="0 0 14 14" fill="none"><path d="M7 1L12 4V10L7 13L2 10V4L7 1Z" stroke="var(--signal)" strokeWidth="1.5" strokeLinejoin="round"/><circle cx="7" cy="7" r="2" fill="var(--signal)"/></svg>
          </div>
          <h1 style={{ fontFamily: "var(--font-display)", fontSize: 34, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.15, marginBottom: 16, color: "var(--text-hi)" }}>
            Your capital, on autopilot.
          </h1>
          <p style={{ color: "var(--text-mid)", fontSize: 16, maxWidth: 420, margin: "0 auto 28px", lineHeight: 1.6 }}>
            Connect to see your position, earnings, and tier — routed across Solana&apos;s top protocols automatically.
          </p>
          <button
            onClick={() => setVisible(true)}
            style={{
              background: "var(--signal)",
              color: "var(--ink-900)", border: "none", padding: "14px 36px", borderRadius: 12,
              fontWeight: 700, fontSize: 16, cursor: "pointer", fontFamily: "var(--font-body)",
            }}
          >
            Connect Wallet
          </button>
          <p style={{ color: "var(--text-low)", fontSize: 12, marginTop: 10 }}>Works with Phantom & Solflare</p>
        </div>

        <div style={{ width: "100%", background: "var(--ink-800)", border: "1px solid var(--line)", borderRadius: 16, padding: "24px 28px", marginBottom: 32, position: "relative", zIndex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-low)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 20, fontFamily: "var(--font-mono)" }}>Live vault stats</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 24 }}>
            <div style={{ textAlign: "left" }}>
              <div className="mono-num" style={{ fontSize: 22, fontWeight: 500, color: "var(--text-hi)" }}>
                {hasTvl ? (
                  <>
                    {usdcTvl !== null && <span>{usdcTvl.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC</span>}
                    {usdcTvl !== null && solTvl !== null && <span style={{ color: "var(--text-low)", margin: "0 6px" }}>·</span>}
                    {solTvl !== null && <span>{solTvl.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })} SOL</span>}
                  </>
                ) : "—"}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-low)", marginTop: 4 }}>Total Value Locked</div>
            </div>
            <div style={{ textAlign: "left" }}>
              <div className="mono-num" style={{ fontSize: 22, fontWeight: 500, color: "var(--signal)" }}>
                {bestApy > 0 ? `${bestApy.toFixed(2)}%` : "—"}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-low)", marginTop: 4 }}>
                Best APY {bestProtocol ? `· ${bestProtocol.name}` : ""}
              </div>
            </div>
            <div style={{ textAlign: "left" }}>
              <div className="mono-num" style={{ fontSize: 22, fontWeight: 500, color: "var(--token)" }}>
                {minutesSinceCompound !== null ? minutesSinceCompound < 60 ? `${minutesSinceCompound}m ago` : minutesSinceCompound < 1440 ? `${Math.floor(minutesSinceCompound/60)}h ago` : `${Math.floor(minutesSinceCompound/1440)}d ago` : "—"}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-low)", marginTop: 4 }}>Last Compounded</div>
            </div>
            <div style={{ textAlign: "left" }}>
              <div className="mono-num" style={{ fontSize: 22, fontWeight: 500, color: "var(--warn)" }}>15 min</div>
              <div style={{ fontSize: 12, color: "var(--text-low)", marginTop: 4 }}>Rebalance Interval</div>
            </div>
          </div>

          {currentAllocation.length > 0 && (
            <div style={{ marginTop: 24, paddingTop: 20, borderTop: "1px solid var(--line)" }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-low)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14, fontFamily: "var(--font-mono)" }}>Current Allocation</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {currentAllocation.map((p, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 13, color: "var(--text-mid)", minWidth: 120, textAlign: "left" }}>{p.name}</div>
                    <div style={{ flex: 1, height: 6, background: "var(--ink-900)", borderRadius: 99, overflow: "hidden" }}>
                      <div style={{ width: `${p.targetBps / 100}%`, height: "100%", background: i === 0 ? "var(--signal)" : "var(--signal-dim)", opacity: i === 0 ? 1 : 0.6, borderRadius: 99 }} />
                    </div>
                    <div className="mono-num" style={{ fontSize: 13, fontWeight: 500, color: "var(--text-hi)", minWidth: 40, textAlign: "right" }}>{(p.targetBps / 100).toFixed(0)}%</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ width: "100%", position: "relative", zIndex: 1 }}>
          <ProtocolTable apys={apys} loading={apyLoading} />
        </div>
      </div>
    );
  }

  // ── Connected: instrument cluster centerpiece ─────────────────────────────
  return (
    <div style={{ maxWidth: 1060, margin: "0 auto", padding: "32px 16px 80px" }}>
      <TxBanner status={txStatus} error={txError} sig={lastTxSig} />

      {/* Wallet strip */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="mono-num" style={{ fontSize: 13, color: "var(--text-mid)" }}>{publicKey && fmtAddr(publicKey.toBase58())}</span>
          <span style={{
            fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 4,
            background: "rgba(124,92,255,0.1)", color: tierColor,
            border: "1px solid rgba(124,92,255,0.25)", fontFamily: "var(--font-mono)",
          }}>{tierLabel.toUpperCase()} TIER</span>
        </div>
        <button
          onClick={refresh}
          style={{ background: "var(--ink-700)", border: "1px solid var(--line)", color: "var(--text-mid)", padding: "6px 12px", borderRadius: 7, fontSize: 12, cursor: "pointer", fontFamily: "var(--font-body)" }}
        >
          ↻ Refresh
        </button>
      </div>

      {/* Instrument cluster + actions */}
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16, marginBottom: 16 }}>
        {/* Instrument cluster */}
        <div style={{
          background: "var(--ink-800)", border: "1px solid var(--line)", borderRadius: 12,
          padding: 24, position: "relative", overflow: "hidden",
        }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-low)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6, fontFamily: "var(--font-mono)" }}>
            Position value
          </div>
          <div className="mono-num" style={{ fontSize: 40, fontWeight: 500, color: "var(--text-hi)", lineHeight: 1, marginBottom: 20 }}>
            {depositLabel}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20, fontSize: 12 }}>
            <div className="live-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--signal)" }} />
            <span style={{ color: "var(--signal)", fontFamily: "var(--font-mono)", fontWeight: 500 }}>AUTOPILOT ENGAGED</span>
            {currentAllocation[0] && <span style={{ color: "var(--text-low)" }}>· Routing to {currentAllocation[0].name}</span>}
            <span style={{ color: "var(--text-low)" }}>· Next rebalance</span>
            <Countdown lastCompoundTs={primaryVault?.lastCompoundTs ?? null} />
          </div>

          {currentAllocation.length > 0 && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-mid)", marginBottom: 6, fontFamily: "var(--font-mono)" }}>
                {currentAllocation.map((p, i) => (
                  <span key={i}>{p.name} {(p.targetBps / 100).toFixed(0)}%</span>
                ))}
              </div>
              <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", background: "var(--ink-700)" }}>
                {currentAllocation.map((p, i) => (
                  <div key={i} style={{
                    width: `${p.targetBps / 100}%`, background: i === 0 ? "var(--signal)" : "var(--signal-dim)",
                    opacity: i === 0 ? 1 : 0.55,
                  }} />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Actions panel */}
        <div style={{ background: "var(--ink-800)", border: "1px solid var(--line)", borderRadius: 12, padding: 20, display: "flex", flexDirection: "column", gap: 10 }}>
          <button onClick={() => setActiveTab("deposit")} style={{
            background: "var(--signal)", color: "var(--ink-900)", border: "none", padding: "12px", borderRadius: 8,
            fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "var(--font-body)",
          }}>Deposit</button>
          <button onClick={() => setActiveTab("withdraw")} style={{
            background: "var(--ink-700)", color: "var(--text-hi)", border: "1px solid var(--line)", padding: "12px", borderRadius: 8,
            fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "var(--font-body)",
          }}>Withdraw</button>

          <div style={{ marginTop: 8, paddingTop: 16, borderTop: "1px solid var(--line)", fontSize: 12, color: "var(--text-mid)", lineHeight: 1.7 }}>
            <div>Perf fee: <span className="mono-num" style={{ color: "var(--text-hi)" }}>{tierLabel === "Gold" ? "0%" : tierLabel === "Silver" ? "3%" : tierLabel === "Bronze" ? "6%" : "9%"}</span> on profit</div>
            {tierLabel !== "Gold" && (
              <div style={{ marginTop: 4 }}>Hold 1,000,000 $YPILOT → Gold (0% fee)</div>
            )}
          </div>
        </div>
      </div>

      {/* Automation toggles (admin) */}
      {primaryVault && isAdmin && (
        <div style={{ background: "var(--ink-800)", border: "1px solid var(--line)", borderRadius: 12, padding: "14px 24px", marginBottom: 16, display: "flex", gap: 32, flexWrap: "wrap" }}>
          <Toggle
            value={primaryVault.autoCompound}
            onChange={() => updateSettings(primaryVault.address, !primaryVault.autoCompound, primaryVault.autoRebalance)}
            label="Auto-Compound"
            sub="Reinvests rewards hourly"
          />
          <Toggle
            value={primaryVault.autoRebalance}
            onChange={() => updateSettings(primaryVault.address, primaryVault.autoCompound, !primaryVault.autoRebalance)}
            label="Auto-Rebalance"
            sub="Keeper moves funds to best APY"
          />
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 20, background: "var(--ink-800)", padding: 4, borderRadius: 10, border: "1px solid var(--line)", width: "fit-content", maxWidth: "100%" }}>
        {(["overview", "protocols", "deposit", "withdraw"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setActiveTab(t)} style={tabStyle(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* ── Overview ─────────────────────────────────────────────────────── */}
      {activeTab === "overview" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <StatCard label="Total Earned" value={`$${fmt(totalEarned)}`} sub={isProjected && totalEarned > 0 ? "projected" : "all time"} accent="var(--signal)" />
            <StatCard label="Avg Protocol APY" value={`${fmt(avgApy)}%`} sub="across protocols" accent="var(--token)" />
            <StatCard label="Best Available" value={`${fmt(bestApy)}%`} sub={bestProtocol ? `${bestProtocol.name} · ${bestProtocol.asset}` : ""} accent="var(--warn)" />
          </div>

          <Card>
            <CardHeader title="Your Positions" />
            {positions.length === 0 ? (
              <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-mid)" }}>
                <div style={{ fontWeight: 600, marginBottom: 6, color: "var(--text-hi)" }}>No position yet</div>
                <div style={{ fontSize: 13 }}>Deposit to start earning.</div>
                <button onClick={() => setActiveTab("deposit")} style={{ marginTop: 14, background: "var(--signal)", color: "var(--ink-900)", border: "none", padding: "8px 18px", borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "var(--font-body)" }}>
                  Make your first deposit →
                </button>
              </div>
            ) : (
              positions.map((pos, i) => {
                const vault = vaults.find((v) => v.address === pos.vault);
                return (
                  <div key={i} style={{ padding: "16px 20px", borderTop: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, color: "var(--text-hi)" }}>{vault?.name || "Vault"}</div>
                      <div style={{ color: "var(--text-mid)", fontSize: 12 }}>
                        {(() => { const d = vault?.name.toUpperCase().includes("SOL") ? 1e9 : 1e6; const sym = vault?.name.toUpperCase().includes("SOL") ? "SOL" : "USDC"; return `${fmt(pos.depositedAmount / d)} ${sym} deposited`; })()} · {fmtAddr(pos.vault)}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div className="mono-num" style={{ color: "var(--signal)", fontWeight: 500 }}>
                        {(() => { const d = vault?.name.toUpperCase().includes("SOL") ? 1e9 : 1e6; const sym = vault?.name.toUpperCase().includes("SOL") ? "SOL" : "USDC"; return `+${fmt(pos.earnedValue / d, 4)} ${sym} earned`; })()}
                      </div>
                      <div style={{ color: "var(--text-mid)", fontSize: 12 }}>
                        {(() => { const d = vault?.name.toUpperCase().includes("SOL") ? 1e9 : 1e6; const sym = vault?.name.toUpperCase().includes("SOL") ? "SOL" : "USDC"; return `${fmt(pos.currentValue / d)} ${sym} current value`; })()}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </Card>

          <RecentTransactions />

          <ProtocolTable apys={apys} loading={apyLoading} />
        </div>
      )}

      {/* ── Protocols ────────────────────────────────────────────────────── */}
      {activeTab === "protocols" && (
        <ProtocolTable apys={apys} loading={apyLoading} />
      )}

      {/* ── Deposit ──────────────────────────────────────────────────────── */}
      {activeTab === "deposit" && (
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
          {vaults.length > 0 ? (() => {
            const selectedVault = vaults.find(v => v.address === selectedVaultAddr) || vaults[0];
            const selectedPos = positions.find(p => p.vault === selectedVault.address);
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {vaults.length > 1 && (
                  <div style={{ display: "flex", background: "var(--ink-800)", border: "1px solid var(--line)", padding: 4, borderRadius: 10, gap: 4, width: "fit-content" }}>
                    {vaults.map(v => {
                      const sym = v.name.toUpperCase().includes("SOL") ? "SOL" : "USDC";
                      const isSel = selectedVaultAddr === v.address || (!selectedVaultAddr && v === vaults[0]);
                      return (
                        <button key={v.address} onClick={() => setSelectedVaultAddr(v.address)} style={{
                          padding: "7px 18px", borderRadius: 7, border: "none", cursor: "pointer",
                          background: isSel ? "var(--signal)" : "transparent",
                          color: isSel ? "var(--ink-900)" : "var(--text-mid)",
                          fontWeight: 600, fontSize: 13, fontFamily: "var(--font-body)",
                        }}>{sym}</button>
                      );
                    })}
                  </div>
                )}
                <DepositWithdrawPanel
                  vault={selectedVault}
                  apys={apys}
                  onDeposit={deposit}
                  onWithdraw={withdraw}
                  userShares={selectedPos?.shares || 0}
                  depositedAmount={selectedPos?.depositedAmount || 0}
                  userGateBalance={userGateBalance}
                />
              </div>
            );
          })() : (
            <div style={{ color: "var(--text-mid)", padding: 20 }}>
              {loading ? "Loading vault..." : vaultError ? `Error: ${vaultError}` : "No vault configured. Set NEXT_PUBLIC_VAULT_ADDRESSES in .env.local"}
            </div>
          )}
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
                    <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4, color: "var(--text-hi)" }}>{title}</div>
                    <div style={{ color: "var(--text-mid)", fontSize: 13, lineHeight: 1.5 }}>{desc}</div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* ── Withdraw ─────────────────────────────────────────────────────── */}
      {activeTab === "withdraw" && (
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
          {vaults.length > 0 ? (() => {
            const selectedVault = vaults.find(v => v.address === selectedVaultAddr) || vaults[0];
            const selectedPos = positions.find(p => p.vault === selectedVault.address);
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {vaults.length > 1 && (
                  <div style={{ display: "flex", background: "var(--ink-800)", border: "1px solid var(--line)", padding: 4, borderRadius: 10, gap: 4, width: "fit-content" }}>
                    {vaults.map(v => {
                      const sym = v.name.toUpperCase().includes("SOL") ? "SOL" : "USDC";
                      const isSel = selectedVaultAddr === v.address || (!selectedVaultAddr && v === vaults[0]);
                      return (
                        <button key={v.address} onClick={() => setSelectedVaultAddr(v.address)} style={{
                          padding: "7px 18px", borderRadius: 7, border: "none", cursor: "pointer",
                          background: isSel ? "var(--signal)" : "transparent",
                          color: isSel ? "var(--ink-900)" : "var(--text-mid)",
                          fontWeight: 600, fontSize: 13, fontFamily: "var(--font-body)",
                        }}>{sym}</button>
                      );
                    })}
                  </div>
                )}
                <DepositWithdrawPanel
                  vault={selectedVault}
                  apys={apys}
                  onDeposit={deposit}
                  onWithdraw={withdraw}
                  userShares={selectedPos?.shares || 0}
                  depositedAmount={selectedPos?.depositedAmount || 0}
                  initialTab="withdraw"
                  userGateBalance={userGateBalance}
                />
              </div>
            );
          })() : (
            <div style={{ color: "var(--text-mid)", padding: 20 }}>
              {loading ? "Loading vaults..." : "No vaults found."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
