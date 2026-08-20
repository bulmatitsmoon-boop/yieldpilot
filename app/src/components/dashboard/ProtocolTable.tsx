"use client";
import { useState, useEffect } from "react";
import { Pill, fmtTvl, fmt } from "@/components/ui";
import type { ProtocolApy } from "@/hooks/useApys";

const RISK_LABEL = ["", "Low", "Medium", "High"];
const LP_IDS = new Set(["raydium-usdc-sol", "orca-sol-usdc"]);

interface Props {
  apys: ProtocolApy[];
  loading: boolean;
}

function ILModal({ onAccept, onDecline }: { onAccept: () => void; onDecline: () => void }) {
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
          borderRadius: 16, maxWidth: 520, width: "100%", padding: "32px",
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
          borderRadius: 10, padding: "18px 20px", marginBottom: 16,
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>What is impermanent loss?</div>
          <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.7, margin: 0 }}>
            LP pools hold two assets (e.g. USDC + SOL) in a fixed ratio. If SOL's price moves
            significantly up or down while your funds are in the pool, you end up with <em>less value</em> than
            if you had simply held the assets. This loss can <strong>exceed the trading fees earned</strong>,
            meaning you lose principal — not just yield.
          </p>
        </div>

        <div style={{
          background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.15)",
          borderRadius: 10, padding: "18px 20px", marginBottom: 24,
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Why this is toggled off by default</div>
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
          <button onClick={onDecline} style={{
            flex: 1, padding: "12px 0", borderRadius: 8,
            border: "1px solid var(--border)", background: "transparent",
            color: "var(--text-muted)", fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}>Cancel</button>
          <button onClick={onAccept} style={{
            flex: 1, padding: "12px 0", borderRadius: 8,
            border: "1px solid rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.1)",
            color: "var(--red)", fontSize: 13, fontWeight: 700, cursor: "pointer",
          }}>I understand — enable LP pools</button>
        </div>
      </div>
    </div>
  );
}

export function ProtocolTable({ apys, loading }: Props) {
  const [lpEnabled, setLpEnabled] = useState(false);
  const [showModal, setShowModal] = useState(false);

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

  function acceptRisk() {
    setShowModal(false);
    setLpEnabled(true);
    localStorage.setItem("yp_lp_enabled", "true");
  }

  const sorted = [...apys]
    .filter(p => lpEnabled || !LP_IDS.has(p.protocolId))
    .sort((a, b) => b.apyBps - a.apyBps);

  const safeProtocols = sorted.filter(p => !LP_IDS.has(p.protocolId));
  const best = safeProtocols[0];

  return (
    <>
      {showModal && <ILModal onAccept={acceptRisk} onDecline={() => setShowModal(false)} />}

      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>Live Protocol Rates</span>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            {/* LP toggle */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
              {loading ? "Refreshing..." : "Updates every 60s"}
            </span>
          </div>
        </div>

        <div className="table-scroll">
          <div style={{ display: "grid", gridTemplateColumns: "10px 1fr 90px 80px 100px 70px", gap: "0 16px", padding: "8px 20px", color: "var(--text-dim)", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", minWidth: 480 }}>
            <div /><div>Protocol</div><div>Type</div><div>APY</div><div>TVL</div><div>Risk</div>
          </div>

          {sorted.map((p) => {
            const isLP = LP_IDS.has(p.protocolId);
            const isBest = p.protocolId === best?.protocolId;
            return (
              <div
                key={p.protocolId}
                style={{
                  display: "grid",
                  gridTemplateColumns: "10px 1fr 90px 80px 100px 70px",
                  gap: "0 16px",
                  padding: "14px 20px",
                  background: isBest ? "rgba(124,58,237,0.06)" : isLP ? "rgba(239,68,68,0.03)" : "transparent",
                  borderTop: "1px solid var(--border)",
                  alignItems: "center",
                  minWidth: 480,
                  opacity: isLP ? 0.85 : 1,
                }}
              >
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: isLP ? "var(--red)" : p.color }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    {p.name}
                    {isBest && <span style={{ fontSize: 10, color: "var(--purple-light)", fontWeight: 700 }}>▲ BEST</span>}
                    {isLP && (
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: "1px 5px", borderRadius: 3,
                        background: "rgba(239,68,68,0.1)", color: "var(--red)",
                        border: "1px solid rgba(239,68,68,0.2)",
                      }}>IL RISK</span>
                    )}
                  </div>
                  <div style={{ color: "var(--text-muted)", fontSize: 11 }}>{p.asset}</div>
                </div>
                <div><Pill label={isLP ? "LP" : p.name === "Marinade" || p.name === "Jito" || p.name === "PSOL" ? "Liquid Stake" : "Lending"} /></div>
                <div style={{ color: isLP ? "var(--red)" : isBest ? "var(--purple-light)" : "var(--green)", fontWeight: 700, fontFamily: "var(--mono)", fontSize: 14 }}>
                  {p.stale ? "—" : `${fmt(p.apyPercent)}%`}
                </div>
                <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 13 }}>{fmtTvl(p.tvlUsd)}</div>
                <div><Pill label={RISK_LABEL[p.riskScore] || "Low"} /></div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
