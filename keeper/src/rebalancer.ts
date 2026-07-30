import { ProtocolApy } from "./apyFetcher";
import { VaultState } from "./solanaClient";
import { logger } from "./logger";
import { EPOCH_GATED_PROTOCOLS } from "./epochTracker";

const REBALANCE_THRESHOLD_BPS = parseInt(process.env.REBALANCE_THRESHOLD_BPS || "500");
const MIN_APY_IMPROVEMENT_BPS = parseInt(process.env.MIN_APY_IMPROVEMENT_BPS || "100");
const BPS_DENOM = 10_000;

// Exit cost in bps for each protocol ID.
// Lending protocols (Kamino, Drift, Solend) = 0: instant, no fee.
// Marinade liquid unstake = ~30 bps (0.3%). We require the APY gain to
// exceed this cost before routing OUT of Marinade, so we never rebalance
// at a net loss.
const EXIT_COST_BPS: Record<string, number> = {
  "kamino-usdc":      0,
  "kamino-sol":       0,
  "solend-usdc":      0,
  "marinade-sol":     30, // ~0.3% liquid unstake fee
  "jito-sol":         10, // ~0.1% DEX swap slippage to exit jitoSOL
  // 10 bps read FIRST-PARTY from PSOL's own stake pool account (sol_withdrawal_fee =
  // 10/10000). Cross-validated: the same field on Jito's pool reads 1/1000 = 10 bps,
  // matching the hand-set jito-sol value above — which is what makes the offset
  // interpretation trustworthy rather than a guess.
  "psol-sol":         10,
};

// ─────────────────────────────────────────────────────────────────────────────
// Epoch cooldown
//
// EPOCH_GATED_PROTOCOLS (marinade-sol, jito-sol, psol-sol) only reprice once per
// Solana epoch, because their yield comes from native staking rewards, which land
// once per epoch. Their exit fee, however, is a FLAT bps charge on the full amount
// withdrawn (principal included), charged regardless of how long the position was
// held. Exiting one of these before at least one epoch's worth of accrued yield
// exceeds that flat fee is a guaranteed realized loss — verified 2026-07-30 live:
// 3 SOL at 6% APY held exactly 1 epoch (~2.11 days at current mainnet slot times)
// earns ~0.00104 SOL but pays ~0.003 SOL in exit fee, a net loss ~3x the yield.
// Breakeven scales with APY, not with position size (both fee and yield are
// proportional to principal, so size cancels out of the comparison).
//
// Lending protocols (Kamino, Solend) are NEVER in EPOCH_GATED_PROTOCOLS and this
// check is a no-op for them — they accrue every slot, so there is no "epoch" to
// wait on. Gating them here would mean a USDC-only rebalance waits forever on an
// epoch signal that never fires for a lending market.
// ─────────────────────────────────────────────────────────────────────────────

export interface EpochContext {
  currentEpoch: number;
  epochLengthDays: number;
  /** label -> epoch this protocol slot was last (re)entered at, from epochTracker */
  entryEpochs: Record<string, number>;
}

// Returns true if `label` cannot yet be safely exited given how long it's been held.
// Fails OPEN (does not block) when we have no entry-epoch record for the position —
// that just means this protective check can't be applied yet, not that the underlying
// exit-cost check should be skipped; it still runs independently in computeExitCost.
function epochCooldownBlocksExit(
  label: string,
  apyBps: number,
  ctx: EpochContext | undefined,
): boolean {
  if (!ctx || !EPOCH_GATED_PROTOCOLS.has(label)) return false;
  const entryEpoch = ctx.entryEpochs[label];
  if (entryEpoch === undefined) return false;

  const epochsHeld = ctx.currentEpoch - entryEpoch;
  if (epochsHeld <= 0) return true; // same epoch as entry — earned $0 so far, guaranteed loss

  const exitFeeFrac = (EXIT_COST_BPS[label] ?? 0) / BPS_DENOM;
  const dailyApy = (apyBps / BPS_DENOM) / 365;
  const accruedFrac = epochsHeld * ctx.epochLengthDays * dailyApy;
  return accruedFrac < exitFeeFrac;
}

export interface RebalanceDecision {
  shouldRebalance: boolean;
  reason: string;
  currentAllocations: number[];
  newAllocations: number[];
  expectedApyImprovement: number; // in bps, net of exit costs
}

// ─────────────────────────────────────────────────────────────────────────────
// Core rebalance logic
// ─────────────────────────────────────────────────────────────────────────────

