/**
 * verify-split-deposit.mjs — correctness check for the /portfolio split-deposit logic.
 *
 * Run: `node scripts/verify-split-deposit.mjs` (from app/) or `npm run verify:split-deposit`.
 * No wallet, browser, or validator needed — it imports the SAME module the page ships
 * (src/lib/splitDeposit.mjs), so the test can never drift from the component.
 *
 * This closes the one gap CI couldn't reach before: the new split-deposit logic — the
 * blended-APY preview and the "which legs fire" orchestration, including the honesty
 * constraints (no zero-deposits, LP blocked without the IL acknowledgement).
 */
import assert from "node:assert/strict";
import { blendedApy, splitAmounts, estYearly, planLegs } from "../src/lib/splitDeposit.mjs";
import { phase2Visible } from "../src/lib/phase2Access.mjs";
import { portfolioTotals, safeValueUsd } from "../src/lib/portfolio.mjs";

let passed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL: ${name}`);
    console.log(`  ${e.message}`);
    process.exitCode = 1;
  }
}

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

// ── blended APY ──────────────────────────────────────────────────────────────
check("blend 70/30 of 6.1% and 34%", () => approx(blendedApy(70, 6.1, 34), (6.1 * 70 + 34 * 30) / 100));
check("blend 100% safe = safe rate", () => approx(blendedApy(100, 6.1, 34), 6.1));
check("blend 0% safe = lp rate", () => approx(blendedApy(0, 6.1, 34), 34));
check("blend clamps pct above 100", () => approx(blendedApy(150, 6.1, 34), 6.1));
check("blend clamps pct below 0", () => approx(blendedApy(-20, 6.1, 34), 34));
check("blend tolerates NaN pct", () => approx(blendedApy(NaN, 6.1, 34), 34));

// ── dollar split ───────────────────────────────────────────────────────────────
check("split 2000 @ 70% safe", () => {
  const { safeUsd, lpUsd } = splitAmounts(2000, 70);
  assert.equal(safeUsd, 1400);
  assert.equal(lpUsd, 600);
});
check("split conserves the total", () => {
  const { safeUsd, lpUsd } = splitAmounts(1234.56, 37);
  approx(safeUsd + lpUsd, 1234.56);
});
check("split of 0 is 0/0", () => {
  const { safeUsd, lpUsd } = splitAmounts(0, 70);
  assert.equal(safeUsd, 0);
  assert.equal(lpUsd, 0);
});
check("split ignores negative plan", () => {
  const { safeUsd, lpUsd } = splitAmounts(-500, 70);
  assert.equal(safeUsd, 0);
  assert.equal(lpUsd, 0);
});

// ── est yearly ─────────────────────────────────────────────────────────────────
check("est yearly rounds", () => assert.equal(estYearly(2000, 14.5), 290));
check("est yearly of 0 plan", () => assert.equal(estYearly(0, 14.5), 0));

// ── leg orchestration (the honesty constraints) ────────────────────────────────
check("both legs when both funded and IL acked", () => {
  const d = planLegs({ safeAmount: "1400", lpReady: true, lpAmountA: "3", ackIl: true });
  assert.deepEqual(d, { runSafe: true, runLp: true, reason: "both" });
});
check("safe only when LP amount blank", () => {
  const d = planLegs({ safeAmount: "1400", lpReady: true, lpAmountA: "", ackIl: true });
  assert.equal(d.runSafe, true);
  assert.equal(d.runLp, false);
  assert.equal(d.reason, "safe only");
});
check("LP blocked without IL acknowledgement", () => {
  const d = planLegs({ safeAmount: "", lpReady: true, lpAmountA: "3", ackIl: false });
  assert.equal(d.runLp, false);
  assert.equal(d.reason, "lp blocked: acknowledge IL risk");
});
check("LP blocked when vault not loaded", () => {
  const d = planLegs({ safeAmount: "", lpReady: false, lpAmountA: "3", ackIl: true });
  assert.equal(d.runLp, false);
});
check("nothing to deposit when both blank", () => {
  const d = planLegs({ safeAmount: "", lpReady: true, lpAmountA: "", ackIl: true });
  assert.deepEqual(d, { runSafe: false, runLp: false, reason: "nothing to deposit" });
});
check("zero and negative amounts are never deposited", () => {
  assert.equal(planLegs({ safeAmount: "0", lpReady: true, lpAmountA: "-1", ackIl: true }).runSafe, false);
  assert.equal(planLegs({ safeAmount: "0", lpReady: true, lpAmountA: "-1", ackIl: true }).runLp, false);
});
check("non-numeric amount is not deposited", () => {
  assert.equal(planLegs({ safeAmount: "abc", lpReady: true, lpAmountA: "x", ackIl: true }).runSafe, false);
});

// ── phase 2 visibility (admin preview gate) ────────────────────────────────────
const ADMIN = "8i7kydJHwi3Cdp46Xugyux2vWJmTScYDvnJrBiBihBnP";
check("flag on = visible to everyone, not a preview", () => {
  assert.deepEqual(phase2Visible(null, true, ADMIN), { visible: true, adminPreview: false });
  assert.deepEqual(phase2Visible("anyone", true, ADMIN), { visible: true, adminPreview: false });
});
check("flag off + admin = visible, adminPreview", () => {
  assert.deepEqual(phase2Visible(ADMIN, false, ADMIN), { visible: true, adminPreview: true });
});
check("flag off + non-admin = hidden", () => {
  assert.deepEqual(phase2Visible("someoneElse", false, ADMIN), { visible: false, adminPreview: false });
});
check("flag off + disconnected = hidden", () => {
  assert.deepEqual(phase2Visible(null, false, ADMIN), { visible: false, adminPreview: false });
});
check("no admin configured = never a preview", () => {
  assert.deepEqual(phase2Visible(ADMIN, false, undefined), { visible: false, adminPreview: false });
});

// ── portfolio totals (combined "your portfolio" view) ─────────────────────────
check("safeValueUsd: USDC is 1:1", () => assert.equal(safeValueUsd(1500e6, false, 75), 1500));
check("safeValueUsd: SOL prices against SOL", () => assert.equal(safeValueUsd(2e9, true, 75), 150));
check("portfolioTotals sums both vaults in USD", () => {
  const positions = [
    { vault: "U", currentValue: 1500e6, earnedValue: 100e6 },
    { vault: "S", currentValue: 2e9, earnedValue: 0.1e9 },
  ];
  const vaults = [{ address: "U", name: "YieldPilot USDC" }, { address: "S", name: "YieldPilot SOL" }];
  const t = portfolioTotals(positions, vaults, 75);
  assert.equal(Math.round(t.totalValueUsd), 1650);
  approx(t.totalEarnedUsd, 100 + 0.1 * 75);
  assert.equal(t.rows.length, 2);
});
check("portfolioTotals: 'USDC' vault not treated as SOL", () => {
  const t = portfolioTotals([{ vault: "U", currentValue: 500e6, earnedValue: 0 }],
    [{ address: "U", name: "YieldPilot USDC" }], 75);
  assert.equal(Math.round(t.totalValueUsd), 500); // NOT 500*75
});
check("portfolioTotals: empty is zero", () => {
  const t = portfolioTotals([], [], 75);
  assert.equal(t.totalValueUsd, 0);
  assert.equal(t.rows.length, 0);
});
check("portfolioTotals: skips positions with no matching vault", () => {
  const t = portfolioTotals([{ vault: "X", currentValue: 999e6, earnedValue: 0 }], [{ address: "U", name: "USDC" }], 75);
  assert.equal(t.totalValueUsd, 0);
});

console.log(`\n${passed} checks passed`);
