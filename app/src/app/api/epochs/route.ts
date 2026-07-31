import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// ─────────────────────────────────────────────────────────────────────────────
// EPOCHS — live per-protocol epoch status, FIRST-PARTY / ON-CHAIN ONLY.
// ─────────────────────────────────────────────────────────────────────────────
// Only liquid-staking protocols (Jito, PSOL, Marinade) are epoch-gated: their
// exchange rate is driven by native Solana staking rewards, which land once per
// epoch. Lending markets (Kamino, Solend) accrue every slot and have no epoch
// concept — they are intentionally NOT listed here.
//
// currentEpoch / slotsInEpoch / slotIndex come straight from getEpochInfo(). Epoch
// length in real time is derived from a LIVE slot-time sample (getRecentPerformanceSamples),
// not a hardcoded constant — mainnet slot times drift (verified 2026-07-30: ~0.4225s/slot,
// not the "~2-3 days/epoch" rule of thumb some docs use).
//
// lastUpdateEpoch for Jito/PSOL is read directly from the SPL Stake Pool account's own
// bytes at offset 274 (a u64 LE) — verified live against getEpochInfo().epoch on both
// pools (both read 1009, matching network epoch 1009, 2026-07-30). If it differs from
// currentEpoch, the pool's exchange rate is one or more epochs stale.
//
// Marinade has no equivalent verified on-chain field wired up here — it uses their own
// API's "value" only, with no last-update-epoch decode. Flagged as `epochVerified: false`
// so the frontend does not claim a certainty we don't have.

const RPC_URL = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
const JITO_POOL = "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb";
const PSOL_POOL = "pSPcvR8GmG9aKDUbn9nbKYjkxt9hxMS7kF1qqKJaPqJ";

const META: Record<string, { name: string; asset: string; color: string }> = {
  "jito-sol":     { name: "Jito",     asset: "SOL", color: "#10B981" },
  "psol-sol":     { name: "PSOL",     asset: "SOL", color: "#8B5CF6" },
  "marinade-sol": { name: "Marinade", asset: "SOL", color: "#06B6D4" },
};

async function rpc(method: string, params: any[] = []): Promise<any> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    next: { revalidate: 60 },
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function getNetworkEpoch() {
  const [epochInfo, perfSamples] = await Promise.all([
    rpc("getEpochInfo"),
    rpc("getRecentPerformanceSamples", [1]),
  ]);
  const sample = perfSamples?.[0];
  const secsPerSlot = sample && sample.numSlots > 0
    ? sample.samplePeriodSecs / sample.numSlots
    : 0.4225; // fallback: last known-good live measurement (2026-07-30)
  const epochLengthSecs = epochInfo.slotsInEpoch * secsPerSlot;
  const secsRemaining = (epochInfo.slotsInEpoch - epochInfo.slotIndex) * secsPerSlot;
  return {
    epoch: epochInfo.epoch as number,
    slotIndex: epochInfo.slotIndex as number,
    slotsInEpoch: epochInfo.slotsInEpoch as number,
    progressPct: (epochInfo.slotIndex / epochInfo.slotsInEpoch) * 100,
    epochLengthDays: epochLengthSecs / 86_400,
    estSecondsToNextEpoch: Math.round(secsRemaining),
  };
}

const MIN_SANE_APY = 0.05;
const MAX_SANE_APY = 25;
const sane = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= MIN_SANE_APY && v <= MAX_SANE_APY;

/** Mirrors api/apys/route.ts's findLastEpochRate exactly — locates the one-epoch-ago
 *  (supply, lamports) pair by magnitude (must be within a few percent of today's, and
 *  imply a rate just below today's, since an LST rate only grows) rather than trusting
 *  a hardcoded offset, which has previously been off-by-one-byte and silently produced a
 *  256x-wrong-but-plausible-looking rate. Exactly one candidate is required. */