export function computeRebalanceDecision(
  vault: VaultState,
  apys: ProtocolApy[],
  epochContext?: EpochContext,
): RebalanceDecision {
  const protocols = vault.protocols.slice(0, vault.protocolCount);

  const currentAllocations = protocols.map(p => p.targetBps.toNumber());

  // Match APYs to registered protocols by label (not by array index).
  // Index-based matching is fragile: if APY fetcher order diverges from on-chain
  // protocol registration order, funds get routed to the wrong protocol silently.
  const apyByLabel = new Map<string, ProtocolApy>();
  for (const apy of apys) {
    apyByLabel.set(apy.protocolId, apy);
  }

  const protocolLabels = protocols.map(p =>
    Buffer.from(p.label).toString("utf8").replace(/\0/g, "")
  );
  const protocolApys = protocolLabels.map(label => apyByLabel.get(label)?.apyBps || 0);
  const protocolIds  = protocolLabels;

  // ── Refuse to move money we cannot price ──────────────────────────────────
  // If ANY registered protocol fell back to a hardcoded APY (stale), abstain from
  // rebalancing entirely and hold the current allocation.
  //
  // Why abstain rather than route around the stale one: excluding it would drive its
  // target to 0, forcing a FULL EXIT that pays real, unrecoverable protocol fees
  // (marinade ~0.3%, jito ~0.1%) on the basis of a transient API blip. Acting on
  // ignorance is strictly worse than waiting for the next cycle — the funds keep
  // earning wherever they already are in the meantime.
  //
  // This is deliberately asymmetric with the frontend, which merely DISPLAYS stale
  // rates (greyed, sorted last). Displaying a stale number is a cosmetic problem;
  // routing real funds on one is a financial one. See the Solend "5.10%" incident:
  // a hand-typed constant beat every live rate and captured 80% of the USDC vault.
  const staleLabels = protocolLabels.filter(l => {
    const a = apyByLabel.get(l);
    return !a || a.stale;
  });
  if (staleLabels.length > 0) {
    return {
      shouldRebalance: false,
      reason: `Holding — no live APY for ${staleLabels.join(", ")} (fell back to a hardcoded rate). Refusing to reallocate on an unpriceable protocol.`,
      currentAllocations,
      newAllocations: currentAllocations,
      expectedApyImprovement: 0,
    };
  }

  const currentWeightedApy = computeWeightedApy(currentAllocations, protocolApys);

  // Compute the optimal allocation, penalizing protocols with exit costs
  // so we only move out of them when the net gain justifies it.
  const optimalAllocations = computeOptimalAllocations(
    currentAllocations,
    protocolApys,
    protocolIds,
    epochContext,
  );

  const optimalWeightedApy = computeWeightedApy(optimalAllocations, protocolApys);

  // Net APY improvement after accounting for exit costs on any protocol
  // we're reducing allocation to.
  const exitCostBps = computeExitCost(currentAllocations, optimalAllocations, protocolIds);
  const netApyImprovement = (optimalWeightedApy - currentWeightedApy) - exitCostBps;

  const maxDrift = Math.max(
    ...currentAllocations.map((cur, i) => Math.abs(cur - optimalAllocations[i]))
  );

  // Surfaced separately from the reason string so operators can tell "nothing better
  // exists" apart from "something better exists but the epoch cooldown is blocking it" —
  // the two look identical from newAllocations alone (both hold current allocation).
  const cooldownBlocked = protocolIds.some((id, i) =>
    currentAllocations[i] > 0 &&
    EPOCH_GATED_PROTOCOLS.has(id) &&
    epochCooldownBlocksExit(id, protocolApys[i], epochContext)
  );

  logger.debug("Rebalance evaluation", {
    currentWeightedApy:  `${(currentWeightedApy / 100).toFixed(2)}%`,
    optimalWeightedApy:  `${(optimalWeightedApy / 100).toFixed(2)}%`,
    exitCostBps,
    netApyImprovementBps: netApyImprovement,
    maxDriftBps: maxDrift,
    thresholdBps: REBALANCE_THRESHOLD_BPS,
    epochCooldownActive: cooldownBlocked,
  });

  const apyTrigger   = netApyImprovement >= MIN_APY_IMPROVEMENT_BPS;
  const driftTrigger = maxDrift >= REBALANCE_THRESHOLD_BPS && netApyImprovement > 0;
  const shouldRebalance = (driftTrigger || apyTrigger) && vault.autoRebalance;

  // The reason MUST be derived from shouldRebalance, never computed by an independent
  // cascade — otherwise the two drift apart and the log/alert contradicts the action.
  //
  // The old cascade tested `!apyTrigger && exitCostBps > 0` BEFORE driftTrigger, so any
  // drift-triggered rebalance reported "holding position" *while rebalancing*, and that
  // text was posted verbatim to Telegram as "⚡ Rebalanced — ... — holding position".
  // Its arithmetic was wrong too: it printed gross gain vs exit cost (e.g. "6.8bps does
  // not exceed 2bps" — 6.8 plainly does exceed 2) when the actual gate is NET gain vs
  // MIN_APY_IMPROVEMENT_BPS. Branching on shouldRebalance makes contradiction impossible.
  const grossGain = optimalWeightedApy - currentWeightedApy;
  let reason: string;
  if (shouldRebalance) {
    if (driftTrigger && apyTrigger) {
      reason = `Drift ${maxDrift}bps AND net APY gain ${netApyImprovement}bps`;
    } else if (apyTrigger) {
      reason = `Net APY improvement of ${netApyImprovement}bps after exit costs`;
    } else {
      reason = `Allocation drifted ${maxDrift}bps (threshold ${REBALANCE_THRESHOLD_BPS}bps), net APY gain ${netApyImprovement}bps after ${exitCostBps}bps exit cost`;
    }
  } else if (!vault.autoRebalance) {
    reason = "Auto-rebalance is disabled";
  } else if (cooldownBlocked) {
    reason = `Holding — a better rate exists but exiting the current epoch-gated position now would pay the exit fee before enough epochs have passed to earn it back`;
  } else if (grossGain > 0) {
    reason = `Net APY gain ${netApyImprovement}bps (gross ${grossGain}bps - ${exitCostBps}bps exit cost) below the ${MIN_APY_IMPROVEMENT_BPS}bps minimum, and drift ${maxDrift}bps below the ${REBALANCE_THRESHOLD_BPS}bps threshold — holding position`;
  } else {
    reason = "No rebalance needed";
  }

  return {
    shouldRebalance,
    reason,
    currentAllocations,
    newAllocations: shouldRebalance ? optimalAllocations : currentAllocations,
    expectedApyImprovement: netApyImprovement,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exit cost calculator
// Marinade charges ~0.3% on liquid unstake. We compute the weighted cost
// of reducing any protocol's allocation.
// ─────────────────────────────────────────────────────────────────────────────

function computeExitCost(
  current: number[],
  proposed: number[],
  protocolIds: string[],
): number {
  let totalCostBps = 0;
  for (let i = 0; i < current.length; i++) {
    const reduction = current[i] - proposed[i];
    if (reduction > 0) {
      const exitCost = EXIT_COST_BPS[protocolIds[i]] ?? 0;
      // Weight the exit cost by how much of total allocation we're exiting
      totalCostBps += (reduction / BPS_DENOM) * exitCost;
    }
  }
  return Math.round(totalCostBps);
}

// ─────────────────────────────────────────────────────────────────────────────
// Allocation optimizer
// Strategy: 100% to the highest live rate.
//
// This replaced a hardcoded 80/20 split (top protocol / runner-up) on
// 2026-07-21. That split had no risk model behind it — its own comment
// justified it as "matches what we advertise to users", i.e. the number came
// from the marketing copy rather than from any calculation. Parking 20% in a
// second-best rate is simply yield the user does not earn: at the rates that
// day (Marinade 6.08%, Jito 5.17%) the split cost 18bps for nothing anyone
// had chosen.
//
// Churn is already handled and does NOT need the split to damp it: a
// reallocation only fires when the drift exceeds REBALANCE_THRESHOLD_BPS AND
// the gain still beats computeExitCost() — which weights each protocol's exit
// fee by the fraction of allocation actually being moved. Concentration makes
// that cost bigger and therefore the guard stricter, not weaker.
//
// The tradeoff accepted here is single-protocol exposure: 100% in one venue
// means an exploit there takes everything. That is a deliberate product call —
// maximise what users earn, and express risk through which protocols are
// eligible at all (SAFE_PROTOCOLS) rather than through an arbitrary constant.
//
// Never routes to Raydium/Orca LP positions — impermanent loss risk is
// incompatible with principal safety.
// ─────────────────────────────────────────────────────────────────────────────

const SAFE_PROTOCOLS = new Set([
  "kamino-usdc",
  "kamino-sol",
  "solend-usdc",
  "marinade-sol",
  "jito-sol",
  // Phantom Staked SOL. Added 2026-07-21 for candidate variety: under winner-takes-all,
  // a wider eligible set means more chances the top rate in any given hour is genuinely
  // the best one available. Measured on-chain at 6.14% vs Marinade ~6.0% and Jito 5.22% —
  // close enough to Marinade that it is NOT a guaranteed upgrade, which is exactly why it
  // belongs in the candidate set rather than being hardwired as the destination.
  "psol-sol",
]);

function computeOptimalAllocations(
  currentAllocations: number[],
  protocolApys: number[],
  protocolIds: string[],
  epochContext?: EpochContext,
): number[] {
  const n = currentAllocations.length;
  if (n === 0) return [];
  if (n === 1) return [BPS_DENOM];

  // Filter to safe (non-LP) protocols only
  const eligible = protocolApys
    .map((apy, i) => ({ i, apy, id: protocolIds[i] }))
    .filter(p => SAFE_PROTOCOLS.has(p.id) || !p.id) // include unknown (devnet mocks)
    .sort((a, b) => b.apy - a.apy);

  const allocations = Array(n).fill(0);

  if (eligible.length === 0) {
    // Fallback: equal weight across all
    const equal = Math.floor(BPS_DENOM / n);
    return allocations.map((_, i) => i === 0 ? equal + (BPS_DENOM - equal * n) : equal);
  }

  // Winner takes all — but the winner is the one with the best NET gain, not the
  // highest headline APY.
  //
  // WHY THIS IS NOT JUST eligible[0]. Proposing only the top-APY protocol and letting
  // the caller reject it on cost means that when the best rate is unreachable, the
  // keeper does NOTHING — even if moving somewhere else is clearly profitable.
  //
  // Observed live 2026-07-22 on the SOL vault (jito 2000 / marinade 8000):
  //   -> psol-sol      gross +22.5bps, exit 26.0 (must leave BOTH legs)  = NET  -3.5
  //   -> marinade-sol  gross +17.4bps, exit  2.0 (only jito's 20% moves) = NET +15.4
  // psol had the higher rate, so it was the only candidate considered, it failed the
  // cost check, and the vault sat at 5.900% while 6.074% was available for 2bps.
  // Leaving 15.4bps on the table indefinitely is the opposite of the goal.
  //
  // So: score EVERY eligible destination net of what it actually costs to get there,
  // and pick the best. Exit cost depends on where the funds currently sit, which is
  // why the top rate is not automatically the right move.
  const currentApy = computeWeightedApy(currentAllocations, protocolApys);
  let best: { alloc: number[]; net: number } | null = null;

  for (const cand of eligible) {
    const proposed = Array(n).fill(0);
    proposed[cand.i] = BPS_DENOM;

    // Epoch cooldown: skip any candidate that requires exiting a gated position before
    // it's been held long enough for accrued yield to exceed its flat exit fee. See the
    // block comment above EPOCH_GATED_PROTOCOLS / epochCooldownBlocksExit.
    const blockedByCooldown = protocolIds.some((id, i) =>
      currentAllocations[i] > proposed[i] &&
      epochCooldownBlocksExit(id, protocolApys[i], epochContext)
    );
    if (blockedByCooldown) continue;

    const gross = (computeWeightedApy(proposed, protocolApys) - currentApy) * 100; // bps
    const net = gross - computeExitCost(currentAllocations, proposed, protocolIds);
    if (!best || net > best.net) best = { alloc: proposed, net };
  }

  // If no destination is profitable after costs (or every profitable one is
  // cooldown-blocked), stay put. Returning the current allocation makes drift zero, so
  // the caller's threshold check will not fire — the keeper holds rather than churning
  // for a loss, or forcing an exit that would realize one.
  if (!best || best.net <= 0) return [...currentAllocations];
  return best.alloc;
}

function computeWeightedApy(allocations: number[], apys: number[]): number {
  if (allocations.length === 0) return 0;
  const total = allocations.reduce((s, a) => s + a, 0);
  if (total === 0) return 0;
  return allocations.reduce((sum, bps, i) => sum + bps * (apys[i] || 0), 0) / total;
}

// ─────────────────────────────────────────────────────────────────────────────
// Compound decision
// ─────────────────────────────────────────────────────────────────────────────

export function shouldCompound(vault: VaultState): { compound: boolean; reason: string } {
  if (!vault.autoCompound) {
    return { compound: false, reason: "Auto-compound is disabled" };
  }

  // Compounding an empty vault is a guaranteed no-op: it burns a keeper tx fee every
  // cycle AND fires a "🔄 Compounded" Telegram alert, which reads to a user as
  // "your money is earning" when the vault holds nothing. Found 2026-07-16: the empty
  // SOL vault was alerting on every 45-min cycle alongside the funded USDC vault.
  if (vault.totalDeposits.isZero()) {
    return { compound: false, reason: "Vault is empty — nothing to compound" };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const lastCompound = vault.lastCompoundTs.toNumber();
  const elapsed = nowSec - lastCompound;
  const COMPOUND_INTERVAL = 3600; // must match program constant

  if (elapsed < COMPOUND_INTERVAL) {
    const waitMin = Math.ceil((COMPOUND_INTERVAL - elapsed) / 60);
    return {
      compound: false,
      reason: `Too early — ${waitMin}min until compound interval`,
    };
  }

  return {
    compound: true,
    reason: `${Math.floor(elapsed / 60)}min since last compound`,
  };
}
