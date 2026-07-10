#!/usr/bin/env ts-node
/**
 * init-vault.ts — YieldPilot vault initializer
 *
 * Usage:
 *   ts-node src/scripts/init-vault.ts --type usdc [options]
 *   ts-node src/scripts/init-vault.ts --type sol  [options]
 *
 * Options:
 *   --type      usdc | sol
 *   --name      "My Vault"             (default: "YieldPilot USDC" / "YieldPilot SOL")
 *   --fee       500                    perf fee bps (default: 500 = 5%)
 *   --cap       1000000000000          TVL cap in base units
 *   --gate      <MINT_PUBKEY>          optional pump.fun gate token
 *   --keeper    <PUBKEY>               keeper pubkey (default: same as admin)
 *   --treasury  <PUBKEY>               treasury pubkey (default: same as admin)
 *   --dry-run                          print plan without sending transactions
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

// ─── Constants ────────────────────────────────────────────────────────────────

const USDC_MINT  = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL_MINT  = new PublicKey("So11111111111111111111111111111111111111112");

// Kamino USDC — verified against solanaClient.ts (reserve.collateral.mintPubkey), 2026-07
const KAMINO_USDC_RESERVE         = new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59");
const KAMINO_USDC_COLLATERAL_MINT = new PublicKey("B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D");

const MSOL_MINT    = new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");
const JITOSOL_MINT = new PublicKey("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");
const JITO_POOL    = new PublicKey("Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb");
const MARINADE_STATE = new PublicKey("8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC");

// Solend USDC — matches SOLEND_* constants in keeper/src/solanaClient.ts
const SOLEND_USDC_RESERVE         = new PublicKey("BgxfHJDzm44T7XG68MYKx7YisTjZu73tVovyZSjJMpmw");
const SOLEND_USDC_COLLATERAL_MINT = new PublicKey("993dVFL2uXWYeoXuEBFXR4BijeXdTv4s6BzsCjJZuwqk");

// ─── Protocol definitions ─────────────────────────────────────────────────────

interface ProtocolDef {
  label: string;
  kind: number;           // 0=Kamino, 1=Marinade, 2=Solend, 3=Jito — see ProtocolKind in adapters/mod.rs
  externalState: PublicKey;
  receiptMint: PublicKey;
  targetBps: number;
}

// USDC vault: 80% Kamino USDC, 20% Solend USDC
// (MarginFi dropped — its deploy/recall CPI was removed from the on-chain program;
// the keeper has no handler for a "marginfi-usdc" label, see solanaClient.ts executeRebalance)
const USDC_PROTOCOLS: ProtocolDef[] = [
  {
    label: "kamino-usdc",
    kind: 0,
    externalState: KAMINO_USDC_RESERVE,
    receiptMint: KAMINO_USDC_COLLATERAL_MINT,
    targetBps: 8000,
  },
  {
    label: "solend-usdc",
    kind: 2,
    externalState: SOLEND_USDC_RESERVE,
    receiptMint: SOLEND_USDC_COLLATERAL_MINT,
    targetBps: 2000,
  },
];

// SOL vault: 80% Jito, 20% Marinade
const SOL_PROTOCOLS: ProtocolDef[] = [
  {
    label: "jito-sol",
    kind: 3,
    externalState: JITO_POOL,
    receiptMint: JITOSOL_MINT,
    targetBps: 8000,
  },
  {
    label: "marinade-sol",
    kind: 1,
    externalState: MARINADE_STATE,
    receiptMint: MSOL_MINT,
    targetBps: 2000,
  },
];

// ─── CLI parsing ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (f: string) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
  const has = (f: string) => args.includes(f);

  const t = get("--type");
  if (t !== "usdc" && t !== "sol") {
    console.error("Usage: ts-node src/scripts/init-vault.ts --type usdc|sol [--name ...] [--fee ...] [--cap ...] [--gate ...] [--keeper ...] [--treasury ...] [--dry-run]");
    process.exit(1);
  }
  return {
    vaultType:   t as "usdc" | "sol",
    name:        get("--name") ?? (t === "usdc" ? "YieldPilot USDC" : "YieldPilot SOL"),
    feeBps:      parseInt(get("--fee") ?? "500"),
    tvlCap:      get("--cap") ?? (t === "usdc" ? "1000000000000" : "1000000000000"),
    gateMint:    get("--gate") ? new PublicKey(get("--gate")!) : PublicKey.default,
    keeperArg:   get("--keeper"),
    treasuryArg: get("--treasury"),
    dryRun:      has("--dry-run"),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Retry a read against a just-confirmed account. RPC nodes can lag a few
 * hundred ms to a couple seconds behind the confirmed slot they just
 * acknowledged a transaction on, so an immediate account fetch right after
 * `.rpc()` resolves can transiently return "Account does not exist or has
 * no data" even though the write already landed. Retry instead of failing.
 */
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

  const keeper   = opts.keeperArg   ? new PublicKey(opts.keeperArg)   : admin.publicKey;
  const treasury = opts.treasuryArg ? new PublicKey(opts.treasuryArg) : admin.publicKey;
  const mint      = opts.vaultType === "usdc" ? USDC_MINT : WSOL_MINT;
  const protocols = opts.vaultType === "usdc" ? USDC_PROTOCOLS : SOL_PROTOCOLS;

  const programId = new PublicKey(process.env.PROGRAM_ID!);
  const wallet    = new anchor.Wallet(admin);
  const provider  = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idlPath = path.resolve(__dirname, process.env.IDL_PATH || "../idl/yieldpilot.json");
  const idl     = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const program  = new anchor.Program(idl, provider);

  const [vaultPda]       = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer(), admin.publicKey.toBuffer()], programId);
  const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), vaultPda.toBuffer()], programId);
  const vaultTokenAccount = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
  const sharesMintKp = Keypair.generate();

  console.log(`Admin:       ${admin.publicKey.toBase58()}`);
  console.log(`Vault PDA:   ${vaultPda.toBase58()}`);
  console.log(`Authority:   ${vaultAuthority.toBase58()}`);
  console.log(`Token acct:  ${vaultTokenAccount.toBase58()}`);
  console.log(`Shares mint: ${sharesMintKp.publicKey.toBase58()}`);
  console.log(`Keeper:      ${keeper.toBase58()}`);
  console.log(`Treasury:    ${treasury.toBase58()}`);
  console.log(`Name:        "${opts.name}"`);
  console.log(`Perf fee:    ${opts.feeBps} bps (${(opts.feeBps / 100).toFixed(2)}%)`);
  console.log(`TVL cap:     ${opts.tvlCap}`);
  console.log("\nProtocols:");
  protocols.forEach((p, i) => {
    const ata = getAssociatedTokenAddressSync(p.receiptMint, vaultAuthority, true);
    console.log(`  [${i}] ${p.label}  ${p.targetBps} bps  receipt-ATA: ${ata.toBase58()}`);
  });

  if (opts.dryRun) {
    console.log("\n[DRY RUN] No transactions sent.");
    console.log(`\nVAULT_ADDRESSES=${vaultPda.toBase58()}`);
    return;
  }

  const balance = await connection.getBalance(admin.publicKey);
  console.log(`\nAdmin balance: ${(balance / 1e9).toFixed(4)} SOL`);
  if (balance < 0.05e9) {
    console.error("Need >= 0.05 SOL to initialize. Fund wallet and retry.");
    process.exit(1);
  }

  // ── 1: Initialize vault ───────────────────────────────────────────────────
  console.log("\n[1/2] Initializing vault...");
  try {
    const sig = await program.methods
      .initializeVault({
        perfFeeBps:    new anchor.BN(opts.feeBps),
        autoCompound:  true,
        autoRebalance: true,
        tvlCap:        new anchor.BN(opts.tvlCap),
        name:          opts.name,
        treasury,
        gateMint:      opts.gateMint,
        keeper,
      })
      .accounts({
        admin:                  admin.publicKey,
        mint,
        vault:                  vaultPda,
        vaultAuthority,
        vaultTokenAccount,
        sharesMint:             sharesMintKp.publicKey,
        tokenProgram:           TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram:          SystemProgram.programId,
        rent:                   SYSVAR_RENT_PUBKEY,
      })
      .signers([admin, sharesMintKp])
      .rpc();
    console.log(`  OK ${sig}`);
  } catch (err: any) {
    const logs: string[] = err.logs ?? [];
    if (logs.some((l: string) => l.includes("already in use"))) {
      console.log("  Vault already exists, skipping init.");
    } else {
      throw err;
    }
  }

  // ── 2: Register protocols ─────────────────────────────────────────────────
  console.log("\n[2/2] Registering protocols...");
  const vaultAccount = await retryFetch(() => (program.account as any).vault.fetch(vaultPda)) as any;
  const alreadyRegistered: number = vaultAccount.protocolCount;
  console.log(`  ${alreadyRegistered} already registered.`);

  for (let i = alreadyRegistered; i < protocols.length; i++) {
    const p = protocols[i];
    const receiptAta = getAssociatedTokenAddressSync(p.receiptMint, vaultAuthority, true);
    console.log(`  Registering [${i}] ${p.label} (${p.targetBps} bps)...`);
    const sig = await program.methods
      .registerProtocol(p.kind, p.externalState, receiptAta, new anchor.BN(p.targetBps), p.label)
      .accounts({ admin: admin.publicKey, vault: vaultPda })
      .rpc();
    console.log(`    OK ${sig}`);
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log("\nVault ready!\n");
  console.log("Add to your .env:");
  console.log(`  VAULT_ADDRESSES=${vaultPda.toBase58()}`);
  console.log(`  PROGRAM_ID=${programId.toBase58()}`);
  console.log(`\nSave your shares mint: ${sharesMintKp.publicKey.toBase58()}`);
}

main().catch(err => {
  console.error("Fatal:", err.message ?? err);
  if (err.logs) console.error(err.logs.join("\n"));
  process.exit(1);
});
