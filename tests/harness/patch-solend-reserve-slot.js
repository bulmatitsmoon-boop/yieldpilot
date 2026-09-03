// Fetch the real Solend USDC reserve, zero out its last_update.slot so the
// local validator's fresh (small) slot number doesn't underflow interest
// accrual math in RefreshReserve, and write it as a solana-test-validator
// --account snapshot file (same JSON format as usdc_ata.json).
const { Connection, PublicKey } = require("/root/lp_lending_work/node_modules/@solana/web3.js");
const fs = require("fs");

const RPC = "https://mainnet.helius-rpc.com/?api-key=530a9cad-774a-4386-a84a-267260ab1e93";
const RESERVE = new PublicKey("BgxfHJDzm44T7XG68MYKx7YisTjZu73tVovyZSjJMpmw");

(async () => {
  const connection = new Connection(RPC, { commitment: "confirmed" });
  const info = await connection.getAccountInfo(RESERVE);
  const data = Buffer.from(info.data);
  // LastUpdate { slot: u64, stale: bool } is the very first field of Reserve,
  // at byte offset 0: version(1) then slot(8) -- verified earlier this session
  // via the same offset math used to read pythOracle/switchboardOracle.
  console.log("original last_update.slot:", data.readBigUInt64LE(1));
  data.writeBigUInt64LE(50n, 1);
  console.log("patched last_update.slot:", data.readBigUInt64LE(1));

  const snapshot = {
    pubkey: RESERVE.toBase58(),
    account: {
      lamports: info.lamports,
      data: [data.toString("base64"), "base64"],
      owner: info.owner.toBase58(),
      executable: info.executable,
      rentEpoch: info.rentEpoch || 0,
      space: data.length,
    },
  };
  fs.writeFileSync("/root/lp_lending_work/tests/harness/usdc_reserve_patched.json", JSON.stringify(snapshot, null, 2));
  console.log("wrote usdc_reserve_patched.json");
})().catch(e => { console.error(e); process.exit(1); });
