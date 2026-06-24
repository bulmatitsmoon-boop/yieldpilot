import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";
import path from "path";

const RPC_URL    = "https://api.mainnet-beta.solana.com";
const PROGRAM_ID = new PublicKey("8c7Boyk91MWkn5jabf5CnYD8DrG6p4hYm9eDdAAWXEKH");
const WSOL_MINT  = new PublicKey("So11111111111111111111111111111111111111112");
const KEEPER     = new PublicKey("DzBe4ag5Ehjd3eE3wa5JVnqcVM2mQ8FFd2ZmxKjVvY2M");

const adminKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/tmp/admin.json", "utf8"))));

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(adminKp);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../target/idl/yieldpilot.json"), "utf8"));
  const program = new anchor.Program(idl, provider);
  const admin = adminKp.publicKey;

  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), WSOL_MINT.toBuffer(), admin.toBuffer()], PROGRAM_ID);
  const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), vaultPda.toBuffer()], PROGRAM_ID);
  const sharesMintKp = Keypair.generate();
  const vaultTokenAccount = await getAssociatedTokenAddress(WSOL_MINT, vaultAuthority, true);

  console.log("Vault PDA:", vaultPda.toBase58());

  const tx = await program.methods.initializeVault({
    perfFeeBps:    new anchor.BN(600),
    autoCompound:  true,
    autoRebalance: true,
    tvlCap:        new anchor.BN(100 * 1e9),
    name:          "YieldPilot SOL",
    treasury:      admin,
    gateMint:      PublicKey.default,
    keeper:        KEEPER,
  }).accounts({
    admin, mint: WSOL_MINT, vault: vaultPda, vaultAuthority, vaultTokenAccount,
    sharesMint: sharesMintKp.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: anchor.web3.SystemProgram.programId,
    rent: anchor.web3.SYSVAR_RENT_PUBKEY,
  }).signers([adminKp, sharesMintKp]).rpc();

  console.log("✓ SOL Vault initialized! Tx:", tx);
  console.log("SOL_VAULT=", vaultPda.toBase58());
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
