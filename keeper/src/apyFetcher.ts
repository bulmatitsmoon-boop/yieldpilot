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
// Liquid staking exits (Jito, Marinade) go via DEX at <0.3%
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

// DeFiLlama pool IDs for the pools we care about (Kamino main market, highest TVL)
const DEFILLAMA_POOL_IDS: Record<string, string> = {
  "kamino-usdc": "d2141a59-c199-4be7-8d4b-c8223954836b", // Kamino main market USDC, $19M TVL
  "kamino-sol":  "525b2dab-ea6a-4cbc-a07f-84ce561d1f83", // Kamino main market SOL, highest TVL
  "marinade-sol":"b3f93865-5ec8-4662-90a0-11808e0aa2bd", // Marinade mSOL
  "jito-sol":    "0e7d0722-9054-4907-8593-567b353c0900", // Jito jitoSOL
};

async function fetchKaminoApy(): Promise<ProtocolApy[]> {
  try {
    // Fetch both pools in one call via DeFiLlama
    const ids = [DEFILLAMA_POOL_IDS["kamino-usdc"], DEFILLAMA_POOL_IDS["kamino-sol"]];
    const responses = await Promise.all(
      ids.map(id => axios.get(`https://yields.llama.fi/chart/${id}`, { timeout: 8000 }))
    );
    const results: ProtocolApy[] = [];
    const labels: Array<{ protocolId: "kamino-usdc" | "kamino-sol"; asset: string; tvl: number }> = [
      { protocolId: "kamino-usdc", asset: "USDC", tvl: 19_320_000 },
      { protocolId: "kamino-sol",  asset: "SOL",  tvl: 280_000_000 },
    ];
    for (let i = 0; i < responses.length; i++) {
      const history: any[] = responses[i].data?.data ?? [];
      if (!history.length) continue;
      const latest = history[history.length - 1];
      const apyPercent = sanitizeApy(parseFloat(latest.apy ?? "0"), labels[i].protocolId);
      if (apyPercent > 0) results.push({
        protocolId: labels[i].protocolId,
        name: "Kamino", asset: labels[i].asset,
        apyBps: Math.round(apyPercent * 100), apyPercent,
        tvlUsd: latest.tvlUsd ?? labels[i].tvl,
        riskScore: 1, fetchedAt: new Date(),
      });
    }
    logger.debug("Kamino APYs fetched via DeFiLlama", { count: results.length });
    return results.length ? results : getFallbackApys(["kamino-usdc", "kamino-sol"]);
  } catch (err: any) {
    logger.warn("Failed to fetch Kamino APY", { error: err.message });
    return getFallbackApys(["kamino-usdc", "kamino-sol"]);
  }
}

async function fetchMarinadeApy(): Promise<ProtocolApy[]> {
  try {
    // 30d window: 1d is too noisy and can land on a near-zero price-change snapshot
    const { data } = await axios.get(
      `${process.env.MARINADE_API_URL || "https://api.marinade.finance"}/msol/apy/30d`,
      { timeout: 8000 }
    );
    const apyPercent = sanitizeApy(parseFloat(data?.value || data?.apy || "0") * 100, "marinade-sol");
    if (!apyPercent || apyPercent < 0.5) return getFallbackApys(["marinade-sol"]);
    return [{ protocolId: "marinade-sol", name: "Marinade", asset: "SOL", apyBps: Math.round(apyPercent * 100), apyPercent, tvlUsd: data?.tvl_usd || 1_230_000_000, riskScore: 1, fetchedAt: new Date() }];
  } catch (err: any) {
    logger.warn("Failed to fetch Marinade APY", { error: err.message });
    return getFallbackApys(["marinade-sol"]);
  }
}

