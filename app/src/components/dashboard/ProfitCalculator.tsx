"use client";

import { useState } from "react";
import { Card, CardHeader, fmt } from "@/components/ui";

interface Props {
  liveApy: number | null; // real current best-available APY; null => no live rate yet
}

const TIMEFRAMES = [
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
];

export function ProfitCalculator({ liveApy }: Props) {
  const [amount, setAmount] = useState("10000");
  const [apy, setApy] = useState(liveApy !== null ? liveApy.toFixed(2) : "");
  const [days, setDays] = useState(365);

  const amountNum = parseFloat(amount) || 0;
  const apyNum = parseFloat(apy) || 0;

  // Daily compounding, matching how the vaults actually accrue (receipt tokens like
  // kUSDC/pSOL appreciate continuously, not in discrete claim events) -- not simple
  // interest, which would understate the real projection.
  const dailyRate = apyNum / 100 / 365;
  const finalValue = amountNum * Math.pow(1 + dailyRate, days);
  const profit = finalValue - amountNum;

  const inputStyle: React.CSSProperties = {
    width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
    borderRadius: 8, padding: "10px 12px", color: "var(--text)",
    fontSize: 15, fontFamily: "var(--mono)", outline: "none", boxSizing: "border-box",
  };
  const labelStyle: React.CSSProperties = {
    display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 6,
  };

  return (
    <Card>
      <CardHeader title="Profit Calculator" />
      <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 160px" }}>
            <label style={labelStyle}>Deposit amount ($)</label>
            <input
              type="number" min="0" value={amount}
              onChange={(e) => setAmount(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div style={{ flex: "1 1 120px" }}>
            <label style={labelStyle}>APY (%)</label>
            <input
              type="number" min="0" step="0.01" value={apy}
              onChange={(e) => setApy(e.target.value)}
              placeholder={liveApy !== null ? liveApy.toFixed(2) : "—"}
              style={inputStyle}
            />
            {liveApy !== null && (
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                Live best-available rate: {liveApy.toFixed(2)}%
              </div>
            )}
          </div>
        </div>

        <div>
          <label style={labelStyle}>Time frame</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            {TIMEFRAMES.map((t) => (
              <button
                key={t.days}
                onClick={() => setDays(t.days)}
                style={{
                  padding: "6px 14px", borderRadius: 7, border: "1px solid var(--border)",
                  background: days === t.days ? "var(--signal)" : "var(--bg)",
                  color: days === t.days ? "var(--ink-900)" : "var(--text-mid)",
                  fontWeight: 600, fontSize: 12.5, cursor: "pointer", fontFamily: "var(--font-body)",
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <input
            type="number" min="1" value={days}
            onChange={(e) => setDays(Math.max(1, parseInt(e.target.value) || 1))}
            style={{ ...inputStyle, maxWidth: 140 }}
          />
          <span style={{ fontSize: 12, color: "var(--text-dim)", marginLeft: 8 }}>days (custom)</span>
        </div>

        <div style={{ background: "var(--bg)", borderRadius: 10, padding: "16px 18px", display: "flex", gap: 24, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Est. profit</div>
            <div className="mono-num" style={{ fontSize: 24, fontWeight: 700, color: "var(--signal)" }}>
              +${fmt(profit, 2)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Final value</div>
            <div className="mono-num" style={{ fontSize: 24, fontWeight: 700, color: "var(--text-hi)" }}>
              ${fmt(finalValue, 2)}
            </div>
          </div>
        </div>

        <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.5 }}>
          Rough estimate only — assumes the entered APY holds constant and compounds daily, and doesn't account for performance fees (9% standard, lower with $YPILOT) or rate changes over time. Real returns depend on live protocol rates, which move.
        </div>
      </div>
    </Card>
  );
}
