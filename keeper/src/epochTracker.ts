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

// Recalling a protocol down to zero clears its entry — the next deploy into it is a
// fresh entry, not a continuation of the old cooldown window.
export function clearEntry(vaultAddress: string, label: string): void {
  const all = load();
  delete all[key(vaultAddress, label)];
  save(all);
}
