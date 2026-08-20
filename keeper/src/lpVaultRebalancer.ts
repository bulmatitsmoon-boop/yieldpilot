import { logger } from "./logger";

/**
 * Keeper decision logic for LP vault repositioning — protocol-agnostic
 * (Orca and Raydium both express price ranges as i32 tick indices, so this
 * module doesn't need to know which protocol a given vault uses; the
 * caller is responsible for actually invoking exit_*_lp_position /
 * open_new_*_lp_position with the right protocol-specific instruction).
 *
 * Mirrors rebalancer.ts's shape (pure decision function taking state in,
 * returning a decision struct, no chain calls inside) for the same reason:
 * keep the "should we act" logic independently testable from the "how do
 * we act" plumbing.
 */

const REPOSITION_BUFFER_BPS = parseInt(process.env.LP_REPOSITION_BUFFER_BPS || "1000"); // 10% of range width
const BPS_DENOM = 10_000;

export interface LpVaultRangeState {
  tickLowerIndex: number;
  tickUpperIndex: number;
  tickSpacing: number;
  positionActive: boolean;
  /**
   * Raw token balances the vault will have available to redeploy. Optional so
   * existing callers keep working — omit them and the range is centred as before.
   *
   * Supply them whenever they are known: a position that has drifted out of range
   * is converted almost entirely into ONE token, and a centred range cannot be
   * funded from one-sided holdings. See computeLpRepositionDecision.
   */
  idleAmountA?: number;
  idleAmountB?: number;
}

export interface LpRepositionDecision {
  shouldReposition: boolean;
  reason: string;
  newTickLowerIndex: number;
  newTickUpperIndex: number;
  /**
   * Which side of the current price the suggested range sits on:
   *   "both"  — straddles the current tick (vault holds a usable mix)
   *   "aboveA"— entirely above the current tick, fundable with token A alone
   *   "belowB"— entirely below the current tick, fundable with token B alone
   */
  rangeShape: "both" | "aboveA" | "belowB";
}

/**
 * Decide whether an LP vault's active position needs to be exited and
 * reopened at a new price range, given the pool's current tick.
 *
 * Two triggers:
 * - Out of range: current tick has left [tickLowerIndex, tickUpperIndex]
 *   entirely — the position earns zero trading fees while this is true, so
 *   this is always a reposition.
 * - Near edge: current tick is within a configurable buffer (default 10%
 *   of the range width) of either edge — a preemptive signal so the keeper
 *   doesn't only react after fees have already stopped accruing.
 *
 * The suggested new range keeps the same width as the old one and is rounded to
 * valid tickSpacing multiples (both Whirlpool and Raydium CLMM reject tick indices
 * that aren't a multiple of the pool's tick spacing).
 *
 * WHERE it is placed depends on what the vault can actually fund. Pass
 * idleAmountA/idleAmountB and a lopsided balance produces a SINGLE-SIDED range on
 * the fundable side instead of a centred one — see the comment inside. Omit them
 * and the range is centred, which is only correct when the vault holds a usable
 * mix of both tokens.
 */
