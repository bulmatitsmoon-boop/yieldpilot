"use client";

import useSWR from "swr";

// Real keeper-liveness timestamp, written by the keeper itself at the end of every
// successful run (see keeper/src/keeperHealth.ts) and committed back to the public
// repo -- fetched directly from GitHub's raw content host, same trust model as the
// rest of this app's on-chain-or-first-party-API data. Replaces the old "Last
// Compounded" stat, which looked like a keeper health signal but wasn't one: it was
// frozen at vault-creation time regardless of whether the keeper was actually alive.
const RAW_URL = "https://raw.githubusercontent.com/bulmatitsmoon-boop/yieldpilot/main/keeper/state/keeper-health.json";

const fetcher = (url: string) => fetch(url, { cache: "no-store" }).then((r) => {
  if (!r.ok) throw new Error(`keeper-health fetch failed: ${r.status}`);
  return r.json();
});

export function useKeeperHealth() {
  const { data, error, isLoading } = useSWR<{ lastCheckTs: number }>(
    RAW_URL,
    fetcher,
    { refreshInterval: 60_000 }
  );

  return {
    lastCheckTs: data?.lastCheckTs ?? null,
    loading: isLoading,
    error,
  };
}
