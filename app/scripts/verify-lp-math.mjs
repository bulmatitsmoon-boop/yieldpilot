/**
 * verify-lp-math.mjs — standalone correctness check for the LP vault's
 * share math and both protocols' liquidity/quote math.
 *
 * Run: `node scripts/verify-lp-math.mjs` (from app/) or `npm run
 * verify:lp-math`. No local validator, devnet RPC, or wallet needed — this
 * only exercises pure math, using the exact same real Orca (@orca-so/
 * whirlpools-core, WASM) and Raydium (@raydium-io/raydium-sdk-v2)
 * primitives that useLpVault.ts calls, not hand-rolled reimplementations.
 *
 * calculateDepositShares/calculateWithdrawLiquidity below are a JS mirror
 * of lp_vault.rs's calculate_deposit_shares/calculate_withdraw_liquidity —
 * keep them in sync if that Rust math changes.
 */
import assert from "node:assert/strict";
import BN from "bn.js";
import { LiquidityMathUtil, TickUtil } from "@raydium-io/raydium-sdk-v2";
import { increaseLiquidityQuoteA, decreaseLiquidityQuote } from "@orca-so/whirlpools-core";

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

// ── 1. Share math (mirrors lp_vault.rs's calculate_deposit_shares /
//    calculate_withdraw_liquidity) ─────────────────────────────────────────
function calculateDepositShares(liquidityAmount, totalLiquidity, totalShares) {
  if (totalShares === 0n || totalLiquidity === 0n) {
    const capped = liquidityAmount > (2n ** 64n - 1n) ? (2n ** 64n - 1n) : liquidityAmount;
    return capped;
  }
  return (liquidityAmount * totalShares) / totalLiquidity;
}
function calculateWithdrawLiquidity(shares, totalLiquidity, totalShares) {
  return (shares * totalLiquidity) / totalShares;
}

check("first depositor mints 1:1", () => {
  const shares = calculateDepositShares(1_000_000n, 0n, 0n);
  assert.equal(shares, 1_000_000n);
});

check("second depositor mints proportionally", () => {
  const shares = calculateDepositShares(500_000n, 1_000_000n, 1_000_000n);
  assert.equal(shares, 500_000n);
});

check("deposit/withdraw round-trip preserves proportional liquidity", () => {
  let totalLiquidity = 0n, totalShares = 0n;
  const s1 = calculateDepositShares(1_000_000n, totalLiquidity, totalShares);
  totalLiquidity += 1_000_000n; totalShares += s1;
  const s2 = calculateDepositShares(3_000_000n, totalLiquidity, totalShares);
  totalLiquidity += 3_000_000n; totalShares += s2;
  const withdrawn = calculateWithdrawLiquidity(s2, totalLiquidity, totalShares);
  assert.equal(withdrawn, 3_000_000n);
  const withdrawn1 = calculateWithdrawLiquidity(s1, totalLiquidity, totalShares);
  assert.equal(withdrawn1, 1_000_000n);
});

check("uneven deposit rounds down (never over-mints shares)", () => {
  const shares = calculateDepositShares(1n, 1_000_000n, 999_999n);
  assert.equal(shares, 0n);
});

// ── 2. Orca real quote math round-trip ──────────────────────────────────────
check("Orca: deposit quote then withdraw quote round-trips within slippage bounds", () => {
  const sqrtPrice = 18446744073709551616n; // price = 1.0 (Q64.64: 1 << 64)
  const tickLower = -1000;
  const tickUpper = 1000;
  const tokenAAmount = 1_000_000n;
  const slippageBps = 100;

  const depositQuote = increaseLiquidityQuoteA(tokenAAmount, slippageBps, sqrtPrice, tickLower, tickUpper);
  assert.ok(depositQuote.liquidityDelta > 0n, "liquidityDelta should be positive");
  assert.ok(depositQuote.tokenMaxA >= depositQuote.tokenEstA, "max should be >= est (slippage headroom)");
  assert.ok(depositQuote.tokenMaxB >= depositQuote.tokenEstB, "max should be >= est (slippage headroom)");

  const withdrawQuote = decreaseLiquidityQuote(depositQuote.liquidityDelta, slippageBps, sqrtPrice, tickLower, tickUpper);
  assert.ok(withdrawQuote.tokenMinA <= withdrawQuote.tokenEstA, "min should be <= est (slippage headroom)");
  assert.ok(withdrawQuote.tokenMinB <= withdrawQuote.tokenEstB, "min should be <= est (slippage headroom)");

  const diffA = depositQuote.tokenEstA > withdrawQuote.tokenEstA
    ? depositQuote.tokenEstA - withdrawQuote.tokenEstA
    : withdrawQuote.tokenEstA - depositQuote.tokenEstA;
  assert.ok(diffA < 10n, `round-trip token A drift too large: ${diffA}`);
});

