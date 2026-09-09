// One-off: propose_admin on both regular vaults, moving admin off the
// compromised key. Signed by the compromised key (still legitimate -- it's
// revoking its own power, same reasoning as the upgrade-authority transfer),
// fee paid by the keeper wallet since admin itself is drained.
const anchor = require("@coral-xyz/anchor");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const fs = require("fs");

const RPC = process.env.MAINNET_RPC_URL;
const PROGRAM_ID = new PublicKey("3tAEmHXZ51YVLe9ts8b9cMcgQPgaSamLxLtxR31VpREi");
const NEW_ADMIN = new PublicKey("89J8qUmvq6HmkV3vKHcAayNgZEu5WFHq3LmiedBKaLCe");
const VAULTS = {
  "USDC vault": new PublicKey("5XpzWiE8jb53CShYv19UoXcY2AywjeXpfwCff8mgrNYn"),
  "SOL vault": new PublicKey("7MJGAiZmTre6VmVQXgYRK6vqoQeoMW1jwEL9jEXZgRy3"),
};

(async () => {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/tmp/deploy-authority.json", "utf8"))));
  const feePayer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/tmp/fee-payer.json", "utf8"))));
  const connection = new Connection(RPC, { commitment: "confirmed" });
  const wallet = new anchor.Wallet(feePayer);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync("src/idl/yieldpilot.mainnet.json", "utf8"));
  const program = new anchor.Program(idl, provider);

  for (const [name, vault] of Object.entries(VAULTS)) {
    try {
      const sig = await program.methods.proposeAdmin(NEW_ADMIN)
        .accounts({ admin: admin.publicKey, vault })
        .signers([admin])
        .rpc();
      console.log(name, "propose_admin SUCCESS:", sig);
    } catch (e) {
      console.error(name, "FAILED:", e.message);
      if (e.logs) console.error(e.logs.join("\n"));
    }
  }
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
