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
  /**
   * True when we could NOT obtain a live rate for this protocol. There is deliberately
   * no hardcoded fallback value any more — a stale entry carries apyPercent 0 and this
   * flag, so it is impossible to mistake for a measurement.
   *
   * computeRebalanceDecision ABSTAINS from rebalancing when ANY registered protocol is
   * stale (PR #105). That is what makes "no live rate" safe: the keeper holds its current
   * allocation instead of routing on a number it cannot trust.
   */
  stale?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE APY — FIRST-PARTY SOURCES ONLY. NO THIRD-PARTY AGGREGATOR.
// ─────────────────────────────────────────────────────────────────────────────
// These are the SAME sources as app/src/app/api/apys/route.ts, deliberately — the site
// and the router must never advertise one rate and optimize on another.
//
// WHY DEFILLAMA IS GONE (2026-07-18). It is a third-party aggregator and it glitched:
// it reported kamino-usdc at 10.75% for one sample (with pool TVL simultaneously
// "dropping" $22M -> $4M) while Kamino's own API said 3.45% and the vault's realized
// on-chain appreciation was 3.76%. That number reached the deposit button. It is the same
// failure family as Solend's fabricated 5.10% and Jito's hardcoded 6.5% base: a number
// that is wrong but looks live. Read from the protocol that actually pays the rate.
//
// AND NO HARDCODED FALLBACKS. The old FALLBACK_APYS table was hand-typed and could not
// track reality; a stale guess was indistinguishable from a live rate, which is exactly
// how the Solend incident routed 80% of the USDC vault into the worst venue. If a source
// is down we emit stale:true and the rebalancer holds position.

const KAMINO_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const KAMINO_RESERVE: Record<string, string> = {
  "kamino-usdc": "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59",
  "kamino-sol":  "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q",
};
const SOLEND_USDC_RESERVE = "BgxfHJDzm44T7XG68MYKx7YisTjZu73tVovyZSjJMpmw";
// SPL stake pools we read directly. Adding another LST is one entry here plus one line
// in META and one in rebalancer.ts's SAFE_PROTOCOLS — no new fetch logic, because every
// standard SPL stake pool exposes yield the same way (exchange-rate growth per epoch).
// Both verified on-chain 2026-07-21 to be owned by the standard SPL Stake Pool program
// (SPoo1Ku8...), which is what makes one reader work for all of them.
const SPL_STAKE_POOLS: Record<string, string> = {
  "jito-sol": "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb",
  "psol-sol": "pSPcvR8GmG9aKDUbn9nbKYjkxt9hxMS7kF1qqKJaPqJ", // Phantom Staked SOL
};

/** Static display metadata only — never a rate. */
const META: Record<string, { name: string; asset: string; riskScore: number; tvlUsd: number }> = {
  "kamino-usdc":  { name: "Kamino",   asset: "USDC", riskScore: 1, tvlUsd:  23_525_228 },
  "kamino-sol":   { name: "Kamino",   asset: "SOL",  riskScore: 1, tvlUsd:  17_698_922 },
  "marinade-sol": { name: "Marinade", asset: "SOL",  riskScore: 1, tvlUsd: 181_896_238 },
  "solend-usdc":  { name: "Solend",   asset: "USDC", riskScore: 1, tvlUsd:   7_143_891 },
  "jito-sol":     { name: "Jito",     asset: "SOL",  riskScore: 1, tvlUsd: 762_417_675 },
  // Phantom Staked SOL. Identity verified on-chain: pool mint pSo1f9nQ… resolves to
  // "Phantom Staked SOL" with metadata served from assets.phantom.app.
  "psol-sol":     { name: "Phantom",  asset: "SOL",  riskScore: 1, tvlUsd: 125_000_000 },
};

// A rate is only believable inside this band. Outside it we treat the source as broken
// rather than routing on it — guards against a hijacked endpoint feeding inflated numbers.
const MIN_SANE_APY_PERCENT = 0.05;
const MAX_SANE_APY_PERCENT = 25;
const sane = (v: number | undefined | null): v is number =>
  typeof v === "number" && isFinite(v) && v >= MIN_SANE_APY_PERCENT && v <= MAX_SANE_APY_PERCENT;

const TIMEOUT = 8000;

/** Kamino — one call returns every reserve, so both our pools come from a single request. */
async function fetchKamino(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const { data } = await axios.get(
      `https://api.kamino.finance/kamino-market/${KAMINO_MARKET}/reserves/metrics`,
      { timeout: TIMEOUT }
    );
    if (!Array.isArray(data)) return out;
    for (const [protocolId, reserve] of Object.entries(KAMINO_RESERVE)) {
      const r = data.find((x: any) => x?.reserve === reserve);
      const apy = parseFloat(r?.supplyApy) * 100;
      if (sane(apy)) out[protocolId] = apy;
      else logger.warn(`kamino: ${protocolId} supplyApy out of band`, { raw: r?.supplyApy });
    }
  } catch (err: any) {
    logger.warn("Kamino APY fetch failed", { error: err.message });
  }
  return out;
}

