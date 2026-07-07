#!/usr/bin/env ts-node
/**
 * test_direct_deploy.ts — call deployToSolend/deployToMarinade directly with
 * small, deliberately buffer-safe amounts, bypassing the rebalancer's
 * full-deficit math entirely. This is the first real attempt at Solend's and
 * Marinade's actual deposit CPI (every prior attempt was blocked by the
 * InsufficientIdle buffer check before ever reaching their programs).
 *
 * Usage: RPC_URL=... KEEPER_KEYPAIR_PATH=... PROGRAM_ID=... IDL_PATH=... ts-node test_direct_deploy.ts
 */
import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { SolanaClient } from "../solanaClient";

async function main() {
  const client = new SolanaClient();
  const usdcVault = "5heGDKagzMLe9tEvLBBwPjURRzrSxENywAJifm3pRifC";
  const solVault = "3UB19cUZFjNf4jhJxZBpxFZd56m3H68JJJaRtBamyKWK";

  const usdcState = await client.fetchVault(usdcVault);
  const solendIdx = (usdcState.protocols as any[]).findIndex((p: any) => Buffer.from(p.label).toString().startsWith("solend-usdc"));
  console.log("Deploying 2,000,000 (2 USDC) to Solend directly (safe amount, buffer intact)...");
  let sig = await client.deployToSolend(usdcVault, solendIdx, new anchor.BN(2_000_000));
  console.log("deployToSolend tx:", sig);

  const solState = await client.fetchVault(solVault);
  const marinadeIdx = (solState.protocols as any[]).findIndex((p: any) => Buffer.from(p.label).toString().startsWith("marinade-sol"));
  console.log("Deploying 15,000,000 lamports (0.015 SOL) to Marinade directly (safe amount, buffer intact)...");
  sig = await client.deployToMarinade(solVault, marinadeIdx, new anchor.BN(15_000_000));
  console.log("deployToMarinade tx:", sig);
}

main().catch(err => {
  console.error("Fatal:", err.message ?? err);
  if (err.logs) console.error(err.logs.join("\n"));
  process.exit(1);
});
