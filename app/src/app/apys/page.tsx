"use client";

import { useApys } from "@/hooks/useApys";
import { Card, CardHeader, fmt } from "@/components/ui";
import { useState, useEffect } from "react";

const RISK_LABEL: Record<number, { label: string; color: string }> = {
  1: { label: "Low",    color: "var(--green)" },
  2: { label: "Medium", color: "var(--yellow)" },
  3: { label: "High",   color: "var(--red)" },
};

function fmtTvl(usd: number) {
  if (usd >= 1_000_000_000) return `$${(usd / 1e9).toFixed(1)}B`;
  if (usd >= 1_000_000)     return `$${(usd / 1e6).toFixed(0)}M`;
  return `$${(usd / 1e3).toFixed(0)}K`;
}

function ILRiskModal({ onAccept, onDecline }: { onAccept: () => void; onDecline: () => void }) {
  return (
    <div
      onClick={onDecline}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "40px 24px", overflowY: "auto",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: 16, maxWidth: 520, width: "100%", padding: "36px 32px",
          margin: "auto", maxHeight: "90vh", overflowY: "auto",
        }}
      >
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)",
          borderRadius: 6, padding: "5px 12px", marginBottom: 20,
        }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--red)" }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--red)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
            Risk Disclosure
          </span>
        </div>

        <h2 style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em", marginBottom: 8 }}>
          LP pools carry impermanent loss risk.
        </h2>
        <p style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.7, marginBottom: 20 }}>
          Raydium and Orca are <strong>liquidity provider (LP) pools</strong>, not lending protocols.
          When you provide liquidity to these pools, your returns depend on trading fees — but you
          also take on <strong>impermanent loss (IL)</strong>.
        </p>

        <div style={{
          background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.15)",
          borderRadius: 10, padding: "18px 20px", marginBottom: 20,
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: "var(--text)" }}>
            What is impermanent loss?
          </div>
          <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.7, margin: 0 }}>
            LP pools hold two assets (e.g. USDC + SOL) in a fixed ratio. If SOL's price moves
            significantly up or down while your funds are in the pool, you end up with <em>less value</em> than
            if you had simply held the assets. This loss can <strong>exceed the trading fees earned</strong>,
            meaning you lose principal — not just yield.
          </p>
        </div>

        <div style={{
          background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.15)",
          borderRadius: 10, padding: "18px 20px", marginBottom: 28,
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: "var(--text)" }}>
            Why this is toggled off by default
          </div>
          <ul style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.8, margin: 0, paddingLeft: 18 }}>
            <li>IL is not a fee — it is a structural price risk on your principal</li>
            <li>High displayed APYs (20-25%) can still result in a net loss during volatile markets</li>
            <li>YieldPilot's default protocols are lending and liquid staking — no price exposure to two assets</li>
          </ul>
        </div>

        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-muted)", marginBottom: 20 }}>
          By enabling LP pools you acknowledge you understand and accept impermanent loss risk,
          and that your principal is not protected from price-driven losses.
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <button
            onClick={onDecline}
            style={{
              flex: 1, padding: "12px 0", borderRadius: 8,
              border: "1px solid var(--border)", background: "transparent",
              color: "var(--text-muted)", fontSize: 13, fontWeight: 600, cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onAccept}
            style={{
              flex: 1, padding: "12px 0", borderRadius: 8,
              border: "1px solid rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.1)",
              color: "var(--red)", fontSize: 13, fontWeight: 700, cursor: "pointer",
            }}
          >
            I understand — enable LP pools
          </button>
        </div>
      </div>
    </div>
  );
}

const LP_PROTOCOL_IDS = new Set(["raydium-usdc-sol", "orca-usdc-eth"]);

