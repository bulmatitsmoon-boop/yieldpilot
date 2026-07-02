"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

const STEPS = [
  { n: "01", title: "Deposit", tag: "You fund the vault", detail: "Add USDC or SOL and receive vault shares priced to the vault's current value. One transaction, non-custodial — the shares are your claim on the pool." },
  { n: "02", title: "Monitor", tag: "The keeper scans", detail: "A keeper bot fetches live APY data from every supported protocol on a 15-minute cycle, watching for a meaningfully better rate." },
  { n: "03", title: "Route", tag: "Capital gets directed", detail: "80% of the vault moves to the highest-yielding protocol, 20% stays in the runner-up — rebalancing only when the spread beats a 0.5% threshold." },
  { n: "04", title: "Compound", tag: "Earnings reinvest", detail: "Every hour, accrued yield is harvested and reinvested automatically. Your position grows without any action from you." },
];

export function HowItWorksStepper() {
  const [active, setActive] = useState(0);
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => setActive((a) => (a + 1) % STEPS.length), 3500);
    return () => clearInterval(id);
  }, [auto]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-low)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10, fontFamily: "var(--font-mono)" }}>
            How it works
          </div>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 700, letterSpacing: "-0.015em", color: "var(--text-hi)" }}>
            Set it up once. The protocol handles the rest.
          </h2>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--signal)", fontFamily: "var(--font-mono)" }}>
          <span className="live-dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--signal)" }} />
          AUTO
        </div>
      </div>

      {/* Connecting progress line with nodes */}
      <div style={{ position: "relative", height: 24, marginBottom: 16, marginTop: 24 }}>
        <div style={{ position: "absolute", top: 11, left: 0, right: 0, height: 2, background: "var(--line)" }} />
        <motion.div
          style={{ position: "absolute", top: 11, left: 0, height: 2, background: "var(--signal)" }}
          animate={{ width: `${(active / (STEPS.length - 1)) * 100}%` }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        />
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, display: "flex", justifyContent: "space-between" }}>
          {STEPS.map((s, i) => (
            <button
              key={s.n}
              onClick={() => { setActive(i); setAuto(false); }}
              style={{
                width: 24, height: 24, borderRadius: "50%", border: "none", cursor: "pointer",
                background: i <= active ? "var(--signal)" : "var(--ink-700)",
                boxShadow: i === active ? "0 0 0 4px rgba(63,224,160,0.15)" : "none",
                transition: "background 0.3s",
              }}
            />
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden", marginBottom: 12 }}>
        {STEPS.map((s, i) => (
          <button
            key={s.n}
            onClick={() => { setActive(i); setAuto(false); }}
            style={{
              padding: "24px 20px", textAlign: "left", cursor: "pointer",
              background: i === active ? "rgba(63,224,160,0.06)" : "var(--ink-800)",
              border: "none",
              borderLeft: i > 0 ? "1px solid var(--line)" : "none",
              borderTop: i === active ? "2px solid var(--signal)" : "2px solid transparent",
            }}
          >
            <div className="mono-num" style={{ fontSize: 11, color: i === active ? "var(--signal)" : "var(--text-low)", marginBottom: 12 }}>{s.n}</div>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4, color: "var(--text-hi)" }}>{s.title}</div>
            <div style={{ fontSize: 12, color: "var(--text-mid)" }}>{s.tag}</div>
          </button>
        ))}
      </div>

      {/* Auto-cycling detail panel */}
      <div style={{ border: "1px solid var(--line)", borderRadius: 12, padding: "20px 24px", background: "var(--ink-800)", minHeight: 88 }}>
        <AnimatePresence mode="wait">
          <motion.div
            key={active}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.3 }}
          >
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--signal)", letterSpacing: "0.06em", marginBottom: 6, fontFamily: "var(--font-mono)" }}>
              STEP {STEPS[active].n} · {STEPS[active].title.toUpperCase()}
            </div>
            <div style={{ fontSize: 14, color: "var(--text-mid)", lineHeight: 1.7 }}>
              {STEPS[active].detail}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
