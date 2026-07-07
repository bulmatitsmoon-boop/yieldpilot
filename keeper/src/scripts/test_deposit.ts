#!/usr/bin/env ts-node
/**
 * test_deposit.ts — deposit a small real amount into a live mainnet vault,
 * signed by the same wallet as a regular user (not admin/keeper authority).
 *
 * Usage:
 *   RPC_URL=... KEEPER_KEYPAIR_PATH=/tmp/admin.json PROGRAM_ID=... IDL_PATH=../idl/yieldpilot.mainnet.json \
 *   ts-node test_deposit.ts --type usdc --amount 5000000
 *   (amount is in base units: USDC has 6 decimals, SOL/wSOL has 9)
 */
import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import fs from "fs";
import path from "path";
import os from "os";

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (f: string) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
  const t = get("--type");
  if (t !== "usdc" && t !== "sol") { console.error("Usage: --type usdc|sol --amount <base units>"); process.exit(1); }
  return { vaultType: t as "usdc" | "sol", amount: get("--amount")! };
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

  const mint = opts.vaultType === "usdc" ? USDC_MINT : WSOL_MINT;
  // NOTE: vault was created by the admin wallet, so admin.publicKey is the seed here regardless of who's depositing
  const adminPubkey = user.publicKey; // same wallet used for both admin+test-deposit in this test
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer(), adminPubkey.toBuffer()], programId);
  const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), vaultPda.toBuffer()], programId);

  const vaultAccount = await (program.account as any).vault.fetch(vaultPda);
  const sharesMint = vaultAccount.sharesMint as PublicKey;
  const vaultTokenAccount = vaultAccount.vaultTokenAccount as PublicKey;

  const userTokenAccount = getAssociatedTokenAddressSync(mint, user.publicKey, true);
  const userSharesAccount = getAssociatedTokenAddressSync(sharesMint, user.publicKey, true);
  const [userPosition] = PublicKey.findProgramAddressSync([Buffer.from("position"), vaultPda.toBuffer(), user.publicKey.toBuffer()], programId);

  console.log("Vault:", vaultPda.toBase58());
  console.log("User:", user.publicKey.toBase58());
  console.log("User token acct:", userTokenAccount.toBase58());
  console.log("Amount (base units):", opts.amount);

  const sig = await program.methods
    .deposit(new anchor.BN(opts.amount))
    .accounts({
      user: user.publicKey,
      vault: vaultPda,
      vaultAuthority,
      vaultTokenAccount,
      userTokenAccount,
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
