import * as fs from "fs";
import * as path from "path";

/**
 * keeperHealth.ts — writes a real "the keeper ran" timestamp every cycle, committed
 * back to the repo by the same auto-commit pattern depositWatcher.ts already uses.
 *
 * Replaces the old dashboard "Last Compounded" stat, which looked like a keeper
 * health signal but wasn't one: compound() is a genuine on-chain no-op the keeper
 * deliberately stopped calling (see run_once.ts's runCompound comment), so that
 * timestamp was frozen at vault-creation time forever regardless of whether the
 * keeper was actually alive. This file is written unconditionally at the end of
 * EVERY successful run -- healthy or not, something to do or not -- so it actually
 * reflects keeper liveness.
 */

const STATE_PATH = path.resolve(__dirname, "..", "state", "keeper-health.json");

export function writeKeeperHealthCheck() {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify({ lastCheckTs: Math.floor(Date.now() / 1000) }, null, 2) + "\n"
  );
}
