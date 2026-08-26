#!/usr/bin/env ts-node
/**
 * init-orca-lp-vault.ts — initialize an Orca Whirlpool LP vault.
 *
 * ============================== STATUS: UNRUN ==============================
 * Mirrors init-vault.ts's CLI/dry-run/retry conventions exactly, but this
 * has NOT been executed against any real cluster — no deployed LP vault
 * program exists yet to run it against. Treat as "should be correct by
 * inspection, same rigor as the local-validator test drafts," not
 * "confirmed working." Run --dry-run first once there IS a deployed
 * program, and check the printed accounts/PDAs look sane before dropping
 * --dry-run.
 * =============================================================================
 *
 * Usage:
 *   ts-node src/scripts/init-orca-lp-vault.ts [options]
 *
 * Options:
 *   --whirlpool  <PUBKEY>   Whirlpool pool address (default: real mainnet SOL/USDC pool)
 *   --token-a    <PUBKEY>   token A mint (default: SOL, must match the whirlpool's tokenMintA)
 *   --token-b    <PUBKEY>   token B mint (default: USDC, must match the whirlpool's tokenMintB)
 *   --width      8000       total tick-range width, centered on current price (default 8000)
 *   --name       "..."      vault display name
 *   --keeper     <PUBKEY>   keeper pubkey (default: same as admin)
 *   --treasury   <PUBKEY>   treasury pubkey (default: same as admin)
 *   --dry-run               print plan without sending transactions
 */

import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import fs from "fs";
import path from "path";
import os from "os";
import { getPositionTickArrays } from "../lpVaultHelpers";

