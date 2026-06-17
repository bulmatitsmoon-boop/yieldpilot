"use client";
import { Pill, fmtTvl, fmt } from "@/components/ui";
import type { ProtocolApy } from "@/hooks/useApys";

const RISK_LABEL = ["", "Low", "Medium", "High"];

interface Props {
  apys: ProtocolApy[];
  loading: boolean;
}

export function ProtocolTable({ apys, loading }: Props) {
  const sorted = [...apys].sort((a, b) => b.apyBps - a.apyBps);
  const best = sorted[0];

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>Live Protocol Rates</span>
        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
          {loading ? "Refreshing..." : "Updates every 60s"}
        </span>
      </div>

      {/* Scrollable on mobile */}
      <div className="table-scroll">
        {/* Column headers */}
        <div style={{ display: "grid", gridTemplateColumns: "10px 1fr 90px 80px 100px 70px", gap: "0 16px", padding: "8px 20px", color: "var(--text-dim)", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", minWidth: 480 }}>
          <div />
          <div>Protocol</div>
          <div>Type</div>
          <div>APY</div>
          <div>TVL</div>
          <div>Risk</div>
        </div>

        {sorted.map((p) => {
          const isBest = p.protocolId === best?.protocolId;
          return (
            <div
              key={p.protocolId}
              style={{
                display: "grid",
                gridTemplateColumns: "10px 1fr 90px 80px 100px 70px",
                gap: "0 16px",
                padding: "14px 20px",
                background: isBest ? "rgba(124,58,237,0.06)" : "transparent",
                borderTop: "1px solid var(--border)",
                alignItems: "center",
                minWidth: 480,
              }}
            >
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: p.color }} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  {p.name}
                  {isBest && (
                    <span style={{ marginLeft: 6, fontSize: 10, color: "var(--purple-light)", fontWeight: 700 }}>▲ BEST</span>
                  )}
                </div>
                <div style={{ color: "var(--text-muted)", fontSize: 11 }}>{p.asset}</div>
              </div>
              <div><Pill label={p.asset.includes("-") ? "LP" : p.name === "Marinade" ? "Liquid Stake" : "Lending"} /></div>
              <div style={{ color: isBest ? "var(--purple-light)" : "var(--green)", fontWeight: 700, fontFamily: "var(--mono)", fontSize: 14 }}>
                {fmt(p.apyPercent)}%
              </div>
              <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 13 }}>{fmtTvl(p.tvlUsd)}</div>
              <div><Pill label={RISK_LABEL[p.riskScore] || "Low"} /></div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