export function computeLpRepositionDecision(
  vault: LpVaultRangeState,
  tickCurrent: number
): LpRepositionDecision {
  const rangeWidth = vault.tickUpperIndex - vault.tickLowerIndex;
  if (rangeWidth <= 0) {
    throw new Error(
      `Invalid LP vault range: tickLowerIndex (${vault.tickLowerIndex}) >= tickUpperIndex (${vault.tickUpperIndex})`
    );
  }
  if (vault.tickSpacing <= 0) {
    throw new Error(`Invalid tickSpacing: ${vault.tickSpacing}`);
  }

  const align = (t: number) => Math.round(t / vault.tickSpacing) * vault.tickSpacing;
  const halfWidth = Math.floor(rangeWidth / 2);

  // ── Side-aware range selection ────────────────────────────────────────────
  //
  // A centred range needs BOTH tokens. But the position we are about to replace
  // drifted out of range, and concentrated liquidity converts fully to one side
  // when that happens: price below the range leaves 100% token A, price above it
  // leaves 100% token B. Proposing a centred range in that state produces a
  // redeploy that cannot be funded — the exit succeeds, the re-entry fails, and
  // the vault sits in cash earning nothing. Measured on the harness 2026-07-24:
  // 33.43 WSOL stranded after an otherwise-successful reposition.
  //
  // So when the holdings are lopsided, put the range entirely on the side that
  // the token we actually hold can fund by itself:
  //   * mostly token A -> range strictly ABOVE the current tick
  //   * mostly token B -> range strictly BELOW the current tick
  //
  // Valuing the two sides: in RAW units the pool price is 1.0001^tick token-B per
  // token-A, which already accounts for differing decimals, so no decimals input
  // is needed here.
  const SINGLE_SIDED_THRESHOLD = 0.95;
  let rangeShape: "both" | "aboveA" | "belowB" = "both";
  let newTickLowerIndex: number;
  let newTickUpperIndex: number;

  const a = vault.idleAmountA;
  const b = vault.idleAmountB;
  let shareA: number | null = null;

  if (typeof a === "number" && typeof b === "number" && (a > 0 || b > 0)) {
    // Explicit balances win when the caller knows them (e.g. recovering a vault
    // that is already sitting in cash).
    const priceBperA = Math.pow(1.0001, tickCurrent);
    const bInA = priceBperA > 0 ? b / priceBperA : 0;
    const total = a + bInA;
    shareA = total > 0 ? a / total : null;
  } else {
    // Otherwise INFER the post-exit composition from the tick's position relative
    // to the range we are about to leave. This is exact in concentrated liquidity,
    // and it matters because the caller CANNOT supply real balances here: at
    // decision time the funds are still inside the position, so the vault's token
    // accounts read ~zero and would look "balanced" to any balance-based check.
    //
    //   tick <= tickLower : price fell through the range -> position is 100% token A
    //   tick >= tickUpper : price rose through the range -> position is 100% token B
    //   in between        : genuinely a mix, so a centred range is fundable
    if (tickCurrent <= vault.tickLowerIndex) shareA = 1;
    else if (tickCurrent >= vault.tickUpperIndex) shareA = 0;
    else shareA = null;
  }

  if (shareA !== null && shareA >= SINGLE_SIDED_THRESHOLD) {
    // Almost all token A. A range above spot is funded by token A alone.
    rangeShape = "aboveA";
    newTickLowerIndex = align(tickCurrent) + vault.tickSpacing;
    newTickUpperIndex = newTickLowerIndex + align(rangeWidth);
  } else if (shareA !== null && shareA <= 1 - SINGLE_SIDED_THRESHOLD) {
    // Almost all token B. A range below spot is funded by token B alone.
    rangeShape = "belowB";
    newTickUpperIndex = align(tickCurrent) - vault.tickSpacing;
    newTickLowerIndex = newTickUpperIndex - align(rangeWidth);
  } else {
    newTickLowerIndex = align(tickCurrent - halfWidth);
    newTickUpperIndex = align(tickCurrent + halfWidth);
  }

  if (!vault.positionActive) {
    return {
      shouldReposition: false,
      reason: "No active position (already mid-reposition, or never opened) — nothing for the keeper to evaluate here.",
      newTickLowerIndex,
      newTickUpperIndex,
      rangeShape,
    };
  }

  const buffer = Math.floor((rangeWidth * REPOSITION_BUFFER_BPS) / BPS_DENOM);
  const outOfRange = tickCurrent < vault.tickLowerIndex || tickCurrent > vault.tickUpperIndex;
  const nearEdge = !outOfRange && (
    tickCurrent < vault.tickLowerIndex + buffer || tickCurrent > vault.tickUpperIndex - buffer
  );
  const shouldReposition = outOfRange || nearEdge;

  let reason: string;
  if (outOfRange) {
    reason = `Current tick ${tickCurrent} is outside the active range [${vault.tickLowerIndex}, ${vault.tickUpperIndex}] — position is earning zero fees. Reposition needed.`;
  } else if (nearEdge) {
    reason = `Current tick ${tickCurrent} is within the ${REPOSITION_BUFFER_BPS}bps buffer zone of range edge [${vault.tickLowerIndex}, ${vault.tickUpperIndex}] — preemptive reposition recommended.`;
  } else {
    reason = `Current tick ${tickCurrent} is comfortably inside range [${vault.tickLowerIndex}, ${vault.tickUpperIndex}]. No action needed.`;
  }

  logger.debug("LP reposition evaluation", {
    tickCurrent,
    tickLowerIndex: vault.tickLowerIndex,
    tickUpperIndex: vault.tickUpperIndex,
    rangeWidth,
    buffer,
    outOfRange,
    nearEdge,
    shouldReposition,
    rangeShape,
    shareA,
    newTickLowerIndex,
    newTickUpperIndex,
  });

  return { shouldReposition, reason, newTickLowerIndex, newTickUpperIndex, rangeShape };
}
