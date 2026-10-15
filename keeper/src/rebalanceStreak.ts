import * as fs from "fs";
import * as path from "path";

/**
 * rebalanceStreak.ts — persists how many consecutive cycles a thin/volatile market
 * has been the computed winner, so the keeper can require sustained confirmation
 * before switching INTO one (see THIN_MARKET_CONFIRM_CYCLES in rebalancer.ts).
 *
 * WHY THIS EXISTS: observed live 2026-10-15 — kamino-usdc-maple (~$2.1M TVL, a thin
 * isolated market) spiked to 7.04% APY, beat kamino-usdc's 6.57% by >100bps, and won
 * the allocation. A few minutes later its rate collapsed to 2.85% while the main pool
 * held ~6%, meaning the very next cycle would have flipped straight back. Kamino-to-
 * Kamino has zero exit cost, so nothing in computeRebalanceDecision stopped that
 * churn — thin markets can swing past the 100bps threshold on ordinary utilization
 * noise, not a real sustained rate advantage.
 *
 * Committed back to the repo by the same auto-commit pattern keeperHealth.ts /
 * depositWatcher.ts already use (see keeper-cron.yml's file_pattern) -- run_once.ts
 * is a fresh process every cron invocation, so this has to live on disk/git, not in
 * memory, to survive between cycles.
 */

export interface StreakEntry {
  candidateId: string;
  cycles: number;
}

type StreakFile = Record<string, StreakEntry>; // keyed by vault address

const STATE_PATH = path.resolve(__dirname, "..", "state", "rebalance-streak.json");

function readAll(): StreakFile {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function readRebalanceStreak(vaultAddress: string): StreakEntry | null {
  return readAll()[vaultAddress] ?? null;
}

export function writeRebalanceStreak(vaultAddress: string, entry: StreakEntry | null) {
  const all = readAll();
  if (entry) {
    all[vaultAddress] = entry;
  } else {
    delete all[vaultAddress];
  }
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(all, null, 2) + "\n");
}
