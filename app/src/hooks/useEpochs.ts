"use client";

import useSWR from "swr";

export interface EpochProtocolStatus {
  protocolId: string;
  name: string;
  asset: string;
  color: string;
  lastUpdateEpoch: number | null;
  epochsBehind: number | null;
  isStale: boolean | null;
  epochVerified: boolean;
  /** What lastUpdateEpoch actually measures — not identical across protocols. Jito/PSOL:
   *  "last updated" (whole-pool balance refresh). Marinade: "last stake-delta run" (when
   *  the crank last rebalanced) — a real but different on-chain signal. */
  epochFieldLabel?: string;
  apyPercent?: number | null;
}

export interface NetworkEpochInfo {
  epoch: number;
  slotIndex: number;
  slotsInEpoch: number;
  progressPct: number;
  epochLengthDays: number;
  estSecondsToNextEpoch: number;
}

export interface EpochsResponse {
  network: NetworkEpochInfo;
  protocols: EpochProtocolStatus[];
}

const fetcher = (url: string) => fetch(url).then(r => r.json());

export function useEpochs() {
  const { data, error, isLoading, mutate } = useSWR<EpochsResponse>(
    "/api/epochs",
    fetcher,
    {
      refreshInterval: 60_000,
      revalidateOnFocus: true,
    }
  );

  return {
    network: data?.network ?? null,
    protocols: data?.protocols ?? [],
    loading: isLoading,
    error,
    refresh: mutate,
  };
}
