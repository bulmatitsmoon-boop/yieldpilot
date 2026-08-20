/**
 * verify-accrue-sol-lst.mjs — checks the accrue_sol_lst accounting model that lib.rs
 * implements. JS mirror of the Rust (keep in sync if the Rust changes).
 *
 * Run: node scripts/verify-accrue-sol-lst.mjs
 */
import assert from "node:assert/strict";

let passed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); passed++; }
  catch (e) { console.log(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// Mirror of accrue_sol_lst: real_value = receiptBalance * totalLamports / poolTokenSupply
// (u128 intermediate); only moves deployed_balance UP, only books a gain when it does.
function accrueSolLst({ totalDeposits, deployedBalance }, { receiptBalance, totalLamports, poolTokenSupply }) {
  totalDeposits = BigInt(totalDeposits);
  deployedBalance = BigInt(deployedBalance);
  receiptBalance = BigInt(receiptBalance);
  totalLamports = BigInt(totalLamports);
  poolTokenSupply = BigInt(poolTokenSupply);

  const realValue = (receiptBalance * totalLamports) / poolTokenSupply;
  if (realValue > deployedBalance) {
    const gain = realValue - deployedBalance;
    return { totalDeposits: totalDeposits + gain, deployedBalance: realValue, gain };
  }
  return { totalDeposits, deployedBalance, gain: 0n };
}

check("books a real gain when the pool's exchange rate has risen since deploy", () => {
  // Deployed 1,000,000 lamports worth (receipt tokens minted 1:1 at deploy time, rate 1.0).
  // Pool has since appreciated: rate is now 1.05 (1,050,000 lamports / 1,000,000 supply).
  const r = accrueSolLst(
    { totalDeposits: 10_000_000n, deployedBalance: 1_000_000n },
    { receiptBalance: 1_000_000n, totalLamports: 1_050_000_000n, poolTokenSupply: 1_000_000_000n }
  );
  assert.equal(r.deployedBalance, 1_050_000n);
  assert.equal(r.gain, 50_000n);
  assert.equal(r.totalDeposits, 10_000_000n + 50_000n);
});

check("no-op when the computed value has not moved (rate unchanged)", () => {
  const r = accrueSolLst(
    { totalDeposits: 10_000_000n, deployedBalance: 1_000_000n },
    { receiptBalance: 1_000_000n, totalLamports: 1_000_000_000n, poolTokenSupply: 1_000_000_000n }
  );
  assert.equal(r.gain, 0n);
  assert.equal(r.deployedBalance, 1_000_000n); // unchanged, not overwritten with an equal value
  assert.equal(r.totalDeposits, 10_000_000n);
});

check("never books a loss — a lower computed value is ignored, not subtracted", () => {
  // Simulates a stale/racing read where real_value comes out under deployed_balance —
  // must be a no-op, never a phantom loss (real losses only come from settle_recall).
  const r = accrueSolLst(
    { totalDeposits: 10_000_000n, deployedBalance: 1_000_000n },
    { receiptBalance: 1_000_000n, totalLamports: 950_000_000n, poolTokenSupply: 1_000_000_000n }
  );
  assert.equal(r.gain, 0n);
  assert.equal(r.deployedBalance, 1_000_000n);
  assert.equal(r.totalDeposits, 10_000_000n);
});

check("repeated accruals compound correctly, no double-counting", () => {
  let state = { totalDeposits: 10_000_000n, deployedBalance: 1_000_000n };
  // First accrual: rate rises to 1.05
  let r = accrueSolLst(state, { receiptBalance: 1_000_000n, totalLamports: 1_050_000_000n, poolTokenSupply: 1_000_000_000n });
  state = { totalDeposits: r.totalDeposits, deployedBalance: r.deployedBalance };
  assert.equal(state.deployedBalance, 1_050_000n);
  // Second accrual: rate rises further to 1.10 — gain should be only the DELTA (50,000), not the full 100,000
  r = accrueSolLst(state, { receiptBalance: 1_000_000n, totalLamports: 1_100_000_000n, poolTokenSupply: 1_000_000_000n });
  assert.equal(r.gain, 50_000n);
  assert.equal(r.deployedBalance, 1_100_000n);
  assert.equal(r.totalDeposits, 10_000_000n + 50_000n + 50_000n);
});

console.log(`\n${passed} checks passed`);
