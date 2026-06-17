import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// All protocols here are lending or liquid staking — no LP impermanent loss risk.
// Liquid staking exits (Jito, BlazeStake, Marinade) go via DEX swap at <0.3% slippage,
// which the keeper accounts for before deciding to rebalance out of them.

const COLORS: Record<string, string> = {
  "kamino-usdc":    "#7C3AED",
  "kamino-sol":     "#9F67F5",
  "marginfi-usdc":  "#F59E0B",
  "marginfi-sol":   "#F97316",
  "jito-sol":       "#10B981",
  "marinade-sol":   "#06B6D4",
  "blazestake-sol": "#3B82F6",
  "drift-sol":      "#14B8A6",
  "solend-usdc":    "#8B5CF6",
};

const FALLBACK = [
  { protocolId: "marginfi-usdc",  name: "MarginFi",   asset: "USDC", apyPercent: 11.40, apyBps: 1140, tvlUsd: 380_000_000,   riskScore: 1 },
  { protocolId: "jito-sol",       name: "Jito",       asset: "SOL",  apyPercent: 8.90,  apyBps:  890, tvlUsd: 2_100_000_000, riskScore: 1 },
  { protocolId: "kamino-usdc",    name: "Kamino",     asset: "USDC", apyPercent: 8.42,  apyBps:  842, tvlUsd: 412_000_000,   riskScore: 1 },
  { protocolId: "marinade-sol",   name: "Marinade",   asset: "SOL",  apyPercent: 7.21,  apyBps:  721, tvlUsd: 1_230_000_000, riskScore: 1 },
  { protocolId: "marginfi-sol",   name: "MarginFi",   asset: "SOL",  apyPercent: 7.10,  apyBps:  710, tvlUsd: 380_000_000,   riskScore: 1 },
  { protocolId: "kamino-sol",     name: "Kamino",     asset: "SOL",  apyPercent: 6.20,  apyBps:  620, tvlUsd: 280_000_000,   riskScore: 1 },
  { protocolId: "blazestake-sol", name: "BlazeStake", asset: "SOL",  apyPercent: 6.01,  apyBps:  601, tvlUsd: 180_000_000,   riskScore: 1 },
  { protocolId: "drift-sol",      name: "Drift",      asset: "SOL",  apyPercent: 5.88,  apyBps:  588, tvlUsd: 220_000_000,   riskScore: 1 },
  { protocolId: "solend-usdc",    name: "Solend",     asset: "USDC", apyPercent: 5.10,  apyBps:  510, tvlUsd: 95_000_000,    riskScore: 1 },
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
      if (apy > 0) results.push({ protocolId: "kamino-usdc", name: "Kamino", asset: "USDC", apyPercent: apy, apyBps: Math.round(apy * 100), tvlUsd: parseFloat(usdc.totalSupplyUsd || "0"), riskScore: 1 });
    }
    if (sol) {
      const apy = parseFloat(sol.supplyInterestAPY || sol.supplyApy || "0") * 100;
      if (apy > 0) results.push({ protocolId: "kamino-sol", name: "Kamino", asset: "SOL", apyPercent: apy, apyBps: Math.round(apy * 100), tvlUsd: parseFloat(sol.totalSupplyUsd || "0"), riskScore: 1 });
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

async function getJitoApy() {
  try {
    const data = await tryFetch("https://kobe.mainnet.jito.network/api/v1/stakes/apy");
    const apy = parseFloat(data?.value || data?.apy || "0") * 100;
    if (!apy) return null;
    return [{ protocolId: "jito-sol", name: "Jito", asset: "SOL", apyPercent: apy, apyBps: Math.round(apy * 100), tvlUsd: 2_100_000_000, riskScore: 1 }];
  } catch { return null; }
}

async function getMarginFiApy() {
  try {
    const data = await tryFetch("https://production.marginfi.com/v1/banks");
    const banks = data?.banks || data || [];
    const results = [];
    const usdc = banks.find((b: any) => b.tokenSymbol === "USDC" || b.symbol === "USDC");
    const sol  = banks.find((b: any) => b.tokenSymbol === "SOL"  || b.symbol === "SOL");
    if (usdc) {
      const apy = parseFloat(usdc.depositRate || usdc.supplyApy || usdc.lendingRate || "0") * 100;
      if (apy > 0) results.push({ protocolId: "marginfi-usdc", name: "MarginFi", asset: "USDC", apyPercent: apy, apyBps: Math.round(apy * 100), tvlUsd: parseFloat(usdc.totalDeposits || usdc.tvl || "0"), riskScore: 1 });
    }
    if (sol) {
      const apy = parseFloat(sol.depositRate || sol.supplyApy || sol.lendingRate || "0") * 100;
      if (apy > 0) results.push({ protocolId: "marginfi-sol", name: "MarginFi", asset: "SOL", apyPercent: apy, apyBps: Math.round(apy * 100), tvlUsd: parseFloat(sol.totalDeposits || sol.tvl || "0"), riskScore: 1 });
    }
    return results.length ? results : null;
  } catch { return null; }
}

export async function GET(_req: NextRequest) {
  const [kaminoData, marinadeData, jitoData, marginfiData] = await Promise.all([
    getKaminoApy(),
    getMarinadeApy(),
    getJitoApy(),
    getMarginFiApy(),
  ]);

  const liveMap = new Map<string, any>();
  [
    ...(kaminoData   || []),
    ...(marinadeData || []),
    ...(jitoData     || []),
    ...(marginfiData || []),
  ].forEach(p => liveMap.set(p.protocolId, p));

  const result = FALLBACK.map(fb => {
    const live = liveMap.get(fb.protocolId);
    return { ...(live || fb), color: COLORS[fb.protocolId] || "#6b7280" };
  });

  // Sort by APY descending so the frontend always shows best rate first
  result.sort((a, b) => b.apyBps - a.apyBps);

  return NextResponse.json(result, {
    headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" },
  });
}
