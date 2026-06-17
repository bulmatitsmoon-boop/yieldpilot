import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Protocol colors
const COLORS: Record<string, string> = {
  "kamino-usdc": "#7C3AED",
  "kamino-sol": "#7C3AED",
  "marinade-sol": "#06B6D4",
  "raydium-usdc-sol": "#F59E0B",
  "drift-sol": "#10B981",
  "orca-usdc-eth": "#EC4899",
  "solend-usdt": "#3B82F6",
};

const FALLBACK = [
  { protocolId: "kamino-usdc", name: "Kamino", asset: "USDC", apyPercent: 8.42, apyBps: 842, tvlUsd: 412_000_000, riskScore: 1 },
  { protocolId: "marinade-sol", name: "Marinade", asset: "SOL", apyPercent: 7.21, apyBps: 721, tvlUsd: 1_230_000_000, riskScore: 1 },
  { protocolId: "raydium-usdc-sol", name: "Raydium", asset: "USDC-SOL", apyPercent: 24.7, apyBps: 2470, tvlUsd: 89_000_000, riskScore: 3 },
  { protocolId: "drift-sol", name: "Drift", asset: "SOL", apyPercent: 5.88, apyBps: 588, tvlUsd: 220_000_000, riskScore: 1 },
  { protocolId: "orca-usdc-eth", name: "Orca", asset: "USDC-ETH", apyPercent: 18.3, apyBps: 1830, tvlUsd: 67_000_000, riskScore: 2 },
  { protocolId: "solend-usdt", name: "Solend", asset: "USDT", apyPercent: 6.95, apyBps: 695, tvlUsd: 310_000_000, riskScore: 1 },
];

async function tryFetch(url: string, timeout = 6000): Promise<any> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, next: { revalidate: 60 } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

async function getKaminoApy() {
  try {
    const data = await tryFetch("https://api.kamino.finance/markets");
    const reserves = data?.markets?.flatMap((m: any) => m.reserves || []) || [];
    const usdc = reserves.find((r: any) => r.symbol === "USDC");
    const sol = reserves.find((r: any) => r.symbol === "SOL");
    const results = [];
    if (usdc) {
      const apy = parseFloat(usdc.supplyInterestAPY || usdc.supplyApy || "0") * 100;
      results.push({ protocolId: "kamino-usdc", name: "Kamino", asset: "USDC", apyPercent: apy, apyBps: Math.round(apy * 100), tvlUsd: parseFloat(usdc.totalSupplyUsd || "0"), riskScore: 1 });
    }
    if (sol) {
      const apy = parseFloat(sol.supplyInterestAPY || sol.supplyApy || "0") * 100;
      results.push({ protocolId: "kamino-sol", name: "Kamino", asset: "SOL", apyPercent: apy, apyBps: Math.round(apy * 100), tvlUsd: parseFloat(sol.totalSupplyUsd || "0"), riskScore: 1 });
    }
    return results.length ? results : null;
  } catch { return null; }
}

async function getMarinadeApy() {
  try {
    const data = await tryFetch("https://api.marinade.finance/msol/apy/1d");
    const apy = parseFloat(data?.value || data?.apy || "0") * 100;
    if (!apy) return null;
    return [{ protocolId: "marinade-sol", name: "Marinade", asset: "SOL", apyPercent: apy, apyBps: Math.round(apy * 100), tvlUsd: data?.tvl_usd || 1_230_000_000, riskScore: 1 }];
  } catch { return null; }
}

export async function GET(_req: NextRequest) {
  // Fetch all in parallel, fall back per-protocol if API fails
  const [kaminoData, marinadeData] = await Promise.all([
    getKaminoApy(),
    getMarinadeApy(),
  ]);

  // Merge live data with fallbacks
  const liveMap = new Map<string, any>();
  [...(kaminoData || []), ...(marinadeData || [])].forEach(p => liveMap.set(p.protocolId, p));

  const result = FALLBACK.map(fb => {
    const live = liveMap.get(fb.protocolId);
    const merged = live || fb;
    return { ...merged, color: COLORS[merged.protocolId] || "#6b7280" };
  });

  return NextResponse.json(result, {
    headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" },
  });
}
