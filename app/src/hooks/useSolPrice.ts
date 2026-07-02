"use client";

import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

/** Live SOL/USD price via our API route (proxies CoinGecko). */
export function useSolPrice() {
  const { data } = useSWR<{ usd: number; live: boolean }>("/api/sol-price", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: true,
  });
  return data?.usd ?? 150;
}
