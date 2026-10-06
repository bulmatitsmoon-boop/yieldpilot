const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction } = require("@solana/web3.js");
const fs = require("fs");
const crypto = require("crypto");

const PROGRAM_ID = new PublicKey("3tAEmHXZ51YVLe9ts8b9cMcgQPgaSamLxLtxR31VpREi");
const RPC = process.env.MAINNET_RPC_URL;
const VAULTS = [
  "5XpzWiE8jb53CShYv19UoXcY2AywjeXpfwCff8mgrNYn", // USDC
  "7MJGAiZmTre6VmVQXgYRK6vqoQeoMW1jwEL9jEXZgRy3", // SOL
];

function disc(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

(async () => {
  const connection = new Connection(RPC, "confirmed");
  const secret = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const admin = Keypair.fromSecretKey(Uint8Array.from(secret));
  console.log("Signing as:", admin.publicKey.toBase58());

  const EXPECTED_ADMIN = "89J8qUmvq6HmkV3vKHcAayNgZEu5WFHq3LmiedBKaLCe";
  if (admin.publicKey.toBase58() !== EXPECTED_ADMIN) {
    console.error("ABORT: signer does not match expected safe admin wallet.");
    process.exit(1);
  }

  const closeDisc = disc("close_vault");

  for (const vaultAddr of VAULTS) {
    const vaultPk = new PublicKey(vaultAddr);

    const before = await connection.getBalance(admin.publicKey);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: vaultPk, isSigner: false, isWritable: true },
      ],
      data: closeDisc,
    });

    const tx = new Transaction().add(ix);
    const sig = await connection.sendTransaction(tx, [admin], { skipPreflight: false });
    await connection.confirmTransaction(sig, "confirmed");

    const after = await connection.getBalance(admin.publicKey);
    console.log(`Closed vault ${vaultAddr}`);
    console.log(`  tx: ${sig}`);
    console.log(`  admin balance: ${before / 1e9} -> ${after / 1e9} SOL (refund + fee: ${(after - before) / 1e9})`);
  }
})();
