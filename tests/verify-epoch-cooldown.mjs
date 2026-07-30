/**
 * verify-epoch-cooldown.mjs — checks the epoch-cooldown gate that rebalancer.ts
 * applies before exiting an LST protocol (marinade-sol, jito-sol, psol-sol).
 * JS mirror of epochCooldownBlocksExit (keep in sync if rebalancer.ts changes).
 *
 * Run: node tests/verify-epoch-cooldown.mjs
 */
import assert from "node:assert/strict";

let passed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); passed++; }
  catch (e) { console.log(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; }
}

const EPOCH_GATED = new Set(["marinade-sol", "jito-sol", "psol-sol"]);
const EXIT_COST_BPS = { "marinade-sol": 30, "jito-sol": 10, "psol-sol": 10, "kamino-usdc": 0, "solend-usdc": 0 };
const BPS_DENOM = 10_000;

function epochCooldownBlocksExit(label, apyBps, ctx) {
  if (!ctx || !EPOCH_GATED.has(label)) return false;
  const entryEpoch = ctx.entryEpochs[label];
  if (entryEpoch === undefined) return false;
  const epochsHeld = ctx.currentEpoch - entryEpoch;
  if (epochsHeld <= 0) return true;
  const exitFeeFrac = (EXIT_COST_BPS[label] ?? 0) / BPS_DENOM;
  const dailyApy = (apyBps / BPS_DENOM) / 365;
  const accruedFrac = epochsHeld * ctx.epochLengthDays * dailyApy;
  return accruedFrac < exitFeeFrac;
}

check("blocks exit in the same epoch as entry (earned $0 so far)", () => {
  const ctx = { currentEpoch: 1009, epochLengthDays: 2.11, entryEpochs: { "jito-sol": 1009 } };
  assert.equal(epochCooldownBlocksExit("jito-sol", 600, ctx), true);
});

check("blocks exit when accrued yield hasn't caught up to the flat exit fee yet (1 epoch, 6% APY)", () => {
  // Matches the live worked example: 6% APY, 1 epoch (~2.11 days) held, 10bps exit fee.
  const ctx = { currentEpoch: 1010, epochLengthDays: 2.11, entryEpochs: { "jito-sol": 1009 } };
  assert.equal(epochCooldownBlocksExit("jito-sol", 600, ctx), true);
});

check("allows exit once enough epochs have passed for yield to exceed the exit fee", () => {
  // 6% APY needs ~6.08 days (~2.9 epochs) to clear a 10bps fee -> 3 epochs held is enough.
  const ctx = { currentEpoch: 1012, epochLengthDays: 2.11, entryEpochs: { "jito-sol": 1009 } };
  assert.equal(epochCooldownBlocksExit("jito-sol", 600, ctx), false);
});

check("never blocks lending protocols (no epoch concept) even with no entry record", () => {
  const ctx = { currentEpoch: 1009, epochLengthDays: 2.11, entryEpochs: {} };
  assert.equal(epochCooldownBlocksExit("kamino-usdc", 3476, ctx), false);
  assert.equal(epochCooldownBlocksExit("solend-usdc", 500, ctx), false);
});

check("fails open (does not block) when there is no entry-epoch record at all", () => {
  const ctx = { currentEpoch: 1009, epochLengthDays: 2.11, entryEpochs: {} };
  assert.equal(epochCooldownBlocksExit("marinade-sol", 600, ctx), false);
});

check("fails open when no epoch context is supplied at all (feature disabled/omitted)", () => {
  assert.equal(epochCooldownBlocksExit("jito-sol", 600, undefined), false);
});

check("higher APY reaches breakeven sooner than lower APY (fewer epochs needed)", () => {
  // At 12% APY breakeven is ~3.04 days (~1.44 epochs) -> should already be clear after 2 epochs.
  const ctx = { currentEpoch: 1011, epochLengthDays: 2.11, entryEpochs: { "marinade-sol": 1009 } };
  assert.equal(epochCooldownBlocksExit("marinade-sol", 1200, ctx), false);
});

console.log(`\n${passed} checks passed`);
