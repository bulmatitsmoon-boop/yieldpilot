#!/usr/bin/env ts-node
/**
 * recall_and_withdraw.ts — round-3 wind-down before program close.
 * 1) recall_from_marinade (keeper-signed): brings deployed mSOL back to idle WSOL in the SOL vault
 * 2) withdraw ALL shares from the USDC vault (admin-signed, admin is the depositor)
 * 3) withdraw ALL shares from the SOL vault (admin-signed)
 *
 * Usage: RPC_URL=... ADMIN_KEYPAIR_PATH=... KEEPER_KEYPAIR_PATH=... PROGRAM_ID=... IDL_PATH=... ts-node recall_and_withdraw.ts
 */
import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import fs from "fs";
import path from "path";
import os from "os";

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const MSOL_MINT = new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");
const MARINADE_PROGRAM = new PublicKey("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");
const MARINADE_STATE = new PublicKey("8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC");
const MARINADE_LIQ_POOL_SOL_LEG = new PublicKey("UefNb6z6yvArqe4cJHTXCqStRsKmWhGxnZzuHbikP5Q");
const MARINADE_LIQ_POOL_MSOL_LEG = new PublicKey("7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE");
const MARINADE_TREASURY_MSOL = new PublicKey("B1aLzaNMeFVAyQ6f3XbbUyKcH2YPHu2fqiEagmiF23VR");

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(p.replace("~", os.homedir())), "utf8"))));
}

async function main() {
  const rpcUrl = process.env.RPC_URL!;
  const connection = new Connection(rpcUrl, { commitment: "confirmed" });
  const admin = loadKeypair(process.env.ADMIN_KEYPAIR_PATH!);
  const keeper = loadKeypair(process.env.KEEPER_KEYPAIR_PATH!);
  const programId = new PublicKey(process.env.PROGRAM_ID!);

  const idlPath = path.resolve(__dirname, process.env.IDL_PATH!);
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));

  const keeperWallet = new anchor.Wallet(keeper);
  const keeperProvider = new anchor.AnchorProvider(connection, keeperWallet, { commitment: "confirmed" });
  const keeperProgram = new anchor.Program(idl, keeperProvider);

  const adminWallet = new anchor.Wallet(admin);
  const adminProvider = new anchor.AnchorProvider(connection, adminWallet, { commitment: "confirmed" });
  const adminProgram = new anchor.Program(idl, adminProvider);

  const solVaultPda = new PublicKey("9M116Q6o28DXutKwtaaHK3QCf7oAgNfHXAjVyYPs3T18");
  const usdcVaultPda = new PublicKey("Fr4icKU4YGWh1W3FtHjKj43jwo6ivVQyCdkiQAxMwG1C");

  // ── Step 1: recall from Marinade ──────────────────────────────────────
  const solVault: any = await (keeperProgram.account as any).vault.fetch(solVaultPda);
  const marinadeIdx = solVault.protocols.findIndex((p: any) => Buffer.from(p.label).toString().startsWith("marinade-sol"));
  const marinadeProtocol = solVault.protocols[marinadeIdx];

  if (marinadeProtocol.deployedBalance.toNumber() > 0) {
    // KNOWN BUG on this deployed (round-3) program: recall_from_marinade's on-chain
    // liquid_unstake discriminator is wrong (fixed in source, but this program predates
    // the fix and can't be upgraded — see project memory). This will always fail here.
    // We attempt it anyway (in case a future redeploy of this same program ID ever fixes
    // it) but don't let the failure block withdrawing the rest of the vault's funds.
    try {
      const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), solVaultPda.toBuffer()], programId);
      const vaultMsolAccount = getAssociatedTokenAddressSync(MSOL_MINT, vaultAuthority, true);
      const msolBal = await connection.getTokenAccountBalance(vaultMsolAccount);
      const msolAmount = new anchor.BN(msolBal.value.amount);
      console.log("Recalling from Marinade, mSOL amount:", msolAmount.toString());

      const sig = await keeperProgram.methods
        .recallFromMarinade(marinadeIdx, msolAmount)
        .accounts({
          keeper: keeper.publicKey,
          vault: solVaultPda,
          vaultAuthority,
          vaultTokenAccount: solVault.vaultTokenAccount,
          marinadeState: MARINADE_STATE,
          msolMint: MSOL_MINT,
          liqPoolSolLeg: MARINADE_LIQ_POOL_SOL_LEG,
          liqPoolMsolLeg: MARINADE_LIQ_POOL_MSOL_LEG,
          treasuryMsolAccount: MARINADE_TREASURY_MSOL,
          vaultMsolAccount,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          marinadeProgram: MARINADE_PROGRAM,
        } as any)
        .rpc();
      console.log("Recall from Marinade OK. Tx:", sig);
    } catch (err: any) {
      console.log("Recall from Marinade failed as expected (known bug on this deployed program):", err.message ?? err);
      console.log("Continuing to withdraw the rest of the vault's funds.");
    }
  } else {
    console.log("Nothing deployed to Marinade, skipping recall.");
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
