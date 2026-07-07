#!/usr/bin/env ts-node
/**
 * test_deposit_sol.ts — wrap native SOL into wSOL, then deposit into the mainnet SOL vault.
 * Usage: RPC_URL=... KEEPER_KEYPAIR_PATH=... PROGRAM_ID=... IDL_PATH=... ts-node test_deposit_sol.ts --amount 30000000
 */
import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import fs from "fs";
import path from "path";
import os from "os";

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (f: string) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
  return { amount: get("--amount")! };
}

async function main() {
  const opts = parseArgs();
  const rpcUrl = process.env.RPC_URL!;
  const connection = new Connection(rpcUrl, { commitment: "confirmed" });

  const keypairPath = process.env.KEEPER_KEYPAIR_PATH!.replace("~", os.homedir());
  const user = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(keypairPath), "utf8"))));

  const programId = new PublicKey(process.env.PROGRAM_ID!);
  const wallet = new anchor.Wallet(user);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idlPath = path.resolve(__dirname, process.env.IDL_PATH!);
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const program = new anchor.Program(idl, provider);

  const userWsolAccount = getAssociatedTokenAddressSync(WSOL_MINT, user.publicKey, false);
  const amount = Number(opts.amount);

  // ── Step 1: wrap SOL ──────────────────────────────────────────────────────
  console.log("Wrapping", amount, "lamports into WSOL...");
  const wrapTx = new Transaction();
  wrapTx.add(
    createAssociatedTokenAccountIdempotentInstruction(user.publicKey, userWsolAccount, user.publicKey, WSOL_MINT),
    SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: userWsolAccount, lamports: amount }),
    createSyncNativeInstruction(userWsolAccount),
  );
  const { blockhash } = await connection.getLatestBlockhash();
  wrapTx.recentBlockhash = blockhash;
  wrapTx.feePayer = user.publicKey;
  wrapTx.sign(user);
  const wrapSig = await connection.sendRawTransaction(wrapTx.serialize());
  await connection.confirmTransaction(wrapSig, "confirmed");
  console.log("✓ Wrapped. Tx:", wrapSig);

  // ── Step 2: deposit ───────────────────────────────────────────────────────
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), WSOL_MINT.toBuffer(), user.publicKey.toBuffer()], programId);
  const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), vaultPda.toBuffer()], programId);

  const vaultAccount = await (program.account as any).vault.fetch(vaultPda);
  const sharesMint = vaultAccount.sharesMint as PublicKey;
  const vaultTokenAccount = vaultAccount.vaultTokenAccount as PublicKey;

  const userSharesAccount = getAssociatedTokenAddressSync(sharesMint, user.publicKey, true);
  const [userPosition] = PublicKey.findProgramAddressSync([Buffer.from("position"), vaultPda.toBuffer(), user.publicKey.toBuffer()], programId);

  console.log("Vault:", vaultPda.toBase58());
  console.log("Depositing", amount, "lamports...");

  const sig = await program.methods
    .deposit(new anchor.BN(amount))
    .accounts({
      user: user.publicKey,
      vault: vaultPda,
      vaultAuthority,
      vaultTokenAccount,
      userTokenAccount: userWsolAccount,
      sharesMint,
      userPosition,
      userSharesAccount,
      userGateAccount: null as any,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("✓ Deposit OK. Tx:", sig);
}

main().catch(err => {
  console.error("Fatal:", err.message ?? err);
  if (err.logs) console.error(err.logs.join("\n"));
  process.exit(1);
});
