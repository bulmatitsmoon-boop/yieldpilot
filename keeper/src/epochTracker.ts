import fs from "fs";
import path from "path";
import { logger } from "./logger";

/**
 * epochTracker.ts — tracks which epoch each SOL-vault LST protocol slot was last
 * (re)entered at, so the rebalancer can refuse to exit a position before its accrued
 * yield exceeds the protocol's flat exit fee.
 *
 * Only liquid-staking protocols are epoch-gated: their exchange rate is driven by
 * native Solana staking rewards, which land once per epoch. Lending markets (Kamino,
 * Solend) accrue interest continuously per-slot and have no epoch concept at all —
 * they must NEVER be gated here, or a USDC-vault rebalance would wait forever on an
 * epoch signal that will never fire for a lending market.
 */
export const EPOCH_GATED_PROTOCOLS = new Set(["marinade-sol", "jito-sol", "psol-sol"]);

const STATE_PATH = path.join(__dirname, "..", "state", "epoch-entries.json");

type EntryMap = Record<string, number>; // `${vaultAddress}:${label}` -> epoch entered

function load(): EntryMap {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function save(entries: EntryMap) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(entries, null, 2));
}

function key(vaultAddress: string, label: string): string {
  return `${vaultAddress}:${label}`;
}

/** Read-only snapshot of entry epochs for every gated protocol on one vault. */
export function getEntryEpochs(vaultAddress: string): Record<string, number> {
  const all = load();
  const out: Record<string, number> = {};
  for (const label of EPOCH_GATED_PROTOCOLS) {
    const k = key(vaultAddress, label);
    if (all[k] !== undefined) out[label] = all[k];
  }
  return out;
}

// Only a fresh 0 -> nonzero deploy starts the cooldown clock. Topping up a position
// that's already deployed must NOT reset it — otherwise every top-up would perpetually
// restart the cooldown and the protocol could never be exited at all.
export function recordEntryIfFresh(
  vaultAddress: string,
  label: string,
  wasZeroBefore: boolean,
  currentEpoch: number,
): void {
  if (!EPOCH_GATED_PROTOCOLS.has(label) || !wasZeroBefore) return;
  const all = load();
  all[key(vaultAddress, label)] = currentEpoch;
  save(all);
  logger.info(`Epoch-entry recorded: ${label} entered at epoch ${currentEpoch}`, { vaultAddress });
}

/**
 * Backfill an entry for a position we ALREADY hold but have no record for.
 *
 * WHY THIS EXISTS (2026-08-20): the cooldown used to fail OPEN when no entry record
 * existed, which made it silently useless in exactly the case it was built for. The SOL
 * vault churned psol-sol three times between Aug 5-10 (recall→redeploy, twice only ~6-8
 * minutes apart) paying a 10bps exit fee each time — ~0.0124 SOL against ~0.0161 SOL of
 * gross yield, i.e. churn ate ~77% of the earnings and dropped realized return to ~2%
 * APY against ~8.5% gross. Not one of those exits was blocked, because no psol-sol entry
 * was ever on file, so `entryEpoch === undefined` short-circuited the check every time.
 *
 * Records only when the key is ABSENT — never overwrites a real entry, so it cannot
 * reset a legitimately running cooldown (same invariant recordEntryIfFresh protects).
 * Paired with the now fail-CLOSED check in rebalancer.ts, this self-heals: the first
 * cycle after state loss stamps "entered now" and blocks the exit, and later cycles
 * compare against it normally and release once the yield genuinely covers the fee.
 */
export function ensureEntryForHeldPosition(
  vaultAddress: string,
  label: string,
  currentEpoch: number,
): void {
  if (!EPOCH_GATED_PROTOCOLS.has(label)) return;
  const all = load();
  const k = key(vaultAddress, label);
  if (all[k] !== undefined) return; // never clobber a real entry
  all[k] = currentEpoch;
  save(all);
  logger.warn(
    `Epoch-entry MISSING for held position ${label} — backfilled at epoch ${currentEpoch}. ` +
    `Exit is blocked until a full cooldown elapses from now.`,
    { vaultAddress },
  );
}

// Recalling a protocol down to zero clears its entry — the next deploy into it is a
// fresh entry, not a continuation of the old cooldown window.
export function clearEntry(vaultAddress: string, label: string): void {
  const all = load();
  delete all[key(vaultAddress, label)];
  save(all);
}
