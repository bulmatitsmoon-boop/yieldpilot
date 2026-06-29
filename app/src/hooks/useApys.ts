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

// Fallback while loading or if API fails
export const FALLBACK_APYS: ProtocolApy[] = [
  { protocolId: "kamino-usdc", name: "Kamino", asset: "USDC", apyPercent: 8.42, apyBps: 842, tvlUsd: 412_000_000, riskScore: 1, color: "#7C3AED" },
  { protocolId: "marinade-sol", name: "Marinade", asset: "SOL", apyPercent: 7.21, apyBps: 721, tvlUsd: 1_230_000_000, riskScore: 1, color: "#06B6D4" },
  { protocolId: "raydium-usdc-sol", name: "Raydium", asset: "USDC-SOL", apyPercent: 24.7, apyBps: 2470, tvlUsd: 89_000_000, riskScore: 3, color: "#F59E0B" },
  { protocolId: "drift-sol", name: "Drift", asset: "SOL", apyPercent: 5.88, apyBps: 588, tvlUsd: 220_000_000, riskScore: 1, color: "#10B981" },
  { protocolId: "orca-usdc-eth", name: "Orca", asset: "USDC-ETH", apyPercent: 18.3, apyBps: 1830, tvlUsd: 67_000_000, riskScore: 3, color: "#EC4899" },
  { protocolId: "solend-usdt", name: "Solend", asset: "USDT", apyPercent: 6.95, apyBps: 695, tvlUsd: 310_000_000, riskScore: 1, color: "#3B82F6" },
];
