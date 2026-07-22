"use client";

import { useState } from "react";
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

  // `stale: true` means we did NOT fetch this rate — it is either the client-side
  // placeholder or a failed fetch. Stale entries may still carry a number, so those
  // entries carry plausible-looking hardcoded numbers, so every AGGREGATE below must
  // exclude them or a fabricated rate silently becomes a headline figure. ProtocolTable
  // already renders per-row stale as "—"; these aggregates did not, which meant Avg
  // Protocol APY / Best Available rendered fallback numbers on first paint and stayed
  // there for good if /api/apys was down. Same bug class as the fake Solend 5.10%.
  const lendingApys = apys.filter(a => a.riskScore <= 1 && !a.stale);
  const hasLiveApys = lendingApys.length > 0;
  const avgApy = hasLiveApys ? lendingApys.reduce((s, a) => s + a.apyPercent, 0) / lendingApys.length : 0;
  const bestApy = hasLiveApys ? Math.max(...lendingApys.map((a) => a.apyPercent)) : 0;
  const bestProtocol = hasLiveApys ? lendingApys.find((a) => a.apyPercent === bestApy) : undefined;

  // Total Earned — a clearly-labelled PROJECTION, not a realized figure.
  //
  // We deliberately do NOT trust p.earnedValue here. It is derived from the on-chain
  // total_deposits, which only learns about yield when a recall REALIZES it — so between
  // recalls it reads $0, and worse, it can carry orphaned realized-yield from a prior
  // withdrawal that has no funds behind it (fixed on-chain by settle_recall / reconcile in
  // the pending upgrade). Until reconcile() ships, the honest on-chain number is either $0
  // or wrong-by-dust, so dressing it up as "all time" earnings would be a lie.
  //
  // Instead project from what IS reliable: real deposited principal x the vault ACTUAL
  // blended rate (its live allocation weighted by each protocol APY) x time deposited.
  // Scaled by DEPLOYED_FRACTION because ~10% sits idle as the withdrawal buffer and earns
  // nothing. This grows continuously and never claims to be realized.
  //
  // ABSTAIN if ANY active protocol lacks a live rate. Deliberately mirrors the keeper's
  // rule from PR #105 (`computeRebalanceDecision` abstains entirely rather than routing
  // around a stale protocol). Blending only the protocols we CAN price would silently
  // reweight the vault — a stale 80% leg would let the live 20% leg set the whole
  // projection — which is how a fabricated input turns into a confident wrong number.
  // Abstaining shows "accruing" instead, which is honest about what we don't know.
  const DEPLOYED_FRACTION = 0.9; // mirrors MIN_IDLE_BPS = 1000 (10% idle buffer)
  const vaultBlendedApy = (vault: typeof vaults[number] | undefined): number => {
    if (!vault) return 0;
    const active = vault.protocols.filter(p => p.targetBps > 0);
    const totalBps = active.reduce((sum, p) => sum + p.targetBps, 0);
    if (totalBps === 0) return 0;
    const rates = active.map(p => apys.find(x => x.protocolId === p.name));
    if (rates.some(a => !a || a.stale)) return 0;
    return active.reduce((sum, p, i) => sum + rates[i]!.apyPercent * (p.targetBps / totalBps), 0);
  };
  const totalEarned = positions.reduce((s, p) => {
    const v = vaults.find(v => v.address === p.vault);
    if (!v || p.lastDepositTs <= 0) return s;
    const apy = vaultBlendedApy(v);
    if (apy <= 0) return s;
    const decimals = v.name.toUpperCase().includes("SOL") ? 1e9 : 1e6;
    const yearFraction = Math.max(0, Date.now() / 1000 - p.lastDepositTs) / 31_536_000;
    const principalUsd = (p.depositedAmount / decimals) * (v.name.toUpperCase().includes("SOL") ? solPrice : 1);
    return s + principalUsd * DEPLOYED_FRACTION * (apy / 100) * yearFraction;
  }, 0);

  const primaryVault = vaults[0];
  // "AUTOPILOT ENGAGED" was a HARDCODED string — it never read autoRebalance, so it claimed
  // engaged while autopilot was off, the vault was paused, or the keeper was dead. It has been
  // lying since the USDC vault's auto-rebalance was deliberately disabled as Solend containment.
  // `autoRebalance` gates whether the keeper may CHANGE targets; deployment to existing targets
  // continues regardless, which is why "off" still means funds are working — just not re-routed.
  const autopilotOn = !!primaryVault?.autoRebalance && !primaryVault?.paused;

  const usdcVault = vaults.find(v => v.name.toUpperCase().includes("USDC"));
  const solVault  = vaults.find(v => v.name.toUpperCase().includes("SOL"));
  const usdcTvl = usdcVault ? usdcVault.totalDeposits / 1e6 : null;
  const solTvl  = solVault  ? solVault.totalDeposits  / 1e9 : null;
  const hasTvl  = usdcTvl !== null || solTvl !== null;
  const lastCompound = primaryVault && primaryVault.lastCompoundTs > 0 ? new Date(primaryVault.lastCompoundTs * 1000) : null;
  const minutesSinceCompound = lastCompound ? Math.floor((Date.now() - lastCompound.getTime()) / 60000) : null;
  const onChainAllocation = primaryVault?.protocols.filter(p => p.targetBps > 0) || [];
  const topApys = [...apys].filter(a => a.riskScore <= 1).sort((a, b) => b.apyPercent - a.apyPercent).slice(0, 2);
  // Show ONLY the vault's real on-chain targets. This previously fell back to a
  // FABRICATED [best 80% / runner-up 20%] (or [best 100%]) built from the APY list whenever
  // a vault had no on-chain allocation — indistinguishable, to the user, from a real one.
  // That is the same failure that produced Solend's fake 5.10% and Jito's hardcoded 6.5%
  // base: a made-up number wearing the costume of live state. Render nothing instead.
  const currentAllocation = onChainAllocation;

  // Tiers only exist when the vault actually has a gate mint set. `system_program::ID` is
  // the program's "unset" sentinel, and on an ungated vault `withdraw()` skips tier logic
  // entirely and falls through to STANDARD_FEE_BPS = 900 (9%) for everyone.
  //
  // Without this check the ladder is decided by comparing `userGateBalance` against the
  // thresholds directly. That is currently harmless ONLY because the balance is always 0
  // (no gate mint exists on mainnet, so nobody can hold the token). The moment a real
  // gate mint is set, this would award tiers off a balance the program does not honour —
  // showing a user "Gold · 0% fee" while the chain charges them 9%. DepositWithdrawPanel
  // already gates on this; the dashboard did not.
  const SYSTEM_PROGRAM = "11111111111111111111111111111111";
  const gatingActive = !!primaryVault?.gateMint
    && primaryVault.gateMint !== SYSTEM_PROGRAM
    && primaryVault.gateMint !== "";
  const tierLabel = !gatingActive ? "Standard"
    : userGateBalance >= (primaryVault?.goldThreshold ?? 1_000_000) ? "Gold"
    : userGateBalance >= (primaryVault?.silverThreshold ?? 100_000) ? "Silver"
    : userGateBalance >= (primaryVault?.bronzeThreshold ?? 10_000) ? "Bronze"
    : "Standard";
  const tierColor = tierLabel === "Gold" ? "var(--token)" : tierLabel === "Silver" ? "var(--text-mid)" : tierLabel === "Bronze" ? "#CD7F32" : "var(--text-low)";

  // Tier-nudge: how many more $YPILOT to reach the next tier up, and how much
  // fee that saves. Every tier step saves 3pp (9/6/3/0), but computed via the
  // real fee map rather than hardcoded, so this stays correct if the fee
  // ladder itself ever changes (thresholds already can, via update_tier_thresholds).
  const FEE_BPS_BY_TIER: Record<string, number> = { Gold: 0, Silver: 3, Bronze: 6, Standard: 9 };
  const NEXT_TIER: Record<string, string> = { Standard: "Bronze", Bronze: "Silver", Silver: "Gold" };
  const THRESHOLD_BY_TIER: Record<string, number> = {
    Bronze: primaryVault?.bronzeThreshold ?? 10_000,
    Silver: primaryVault?.silverThreshold ?? 100_000,
    Gold: primaryVault?.goldThreshold ?? 1_000_000,
  };
  // Suppressed while gating is off: promising a fee saving nobody can unlock is the same
  // class of claim as the cadence and harvest copy removed in #121/#122.
  const nextTier = gatingActive ? NEXT_TIER[tierLabel] : undefined;
  const tokensToNextTier = nextTier ? Math.max(0, THRESHOLD_BY_TIER[nextTier] - userGateBalance) : 0;
  const nextTierFeeSavingsPct = nextTier ? FEE_BPS_BY_TIER[tierLabel] - FEE_BPS_BY_TIER[nextTier] : 0;

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
              {/* "45 min" was wrong: the 45-minute cron expression fires at :00 and :45
                  (a 45-then-15 split), and Actions delays on top — observed gaps 60-98 min.
                  See the How-it-works note below. */}
              <div className="mono-num" style={{ fontSize: 22, fontWeight: 500, color: "var(--warn)" }}>~hourly</div>
              <div style={{ fontSize: 12, color: "var(--text-low)", marginTop: 4 }}>Rebalance Cadence</div>
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
            <div className="live-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: autopilotOn ? "var(--signal)" : "var(--text-low)" }} />
            <span style={{ color: autopilotOn ? "var(--signal)" : "var(--text-low)", fontFamily: "var(--font-mono)", fontWeight: 500 }}>
              {primaryVault?.paused ? "VAULT PAUSED" : autopilotOn ? "AUTOPILOT ENGAGED" : "AUTOPILOT OFF"}
            </span>
            {currentAllocation[0] && <span style={{ color: "var(--text-low)" }}>· Routing to {currentAllocation[0].name}</span>}
            {/* Report when the keeper LAST acted (real, from lastCompoundTs on-chain) rather than
                predicting when it next will. The old "Next rebalance MM:SS" countdown ignored its
                own prop and rendered Date.now() % 45min — pure theatre. It can't be made accurate:
                the keeper runs on a GitHub Actions cron whose OBSERVED gaps are 60-98 minutes
                (the every-45 cron form actually means :00 and :45, and Actions cron drifts heavily on top). A
                verifiable "last acted" beats a confident, wrong prediction. */}
            {minutesSinceCompound !== null && (
              <span style={{ color: "var(--text-low)" }}>
                · Last compounded <span className="mono-num" style={{ color: "var(--text-hi)" }}>{minutesSinceCompound}m</span> ago
              </span>
            )}
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
            {nextTier && tokensToNextTier > 0 && (
              <div style={{ marginTop: 4 }}>
                You're <span className="mono-num" style={{ color: "var(--text-hi)" }}>{tokensToNextTier.toLocaleString()}</span> $YPILOT away from {nextTier} — save {nextTierFeeSavingsPct}% in fees
              </div>
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
            sub="Emits a compound checkpoint (yield accrues in-kind)"
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
            {/* Sub-cent earnings are REAL but round to $0.00 at 2dp, which reads as broken.
                A $12 position at ~6.5% takes ~3 days to clear a cent, so this is the normal
                early state, not an edge case. Show "<$0.01 · accruing" instead of a
                confident "$0.00 · projected". */}
            <StatCard
              label="Total Earned"
              value={totalEarned > 0 && totalEarned < 0.005 ? "<$0.01" : `$${fmt(totalEarned)}`}
              sub={totalEarned >= 0.005 ? "projected · est." : positions.length > 0 ? "accruing" : "—"}
              accent="var(--signal)"
            />
            <StatCard label="Avg Protocol APY" value={hasLiveApys ? `${fmt(avgApy)}%` : "—"} sub={hasLiveApys ? "across protocols" : "rates unavailable"} accent="var(--token)" />
            <StatCard label="Best Available" value={hasLiveApys ? `${fmt(bestApy)}%` : "—"} sub={bestProtocol ? `${bestProtocol.name} · ${bestProtocol.asset}` : "rates unavailable"} accent="var(--warn)" />
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
                  // Cadence: the cron is "*/45", which in cron fires at :00 and :45 — a 45-then-15
                  // split, NOT "every 45 minutes" — and GitHub Actions cron is best-effort on top.
                  // Observed gaps between real runs: 60-98 minutes. "~hourly" matches the wording
                  // already used on the APYs page; do not put a precise number back here.
                  ["2. Auto-optimize", "The keeper bot checks rates roughly hourly and moves funds when a better rate clears the drift threshold."],
                  // NOT "harvested and reinvested" — compound() is a no-op on-chain (it updates a
                  // timestamp and emits an event; it moves no funds). Nothing needs harvesting:
                  // yield accrues inside each receipt token's exchange rate (mSOL/jitoSOL/kUSDC
                  // appreciate on their own) and is realized into the vault on recall. Claiming an
                  // hourly harvest described work the program does not do.
                  ["3. Auto-compound", "Your yield accrues inside each protocol's receipt token, so it compounds on its own — nothing to harvest or claim."],
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




