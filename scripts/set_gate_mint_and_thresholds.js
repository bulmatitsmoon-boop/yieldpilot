// Wires the live $YPILOT mint into both Safe vaults: set_gate_mint once per vault
// (first-ever set, no cooldown applies since gate_mint starts at system-program
// default), then update_tier_thresholds with the real displayed thresholds
// (Bronze 10,000 / Silver 100,000 / Gold 1,000,000) converted to raw units for the
// mint's 6 decimals.
const anchor = require("@coral-xyz/anchor");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const fs = require("fs");
const IDL = require("../app/src/idl/yieldpilot.mainnet.json");

const PROGRAM_ID = new PublicKey("D9YJR8fvGLRSVfX82fpextgS9T7fT2QLm5Esnro6Yjmx");
const RPC = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
const GATE_MINT = new PublicKey("BrzPQi5XHXwuZTDFNmYHF6YGXNRfsJ3DYLmTXwR5pump");
const DECIMALS = 6;

const GOLD = new anchor.BN(1_000_000).mul(new anchor.BN(10 ** DECIMALS));
const SILVER = new anchor.BN(100_000).mul(new anchor.BN(10 ** DECIMALS));
const BRONZE = new anchor.BN(10_000).mul(new anchor.BN(10 ** DECIMALS));

const VAULTS = [
  { key: "USDC", address: new PublicKey("Cgj7SkEQDJZYhq2gviNajNmsoX4zeGzr6TgbNDZDaJSQ") },
  { key: "SOL", address: new PublicKey("8yHqDcsuEbfAVRnHns83b3spkdtjY9x4zyiUXqDUUumF") },
];

(async () => {
  const connection = new Connection(RPC, "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.argv[2], "utf8"))));
  console.log("Admin:", admin.publicKey.toBase58());

  const EXPECTED_ADMIN = "yaZDx7cKF8WqJyaVQJDhiTgi1UEB6rgjSpg5sW4GpD7";
  if (admin.publicKey.toBase58() !== EXPECTED_ADMIN) {
    console.error("ABORT: signer is not the expected admin wallet.");
    process.exit(1);
  }

  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  IDL.address = PROGRAM_ID.toBase58();
  const program = new anchor.Program(IDL, provider);

  for (const v of VAULTS) {
    console.log(`\n===== ${v.key} vault =====`);

    const before = await program.account.vault.fetch(v.address);
    console.log("current gate_mint:", before.gateMint.toBase58());

    if (before.gateMint.equals(GATE_MINT)) {
      console.log("gate_mint already set to $YPILOT, skipping set_gate_mint.");
    } else {
      const sig1 = await program.methods
        .setGateMint(GATE_MINT)
        .accounts({ admin: admin.publicKey, vault: v.address })
        .rpc();
      console.log("set_gate_mint:", sig1);
    }

    const sig2 = await program.methods
      .updateTierThresholds(GOLD, SILVER, BRONZE)
      .accounts({ admin: admin.publicKey, vault: v.address })
      .rpc();
    console.log("update_tier_thresholds:", sig2);

    const after = await program.account.vault.fetch(v.address);
    console.log("confirmed gate_mint:", after.gateMint.toBase58());
    console.log("confirmed thresholds (raw):", after.goldThreshold.toString(), after.silverThreshold.toString(), after.bronzeThreshold.toString());
  }
})();
