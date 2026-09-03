"use client";

import { motion } from "framer-motion";

interface Props {
  bestName: string | null;
  bestApy: number | null;
  runnerUpName: string | null;
}

/**
 * The "flight-path routing" signature visual: a glowing curved path from the
 * vault to the winning protocol, with a traveling dot. Driven entirely by
 * real best/runner-up route data passed in — no fabricated network activity.
 */
export function RoutingVisual({ bestName, bestApy, runnerUpName }: Props) {
  if (!bestName) return null;

  return (
    <div style={{ position: "relative", height: 140 }}>
      <svg viewBox="0 0 400 140" width="100%" height="140" style={{ overflow: "visible" }}>
        <defs>
          <linearGradient id="routePrimary" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--signal)" stopOpacity="0.1" />
            <stop offset="100%" stopColor="var(--signal)" stopOpacity="0.9" />
          </linearGradient>
        </defs>

        {/* Runner-up path (dashed, dim) */}
        {runnerUpName && (
          <path
            d="M 60 70 C 180 70, 220 112, 340 112"
            fill="none"
            stroke="var(--line)"
            strokeWidth="1.5"
            strokeDasharray="3 4"
          />
        )}

        {/* Primary path (glowing, animated draw-in) */}
        <motion.path
          d="M 60 70 C 180 70, 220 30, 340 30"
          fill="none"
          stroke="url(#routePrimary)"
          strokeWidth="2"
          strokeLinecap="round"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
        />

        {/* Traveling pilot-dot along the primary path */}
        <motion.circle
          r="4"
          fill="var(--signal)"
          initial={{ offsetDistance: "0%", opacity: 0 }}
          animate={{ offsetDistance: "100%", opacity: [0, 1, 1, 0] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: "linear", delay: 1.1 }}
          style={{ offsetPath: "path('M 60 70 C 180 70, 220 30, 340 30')" } as any}
        />

        {/* Vault node */}
        <circle cx="60" cy="70" r="6" fill="var(--ink-900)" stroke="var(--text-mid)" strokeWidth="1.5" />
        <text x="60" y="95" textAnchor="middle" fontSize="10" fill="var(--text-mid)" fontFamily="var(--font-mono)">VAULT</text>

        {/* Best protocol node */}
        <circle cx="340" cy="30" r="5" fill="var(--signal)" />
        <text x="340" y="18" textAnchor="middle" fontSize="11" fill="var(--text-hi)" fontFamily="var(--font-display)" fontWeight="700">
          {bestName}
        </text>

        {/* Runner-up node. Labeled "0%" explicitly — the dashed line + visible dot alone
            read as "some smaller share routes here," a leftover metaphor from the old
            80/20 split. Routing is winner-take-all now: this protocol gets funded only
            if it overtakes the current best by more than the drift threshold. Mirrors
            the "100%" the winner shows in the allocation bar below, so the two together
            read as a real 100/0 split, not 80/20. */}
        {runnerUpName && (
          <>
            <circle cx="340" cy="112" r="4" fill="var(--signal-dim)" opacity="0.6" />
            <text x="340" y="126" textAnchor="middle" fontSize="10" fill="var(--text-mid)" fontFamily="var(--font-mono)">
              {runnerUpName}
            </text>
            <text x="340" y="138" textAnchor="middle" fontSize="9" fill="var(--text-low)" fontFamily="var(--font-mono)">
              0% · monitored
            </text>
          </>
        )}
      </svg>
    </div>
  );
}
