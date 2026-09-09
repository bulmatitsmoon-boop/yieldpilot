const { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } = require("@solana/web3.js");
const fs = require("fs");

const RPC = process.env.MAINNET_RPC_URL;
const NEW_ADMIN = new PublicKey("89J8qUmvq6HmkV3vKHcAayNgZEu5WFHq3LmiedBKaLCe");

(async () => {
  const keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/tmp/fee-payer.json", "utf8"))));
  const connection = new Connection(RPC, { commitment: "confirmed" });
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: keeper.publicKey,
    toPubkey: NEW_ADMIN,
    lamports: 0.02 * 1e9,
  }));
  const sig = await sendAndConfirmTransaction(connection, tx, [keeper]);
  console.log("Funded new admin with 0.02 SOL:", sig);
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
