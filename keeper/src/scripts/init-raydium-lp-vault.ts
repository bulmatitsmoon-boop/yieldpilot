#!/usr/bin/env ts-node
/**
 * init-raydium-lp-vault.ts — initialize a Raydium CLMM LP vault.
 *
 * ======================== STATUS: PARTIALLY RUN, BLOCKED ========================
 * Run for real against live devnet 2026-08-26 (previously never executed). Found and
 * fixed 3 real bugs on the way:
 *   - token_account_0/1 were wired to the VAULT's not-yet-existing ATAs; Raydium's
 *     open_position CPI expects the FUNDER's (admin's) own existing token accounts
 *     here — same lesson already documented from local-harness testing, never applied
 *     to this script.
 *   - vault_authority was never funded before the CPI, which makes it the funder for
 *     the new position + Metaplex metadata rent (~0.09-0.2 SOL, notably more than
 *     Orca's ~0.01 SOL — Raydium's open_position also creates real NFT metadata).
 *   - initialize_raydium_lp_vault does not fit a legacy OR a bare v0 transaction
 *     (measured 1236 and 1278 bytes respectively, against the 1232 limit) — needs a
 *     real Address Lookup Table for the static accounts, built inline here since no
 *     vault exists yet to read from (create-lp-alt.ts assumes a live vault).
 *
 * Now blocked on something INSIDE Raydium's own program, not this script or the
 * on-chain adapter: `open_position` panics with "index out of bounds: the len is 0
 * but the index is 0" at programs/amm/src/instructions/open_position.rs:316. Prime
 * suspect: a missing `tick_array_bitmap_extension` account, which Raydium CLMM pools
 * use for tracking initialized tick arrays beyond the standard range and which
 * neither this script nor InitializeRaydiumLpVault currently passes. Needs its own
 * focused investigation into Raydium's real account requirements before retrying.
 * =============================================================================
 *
 * Usage:
 *   ts-node src/scripts/init-raydium-lp-vault.ts [options]
 *
 * Options:
 *   --pool       <PUBKEY>   Raydium pool_state address (default: real mainnet SOL/USDC pool)
 *   --token-a    <PUBKEY>   token A mint (default: SOL, must match the pool's mintA)
 *   --token-b    <PUBKEY>   token B mint (default: USDC, must match the pool's mintB)
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
import { getRaydiumPositionTickArrays, getRaydiumTickArrayStartIndex, getRaydiumProtocolPositionPda } from "../lpVaultHelpers";

// ─── Constants ────────────────────────────────────────────────────────────────
// Same real SOL/USDC Raydium CLMM pool verified live via Raydium's API
// earlier in this work (2026-07-09) — same address used in
// tests/lp-vault-raydium.ts, independently verified from the Orca pool.
// Network-dependent, same as the on-chain program's own RAYDIUM_CLMM_PROGRAM_ID
// (adapters/raydium.rs) — devnet and mainnet Raydium CLMM live at different
// addresses. Defaults to devnet; set RAYDIUM_PROGRAM_ID=CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
// when targeting mainnet.
const RAYDIUM_CLMM_PROGRAM_ID = new PublicKey(
  process.env.RAYDIUM_PROGRAM_ID || "DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH"
);
const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const DEFAULT_POOL_STATE = new PublicKey("3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv");
const DEFAULT_SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const DEFAULT_USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// ─── CLI parsing ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (f: string) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
  const has = (f: string) => args.includes(f);

  return {
    poolState: get("--pool") ? new PublicKey(get("--pool")!) : DEFAULT_POOL_STATE,
    tokenAMint: get("--token-a") ? new PublicKey(get("--token-a")!) : DEFAULT_SOL_MINT,
    tokenBMint: get("--token-b") ? new PublicKey(get("--token-b")!) : DEFAULT_USDC_MINT,
    width: parseInt(get("--width") ?? "8000"),
    name: get("--name") ?? "YieldPilot Raydium LP",
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
 * Byte-offset decode of a Raydium pool_state account — same verified
 * offsets as app/src/hooks/useLpVault.ts's decodeRaydiumPool.
 */
