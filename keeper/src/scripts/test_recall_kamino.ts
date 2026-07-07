#!/usr/bin/env ts-node
/**
 * test_recall_kamino.ts — partial recall_from_kamino test (never verified live before).
 * Usage: RPC_URL=... KEEPER_KEYPAIR_PATH=... PROGRAM_ID=... IDL_PATH=... ts-node test_recall_kamino.ts --collateral <amount>
 */
import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { SolanaClient } from "../solanaClient";

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (f: string) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
  return { collateral: get("--collateral")! };
}

async function main() {
  const opts = parseArgs();
  const client = new SolanaClient();
  const vaultAddress = "5heGDKagzMLe9tEvLBBwPjURRzrSxENywAJifm3pRifC";
  const vault = await client.fetchVault(vaultAddress);
  const kaminoIdx = (vault.protocols as any[]).findIndex((p: any) => Buffer.from(p.label).toString().startsWith("kamino-usdc"));
  console.log("Kamino protocol index:", kaminoIdx);
  console.log("Recalling", opts.collateral, "kUSDC units from Kamino...");
  const sig = await client.recallFromKamino(vaultAddress, kaminoIdx, new anchor.BN(opts.collateral));
  console.log("✓ Recall from Kamino OK. Tx:", sig);
}

main().catch(err => {
  console.error("Fatal:", err.message ?? err);
  if (err.logs) console.error(err.logs.join("\n"));
  process.exit(1);
});
