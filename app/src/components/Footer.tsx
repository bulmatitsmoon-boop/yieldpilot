import Link from "next/link";

export function Footer() {
  const isMainnet = process.env.NEXT_PUBLIC_SOLANA_NETWORK === "mainnet-beta";
  return (
    <footer style={{
      borderTop: "1px solid var(--border)",
      background: "var(--surface)",
      padding: "40px 32px 32px",
      marginTop: 80,
    }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <div className="footer-inner" style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 32, marginBottom: 36 }}>

          {/* Brand */}
          <div style={{ maxWidth: 260 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <div style={{ width: 28, height: 28, borderRadius: 7, background: "var(--ink-700)", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M7 1L12 4V10L7 13L2 10V4L7 1Z" stroke="var(--signal)" strokeWidth="1.5" strokeLinejoin="round"/>
                    <circle cx="7" cy="7" r="2" fill="var(--signal)"/>
                  </svg>
                </div>
              <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 15, color: "var(--text-hi)" }}>YieldPilot</span>
            </div>
            <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6 }}>
              Automated yield optimization on Solana. Non-custodial, transparent, always on.
            </p>
          </div>

          {/* Nav */}
          <div style={{ display: "flex", gap: 48, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>Product</div>
              {[["Home", "/"], ["Dashboard", "/dashboard"], ["Live Rates", "/apys"]].map(([label, href]) => (
                <div key={href} style={{ marginBottom: 8 }}>
                  <Link href={href} style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>{label}</Link>
                </div>
              ))}
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>Resources</div>
              {[
                ["Whitepaper", "/whitepaper"],
                ["X / Twitter", "https://x.com/YieldPilotSOL"],
              ].map(([label, href]) => (
                <div key={href} style={{ marginBottom: 8 }}>
                  {href.startsWith("/") ? (
                    <a href={href} style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>{label}</a>
                  ) : (
                    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>{label}</a>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 20, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <p style={{ color: "var(--text-dim)", fontSize: 12 }}>
            © {new Date().getFullYear()} YieldPilot. Not financial advice.
          </p>
          <p style={{ color: "var(--text-dim)", fontSize: 12 }}>
            {isMainnet ? (
              <>Live on <span style={{ color: "var(--signal)" }}>Solana Mainnet</span>.</>
            ) : (
              <>Currently on <span style={{ color: "var(--warn)" }}>Devnet</span> — do not deposit real funds.</>
            )}
          </p>
        </div>
      </div>
    </footer>
  );
}
