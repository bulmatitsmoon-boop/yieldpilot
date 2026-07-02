"use client";

import { useApys } from "@/hooks/useApys";
import { Card, CardHeader, fmt } from "@/components/ui";
import { useState, useEffect } from "react";

// Only these protocol IDs have an on-chain deploy_to_* instruction — everything
// else (Drift, and LP pools when opted in) must never get a "ROUTING HERE" /
// "20% HERE" badge, regardless of riskScore or APY rank.
const ROUTABLE_PROTOCOL_IDS = new Set([
  "kamino-usdc", "kamino-sol", "marinade-sol", "jito-sol", "solend-usdc",
]);

const RISK_LABEL: Record<number, { label: string; color: string }> = {
  1: { label: "Low",    color: "var(--signal)" },
  2: { label: "Medium", color: "var(--warn)" },
  3: { label: "High",   color: "var(--loss)" },
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
          background: "var(--ink-800)", border: "1px solid var(--line)",
          borderRadius: 16, maxWidth: 520, width: "100%", padding: "36px 32px",
          margin: "auto", maxHeight: "90vh", overflowY: "auto",
        }}
      >
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          background: "rgba(255,107,107,0.1)", border: "1px solid rgba(255,107,107,0.25)",
          borderRadius: 6, padding: "5px 12px", marginBottom: 20,
        }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--loss)" }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--loss)", letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: "var(--font-mono)" }}>
            Risk Disclosure
          </span>
        </div>

        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 700, letterSpacing: "-0.015em", marginBottom: 8, color: "var(--text-hi)" }}>
          LP pools carry impermanent loss risk.
        </h2>
        <p style={{ fontSize: 14, color: "var(--text-mid)", lineHeight: 1.7, marginBottom: 20 }}>
          Raydium and Orca are <strong>liquidity provider (LP) pools</strong>, not lending protocols.
          They are shown here as reference market data only — YieldPilot has no on-chain instruction
          that can route your funds there, and never will unless that changes. When you provide liquidity
          to pools like these, your returns depend on trading fees — but you also take on
          <strong> impermanent loss (IL)</strong>.
        </p>

        <div style={{
          background: "rgba(255,107,107,0.06)", border: "1px solid rgba(255,107,107,0.15)",
          borderRadius: 10, padding: "18px 20px", marginBottom: 20,
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: "var(--text-hi)" }}>
            What is impermanent loss?
          </div>
          <p style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.7, margin: 0 }}>
            LP pools hold two assets (e.g. USDC + SOL) in a fixed ratio. If SOL&apos;s price moves
            significantly up or down while your funds are in the pool, you end up with <em>less value</em> than
            if you had simply held the assets. This loss can <strong>exceed the trading fees earned</strong>,
            meaning you lose principal — not just yield.
          </p>
        </div>

        <div style={{
          background: "rgba(255,107,107,0.06)", border: "1px solid rgba(255,107,107,0.15)",
          borderRadius: 10, padding: "18px 20px", marginBottom: 28,
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: "var(--text-hi)" }}>
            Why this is toggled off by default
          </div>
          <ul style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.8, margin: 0, paddingLeft: 18 }}>
            <li>IL is not a fee — it is a structural price risk on your principal</li>
            <li>High displayed APYs (20-25%) can still result in a net loss during volatile markets</li>
            <li>YieldPilot&apos;s vault only ever routes to lending and liquid staking — no price exposure to two assets</li>
          </ul>
        </div>

        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-mid)", marginBottom: 20 }}>
          This only affects what&apos;s displayed on this page — it does not change where your deposited
          funds are routed.
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <button
            onClick={onDecline}
            style={{
              flex: 1, padding: "12px 0", borderRadius: 8,
              border: "1px solid var(--line)", background: "transparent",
              color: "var(--text-mid)", fontSize: 13, fontWeight: 600, cursor: "pointer",
              fontFamily: "var(--font-body)",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onAccept}
            style={{
              flex: 1, padding: "12px 0", borderRadius: 8,
              border: "1px solid rgba(255,107,107,0.4)", background: "rgba(255,107,107,0.1)",
              color: "var(--loss)", fontSize: 13, fontWeight: 700, cursor: "pointer",
              fontFamily: "var(--font-body)",
            }}
          >
            I understand — show LP pools
          </button>
        </div>
      </div>
    </div>
  );
}

const LP_PROTOCOL_IDS = new Set(["raydium-usdc-sol", "orca-usdc-eth"]);