async function fetchJitoApy(): Promise<ProtocolApy[]> {
  try {
    // MEV rewards endpoint — compute annualized APY from mev_reward_per_lamport
    // epochs_per_year ≈ 182.5 (2 epochs/day * 365)
    const { data } = await axios.get(
      "https://kobe.mainnet.jito.network/api/v1/mev_rewards",
      { timeout: 8000 }
    );
    const mevPerLamport: number = data?.mev_reward_per_lamport ?? 0;
    // Base staking yield ~6.5% APY; MEV adds on top
    const BASE_STAKING_APY = 6.5;
    const EPOCHS_PER_YEAR = 182.5;
    const mevApy = mevPerLamport * EPOCHS_PER_YEAR * 100;
    const apyPercent = sanitizeApy(BASE_STAKING_APY + mevApy, "jito-sol");
    if (!apyPercent) return getFallbackApys(["jito-sol"]);
    return [{ protocolId: "jito-sol", name: "Jito", asset: "SOL", apyBps: Math.round(apyPercent * 100), apyPercent, tvlUsd: 2_100_000_000, riskScore: 1, fetchedAt: new Date() }];
  } catch (err: any) {
    logger.warn("Failed to fetch Jito APY", { error: err.message });
    return getFallbackApys(["jito-sol"]);
  }
}

async function fetchMarginFiApy(): Promise<ProtocolApy[]> {
  // MarginFi has no public REST endpoint for APYs — compute from on-chain bank state.
  // Interest rate = utilization * slope + base. We decode the bank account directly.
  // Bank: 2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB (USDC, main group)
  // Layout offsets (from MarginFi v2 source):
  //   totalAssetShares at 328 (u128 as 16 bytes, but we use as f64)
  //   totalLiabilityShares at 344
  //   depositShareValue at 360 (f64 little-endian)
  //   borrowShareValue at 368 (f64 little-endian)
  //   optimalUtilizationRate at 448 (f64)
  //   plateauInterestRate at 456 (f64)
  //   maxInterestRate at 464 (f64)
  //
  // APY ≈ plateau_rate * utilization (simplified; accurate within ~5% of true rate)
  try {
    const { data } = await axios.post(
      "https://api.mainnet-beta.solana.com",
      { jsonrpc: "2.0", id: 1, method: "getAccountInfo",
        params: ["2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB", { encoding: "base64" }] },
      { headers: { "Content-Type": "application/json" }, timeout: 8000 }
    );
    const raw = Buffer.from(data?.result?.value?.data?.[0] ?? "", "base64");
    if (raw.length < 480) throw new Error("bank account too small");

    // Read utilization: totalLiabilityShares / totalAssetShares (both as u128 LE)
    const assetLow  = raw.readBigUInt64LE(328);
    const assetHigh = raw.readBigUInt64LE(336);
    const liabLow   = raw.readBigUInt64LE(344);
    const liabHigh  = raw.readBigUInt64LE(352);
    const assets = Number(assetLow) + Number(assetHigh) * 2**64;
    const liabs  = Number(liabLow)  + Number(liabHigh)  * 2**64;
    const utilization = assets > 0 ? Math.min(liabs / assets, 1) : 0;

    const plateauRate = raw.readDoubleLE(456); // optimal interest rate
    const optimalUtil = raw.readDoubleLE(448);
    // If utilization < optimal: rate = plateauRate * (utilization / optimalUtil)
    // If utilization >= optimal: rate is above plateau (less common for USDC)
    const depositRate = utilization <= optimalUtil
      ? plateauRate * (utilization / Math.max(optimalUtil, 0.001))
      : plateauRate;

    const apyPercent = sanitizeApy(depositRate * 100, "marginfi-usdc");
    if (!apyPercent) return getFallbackApys(["marginfi-usdc"]);
    return [{ protocolId: "marginfi-usdc", name: "MarginFi", asset: "USDC", apyBps: Math.round(apyPercent * 100), apyPercent, tvlUsd: 380_000_000, riskScore: 1, fetchedAt: new Date() }];
  } catch (err: any) {
    logger.warn("Failed to fetch MarginFi APY", { error: err.message });
    return getFallbackApys(["marginfi-usdc"]);
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
