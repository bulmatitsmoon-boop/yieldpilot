#!/usr/bin/env ts-node
/**
 * test_withdraw.ts — withdraw ALL shares from a vault back to the depositor.
 * Usage: RPC_URL=... KEEPER_KEYPAIR_PATH=... PROGRAM_ID=... IDL_PATH=... ts-node test_withdraw.ts --type usdc
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

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (f: string) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
  const t = get("--type");
  if (t !== "usdc" && t !== "sol") { console.error("Usage: --type usdc|sol [--shares <amount>]"); process.exit(1); }
  return { vaultType: t as "usdc" | "sol", sharesOverride: get("--shares") };
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
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer(), user.publicKey.toBuffer()], programId);
  const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), vaultPda.toBuffer()], programId);

  const vaultAccount = await (program.account as any).vault.fetch(vaultPda);
  const sharesMint = vaultAccount.sharesMint as PublicKey;
  const vaultTokenAccount = vaultAccount.vaultTokenAccount as PublicKey;
  const treasury = vaultAccount.treasury as PublicKey;
  const treasuryTokenAccount = getAssociatedTokenAddressSync(mint, treasury, true);

  const userTokenAccount = getAssociatedTokenAddressSync(mint, user.publicKey, true);
  const userSharesAccount = getAssociatedTokenAddressSync(sharesMint, user.publicKey, true);
  const [userPosition] = PublicKey.findProgramAddressSync([Buffer.from("position"), vaultPda.toBuffer(), user.publicKey.toBuffer()], programId);

  const posAccount = await (program.account as any).userPosition.fetch(userPosition);
  const shares = opts.sharesOverride ? new anchor.BN(opts.sharesOverride) : posAccount.shares;
  console.log("Vault:", vaultPda.toBase58());
  console.log("Vault mint (raw pubkey):", vaultAccount.mint.toBase58());
  console.log("Vault treasury (raw pubkey):", treasury.toBase58());
  console.log("Derived treasuryTokenAccount:", treasuryTokenAccount.toBase58());
  console.log("Derived userTokenAccount:", userTokenAccount.toBase58());
  console.log("Total shares held:", posAccount.shares.toString());
  console.log("Shares to withdraw (this call):", shares.toString());

  if (shares.toNumber() === 0) {
    console.log("No shares to withdraw. Nothing to do.");
    return;
  }

  const sig = await program.methods
    .withdraw(shares, new anchor.BN(0)) // min_amount_out = 0, no slippage guard for this test
    .accounts({
      user: user.publicKey,
      vault: vaultPda,
      vaultAuthority,
      vaultTokenAccount,
      userTokenAccount,
      sharesMint,
      userPosition,
      userSharesAccount,
      treasuryTokenAccount,
      userGateAccount: null,
      whitelistEntry: null,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .rpc();

  console.log("✓ Withdraw OK. Tx:", sig);
}

main().catch(err => {
  console.error("Fatal:", err.message ?? err);
  if (err.logs) console.error(err.logs.join("\n"));
  process.exit(1);
});
