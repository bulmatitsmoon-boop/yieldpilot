import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { Redis } from "@upstash/redis";

// ─────────────────────────────────────────────────────────────────────────────
// LIVE APY — FIRST-PARTY SOURCES ONLY. NO THIRD-PARTY AGGREGATOR.
// ─────────────────────────────────────────────────────────────────────────────
// Every rate here comes from the protocol that actually pays it: Kamino's own API,
// Marinade's own API, Solend's own API, and — for Jito — the stake pool account
// on-chain, because an LST's yield IS the growth of its exchange rate.
//
// WHY WE DROPPED DEFILLAMA (2026-07-18). We moved to DeFiLlama in July to escape
// rotted per-protocol endpoints, but it is a third-party aggregator and it glitches.
// It reported kamino-usdc at **10.75%** for a single sample — with pool TVL
// simultaneously "dropping" from $22M to $4M — while Kamino's own API said 3.45%
// and the vault's realized on-chain appreciation was 3.76%. That number reached the
// deposit button. Same failure family as Solend's fabricated 5.10% and Jito's
// hardcoded 6.5% base: a number that is wrong but looks live.
//
// THE RULE THAT MAKES THIS PERMANENT:
//   1. Read from the protocol itself — first-party or on-chain, never an aggregator.
//   2. Sanity-gate every value; reject rather than display something implausible.
//   3. On failure fall back ONLY to a real previously-observed value ("last known"),
//      flagged `stale: true`. NEVER to a hand-written constant. Hand-written
//      constants caused every prior incident, because a stale guess is
//      indistinguishable from a live rate.
//   4. If there is no live value AND no last-known, return no rate at all so the UI
//      renders "—". Silence beats a plausible lie.
//
// The keeper (keeper/src/apyFetcher.ts) reads these SAME first-party sources, so the
// site and the router cannot drift apart. And per PR #105 the keeper ABSTAINS from
// rebalancing whenever any rate is stale — so a stale rate can be displayed, but it
// can never move funds.

const KAMINO_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const KAMINO_RESERVE: Record<string, string> = {
  "kamino-usdc": "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59",
  "kamino-sol":  "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q",
};
const SOLEND_USDC_RESERVE = "BgxfHJDzm44T7XG68MYKx7YisTjZu73tVovyZSjJMpmw";
const JITO_POOL = "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb";

// Static display metadata only — never a rate.
const META = [
  { protocolId: "jito-sol",         name: "Jito",     asset: "SOL",      riskScore: 1, tvlUsd: 762_417_675 },
  { protocolId: "kamino-sol",       name: "Kamino",   asset: "SOL",      riskScore: 1, tvlUsd:  17_698_922 },
  { protocolId: "marinade-sol",     name: "Marinade", asset: "SOL",      riskScore: 1, tvlUsd: 181_896_238 },
  { protocolId: "kamino-usdc",      name: "Kamino",   asset: "USDC",     riskScore: 1, tvlUsd:  23_525_228 },
  { protocolId: "solend-usdc",      name: "Solend",   asset: "USDC",     riskScore: 1, tvlUsd:   7_143_891 },
  // LP pools. TVL is NOT hardcoded here — both fetchers return live TVL, and the
  // placeholder that used to sit here claimed $190M/$120M against a real ~$6M/~$26M.
  // Orca is the SOL/USDC Whirlpool we would actually route to (Czfq3xZZ…), not a
  // USDC-ETH pool we have no integration with.
  { protocolId: "raydium-usdc-sol", name: "Raydium",  asset: "USDC-SOL", riskScore: 3 },
  { protocolId: "orca-sol-usdc",    name: "Orca",     asset: "SOL-USDC", riskScore: 3 },
];

const COLORS: Record<string, string> = {
  "kamino-usdc": "#3FE0A0", "kamino-sol": "#22B37E", "jito-sol": "#10B981",
  "marinade-sol": "#06B6D4", "drift-sol": "#14B8A6", "solend-usdc": "#34D399",
  "raydium-usdc-sol": "#EF4444", "orca-sol-usdc": "#EF4444",
};

/**
 * A rate is only believable inside this band; outside it we treat the source as broken.
 *
 * The ceiling has to differ by protocol type. For LENDING, 25% is a good tripwire — a
 * pool that normally pays 3% suddenly reporting 40% is a broken feed, and that guard is
 * what has caught fake rates before.
 *
 * But concentrated-liquidity FEE APRs legitimately run far higher: measured live
 * 2026-07-21, Raydium SOL/USDC was 29.5% and Orca SOL/USDC ~34%. The single 25% ceiling
 * silently rejected both, so the LP rows rendered "—" while the fetchers were working
 * perfectly — the guard was throwing the right answers away.
 *
 * 300% for LP is still a real tripwire (a fee APR above that is a data error, not a
 * pool), just one set for the right instrument.
 */
const MIN_SANE_APY = 0.05;
const MAX_SANE_APY = 25;      // lending
const MAX_SANE_LP_APY = 300;  // concentrated-liquidity fee APR

const inBand = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= MIN_SANE_APY && v <= max;