function readRaydiumPool(data: Buffer) {
  const readU128LE = (offset: number) => {
    const low = data.readBigUInt64LE(offset);
    const high = data.readBigUInt64LE(offset + 8);
    return (high << 64n) | low;
  };
  return {
    tokenMintA: new PublicKey(data.subarray(73, 105)),
    tokenMintB: new PublicKey(data.subarray(105, 137)),
    tokenVaultA: new PublicKey(data.subarray(137, 169)),
    tokenVaultB: new PublicKey(data.subarray(169, 201)),
    tickSpacing: data.readUInt16LE(235),
    sqrtPriceX64: readU128LE(253),
    tickCurrent: data.readInt32LE(269),
  };
}

function getMetadataPda(mint: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID
  );
  return address;
}
function getPersonalPositionPda(positionNftMint: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), positionNftMint.toBuffer()],
    RAYDIUM_CLMM_PROGRAM_ID
  );
  return address;
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

  console.log(`Reading pool_state ${opts.poolState.toBase58()}...`);
  const poolAccountInfo = await connection.getAccountInfo(opts.poolState);
  if (!poolAccountInfo) {
    console.error(`pool_state account not found at ${opts.poolState.toBase58()} — check --pool and RPC_URL/network.`);
    process.exit(1);
  }
  const pool = readRaydiumPool(poolAccountInfo.data);
  if (!pool.tokenMintA.equals(opts.tokenAMint) || !pool.tokenMintB.equals(opts.tokenBMint)) {
    console.error(
      `Mint mismatch: this pool is ${pool.tokenMintA.toBase58()}/${pool.tokenMintB.toBase58()}, ` +
      `but --token-a/--token-b said ${opts.tokenAMint.toBase58()}/${opts.tokenBMint.toBase58()}.`
    );
    process.exit(1);
  }

  const align = (t: number) => Math.round(t / pool.tickSpacing) * pool.tickSpacing;
  const halfWidth = Math.floor(opts.width / 2);
  const tickLowerIndex = align(pool.tickCurrent - halfWidth);
  const tickUpperIndex = align(pool.tickCurrent + halfWidth);
  const tickArrayLowerStartIndex = getRaydiumTickArrayStartIndex(tickLowerIndex, pool.tickSpacing);
  const tickArrayUpperStartIndex = getRaydiumTickArrayStartIndex(tickUpperIndex, pool.tickSpacing);
  const { tickArrayLower, tickArrayUpper } = getRaydiumPositionTickArrays(
    opts.poolState, tickLowerIndex, tickUpperIndex, pool.tickSpacing, RAYDIUM_CLMM_PROGRAM_ID
  );
  const protocolPositionPda = getRaydiumProtocolPositionPda(opts.poolState, tickLowerIndex, tickUpperIndex, RAYDIUM_CLMM_PROGRAM_ID);

  // Trailing 1 = Raydium — mirrors InitializeRaydiumLpVault's seed exactly, so a
  // Raydium and an Orca vault on the same pair no longer collide at the same PDA.
  const [lpVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_vault"), opts.tokenAMint.toBuffer(), opts.tokenBMint.toBuffer(), admin.publicKey.toBuffer(), Buffer.from([1])],
    programId
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_vault_authority"), lpVaultPda.toBuffer()],
    programId
  );
  const vaultTokenAAccount = getAssociatedTokenAddressSync(opts.tokenAMint, vaultAuthority, true);
  const vaultTokenBAccount = getAssociatedTokenAddressSync(opts.tokenBMint, vaultAuthority, true);
  // token_account_0/1 are the FUNDER's (admin's) own existing token accounts on
  // initialize, not the vault's — the vault's ATAs don't exist yet at this point, so
  // passing them here fails AccountNotInitialized (3012). Raydium's open_position CPI
  // uses these as the transfer source for the position's initial (typically dust)
  // liquidity; the vault's own ATAs are a separate pair of accounts created earlier in
  // the same instruction. Confirmed on first-ever live execution, 2026-08-26 — matches
  // the identical gotcha already documented from local-harness testing.
  const adminTokenAAccount = getAssociatedTokenAddressSync(opts.tokenAMint, admin.publicKey);
  const adminTokenBAccount = getAssociatedTokenAddressSync(opts.tokenBMint, admin.publicKey);
  const sharesMintKp = Keypair.generate();
  const positionNftMintKp = Keypair.generate();
  const positionNftAccount = getAssociatedTokenAddressSync(positionNftMintKp.publicKey, vaultAuthority, true);
  const metadataAccount = getMetadataPda(positionNftMintKp.publicKey);
  const personalPositionPda = getPersonalPositionPda(positionNftMintKp.publicKey);

  console.log(`\nAdmin:              ${admin.publicKey.toBase58()}`);
  console.log(`LP Vault PDA:       ${lpVaultPda.toBase58()}`);
  console.log(`Vault authority:    ${vaultAuthority.toBase58()}`);
  console.log(`Vault token A:      ${vaultTokenAAccount.toBase58()}`);
  console.log(`Vault token B:      ${vaultTokenBAccount.toBase58()}`);
  console.log(`Shares mint:        ${sharesMintKp.publicKey.toBase58()}`);
  console.log(`Position NFT mint:  ${positionNftMintKp.publicKey.toBase58()}`);
  console.log(`Personal position:  ${personalPositionPda.toBase58()}`);
  console.log(`Protocol position:  ${protocolPositionPda.toBase58()}`);
  console.log(`Keeper:             ${keeper.toBase58()}`);
  console.log(`Treasury:           ${treasury.toBase58()}`);
  console.log(`Name:               "${opts.name}"`);
  console.log(`\nPool state:         ${opts.poolState.toBase58()}`);
  console.log(`Current tick:       ${pool.tickCurrent} (tickSpacing ${pool.tickSpacing})`);
  console.log(`Range:              [${tickLowerIndex}, ${tickUpperIndex}] (width ${opts.width})`);
  console.log(`Tick array lower:   ${tickArrayLower.toBase58()} (start ${tickArrayLowerStartIndex})`);
  console.log(`Tick array upper:   ${tickArrayUpper.toBase58()} (start ${tickArrayUpperStartIndex})`);

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

  // Same requirement as Orca's init: Raydium's own open_position CPI makes
  // vault_authority the funder for the new position's rent. A brand-new PDA holds 0
  // lamports, so without this the CPI fails with "insufficient lamports 0, need
  // 1461600" — confirmed live on devnet 2026-08-26, same class of bug as
  // init-orca-lp-vault.ts's identical fix.
  // 0.09 SOL, not 0.01 — measured live: Raydium's open_position also creates real
  // Metaplex metadata (unlike Orca's plainer position), and one attempt at 0.01 SOL
  // failed needing 0.072161280 SOL total. Overshoot slightly for margin.
  const vaultAuthorityBalance = await connection.getBalance(vaultAuthority);
  if (vaultAuthorityBalance < 0.2e9) {
    const topUp = 0.2e9 - vaultAuthorityBalance;
    console.log(`\nFunding vault authority ${vaultAuthority.toBase58()} with ${(topUp / 1e9).toFixed(4)} SOL for Raydium's position + metadata rent...`);
    const fundSig = await connection.sendTransaction(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: vaultAuthority, lamports: topUp })
      ),
      [admin]
    );
    await connection.confirmTransaction(fundSig, "confirmed");
    console.log(`  Funded: ${fundSig}`);
  }

  console.log("\nInitializing Raydium LP vault...");
  try {
    // initialize_raydium_lp_vault does not fit a legacy transaction (measured: 1236 >
    // 1232 bytes here; the project's own local-harness notes record 1245 bytes on a
    // slightly different account set) — it needs a compute-budget bump (Metaplex
    // metadata creation exceeds the 200k default) on top of ~26 accounts. A versioned
    // (v0) message alone (no ALT) saves enough overhead vs. legacy to fit; confirmed
    // live 2026-08-26. Production paths needing an ALT (redeploy, etc.) are a separate,
    // already-solved concern (see solanaClient.ts's sendV0) — this is init-only.
    const ix = await program.methods
      .initializeRaydiumLpVault({
        keeper,
        treasury,
        tickLowerIndex,
        tickUpperIndex,
        tickArrayLowerStartIndex,
        tickArrayUpperStartIndex,
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
        positionNftMint: positionNftMintKp.publicKey,
        positionNftAccount,
        metadataAccount,
        poolState: opts.poolState,
        protocolPosition: protocolPositionPda,
        tickArrayLower,
        tickArrayUpper,
        personalPosition: personalPositionPda,
        tokenAccount0: adminTokenAAccount,
        tokenAccount1: adminTokenBAccount,
        tokenVault0: pool.tokenVaultA,
        tokenVault1: pool.tokenVaultB,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        metadataProgram: METADATA_PROGRAM_ID,
        raydiumProgram: RAYDIUM_CLMM_PROGRAM_ID,
      })
      .instruction();

    // A v0 message alone doesn't fit either (measured: 1278 bytes, worse than legacy's
    // 1236 — v0 header overhead outweighs the saving on this account count). Needs a
    // real ALT for the STATIC accounts, matching the project's own documented finding
    // (878 bytes with an ALT vs 1245 without, from the original local-harness work).
    // Built here as a one-shot table for the init call specifically — everything
    // vault-derived doesn't exist yet, so this can't reuse create-lp-alt.ts, which
    // assumes a live vault to read from.
    const staticAddresses = [
      RAYDIUM_CLMM_PROGRAM_ID, METADATA_PROGRAM_ID,
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId, SYSVAR_RENT_PUBKEY,
      opts.poolState, opts.tokenAMint, opts.tokenBMint, pool.tokenVaultA, pool.tokenVaultB,
      protocolPositionPda, tickArrayLower, tickArrayUpper,
    ];
    const altSlot = await connection.getSlot("finalized");
    const [createAltIx, altAddress] = anchor.web3.AddressLookupTableProgram.createLookupTable({
      authority: admin.publicKey, payer: admin.publicKey, recentSlot: altSlot,
    });
    const extendAltIx = anchor.web3.AddressLookupTableProgram.extendLookupTable({
      payer: admin.publicKey, authority: admin.publicKey, lookupTable: altAddress, addresses: staticAddresses,
    });
    const setupSig = await connection.sendTransaction(
      new anchor.web3.Transaction().add(createAltIx, extendAltIx), [admin]
    );
    await connection.confirmTransaction(setupSig, "confirmed");
    console.log(`  Created ALT ${altAddress.toBase58()} (${setupSig})`);
    // A lookup table is only usable one slot after being extended.
    await new Promise((r) => setTimeout(r, 2000));
    const altAccount = (await connection.getAddressLookupTable(altAddress)).value!;

    const computeIx = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
    const { blockhash } = await connection.getLatestBlockhash();
    const msg = new anchor.web3.TransactionMessage({
      payerKey: admin.publicKey,
      recentBlockhash: blockhash,
      instructions: [computeIx, ix],
    }).compileToV0Message([altAccount]);
    const vtx = new anchor.web3.VersionedTransaction(msg);
    vtx.sign([admin, sharesMintKp, positionNftMintKp]);
    console.log(`  Transaction size: ${vtx.serialize().length} bytes`);
    const sig = await connection.sendTransaction(vtx);
    await connection.confirmTransaction(sig, "confirmed");
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
