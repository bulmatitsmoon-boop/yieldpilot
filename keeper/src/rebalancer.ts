import { ProtocolApy } from "./apyFetcher";
import { VaultState } from "./solanaClient";
import { logger } from "./logger";

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
  "marginfi-usdc":    0,
  "marginfi-sol":     0,
  "drift-sol":        0,
  "solend-usdc":      0,
  "marinade-sol":     30, // ~0.3% liquid unstake fee
  "jito-sol":         10, // ~0.1% DEX swap slippage to exit jitoSOL
  "blazestake-sol":   8,  // <0.1% DEX swap slippage to exit bSOL
};

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
  apys: ProtocolApy[]
): RebalanceDecision {
  const protocols = vault.protocols.slice(0, vault.protocolCount);
  const currentAllocations = protocols.map(p => p.targetBps.toNumber());

  // Match APYs to registered protocols by index position
  const protocolApys = protocols.map((_, i) => apys[i]?.apyBps || 0);
  const protocolIds  = protocols.map((_, i) => apys[i]?.protocolId || "");

  const currentWeightedApy = computeWeightedApy(currentAllocations, protocolApys);

  // Compute the optimal allocation, penalizing protocols with exit costs
  // so we only move out of them when the net gain justifies it.
  const optimalAllocations = computeOptimalAllocations(
    currentAllocations,
    protocolApys,
    protocolIds,
  );

  const optimalWeightedApy = computeWeightedApy(optimalAllocations, protocolApys);

  // Net APY improvement after accounting for exit costs on any protocol
  // we're reducing allocation to.
  const exitCostBps = computeExitCost(currentAllocations, optimalAllocations, protocolIds);
  const netApyImprovement = (optimalWeightedApy - currentWeightedApy) - exitCostBps;

  const maxDrift = Math.max(
    ...currentAllocations.map((cur, i) => Math.abs(cur - optimalAllocations[i]))
  );

  logger.debug("Rebalance evaluation", {
    currentWeightedApy:  `${(currentWeightedApy / 100).toFixed(2)}%`,
    optimalWeightedApy:  `${(optimalWeightedApy / 100).toFixed(2)}%`,
    exitCostBps,
    netApyImprovementBps: netApyImprovement,
    maxDriftBps: maxDrift,
    thresholdBps: REBALANCE_THRESHOLD_BPS,
  });

  const apyTrigger   = netApyImprovement >= MIN_APY_IMPROVEMENT_BPS;
  const driftTrigger = maxDrift >= REBALANCE_THRESHOLD_BPS && netApyImprovement > 0;
  const shouldRebalance = (driftTrigger || apyTrigger) && vault.autoRebalance;

  let reason = "No rebalance needed";
  if (!vault.autoRebalance) {
    reason = "Auto-rebalance is disabled";
  } else if (!apyTrigger && exitCostBps > 0) {
    reason = `APY gain (${(optimalWeightedApy - currentWeightedApy)}bps) does not exceed exit cost (${exitCostBps}bps) — holding position`;
  } else if (driftTrigger && apyTrigger) {
    reason = `Drift ${maxDrift}bps AND net APY gain ${netApyImprovement}bps`;
  } else if (driftTrigger) {
    reason = `Allocation drifted ${maxDrift}bps (threshold: ${REBALANCE_THRESHOLD_BPS}bps)`;
  } else if (apyTrigger) {
    reason = `Net APY improvement of ${netApyImprovement}bps after exit costs`;
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
// Strategy: 80% to top protocol, 20% to runner-up (as advertised).
// Never routes to Raydium/Orca LP positions — impermanent loss risk is
// incompatible with principal safety.
// ─────────────────────────────────────────────────────────────────────────────

const SAFE_PROTOCOLS = new Set([
  "kamino-usdc",
  "kamino-sol",
  "marginfi-usdc",
  "marginfi-sol",
  "drift-sol",
  "solend-usdc",
  "marinade-sol",
  "jito-sol",
  "blazestake-sol",
]);

function computeOptimalAllocations(
  currentAllocations: number[],
  protocolApys: number[],
  protocolIds: string[],
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

  if (eligible.length === 1) {
    allocations[eligible[0].i] = BPS_DENOM;
    return allocations;
  }

  // 80/20 split — matches what we advertise to users
  allocations[eligible[0].i] = 8000;
  allocations[eligible[1].i] = 2000;

  // Any remaining ineligible protocols (LP) stay at 0
  return allocations;
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
