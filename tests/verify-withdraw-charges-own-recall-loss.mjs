/**
 * verify-withdraw-charges-own-recall-loss.mjs — checks the fix for the "cheap grief the
 * whole pool" gap: a withdrawal that forces an early exit from a deployed LST position
 * (before enough epochs/yield have accrued to cover the protocol's exit fee) used to have
 * that loss booked into total_deposits, socialized across every depositor via total_shares
 * — so a tiny stakeholder could force a real loss mostly paid by everyone else. JS mirror
 * of the Rust (keep in sync if lib.rs changes): settle_recall's charge_to_withdrawer path
 * (stages the loss in pending_recall_loss instead of total_deposits) plus withdraw()'s
 * charge-back (subtracts the OTHER shareholders' portion of that loss from the triggering
 * user's own payout, reverting rather than leaking any of it onto the pool if their
 * withdrawal is too small to cover it).
 *
 * Run: node scripts/verify-withdraw-charges-own-recall-loss.mjs
 */
import assert from "node:assert/strict";

let passed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); passed++; }
  catch (e) { console.log(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// Mirror of settle_recall with the charge_to_withdrawer branch. Returns
// { deployed, totalDeposits, pendingRecallLoss }.
function settleRecall(
  { deployed, totalDeposits, pendingRecallLoss },
  received, receiptBefore, receiptRemaining, chargeToWithdrawer,
) {
  deployed = BigInt(deployed); totalDeposits = BigInt(totalDeposits);
  pendingRecallLoss = BigInt(pendingRecallLoss);
  received = BigInt(received); receiptBefore = BigInt(receiptBefore); receiptRemaining = BigInt(receiptRemaining);
  const newDeployed = receiptBefore === 0n ? 0n : (deployed * receiptRemaining) / receiptBefore;
  const costBasisRecalled = deployed > newDeployed ? deployed - newDeployed : 0n;
  if (received >= costBasisRecalled) {
    totalDeposits += received - costBasisRecalled; // gain always socialized — no exploit incentive there
  } else {
    const loss = costBasisRecalled - received;
    if (chargeToWithdrawer) {
      pendingRecallLoss += loss; // staged, NOT subtracted from totalDeposits
    } else {
      totalDeposits = totalDeposits > loss ? totalDeposits - loss : 0n; // keeper's own voluntary rebalance — unchanged behavior
    }
  }
  return { deployed: newDeployed, totalDeposits, pendingRecallLoss };
}

// Mirror of withdraw()'s recall-loss charge-back. Returns amount_out after the charge,
// or throws (mirroring the Rust `require!` revert) if the loss exceeds the withdrawal.
function applyRecallCharge(amountOut, pendingRecallLoss, totalSharesBefore, shares) {
  amountOut = BigInt(amountOut); pendingRecallLoss = BigInt(pendingRecallLoss);
  totalSharesBefore = BigInt(totalSharesBefore); shares = BigInt(shares);
  if (pendingRecallLoss === 0n) return amountOut;
  const extraCharge = (pendingRecallLoss * (totalSharesBefore - shares)) / totalSharesBefore;
  if (amountOut < extraCharge) throw new Error("RecallExceedsWithdrawal");
  return amountOut - extraCharge;
}

// ── keeper-initiated recall: unchanged, loss still socialized into total_deposits ──
check("keeper's own voluntary recall still socializes loss (unaffected by the fix)", () => {
  const r = settleRecall({ deployed: 8000n, totalDeposits: 10000n, pendingRecallLoss: 0n }, 3900n, 4000n, 2000n, false);
  assert.equal(r.pendingRecallLoss, 0n);
  assert.equal(r.totalDeposits, 10000n - 100n); // same -100 loss as the settle_recall test
});

// ── paired (user-forced) recall: loss diverted to pending_recall_loss, NOT total_deposits ──
check("paired withdrawal recall stages the loss instead of touching total_deposits", () => {
  const r = settleRecall({ deployed: 8000n, totalDeposits: 10000n, pendingRecallLoss: 0n }, 3900n, 4000n, 2000n, true);
  assert.equal(r.totalDeposits, 10000n); // untouched — other depositors' share price unaffected
  assert.equal(r.pendingRecallLoss, 100n);
});

// ── gains are NEVER redirected, paired or not — no exploit incentive on the gain side ──
check("gain always goes to total_deposits regardless of charge_to_withdrawer", () => {
  const rKeeper = settleRecall({ deployed: 1000n, totalDeposits: 1000n, pendingRecallLoss: 0n }, 1100n, 500n, 0n, false);
  const rPaired = settleRecall({ deployed: 1000n, totalDeposits: 1000n, pendingRecallLoss: 0n }, 1100n, 500n, 0n, true);
  assert.equal(rKeeper.totalDeposits, 1100n);
  assert.equal(rPaired.totalDeposits, 1100n);
  assert.equal(rPaired.pendingRecallLoss, 0n);
});

// ── the core fix: withdrawer eats the FULL loss, not just their pro-rata slice ──
check("withdrawer's payout absorbs the entire loss, other shareholders made exactly whole", () => {
  // Vault: 100 total shares, one user withdraws 1 share (1% stake) forcing a recall that
  // loses 1000. Old behavior: total_deposits -1000, shared by all 100 shares — the 1%
  // attacker would've paid only 10 of that, externalizing 990 onto the other 99 shares.
  const totalSharesBefore = 100n, shares = 1n, pendingRecallLoss = 1000n;
  const vPriorToRecall = 500000n; // pre-recall total vault value (idle + deployed)
  // amount_out before the charge is exactly what withdraw()'s existing idle+deployed
  // pricing produces: this withdrawer's pro-rata claim on the ALREADY-post-loss total
  // value (vPriorToRecall - pendingRecallLoss) — that dilution already happened to
  // total_value the instant the recall ran, before this charge-back logic even runs.
  const amountOutBeforeCharge = (shares * (vPriorToRecall - pendingRecallLoss)) / totalSharesBefore; // 4990
  const finalAmountOut = applyRecallCharge(amountOutBeforeCharge, pendingRecallLoss, totalSharesBefore, shares);
  const extraCharge = amountOutBeforeCharge - finalAmountOut;
  assert.equal(extraCharge, (1000n * 99n) / 100n); // the other 99%'s portion — 990
  // Exact-wholeness check: remaining assets / remaining shares must equal the pre-loss
  // per-share ratio, i.e. as if the early exit never happened. extraCharge is tokens that
  // never left the vault (subtracted from the payout, not sent anywhere), so it stays
  // part of the vault's remaining physical assets.
  const remainingAssets = (vPriorToRecall - pendingRecallLoss) - finalAmountOut;
  const remainingShares = totalSharesBefore - shares;
  // remainingAssets should equal vPriorToRecall * remainingShares / totalSharesBefore
  const expected = (vPriorToRecall * remainingShares) / totalSharesBefore;
  assert.equal(remainingAssets, expected);
});

// ── the "0.001 SOL stake, 40 SOL vault" scenario: revert, never partially leak ──
check("loss bigger than the withdrawal itself reverts instead of leaking onto the pool", () => {
  assert.throws(
    () => applyRecallCharge(/* amountOut */ 10n, /* pendingRecallLoss */ 1000n, /* totalShares */ 100n, /* shares */ 1n),
    /RecallExceedsWithdrawal/,
  );
});

// ── isolation: a keeper-only recall never populates pending_recall_loss for a later withdraw ──
check("keeper-initiated recalls never stage a charge a later withdrawer could inherit", () => {
  const r = settleRecall({ deployed: 8000n, totalDeposits: 10000n, pendingRecallLoss: 0n }, 3900n, 4000n, 2000n, false);
  assert.equal(r.pendingRecallLoss, 0n); // nothing staged — a subsequent withdraw() sees pendingRecallLoss=0, no charge
});

// ── no recall at all: withdraw() behaves exactly as before ──
check("normal withdrawal (idle covers it, no recall) is untouched by the fix", () => {
  assert.equal(applyRecallCharge(5000n, 0n, 100n, 1n), 5000n);
});

console.log(`\n${passed} checks passed`);
