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

  const FEE_BUFFER_LAMPORTS = 10000;
  const sendLamports = bal - FEE_BUFFER_LAMPORTS;
  if (sendLamports <= 0) { console.error("not enough balance to send anything after fee buffer"); process.exit(1); }

  console.log(`sending ${sendLamports / 1e9} SOL to keeper wallet ${KEEPER_WALLET.toBase58()}`);
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: admin.publicKey,
    toPubkey: KEEPER_WALLET,
    lamports: sendLamports,
  }));
  const sig = await sendAndConfirmTransaction(connection, tx, [admin]);
  console.log("SUCCESS:", sig);
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