function findLastEpochRate(d: Buffer, supplyNow: number, lamportsNow: number, rateNow: number): number | null {
  const matches: number[] = [];
  for (let o = 282; o + 16 <= d.length; o++) {
    const supply = Number(d.readBigUInt64LE(o));
    const lamports = Number(d.readBigUInt64LE(o + 8));
    if (!Number.isFinite(supply) || !Number.isFinite(lamports) || supply <= 0) continue;
    const magSupply = supply / supplyNow;
    const magLamports = lamports / lamportsNow;
    if (magSupply < 0.90 || magSupply > 1.02) continue;
    if (magLamports < 0.90 || magLamports > 1.02) continue;
    const rate = lamports / supply;
    if (!(rate > 1.0 && rate < rateNow)) continue;
    matches.push(rate);
  }
  return matches.length === 1 ? matches[0] : null;
}

/** Same SPL Stake Pool account layout as api/apys/route.ts's fetchStakePool, plus the
 *  last-update-epoch field at offset 274 that page doesn't need. */
async function fetchStakePoolEpochStatus(poolAddress: string): Promise<{
  lastUpdateEpoch: number; rateNow: number; apyPercent: number | null;
} | null> {
  try {
    const result = await rpc("getAccountInfo", [poolAddress, { encoding: "base64", commitment: "confirmed" }]);
    const b64 = result?.value?.data?.[0];
    if (!b64) return null;
    const d = Buffer.from(b64, "base64");
    if (d.length < 282) return null;

    const lamportsNow = Number(d.readBigUInt64LE(258));
    const supplyNow = Number(d.readBigUInt64LE(266));
    const lastUpdateEpoch = Number(d.readBigUInt64LE(274));
    const rateNow = lamportsNow / supplyNow;
    if (!Number.isFinite(rateNow) || rateNow < 1.0 || rateNow > 1.6) return null;
    if (!Number.isFinite(lastUpdateEpoch) || lastUpdateEpoch <= 0) return null;

    const rateLast = findLastEpochRate(d, supplyNow, lamportsNow, rateNow);
    const EPOCHS_PER_YEAR = 182.5; // ~2 epochs/day
    const apy = rateLast !== null ? (Math.pow(rateNow / rateLast, EPOCHS_PER_YEAR) - 1) * 100 : null;

    return { lastUpdateEpoch, rateNow, apyPercent: sane(apy) ? apy : null };
  } catch { return null; }
}

async function fetchMarinadeRate(): Promise<number | null> {
  try {
    const res = await fetch("https://api.marinade.finance/msol/apy/7d", { next: { revalidate: 60 } });
    const j = await res.json();
    const apy = parseFloat(j?.value) * 100;
    return Number.isFinite(apy) ? apy : null;
  } catch { return null; }
}

export async function GET(_req: NextRequest) {
  const [network, jito, psol, marinadeApy] = await Promise.all([
    getNetworkEpoch(),
    fetchStakePoolEpochStatus(JITO_POOL),
    fetchStakePoolEpochStatus(PSOL_POOL),
    fetchMarinadeRate(),
  ]);

  const protocols = [
    {
      protocolId: "jito-sol",
      ...META["jito-sol"],
      lastUpdateEpoch: jito?.lastUpdateEpoch ?? null,
      epochsBehind: jito ? network.epoch - jito.lastUpdateEpoch : null,
      isStale: jito ? jito.lastUpdateEpoch < network.epoch : null,
      epochVerified: jito !== null,
      apyPercent: jito?.apyPercent ?? null,
    },
    {
      protocolId: "psol-sol",
      ...META["psol-sol"],
      lastUpdateEpoch: psol?.lastUpdateEpoch ?? null,
      epochsBehind: psol ? network.epoch - psol.lastUpdateEpoch : null,
      isStale: psol ? psol.lastUpdateEpoch < network.epoch : null,
      epochVerified: psol !== null,
      apyPercent: psol?.apyPercent ?? null,
    },
    {
      protocolId: "marinade-sol",
      ...META["marinade-sol"],
      // No verified on-chain last-update-epoch decode for Marinade's account layout yet —
      // report what we have (their own API's rate) without claiming epoch-level certainty.
      lastUpdateEpoch: null,
      epochsBehind: null,
      isStale: null,
      epochVerified: false,
      apyPercent: marinadeApy,
    },
  ];

  return NextResponse.json(
    { network, protocols },
    { headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" } }
  );
}
