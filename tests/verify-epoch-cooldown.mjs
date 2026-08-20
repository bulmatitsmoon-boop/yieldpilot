/**
 * verify-epoch-cooldown.mjs — guards the epoch-cooldown gate that stops the keeper from
 * exiting an epoch-gated LST position before its accrued yield covers the flat exit fee.
 *
 * THE INCIDENT THIS EXISTS TO PREVENT (2026-08-20):
 * The check used to FAIL OPEN when no entry-epoch record existed for a position, which
 * made it silently inert in exactly the case it was written for. The SOL vault churned
 * psol-sol three times between Aug 5-10 — twice recalling and redeploying the SAME
 * protocol only ~6-8 minutes apart — paying the 10bps exit fee on the full balance each
 * time. That burned ~0.0124 SOL against ~0.0161 SOL of gross yield: churn ate ~77% of
 * earnings and dropped realized return to ~2% APY versus ~8.5% gross. Every exit sailed
 * through because no psol-sol entry was ever on file.
 *
 * The gate now fails CLOSED on a missing record, and solanaClient.getEpochContext
 * backfills an entry for any held epoch-gated position so it self-heals rather than
 * deadlocking. JS mirror of rebalancer.ts's epochCooldownBlocksExit — keep in sync.
 *
 * Run: node tests/verify-epoch-cooldown.mjs
 */
import assert from "node:assert/strict";

let passed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); passed++; }
  catch (e) { console.log(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// Mirrors rebalancer.ts
const EPOCH_GATED_PROTOCOLS = new Set(["marinade-sol", "jito-sol", "psol-sol"]);
const EXIT_COST_BPS = {
  "kamino-usdc": 0, "kamino-usdc-maple": 0, "kamino-sol": 0, "solend-usdc": 0,
  "marinade-sol": 30, "jito-sol": 10, "psol-sol": 10,
};
const BPS_DENOM = 10_000;

function epochCooldownBlocksExit(label, apyBps, ctx) {
  if (!ctx || !EPOCH_GATED_PROTOCOLS.has(label)) return false;
  const entryEpoch = ctx.entryEpochs[label];
  if (entryEpoch === undefined) return true; // fail CLOSED
  const epochsHeld = ctx.currentEpoch - entryEpoch;
  if (epochsHeld <= 0) return true;
  const exitFeeFrac = (EXIT_COST_BPS[label] ?? 0) / BPS_DENOM;
  const dailyApy = (apyBps / BPS_DENOM) / 365;
  const accruedFrac = epochsHeld * ctx.epochLengthDays * dailyApy;
  return accruedFrac < exitFeeFrac;
}

const L = 2.11; // measured mainnet epoch length in days
const ctx = (currentEpoch, entryEpochs) => ({ currentEpoch, epochLengthDays: L, entryEpochs });

// ── THE REGRESSION ──────────────────────────────────────────────────────────
check("missing entry record BLOCKS exit (fail-closed; this is the Aug 5-10 bug)", () => {
  assert.equal(epochCooldownBlocksExit("psol-sol", 615, ctx(1010, {})), true);
});

check("missing record blocks marinade too", () => {
  assert.equal(epochCooldownBlocksExit("marinade-sol", 600, ctx(1010, {})), true);
});

// ── Normal cooldown behaviour ───────────────────────────────────────────────
check("entered this epoch -> blocked (earned nothing yet)", () => {
  assert.equal(epochCooldownBlocksExit("psol-sol", 615, ctx(1010, { "psol-sol": 1010 })), true);
});

check("1 epoch held, accrued < 10bps fee -> blocked", () => {
  // 2.11d * (6.15%/365) = 0.0356% < 0.10%
  assert.equal(epochCooldownBlocksExit("psol-sol", 615, ctx(1011, { "psol-sol": 1010 })), true);
});

check("3 epochs held, accrued > 10bps fee -> ALLOWED", () => {
  // 6.33d * (6.15%/365) = 0.1067% > 0.10%
  assert.equal(epochCooldownBlocksExit("psol-sol", 615, ctx(1013, { "psol-sol": 1010 })), false);
});

check("marinade's 30bps fee needs materially longer than psol's 10bps", () => {
  assert.equal(epochCooldownBlocksExit("marinade-sol", 600, ctx(1013, { "marinade-sol": 1010 })), true);
  assert.equal(epochCooldownBlocksExit("marinade-sol", 600, ctx(1020, { "marinade-sol": 1010 })), false);
});

// ── Lending markets must NEVER be gated ─────────────────────────────────────
// They accrue every slot; gating them would wait forever on an epoch signal that
// never fires, freezing legitimate rebalances out of a lending market.
check("kamino/solend are never blocked, even with no record", () => {
  for (const label of ["kamino-usdc", "kamino-usdc-maple", "kamino-sol", "solend-usdc"]) {
    assert.equal(epochCooldownBlocksExit(label, 400, ctx(1010, {})), false, label);
  }
});

check("no epoch context at all -> never blocks (cannot evaluate)", () => {
  assert.equal(epochCooldownBlocksExit("psol-sol", 615, undefined), false);
});

// ── Economic property: blocking must be strictly cheaper than churning ──────
check("a blocked exit never costs more than the fee it avoids", () => {
  // At 6.15% APY, one full 10bps fee equals ~5.9 days of yield. Exiting before that
  // is a guaranteed net loss, which is precisely what the gate must refuse.
  const dailyApy = (615 / BPS_DENOM) / 365;
  const daysToEarnFee = (10 / BPS_DENOM) / dailyApy;
  assert.ok(daysToEarnFee > L, "one epoch must not be enough to cover a 10bps fee");
  const epochsNeeded = Math.ceil(daysToEarnFee / L);
  assert.equal(epochCooldownBlocksExit("psol-sol", 615, ctx(1010 + epochsNeeded - 1, { "psol-sol": 1010 })), true);
  assert.equal(epochCooldownBlocksExit("psol-sol", 615, ctx(1010 + epochsNeeded, { "psol-sol": 1010 })), false);
});

console.log(`\n${passed} checks passed`);