/** Marinade — first-party realized mSOL yield (rewards land per epoch, so an LST rate is
 *  inherently a recent realized figure; 7d is Marinade's own window, not our smoothing). */
async function fetchMarinade(): Promise<number | null> {
  try {
    const { data } = await axios.get("https://api.marinade.finance/msol/apy/7d", { timeout: TIMEOUT });
    const apy = parseFloat(data?.value) * 100;
    return sane(apy) ? apy : null;
  } catch (err: any) {
    logger.warn("Marinade APY fetch failed", { error: err.message });
    return null;
  }
}

/** Solend/Save — first-party reserve stats; supplyInterest is already a percent. */
async function fetchSolend(): Promise<number | null> {
  try {
    const { data } = await axios.get(
      `https://api.solend.fi/v1/reserves/?ids=${SOLEND_USDC_RESERVE}`, { timeout: TIMEOUT }
    );
    const apy = parseFloat(data?.results?.[0]?.rates?.supplyInterest);
    return sane(apy) ? apy : null;
  } catch (err: any) {
    logger.warn("Solend APY fetch failed", { error: err.message });
    return null;
  }
}

/** Jito — ON-CHAIN. jitoSOL's total yield (staking + MEV) is exactly the growth of the
 *  pool's SOL-per-jitoSOL exchange rate, so we read the stake pool account rather than
 *  trusting an API. kobe publishes only the MEV slice, which is why the previous fetcher
 *  added a hardcoded 6.5% "base" and produced a number that was ~98% invented.
 *
 *  CURRENT fields are at FIXED, VERIFIED offsets: reserveStake@130 / managerFeeAccount@194
 *  are proven correct (the live jitoSOL deploy+recall CPIs use them), which pins the SPL
 *  StakePool layout and puts total_lamports@258 / pool_token_supply@266.
 *
 *  The LAST-EPOCH pair is NOT at a fixed offset and must not be hardcoded. Between it and
 *  the header sit variable-length fields (`FutureEpoch<Fee>` enums, `Option<Pubkey>`), so
 *  the position shifts — e.g. if Jito ever schedules a fee change, a hardcoded offset moves
 *  by 16 bytes and silently reads the wrong thing.
 *
 *  This bit me for real (2026-07-18): a hardcoded 418/426 was off by ONE byte, so every
 *  value came back exactly 256x too large. The ratio survived the shift, so the APY still
 *  looked like a correct 5.43% and passed a ratio-only sanity check — a textbook
 *  plausible-but-wrong read. Verified offsets are 419/427 TODAY.
 *
 *  So instead of trusting any offset we LOCATE the pair and validate it on magnitude, not
 *  just ratio: one epoch ago the pool's supply and lamports must both be within a few
 *  percent of today's, and the implied rate must be just below today's (an LST rate only
 *  ever grows). A 256x-shifted read fails the magnitude test instantly. We require exactly
 *  one candidate; zero or several means we cannot identify it, so we return null and the
 *  keeper holds position rather than routing on a guess. */
function findLastEpochRate(d: Buffer, supplyNow: number, lamportsNow: number, rateNow: number): number | null {
  const matches: number[] = [];
  for (let o = 282; o + 16 <= d.length; o++) {
    const supply = Number(d.readBigUInt64LE(o));
    const lamports = Number(d.readBigUInt64LE(o + 8));
    if (!isFinite(supply) || !isFinite(lamports) || supply <= 0) continue;
    const magSupply = supply / supplyNow;
    const magLamports = lamports / lamportsNow;
    // One epoch of growth is ~0.03%, so last epoch is just under today. Allow a wide-ish
    // band for safety but tight enough that a byte-shifted (256x) read can never pass.
    if (magSupply < 0.90 || magSupply > 1.02) continue;
    if (magLamports < 0.90 || magLamports > 1.02) continue;
    const rate = lamports / supply;
    if (!(rate > 1.0 && rate < rateNow)) continue;
    matches.push(rate);
  }
  return matches.length === 1 ? matches[0] : null;
}

/** Reads any standard SPL stake pool. Was fetchJito(); generalised 2026-07-21 when PSOL
 *  was added, since the mechanism is identical for every pool on the standard program. */
/** Epochs per year, measured. slotsInEpoch from the cluster, slot time from recent
 *  performance samples — both first-party RPC, no assumed constants. */
