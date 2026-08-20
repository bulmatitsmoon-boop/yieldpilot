/**
 * verify-clear-phantom.mjs — checks the clear_phantom_deployed accounting model that
 * lib.rs implements. JS mirror of the Rust (keep in sync if the Rust changes).
 *
 * Run: node scripts/verify-clear-phantom.mjs
 */
import assert from "node:assert/strict";

let passed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); passed++; }
  catch (e) { console.log(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// Mirror of clear_phantom_deployed: only callable when receiptBalance === 0n (enforced
// on-chain via require!; this mirror takes it as a precondition the caller must have met).
function clearPhantomDeployed({ totalDeposits, deployedBalance }) {
  totalDeposits = BigInt(totalDeposits);
  deployedBalance = BigInt(deployedBalance);
  const phantom = deployedBalance;
  const newTotalDeposits = totalDeposits > phantom ? totalDeposits - phantom : 0n; // saturating_sub
  return { totalDeposits: newTotalDeposits, deployedBalance: 0n, cleared: phantom };
}

check("clears a dead slot and books the loss into total_deposits", () => {
  const r = clearPhantomDeployed({ totalDeposits: 11317104n, deployedBalance: 68779n });
  assert.equal(r.deployedBalance, 0n);
  assert.equal(r.cleared, 68779n);
  assert.equal(r.totalDeposits, 11317104n - 68779n);
});

check("two sequential clears (jito then marinade) compound correctly, no double-count", () => {
  let state = { totalDeposits: 11317104n, deployedBalance: 68779n }; // jito slot
  let r1 = clearPhantomDeployed(state);
  assert.equal(r1.totalDeposits, 11317104n - 68779n);

  // marinade slot uses the SAME running total_deposits, different deployed_balance
  let r2 = clearPhantomDeployed({ totalDeposits: r1.totalDeposits, deployedBalance: 533348n });
  assert.equal(r2.totalDeposits, 11317104n - 68779n - 533348n);
  assert.equal(r2.deployedBalance, 0n);
});

check("saturates at 0 rather than underflowing if phantom somehow exceeds total_deposits", () => {
  const r = clearPhantomDeployed({ totalDeposits: 100n, deployedBalance: 1000n });
  assert.equal(r.totalDeposits, 0n);
});

check("real SOL-vault numbers: clearing both dead slots matches the observed gap", () => {
  // Live numbers captured 2026-07-30: idle=1,708,575, totalDeposits=2,310,702,
  // jito=68,779 (receipt 0), marinade=533,348 (receipt 0), psol=0 (already clean).
  // After clearing both dead slots, total_deposits should equal idle + real deployed (0).
  let state = { totalDeposits: 2310702n, deployedBalance: 68779n };
  state = clearPhantomDeployed(state);
  state = clearPhantomDeployed({ totalDeposits: state.totalDeposits, deployedBalance: 533348n });
  assert.equal(state.totalDeposits, 1708575n); // == idle exactly, since real deployed is 0 post-clear
});

console.log(`\n${passed} checks passed`);
