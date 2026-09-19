"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export interface HoodActivity {
  id: string; // tx hash
  chain: "robinhood";
  blockTime: number | null;
  explorerUrl: string;
}

export interface HoodFleetStats {
  hoodDepositedUsd: number; // real pool reserves, stablecoins ~= USD 1:1
  hoodFeesUsd: number; // real treasury balance -- all-time fee revenue collected
  hoodActivePositions: number; // unique real depositors with a nonzero share balance right now
  hoodActivity: HoodActivity[];
  loading: boolean;
}

/// Real, on-chain Robinhood Chain stats -- same "no fabricated numbers" discipline as
/// useFleetStats.ts on the Solana side. Fetched via /api/hood-activity (server-side,
/// cached 60s for all visitors) rather than scanning event logs directly from the
/// browser: Robinhood Chain's public RPC caps eth_getLogs at 2000 blocks per request,
/// so a full since-deployment scan needs real chunking that shouldn't run once per
/// visitor per page load.
export function useHoodFleetStats(): HoodFleetStats {
  const [hoodDepositedUsd, setHoodDepositedUsd] = useState(0);
  const [hoodFeesUsd, setHoodFeesUsd] = useState(0);
  const [hoodActivePositions, setHoodActivePositions] = useState(0);
  const [hoodActivity, setHoodActivity] = useState<HoodActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const requestIdRef = useRef(0);

  const fetchStats = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    try {
      const res = await fetch("/api/hood-activity");
      const data = await res.json();
      if (requestId !== requestIdRef.current) return;

      setHoodDepositedUsd(data.depositedUsd ?? 0);
      setHoodFeesUsd(data.feesUsd ?? 0);
      setHoodActivePositions(data.activePositions ?? 0);
      setHoodActivity(
        (data.activity ?? []).map((a: { id: string; blockTime: number | null; explorerUrl: string }) => ({
          id: a.id,
          chain: "robinhood" as const,
          blockTime: a.blockTime,
          explorerUrl: a.explorerUrl,
        }))
      );
    } catch (err) {
      console.error("useHoodFleetStats error", err);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const id = setInterval(fetchStats, 60_000);
    return () => clearInterval(id);
  }, [fetchStats]);

  return { hoodDepositedUsd, hoodFeesUsd, hoodActivePositions, hoodActivity, loading };
}
