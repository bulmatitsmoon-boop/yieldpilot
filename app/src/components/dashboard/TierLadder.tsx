"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

const TIERS = [
  { key: "standard", tier: "Standard", color: "var(--text-low)", req: "No $YPILOT required", fee: "9%" },
  { key: "bronze", tier: "Bronze", color: "#CD7F32", req: "10,000+ $YPILOT", fee: "6%" },
  { key: "silver", tier: "Silver", color: "var(--text-mid)", req: "100,000+ $YPILOT", fee: "3%" },
  { key: "gold", tier: "Gold", color: "var(--token)", req: "1,000,000+ $YPILOT", fee: "0%" },
];

interface Props {
  yourTierKey?: string | null; // pass the connected user's real tier key, or null if disconnected
}

export function TierLadder({ yourTierKey = null }: Props) {
  const [active, setActive] = useState(TIERS.findIndex(t => t.key === yourTierKey) >= 0 ? TIERS.findIndex(t => t.key === yourTierKey) : 2);
  const [auto, setAuto] = useState(!yourTierKey);

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => setActive((a) => (a + 1) % TIERS.length), 3500);
    return () => clearInterval(id);
  }, [auto]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--token)", letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: "var(--font-mono)" }}>
          Hold $YPILOT
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--token)", fontFamily: "var(--font-mono)" }}>
          {auto && <><span className="live-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--token)" }} />AUTO</>}
        </div>
      </div>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 700, letterSpacing: "-0.015em", color: "var(--text-hi)", marginBottom: 16 }}>
        Pay less on profit. Every tier, uncapped.
      </h2>
      <p style={{ color: "var(--text-mid)", fontSize: 14, maxWidth: 520, lineHeight: 1.65, marginBottom: 32 }}>
        Your tier sets your performance fee — nothing else. No deposit fees, no management fees,
        and no tier is ever capped on how much it can deposit. Fees apply to profit only, never your principal.
      </p>

      {/* Connected-dot slider */}
      <div style={{ position: "relative", height: 24, marginBottom: 24 }}>
        <div style={{ position: "absolute", top: 11, left: 12, right: 12, height: 2, background: "linear-gradient(90deg, var(--line), var(--token))" }} />
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, display: "flex", justifyContent: "space-between" }}>
          {TIERS.map((t, i) => (
            <button
              key={t.key}
              onClick={() => { setActive(i); setAuto(false); }}
              style={{
                width: 24, height: 24, borderRadius: "50%", border: "none", cursor: "pointer",
                background: i === active ? t.color : "var(--ink-700)",
                boxShadow: i === active ? `0 0 0 4px ${t.color}33` : "none",
                transition: "background 0.3s",
              }}
            />
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        {TIERS.map((t, i) => (
          <button
            key={t.key}
            onClick={() => { setActive(i); setAuto(false); }}
            style={{
              border: i === active ? `1px solid ${t.color}66` : "1px solid var(--line)",
              borderRadius: 12, padding: "22px 20px", textAlign: "left", cursor: "pointer",
              background: i === active ? `${t.color}0f` : "var(--ink-800)",
              position: "relative",
            }}
          >
            {t.key === yourTierKey && (
              <span style={{
                position: "absolute", top: 16, right: 16, fontSize: 9, fontWeight: 700,
                padding: "2px 7px", borderRadius: 4, background: `${t.color}22`, color: t.color,
                border: `1px solid ${t.color}44`, letterSpacing: "0.04em", fontFamily: "var(--font-mono)",
              }}>YOUR TIER</span>
            )}
            <div style={{ fontWeight: 700, fontSize: 15, color: t.color, marginBottom: 4, fontFamily: "var(--font-display)" }}>{t.tier}</div>
            <div style={{ fontSize: 12, color: "var(--text-low)", marginBottom: 16 }}>{t.req}</div>
            <div className="mono-num" style={{ fontSize: 28, fontWeight: 500, color: "var(--text-hi)", marginBottom: 2 }}>{t.fee}</div>
            <div style={{ fontSize: 11, color: "var(--text-low)" }}>on profit at exit — no deposit cap, ever</div>
          </button>
        ))}
      </div>

      <div style={{ border: "1px solid var(--line)", borderRadius: 12, padding: "18px 22px", background: "var(--ink-800)", marginTop: 12, minHeight: 60 }}>
        <AnimatePresence mode="wait">
          <motion.div
            key={active}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25 }}
            style={{ fontSize: 13, color: "var(--text-mid)" }}
          >
            <span style={{ color: TIERS[active].color, fontWeight: 700 }}>{TIERS[active].tier}</span>
            {" — "}{TIERS[active].req}, <span className="mono-num">{TIERS[active].fee}</span> performance fee on profit, unlimited deposits.
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
