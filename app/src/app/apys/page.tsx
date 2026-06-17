"use client";

import { useApys } from "@/hooks/useApys";
import { Card, CardHeader, fmt } from "@/components/ui";

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

export default function ApysPage() {
  const { apys, loading } = useApys();
  const sorted = [...apys].sort((a, b) => b.apyBps - a.apyBps);

  return (
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
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {loading ? "Refreshing..." : "Auto-refreshes every 60s"}
            </span>
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
          return (
            <div key={p.protocolId} style={{
              display: "grid", gridTemplateColumns: "1fr 80px 100px 80px 80px",
              padding: "14px 20px", borderTop: i === 0 ? "none" : "1px solid var(--border)",
              alignItems: "center",
              background: i === 0 ? "rgba(124,58,237,0.04)" : "var(--surface)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{
                  width: 7, height: 7, borderRadius: "50%",
                  background: p.color || "var(--purple)", flexShrink: 0,
                }} />
                <span style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</span>
                {i === 0 && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: "2px 7px",
                    borderRadius: 4, background: "rgba(52,211,153,0.12)",
                    color: "var(--green)", border: "1px solid rgba(52,211,153,0.2)",
                    letterSpacing: "0.04em",
                  }}>ROUTING HERE</span>
                )}
                {i === 1 && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: "2px 7px",
                    borderRadius: 4, background: "rgba(124,58,237,0.1)",
                    color: "var(--purple-light)", border: "1px solid rgba(124,58,237,0.2)",
                    letterSpacing: "0.04em",
                  }}>20% HERE</span>
                )}
              </div>
              <span style={{ textAlign: "right", color: "var(--text-muted)", fontSize: 12, fontFamily: "var(--mono)" }}>
                {p.asset}
              </span>
              <span style={{
                textAlign: "right", fontFamily: "var(--mono)", fontWeight: 700, fontSize: 15,
                color: i === 0 ? "var(--green)" : "var(--text)",
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

      <p style={{ marginTop: 20, color: "var(--text-dim)", fontSize: 11, lineHeight: 1.65 }}>
        APYs are estimates based on recent protocol data and may change. Past performance does not
        guarantee future returns. YieldPilot charges a 5% performance fee on profits only.
        Always do your own research before depositing.
      </p>
    </div>
  );
}
