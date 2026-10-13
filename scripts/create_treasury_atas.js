// Creates the treasury's USDC and wSOL associated token accounts, paid for by the
// admin wallet. Needed because withdraw() requires treasury_token_account to already
// exist (AccountNotInitialized, error 3012) -- confirmed live on two failed USDC
// withdraw txs against the fresh treasury wallet, which has never held either token.
const anchor = require("@coral-xyz/anchor");
const { Connection, Keypair, PublicKey, Transaction } = require("@solana/web3.js");
const {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  NATIVE_MINT,
} = require("@solana/spl-token");
const fs = require("fs");

const RPC = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TREASURY = new PublicKey("CiZb5cLMT6T8Spb4NspPCMgF5yNrZo5nxXimkJYPvnDA");

(async () => {
  const connection = new Connection(RPC, "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.argv[2], "utf8"))));
  console.log("Payer/admin:", admin.publicKey.toBase58());

  const EXPECTED_ADMIN = "yaZDx7cKF8WqJyaVQJDhiTgi1UEB6rgjSpg5sW4GpD7";
  if (admin.publicKey.toBase58() !== EXPECTED_ADMIN) {
    console.error("ABORT: signer is not the expected admin wallet.");
    process.exit(1);
  }

  for (const mint of [USDC_MINT, NATIVE_MINT]) {
    const ata = getAssociatedTokenAddressSync(mint, TREASURY, false);
    const existing = await connection.getAccountInfo(ata);
    if (existing) {
      console.log(mint.toBase58(), "-> ATA already exists:", ata.toBase58());
      continue;
    }
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(admin.publicKey, ata, TREASURY, mint)
    );
    const sig = await connection.sendTransaction(tx, [admin]);
    await connection.confirmTransaction(sig, "confirmed");
    console.log(mint.toBase58(), "-> created ATA:", ata.toBase58(), "tx:", sig);
  }
})();
