/**
 * Create + populate the Address Lookup Table that Raydium LP instructions require.
 *
 * WHY THIS EXISTS
 * `initialize_raydium_lp_vault` takes 26 accounts. As a legacy transaction it is 1245
 * bytes against Solana's hard 1232-byte limit once the mandatory compute-budget
 * instruction is included — and there is no combination that fits, because dropping the
 * budget instruction makes it run out of compute inside Metaplex instead. Measured on
 * the local harness 2026-07-20; with an ALT the same transaction is 878 bytes.
 *
 * Run ONCE per pool, then put the printed address in LP_ADDRESS_LOOKUP_TABLE (keeper)
 * and NEXT_PUBLIC_LP_ADDRESS_LOOKUP_TABLE (app).
 *
 *   npx ts-node src/scripts/create-lp-alt.ts <LP_VAULT_ADDRESS>
 *
 * Costs a small amount of rent, paid by the keeper keypair, recoverable by closing the
 * table. Only STATIC accounts go in — per-transaction keypairs (a fresh position NFT
 * mint) cannot be pre-published and stay in the transaction proper.
 */
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

async function main() {
  const lpVaultArg = process.argv[2];
  if (!lpVaultArg) {
    console.error("usage: create-lp-alt.ts <LP_VAULT_ADDRESS>");
    process.exit(1);
  }

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

  // Read the vault so the table covers ITS pool and derived accounts, not just globals.
  const vaultInfo = await conn.getAccountInfo(new PublicKey(lpVaultArg));
  if (!vaultInfo) throw new Error(`LP vault not found: ${lpVaultArg}`);

  const idlPath = process.env.IDL_PATH || "src/idl/yieldpilot.json";
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const anchor = await import("@coral-xyz/anchor");
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(payer), { commitment: "confirmed" });
  const program = new anchor.Program(idl, provider);
  const v: any = await (program.account as any).lpVault.fetch(new PublicKey(lpVaultArg));

  const addresses: PublicKey[] = [
    RAYDIUM_CLMM, WHIRLPOOL, METADATA,
    TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId, SYSVAR_RENT_PUBKEY,
    v.pool, v.tokenAMint, v.tokenBMint,
    v.vaultTokenAAccount, v.vaultTokenBAccount,
    v.protocolPosition, v.position, v.positionTokenAccount, v.lpSharesMint,
  ].filter((a: PublicKey) => a && !a.equals(PublicKey.default));

  // de-dupe; a table with repeats still works but wastes space
  const seen = new Set<string>();
  const unique = addresses.filter(a => !seen.has(a.toBase58()) && seen.add(a.toBase58()));

  const slot = await conn.getSlot("finalized");
  const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot,
  });
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey, authority: payer.publicKey,
    lookupTable: altAddress, addresses: unique,
  });

  const sig = await conn.sendTransaction(
    new Transaction().add(createIx).add(extendIx), [payer]
  );
  await conn.confirmTransaction(sig, "confirmed");

  // A lookup table is only usable one slot after it is extended.
  await new Promise(r => setTimeout(r, 2000));
  const fetched = await conn.getAddressLookupTable(altAddress);

  console.log("\n=== lookup table created ===");
  console.log("address:", altAddress.toBase58());
  console.log("tx     :", sig);
  console.log("entries:", fetched.value?.state.addresses.length ?? 0);
  console.log("\nSet BOTH of these:");
  console.log("  keeper .env : LP_ADDRESS_LOOKUP_TABLE=" + altAddress.toBase58());
  console.log("  app .env    : NEXT_PUBLIC_LP_ADDRESS_LOOKUP_TABLE=" + altAddress.toBase58());
}

main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
