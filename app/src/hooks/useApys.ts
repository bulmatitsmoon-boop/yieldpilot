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

// No fallback table. While SWR is loading, or if /api/apys fails, this returns an EMPTY
// array — never a hand-written rate. A hardcoded rate that looks live is the single
// most expensive bug class in this project: a fabricated Solend 5.10% (real 2.25%)
// once captured 80% of the USDC vault, routing real money to the WORSE protocol.
// Consumers must treat [] as "no data" and render "—", not 0%.
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
    apys: data ?? [],
    loading: isLoading,
    error,
    refresh: mutate,
  };
}
