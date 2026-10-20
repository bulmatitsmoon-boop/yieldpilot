import { ProtocolApy } from "./apyFetcher";
import { VaultState } from "./solanaClient";
import { logger } from "./logger";
import { EPOCH_GATED_PROTOCOLS } from "./epochTracker";
import { StreakEntry } from "./rebalanceStreak";

const REBALANCE_THRESHOLD_BPS = parseInt(process.env.REBALANCE_THRESHOLD_BPS || "500");
const MIN_APY_IMPROVEMENT_BPS = parseInt(process.env.MIN_APY_IMPROVEMENT_BPS || "100");
const BPS_DENOM = 10_000;

// A market below this TVL is "thin" -- its live supply APY can swing several points
// on ordinary utilization/deposit-withdraw noise rather than a real sustained rate
// edge. kamino-usdc-maple sits at ~$2.1M; the main kamino-usdc pool is ~$23.5M.
// Below this, a win must be CONFIRMED across consecutive cycles (see below) before
// the keeper actually switches into it.
const THIN_MARKET_TVL_USD = parseInt(process.env.THIN_MARKET_TVL_USD || "5000000");
// How many consecutive cycles a thin market must keep winning before the keeper
// switches into it. 3 cycles at the ~45min keeper interval is ~2.25h of sustained
// advantage -- long enough that a single utilization spike can't win on its own,
// short enough that a genuinely better thin-market rate isn't ignored for days.
const THIN_MARKET_CONFIRM_CYCLES = parseInt(process.env.THIN_MARKET_CONFIRM_CYCLES || "3");