const sane = (v: unknown): v is number => inBand(v, MAX_SANE_APY);
/** Use for LP pools only — see the note above on why the ceiling differs. */
const saneLp = (v: unknown): v is number => inBand(v, MAX_SANE_LP_APY);

async function tryFetch(url: string, timeout = 8000): Promise<any> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, next: { revalidate: 60 } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(id); }
}

type Live = { apyPercent: number; tvlUsd?: number };

/** Kamino — one call returns every reserve, so both our pools come from a single request. */
async function fetchKamino(): Promise<Record<string, Live>> {
  const out: Record<string, Live> = {};
  try {
    const arr = await tryFetch(`https://api.kamino.finance/kamino-market/${KAMINO_MARKET}/reserves/metrics`);
    if (!Array.isArray(arr)) return out;
    for (const [protocolId, reserve] of Object.entries(KAMINO_RESERVE)) {
      const r = arr.find((x: any) => x?.reserve === reserve);
      const apy = parseFloat(r?.supplyApy) * 100;
      if (sane(apy)) out[protocolId] = { apyPercent: apy, tvlUsd: Number(r?.totalSupply) || undefined };
    }
  } catch { /* leave empty — caller falls back to last-known */ }
  return out;
}

/** Marinade — first-party realized mSOL yield. An LST's rate is inherently a recent
 *  realized figure (rewards land per epoch); 7d is Marinade's own window, not our smoothing. */
async function fetchMarinade(): Promise<Live | null> {
  try {
    const j = await tryFetch("https://api.marinade.finance/msol/apy/7d");
    const apy = parseFloat(j?.value) * 100;
    return sane(apy) ? { apyPercent: apy } : null;
  } catch { return null; }
}

/** Solend/Save — first-party reserve stats; supplyInterest is already a percent. */
async function fetchSolend(): Promise<Live | null> {
  try {
    const j = await tryFetch(`https://api.solend.fi/v1/reserves/?ids=${SOLEND_USDC_RESERVE}`);
    const r = (j?.results || [])[0];
    const apy = parseFloat(r?.rates?.supplyInterest);
    return sane(apy) ? { apyPercent: apy } : null;
  } catch { return null; }
}

/** Jito — ON-CHAIN. jitoSOL's total yield (staking + MEV) is exactly the growth of the
 *  pool's SOL-per-jitoSOL exchange rate, so we read the stake pool account rather than
 *  trusting any API. kobe only publishes the MEV slice, which is why the old fetcher
 *  hardcoded a 6.5% "base" and got the total wrong.
 *
 *  CURRENT fields sit at FIXED, VERIFIED offsets: reserveStake@130 / managerFeeAccount@194
 *  are proven correct (the live jitoSOL deploy/recall CPIs use them), pinning the SPL
 *  StakePool layout so total_lamports@258 and pool_token_supply@266.
 *
 *  The LAST-EPOCH pair must NOT be hardcoded — variable-length fields (`FutureEpoch<Fee>`,
 *  `Option<Pubkey>`) sit in front of it, so its position moves (e.g. scheduling a fee
 *  change shifts it 16 bytes). A hardcoded 418/426 was off by ONE byte on 2026-07-18,
 *  making every value exactly 256x too large; the ratio survived the shift so the APY
 *  still looked like a correct 5.43% and passed a ratio-only check. Verified 419/427 today.
 *
 *  So we LOCATE the pair and validate on MAGNITUDE, not just ratio: one epoch ago the
 *  pool's supply and lamports must each be within a few percent of today's, and the implied
 *  rate must be just below today's (an LST rate only grows). A byte-shifted read fails the
 *  magnitude test immediately. Exactly one candidate is required; otherwise return null so
 *  the UI shows last-known/"—" rather than a guess. */
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

async function fetchJito(): Promise<Live | null> {
  try {
    const rpc = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "getAccountInfo",
        params: [JITO_POOL, { encoding: "base64", commitment: "confirmed" }],
      }),
      next: { revalidate: 60 },
    });
    const j = await res.json();
    const b64 = j?.result?.value?.data?.[0];
    if (!b64) return null;
    const d = Buffer.from(b64, "base64");
    if (d.length < 300) return null;

    const lamportsNow = Number(d.readBigUInt64LE(258));
    const supplyNow   = Number(d.readBigUInt64LE(266));
    const rateNow = lamportsNow / supplyNow;
    if (!Number.isFinite(rateNow) || rateNow < 1.0 || rateNow > 1.6) return null;

    const rateLast = findLastEpochRate(d, supplyNow, lamportsNow, rateNow);
    if (rateLast === null) return null;

    const EPOCHS_PER_YEAR = 182.5; // ~2 epochs/day
    const apy = (Math.pow(rateNow / rateLast, EPOCHS_PER_YEAR) - 1) * 100;
    return sane(apy) ? { apyPercent: apy } : null;
  } catch { return null; }
}

// Raydium CLMM SOL/USDC — the pool the LP adapter targets.
//
// The old v2 endpoint (api.raydium.io/v2/ammV3/ammPools) returned the ENTIRE pool list:
// 216 MB, ~16s. It timed out in the serverless function every time, which is why
// Raydium rendered "—" while looking like it had a working fetcher. v3 answers a
// targeted query in ~7 KB.
//
// `day.apr` is already a percentage (29.65 = 29.65%), NOT a fraction — the old code
// multiplied by 100 and would have shown 2965% had it ever returned.
const RAYDIUM_SOL_USDC_POOL = "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv";

