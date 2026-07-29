/**
 * portfolio.mjs — pure math for the combined "your portfolio" view on /portfolio.
 *
 * Rolls a user's safe-vault positions into one USD total + earned figure, so the view can
 * show "here's everything you hold across both vaults" without any of the arithmetic living
 * in the React component. Tested in scripts/verify-split-deposit.mjs against the same code
 * the page ships.
 *
 * The LP position is deliberately NOT valued here: its USD value needs a live pool quote
 * (fees + impermanent loss), which is an async chain call, not pure math. The view shows the
 * LP position's presence and shares, and links to the LP page for its live value.
 */

/**
 * USD value of one safe position. Balances are raw base units; SOL vaults price against SOL.
 * @param {number} currentValueBase  raw base units (6dp USDC, 9dp SOL)
 * @param {boolean} isSol
 * @param {number} solPriceUsd
 * @returns {number}
 */
export function safeValueUsd(currentValueBase, isSol, solPriceUsd) {
  const dec = isSol ? 1e9 : 1e6;
  const units = (Number(currentValueBase) || 0) / dec;
  return isSol ? units * (Number(solPriceUsd) || 0) : units;
}

/**
 * Roll all safe positions into a combined total.
 * @param {Array<{vault:string,currentValue:number,earnedValue:number}>} positions
 * @param {Array<{address:string,name:string}>} vaults
 * @param {number} solPriceUsd
 * @returns {{ totalValueUsd:number, totalEarnedUsd:number, rows:Array<{name:string,valueUsd:number,earnedUsd:number}> }}
 */
export function portfolioTotals(positions, vaults, solPriceUsd) {
  const byAddr = new Map((vaults || []).map((v) => [v.address, v]));
  let totalValueUsd = 0;
  let totalEarnedUsd = 0;
  const rows = [];
  for (const p of positions || []) {
    const v = byAddr.get(p.vault);
    if (!v) continue;
    const isSol = /SOL/i.test(v.name) && !/USD/i.test(v.name);
    const valueUsd = safeValueUsd(p.currentValue, isSol, solPriceUsd);
    const earnedUsd = safeValueUsd(p.earnedValue, isSol, solPriceUsd);
    totalValueUsd += valueUsd;
    totalEarnedUsd += earnedUsd;
    rows.push({ name: v.name, valueUsd, earnedUsd });
  }
  return { totalValueUsd, totalEarnedUsd, rows };
}
