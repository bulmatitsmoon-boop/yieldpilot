#!/usr/bin/env ts-node
/**
 * close_sol_vault_r5.ts — close the round-5 SOL vault (already empty:
 * total_shares == 0), reclaiming its account rent to admin.
 *
 * Usage: RPC_URL=... KEEPER_KEYPAIR_PATH=... PROGRAM_ID=... IDL_PATH=... ts-node close_sol_vault_r5.ts
 */
import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import os from "os";

async function main() {
  const rpcUrl = process.env.RPC_URL!;
  const connection = new Connection(rpcUrl, { commitment: "confirmed" });

  const keypairPath = process.env.KEEPER_KEYPAIR_PATH!.replace("~", os.homedir());
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(keypairPath), "utf8"))));

  const programId = new PublicKey(process.env.PROGRAM_ID!);
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idlPath = path.resolve(__dirname, process.env.IDL_PATH!);
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const program = new anchor.Program(idl, provider);

  const solVault = new PublicKey("3UB19cUZFjNf4jhJxZBpxFZd56m3H68JJJaRtBamyKWK");

  const vaultAccount = await (program.account as any).vault.fetch(solVault);
  console.log("total_shares:", vaultAccount.totalShares.toString());
  if (vaultAccount.totalShares.toString() !== "0") {
    console.error("Vault still has shares — refusing to close.");
    process.exit(1);
  }

  const sig = await program.methods
    .closeVault()
    .accounts({ admin: admin.publicKey, vault: solVault } as any)
    .rpc();
  console.log("✓ SOL vault closed. Tx:", sig);
}

main().catch(err => {
  console.error("Fatal:", err.message ?? err);
  if (err.logs) console.error(err.logs.join("\n"));
  process.exit(1);
});
