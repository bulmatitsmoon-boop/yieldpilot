/**
 * verify-settle-recall.mjs — checks the proportional recall-accounting model that
 * lib.rs's settle_recall implements. JS mirror of the Rust (keep in sync if the Rust
 * changes), exercised across the cases that matter: full exit, partial recall, realized
 * gain, realized loss, and the exact SOL-vault overstatement this was written to fix.
 *
 * Run: node scripts/verify-settle-recall.mjs
 */
import assert from "node:assert/strict";

let passed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); passed++; }
  catch (e) { console.log(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// Mirror of settle_recall: returns the post-recall { deployed, totalDeposits }.
// BigInt throughout, matching the Rust u64/u128 arithmetic.
function settleRecall({ deployed, totalDeposits }, received, receiptBefore, receiptRemaining) {
  deployed = BigInt(deployed); totalDeposits = BigInt(totalDeposits);
  received = BigInt(received); receiptBefore = BigInt(receiptBefore); receiptRemaining = BigInt(receiptRemaining);
  const newDeployed = receiptBefore === 0n ? 0n : (deployed * receiptRemaining) / receiptBefore;
  const costBasisRecalled = deployed > newDeployed ? deployed - newDeployed : 0n;
  if (received >= costBasisRecalled) {
    totalDeposits += received - costBasisRecalled;               // realized gain
  } else {
    const loss = costBasisRecalled - received;
    totalDeposits = totalDeposits > loss ? totalDeposits - loss : 0n; // saturating
  }
  return { deployed: newDeployed, totalDeposits };
}

// ── full exit, at a loss (exit fee) — the classic phantom case ──
check("full exit books the loss and zeros the slot", () => {
  // deployed 8156, receipt 5501 -> 0, received 7655 (net of unstake fee)
  const r = settleRecall({ deployed: 8156n, totalDeposits: 11327n }, 7655n, 5501n, 0n);
  assert.equal(r.deployed, 0n);
  assert.equal(r.totalDeposits, 11327n - (8156n - 7655n)); // -501 loss
});

// ── full exit, at a gain (yield realized) ──
check("full exit books yield gain, zeros slot", () => {
  const r = settleRecall({ deployed: 1000n, totalDeposits: 1000n }, 1100n, 500n, 0n);
  assert.equal(r.deployed, 0n);
  assert.equal(r.totalDeposits, 1100n); // +100 gain
});

// ── partial recall: THE FIX. residue must NOT accumulate ──
check("partial recall reduces deployed proportionally, books loss on recalled part", () => {
  // half the receipt tokens recalled; deployed halves; loss booked on the recalled half
  // deployed 8000, receipt 4000 -> 2000 (half), received 3900 (half's value net of fee)
  const r = settleRecall({ deployed: 8000n, totalDeposits: 10000n }, 3900n, 4000n, 2000n);
  assert.equal(r.deployed, 4000n);            // exactly half of 8000 — proportional, no residue
  const costRecalled = 8000n - 4000n;         // 4000
  assert.equal(r.totalDeposits, 10000n - (costRecalled - 3900n)); // -100 loss on recalled half
});

// ── repeated partial recalls do not accumulate residue ──
check("two partial recalls leave deployed exactly proportional (no drift)", () => {
  let st = { deployed: 8000n, totalDeposits: 10000n };
  // recall 1: 4000 -> 3000 receipt (1/4 removed), received matches cost basis (no fee for test)
  st = settleRecall(st, 2000n, 4000n, 3000n);   // costRecalled = 8000*(1 - 3000/4000)=2000
  assert.equal(st.deployed, 6000n);             // 8000 * 3000/4000
  // recall 2: 3000 -> 1500 receipt (half of remaining), received matches
  st = settleRecall(st, 3000n, 3000n, 1500n);   // costRecalled = 6000*(1-1500/3000)=3000
  assert.equal(st.deployed, 3000n);             // 6000 * 1500/3000 — still exact, zero residue
});

// ── the OLD bug it fixes: `deployed - received` would leave residue ──
check("old `deployed - received` would have left residue; new model does not", () => {
  const deployed = 8000n, received = 3900n, receiptBefore = 4000n, receiptRemaining = 2000n;
  const oldResidualDeployed = deployed - received;                  // 4100 — WRONG (fee baked in)
  const neu = settleRecall({ deployed, totalDeposits: 10000n }, received, receiptBefore, receiptRemaining);
  assert.equal(neu.deployed, 4000n);            // proportional truth
  assert.notEqual(neu.deployed, oldResidualDeployed);
});

// ── edge: receiptBefore 0 (nothing was there) ──
check("receiptBefore 0 -> deployed 0, no divide by zero", () => {
  const r = settleRecall({ deployed: 0n, totalDeposits: 5n }, 0n, 0n, 0n);
  assert.equal(r.deployed, 0n);
});

// ── loss can never underflow total_deposits (saturating) ──
check("loss saturates total_deposits at 0", () => {
  const r = settleRecall({ deployed: 1000n, totalDeposits: 100n }, 0n, 1000n, 0n); // loss 1000 > 100
  assert.equal(r.totalDeposits, 0n);
});

console.log(`\n${passed} checks passed`);
