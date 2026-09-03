const { Connection, PublicKey } = require("/root/lp_lending_work/node_modules/@solana/web3.js");
const fs = require("fs");

const RPC = "https://mainnet.helius-rpc.com/?api-key=530a9cad-774a-4386-a84a-267260ab1e93";
const MARKET = new PublicKey("4UpD2fh7xH3VP9QQaXtsS1YY3bxzWhtfpks7FatyKvdY");

(async () => {
  const connection = new Connection(RPC, { commitment: "confirmed" });
  const info = await connection.getAccountInfo(MARKET);
  const data = Buffer.from(info.data);
  console.log("original rate_limiter.window_start (offset 194):", data.readBigUInt64LE(194));
  data.writeBigUInt64LE(50n, 194);
  console.log("patched:", data.readBigUInt64LE(194));

  const snapshot = {
    pubkey: MARKET.toBase58(),
    account: {
      lamports: info.lamports,
      data: [data.toString("base64"), "base64"],
      owner: info.owner.toBase58(),
      executable: info.executable,
      rentEpoch: 0,
      space: data.length,
    },
  };
  fs.writeFileSync("/root/lp_lending_work/tests/harness/lending_market_patched.json", JSON.stringify(snapshot, null, 2));
  console.log("wrote lending_market_patched.json");
})().catch(e => { console.error(e); process.exit(1); });
