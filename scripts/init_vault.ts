import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";
import path from "path";

// ── Config ────────────────────────────────────────────────────────────────────

const RPC_URL   = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("8c7Boyk91MWkn5jabf5CnYD8DrG6p4hYm9eDdAAWXEKH");

// Devnet USDC mint (Circle's devnet USDC)
const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

// Load admin keypair
const adminKeypairPath = path.resolve(process.env.HOME!, ".config/solana/id.json");
const adminKp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(adminKeypairPath, "utf8")))
);

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(adminKp);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../target/idl/yieldpilot.json"), "utf8")
  );
  const program = new anchor.Program(idl, provider);

  const admin = adminKp.publicKey;

  // Derive PDAs
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), USDC_MINT.toBuffer(), admin.toBuffer()],
    PROGRAM_ID
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), vaultPda.toBuffer()],
    PROGRAM_ID
  );

  const sharesMintKp = Keypair.generate();

  const vaultTokenAccount = await getAssociatedTokenAddress(USDC_MINT, vaultAuthority, true);

  console.log("Admin:          ", admin.toBase58());
  console.log("Vault PDA:      ", vaultPda.toBase58());
  console.log("Vault Authority:", vaultAuthority.toBase58());
  console.log("Shares Mint:    ", sharesMintKp.publicKey.toBase58());
  console.log("Vault Token Acct:", vaultTokenAccount.toBase58());

  const params = {
    perfFeeBps:    new anchor.BN(600),          // stored on-chain; tier system applies at withdrawal
    autoCompound:  true,
    autoRebalance: true,
    tvlCap:        new anchor.BN(10_000 * 1e6), // 10,000 USDC cap to start
    name:          "YieldPilot USDC",
    treasury:      admin,                        // fees go to admin wallet for now
    gateMint:      PublicKey.default,            // no token gating on devnet
    keeper:        admin,                        // admin acts as keeper for now
  };

  console.log("\nInitializing vault with params:");
  console.log("  name:         ", params.name);
  console.log("  tvl_cap:      ", "10,000 USDC");
  console.log("  auto_compound:", params.autoCompound);
  console.log("  auto_rebalance:", params.autoRebalance);
  console.log("  keeper:       ", params.keeper.toBase58());

  const tx = await program.methods
    .initializeVault(params)
    .accounts({
      admin,
      mint:               USDC_MINT,
      vault:              vaultPda,
      vaultAuthority,
      vaultTokenAccount,
      sharesMint:         sharesMintKp.publicKey,
      tokenProgram:       TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram:      anchor.web3.SystemProgram.programId,
      rent:               anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .signers([adminKp, sharesMintKp])
    .rpc();

  console.log("\n✓ Vault initialized!");
  console.log("  Tx:", tx);
  console.log("  Vault:", vaultPda.toBase58());
  console.log("\nAdd to .env:");
  console.log(`  VAULT_ADDRESSES=${vaultPda.toBase58()}`);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
