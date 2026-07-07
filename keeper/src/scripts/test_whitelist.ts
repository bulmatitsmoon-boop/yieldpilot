#!/usr/bin/env ts-node
/**
 * test_whitelist.ts — verify add_to_whitelist / remove_from_whitelist work
 * on the round-5 USDC vault. Uses a throwaway test wallet address (doesn't
 * need to be a real funded wallet — the whitelist PDA just needs a valid
 * pubkey as a seed).
 *
 * Usage: RPC_URL=... ADMIN_KEYPAIR_PATH=... PROGRAM_ID=... IDL_PATH=... ts-node test_whitelist.ts
 */
import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import os from "os";

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(p.replace("~", os.homedir())), "utf8"))));
}

async function main() {
  const rpcUrl = process.env.RPC_URL!;
  const connection = new Connection(rpcUrl, { commitment: "confirmed" });
  const admin = loadKeypair(process.env.ADMIN_KEYPAIR_PATH!);
  const programId = new PublicKey(process.env.PROGRAM_ID!);

  const idlPath = path.resolve(__dirname, "..", "idl", "yieldpilot.mainnet.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));

  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new anchor.Program(idl, provider);

  const usdcVaultPda = new PublicKey("5heGDKagzMLe9tEvLBBwPjURRzrSxENywAJifm3pRifC");
  const testWallet = Keypair.generate().publicKey; // throwaway address, just needs to be a valid pubkey
  console.log("Test wallet:", testWallet.toBase58());

  const [whitelistEntry] = PublicKey.findProgramAddressSync(
    [Buffer.from("wl"), usdcVaultPda.toBuffer(), testWallet.toBuffer()],
    programId
  );
  console.log("Whitelist entry PDA:", whitelistEntry.toBase58());

  console.log("\n[1/3] Adding to whitelist...");
  const addSig = await program.methods
    .addToWhitelist(testWallet)
    .accounts({
      admin: admin.publicKey,
      vault: usdcVaultPda,
      whitelistEntry,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();
  console.log("✓ Added. Tx:", addSig);

  console.log("\n[2/3] Verifying whitelist entry exists on-chain...");
  const entryInfo = await connection.getAccountInfo(whitelistEntry);
  if (!entryInfo) throw new Error("Whitelist entry does not exist after add!");
  console.log("✓ Confirmed: whitelist_entry account exists, owner =", entryInfo.owner.toBase58(), "size =", entryInfo.data.length, "bytes");

  console.log("\n[3/3] Removing from whitelist (cleanup, reclaims rent)...");
  const removeSig = await program.methods
    .removeFromWhitelist(testWallet)
    .accounts({
      admin: admin.publicKey,
      vault: usdcVaultPda,
      whitelistEntry,
    } as any)
    .rpc();
  console.log("✓ Removed. Tx:", removeSig);

  const afterInfo = await connection.getAccountInfo(whitelistEntry);
  console.log("\nWhitelist entry after removal:", afterInfo ? "STILL EXISTS (bug!)" : "correctly closed");
}

main().catch(err => {
  console.error("Fatal:", err.message ?? err);
  if (err.logs) console.error(err.logs.join("\n"));
  process.exit(1);
});
