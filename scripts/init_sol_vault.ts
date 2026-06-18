import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import fs from "fs";
import path from "path";

const RPC_URL    = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("8c7Boyk91MWkn5jabf5CnYD8DrG6p4hYm9eDdAAWXEKH");
const SOL_MINT   = NATIVE_MINT; // Wrapped SOL: So11111111111111111111111111111111111111112

const adminKp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(
    path.resolve(process.env.HOME!, ".config/solana/id.json"), "utf8"
  )))
);

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet     = new anchor.Wallet(adminKp);
  const provider   = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idl     = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../target/idl/yieldpilot.json"), "utf8"));
  const program  = new anchor.Program(idl, provider);
  const admin    = adminKp.publicKey;

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), SOL_MINT.toBuffer(), admin.toBuffer()],
    PROGRAM_ID
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), vaultPda.toBuffer()],
    PROGRAM_ID
  );
  const sharesMintKp      = Keypair.generate();
  const vaultTokenAccount = await getAssociatedTokenAddress(SOL_MINT, vaultAuthority, true);

  console.log("SOL Mint (wSOL):", SOL_MINT.toBase58());
  console.log("Vault PDA:      ", vaultPda.toBase58());
  console.log("Vault Authority:", vaultAuthority.toBase58());

  const params = {
    perfFeeBps:    new anchor.BN(600),
    autoCompound:  true,
    autoRebalance: true,
    tvlCap:        new anchor.BN(10 * 1e9), // 10 SOL cap to start
    name:          "YieldPilot SOL",
    treasury:      admin,
    gateMint:      PublicKey.default,
    keeper:        admin,
  };

  const tx = await program.methods
    .initializeVault(params)
    .accounts({
      admin,
      mint:                   SOL_MINT,
      vault:                  vaultPda,
      vaultAuthority,
      vaultTokenAccount,
      sharesMint:             sharesMintKp.publicKey,
      tokenProgram:           TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram:          anchor.web3.SystemProgram.programId,
      rent:                   anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .signers([adminKp, sharesMintKp])
    .rpc();

  console.log("\n✓ SOL Vault initialized!");
  console.log("  Tx:    ", tx);
  console.log("  Vault: ", vaultPda.toBase58());
  console.log("\nAdd to keeper .env VAULT_ADDRESSES (comma-separated with USDC vault):");
  console.log(`  VAULT_ADDRESSES=F1r513ZZdofz4tjhRfhNAYDK5hsmc8uCZbMmg2tkPJ6e,${vaultPda.toBase58()}`);
}

main().catch(err => { console.error(err); process.exit(1); });
