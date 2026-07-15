import { ImageResponse } from "next/og";

export const runtime = "edge";

export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#080b12",
          fontFamily: "sans-serif",
          position: "relative",
        }}
      >
        {/* Background gradient blobs */}
        <div style={{
          position: "absolute", top: -100, left: -100,
          width: 500, height: 500, borderRadius: "50%",
          background: "radial-gradient(circle, rgba(63,224,160,0.15) 0%, transparent 70%)",
          display: "flex",
        }} />
        <div style={{
          position: "absolute", bottom: -100, right: -100,
          width: 400, height: 400, borderRadius: "50%",
          background: "radial-gradient(circle, rgba(6,182,212,0.12) 0%, transparent 70%)",
          display: "flex",
        }} />

        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 32 }}>
          <div style={{
            width: 64, height: 64, borderRadius: 16,
            background: "#18202B",
            border: "1px solid #26313F",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <svg width="32" height="32" viewBox="0 0 14 14" fill="none">
              <path d="M7 1L12 4V10L7 13L2 10V4L7 1Z" stroke="#3FE0A0" strokeWidth="1.5" strokeLinejoin="round"/>
              <circle cx="7" cy="7" r="2" fill="#3FE0A0"/>
            </svg>
          </div>
          <span style={{ fontSize: 52, fontWeight: 900, color: "#e2e8f0", letterSpacing: "-2px" }}>
            YieldPilot
          </span>
        </div>

        {/* Tagline */}
        <div style={{
          fontSize: 28, color: "#6b7280", textAlign: "center",
          maxWidth: 700, lineHeight: 1.4, marginBottom: 48,
          display: "flex",
        }}>
          Earn the best yield on Solana, automatically.
        </div>

        {/* Stats row */}
        <div style={{ display: "flex", gap: 24 }}>
          {[
            { label: "Auto-Rebalance", value: "Every 45 min" },
            { label: "Performance Fee", value: "0-9% of profit" },
            { label: "Protocols", value: "Kamino · Marinade · Jito · Solend" },
          ].map(({ label, value }) => (
            <div key={label} style={{
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 12, padding: "14px 24px",
              display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
            }}>
              <span style={{ color: "#374151", fontSize: 12, textTransform: "uppercase", letterSpacing: "1px" }}>{label}</span>
              <span style={{ color: "#e2e8f0", fontSize: 16, fontWeight: 700 }}>{value}</span>
            </div>
          ))}
        </div>

        {/* URL */}
        <div style={{
          position: "absolute", bottom: 32,
          color: "#374151", fontSize: 18, letterSpacing: "0.5px",
          display: "flex",
        }}>
          yieldpilot.fund
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    }
  );
}
