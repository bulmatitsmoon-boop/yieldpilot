#!/usr/bin/env ts-node
/**
 * test_flip_and_deploy.ts — temporarily flip target allocations to favor
 * Solend/Marinade (never confirmed live) instead of Kamino/Jito, then force
 * a rebalance pass so they actually get enough idle room to attempt their
 * real deposit CPIs (previously always blocked by the InsufficientIdle
 * buffer check before ever reaching Solend/Marinade's programs).
 *
 * Usage: RPC_URL=... KEEPER_KEYPAIR_PATH=... PROGRAM_ID=... IDL_PATH=... ts-node test_flip_and_deploy.ts
 */
import "dotenv/config";
import { SolanaClient } from "../solanaClient";

async function main() {
  const client = new SolanaClient();
  const usdcVault = "5heGDKagzMLe9tEvLBBwPjURRzrSxENywAJifm3pRifC";
  const solVault = "3UB19cUZFjNf4jhJxZBpxFZd56m3H68JJJaRtBamyKWK";

  console.log("=== Flipping USDC vault: kamino 10% / solend 90% ===");
  let sig = await client.rebalance(usdcVault, [1000, 9000]);
  console.log("rebalance tx:", sig);

  console.log("=== Flipping SOL vault: jito 10% / marinade 90% ===");
  sig = await client.rebalance(solVault, [1000, 9000]);
  console.log("rebalance tx:", sig);

  console.log("\n=== Executing rebalance (deploy phase) on USDC vault ===");
  const usdcState = await client.fetchVault(usdcVault);
  await client.executeRebalance(usdcVault, usdcState);

  console.log("\n=== Executing rebalance (deploy phase) on SOL vault ===");
  const solState = await client.fetchVault(solVault);
  await client.executeRebalance(solVault, solState);

  console.log("\nDone. Check logs above for deployToSolend/deployToMarinade results.");
}

main().catch(err => {
  console.error("Fatal:", err.message ?? err);
  if (err.logs) console.error(err.logs.join("\n"));
  process.exit(1);
});
