"use client";
import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { fmtAddr } from "@/components/ui";

export function Header() {
  const { publicKey, disconnect, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const pathname = usePathname();
  const isAdmin = publicKey?.toBase58() === process.env.NEXT_PUBLIC_ADMIN_WALLET;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const isMainnet = process.env.NEXT_PUBLIC_SOLANA_NETWORK === "mainnet-beta";

  const navLinks: [string, string][] = [
    ["Home", "/"],
    ["Dashboard", "/dashboard"],
    ["Live Rates", "/apys"],
    ["Epochs", "/epochs"],
    ["Whitepaper", "/whitepaper"],
    ...(isAdmin ? [["Admin", "/admin"] as [string, string]] : []),
  ];

  return (
    <header className="header-root" style={{
      background: "var(--surface)",
      borderBottom: "1px solid var(--border)",
      padding: "0 32px",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      height: 60,
      position: "sticky",
      top: 0,
      zIndex: 50,
    }}>
      {/* Logo */}
      <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", flexShrink: 0 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 7,
          background: "var(--ink-700)", border: "1px solid var(--line)", display: "flex", alignItems: "center",
          justifyContent: "center", flexShrink: 0,
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 1L12 4V10L7 13L2 10V4L7 1Z" stroke="var(--signal)" strokeWidth="1.5" strokeLinejoin="round"/>
            <circle cx="7" cy="7" r="2" fill="var(--signal)"/>
          </svg>
        </div>
        <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16, letterSpacing: "-0.02em", color: "var(--text-hi)" }}>YieldPilot</span>
        <span className="header-logo-sub" style={{ color: "var(--text-low)", fontSize: 11, marginLeft: 1, fontFamily: "var(--font-mono)" }}>/ Solana</span>
      </Link>

      {/* Nav links — hidden on mobile via CSS */}
      <div className="header-nav" style={{ display: "flex", gap: 4 }}>
        {navLinks.map(([label, href]) => {
          const active = href === "/" ? pathname === "/" : pathname?.startsWith(href);
          return (
            <Link key={href} href={href} style={{
              padding: "6px 12px", borderRadius: 7, fontSize: 13, fontWeight: 500,
              color: active ? "var(--text)" : "var(--text-muted)",
              background: active ? "var(--surface-2)" : "transparent",
              textDecoration: "none", transition: "color 0.15s",
            }}>{label}</Link>
          );
        })}
      </div>

      {/* Right side */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        {/* Network indicator — amber on devnet (caution), signal green on mainnet (live) */}
        <div style={{
          display: "flex", alignItems: "center", gap: 6, fontSize: 12,
          color: isMainnet ? "var(--signal)" : "var(--warn)",
          fontFamily: "var(--font-mono)",
        }}>
          <div className="live-dot" style={{
            width: 6, height: 6, borderRadius: "50%",
            background: isMainnet ? "var(--signal)" : "var(--warn)",
            boxShadow: isMainnet ? "0 0 6px var(--signal)" : "0 0 6px var(--warn)",
            flexShrink: 0,
          }} />
          <span className="header-logo-sub">
            {isMainnet ? "Mainnet" : "Devnet"}
          </span>
        </div>

        {/* Wallet button */}
        {connected && publicKey ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{
              background: "rgba(63,224,160,0.08)",
              border: "1px solid rgba(63,224,160,0.25)",
              padding: "6px 14px", borderRadius: 8,
              fontSize: 13, color: "var(--signal)", fontFamily: "var(--font-mono)",
            }}>
              {fmtAddr(publicKey.toBase58())}
            </div>
            <button
              className="header-disconnect-btn"
              onClick={disconnect}
              style={{
                background: "var(--ink-700)", border: "1px solid var(--line)",
                color: "var(--text-mid)", padding: "6px 12px", borderRadius: 8,
                fontSize: 12, cursor: "pointer", fontFamily: "var(--font-body)",
              }}
            >
              Disconnect
            </button>
          </div>
        ) : (
          <button
            onClick={() => setVisible(true)}
            style={{
              background: "var(--signal)",
              color: "var(--ink-900)", border: "none", padding: "9px 20px",
              borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: "pointer",
              fontFamily: "var(--font-body)", whiteSpace: "nowrap",
            }}
          >
            Connect
          </button>
        )}

        {/* Mobile menu toggle — only visible on narrow screens via CSS */}
        <button
          className="header-burger"
          aria-label="Toggle menu"
          onClick={() => setMobileMenuOpen(o => !o)}
          style={{
            display: "none",
            background: "transparent", border: "1px solid var(--line)",
            borderRadius: 7, width: 34, height: 34,
            alignItems: "center", justifyContent: "center", cursor: "pointer",
            marginLeft: 4, flexShrink: 0,
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            {mobileMenuOpen ? (
              <path d="M3 3L13 13M13 3L3 13" stroke="var(--text-hi)" strokeWidth="1.5" strokeLinecap="round" />
            ) : (
              <path d="M2 4H14M2 8H14M2 12H14" stroke="var(--text-hi)" strokeWidth="1.5" strokeLinecap="round" />
            )}
          </svg>
        </button>
      </div>

      {/* Mobile dropdown menu — only rendered/visible on narrow screens via CSS */}
      {mobileMenuOpen && (
        <div className="header-mobile-menu" style={{
          position: "absolute", top: 60, left: 0, right: 0,
          background: "var(--surface)", borderBottom: "1px solid var(--border)",
          display: "flex", flexDirection: "column", padding: "8px 16px 16px",
          zIndex: 49,
        }}>
          {navLinks.map(([label, href]) => {
            const active = href === "/" ? pathname === "/" : pathname?.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                onClick={() => setMobileMenuOpen(false)}
                style={{
                  padding: "12px 8px", borderRadius: 7, fontSize: 15, fontWeight: 500,
                  color: active ? "var(--text)" : "var(--text-muted)",
                  background: active ? "var(--surface-2)" : "transparent",
                  textDecoration: "none",
                }}
              >{label}</Link>
            );
          })}
          {connected && publicKey && (
            <button
              onClick={() => { disconnect(); setMobileMenuOpen(false); }}
              style={{
                marginTop: 8, padding: "12px 8px", borderRadius: 7, fontSize: 15, fontWeight: 500,
                color: "var(--text-muted)", background: "transparent", border: "none",
                textAlign: "left", cursor: "pointer", fontFamily: "var(--font-body)",
              }}
            >
              Disconnect {fmtAddr(publicKey.toBase58())}
            </button>
          )}
        </div>
      )}
    </header>
  );
}
