/**
 * scripts/deploy.ts
 * Run after `anchor deploy --provider.cluster devnet` to initialize the vault.
 *
 * Usage:
 *   cd /root/yieldpilot
 *   ts-node scripts/deploy.ts
 */
import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, clusterApiUrl,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";

// ── Config ────────────────────────────────────────────────────────────────────

const CLUSTER = (process.argv.find(a => a === "mainnet-beta") ? "mainnet-beta" : "devnet") as "devnet" | "mainnet-beta";
const RPC_URL = CLUSTER === "mainnet-beta" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com";
const KEYPAIR_PATH = "~/.config/solana/id.json".replace("~", os.homedir());

// Devnet USDC — Circle's devnet faucet token
// Get test USDC at: https://spl-token-faucet.com/?token-name=USDC-Dev
const USDC_MINT: Record<string, string> = {
  devnet:        "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  "mainnet-beta":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n⚡ YieldPilot Vault Init`);
  console.log(`   Cluster: ${CLUSTER}`);
  console.log(`   RPC:     ${RPC_URL}\n`);

  // Load admin keypair
  const raw = JSON.parse(fs.readFileSync(path.resolve(KEYPAIR_PATH), "utf8"));
  const admin = Keypair.fromSecretKey(Uint8Array.from(raw));
  console.log(`   Admin:   ${admin.publicKey.toBase58()}`);

  const connection = new Connection(RPC_URL, "confirmed");
  const balance = await connection.getBalance(admin.publicKey);
  console.log(`   Balance: ${(balance / 1e9).toFixed(4)} SOL\n`);

  if (balance < 0.05e9) {
    console.error("✗ Insufficient SOL. Need at least 0.05 SOL.");
    process.exit(1);
  }

  // Load IDL
  const idlPath = path.resolve(__dirname, "../target/idl/yieldpilot.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));

  // Build provider — Anchor 0.31: Program(idl, provider)
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new anchor.Program(idl, provider);

  const usdcMint = new PublicKey(USDC_MINT[CLUSTER]);

  // Derive vault PDA — seeds: ["vault", mint, admin]
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), usdcMint.toBuffer(), admin.publicKey.toBuffer()],
    program.programId
  );
  // Derive authority PDA — seeds: ["vault", vault]
  const [authorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), vaultPda.toBuffer()],
    program.programId
  );
  const vaultTokenAccount = await getAssociatedTokenAddress(usdcMint, authorityPda, true);
  const sharesMintKeypair = Keypair.generate();

  // TVL cap: $1000 USDC on devnet, $500 on mainnet (launch cap — raise later)
  const tvlCap = CLUSTER === "mainnet-beta"
    ? new anchor.BN(500 * 1_000_000)
    : new anchor.BN(1000 * 1_000_000);

  console.log("── Initializing vault ────────────────────────────────────────────");
  console.log(`   Vault:       ${vaultPda.toBase58()}`);
  console.log(`   Authority:   ${authorityPda.toBase58()}`);
  console.log(`   Shares mint: ${sharesMintKeypair.publicKey.toBase58()}`);
  console.log(`   TVL cap:     $${tvlCap.toNumber() / 1_000_000} USDC`);

  // Check if already initialized
  const existing = await connection.getAccountInfo(vaultPda);
  if (existing) {
    console.log("\n   ℹ Vault already exists — skipping init");
  } else {
    const sig = await (program.methods as any)
      .initializeVault({
        perfFeeBps:    new anchor.BN(500),   // 5% performance fee
        autoCompound:  true,
        autoRebalance: true,
        tvlCap,
        name:          "USDC Yield Vault",
        treasury:      admin.publicKey,      // perf fees → admin wallet (change later)
        gateMint:      PublicKey.default,    // no token gating initially
      })
      .accounts({
        admin:                  admin.publicKey,
        mint:                   usdcMint,
        vault:                  vaultPda,
        vaultAuthority:         authorityPda,
        vaultTokenAccount,
        sharesMint:             sharesMintKeypair.publicKey,
        tokenProgram:           TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram:          SystemProgram.programId,
        rent:                   SYSVAR_RENT_PUBKEY,
      })
      .signers([sharesMintKeypair])
      .rpc();

    console.log(`\n   ✓ Vault initialized!`);
    console.log(`   Signature: ${sig}`);
  }

  // ── Output ────────────────────────────────────────────────────────────────
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DONE. Add this to Netlify environment variables:

  NEXT_PUBLIC_VAULT_ADDRESSES=${vaultPda.toBase58()}

  Also update keeper/.env:
  VAULT_ADDRESSES=${vaultPda.toBase58()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `);
}

main().catch(err => {
  console.error("\n✗ Deploy failed:", err.message ?? err);
  process.exit(1);
});