// ── 3. Raydium real quote math round-trip ───────────────────────────────────
check("Raydium: deposit quote then withdraw quote round-trips within slippage bounds", () => {
  const tickLower = -1000;
  const tickUpper = 1000;
  const sqrtPriceCurrentX64 = TickUtil.getSqrtPriceAtTick(0);
  const sqrtPriceLowerX64 = TickUtil.getSqrtPriceAtTick(tickLower);
  const sqrtPriceUpperX64 = TickUtil.getSqrtPriceAtTick(tickUpper);
  const tokenAAmount = new BN(1_000_000);
  const hugeAmountB = new BN(2).pow(new BN(64)).subn(1);
  const slippage = 0.01;

  const liquidityDelta = LiquidityMathUtil.getLiquidityFromAmounts(
    sqrtPriceCurrentX64, sqrtPriceLowerX64, sqrtPriceUpperX64, tokenAAmount, hugeAmountB
  );
  assert.ok(liquidityDelta.gtn(0), "liquidityDelta should be positive");

  const { amountA: exactA, amountB: exactB } = LiquidityMathUtil.getAmountsForLiquidity(
    sqrtPriceCurrentX64, sqrtPriceLowerX64, sqrtPriceUpperX64, liquidityDelta, true
  );
  const diffA = exactA.sub(tokenAAmount).abs();
  assert.ok(diffA.ltn(10), `computed exact amountA drifted too far from requested: ${diffA.toString()}`);

  const { amountSlippageA: maxA, amountSlippageB: maxB } = LiquidityMathUtil.getAmountsFromLiquidityWithSlippage(
    sqrtPriceCurrentX64, sqrtPriceLowerX64, sqrtPriceUpperX64, liquidityDelta, true, true, slippage
  );
  assert.ok(maxA.gte(exactA), "slippage-adjusted max A should be >= exact A");
  assert.ok(maxB.gte(exactB), "slippage-adjusted max B should be >= exact B");

  const { amountSlippageA: minA, amountSlippageB: minB } = LiquidityMathUtil.getAmountsFromLiquidityWithSlippage(
    sqrtPriceCurrentX64, sqrtPriceLowerX64, sqrtPriceUpperX64, liquidityDelta, false, false, slippage
  );
  assert.ok(minA.lte(exactA), "slippage-adjusted min A should be <= exact A");
  assert.ok(minB.lte(exactB), "slippage-adjusted min B should be <= exact B");

  const diffRoundTrip = exactA.sub(tokenAAmount).abs();
  assert.ok(diffRoundTrip.ltn(10), `round-trip token A drift too large: ${diffRoundTrip.toString()}`);
});

check("Raydium: price below range uses token A only (matches Orca's analogous case)", () => {
  const tickLower = 1000;
  const tickUpper = 2000;
  const sqrtPriceCurrentX64 = TickUtil.getSqrtPriceAtTick(0);
  const sqrtPriceLowerX64 = TickUtil.getSqrtPriceAtTick(tickLower);
  const sqrtPriceUpperX64 = TickUtil.getSqrtPriceAtTick(tickUpper);
  const tokenAAmount = new BN(1_000_000);
  const hugeAmountB = new BN(2).pow(new BN(64)).subn(1);

  const liquidityDelta = LiquidityMathUtil.getLiquidityFromAmounts(
    sqrtPriceCurrentX64, sqrtPriceLowerX64, sqrtPriceUpperX64, tokenAAmount, hugeAmountB
  );
  const { amountA, amountB } = LiquidityMathUtil.getAmountsForLiquidity(
    sqrtPriceCurrentX64, sqrtPriceLowerX64, sqrtPriceUpperX64, liquidityDelta, true
  );
  assert.ok(amountB.eqn(0), `expected zero token B when price is below range, got ${amountB.toString()}`);
  assert.ok(amountA.gtn(0));
});

console.log(`\n${passed} check(s) passed.`);
