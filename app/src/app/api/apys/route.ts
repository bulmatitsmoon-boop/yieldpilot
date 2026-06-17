import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Raydium and Orca are intentionally excluded — LP positions carry impermanent
// loss risk incompatible with a principal-preserving yield vault.
// Marinade is included but the keeper accounts for its ~0.3% liquid unstake
// exit cost before rebalancing out of it.

const COLORS: Record<string, string> = {
  "kamino-usdc":  "#7C3AED",
  "kamino-sol":   "#9F67F5",
  "marinade-sol": "#06B6D4",
  "drift-sol":    "#10B981",
  "solend-usdc":  "#3B82F6",
};

const FALLBACK = [
  { protocolId: "kamino-usdc",  name: "Kamino",   asset: "USDC", apyPercent: 8.42, apyBps: 842, tvlUsd: 412_000_000,   riskScore: 1 },
  { protocolId: "marinade-sol", name: "Marinade", asset: "SOL",  apyPercent: 7.21, apyBps: 721, tvlUsd: 1_230_000_000, riskScore: 1 },
  { protocolId: "kamino-sol",   name: "Kamino",   asset: "SOL",  apyPercent: 6.20, apyBps: 620, tvlUsd: 280_000_000,   riskScore: 1 },
  { protocolId: "drift-sol",    name: "Drift",    asset: "SOL",  apyPercent: 5.88, apyBps: 588, tvlUsd: 220_000_000,   riskScore: 1 },
  { protocolId: "solend-usdc",  name: "Solend",   asset: "USDC", apyPercent: 5.10, apyBps: 510, tvlUsd: 95_000_000,    riskScore: 1 },
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
    const sol  = reserves.find((r: any) => r.symbol === "SOL");
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
  const [kaminoData, marinadeData] = await Promise.all([
    getKaminoApy(),
    getMarinadeApy(),
  ]);

  const liveMap = new Map<string, any>();
  [...(kaminoData || []), ...(marinadeData || [])].forEach(p => liveMap.set(p.protocolId, p));

  const result = FALLBACK.map(fb => {
    const live = liveMap.get(fb.protocolId);
    return { ...(live || fb), color: COLORS[fb.protocolId] || "#6b7280" };
  });

  return NextResponse.json(result, {
    headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" },
  });
}
