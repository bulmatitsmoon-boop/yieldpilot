import { ProtocolApy } from "./apyFetcher";
import { VaultState } from "./solanaClient";
import { logger } from "./logger";

const REBALANCE_THRESHOLD_BPS = parseInt(process.env.REBALANCE_THRESHOLD_BPS || "500");
const MIN_APY_IMPROVEMENT_BPS = parseInt(process.env.MIN_APY_IMPROVEMENT_BPS || "100");
const BPS_DENOM = 10_000;

export interface RebalanceDecision {
  shouldRebalance: boolean;
  reason: string;
  currentAllocations: number[];
  newAllocations: number[];
  expectedApyImprovement: number; // in bps
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

  // Build APY lookup by protocol pubkey
  // In production, the vault would store protocol IDs mapped to on-chain keys
  // Here we match by index position (same order as registered)
  const protocolApys = protocols.map((_, i) => apys[i]?.apyBps || 0);

  // ── Check 1: Has any protocol drifted significantly? ─────────────────────
  // (In a real system, currentBalance would reflect actual deployed funds;
  //  here we check if target allocations are stale relative to best available)
  const bestApy = Math.max(...protocolApys);
  const currentWeightedApy = computeWeightedApy(currentAllocations, protocolApys);

  // ── Check 2: Compute optimal allocation ──────────────────────────────────
  const optimalAllocations = computeOptimalAllocations(
    currentAllocations,
    protocolApys,
    vault
  );

  const optimalWeightedApy = computeWeightedApy(optimalAllocations, protocolApys);
  const apyImprovement = optimalWeightedApy - currentWeightedApy;

  // ── Check 3: Drift from targets ───────────────────────────────────────────
  const maxDrift = Math.max(
    ...currentAllocations.map((cur, i) => Math.abs(cur - optimalAllocations[i]))
  );

  logger.debug("Rebalance evaluation", {
    currentWeightedApy: `${(currentWeightedApy / 100).toFixed(2)}%`,
    optimalWeightedApy: `${(optimalWeightedApy / 100).toFixed(2)}%`,
    apyImprovementBps: apyImprovement,
    maxDriftBps: maxDrift,
    thresholdBps: REBALANCE_THRESHOLD_BPS,
  });

  const driftTrigger = maxDrift >= REBALANCE_THRESHOLD_BPS;
  const apyTrigger = apyImprovement >= MIN_APY_IMPROVEMENT_BPS;
  const shouldRebalance = (driftTrigger || apyTrigger) && vault.autoRebalance;

  let reason = "No rebalance needed";
  if (!vault.autoRebalance) {
    reason = "Auto-rebalance is disabled";
  } else if (driftTrigger && apyTrigger) {
    reason = `Drift ${maxDrift}bps > threshold AND APY improvement ${apyImprovement}bps`;
  } else if (driftTrigger) {
    reason = `Allocation drifted ${maxDrift}bps (threshold: ${REBALANCE_THRESHOLD_BPS}bps)`;
  } else if (apyTrigger) {
    reason = `APY improvement of ${apyImprovement}bps available (min: ${MIN_APY_IMPROVEMENT_BPS}bps)`;
  }

  return {
    shouldRebalance,
    reason,
    currentAllocations,
    newAllocations: shouldRebalance ? optimalAllocations : currentAllocations,
    expectedApyImprovement: apyImprovement,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Allocation optimizer
// Strategy: greedy — weight toward highest APY protocols
//           while respecting risk limits and minimum diversification
// ─────────────────────────────────────────────────────────────────────────────

function computeOptimalAllocations(
  currentAllocations: number[],
  protocolApys: number[],
  vault: VaultState
): number[] {
  const n = currentAllocations.length;
  if (n === 0) return [];
  if (n === 1) return [BPS_DENOM];

  // Minimum allocation per protocol: 5% (500 bps) to maintain diversification
  const MIN_BPS = 500;
  const remaining = BPS_DENOM - MIN_BPS * n;

  if (remaining <= 0) {
    // Equal weight if too many protocols for minimum
    const equal = Math.floor(BPS_DENOM / n);
    const allocations = Array(n).fill(equal);
    allocations[0] += BPS_DENOM - equal * n; // remainder to first
    return allocations;
  }

  // Sort protocols by APY descending
  const ranked = protocolApys
    .map((apy, i) => ({ i, apy }))
    .sort((a, b) => b.apy - a.apy);

  // Allocate remaining bps with a weighted distribution
  // Top protocol: up to 50%, second: up to 30%, rest: remainder
  const MAX_TOP = Math.min(5000, remaining);       // 50%
  const MAX_SECOND = Math.min(3000, remaining);    // 30%

  const allocations = Array(n).fill(MIN_BPS);
  let leftover = remaining;

  if (ranked.length >= 1) {
    const give = Math.min(MAX_TOP, leftover);
    allocations[ranked[0].i] += give;
    leftover -= give;
  }
  if (ranked.length >= 2 && leftover > 0) {
    const give = Math.min(MAX_SECOND, leftover);
    allocations[ranked[1].i] += give;
    leftover -= give;
  }
  // Distribute any remaining to top protocol
  if (leftover > 0) {
    allocations[ranked[0].i] += leftover;
  }

  // Sanity check: must sum to exactly BPS_DENOM
  const total = allocations.reduce((s, a) => s + a, 0);
  console.assert(total === BPS_DENOM, `Allocations sum to ${total}, expected ${BPS_DENOM}`);

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
  const COMPOUND_INTERVAL = 3600; // 1 hour — must match program constant

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
