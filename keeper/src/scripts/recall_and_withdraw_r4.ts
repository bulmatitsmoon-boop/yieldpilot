#!/usr/bin/env ts-node
/**
 * recall_and_withdraw_r4.ts — round-4 wind-down before program close.
 * 1) recall_from_sol_lst (Jito, keeper-signed via SolanaClient): brings the
 *    deployed 0.024 SOL back to idle WSOL in the SOL vault
 * 2) withdraw ALL shares from the USDC vault (admin-signed)
 * 3) withdraw ALL shares from the SOL vault (admin-signed)
 * 4) close both vaults (admin-signed), once total_shares == 0
 *
 * Usage: RPC_URL=... ADMIN_KEYPAIR_PATH=... KEEPER_KEYPAIR_PATH=... PROGRAM_ID=... IDL_PATH=... ts-node recall_and_withdraw_r4.ts
 */
import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import fs from "fs";
import path from "path";
import os from "os";
import { SolanaClient } from "../solanaClient";

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(p.replace("~", os.homedir())), "utf8"))));
}

async function main() {
  const rpcUrl = process.env.RPC_URL!;
  const connection = new Connection(rpcUrl, { commitment: "confirmed" });
  const admin = loadKeypair(process.env.ADMIN_KEYPAIR_PATH!);
  const programId = new PublicKey(process.env.PROGRAM_ID!);

  const idlPath = path.resolve(__dirname, process.env.IDL_PATH!);
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));

  const adminWallet = new anchor.Wallet(admin);
  const adminProvider = new anchor.AnchorProvider(connection, adminWallet, { commitment: "confirmed" });
  const adminProgram = new anchor.Program(idl, adminProvider);

  const solVaultPda = new PublicKey("3izsbbZfney3ep9Fd8nBHxvAgJCp5XmkGfYs55mP5mty");
  const usdcVaultPda = new PublicKey("C5DYzmGnQ1avDENSNNyrJrZLxG2XXNggPrZqLzuKmoUw");

  // ── Step 1: recall from Jito (keeper-signed, via SolanaClient) ──────────
  const solVault: any = await (adminProgram.account as any).vault.fetch(solVaultPda);
  const jitoIdx = solVault.protocols.findIndex((p: any) => Buffer.from(p.label).toString().startsWith("jito-sol"));
  const jitoProtocol = solVault.protocols[jitoIdx];

  if (jitoProtocol.deployedBalance.toNumber() > 0) {
    const client = new SolanaClient(); // uses KEEPER_KEYPAIR_PATH / IDL_PATH / RPC_URL env vars
    const cfg = await client.getJitoPoolConfig();
    const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), solVaultPda.toBuffer()], programId);
    const vaultLstAccount = getAssociatedTokenAddressSync(cfg.lstMint, vaultAuthority, true);
    const lstBal = await connection.getTokenAccountBalance(vaultLstAccount);
    const lstAmount = new anchor.BN(lstBal.value.amount);
    console.log("Recalling from Jito, jitoSOL amount:", lstAmount.toString());
    const sig = await client.recallFromSolLst(solVaultPda.toBase58(), jitoIdx, lstAmount, cfg);
    console.log("Recall from Jito OK. Tx:", sig);
  } else {
    console.log("Nothing deployed to Jito, skipping recall.");
  }

  // ── Step 2 & 3: withdraw all shares from both vaults (admin-signed) ──
  async function withdrawAll(vaultPda: PublicKey, mint: PublicKey, label: string) {
    const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), vaultPda.toBuffer()], programId);
    const vaultAccount: any = await (adminProgram.account as any).vault.fetch(vaultPda);
    const sharesMint = vaultAccount.sharesMint as PublicKey;
    const vaultTokenAccount = vaultAccount.vaultTokenAccount as PublicKey;

    const userTokenAccount = getAssociatedTokenAddressSync(mint, admin.publicKey, true);
    const userSharesAccount = getAssociatedTokenAddressSync(sharesMint, admin.publicKey, true);
    const [userPosition] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), vaultPda.toBuffer(), admin.publicKey.toBuffer()],
      programId
    );

    const posAccount: any = await (adminProgram.account as any).userPosition.fetch(userPosition);
    const shares = posAccount.shares;
    console.log(`\n${label} vault: shares to withdraw =`, shares.toString());

    if (shares.toNumber() === 0) {
      console.log(`${label}: no shares, nothing to withdraw.`);
      return;
    }

    const sig = await adminProgram.methods
      .withdraw(shares, new anchor.BN(0))
      .accounts({
        user: admin.publicKey,
        vault: vaultPda,
        vaultAuthority,
        vaultTokenAccount,
        userTokenAccount,
        sharesMint,
        userPosition,
        userSharesAccount,
        treasuryTokenAccount: null,
        userGateAccount: null,
        whitelistEntry: null,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
    console.log(`${label} withdraw OK. Tx:`, sig);
  }

  await withdrawAll(usdcVaultPda, USDC_MINT, "USDC");
  await withdrawAll(solVaultPda, WSOL_MINT, "SOL");

  console.log("\nAll recalls/withdrawals complete.");

  // ── Step 4 & 5: close both vaults (admin-signed) — reclaims vault rent ──
  async function closeVault(vaultPda: PublicKey, label: string) {
    const vaultAccount: any = await (adminProgram.account as any).vault.fetch(vaultPda);
    if (vaultAccount.totalShares.toNumber() !== 0) {
      console.log(`${label} vault: total_shares != 0 (${vaultAccount.totalShares.toString()}), skipping close.`);
      return;
    }
    const sig = await adminProgram.methods
      .closeVault()
      .accounts({
        admin: admin.publicKey,
        vault: vaultPda,
      } as any)
      .rpc();
    console.log(`${label} vault closed. Tx:`, sig);
  }

  await closeVault(usdcVaultPda, "USDC");
  await closeVault(solVaultPda, "SOL");

  console.log("\nBoth vaults closed (or skipped if not empty).");
}

main().catch((err) => {
  console.error("Fatal:", err.message ?? err);
  if (err.logs) console.error(err.logs.join("\n"));
  process.exit(1);
});
