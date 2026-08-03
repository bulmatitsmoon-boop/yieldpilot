/**
 * verify-lifetime-gains.mjs — checks the lifetime_gains accounting model lib.rs
 * implements: a cumulative, never-decreasing counter of all REALIZED gains,
 * incremented in settle_recall's gain branch and accrue_sol_lst's gain branch.
 * JS mirror of the Rust (keep in sync if the Rust changes).
 *
 * Run: node tests/verify-lifetime-gains.mjs
 */
import assert from "node:assert/strict";

let passed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); passed++; }
  catch (e) { console.log(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// Mirrors settle_recall's proportional model, extended with lifetime_gains.
function settleRecall(v, idx, received, receiptBefore, receiptRemaining) {
  received = BigInt(received); receiptBefore = BigInt(receiptBefore); receiptRemaining = BigInt(receiptRemaining);
  const deployed = BigInt(v.protocols[idx].deployedBalance);
  const newDeployed = receiptBefore === 0n ? 0n : (deployed * receiptRemaining) / receiptBefore;
  const costBasisRecalled = deployed > newDeployed ? deployed - newDeployed : 0n;

  let totalDeposits = BigInt(v.totalDeposits);
  let lifetimeGains = BigInt(v.lifetimeGains);
  if (received >= costBasisRecalled) {
    const gain = received - costBasisRecalled;
    totalDeposits += gain;
    lifetimeGains += gain; // only path that increments it, alongside accrue_sol_lst
  } else {
    const loss = costBasisRecalled - received;
    totalDeposits = totalDeposits > loss ? totalDeposits - loss : 0n;
    // lifetimeGains UNTOUCHED on a loss — it only ever goes up.
  }
  v.protocols[idx].deployedBalance = newDeployed;
  v.totalDeposits = totalDeposits;
  v.lifetimeGains = lifetimeGains;
}

// Mirrors accrue_sol_lst's gain branch, extended with lifetime_gains.
function accrueSolLst(v, idx, realValue) {
  realValue = BigInt(realValue);
  const oldDeployed = BigInt(v.protocols[idx].deployedBalance);
  if (realValue > oldDeployed) {
    const gain = realValue - oldDeployed;
    v.totalDeposits = BigInt(v.totalDeposits) + gain;
    v.lifetimeGains = BigInt(v.lifetimeGains) + gain;
    v.protocols[idx].deployedBalance = realValue;
  }
  // realValue <= oldDeployed: no-op, exactly like the real function — never books a loss here.
}

function freshVault() {
  return { totalDeposits: 0n, lifetimeGains: 0n, protocols: [{ deployedBalance: 0n }] };
}

check("settle_recall gain increments both totalDeposits and lifetimeGains equally", () => {
  const v = freshVault();
  v.totalDeposits = 1_000_000n;
  v.protocols[0].deployedBalance = 500_000n;
  settleRecall(v, 0, 550_000n, 500_000n, 0n); // full exit, receipt fully redeemed, gain of 50k
  assert.equal(v.totalDeposits, 1_050_000n);
  assert.equal(v.lifetimeGains, 50_000n);
});

check("settle_recall loss decrements totalDeposits but NEVER touches lifetimeGains", () => {
  const v = freshVault();
  v.totalDeposits = 1_000_000n;
  v.lifetimeGains = 12_345n; // pretend some prior gain was already booked
  v.protocols[0].deployedBalance = 500_000n;
  settleRecall(v, 0, 480_000n, 500_000n, 0n); // full exit, loss of 20k (e.g. exit fee)
  assert.equal(v.totalDeposits, 980_000n);
  assert.equal(v.lifetimeGains, 12_345n); // unchanged
});

check("accrue_sol_lst gain increments both totalDeposits and lifetimeGains equally", () => {
  const v = freshVault();
  v.totalDeposits = 10_000_000n;
  v.protocols[0].deployedBalance = 1_000_000n;
  accrueSolLst(v, 0, 1_050_000n); // rate rose, real value now 1.05M vs deployed 1M
  assert.equal(v.totalDeposits, 10_050_000n);
  assert.equal(v.lifetimeGains, 50_000n);
});

check("accrue_sol_lst no-op (rate unchanged or lower) never touches lifetimeGains", () => {
  const v = freshVault();
  v.totalDeposits = 10_000_000n;
  v.lifetimeGains = 7_000n;
  v.protocols[0].deployedBalance = 1_000_000n;
  accrueSolLst(v, 0, 950_000n); // lower real value — must be ignored, not a phantom loss
  assert.equal(v.totalDeposits, 10_000_000n);
  assert.equal(v.lifetimeGains, 7_000n);
});

check("lifetimeGains survives a full withdrawal that resets totalDeposits to 0", () => {
  // This is the whole point of the feature: totalDeposits is a live snapshot that goes
  // to 0 once everyone withdraws, but lifetimeGains must still remember real history.
  const v = freshVault();
  v.totalDeposits = 1_000_000n;
  v.protocols[0].deployedBalance = 500_000n;
  settleRecall(v, 0, 550_000n, 500_000n, 0n); // gain of 50k booked
  assert.equal(v.lifetimeGains, 50_000n);
  // Simulate a full withdrawal driving totalDeposits back to 0 (withdraw() itself
  // doesn't touch lifetimeGains at all — not modeled here since it's out of scope for
  // this file, just asserting the field the withdrawal path never mutates stays put).
  v.totalDeposits = 0n;
  assert.equal(v.lifetimeGains, 50_000n, "lifetimeGains must NOT reset alongside totalDeposits");
});

check("repeated gains across multiple cycles accumulate correctly (no double-counting, no overwrite)", () => {
  const v = freshVault();
  v.totalDeposits = 1_000_000n;
  v.protocols[0].deployedBalance = 500_000n;
  settleRecall(v, 0, 550_000n, 500_000n, 0n); // +50k
  v.protocols[0].deployedBalance = 300_000n; // pretend a fresh deploy cycle happened
  settleRecall(v, 0, 330_000n, 300_000n, 0n); // +30k more
  assert.equal(v.lifetimeGains, 80_000n);
});

console.log(`\n${passed} checks passed`);