async function fetchRaydium(): Promise<Live | null> {
  try {
    const data = await tryFetch(
      `https://api-v3.raydium.io/pools/info/ids?ids=${RAYDIUM_SOL_USDC_POOL}`
    );
    const pool = (data?.data || [])[0];
    if (!pool) return null;
    const apy = Number(pool.day?.apr);
    const tvl = Number(pool.tvl);
    return saneLp(apy) ? { apyPercent: apy, tvlUsd: Number.isFinite(tvl) ? tvl : undefined } : null;
  } catch { return null; }
}

// Orca Whirlpool SOL/USDC — the exact pool the LP adapter opens positions in.
//
// Orca publishes no APR field, so derive it from first-party numbers: 24h fees over TVL,
// annualised. stats["24h"].yieldOverTvl is a DAILY fraction (0.000937 = 0.0937%/day),
// so x365 gives ~34% APR. The v1 whirlpool/list endpoint is 18 MB — use the v2 token
// query (~170 KB) and pick our pool by address.
const ORCA_SOL_USDC_WHIRLPOOL = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";

async function fetchOrca(): Promise<Live | null> {
  try {
    const data = await tryFetch(
      "https://api.orca.so/v2/solana/pools?token=So11111111111111111111111111111111111111112"
    );
    const pool = (data?.data || []).find((p: any) => p.address === ORCA_SOL_USDC_WHIRLPOOL);
    if (!pool) return null;
    const daily = Number(pool.stats?.["24h"]?.yieldOverTvl ?? pool.yieldOverTvl);
    if (!Number.isFinite(daily)) return null;
    const apy = daily * 365 * 100;
    const tvl = Number(pool.tvlUsdc);
    return saneLp(apy) ? { apyPercent: apy, tvlUsd: Number.isFinite(tvl) ? tvl : undefined } : null;
  } catch { return null; }
}

// ── last-known store ────────────────────────────────────────────────────────
// Holds ONLY values we genuinely observed live, with the time we observed them.
// Never seeded with constants. Redis when configured (survives cold starts);
// module memory otherwise (better than nothing, lost on cold start).
type Known = { apyPercent: number; tvlUsd?: number; at: string };
const memCache = new Map<string, Known>();
const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const redis = redisUrl && redisToken ? new Redis({ url: redisUrl, token: redisToken }) : null;
const KEY = (id: string) => `apy:lastknown:${id}`;

async function readKnown(id: string): Promise<Known | null> {
  const m = memCache.get(id);
  if (m) return m;
  if (!redis) return null;
  try { return (await redis.get<Known>(KEY(id))) ?? null; } catch { return null; }
}
async function writeKnown(id: string, k: Known) {
  memCache.set(id, k);
  if (!redis) return;
  try { await redis.set(KEY(id), k); } catch { /* cache is best-effort */ }
}

export async function GET(_req: NextRequest) {
  const [kamino, marinade, solend, jito, raydium, orca] = await Promise.all([
    fetchKamino(), fetchMarinade(), fetchSolend(), fetchJito(), fetchRaydium(), fetchOrca(),
  ]);

  const live: Record<string, Live | null> = {
    "kamino-usdc":      kamino["kamino-usdc"] ?? null,
    "kamino-sol":       kamino["kamino-sol"] ?? null,
    "marinade-sol":     marinade,
    "solend-usdc":      solend,
    "jito-sol":         jito,
    "raydium-usdc-sol": raydium,
    "orca-sol-usdc":    orca,
  };

  const now = new Date().toISOString();
  const result = await Promise.all(META.map(async (m) => {
    const l = live[m.protocolId];
    if (l) {
      await writeKnown(m.protocolId, { apyPercent: l.apyPercent, tvlUsd: l.tvlUsd, at: now });
      return {
        ...m,
        apyPercent: l.apyPercent,
        apyBps: Math.round(l.apyPercent * 100),
        tvlUsd: l.tvlUsd ?? m.tvlUsd,
        stale: false,
        fetchedAt: now,
        color: COLORS[m.protocolId] || "#6b7280",
      };
    }
    // No live rate: serve the last value we actually observed, clearly flagged, with
    // the time it was really observed (NOT `now` — that would disguise its age).
    const known = await readKnown(m.protocolId);
    return {
      ...m,
      apyPercent: known?.apyPercent ?? null,
      apyBps: known ? Math.round(known.apyPercent * 100) : 0,
      tvlUsd: known?.tvlUsd ?? m.tvlUsd,
      stale: true,
      fetchedAt: known?.at ?? null,
      color: COLORS[m.protocolId] || "#6b7280",
    };
  }));

  // Live rates first; stale/unknown sort last so they can never become the headline "Best APY".
  result.sort((a, b) => (Number(a.stale) - Number(b.stale)) || (b.apyBps - a.apyBps));

  return NextResponse.json(result, {
    headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" },
  });
}