// Exit cost in bps for each protocol ID.
// Lending protocols (Kamino, Drift, Solend) = 0: instant, no fee.
// Marinade liquid unstake = ~30 bps (0.3%). We require the APY gain to
// exceed this cost before routing OUT of Marinade, so we never rebalance
// at a net loss.
const EXIT_COST_BPS: Record<string, number> = {
  "kamino-usdc":      0,
  "kamino-usdc-maple": 0, // same Kamino lending-market mechanics, no exit fee — proven on the local-validator harness before this was registered
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
//
// Fails CLOSED (blocks) when we have no entry-epoch record for an epoch-gated position.
// This was FAIL-OPEN until 2026-08-20 and that made the whole check silently useless:
// the SOL vault churned psol-sol three times between Aug 5-10 — twice recalling and
// redeploying the SAME protocol only ~6-8 minutes apart — paying the 10bps exit fee on
// the full balance every time. That burned ~0.0124 SOL against ~0.0161 SOL of gross
// yield (~77% of earnings), dropping realized return to ~2% APY versus ~8.5% gross.
// Every one of those exits sailed through here because no psol-sol entry was ever
// written, so `entryEpoch === undefined` returned false and waved the exit past.
//
// Blocking on a missing record cannot deadlock: solanaClient.getEpochContext backfills
// an entry for any held epoch-gated position before building this context (see
// ensureEntryForHeldPosition), so a missing record self-heals into a real one on the
// very next cycle and then ages out normally. The failure mode of being wrong here is
// "hold a good position slightly too long", which is strictly cheaper than "pay a real
// exit fee for nothing" — the asymmetry that motivated the change.
function epochCooldownBlocksExit(
  label: string,
  apyBps: number,
  ctx: EpochContext | undefined,
): boolean {
  if (!ctx || !EPOCH_GATED_PROTOCOLS.has(label)) return false;
  const entryEpoch = ctx.entryEpochs[label];
  if (entryEpoch === undefined) return true; // fail CLOSED — see block comment above

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
  /** Pass this back into the NEXT call's `streak` argument for this same vault
   *  (persisted via rebalanceStreak.ts) — null means "nothing to track right now",
   *  clearing any stale entry. */
  updatedStreak: StreakEntry | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core rebalance logic
// ─────────────────────────────────────────────────────────────────────────────

export function computeRebalanceDecision(
  vault: VaultState,
  apys: ProtocolApy[],
  epochContext?: EpochContext,
  streak?: StreakEntry | null,
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
      updatedStreak: null,
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

  // ── Thin-market confirmation gate ──────────────────────────────────────────
  // See THIN_MARKET_TVL_USD's comment above and rebalanceStreak.ts's module doc for
  // the real 2026-10-15 incident this closes. A switch INTO a thin market away from
  // whatever is currently fully allocated must win THIN_MARKET_CONFIRM_CYCLES times
  // in a row before it's actually acted on. Switching AWAY from a thin market (back
  // to a deeper one) is never gated — only entry into thin markets is suspect, exit
  // from one is always safe to act on immediately.
  const currentWinnerIdx = currentAllocations.findIndex(a => a === BPS_DENOM);
  const proposedWinnerIdx = optimalAllocations.findIndex(a => a === BPS_DENOM);
  const proposedTvlUsd = proposedWinnerIdx >= 0
    ? (apyByLabel.get(protocolIds[proposedWinnerIdx])?.tvlUsd ?? Infinity)
    : Infinity;
  const isSwitchIntoThinMarket =
    proposedWinnerIdx >= 0 &&
    proposedWinnerIdx !== currentWinnerIdx &&
    proposedTvlUsd < THIN_MARKET_TVL_USD;

  let streakGateBlocking = false;
  let updatedStreak: StreakEntry | null = null;
  let streakCyclesSoFar = 0;
  if (isSwitchIntoThinMarket) {
    const candidateId = protocolIds[proposedWinnerIdx];
    const priorCycles = streak && streak.candidateId === candidateId ? streak.cycles : 0;
    streakCyclesSoFar = priorCycles + 1;
    if (streakCyclesSoFar < THIN_MARKET_CONFIRM_CYCLES) {
      streakGateBlocking = true;
      updatedStreak = { candidateId, cycles: streakCyclesSoFar };
    }
    // else: confirmed — proceed, updatedStreak stays null (reset once acted on)
  }
  // Any other state (not a thin-market switch at all, or a confirmed/expired one)
  // clears whatever streak was tracked — there's nothing stale left to carry forward.

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
    isSwitchIntoThinMarket,
    streakGateBlocking,
    streakCyclesSoFar,
  });

  const apyTrigger   = netApyImprovement >= MIN_APY_IMPROVEMENT_BPS;
  // REGRESSION, caught live 2026-10-20: this vault is winner-take-all (100% to one
  // protocol, 0% to the rest -- see computeOptimalAllocations' doc comment), so
  // switching protocols at ALL always produces maxDrift = BPS_DENOM (10000). That
  // means `driftTrigger` was satisfied by ANY positive net gain, however tiny, and
  // completely bypassed the MIN_APY_IMPROVEMENT_BPS floor apyTrigger was supposed to
  // enforce -- confirmed live: the keeper switched kamino-usdc -> kamino-usdc-maple
  // on a 0.33bps edge, nowhere near the intended 100bps minimum. REBALANCE_THRESHOLD_BPS
  // is a holdover from the pre-2026-07-21 80/20-split allocation scheme, where partial
  // drift short of a full switch was a real, distinct case; under winner-take-all it
  // never is, so the separate low-bar drift path has no scenario left where it SHOULD
  // differ from apyTrigger. Now requires the same real net-gain floor -- the drift
  // check still runs (kept in case a future allocation scheme reintroduces partial
  // splits, where it would matter again), it just can no longer approve a switch
  // apyTrigger itself wouldn't.
  const driftTrigger = maxDrift >= REBALANCE_THRESHOLD_BPS && netApyImprovement >= MIN_APY_IMPROVEMENT_BPS;
  const shouldRebalance = (driftTrigger || apyTrigger) && vault.autoRebalance && !streakGateBlocking;

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
  } else if (streakGateBlocking) {
    reason = `Holding — ${protocolIds[proposedWinnerIdx]} is a thin market (TVL $${Math.round(proposedTvlUsd).toLocaleString()}) leading by ${netApyImprovement}bps, but needs ${THIN_MARKET_CONFIRM_CYCLES} consecutive cycles to confirm before switching (${streakCyclesSoFar}/${THIN_MARKET_CONFIRM_CYCLES})`;
  } else if (cooldownBlocked) {
    reason = `Holding — a better rate exists but exiting the current epoch-gated position now would pay the exit fee before enough epochs have passed to earn it back`;
  } else if (grossGain > 0) {
    // Drift alone (without also clearing MIN_APY_IMPROVEMENT_BPS) can no longer
    // trigger a rebalance -- see driftTrigger's comment above -- so this message no
    // longer claims drift was below threshold; it may well be at/above it.
    reason = `Net APY gain ${netApyImprovement}bps (gross ${grossGain}bps - ${exitCostBps}bps exit cost) below the ${MIN_APY_IMPROVEMENT_BPS}bps minimum required to switch — holding position`;
  } else {
    reason = "No rebalance needed";
  }

  return {
    shouldRebalance,
    reason,
    currentAllocations,
    newAllocations: shouldRebalance ? optimalAllocations : currentAllocations,
    expectedApyImprovement: netApyImprovement,
    updatedStreak,
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
//
// NOTE: this function stays a pure "what's the best headline allocation" optimizer.
// The thin-market consecutive-cycle confirmation gate lives one level up in
// computeRebalanceDecision, which is the only place that has the streak state —
// this keeps computeOptimalAllocations testable without needing to thread
// persistence through it.
// ─────────────────────────────────────────────────────────────────────────────

const SAFE_PROTOCOLS = new Set([
  "kamino-usdc",
  "kamino-usdc-maple",
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
