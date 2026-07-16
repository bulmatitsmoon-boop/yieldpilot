"use client";

import useSWR from "swr";

export interface ProtocolApy {
  protocolId: string;
  name: string;
  asset: string;
  apyPercent: number;
  apyBps: number;
  tvlUsd: number;
  riskScore: number;
  color: string;
  /** true => this is NOT a live rate (fetch failed or still loading). Render as "—", never as a number. */
  stale?: boolean;
}

// These hit our Next.js API routes which proxy to the real protocol APIs
const fetcher = (url: string) => fetch(url).then(r => r.json());

export function useApys() {
  const { data, error, isLoading, mutate } = useSWR<ProtocolApy[]>(
    "/api/apys",
    fetcher,
    {
      refreshInterval: 60_000, // refresh every minute
      revalidateOnFocus: true,
    }
  );

  return {
    apys: data || FALLBACK_APYS,
    loading: isLoading,
    error,
    refresh: mutate,
  };
}

// Fallback while loading or if API fails.
// Only protocols the program can actually route to appear as routable (riskScore < 3).
// Drift is informational-only (no deploy_to_drift instruction exists on-chain) — kept
// at riskScore 3 so it renders in the "not routable" bucket rather than the live table.
export const FALLBACK_APYS: ProtocolApy[] = [
  // Shown only while loading or if /api/apys fails. Every entry is stale:true so the
  // UI renders "—" instead of a number we did not actually fetch. Values refreshed
  // 2026-07-16 against real rates (they had drifted badly: jito 8.90 vs real 4.89,
  // kamino-usdc 8.42 vs real 3.39, solend 5.10 vs real 2.25) so that even if a future
  // bug leaks them into view, they are not wildly wrong.
  { protocolId: "kamino-sol", name: "Kamino", asset: "SOL", apyPercent: 5.84, apyBps: 584, tvlUsd: 17_698_922, riskScore: 1, color: "#3FE0A0", stale: true },
  { protocolId: "jito-sol", name: "Jito", asset: "SOL", apyPercent: 4.89, apyBps: 489, tvlUsd: 762_417_675, riskScore: 1, color: "#F5B84B", stale: true },
  { protocolId: "marinade-sol", name: "Marinade", asset: "SOL", apyPercent: 4.73, apyBps: 473, tvlUsd: 181_896_238, riskScore: 1, color: "#2DD4BF", stale: true },
  { protocolId: "kamino-usdc", name: "Kamino", asset: "USDC", apyPercent: 3.39, apyBps: 339, tvlUsd: 23_525_228, riskScore: 1, color: "#3FE0A0", stale: true },
  { protocolId: "solend-usdc", name: "Solend", asset: "USDC", apyPercent: 2.25, apyBps: 225, tvlUsd: 7_143_891, riskScore: 1, color: "#9BA8B8", stale: true },
  { protocolId: "drift-sol", name: "Drift", asset: "SOL", apyPercent: 5.88, apyBps: 588, tvlUsd: 220_000_000, riskScore: 3, color: "#5D6B7C", stale: true },
];