// Purely a display grouping for the type-filter tabs — not a routability signal.
const PROTOCOL_TYPE: Record<string, "Lending" | "Liquid stake" | "LP"> = {
  "kamino-usdc": "Lending", "kamino-sol": "Lending", "solend-usdc": "Lending", "drift-sol": "Lending",
  "marinade-sol": "Liquid stake", "jito-sol": "Liquid stake",
  "raydium-usdc-sol": "LP", "orca-usdc-eth": "LP",
};

type TypeFilter = "All" | "Lending" | "Liquid stake";

export default function ApysPage() {
  const { apys, loading } = useApys();
  const [lpEnabled, setLpEnabled] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("All");
  const [activeIdx, setActiveIdx] = useState(0);
  const [autoActive, setAutoActive] = useState(true);

  useEffect(() => {
    setLpEnabled(localStorage.getItem("yp_lp_enabled") === "true");
  }, []);

  function handleToggle() {
    if (lpEnabled) {
      setLpEnabled(false);
      localStorage.setItem("yp_lp_enabled", "false");
    } else {
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
    .filter(p => typeFilter === "All" || PROTOCOL_TYPE[p.protocolId] === typeFilter)
    .sort((a, b) => b.apyBps - a.apyBps);

  // Only real routable protocols are eligible for ROUTING HERE / 20% HERE —
  // riskScore alone isn't a safe proxy (Drift is riskScore 1 but not routable).
  const routableSorted = sorted.filter(p => ROUTABLE_PROTOCOL_IDS.has(p.protocolId));

  useEffect(() => {
    if (!autoActive || routableSorted.length === 0) return;
    const id = setInterval(() => setActiveIdx(i => (i + 1) % routableSorted.length), 3500);
    return () => clearInterval(id);
  }, [autoActive, routableSorted.length]);

  const activeNode = routableSorted[activeIdx % Math.max(routableSorted.length, 1)];

  return (
    <>
      {showModal && <ILRiskModal onAccept={acceptLpRisk} onDecline={declineLpRisk} />}

      <div style={{ maxWidth: 860, margin: "0 auto", padding: "48px 24px 80px", position: "relative" }}>
        <div className="aurora-bg" />

        <div style={{ marginBottom: 48, position: "relative", zIndex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-low)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10, fontFamily: "var(--font-mono)" }}>
            Live data
          </div>
          <h1 style={{ fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 700, letterSpacing: "-0.015em", marginBottom: 4, color: "var(--text-hi)" }}>
            Protocol rates.
          </h1>
          <h1 style={{ fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 700, letterSpacing: "-0.015em", color: "var(--signal)", marginBottom: 20 }}>
            Updated every 15 minutes.
          </h1>
          <p style={{ color: "var(--text-mid)", fontSize: 14, lineHeight: 1.7, maxWidth: 520 }}>
            YieldPilot monitors these protocols continuously. 80% of vault assets route to the top rate,
            20% stays in the runner-up. Rates update every 15 minutes; display refreshes every 60 seconds.
          </p>
        </div>

        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 1, background: "var(--line)", borderRadius: 10, overflow: "hidden",
          marginBottom: 40, border: "1px solid var(--line)", position: "relative", zIndex: 1,
        }}>
          {[
            { label: "Primary allocation", value: "80%" },
            { label: "Runner-up allocation", value: "20%" },
            { label: "Rebalance threshold", value: "0.5%" },
            { label: "Rebalance cycle", value: "15 min" },
          ].map(({ label, value }) => (
            <div key={label} style={{ background: "var(--ink-800)", padding: "20px 24px" }}>
              <div className="mono-num" style={{ fontSize: 22, fontWeight: 500, color: "var(--text-hi)", marginBottom: 4 }}>
                {value}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-mid)" }}>{label}</div>
            </div>
          ))}
        </div>

        {/* Live routing — clickable protocol nodes + auto-cycling detail panel */}
        {routableSorted.length > 0 && (
          <div style={{ background: "var(--ink-800)", border: "1px solid var(--line)", borderRadius: 12, padding: "20px 24px", marginBottom: 24, position: "relative", zIndex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-low)", textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: "var(--font-mono)" }}>
                Live routing
              </div>
              {autoActive && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--signal)", fontFamily: "var(--font-mono)" }}>
                  <span className="live-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--signal)" }} />
                  AUTO
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
              {routableSorted.map((p, i) => (
                <button
                  key={p.protocolId}
                  onClick={() => { setActiveIdx(i); setAutoActive(false); }}
                  style={{
                    padding: "8px 14px", borderRadius: 8, cursor: "pointer",
                    border: i === activeIdx ? "1px solid rgba(63,224,160,0.4)" : "1px solid var(--line)",
                    background: i === activeIdx ? "rgba(63,224,160,0.08)" : "var(--ink-700)",
                    color: i === activeIdx ? "var(--signal)" : "var(--text-mid)",
                    fontSize: 12, fontWeight: 600, fontFamily: "var(--font-body)",
                  }}
                >
                  {p.name} <span className="mono-num" style={{ marginLeft: 6 }}>{fmt(p.apyPercent)}%</span>
                </button>
              ))}
            </div>
            {activeNode && (
              <div style={{ borderTop: "1px solid var(--line)", paddingTop: 14, fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}>
                {activeIdx === 0
                  ? <>Highest live rate right now — receives <span className="mono-num" style={{ color: "var(--signal)" }}>80%</span> of the vault on the next rebalance.</>
                  : activeIdx === 1
                  ? <>Runner-up rate — holds <span className="mono-num" style={{ color: "var(--signal-dim)" }}>20%</span> of the vault for diversification.</>
                  : <>Monitored continuously; routes here only if it overtakes the current leader by more than the 0.5% threshold.</>}
                {" "}TVL <span className="mono-num">{fmtTvl(activeNode.tvlUsd)}</span>.
              </div>
            )}
          </div>
        )}

        {/* Type filter tabs */}
        <div style={{ display: "flex", gap: 4, marginBottom: 16, background: "var(--ink-800)", padding: 4, borderRadius: 10, border: "1px solid var(--line)", width: "fit-content", position: "relative", zIndex: 1 }}>
          {(["All", "Lending", "Liquid stake"] as TypeFilter[]).map((t) => (
            <button key={t} onClick={() => setTypeFilter(t)} style={{
              padding: "7px 14px", borderRadius: 7, border: "none", cursor: "pointer",
              background: typeFilter === t ? "var(--signal)" : "transparent",
              color: typeFilter === t ? "var(--ink-900)" : "var(--text-mid)",
              fontWeight: 600, fontSize: 12, fontFamily: "var(--font-body)",
            }}>{t}</button>
          ))}
        </div>

        <div style={{ position: "relative", zIndex: 1 }}>
        <Card>
          <CardHeader
            title="All Protocols"
            right={
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 12, color: "var(--text-mid)", fontWeight: 500 }}>LP pools</span>
                  <button
                    onClick={handleToggle}
                    aria-label="Toggle LP pools"
                    style={{
                      position: "relative", width: 40, height: 22, borderRadius: 11,
                      border: lpEnabled ? "1px solid rgba(255,107,107,0.5)" : "1px solid var(--line)",
                      background: lpEnabled ? "rgba(255,107,107,0.15)" : "var(--ink-900)",
                      cursor: "pointer", flexShrink: 0, transition: "all 0.2s",
                    }}
                  >
                    <span style={{
                      position: "absolute", top: 3, left: lpEnabled ? 20 : 3,
                      width: 14, height: 14, borderRadius: "50%",
                      background: lpEnabled ? "var(--loss)" : "var(--text-low)",
                      transition: "left 0.2s",
                    }} />
                  </button>
                  {lpEnabled && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, color: "var(--loss)",
                      background: "rgba(255,107,107,0.1)", border: "1px solid rgba(255,107,107,0.25)",
                      borderRadius: 4, padding: "2px 6px", letterSpacing: "0.06em", fontFamily: "var(--font-mono)",
                    }}>IL RISK</span>
                  )}
                </div>
                <span style={{ color: "var(--text-mid)", fontSize: 12, fontFamily: "var(--font-mono)" }}>
                  {loading ? "Refreshing…" : "Auto-refreshes every 60s"}
                </span>
              </div>
            }
          />

          <div style={{
            display: "grid", gridTemplateColumns: "1fr 80px 100px 80px 80px",
            padding: "8px 20px", borderBottom: "1px solid var(--line)",
            color: "var(--text-low)", fontSize: 11, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: "var(--font-mono)",
          }}>
            <span>Protocol</span>
            <span style={{ textAlign: "right" }}>Asset</span>
            <span style={{ textAlign: "right" }}>APY</span>
            <span style={{ textAlign: "right" }}>TVL</span>
            <span style={{ textAlign: "right" }}>Risk</span>
          </div>

          {sorted.map((p, i) => {
            const risk = RISK_LABEL[p.riskScore] || { label: "—", color: "var(--text-mid)" };
            const isLP = LP_PROTOCOL_IDS.has(p.protocolId);
            const isRoutable = ROUTABLE_PROTOCOL_IDS.has(p.protocolId);
            const routableRank = routableSorted.findIndex(s => s.protocolId === p.protocolId);
            return (
              <div key={p.protocolId} style={{
                display: "grid", gridTemplateColumns: "1fr 80px 100px 80px 80px",
                padding: "14px 20px", borderTop: i === 0 ? "none" : "1px solid var(--line)",
                alignItems: "center",
                background: routableRank === 0 ? "rgba(63,224,160,0.04)" : isLP ? "rgba(255,107,107,0.03)" : "var(--ink-800)",
                opacity: isLP ? 0.85 : 1,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <div style={{
                    width: 7, height: 7, borderRadius: "50%",
                    background: isLP ? "var(--loss)" : (p.color || "var(--signal)"), flexShrink: 0,
                  }} />
                  <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text-hi)" }}>{p.name}</span>
                  {routableRank === 0 && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "2px 7px",
                      borderRadius: 4, background: "rgba(63,224,160,0.12)",
                      color: "var(--signal)", border: "1px solid rgba(63,224,160,0.25)",
                      letterSpacing: "0.04em", fontFamily: "var(--font-mono)",
                    }}>ROUTING HERE</span>
                  )}
                  {routableRank === 1 && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "2px 7px",
                      borderRadius: 4, background: "rgba(34,179,126,0.1)",
                      color: "var(--signal-dim)", border: "1px solid rgba(34,179,126,0.2)",
                      letterSpacing: "0.04em", fontFamily: "var(--font-mono)",
                    }}>20% HERE</span>
                  )}
                  {isLP && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "2px 7px",
                      borderRadius: 4, background: "rgba(255,107,107,0.1)",
                      color: "var(--loss)", border: "1px solid rgba(255,107,107,0.2)",
                      letterSpacing: "0.04em", fontFamily: "var(--font-mono)",
                    }}>LP · IL RISK</span>
                  )}
                  {!isLP && !isRoutable && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "2px 7px",
                      borderRadius: 4, background: "rgba(154,168,184,0.08)",
                      color: "var(--text-mid)", border: "1px solid var(--line)",
                      letterSpacing: "0.04em", fontFamily: "var(--font-mono)",
                    }}>REFERENCE ONLY</span>
                  )}
                </div>
                <span className="mono-num" style={{ textAlign: "right", color: "var(--text-mid)", fontSize: 12 }}>
                  {p.asset}
                </span>
                <span className="mono-num" style={{
                  textAlign: "right", fontWeight: 500, fontSize: 15,
                  color: isLP ? "var(--loss)" : (routableRank === 0 ? "var(--signal)" : "var(--text-hi)"),
                }}>
                  {fmt(p.apyPercent)}%
                </span>
                <span className="mono-num" style={{ textAlign: "right", color: "var(--text-mid)", fontSize: 12 }}>
                  {fmtTvl(p.tvlUsd)}
                </span>
                <span style={{ textAlign: "right", fontSize: 12, fontWeight: 600, color: risk.color }}>
                  {risk.label}
                </span>
              </div>
            );
          })}
        </Card>
        </div>

        {lpEnabled && (
          <div style={{
            marginTop: 16, padding: "14px 18px", borderRadius: 10,
            background: "rgba(255,107,107,0.06)", border: "1px solid rgba(255,107,107,0.2)",
            fontSize: 13, color: "var(--loss)", lineHeight: 1.6, position: "relative", zIndex: 1,
          }}>
            <strong>LP pools are shown for reference.</strong> Raydium and Orca carry impermanent loss risk —
            your principal is not protected from price-driven losses. YieldPilot has no on-chain path to route
            your deposited funds there.
          </div>
        )}

        <p style={{ marginTop: 20, color: "var(--text-low)", fontSize: 11, lineHeight: 1.65, position: "relative", zIndex: 1 }}>
          APYs are estimates based on recent protocol data and may change. Past performance does not
          guarantee future returns. LP pool APYs displayed when enabled are gross of impermanent loss.
          Always do your own research before depositing.
        </p>
      </div>
    </>
  );
}
