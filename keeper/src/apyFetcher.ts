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
// ─────────────────────────────────────────────────────────────────────────────

async function fetchKaminoApy(): Promise<ProtocolApy[]> {
  try {
    // Kamino's public API returns market data including supply APY per reserve
    const { data } = await axios.get(
      `${process.env.KAMINO_API_URL || "https://api.kamino.finance"}/markets`,
      { timeout: 8000 }
    );

    const results: ProtocolApy[] = [];

    // Parse USDC reserve
    const usdcReserve = data?.markets
      ?.flatMap((m: any) => m.reserves || [])
      .find((r: any) => r.symbol === "USDC" || r.mintAddress === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

    if (usdcReserve) {
      const apy = parseFloat(usdcReserve.supplyInterestAPY || usdcReserve.supplyApy || "0") * 100;
      results.push({
        protocolId: "kamino-usdc",
        name: "Kamino",
        asset: "USDC",
        apyBps: Math.round(apy * 100),
        apyPercent: apy,
        tvlUsd: parseFloat(usdcReserve.totalSupplyUsd || "0"),
        riskScore: 1,
        fetchedAt: new Date(),
      });
    }

    // Parse SOL reserve
    const solReserve = data?.markets
      ?.flatMap((m: any) => m.reserves || [])
      .find((r: any) => r.symbol === "SOL");

    if (solReserve) {
      const apy = parseFloat(solReserve.supplyInterestAPY || solReserve.supplyApy || "0") * 100;
      results.push({
        protocolId: "kamino-sol",
        name: "Kamino",
        asset: "SOL",
        apyBps: Math.round(apy * 100),
        apyPercent: apy,
        tvlUsd: parseFloat(solReserve.totalSupplyUsd || "0"),
        riskScore: 1,
        fetchedAt: new Date(),
      });
    }

    logger.debug("Kamino APYs fetched", { count: results.length });
    return results;
  } catch (err: any) {
    logger.warn("Failed to fetch Kamino APY, using fallback", { error: err.message });
    return getFallbackApys(["kamino-usdc", "kamino-sol"]);
  }
}

async function fetchMarinadeApy(): Promise<ProtocolApy[]> {
  try {
    // Marinade public stats endpoint
    const { data } = await axios.get(
      `${process.env.MARINADE_API_URL || "https://api.marinade.finance"}/msol/apy/1d`,
      { timeout: 8000 }
    );

    const apyPercent = parseFloat(data?.value || data?.apy || "0") * 100;

    return [{
      protocolId: "marinade-sol",
      name: "Marinade",
      asset: "SOL",
      apyBps: Math.round(apyPercent * 100),
      apyPercent,
      tvlUsd: data?.tvl_usd || 1_230_000_000,
      riskScore: 1,
      fetchedAt: new Date(),
    }];
  } catch (err: any) {
    logger.warn("Failed to fetch Marinade APY, using fallback", { error: err.message });
    return getFallbackApys(["marinade-sol"]);
  }
}

async function fetchRaydiumApy(): Promise<ProtocolApy[]> {
  try {
    // Raydium pools API
    const { data } = await axios.get(
      "https://api.raydium.io/v2/ammV3/ammPools",
      { timeout: 8000 }
    );

    const pools = data?.data || [];

    // Find USDC-SOL pool (highest liquidity)
    const usdcSolPool = pools
      .filter((p: any) =>
        p.mintA?.symbol === "USDC" && p.mintB?.symbol === "SOL" ||
        p.mintA?.symbol === "SOL" && p.mintB?.symbol === "USDC"
      )
      .sort((a: any, b: any) => (b.tvl || 0) - (a.tvl || 0))[0];

    if (!usdcSolPool) return getFallbackApys(["raydium-usdc-sol"]);

    const apyPercent = parseFloat(usdcSolPool.day?.apr || usdcSolPool.apr || "0") * 100;

    return [{
      protocolId: "raydium-usdc-sol",
      name: "Raydium",
      asset: "USDC-SOL",
      apyBps: Math.round(apyPercent * 100),
      apyPercent,
      tvlUsd: parseFloat(usdcSolPool.tvl || "0"),
      riskScore: 3, // LP = IL risk
      fetchedAt: new Date(),
    }];
  } catch (err: any) {
    logger.warn("Failed to fetch Raydium APY, using fallback", { error: err.message });
    return getFallbackApys(["raydium-usdc-sol"]);
  }
}

async function fetchDriftApy(): Promise<ProtocolApy[]> {
  try {
    const { data } = await axios.get(
      "https://dlob.drift.trade/stats/apys",
      { timeout: 8000 }
    );

    const solMarket = data?.find?.((m: any) =>
      m.marketSymbol === "SOL" || m.symbol === "SOL"
    );

    const apyPercent = parseFloat(solMarket?.depositApy || solMarket?.lendApy || "0");

    return [{
      protocolId: "drift-sol",
      name: "Drift",
      asset: "SOL",
      apyBps: Math.round(apyPercent * 100),
      apyPercent,
      tvlUsd: solMarket?.tvl || 220_000_000,
      riskScore: 1,
      fetchedAt: new Date(),
    }];
  } catch (err: any) {
    logger.warn("Failed to fetch Drift APY, using fallback", { error: err.message });
    return getFallbackApys(["drift-sol"]);
  }
}

async function fetchOrcaApy(): Promise<ProtocolApy[]> {
  try {
    const { data } = await axios.get(
      "https://api.orca.so/v2/solana/whirlpools",
      { timeout: 8000 }
    );

    const pools = data?.whirlpools || data || [];
    const usdcEthPool = pools
      .filter((p: any) =>
        (p.tokenA?.symbol === "USDC" && p.tokenB?.symbol === "ETH") ||
        (p.tokenA?.symbol === "ETH" && p.tokenB?.symbol === "USDC")
      )
      .sort((a: any, b: any) => (b.tvl || 0) - (a.tvl || 0))[0];

    if (!usdcEthPool) return getFallbackApys(["orca-usdc-eth"]);

    const apyPercent = parseFloat(usdcEthPool.apy || usdcEthPool.feeApr || "0") * 100;

    return [{
      protocolId: "orca-usdc-eth",
      name: "Orca",
      asset: "USDC-ETH",
      apyBps: Math.round(apyPercent * 100),
      apyPercent,
      tvlUsd: parseFloat(usdcEthPool.tvl || "0"),
      riskScore: 2,
      fetchedAt: new Date(),
    }];
  } catch (err: any) {
    logger.warn("Failed to fetch Orca APY, using fallback", { error: err.message });
    return getFallbackApys(["orca-usdc-eth"]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fallback APYs (used if API is down — based on recent historical averages)
// ─────────────────────────────────────────────────────────────────────────────

// Raydium and Orca are intentionally excluded — LP positions carry impermanent
// loss risk and are incompatible with principal-preserving yield vaults.
// Marinade is included but the rebalancer accounts for its ~0.3% liquid unstake
// exit cost before deciding to route out of it.
const FALLBACK_APYS: Record<string, Omit<ProtocolApy, "fetchedAt">> = {
  "kamino-usdc": { protocolId: "kamino-usdc", name: "Kamino",   asset: "USDC", apyBps: 842, apyPercent: 8.42, tvlUsd: 412_000_000, riskScore: 1 },
  "kamino-sol":  { protocolId: "kamino-sol",  name: "Kamino",   asset: "SOL",  apyBps: 620, apyPercent: 6.20, tvlUsd: 280_000_000, riskScore: 1 },
  "marinade-sol":{ protocolId: "marinade-sol",name: "Marinade", asset: "SOL",  apyBps: 721, apyPercent: 7.21, tvlUsd: 1_230_000_000, riskScore: 1 },
  "drift-sol":   { protocolId: "drift-sol",   name: "Drift",    asset: "SOL",  apyBps: 588, apyPercent: 5.88, tvlUsd: 220_000_000, riskScore: 1 },
  "solend-usdc": { protocolId: "solend-usdc", name: "Solend",   asset: "USDC", apyBps: 510, apyPercent: 5.10, tvlUsd: 95_000_000,  riskScore: 1 },
};

function getFallbackApys(ids: string[]): ProtocolApy[] {
  return ids.map(id => ({ ...FALLBACK_APYS[id], fetchedAt: new Date() })).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export: fetch all APYs in parallel
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchAllApys(): Promise<ProtocolApy[]> {
  logger.info("Fetching APYs from all protocols...");

  // Raydium and Orca excluded — LP impermanent loss risk
  const results = await Promise.allSettled([
    fetchKaminoApy(),
    fetchMarinadeApy(),
    fetchDriftApy(),
  ]);

  const apys: ProtocolApy[] = results.flatMap(r =>
    r.status === "fulfilled" ? r.value : []
  );

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
