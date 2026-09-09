const { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } = require("@solana/web3.js");
const fs = require("fs");

const RPC = process.env.MAINNET_RPC_URL;
const KEEPER_WALLET = new PublicKey("DzBe4ag5Ehjd3eE3wa5JVnqcVM2mQ8FFd2ZmxKjVvY2M");

(async () => {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/tmp/admin-keypair.json", "utf8"))));
  console.log("sending from:", admin.publicKey.toBase58());

  const connection = new Connection(RPC, { commitment: "confirmed" });
  const bal = await connection.getBalance(admin.publicKey);
  console.log("current balance:", bal / 1e9, "SOL");

  // A system account must end at exactly 0 or >= the rent-exempt minimum — leaving a small
  // dust balance in between is rejected by simulation. So build the tx first, get its real
  // fee, and send bal - fee exactly, leaving the admin account at 0.
  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: admin.publicKey });
  tx.add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: KEEPER_WALLET, lamports: 1 })); // placeholder amount just to size the message
  const feeResp = await connection.getFeeForMessage(tx.compileMessage());
  const fee = feeResp.value;
  console.log("estimated fee:", fee, "lamports");

  const sendLamports = bal - fee;
  if (sendLamports <= 0) { console.error("not enough balance to cover fee"); process.exit(1); }

  console.log(`sending ${sendLamports / 1e9} SOL to keeper wallet ${KEEPER_WALLET.toBase58()} (leaving account at exactly 0)`);
  const finalTx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: admin.publicKey,
    toPubkey: KEEPER_WALLET,
    lamports: sendLamports,
  }));
  const sig = await sendAndConfirmTransaction(connection, finalTx, [admin]);
  console.log("SUCCESS:", sig);
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
