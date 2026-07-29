// Build the two --account fixtures for the reconcile harness test:
//  1. The REAL orphaned USDC vault (total_deposits=2150, deployed=0), re-owned to the
//     devnet program our binary matches, with the keeper field patched to the harness
//     keypair so reconcile's keeper==signer check passes.
//  2. A crafted SPL token account at the vault's vault_token_account address holding the
//     real idle balance (3 base units), so reconcile reads idle=3.
//
// Then reconcile should set total_deposits = idle(3) + total_deployed(0) = 3, i.e. correct
// the exact live orphan. Proves the #113 fix on the actual production scenario.
const { Keypair, PublicKey } = require("@solana/web3.js");
const fs = require("fs"), path = require("path"), os = require("os");

const DEVNET_PROGRAM = "8c7Boyk91MWkn5jabf5CnYD8DrG6p4hYm9eDdAAWXEKH";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const VAULT_ADDR = "5XpzWiE8jb53CShYv19UoXcY2AywjeXpfwCff8mgrNYn";
const VAULT_TOKEN_ACCT = "4HFsLb9xconKtmszwRDCC8aGuMXjk523kaR5KkSh9sDZ";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const IDLE_AMOUNT = 3n; // real idle balance of the live USDC vault

const keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(path.resolve(os.homedir(), ".config/solana/id.json"), "utf8"))));

// ── 1. patched vault ──
const vaultData = Buffer.from(fs.readFileSync("vault_raw.b64", "utf8"), "base64");
console.log("vault total_deposits BEFORE patch @288:", vaultData.readBigUInt64LE(288).toString());
// patch keeper field (offset 40) -> harness keypair, so reconcile's keeper==signer passes
keeper.publicKey.toBuffer().copy(vaultData, 40);
console.log("keeper patched to:", new PublicKey(vaultData.subarray(40, 72)).toBase58());

const vaultJson = {
  pubkey: VAULT_ADDR,
  account: {
    lamports: 3000000,
    data: [vaultData.toString("base64"), "base64"],
    owner: DEVNET_PROGRAM, // re-own to the program our binary declares
    executable: false,
    rentEpoch: 0,
  },
};
fs.writeFileSync("fx_vault.json", JSON.stringify(vaultJson));

// ── 2. crafted SPL token account at vault_token_account (165 bytes, initialized) ──
const ta = Buffer.alloc(165);
new PublicKey(USDC_MINT).toBuffer().copy(ta, 0);       // mint
keeper.publicKey.toBuffer().copy(ta, 32);               // owner (irrelevant to reconcile)
ta.writeBigUInt64LE(IDLE_AMOUNT, 64);                   // amount = idle
ta.writeUInt8(1, 108);                                  // state = initialized
const tokenJson = {
  pubkey: VAULT_TOKEN_ACCT,
  account: {
    lamports: 2039280,
    data: [ta.toString("base64"), "base64"],
    owner: TOKEN_PROGRAM,
    executable: false,
    rentEpoch: 0,
  },
};
fs.writeFileSync("fx_token.json", JSON.stringify(tokenJson));

console.log("wrote fx_vault.json + fx_token.json");
console.log("expected reconcile result: total_deposits 2150 -> " + (IDLE_AMOUNT + 0n) + " (idle + deployed)");
