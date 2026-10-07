// Initializes the two Safe vaults (USDC, SOL) on the new program, with the full real
// protocol registration recovered from the old vaults' actual on-chain history --
// NOT the stale 2-protocol init-vault.ts script, and NOT the original registration-time
// bps (which have since been rebalanced away by the keeper) -- these are the real,
// final, live-at-closure allocations.
const anchor = require("@coral-xyz/anchor");
const { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, NATIVE_MINT } = require("@solana/spl-token");
const fs = require("fs");
const IDL = require("./src/idl/yieldpilot.mainnet.json");

const PROGRAM_ID = new PublicKey("3Am7Q6KyPb6L9cuUDZCwAVFSLZXbPtjCoXWHGiNBzKkR");
const RPC = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TREASURY = new PublicKey("DQxZQF94ZkNwqL7FMpV1xK7XipaHHRBrnniUcRZC36iL");
const KEEPER = new PublicKey("DzBe4ag5Ehjd3eE3wa5JVnqcVM2mQ8FFd2ZmxKjVvY2M");

const VAULTS = [
  {
    key: "USDC",
    mint: USDC_MINT,
    name: "YieldPilot USDC",
    tvlCap: "1000000000000", // 1,000,000 USDC (6dp)
    protocols: [
      { label: "kamino-usdc", kind: 0, externalState: "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59", receiptMint: "B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D", targetBps: 10000 },
      { label: "solend-usdc", kind: 2, externalState: "BgxfHJDzm44T7XG68MYKx7YisTjZu73tVovyZSjJMpmw", receiptMint: "993dVFL2uXWYeoXuEBFXR4BijeXdTv4s6BzsCjJZuwqk", targetBps: 0 },
      { label: "kamino-usdc-maple", kind: 0, externalState: "Atj6UREVWa7WxbF2EMKNyfmYUY1U1txughe2gjhcPDCo", receiptMint: "6M89FWrQaqcy3domy85J1a1wVMnviL86WeUqbqTXf1qb", targetBps: 0 },
    ],
  },
  {
    key: "SOL",
    mint: NATIVE_MINT,
    name: "YieldPilot SOL",
    tvlCap: "1000000000000", // 1,000 SOL (9dp)
    protocols: [
      { label: "jito-sol", kind: 3, externalState: "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb", receiptMint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", targetBps: 0 },
      { label: "marinade-sol", kind: 1, externalState: "8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC", receiptMint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", targetBps: 0 },
      { label: "kamino-sol", kind: 0, externalState: "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q", receiptMint: "2UywZrUdyqs5vDchy7fKQJKau2RVyuzBev2XKGPDSiX1", targetBps: 0 },
      { label: "psol-sol", kind: 3, externalState: "pSPcvR8GmG9aKDUbn9nbKYjkxt9hxMS7kF1qqKJaPqJ", receiptMint: "pSo1f9nQXWgXibFtKf7NWYxb5enAM4qfP6UJSiXRQfL", targetBps: 10000 },
    ],
  },
];

async function retryFetch(fn, attempts = 6, delayMs = 1500) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const msg = err.message ?? String(err);
      if (!msg.includes("Account does not exist") && !msg.includes("has no data")) throw err;
      console.log(`  (RPC read-lag, retry ${i + 1}/${attempts}...)`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

(async () => {
  const connection = new Connection(RPC, "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.argv[2], "utf8"))));
  console.log("Admin:", admin.publicKey.toBase58());

  const EXPECTED_ADMIN = "89J8qUmvq6HmkV3vKHcAayNgZEu5WFHq3LmiedBKaLCe";
  if (admin.publicKey.toBase58() !== EXPECTED_ADMIN) {
    console.error("ABORT: signer is not the expected safe admin wallet.");
    process.exit(1);
  }

  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new anchor.Program(IDL, provider);

  for (const v of VAULTS) {
    console.log(`\n===== ${v.key} vault =====`);
    const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), v.mint.toBuffer(), admin.publicKey.toBuffer()], PROGRAM_ID);
    const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), vaultPda.toBuffer()], PROGRAM_ID);
    const vaultTokenAccount = getAssociatedTokenAddressSync(v.mint, vaultAuthority, true);
    const sharesMintKp = Keypair.generate();

    console.log("Vault PDA:  ", vaultPda.toBase58());
    console.log("Authority:  ", vaultAuthority.toBase58());
    console.log("Shares mint:", sharesMintKp.publicKey.toBase58());

    try {
      const sig = await program.methods
        .initializeVault({
          autoCompound: true,
          autoRebalance: true,
          tvlCap: new anchor.BN(v.tvlCap),
          name: v.name,
          treasury: TREASURY,
          gateMint: PublicKey.default,
          keeper: KEEPER,
        })
        .accounts({
          admin: admin.publicKey,
          mint: v.mint,
          vault: vaultPda,
          vaultAuthority,
          vaultTokenAccount,
          sharesMint: sharesMintKp.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([admin, sharesMintKp])
        .rpc();
      console.log("Vault initialized:", sig);
    } catch (err) {
      const logs = err.logs ?? [];
      if (logs.some(l => l.includes("already in use"))) {
        console.log("Vault already exists, skipping init.");
      } else {
        throw err;
      }
    }

    const vaultAccount = await retryFetch(() => program.account.vault.fetch(vaultPda));
    const alreadyRegistered = vaultAccount.protocolCount;
    console.log(`${alreadyRegistered} protocol(s) already registered.`);

    for (let i = alreadyRegistered; i < v.protocols.length; i++) {
      const p = v.protocols[i];
      const receiptAta = getAssociatedTokenAddressSync(new PublicKey(p.receiptMint), vaultAuthority, true);
      console.log(`Registering [${i}] ${p.label} (${p.targetBps} bps)...`);
      const sig = await program.methods
        .registerProtocol(p.kind, new PublicKey(p.externalState), receiptAta, new anchor.BN(p.targetBps), p.label)
        .accounts({ admin: admin.publicKey, vault: vaultPda })
        .rpc();
      console.log("  OK", sig);
    }

    console.log(`${v.key} vault address: ${vaultPda.toBase58()}`);
  }
})();