export default function ApysPage() {
  const { apys, loading } = useApys();
  const [lpEnabled, setLpEnabled] = useState(false);
  const [showModal, setShowModal] = useState(false);

  // Persist LP toggle preference across page reloads
  useEffect(() => {
    setLpEnabled(localStorage.getItem("yp_lp_enabled") === "true");
  }, []);

  function handleToggle() {
    if (lpEnabled) {
      // Turning off — no confirmation needed
      const next = false;
      setLpEnabled(next);
      localStorage.setItem("yp_lp_enabled", "false");
    } else {
      // Turning on — show disclosure modal first
      setShowModal(true);
    }
  }

  function acceptLpRisk() {
    setShowModal(false);
    setLpEnabled(true);
    localStorage.setItem("yp_lp_enabled", "true");
  }

  function declineLpRisk() {
    setShowModal(false);
  }

  const sorted = [...apys]
    .filter(p => lpEnabled || !LP_PROTOCOL_IDS.has(p.protocolId))
    .sort((a, b) => b.apyBps - a.apyBps);

  // Safe protocols only (for ROUTING HERE label — never point to LP)
  const safeProtocols = sorted.filter(p => !LP_PROTOCOL_IDS.has(p.protocolId));

  return (
    <>
      {showModal && <ILRiskModal onAccept={acceptLpRisk} onDecline={declineLpRisk} />}

      <div style={{ maxWidth: 860, margin: "0 auto", padding: "48px 24px 80px" }}>

        {/* Page header */}
        <div style={{ marginBottom: 48 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>
            Live data
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.025em", marginBottom: 4 }}>
            Protocol rates.
          </h1>
          <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.025em", color: "var(--purple-light)", marginBottom: 20 }}>
            Updated every 15 minutes.
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 14, lineHeight: 1.7, maxWidth: 520 }}>
            YieldPilot monitors these protocols continuously. 80% of vault assets route to the top rate,
            20% stays in the runner-up. Rates update every 15 minutes; display refreshes every 60 seconds.
          </p>
        </div>

        {/* Routing logic strip */}
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 1, background: "var(--border)", borderRadius: 10, overflow: "hidden",
          marginBottom: 40, border: "1px solid var(--border)",
        }}>
          {[
            { label: "Primary allocation", value: "80%" },
            { label: "Runner-up allocation", value: "20%" },
            { label: "Rebalance threshold", value: "0.5%" },
            { label: "Rebalance cycle", value: "15 min" },
          ].map(({ label, value }) => (
            <div key={label} style={{ background: "var(--surface)", padding: "20px 24px" }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 22, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
                {value}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</div>
            </div>
          ))}
        </div>

        {/* APY table */}
        <Card>
          <CardHeader
            title="All Protocols"
            right={
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                {/* LP toggle */}
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>LP pools</span>
                  <button
                    onClick={handleToggle}
                    aria-label="Toggle LP pools"
                    style={{
                      position: "relative", width: 40, height: 22, borderRadius: 11,
                      border: lpEnabled ? "1px solid rgba(239,68,68,0.5)" : "1px solid var(--border)",
                      background: lpEnabled ? "rgba(239,68,68,0.15)" : "var(--bg)",
                      cursor: "pointer", flexShrink: 0, transition: "all 0.2s",
                    }}
                  >
                    <span style={{
                      position: "absolute", top: 3, left: lpEnabled ? 20 : 3,
                      width: 14, height: 14, borderRadius: "50%",
                      background: lpEnabled ? "var(--red)" : "var(--text-dim)",
                      transition: "left 0.2s",
                    }} />
                  </button>
                  {lpEnabled && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, color: "var(--red)",
                      background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)",
                      borderRadius: 4, padding: "2px 6px", letterSpacing: "0.06em",
                    }}>IL RISK</span>
                  )}
                </div>
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                  {loading ? "Refreshing..." : "Auto-refreshes every 60s"}
                </span>
              </div>
            }
          />

          {/* Table header */}
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 80px 100px 80px 80px",
            padding: "8px 20px", borderBottom: "1px solid var(--border)",
            color: "var(--text-dim)", fontSize: 11, fontWeight: 700,
            textTransform: "uppercase", letterSpacing: "0.06em",
          }}>
            <span>Protocol</span>
            <span style={{ textAlign: "right" }}>Asset</span>
            <span style={{ textAlign: "right" }}>APY</span>
            <span style={{ textAlign: "right" }}>TVL</span>
            <span style={{ textAlign: "right" }}>Risk</span>
          </div>

          {sorted.map((p, i) => {
            const risk = RISK_LABEL[p.riskScore] || { label: "—", color: "var(--text-muted)" };
            const isLP = LP_PROTOCOL_IDS.has(p.protocolId);
            // ROUTING HERE / 20% HERE badges only apply to safe protocols
            const safeRank = safeProtocols.findIndex(s => s.protocolId === p.protocolId);
            return (
              <div key={p.protocolId} style={{
                display: "grid", gridTemplateColumns: "1fr 80px 100px 80px 80px",
                padding: "14px 20px", borderTop: i === 0 ? "none" : "1px solid var(--border)",
                alignItems: "center",
                background: safeRank === 0 ? "rgba(124,58,237,0.04)" : isLP ? "rgba(239,68,68,0.03)" : "var(--surface)",
                opacity: isLP ? 0.85 : 1,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <div style={{
                    width: 7, height: 7, borderRadius: "50%",
                    background: isLP ? "var(--red)" : (p.color || "var(--purple)"), flexShrink: 0,
                  }} />
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</span>
                  {safeRank === 0 && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "2px 7px",
                      borderRadius: 4, background: "rgba(52,211,153,0.12)",
                      color: "var(--green)", border: "1px solid rgba(52,211,153,0.2)",
                      letterSpacing: "0.04em",
                    }}>ROUTING HERE</span>
                  )}
                  {safeRank === 1 && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "2px 7px",
                      borderRadius: 4, background: "rgba(124,58,237,0.1)",
                      color: "var(--purple-light)", border: "1px solid rgba(124,58,237,0.2)",
                      letterSpacing: "0.04em",
                    }}>20% HERE</span>
                  )}
                  {isLP && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "2px 7px",
                      borderRadius: 4, background: "rgba(239,68,68,0.1)",
                      color: "var(--red)", border: "1px solid rgba(239,68,68,0.2)",
                      letterSpacing: "0.04em",
                    }}>LP · IL RISK</span>
                  )}
                </div>
                <span style={{ textAlign: "right", color: "var(--text-muted)", fontSize: 12, fontFamily: "var(--mono)" }}>
                  {p.asset}
                </span>
                <span style={{
                  textAlign: "right", fontFamily: "var(--mono)", fontWeight: 700, fontSize: 15,
                  color: isLP ? "var(--red)" : (safeRank === 0 ? "var(--green)" : "var(--text)"),
                }}>
                  {fmt(p.apyPercent)}%
                </span>
                <span style={{ textAlign: "right", color: "var(--text-muted)", fontSize: 12, fontFamily: "var(--mono)" }}>
                  {fmtTvl(p.tvlUsd)}
                </span>
                <span style={{ textAlign: "right", fontSize: 12, fontWeight: 600, color: risk.color }}>
                  {risk.label}
                </span>
              </div>
            );
          })}
        </Card>

        {lpEnabled && (
          <div style={{
            marginTop: 16, padding: "14px 18px", borderRadius: 10,
            background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.2)",
            fontSize: 13, color: "var(--red)", lineHeight: 1.6,
          }}>
            <strong>LP pools are enabled.</strong> Raydium and Orca carry impermanent loss risk —
            your principal is not protected from price-driven losses. YieldPilot will still route
            80/20 to safe lending protocols unless you are opted into LP routing via vault settings.
          </div>
        )}

        <p style={{ marginTop: 20, color: "var(--text-dim)", fontSize: 11, lineHeight: 1.65 }}>
          APYs are estimates based on recent protocol data and may change. Past performance does not
          guarantee future returns. LP pool APYs displayed when enabled are gross of impermanent loss.
          Always do your own research before depositing.
        </p>
      </div>
    </>
  );
}