async function epochsPerYear(rpc: string): Promise<number> {
  try {
    const call = async (method: string, params: any[] = []) =>
      (await axios.post(rpc, { jsonrpc: "2.0", id: 1, method, params }, { timeout: TIMEOUT })).data?.result;
    const [info, samples] = await Promise.all([call("getEpochInfo"), call("getRecentPerformanceSamples", [30])]);
    const slots = Number(info?.slotsInEpoch);
    const arr: any[] = Array.isArray(samples) ? samples : [];
    if (!slots || !arr.length) return 174.8;
    const slotSec = arr.reduce((a, p) => a + p.samplePeriodSecs / p.numSlots, 0) / arr.length;
    const perYear = 31_557_600 / (slots * slotSec);
    // Sanity: Solana epochs are ~2-3 days. Outside that, the probe is wrong, not the chain.
    return perYear > 100 && perYear < 250 ? perYear : 174.8;
  } catch { return 174.8; }
}

async function fetchSplStakePool(protocolId: string, pool: string): Promise<number | null> {
  try {
    const rpc = process.env.RPC_URL;
    if (!rpc) { logger.warn(`${protocolId} APY: RPC_URL unset`); return null; }
    const { data } = await axios.post(rpc, {
      jsonrpc: "2.0", id: 1, method: "getAccountInfo",
      params: [pool, { encoding: "base64", commitment: "confirmed" }],
    }, { timeout: TIMEOUT });

    const b64 = data?.result?.value?.data?.[0];
    if (!b64) return null;
    const d = Buffer.from(b64, "base64");
    if (d.length < 300) return null;

    const lamportsNow = Number(d.readBigUInt64LE(258));
    const supplyNow   = Number(d.readBigUInt64LE(266));
    const rateNow = lamportsNow / supplyNow;
    // An LST rate is ~1.0-1.6. Anything else means the verified header offsets moved.
    if (!isFinite(rateNow) || rateNow < 1.0 || rateNow > 1.6) return null;

    const rateLast = findLastEpochRate(d, supplyNow, lamportsNow, rateNow);
    if (rateLast === null) {
      logger.warn(`${protocolId} APY: could not uniquely identify last-epoch fields — holding`);
      return null;
    }

    // 182.5 assumed exactly 400ms slots (432000 slots = 2.000 days). Real slot time runs
    // ~418ms, so an epoch is ~2.09 days and there are ~175 per year — the old constant
    // overstated every stake-pool APY by ~4%. Same for all pools, so it never changed a
    // ranking, but it is a number users see. Derived, not re-hardcoded, so it tracks any
    // future change in slot time; falls back to the measured figure if the probe fails.
    const EPOCHS_PER_YEAR = await epochsPerYear(rpc);
    const apy = (Math.pow(rateNow / rateLast, EPOCHS_PER_YEAR) - 1) * 100;
    return sane(apy) ? apy : null;
  } catch (err: any) {
    logger.warn(`${protocolId} APY fetch failed`, { error: err.message });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchAllApys(): Promise<ProtocolApy[]> {
  logger.info("Fetching APYs from first-party sources...");

  const [kamino, marinade, solend, jito, psol] = await Promise.all([
    fetchKamino(), fetchMarinade(), fetchSolend(),
    fetchSplStakePool("jito-sol", SPL_STAKE_POOLS["jito-sol"]),
    fetchSplStakePool("psol-sol", SPL_STAKE_POOLS["psol-sol"]),
  ]);

  const live: Record<string, number | null> = {
    "kamino-usdc":  kamino["kamino-usdc"] ?? null,
    "kamino-sol":   kamino["kamino-sol"] ?? null,
    "marinade-sol": marinade,
    "solend-usdc":  solend,
    "jito-sol":     jito,
    "psol-sol":     psol,
  };

  const now = new Date();
  const apys: ProtocolApy[] = Object.entries(META).map(([protocolId, m]) => {
    const v = live[protocolId];
    // No hardcoded fallback: a missing rate is reported as stale with 0, never invented.
    return {
      protocolId,
      name: m.name,
      asset: m.asset,
      apyPercent: v ?? 0,
      apyBps: v ? Math.round(v * 100) : 0,
      tvlUsd: m.tvlUsd,
      riskScore: m.riskScore,
      fetchedAt: now,
      ...(v == null ? { stale: true } : {}),
    };
  });

  const staleIds = apys.filter(a => a.stale).map(a => a.protocolId);
  if (staleIds.length) {
    logger.warn("No live APY for some protocols — rebalancing will be held", { stale: staleIds });
  }

  logger.info("APY fetch complete", {
    protocols: apys.map(a => `${a.name}(${a.asset}): ${a.stale ? "— (no live rate)" : a.apyPercent.toFixed(2) + "%"}`),
  });

  return apys;
}

// Find best APY for a given asset (optionally cap risk score).
// Stale entries are excluded outright so they can never win this comparison.
export function bestApyForAsset(
  apys: ProtocolApy[],
  asset: string,
  maxRisk: number = 3
): ProtocolApy | undefined {
  return apys
    .filter(a => a.asset === asset && a.riskScore <= maxRisk && !a.stale)
    .sort((a, b) => b.apyBps - a.apyBps)[0];
}
