import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// All protocols here are lending or liquid staking — no LP impermanent loss risk.
// Liquid staking exits (Jito, Marinade) go via DEX swap at <0.3% slippage,
// which the keeper accounts for before deciding to rebalance out of them.
//
// MarginFi is intentionally NOT listed here — see git history; their SDK can't
// decode their own current mainnet banks and our CPI was never verified against
// their "Project 0" successor.
//
// APY SOURCE (2026-07-16): everything routable now comes from DeFiLlama, the same
// source the keeper uses (keeper/src/apyFetcher.ts). This is deliberate — the site
// and the router MUST agree, or we advertise one rate and optimize on another.
// The previous per-protocol endpoints had silently rotted: api.kamino.finance/markets,
// kobe.mainnet.jito.network/.../stakes/apy and api.orca.so/v2/... all return 404, and
// Solend had no fetcher at all. Every failure fell through to a hardcoded FALLBACK,
// so the site displayed 8.90% for Jito (really 4.89%) and 8.42% for Kamino USDC
// (really 3.39%). Never let a fetch failure masquerade as a live rate again: if a
// live value is unavailable we return `stale: true` so the UI can mark it.
const DEFILLAMA_POOL_IDS: Record<string, string> = {
  "kamino-usdc":  "d2141a59-c199-4be7-8d4b-c8223954836b",
  "kamino-sol":   "525b2dab-ea6a-4cbc-a07f-84ce561d1f83",
  "marinade-sol": "b3f93865-5ec8-4662-90a0-11808e0aa2bd",
  "jito-sol":     "0e7d0722-9054-4907-8593-567b353c0900",
  // Solend rebranded to "Save". This is their Main Pool USDC reserve
  // (underlyingTokens == [USDC mint]), matching SOLEND_USDC_RESERVE on-chain.
  "solend-usdc":  "dde4c16c-504d-470b-9404-006287ce0906",
};

const COLORS: Record<string, string> = {
  "kamino-usdc":      "#3FE0A0",
  "kamino-sol":       "#22B37E",
  "jito-sol":         "#10B981",
  "marinade-sol":     "#06B6D4",
  "drift-sol":        "#14B8A6",
  "solend-usdc":      "#34D399",
  "raydium-usdc-sol": "#EF4444",
  "orca-usdc-eth":    "#EF4444",
};

// Last-resort values ONLY. Anything served from here is flagged `stale: true`.
// These are NOT to be presented as live rates.
const FALLBACK = [
  { protocolId: "jito-sol",         name: "Jito",     asset: "SOL",      apyPercent: 4.89, apyBps: 489, tvlUsd:   762_417_675, riskScore: 1 },
  { protocolId: "kamino-sol",       name: "Kamino",   asset: "SOL",      apyPercent: 5.84, apyBps: 584, tvlUsd:    17_698_922, riskScore: 1 },
  { protocolId: "marinade-sol",     name: "Marinade", asset: "SOL",      apyPercent: 4.73, apyBps: 473, tvlUsd:   181_896_238, riskScore: 1 },
  { protocolId: "kamino-usdc",      name: "Kamino",   asset: "USDC",     apyPercent: 3.39, apyBps: 339, tvlUsd:    23_525_228, riskScore: 1 },
  { protocolId: "solend-usdc",      name: "Solend",   asset: "USDC",     apyPercent: 2.25, apyBps: 225, tvlUsd:     7_143_891, riskScore: 1 },
  // LP protocols — shown only when the user opts in via the LP toggle.
  { protocolId: "raydium-usdc-sol", name: "Raydium",  asset: "USDC-SOL", apyPercent: 0,    apyBps: 0,   tvlUsd:   190_000_000, riskScore: 3 },
  { protocolId: "orca-usdc-eth",    name: "Orca",     asset: "USDC-ETH", apyPercent: 0,    apyBps: 0,   tvlUsd:   120_000_000, riskScore: 3 },
];

async function tryFetch(url: string, timeout = 8000): Promise<any> {
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

/** Latest APY/TVL for one DeFiLlama pool. Returns null on any failure — never a guess. */
async function getLlamaPool(protocolId: string): Promise<{ apyPercent: number; tvlUsd: number } | null> {
  try {
    const data = await tryFetch(`https://yields.llama.fi/chart/${DEFILLAMA_POOL_IDS[protocolId]}`);
    const history: any[] = data?.data ?? [];
    if (!history.length) return null;
    const latest = history[history.length - 1];
    const apy = parseFloat(latest?.apy ?? "0");
    // Reject non-finite/negative/absurd values rather than displaying them.
    if (!Number.isFinite(apy) || apy <= 0 || apy > 100) return null;
    return { apyPercent: apy, tvlUsd: Number(latest?.tvlUsd) || 0 };
  } catch { return null; }
}

async function getRaydiumApy() {
  try {
    const data = await tryFetch("https://api.raydium.io/v2/ammV3/ammPools");
    const pools: any[] = data?.data || [];
    const pool = pools
      .filter((p: any) =>
        (p.mintA?.symbol === "USDC" && p.mintB?.symbol === "SOL") ||
        (p.mintA?.symbol === "SOL"  && p.mintB?.symbol === "USDC"))
      .sort((a: any, b: any) => (b.tvl || 0) - (a.tvl || 0))[0];
    if (!pool) return null;
    const apy = parseFloat(pool.day?.apr || pool.apr || "0") * 100;
    if (!Number.isFinite(apy) || apy <= 0) return null;
    return { protocolId: "raydium-usdc-sol", apyPercent: apy, apyBps: Math.round(apy * 100), tvlUsd: parseFloat(pool.tvl || "0") };
  } catch { return null; }
}

export async function GET(_req: NextRequest) {
  const llamaIds = Object.keys(DEFILLAMA_POOL_IDS);
  const [llamaResults, raydium] = await Promise.all([
    Promise.all(llamaIds.map(id => getLlamaPool(id))),
    getRaydiumApy(),
  ]);

  const liveMap = new Map<string, { apyPercent: number; apyBps: number; tvlUsd: number }>();
  llamaResults.forEach((r, i) => {
    if (r) liveMap.set(llamaIds[i], { apyPercent: r.apyPercent, apyBps: Math.round(r.apyPercent * 100), tvlUsd: r.tvlUsd });
  });
  if (raydium) liveMap.set("raydium-usdc-sol", { apyPercent: raydium.apyPercent, apyBps: raydium.apyBps, tvlUsd: raydium.tvlUsd });

  const fetchedAt = new Date().toISOString();
  const result = FALLBACK.map(fb => {
    const live = liveMap.get(fb.protocolId);
    return {
      ...fb,
      ...(live ? { apyPercent: live.apyPercent, apyBps: live.apyBps, tvlUsd: live.tvlUsd || fb.tvlUsd } : {}),
      stale: !live,          // true => this is NOT a live rate; UI should mark it
      fetchedAt,
      color: COLORS[fb.protocolId] || "#6b7280",
    };
  });

  // Best rate first. Stale/unavailable entries sort last so they can never
  // masquerade as the headline "Best APY".
  result.sort((a, b) => (Number(a.stale) - Number(b.stale)) || (b.apyBps - a.apyBps));

  return NextResponse.json(result, {
    headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" },
  });
}
