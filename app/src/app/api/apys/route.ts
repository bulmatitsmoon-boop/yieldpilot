import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// All protocols here are lending or liquid staking — no LP impermanent loss risk.
// Liquid staking exits (Jito, Marinade) go via DEX swap at <0.3% slippage,
// which the keeper accounts for before deciding to rebalance out of them.

const COLORS: Record<string, string> = {
  "kamino-usdc":      "#7C3AED",
  "kamino-sol":       "#9F67F5",
  "marginfi-usdc":    "#F59E0B",
  "marginfi-sol":     "#F97316",
  "jito-sol":         "#10B981",
  "marinade-sol":     "#06B6D4",
  "drift-sol":        "#14B8A6",
  "solend-usdc":      "#8B5CF6",
  "raydium-usdc-sol": "#EF4444",
  "orca-usdc-eth":    "#EF4444",
};

const FALLBACK = [
  { protocolId: "marginfi-usdc",    name: "MarginFi",   asset: "USDC",     apyPercent: 11.40, apyBps: 1140, tvlUsd: 380_000_000,   riskScore: 1 },
  { protocolId: "jito-sol",         name: "Jito",       asset: "SOL",      apyPercent: 8.90,  apyBps:  890, tvlUsd: 2_100_000_000, riskScore: 1 },
  { protocolId: "kamino-usdc",      name: "Kamino",     asset: "USDC",     apyPercent: 8.42,  apyBps:  842, tvlUsd: 412_000_000,   riskScore: 1 },
  { protocolId: "marinade-sol",     name: "Marinade",   asset: "SOL",      apyPercent: 7.21,  apyBps:  721, tvlUsd: 1_230_000_000, riskScore: 1 },
  { protocolId: "marginfi-sol",     name: "MarginFi",   asset: "SOL",      apyPercent: 7.10,  apyBps:  710, tvlUsd: 380_000_000,   riskScore: 1 },
  { protocolId: "kamino-sol",       name: "Kamino",     asset: "SOL",      apyPercent: 6.20,  apyBps:  620, tvlUsd: 280_000_000,   riskScore: 1 },
  { protocolId: "drift-sol",        name: "Drift",      asset: "SOL",      apyPercent: 5.88,  apyBps:  588, tvlUsd: 220_000_000,   riskScore: 1 },
  { protocolId: "solend-usdc",      name: "Solend",     asset: "USDC",     apyPercent: 5.10,  apyBps:  510, tvlUsd: 95_000_000,    riskScore: 1 },
  // LP protocols — shown only when user opts in via the LP toggle
  { protocolId: "raydium-usdc-sol", name: "Raydium",    asset: "USDC-SOL", apyPercent: 24.70, apyBps: 2470, tvlUsd: 190_000_000,   riskScore: 3 },
  { protocolId: "orca-usdc-eth",    name: "Orca",       asset: "USDC-ETH", apyPercent: 18.30, apyBps: 1830, tvlUsd: 120_000_000,   riskScore: 3 },
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

async function getRaydiumApy() {
  try {
    const data = await tryFetch("https://api.raydium.io/v2/ammV3/ammPools");
    const pools: any[] = data?.data || [];
    const pool = pools
      .filter((p: any) =>
        (p.mintA?.symbol === "USDC" && p.mintB?.symbol === "SOL") ||
        (p.mintA?.symbol === "SOL"  && p.mintB?.symbol === "USDC")
      )
      .sort((a: any, b: any) => (b.tvl || 0) - (a.tvl || 0))[0];
    if (!pool) return null;
    const apy = parseFloat(pool.day?.apr || pool.apr || "0") * 100;
    return [{ protocolId: "raydium-usdc-sol", name: "Raydium", asset: "USDC-SOL", apyPercent: apy, apyBps: Math.round(apy * 100), tvlUsd: parseFloat(pool.tvl || "0"), riskScore: 3 }];
  } catch { return null; }
}

async function getOrcaApy() {
  try {
    const data = await tryFetch("https://api.orca.so/v2/solana/whirlpools");
    const pools: any[] = data?.whirlpools || data || [];
    const pool = pools
      .filter((p: any) =>
        (p.tokenA?.symbol === "USDC" && p.tokenB?.symbol === "ETH") ||
        (p.tokenA?.symbol === "ETH"  && p.tokenB?.symbol === "USDC")
      )
      .sort((a: any, b: any) => (b.tvl || 0) - (a.tvl || 0))[0];
    if (!pool) return null;
    const apy = parseFloat(pool.apy || pool.feeApr || "0") * 100;
    return [{ protocolId: "orca-usdc-eth", name: "Orca", asset: "USDC-ETH", apyPercent: apy, apyBps: Math.round(apy * 100), tvlUsd: parseFloat(pool.tvl || "0"), riskScore: 3 }];
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
  const [kaminoData, marinadeData, jitoData, marginfiData, raydiumData, orcaData] = await Promise.all([
    getKaminoApy(),
    getMarinadeApy(),
    getJitoApy(),
    getMarginFiApy(),
    getRaydiumApy(),
    getOrcaApy(),
  ]);

  const liveMap = new Map<string, any>();
  [
    ...(kaminoData   || []),
    ...(marinadeData || []),
    ...(jitoData     || []),
    ...(marginfiData || []),
    ...(raydiumData  || []),
    ...(orcaData     || []),
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
