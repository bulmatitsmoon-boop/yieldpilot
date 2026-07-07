#!/usr/bin/env ts-node
/**
 * fix_usdc_allocation.ts — revert the USDC vault's target allocation back to
 * Kamino 100% / Solend 0%, since Solend's deposit CPI is still broken and
 * every keeper cron cycle was retrying-and-failing against it 3x per run,
 * burning fees for nothing (leftover from the "flip allocations" test).
 *
 * Usage: RPC_URL=... KEEPER_KEYPAIR_PATH=... PROGRAM_ID=... IDL_PATH=... ts-node fix_usdc_allocation.ts
 */
import "dotenv/config";
import { SolanaClient } from "../solanaClient";

async function main() {
  const client = new SolanaClient();
  const usdcVault = "5heGDKagzMLe9tEvLBBwPjURRzrSxENywAJifm3pRifC";

  console.log("Reverting USDC vault to kamino 100% / solend 0%...");
  const sig = await client.rebalance(usdcVault, [10000, 0]);
  console.log("rebalance tx:", sig);

  console.log("\nExecuting rebalance (deploy phase) to move idle funds into Kamino...");
  const usdcState = await client.fetchVault(usdcVault);
  await client.executeRebalance(usdcVault, usdcState);

  console.log("\nDone.");
}

main().catch(err => {
  console.error("Fatal:", err.message ?? err);
  if (err.logs) console.error(err.logs.join("\n"));
  process.exit(1);
});
