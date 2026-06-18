"use client";
import React from "react";

// ── Pill badge ────────────────────────────────────────────────────────────────
const pillStyles: Record<string, { bg: string; color: string }> = {
  Low:    { bg: "#052e16", color: "#4ade80" },
  Medium: { bg: "#431407", color: "#fb923c" },
  High:   { bg: "#450a0a", color: "#f87171" },
  Lending:        { bg: "#0c1a2e", color: "#60a5fa" },
  "Liquid Stake": { bg: "#1a0533", color: "#c084fc" },
  LP:     { bg: "#1c1917", color: "#d6d3d1" },
  Active: { bg: "#052e16", color: "#4ade80" },
  Idle:   { bg: "#1c1917", color: "#6b7280" },
};

export function Pill({ label }: { label: string }) {
  const s = pillStyles[label] || { bg: "#1e2535", color: "#94a3b8" };
  return (
    <span style={{ background: s.bg, color: s.color, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}

// ── Stat card ────────────────────────────────────────────────────────────────
export function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "20px 24px", flex: 1, minWidth: 150 }}>
      <div style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>{label}</div>
      <div style={{ color: accent || "var(--text)", fontSize: 26, fontWeight: 700, fontFamily: "var(--mono)", lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

// ── Card wrapper ─────────────────────────────────────────────────────────────
export function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", ...style }}>
      {children}
    </div>
  );
}

export function CardHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ fontWeight: 700, fontSize: 14 }}>{title}</span>
      {right}
    </div>
  );
}

// ── Toggle switch ─────────────────────────────────────────────────────────────
export function Toggle({ value, onChange, label, sub }: { value: boolean; onChange: (v: boolean) => void; label: string; sub?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        style={{ width: 40, height: 22, borderRadius: 11, cursor: "pointer", background: value ? "var(--purple)" : "var(--border-2)", position: "relative", transition: "background 0.2s", flexShrink: 0 }}
      >
        <div style={{ position: "absolute", top: 3, left: value ? 21 : 3, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
      </div>
      <div>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{label}</div>
        {sub && <div style={{ color: "var(--text-muted)", fontSize: 11 }}>{sub}</div>}
      </div>
    </div>
  );
}

// ── Button ────────────────────────────────────────────────────────────────────
export function Button({
  children, onClick, variant = "primary", disabled, fullWidth, size = "md"
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost";
  disabled?: boolean;
  fullWidth?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const bg = variant === "primary"
    ? "linear-gradient(135deg, #7c3aed, #6d28d9)"
    : variant === "secondary"
    ? "var(--surface-2)"
    : "transparent";
  const color = variant === "primary" ? "#fff" : variant === "secondary" ? "var(--text)" : "var(--text-muted)";
  const padding = size === "sm" ? "6px 12px" : size === "lg" ? "14px 28px" : "9px 18px";
  const fontSize = size === "sm" ? 12 : size === "lg" ? 15 : 13;

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: disabled ? "var(--border)" : bg,
        color: disabled ? "var(--text-muted)" : color,
        border: variant === "secondary" ? "1px solid var(--border)" : "none",
        padding, fontSize, fontWeight: 600,
        borderRadius: 8, cursor: disabled ? "not-allowed" : "pointer",
        width: fullWidth ? "100%" : undefined,
        transition: "opacity 0.15s",
        opacity: disabled ? 0.6 : 1,
        fontFamily: "Inter, sans-serif",
      }}
    >
      {children}
    </button>
  );
}

// ── Tx status banner ──────────────────────────────────────────────────────────
export function TxBanner({ status, error, sig }: { status: string; error: string | null; sig: string | null }) {
  if (status === "idle") return null;

  const configs: Record<string, { bg: string; border: string; color: string; icon: string; msg: string }> = {
    signing:    { bg: "#0c1a2e", border: "#1e40af", color: "#93c5fd", icon: "⏳", msg: "Waiting for wallet signature..." },
    confirming: { bg: "#0c1a2e", border: "#1e40af", color: "#93c5fd", icon: "🔄", msg: "Confirming on-chain..." },
    success:    { bg: "#052e16", border: "#166534", color: "#86efac", icon: "✓", msg: "Transaction confirmed!" },
    error:      { bg: "#450a0a", border: "#7f1d1d", color: "#fca5a5", icon: "✕", msg: error || "Transaction failed" },
  };
  const c = configs[status];
  if (!c) return null;

  return (
    <div style={{
      position: "fixed", bottom: 24, right: 24, zIndex: 1000,
      background: c.bg, border: `1px solid ${c.border}`,
      borderRadius: 12, padding: "16px 20px",
      display: "flex", flexDirection: "column", gap: 8,
      minWidth: 300, maxWidth: 420,
      boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
      animation: "slideIn 0.2s ease",
    }}>
      <style>{`@keyframes slideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }`}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 16 }}>{c.icon}</span>
        <span style={{ color: c.color, fontWeight: 600, fontSize: 14 }}>{c.msg}</span>
      </div>
      {sig && status === "success" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ color: "var(--text-muted)", fontSize: 11, fontFamily: "var(--mono)", wordBreak: "break-all" }}>
            {sig.slice(0, 20)}...{sig.slice(-8)}
          </div>
          <a href={`https://solscan.io/tx/${sig}?cluster=devnet`} target="_blank" rel="noopener noreferrer"
            style={{ color: "var(--purple-light)", fontSize: 12, textDecoration: "none", fontWeight: 600 }}>
            View on Solscan ↗
          </a>
        </div>
      )}
    </div>
  );
}

// ── Number formatters ─────────────────────────────────────────────────────────
export function fmt(n: number, d = 2) {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function fmtTvl(n: number) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toLocaleString()}`;
}
export function fmtAddr(s: string) {
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}
