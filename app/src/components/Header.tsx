"use client";
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

  const navLinks: [string, string][] = [
    ["Home", "/"],
    ["Dashboard", "/dashboard"],
    ["APYs", "/apys"],
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
          background: "var(--purple)", display: "flex", alignItems: "center",
          justifyContent: "center", flexShrink: 0,
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 1L12 4V10L7 13L2 10V4L7 1Z" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round"/>
            <circle cx="7" cy="7" r="2" fill="#fff"/>
          </svg>
        </div>
        <span style={{ fontWeight: 800, fontSize: 16, letterSpacing: "-0.025em", color: "var(--text)" }}>YieldPilot</span>
        <span className="header-logo-sub" style={{ color: "var(--text-dim)", fontSize: 11, marginLeft: 1 }}>/ Solana</span>
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
        {/* Network indicator */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--green)", fontSize: 12 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--green)", boxShadow: "0 0 6px #34d399", flexShrink: 0 }} />
          <span className="header-logo-sub">
            {process.env.NEXT_PUBLIC_SOLANA_NETWORK === "mainnet-beta" ? "Mainnet" : "Devnet"}
          </span>
        </div>

        {/* Wallet button */}
        {connected && publicKey ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{
              background: "rgba(124,58,237,0.1)",
              border: "1px solid rgba(124,58,237,0.3)",
              padding: "6px 14px", borderRadius: 8,
              fontSize: 13, color: "var(--purple-light)", fontFamily: "var(--mono)",
            }}>
              {fmtAddr(publicKey.toBase58())}
            </div>
            <button
              onClick={disconnect}
              style={{
                background: "var(--surface-2)", border: "1px solid var(--border)",
                color: "var(--text-muted)", padding: "6px 12px", borderRadius: 8,
                fontSize: 12, cursor: "pointer", fontFamily: "Inter, sans-serif",
              }}
            >
              Disconnect
            </button>
          </div>
        ) : (
          <button
            onClick={() => setVisible(true)}
            style={{
              background: "var(--purple)",
              color: "#fff", border: "none", padding: "9px 20px",
              borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: "pointer",
              fontFamily: "Inter, sans-serif", whiteSpace: "nowrap",
            }}
          >
            Connect
          </button>
        )}
      </div>
    </header>
  );
}