// ─── Constants ────────────────────────────────────────────────────────────────
// Same real SOL/USDC Whirlpool verified live via Orca's API earlier in this
// work (2026-07-09) — same address used in tests/lp-vault-orca.ts, not a
// second, independently-guessed one.
const WHIRLPOOL_PROGRAM_ID = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const DEFAULT_WHIRLPOOL = new PublicKey("Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE");
const DEFAULT_SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const DEFAULT_USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// ─── CLI parsing ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (f: string) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
  const has = (f: string) => args.includes(f);

  return {
    whirlpool: get("--whirlpool") ? new PublicKey(get("--whirlpool")!) : DEFAULT_WHIRLPOOL,
    tokenAMint: get("--token-a") ? new PublicKey(get("--token-a")!) : DEFAULT_SOL_MINT,
    tokenBMint: get("--token-b") ? new PublicKey(get("--token-b")!) : DEFAULT_USDC_MINT,
    width: parseInt(get("--width") ?? "8000"),
    name: get("--name") ?? "YieldPilot Orca LP",
    keeperArg: get("--keeper"),
    treasuryArg: get("--treasury"),
    dryRun: has("--dry-run"),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function retryFetch<T>(fn: () => Promise<T>, attempts = 6, delayMs = 1500): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const msg = err.message ?? String(err);
      if (!msg.includes("Account does not exist") && !msg.includes("has no data")) throw err;
      console.log(`  (RPC read-lag, retry ${i + 1}/${attempts}...)`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/**
 * Byte-offset decode of a Whirlpool account — same verified offsets as
 * app/src/hooks/useLpVault.ts's decodeWhirlpool.
 */
function readWhirlpool(data: Buffer) {
  const readU128LE = (offset: number) => {
    const low = data.readBigUInt64LE(offset);
    const high = data.readBigUInt64LE(offset + 8);
    return (high << 64n) | low;
  };
  return {
    tickSpacing: data.readUInt16LE(41),
    sqrtPrice: readU128LE(65),
    tickCurrent: data.readInt32LE(81),
    tokenMintA: new PublicKey(data.subarray(101, 133)),
    tokenVaultA: new PublicKey(data.subarray(133, 165)),
    tokenMintB: new PublicKey(data.subarray(181, 213)),
    tokenVaultB: new PublicKey(data.subarray(213, 245)),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  const rpcUrl = process.env.RPC_URL || "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, { commitment: "confirmed" });

  const keypairPath = (process.env.KEEPER_KEYPAIR_PATH || "~/.config/solana/id.json")
    .replace("~", os.homedir());
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(keypairPath), "utf8")))
  );

  const keeper = opts.keeperArg ? new PublicKey(opts.keeperArg) : admin.publicKey;
  const treasury = opts.treasuryArg ? new PublicKey(opts.treasuryArg) : admin.publicKey;

  const programId = new PublicKey(process.env.PROGRAM_ID!);
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idlPath = path.resolve(__dirname, process.env.IDL_PATH || "../idl/yieldpilot.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const program = new anchor.Program(idl, provider);

  console.log(`Reading Whirlpool ${opts.whirlpool.toBase58()}...`);
  const whirlpoolInfo = await connection.getAccountInfo(opts.whirlpool);
  if (!whirlpoolInfo) {
    console.error(`Whirlpool account not found at ${opts.whirlpool.toBase58()} — check --whirlpool and RPC_URL/network.`);
    process.exit(1);
  }
  const pool = readWhirlpool(whirlpoolInfo.data);
  if (!pool.tokenMintA.equals(opts.tokenAMint) || !pool.tokenMintB.equals(opts.tokenBMint)) {
    console.error(
      `Mint mismatch: this whirlpool is ${pool.tokenMintA.toBase58()}/${pool.tokenMintB.toBase58()}, ` +
      `but --token-a/--token-b said ${opts.tokenAMint.toBase58()}/${opts.tokenBMint.toBase58()}.`
    );
    process.exit(1);
  }

  // Center a range on the pool's current tick, aligned to its tick spacing —
  // matches the same approach used in tests/lp-vault-orca.ts.
  const align = (t: number) => Math.round(t / pool.tickSpacing) * pool.tickSpacing;
  const halfWidth = Math.floor(opts.width / 2);
  const tickLowerIndex = align(pool.tickCurrent - halfWidth);
  const tickUpperIndex = align(pool.tickCurrent + halfWidth);
  const { tickArrayLower, tickArrayUpper } = getPositionTickArrays(
    opts.whirlpool, tickLowerIndex, tickUpperIndex, pool.tickSpacing, WHIRLPOOL_PROGRAM_ID
  );

  const [lpVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_vault"), opts.tokenAMint.toBuffer(), opts.tokenBMint.toBuffer(), admin.publicKey.toBuffer()],
    programId
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_vault_authority"), lpVaultPda.toBuffer()],
    programId
  );
  const vaultTokenAAccount = getAssociatedTokenAddressSync(opts.tokenAMint, vaultAuthority, true);
  const vaultTokenBAccount = getAssociatedTokenAddressSync(opts.tokenBMint, vaultAuthority, true);
  const sharesMintKp = Keypair.generate();
  // `position` is a Whirlpool-owned PDA derived from the position mint, NOT a random
  // keypair the caller signs with — confirmed against solanaClient.ts's own working
  // repositionLpVault, which derives it the same way. Found live 2026-08-26: this
  // script originally generated a fresh Keypair for `position` and passed it as a
  // co-signer, which fails with "unknown signer" since Anchor can't find a signature
  // matching a pubkey the program expects to derive itself via CPI into Orca.
  const positionMintKp = Keypair.generate();
  const [positionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), positionMintKp.publicKey.toBuffer()],
    WHIRLPOOL_PROGRAM_ID
  );
  const positionTokenAccount = getAssociatedTokenAddressSync(positionMintKp.publicKey, vaultAuthority, true);

  console.log(`\nAdmin:            ${admin.publicKey.toBase58()}`);
  console.log(`LP Vault PDA:     ${lpVaultPda.toBase58()}`);
  console.log(`Vault authority:  ${vaultAuthority.toBase58()}`);
  console.log(`Vault token A:    ${vaultTokenAAccount.toBase58()}`);
  console.log(`Vault token B:    ${vaultTokenBAccount.toBase58()}`);
  console.log(`Shares mint:      ${sharesMintKp.publicKey.toBase58()}`);
  console.log(`Position:         ${positionPda.toBase58()}`);
  console.log(`Position mint:    ${positionMintKp.publicKey.toBase58()}`);
  console.log(`Keeper:           ${keeper.toBase58()}`);
  console.log(`Treasury:         ${treasury.toBase58()}`);
  console.log(`Name:             "${opts.name}"`);
  console.log(`\nWhirlpool:        ${opts.whirlpool.toBase58()}`);
  console.log(`Current tick:     ${pool.tickCurrent} (tickSpacing ${pool.tickSpacing})`);
  console.log(`Range:            [${tickLowerIndex}, ${tickUpperIndex}] (width ${opts.width})`);
  console.log(`Tick array lower: ${tickArrayLower.toBase58()}`);
  console.log(`Tick array upper: ${tickArrayUpper.toBase58()}`);

  if (opts.dryRun) {
    console.log("\n[DRY RUN] No transactions sent.");
    console.log(`\nLP_VAULT_ADDRESSES=${lpVaultPda.toBase58()}`);
    return;
  }

  const balance = await connection.getBalance(admin.publicKey);
  console.log(`\nAdmin balance: ${(balance / 1e9).toFixed(4)} SOL`);
  if (balance < 0.05e9) {
    console.error("Need >= 0.05 SOL to initialize. Fund wallet and retry.");
    process.exit(1);
  }

  // Orca's own open_position CPI makes vault_authority the `funder` — it pays the new
  // Position account's rent directly via a native SystemProgram transfer INSIDE Orca's
  // program, not something our own program funds on the PDA's behalf. A brand-new PDA
  // holds 0 lamports, so without this the CPI fails with "insufficient lamports 0, need
  // 2394240" — confirmed live on devnet 2026-08-26, first real execution of this script.
  // This mirrors the known design note (see project memory on LP vault design) that the
  // harness pre-funds vault_authority before init for the same reason.
  const vaultAuthorityBalance = await connection.getBalance(vaultAuthority);
  if (vaultAuthorityBalance < 0.01e9) {
    console.log(`\nFunding vault authority ${vaultAuthority.toBase58()} with 0.01 SOL for Orca's position rent...`);
    const fundSig = await connection.sendTransaction(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: vaultAuthority, lamports: 0.01e9 })
      ),
      [admin]
    );
    await connection.confirmTransaction(fundSig, "confirmed");
    console.log(`  Funded: ${fundSig}`);
  }

  console.log("\nInitializing Orca LP vault...");
  try {
    const sig = await program.methods
      .initializeOrcaLpVault({
        keeper,
        treasury,
        tickLowerIndex,
        tickUpperIndex,
        tickArrayLowerStartIndex: 0, // unused by the Orca path, Raydium-only field
        tickArrayUpperStartIndex: 0,
        name: opts.name,
      })
      .accounts({
        admin: admin.publicKey,
        lpVault: lpVaultPda,
        vaultAuthority,
        tokenAMint: opts.tokenAMint,
        tokenBMint: opts.tokenBMint,
        vaultTokenAAccount,
        vaultTokenBAccount,
        lpSharesMint: sharesMintKp.publicKey,
        position: positionPda,
        positionMint: positionMintKp.publicKey,
        positionTokenAccount,
        whirlpool: opts.whirlpool,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        whirlpoolProgram: WHIRLPOOL_PROGRAM_ID,
      })
      .signers([admin, sharesMintKp, positionMintKp])
      .rpc();
    console.log(`  OK ${sig}`);
  } catch (err: any) {
    const logs: string[] = err.logs ?? [];
    if (logs.some((l: string) => l.includes("already in use"))) {
      console.log("  LP vault already exists, nothing to do.");
    } else {
      throw err;
    }
  }

  await retryFetch(() => (program.account as any).lpVault.fetch(lpVaultPda));

  console.log("\nLP vault ready!\n");
  console.log("Add to your keeper .env:");
  console.log(`  LP_VAULT_ADDRESSES=${lpVaultPda.toBase58()}`);
  console.log(`\nSave your shares mint: ${sharesMintKp.publicKey.toBase58()}`);
}

main().catch(err => {
  console.error("Fatal:", err.message ?? err);
  if (err.logs) console.error(err.logs.join("\n"));
  process.exit(1);
});
