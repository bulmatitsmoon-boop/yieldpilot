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
}

export interface LpRepositionDecision {
  shouldReposition: boolean;
  reason: string;
  newTickLowerIndex: number;
  newTickUpperIndex: number;
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
 * The suggested new range keeps the same width as the old one, re-centered
 * on the current tick and rounded to valid tickSpacing multiples (both
 * Whirlpool and Raydium CLMM reject tick indices that aren't a multiple of
 * the pool's tick spacing).
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
  const newTickLowerIndex = align(tickCurrent - halfWidth);
  const newTickUpperIndex = align(tickCurrent + halfWidth);

  if (!vault.positionActive) {
    return {
      shouldReposition: false,
      reason: "No active position (already mid-reposition, or never opened) — nothing for the keeper to evaluate here.",
      newTickLowerIndex,
      newTickUpperIndex,
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
  });

  return { shouldReposition, reason, newTickLowerIndex, newTickUpperIndex };
}
