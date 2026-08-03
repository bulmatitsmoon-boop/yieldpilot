"use client";

import { useFleetStats } from "@/hooks/useFleetStats";
import { fmtTvl } from "@/components/ui";

interface Props {
  totalDeposited: number; // real, in USD-equivalent
  blendedApy: number | null; // real; null => no live rate available, render "—"
}

// Deterministic pseudo-random placement so dots don't jump around on re-render,
// but are still spread out rather than stacked. Purely visual — count is real.
function dotPosition(i: number, radius: number) {
  const angle = (i * 137.5) % 360; // golden-angle spread
  const r = radius * (0.35 + 0.55 * ((i * 0.618) % 1));
  const rad = (angle * Math.PI) / 180;
  return { x: 140 + r * Math.cos(rad), y: 140 + r * Math.sin(rad) };
}

export function FleetRadar({ totalDeposited, blendedApy }: Props) {
  const { activePositions, recentActivity, totalGainedUsd, lifetimeGainedUsd, loading } = useFleetStats();

  return (
    <div style={{ marginBottom: 96, position: "relative", zIndex: 1 }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, fontWeight: 600, color: "var(--text-low)", letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: "var(--font-mono)" }}>
          <span>Total value across all vaults</span>
          <span className="live-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--signal)" }} />
          <span style={{ color: "var(--signal)" }}>LIVE</span>
        </div>
      </div>

      <div style={{ textAlign: "center", marginBottom: 40 }}>
        <div className="mono-num" style={{ fontSize: "clamp(32px, 6vw, 56px)", fontWeight: 500, color: "var(--text-hi)", textShadow: "0 0 30px rgba(63,224,160,0.25)" }}>
          {fmtTvl(totalDeposited)}
        </div>
        <div style={{ color: "var(--text-mid)", fontSize: 14, marginTop: 8 }}>
          Deposited across every YieldPilot vault. Grows as real users join.
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 16 }}>
        {/* Fleet radar */}
        <div style={{ background: "var(--ink-800)", border: "1px solid var(--line)", borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-low)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12, fontFamily: "var(--font-mono)" }}>
            Fleet Radar
          </div>
          <svg viewBox="0 0 280 280" width="100%" height="220">
            {[110, 75, 40].map((r) => (
              <circle key={r} cx="140" cy="140" r={r} fill="none" stroke="var(--line)" strokeWidth="1" />
            ))}
            <line x1="140" y1="30" x2="140" y2="250" stroke="var(--line)" strokeWidth="1" />
            <line x1="30" y1="140" x2="250" y2="140" stroke="var(--line)" strokeWidth="1" />

            {/* Sweep */}
            <g style={{ transformOrigin: "140px 140px", animation: "radar-sweep 4s linear infinite" }}>
              <path d="M 140 140 L 140 30 A 110 110 0 0 1 195 55 Z" fill="var(--signal)" opacity="0.12" />
            </g>

            <circle cx="140" cy="140" r="4" fill="var(--signal)" className="live-dot" />

            {Array.from({ length: Math.min(activePositions, 40) }).map((_, i) => {
              const { x, y } = dotPosition(i, 100);
              return <circle key={i} cx={x} cy={y} r="3" fill="var(--signal)" opacity="0.8" />;
            })}
          </svg>
          <div style={{ textAlign: "center", fontSize: 12, color: "var(--text-mid)", marginTop: 8 }}>
            {loading ? "Scanning…" : activePositions === 0
              ? "No active positions yet — be the first"
              : `${activePositions} active position${activePositions === 1 ? "" : "s"}`}
          </div>
        </div>

        {/* Stat grid + real activity feed */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
            {[
              { value: fmtTvl(totalDeposited), label: "Total deposited" },
              { value: String(activePositions), label: "Active positions" },
              { value: blendedApy === null ? "—" : `${blendedApy.toFixed(1)}%`, label: "Blended net APY" },
              // Real, on-chain realized gain currently sitting in the vaults —
              // total_deposits minus every position's own cost basis, summed across
              // every vault. A LIVE snapshot: goes toward $0 whenever everyone withdraws,
              // since there's nothing left "currently gaining" at that point. Not a
              // projection — settle_recall and reconcile() keep total_deposits accurate.
              { value: totalGainedUsd === null ? "—" : fmtTvl(totalGainedUsd), label: "Currently gaining" },
              // Cumulative, ALL-TIME realized gain — reads the on-chain lifetime_gains
              // counter directly (added 2026-08-03). Unlike the stat above, this only
              // ever goes up and survives full withdrawals — it answers "how much has
              // this ever earned", not "how much is earning right now".
              { value: lifetimeGainedUsd === null ? "—" : fmtTvl(lifetimeGainedUsd), label: "All-time gained" },
            ].map(({ value, label }) => (
              <div key={label} style={{ background: "var(--ink-800)", border: "1px solid var(--line)", borderRadius: 10, padding: "16px 18px" }}>
                <div className="mono-num" style={{ fontSize: 22, fontWeight: 500, color: "var(--text-hi)" }}>{value}</div>
                <div style={{ fontSize: 11, color: "var(--text-low)", marginTop: 4 }}>{label}</div>
              </div>
            ))}
          </div>

          <div style={{ background: "var(--ink-800)", border: "1px solid var(--line)", borderRadius: 10, padding: "14px 18px", flex: 1 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-low)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10, fontFamily: "var(--font-mono)" }}>
              Recent on-chain activity
            </div>
            {recentActivity.length === 0 ? (
              <div style={{ color: "var(--text-low)", fontSize: 13 }}>No activity yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {recentActivity.slice(0, 4).map((a) => (
                  <a
                    key={a.signature}
                    href={`https://solscan.io/tx/${a.signature}?cluster=${process.env.NEXT_PUBLIC_SOLANA_NETWORK === "mainnet-beta" ? "mainnet-beta" : "devnet"}`}
                    target="_blank" rel="noopener noreferrer"
                    style={{ display: "flex", justifyContent: "space-between", fontSize: 12, textDecoration: "none", color: "var(--text-mid)" }}
                  >
                    <span className="mono-num">{a.signature.slice(0, 12)}…</span>
                    <span>{a.blockTime ? new Date(a.blockTime * 1000).toLocaleTimeString() : "pending"}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes radar-sweep {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

