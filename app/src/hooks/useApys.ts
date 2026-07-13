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
  { protocolId: "kamino-usdc", name: "Kamino", asset: "USDC", apyPercent: 8.42, apyBps: 842, tvlUsd: 412_000_000, riskScore: 1, color: "#3FE0A0" },
  { protocolId: "kamino-sol", name: "Kamino", asset: "SOL", apyPercent: 6.20, apyBps: 620, tvlUsd: 280_000_000, riskScore: 1, color: "#3FE0A0" },
  { protocolId: "marinade-sol", name: "Marinade", asset: "SOL", apyPercent: 7.21, apyBps: 721, tvlUsd: 1_230_000_000, riskScore: 1, color: "#2DD4BF" },
  { protocolId: "jito-sol", name: "Jito", asset: "SOL", apyPercent: 8.90, apyBps: 890, tvlUsd: 2_100_000_000, riskScore: 1, color: "#F5B84B" },
  { protocolId: "solend-usdc", name: "Solend", asset: "USDC", apyPercent: 5.10, apyBps: 510, tvlUsd: 95_000_000, riskScore: 1, color: "#9BA8B8" },
  { protocolId: "drift-sol", name: "Drift", asset: "SOL", apyPercent: 5.88, apyBps: 588, tvlUsd: 220_000_000, riskScore: 3, color: "#5D6B7C" },
];
