import "dotenv/config";
import {
  Connection, Keypair, PublicKey, Transaction,
  AddressLookupTableProgram, SystemProgram, SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";

const RAYDIUM_CLMM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const WHIRLPOOL = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const METADATA = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const ORCA_VAULT = new PublicKey("FhuthBKSw2TWZRrzxGFm3fcetuDsPLxFhqfM6KdcSyax");
const RAYDIUM_VAULT = new PublicKey("7eMRVqgNFt8qMUBPFbycyCPYaKUdx7BKGW1GyxsXSoZP");

async function main() {
  const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KEEPER_KEYPAIR_PATH!, "utf8")))
  );

  const bal = await conn.getBalance(payer.publicKey);
  console.log("payer:", payer.publicKey.toBase58(), `(${(bal / 1e9).toFixed(4)} SOL)`);
  if (bal < 0.02e9) {
    console.error("payer needs at least ~0.02 SOL for the table's rent");
    process.exit(1);
  }

  const idlPath = process.env.IDL_PATH || "src/idl/yieldpilot.json";
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const anchor = await import("@coral-xyz/anchor");
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(payer), { commitment: "confirmed" });
  const program = new anchor.Program(idl, provider);

  const orca: any = await (program.account as any).lpVault.fetch(ORCA_VAULT);
  const raydium: any = await (program.account as any).lpVault.fetch(RAYDIUM_VAULT);

  const addresses: PublicKey[] = [
    RAYDIUM_CLMM, WHIRLPOOL, METADATA,
    TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId, SYSVAR_RENT_PUBKEY,
    ORCA_VAULT, orca.pool, orca.tokenAMint, orca.tokenBMint,
    orca.vaultTokenAAccount, orca.vaultTokenBAccount, orca.position, orca.positionTokenAccount, orca.lpSharesMint,
    RAYDIUM_VAULT, raydium.pool, raydium.tokenAMint, raydium.tokenBMint,
    raydium.vaultTokenAAccount, raydium.vaultTokenBAccount,
    raydium.protocolPosition, raydium.position, raydium.positionTokenAccount, raydium.lpSharesMint,
  ].filter((a: PublicKey) => a && !a.equals(PublicKey.default));

  const seen = new Set<string>();
  const unique = addresses.filter(a => !seen.has(a.toBase58()) && seen.add(a.toBase58()));
  console.log("unique addresses:", unique.length);

  const slot = await conn.getSlot("finalized");
  const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot,
  });
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey, authority: payer.publicKey,
    lookupTable: altAddress, addresses: unique,
  });

  const sig = await conn.sendTransaction(new Transaction().add(createIx).add(extendIx), [payer]);
  await conn.confirmTransaction(sig, "confirmed");

  await new Promise(r => setTimeout(r, 2000));
  const fetched = await conn.getAddressLookupTable(altAddress);

  console.log("\n=== lookup table created ===");
  console.log("address:", altAddress.toBase58());
  console.log("tx     :", sig);
  console.log("entries:", fetched.value?.state.addresses.length ?? 0);
}

main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
