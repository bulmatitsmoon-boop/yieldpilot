#!/usr/bin/env ts-node
/**
 * recall_all_r5.ts — recall every deployed protocol position back to idle
 * balance, on both round-5 vaults, as the first step of winding the program
 * down (withdraw everything, close vaults, close program, recoup rent).
 *
 * Usage: RPC_URL=... KEEPER_KEYPAIR_PATH=... PROGRAM_ID=... IDL_PATH=... ts-node recall_all_r5.ts
 */
import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { SolanaClient } from "../solanaClient";

async function main() {
  const client = new SolanaClient();
  const usdcVault = "5heGDKagzMLe9tEvLBBwPjURRzrSxENywAJifm3pRifC";
  const solVault = "3UB19cUZFjNf4jhJxZBpxFZd56m3H68JJJaRtBamyKWK";

  console.log("=== USDC vault: recall Kamino (0.35627 kUSDC) ===");
  const usdcState = await client.fetchVault(usdcVault);
  const kaminoIdx = (usdcState.protocols as any[]).findIndex((p: any) => Buffer.from(p.label).toString().startsWith("kamino-usdc"));
  const sig1 = await client.recallFromKamino(usdcVault, kaminoIdx, new anchor.BN(356270));
  console.log("recallFromKamino tx:", sig1);

  console.log("\n=== SOL vault: recall Jito (0.000905707 jitoSOL) ===");
  const solState = await client.fetchVault(solVault);
  const jitoIdx = (solState.protocols as any[]).findIndex((p: any) => Buffer.from(p.label).toString().startsWith("jito-sol"));
  const jitoPoolConfig = await client.getJitoPoolConfig();
  const sig2 = await client.recallFromSolLst(solVault, jitoIdx, new anchor.BN(905707), jitoPoolConfig);
  console.log("recallFromSolLst tx:", sig2);

  console.log("\n=== SOL vault: recall Marinade (0.004310276 mSOL) ===");
  const marinadeIdx = (solState.protocols as any[]).findIndex((p: any) => Buffer.from(p.label).toString().startsWith("marinade-sol"));
  const sig3 = await client.recallFromMarinade(solVault, marinadeIdx, new anchor.BN(4310276));
  console.log("recallFromMarinade tx:", sig3);

  console.log("\nAll recalls complete.");
}

main().catch(err => {
  console.error("Fatal:", err.message ?? err);
  if (err.logs) console.error("Logs:\n" + err.logs.join("\n"));
  process.exit(1);
});
