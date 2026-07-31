"use client";

import { useEpochs } from "@/hooks/useEpochs";
import { Card, CardHeader, fmt } from "@/components/ui";

function fmtDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "—";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.round((totalSeconds % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const remH = h % 24;
    return `${d}d ${remH}h`;
  }
  return `${h}h ${m}m`;
}

export default function EpochsPage() {
  const { network, protocols, loading } = useEpochs();

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "48px 24px 80px", position: "relative" }}>
      <div className="aurora-bg" />

      <div style={{ marginBottom: 48, position: "relative", zIndex: 1 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-low)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10, fontFamily: "var(--font-mono)" }}>
          Live data
        </div>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 700, letterSpacing: "-0.015em", marginBottom: 4, color: "var(--text-hi)" }}>
          Epoch status.
        </h1>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 700, letterSpacing: "-0.015em", color: "var(--signal)", marginBottom: 20 }}>
          Why LST rates only move once per epoch.
        </h1>
        <p style={{ color: "var(--text-mid)", fontSize: 14, lineHeight: 1.7, maxWidth: 560 }}>
          Jito, PSOL, and Marinade are liquid-staking protocols: their exchange rate only
          updates once per Solana epoch, because the underlying staking rewards themselves
          land once per epoch. Kamino and Solend are lending markets — they accrue interest
          every slot and have no epoch dependency at all, so they aren&apos;t shown here.
        </p>
      </div>

      {/* Network epoch status */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: 1, background: "var(--line)", borderRadius: 10, overflow: "hidden",
        marginBottom: 24, border: "1px solid var(--line)", position: "relative", zIndex: 1,
      }}>
        {[
          { label: "Current epoch", value: network ? String(network.epoch) : "—" },
          { label: "Epoch length", value: network ? `~${fmt(network.epochLengthDays, 2)}d` : "—" },
          { label: "Time to next epoch", value: network ? fmtDuration(network.estSecondsToNextEpoch) : "—" },
        ].map(({ label, value }) => (
          <div key={label} style={{ background: "var(--ink-800)", padding: "20px 24px" }}>
            <div className="mono-num" style={{ fontSize: 22, fontWeight: 500, color: "var(--text-hi)", marginBottom: 4 }}>
              {value}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-mid)" }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Epoch progress bar */}
      {network && (
        <div style={{
          background: "var(--ink-800)", border: "1px solid var(--line)", borderRadius: 12,
          padding: "18px 24px", marginBottom: 32, position: "relative", zIndex: 1,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: "var(--text-mid)" }}>Epoch {network.epoch} progress</span>
            <span className="mono-num" style={{ fontSize: 12, color: "var(--signal)" }}>
              {fmt(network.progressPct, 1)}%
            </span>
          </div>
          <div style={{ height: 8, borderRadius: 4, background: "var(--ink-900)", overflow: "hidden" }}>
            <div style={{
              height: "100%", width: `${Math.min(network.progressPct, 100)}%`,
              background: "var(--signal)", borderRadius: 4, transition: "width 0.3s",
            }} />
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-low)" }}>
            Slot {network.slotIndex.toLocaleString()} of {network.slotsInEpoch.toLocaleString()}
          </div>
        </div>
      )}

      <div style={{ position: "relative", zIndex: 1 }}>
        <Card>
          <CardHeader
            title="Epoch-gated protocols"
            right={
              <span style={{ color: "var(--text-mid)", fontSize: 12, fontFamily: "var(--font-mono)" }}>
                {loading ? "Refreshing…" : "Auto-refreshes every 60s"}
              </span>
            }
          />

          <div style={{
            display: "grid", gridTemplateColumns: "1fr 100px 110px 130px",
            padding: "8px 20px", borderBottom: "1px solid var(--line)",
            color: "var(--text-low)", fontSize: 11, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: "var(--font-mono)",
          }}>
            <span>Protocol</span>
            <span style={{ textAlign: "right" }}>Rate APY</span>
            <span style={{ textAlign: "right" }}>Last updated</span>
            <span style={{ textAlign: "right" }}>Status</span>
          </div>

          {protocols.map((p, i) => (
            <div key={p.protocolId} style={{
              display: "grid", gridTemplateColumns: "1fr 100px 110px 130px",
              padding: "14px 20px", borderTop: i === 0 ? "none" : "1px solid var(--line)",
              alignItems: "center", background: "var(--ink-800)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: p.color, flexShrink: 0 }} />
                <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text-hi)" }}>{p.name}</span>
                <span style={{ fontSize: 11, color: "var(--text-low)" }}>{p.asset}</span>
              </div>
              <span className="mono-num" style={{ textAlign: "right", fontSize: 14, color: "var(--text-hi)" }}>
                {p.apyPercent != null ? `${fmt(p.apyPercent)}%` : "—"}
              </span>
              <span className="mono-num" style={{ textAlign: "right", fontSize: 13, color: "var(--text-mid)" }}>
                {p.lastUpdateEpoch != null ? (
                  <span title={p.epochFieldLabel ? `(${p.epochFieldLabel})` : undefined}>
                    Epoch {p.lastUpdateEpoch}
                  </span>
                ) : "—"}
              </span>
              <span style={{ textAlign: "right" }}>
                {!p.epochVerified ? (
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 4,
                    background: "rgba(154,168,184,0.08)", color: "var(--text-mid)",
                    border: "1px solid var(--line)", letterSpacing: "0.04em", fontFamily: "var(--font-mono)",
                  }}>NOT VERIFIED</span>
                ) : p.isStale ? (
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 4,
                    background: "rgba(255,199,89,0.1)", color: "var(--warn)",
                    border: "1px solid rgba(255,199,89,0.25)", letterSpacing: "0.04em", fontFamily: "var(--font-mono)",
                  }}>{p.epochsBehind}{p.epochsBehind === 1 ? " EPOCH" : " EPOCHS"} BEHIND</span>
                ) : (
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 4,
                    background: "rgba(63,224,160,0.12)", color: "var(--signal)",
                    border: "1px solid rgba(63,224,160,0.25)", letterSpacing: "0.04em", fontFamily: "var(--font-mono)",
                  }}>UP TO DATE</span>
                )}
              </span>
            </div>
          ))}
        </Card>
      </div>

      <p style={{ marginTop: 20, color: "var(--text-low)", fontSize: 11, lineHeight: 1.65, position: "relative", zIndex: 1 }}>
        &quot;Last updated&quot; for Jito and PSOL is read directly from each protocol&apos;s own
        on-chain stake pool account (its whole-pool balance refresh) — not an estimate. Marinade
        has no equivalent single field for that, but its account does store the epoch its crank
        last ran a stake-delta rebalance, which is shown instead (hover the epoch number for the
        exact label) — a real on-chain signal, though measuring a slightly different thing than
        Jito/PSOL&apos;s field. Epoch length and time-to-next-epoch are derived from live network
        slot timing and will vary slightly as validators speed up or slow down.
      </p>
    </div>
  );
}
