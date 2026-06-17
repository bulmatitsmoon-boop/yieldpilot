import axios from "axios";
import { logger } from "./logger";

export interface ProtocolApy {
  protocolId: string;
  name: string;
  asset: string;
  apyBps: number;       // APY in basis points (e.g. 842 = 8.42%)
  apyPercent: number;   // Human-readable (e.g. 8.42)
  tvlUsd: number;
  riskScore: number;    // 1 (low) – 3 (high)
  fetchedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual protocol fetchers
// All protocols here are lending or liquid staking — no LP impermanent loss.
// Liquid staking exits (Jito, BlazeStake, Marinade) go via DEX at <0.3%
// slippage, which the rebalancer accounts for before routing out of them.
// ─────────────────────────────────────────────────────────────────────────────

// Hard cap: any fetched APY above this is treated as corrupt/spoofed data and falls back.
// Legitimate Solana lending yields do not exceed 50% APY. This guards against DNS hijack
// or CDN compromise feeding inflated numbers that trick the keeper into a bad rebalance.
const MAX_SANE_APY_PERCENT = 50;

function sanitizeApy(rawPercent: number, source: string): number {
  if (!isFinite(rawPercent) || rawPercent < 0) {
    logger.warn(`${source}: invalid APY ${rawPercent}, using 0`);
    return 0;
  }
  if (rawPercent > MAX_SANE_APY_PERCENT) {
    logger.warn(`${source}: APY ${rawPercent}% exceeds sanity cap ${MAX_SANE_APY_PERCENT}%, rejecting`);
    return 0;
  }
  return rawPercent;
}

async function fetchKaminoApy(): Promise<ProtocolApy[]> {
  try {
    const { data } = await axios.get(
      `${process.env.KAMINO_API_URL || "https://api.kamino.finance"}/markets`,
      { timeout: 8000 }
    );

    const results: ProtocolApy[] = [];
    const allReserves = data?.markets?.flatMap((m: any) => m.reserves || []) || [];

    const usdcReserve = allReserves.find((r: any) =>
      r.symbol === "USDC" || r.mintAddress === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    );
    if (usdcReserve) {
      const apy = sanitizeApy(parseFloat(usdcReserve.supplyInterestAPY || usdcReserve.supplyApy || "0") * 100, "kamino-usdc");
      if (apy > 0) results.push({ protocolId: "kamino-usdc", name: "Kamino", asset: "USDC", apyBps: Math.round(apy * 100), apyPercent: apy, tvlUsd: parseFloat(usdcReserve.totalSupplyUsd || "0"), riskScore: 1, fetchedAt: new Date() });
    }

    const solReserve = allReserves.find((r: any) => r.symbol === "SOL");
    if (solReserve) {
      const apy = sanitizeApy(parseFloat(solReserve.supplyInterestAPY || solReserve.supplyApy || "0") * 100, "kamino-sol");
      if (apy > 0) results.push({ protocolId: "kamino-sol", name: "Kamino", asset: "SOL", apyBps: Math.round(apy * 100), apyPercent: apy, tvlUsd: parseFloat(solReserve.totalSupplyUsd || "0"), riskScore: 1, fetchedAt: new Date() });
    }

    logger.debug("Kamino APYs fetched", { count: results.length });
    return results.length ? results : getFallbackApys(["kamino-usdc", "kamino-sol"]);
  } catch (err: any) {
    logger.warn("Failed to fetch Kamino APY", { error: err.message });
    return getFallbackApys(["kamino-usdc", "kamino-sol"]);
  }
}

async function fetchMarinadeApy(): Promise<ProtocolApy[]> {
  try {
    const { data } = await axios.get(
      `${process.env.MARINADE_API_URL || "https://api.marinade.finance"}/msol/apy/1d`,
      { timeout: 8000 }
    );
    const apyPercent = sanitizeApy(parseFloat(data?.value || data?.apy || "0") * 100, "marinade-sol");
    if (!apyPercent) return getFallbackApys(["marinade-sol"]);
    return [{ protocolId: "marinade-sol", name: "Marinade", asset: "SOL", apyBps: Math.round(apyPercent * 100), apyPercent, tvlUsd: data?.tvl_usd || 1_230_000_000, riskScore: 1, fetchedAt: new Date() }];
  } catch (err: any) {
    logger.warn("Failed to fetch Marinade APY", { error: err.message });
    return getFallbackApys(["marinade-sol"]);
  }
}

async function fetchJitoApy(): Promise<ProtocolApy[]> {
  try {
    // Jito public APY endpoint — returns jitoSOL staking yield including MEV
    const { data } = await axios.get(
      "https://kobe.mainnet.jito.network/api/v1/stakes/apy",
      { timeout: 8000 }
    );
    const apyPercent = sanitizeApy(parseFloat(data?.value || data?.apy || "0") * 100, "jito-sol");
    if (!apyPercent) return getFallbackApys(["jito-sol"]);
    return [{ protocolId: "jito-sol", name: "Jito", asset: "SOL", apyBps: Math.round(apyPercent * 100), apyPercent, tvlUsd: 2_100_000_000, riskScore: 1, fetchedAt: new Date() }];
  } catch (err: any) {
    logger.warn("Failed to fetch Jito APY", { error: err.message });
    return getFallbackApys(["jito-sol"]);
  }
}

async function fetchMarginFiApy(): Promise<ProtocolApy[]> {
  try {
    const { data } = await axios.get(
      "https://production.marginfi.com/v1/banks",
      { timeout: 8000 }
    );
    const banks: any[] = data?.banks || (Array.isArray(data) ? data : []);
    const results: ProtocolApy[] = [];

    const usdc = banks.find((b: any) => b.tokenSymbol === "USDC" || b.symbol === "USDC");
    if (usdc) {
      const apy = sanitizeApy(parseFloat(usdc.depositRate || usdc.supplyApy || usdc.lendingRate || "0") * 100, "marginfi-usdc");
      if (apy > 0) results.push({ protocolId: "marginfi-usdc", name: "MarginFi", asset: "USDC", apyBps: Math.round(apy * 100), apyPercent: apy, tvlUsd: parseFloat(usdc.totalDeposits || usdc.tvl || "0"), riskScore: 1, fetchedAt: new Date() });
    }

    const sol = banks.find((b: any) => b.tokenSymbol === "SOL" || b.symbol === "SOL");
    if (sol) {
      const apy = sanitizeApy(parseFloat(sol.depositRate || sol.supplyApy || sol.lendingRate || "0") * 100, "marginfi-sol");
      if (apy > 0) results.push({ protocolId: "marginfi-sol", name: "MarginFi", asset: "SOL", apyBps: Math.round(apy * 100), apyPercent: apy, tvlUsd: parseFloat(sol.totalDeposits || sol.tvl || "0"), riskScore: 1, fetchedAt: new Date() });
    }

    return results.length ? results : getFallbackApys(["marginfi-usdc", "marginfi-sol"]);
  } catch (err: any) {
    logger.warn("Failed to fetch MarginFi APY", { error: err.message });
    return getFallbackApys(["marginfi-usdc", "marginfi-sol"]);
  }
}

async function fetchDriftApy(): Promise<ProtocolApy[]> {
  try {
    const { data } = await axios.get(
      "https://dlob.drift.trade/stats/apys",
      { timeout: 8000 }
    );
    const solMarket = data?.find?.((m: any) => m.marketSymbol === "SOL" || m.symbol === "SOL");
    const apyPercent = parseFloat(solMarket?.depositApy || solMarket?.lendApy || "0");
    return [{ protocolId: "drift-sol", name: "Drift", asset: "SOL", apyBps: Math.round(apyPercent * 100), apyPercent, tvlUsd: solMarket?.tvl || 220_000_000, riskScore: 1, fetchedAt: new Date() }];
  } catch (err: any) {
    logger.warn("Failed to fetch Drift APY", { error: err.message });
    return getFallbackApys(["drift-sol"]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fallback APYs — used if API is down (based on recent historical averages)
// Raydium and Orca are intentionally excluded — LP impermanent loss risk is
// incompatible with principal-preserving yield vaults.
// ─────────────────────────────────────────────────────────────────────────────

const FALLBACK_APYS: Record<string, Omit<ProtocolApy, "fetchedAt">> = {
  "marginfi-usdc":  { protocolId: "marginfi-usdc",  name: "MarginFi",   asset: "USDC", apyBps: 1140, apyPercent: 11.40, tvlUsd: 380_000_000,   riskScore: 1 },
  "jito-sol":       { protocolId: "jito-sol",       name: "Jito",       asset: "SOL",  apyBps:  890, apyPercent: 8.90,  tvlUsd: 2_100_000_000, riskScore: 1 },
  "kamino-usdc":    { protocolId: "kamino-usdc",    name: "Kamino",     asset: "USDC", apyBps:  842, apyPercent: 8.42,  tvlUsd: 412_000_000,   riskScore: 1 },
  "marinade-sol":   { protocolId: "marinade-sol",   name: "Marinade",   asset: "SOL",  apyBps:  721, apyPercent: 7.21,  tvlUsd: 1_230_000_000, riskScore: 1 },
  "marginfi-sol":   { protocolId: "marginfi-sol",   name: "MarginFi",   asset: "SOL",  apyBps:  710, apyPercent: 7.10,  tvlUsd: 380_000_000,   riskScore: 1 },
  "kamino-sol":     { protocolId: "kamino-sol",     name: "Kamino",     asset: "SOL",  apyBps:  620, apyPercent: 6.20,  tvlUsd: 280_000_000,   riskScore: 1 },
  "blazestake-sol": { protocolId: "blazestake-sol", name: "BlazeStake", asset: "SOL",  apyBps:  601, apyPercent: 6.01,  tvlUsd: 180_000_000,   riskScore: 1 },
  "drift-sol":      { protocolId: "drift-sol",      name: "Drift",      asset: "SOL",  apyBps:  588, apyPercent: 5.88,  tvlUsd: 220_000_000,   riskScore: 1 },
  "solend-usdc":    { protocolId: "solend-usdc",    name: "Solend",     asset: "USDC", apyBps:  510, apyPercent: 5.10,  tvlUsd: 95_000_000,    riskScore: 1 },
};

function getFallbackApys(ids: string[]): ProtocolApy[] {
  return ids.map(id => FALLBACK_APYS[id] ? { ...FALLBACK_APYS[id], fetchedAt: new Date() } : null).filter(Boolean) as ProtocolApy[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export: fetch all APYs in parallel
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchAllApys(): Promise<ProtocolApy[]> {
  logger.info("Fetching APYs from all protocols...");

  const results = await Promise.allSettled([
    fetchKaminoApy(),
    fetchMarinadeApy(),
    fetchJitoApy(),
    fetchMarginFiApy(),
    fetchDriftApy(),
  ]);

  // Merge live results, fall back per-protocol if any fetcher failed
  const liveMap = new Map<string, ProtocolApy>();
  results.flatMap(r => r.status === "fulfilled" ? r.value : [])
    .forEach(p => liveMap.set(p.protocolId, p));

  // Ensure every fallback protocol is represented (use live data where available)
  const allProtocolIds = Object.keys(FALLBACK_APYS);
  const apys: ProtocolApy[] = allProtocolIds.map(id => liveMap.get(id) || { ...FALLBACK_APYS[id], fetchedAt: new Date() });

  logger.info("APY fetch complete", {
    protocols: apys.map(a => `${a.name}(${a.asset}): ${a.apyPercent.toFixed(2)}%`),
  });

  return apys;
}

// Find best APY for a given asset (optionally cap risk score)
export function bestApyForAsset(
  apys: ProtocolApy[],
  asset: string,
  maxRisk: number = 3
): ProtocolApy | undefined {
  return apys
    .filter(a => a.asset === asset && a.riskScore <= maxRisk)
    .sort((a, b) => b.apyBps - a.apyBps)[0];
}
