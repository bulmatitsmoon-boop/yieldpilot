import { AccountLayout, TOKEN_PROGRAM_ID, AccountState } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import fs from "node:fs";

/**
 * Crafts a raw SPL token account (165 bytes, standard AccountLayout) with
 * an arbitrary owner + balance, for loading into solana-test-validator via
 * `--account <pubkey> <file.json>`. This is how you get a test wallet to
 * hold a token whose real mint authority you don't control (e.g. USDC) —
 * the local validator just trusts whatever raw account bytes you hand it
 * at startup, so a token account with owner=<testWallet>, mint=<realUSDC>,
 * amount=<huge> is indistinguishable on-chain from a "real" funded account
 * for the lifetime of that local validator instance.
 *
 * Usage: node craft-mock-token-account.mjs <mint> <owner> <amount> <outFile>
 */
const [, , mintArg, ownerArg, amountArg, outFile] = process.argv;
if (!mintArg || !ownerArg || !amountArg || !outFile) {
  console.error("Usage: node craft-mock-token-account.mjs <mint> <owner> <amount> <outFile>");
  process.exit(1);
}

const mint = new PublicKey(mintArg);
const owner = new PublicKey(ownerArg);
const amount = BigInt(amountArg);

const buf = Buffer.alloc(AccountLayout.span);
AccountLayout.encode(
  {
    mint,
    owner,
    amount,
    delegateOption: 0,
    delegate: PublicKey.default,
    state: AccountState.Initialized,
    isNativeOption: 0,
    isNative: 0n,
    delegatedAmount: 0n,
    closeAuthorityOption: 0,
    closeAuthority: PublicKey.default,
  },
  buf
);

// Round-trip sanity check before writing anything out — if this doesn't
// match, the crafted account is wrong and solana-test-validator would load
// garbage silently.
const decoded = AccountLayout.decode(buf);
if (!decoded.mint.equals(mint)) throw new Error("round-trip check failed: mint mismatch");
if (!decoded.owner.equals(owner)) throw new Error("round-trip check failed: owner mismatch");
if (decoded.amount !== amount) throw new Error(`round-trip check failed: amount mismatch (${decoded.amount} !== ${amount})`);
if (decoded.state !== AccountState.Initialized) throw new Error("round-trip check failed: state not Initialized");

// solana-test-validator --account file format (same shape `solana account
// <pubkey> --output json` produces).
const output = {
  pubkey: "REPLACE_WITH_THE_TOKEN_ACCOUNT_PUBKEY_YOU_WANT_THIS_LOADED_AT",
  account: {
    lamports: 2039280, // rent-exempt minimum for a 165-byte account (verify against `solana rent 165` if this drifts)
    data: [buf.toString("base64"), "base64"],
    owner: TOKEN_PROGRAM_ID.toBase58(),
    executable: false,
    rentEpoch: 0,
    space: AccountLayout.span,
  },
};

fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
console.log(`Wrote ${outFile} — ${AccountLayout.span} bytes encoded, round-trip verified.`);
console.log(`IMPORTANT: edit "pubkey" in the output file before use — this script does NOT`);
console.log(`derive the associated token account address for you (that depends on which`);
console.log(`token program / ATA derivation the mint uses); use getAssociatedTokenAddress`);
console.log(`from @solana/spl-token for that, matching what the test file expects at`);
console.log(`aliceTokenBAccount.`);
