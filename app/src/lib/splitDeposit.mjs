/**
 * splitDeposit.mjs — the pure logic behind the /portfolio split-deposit screen.
 *
 * Kept as a standalone module (not inlined in the React component) for one reason: it is
 * the only genuinely NEW logic the split-deposit feature adds, and pulling it out here
 * makes it testable without a wallet, a browser, or a validator. scripts/verify-split-
 * deposit.mjs exercises exactly these functions — the same code the page ships — so the
 * test can never drift from the component the way a re-implementation would.
 *
 * Everything here is pure: numbers in, numbers/decisions out. No chain calls, no BN, no
 * React. The transaction-building lives in the hooks (useYieldPilot / useLpVault) and is
 * proven separately (program paths on the harness, hook paths in live use).
 */

/**
 * Blended APY of a safe/LP split.
 * @param {number} safePct  percent (0..100) allocated to the safe vault
 * @param {number} safeApy  safe vault APY, as a percent (e.g. 6.1)
 * @param {number} lpApy    LP vault fee APY, as a percent (e.g. 34)
 * @returns {number} blended APY as a percent
 */
export function blendedApy(safePct, safeApy, lpApy) {
  const s = clampPct(safePct);
  return (safeApy * s + lpApy * (100 - s)) / 100;
}

/**
 * Dollar split of a plan amount.
 * @param {number} planUsd  total capital being planned
 * @param {number} safePct  percent (0..100) to the safe vault
 * @returns {{ safeUsd: number, lpUsd: number }}
 */
export function splitAmounts(planUsd, safePct) {
  const s = clampPct(safePct);
  const total = Number.isFinite(planUsd) && planUsd > 0 ? planUsd : 0;
  const safeUsd = (total * s) / 100;
  return { safeUsd, lpUsd: total - safeUsd };
}

/**
 * Estimated yearly yield in dollars for a plan.
 * @param {number} planUsd
 * @param {number} blended  blended APY as a percent
 * @returns {number} rounded dollars
 */
export function estYearly(planUsd, blended) {
  const total = Number.isFinite(planUsd) && planUsd > 0 ? planUsd : 0;
  return Math.round((total * blended) / 100);
}

/**
 * Decide which deposit legs to run — the orchestration the "Deposit into both vaults"
 * button follows. This is where the honesty constraints live: the LP leg cannot fire
 * without a loaded LP vault, a positive token-A amount, AND the impermanent-loss
 * acknowledgement. A blank leg is skipped, never sent as a zero deposit.
 *
 * @param {object} p
 * @param {string} p.safeAmount   raw text from the safe amount input
 * @param {boolean} p.lpReady     an LP vault has been loaded (both tokens known)
 * @param {string} p.lpAmountA    raw text from the LP token-A input
 * @param {boolean} p.ackIl       user acknowledged impermanent-loss risk
 * @returns {{ runSafe: boolean, runLp: boolean, reason: string }}
 */
export function planLegs({ safeAmount, lpReady, lpAmountA, ackIl }) {
  const runSafe = isPositiveAmount(safeAmount);
  const runLp = lpReady === true && isPositiveAmount(lpAmountA) && ackIl === true;

  let reason;
  if (runSafe && runLp) reason = "both";
  else if (runSafe) reason = "safe only";
  else if (runLp) reason = "lp only";
  else if (lpReady && isPositiveAmount(lpAmountA) && !ackIl) reason = "lp blocked: acknowledge IL risk";
  else reason = "nothing to deposit";

  return { runSafe, runLp, reason };
}

/** @param {string} v @returns {boolean} */
function isPositiveAmount(v) {
  if (typeof v !== "string") return false;
  const n = Number(v.trim());
  return Number.isFinite(n) && n > 0;
}

/** @param {number} p @returns {number} */
function clampPct(p) {
  if (!Number.isFinite(p)) return 0;
  return Math.min(100, Math.max(0, p));
}
