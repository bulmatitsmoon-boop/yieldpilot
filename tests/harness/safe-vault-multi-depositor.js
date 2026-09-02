// Multi-depositor share-math integrity test for the Phase 1 SAFE vault
// (single-asset, Kamino/Solend/Jito/Marinade auto-routing). Unlike the LP
// vault, Phase 1 already has weeks of real multi-depositor production
// history, so this is a lower-stakes confirmation, not new territory — run
// for completeness per Lloyd's explicit request.
//
// Deliberately does NOT call deploy_to_* / recall_from_* (that requires
// cloning Kamino/Solend/Jito/Marinade mainnet state, a much larger harness —
// see start_sol.sh/start_kamino.sh for that separate setup, already proven
// elsewhere). This tests the CORE mint-on-deposit/burn-on-withdraw accounting
// with funds sitting idle — the same invariant class as the LP test: does
// every depositor get back exactly what they're owed under randomized,
// interleaved concurrent activity, with zero leaked or stuck value.
const anchor = require("@coral-xyz/anchor");
const {
  Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction, createTransferInstruction,
} = require("@solana/spl-token");
const fs = require("fs"), path = require("path"), os = require("os");

const RPC = "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey("8c7Boyk91MWkn5jabf5CnYD8DrG6p4hYm9eDdAAWXEKH");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const N_WALLETS = 8;

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

(async () => {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(path.resolve(os.homedir(), ".config/solana/id.json"), "utf8"))));
  const connection = new Connection(RPC, { commitment: "confirmed" });
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.resolve(__dirname, "idl_p2.json"), "utf8"));
  const program = new anchor.Program(idl, provider);

  for (let i = 0; i < 12; i++) {
    if ((await connection.getBalance(admin.publicKey)) > 3000e9) break;
    try { await connection.confirmTransaction(await connection.requestAirdrop(admin.publicKey, 500e9), "confirmed"); }
    catch { break; }
  }

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), USDC_MINT.toBuffer(), admin.publicKey.toBuffer()], PROGRAM_ID);
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), vaultPda.toBuffer()], PROGRAM_ID);
  const sharesMintKp = Keypair.generate();
  const vaultTokenAccount = getAssociatedTokenAddressSync(USDC_MINT, vaultAuthority, true);

  // ── [1] init vault, no protocols registered ─────────────────────────────────
  await program.methods.initializeVault({
    perfFeeBps: new anchor.BN(500), autoCompound: true, autoRebalance: true,
    tvlCap: new anchor.BN("1000000000000"), name: "MULTI-DEPOSITOR SAFE TEST",
    treasury: admin.publicKey, gateMint: PublicKey.default, keeper: admin.publicKey,
  }).accounts({
    admin: admin.publicKey, mint: USDC_MINT, vault: vaultPda, vaultAuthority,
    vaultTokenAccount, sharesMint: sharesMintKp.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
  }).signers([admin, sharesMintKp]).rpc({ commitment: "confirmed" });
  console.log("[1] vault initialized (no protocols registered — idle-funds test only)");

  // ── [2] create N wallets, fund with USDC from admin's cloned ATA ────────────
  const adminUsdc = new PublicKey("5gXt4YTqgDyzfL4zMErMRGB47gi1N6VAywowAsCAGEac");
  const wallets = Array.from({ length: N_WALLETS }, () => Keypair.generate());
  const ctx = {};
  for (const w of wallets) {
    await connection.confirmTransaction(await connection.requestAirdrop(w.publicKey, 5 * 1e9), "confirmed");
    const userTokenAccount = getAssociatedTokenAddressSync(USDC_MINT, w.publicKey);
    const userSharesAccount = getAssociatedTokenAddressSync(sharesMintKp.publicKey, w.publicKey);
    const [userPosition] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), vaultPda.toBuffer(), w.publicKey.toBuffer()], PROGRAM_ID);
    const depositAmount = Math.floor((500 + Math.random() * 2500) * 1e6); // 500-3000 USDC, genuinely randomized
    const prep = new Transaction();
    prep.add(createAssociatedTokenAccountInstruction(w.publicKey, userTokenAccount, w.publicKey, USDC_MINT));
    prep.add(createTransferInstruction(adminUsdc, userTokenAccount, admin.publicKey, depositAmount));
    await provider.sendAndConfirm(prep, [w]);
    ctx[w.publicKey.toBase58()] = { w, userTokenAccount, userSharesAccount, userPosition, depositAmount };
  }
  console.log(`[2] ${N_WALLETS} wallets funded with randomized USDC amounts (500-5000 USDC each)`);

  // ── [3] RANDOM-ORDER deposits ────────────────────────────────────────────────
  console.log("\n[3] depositing, random order:");
  for (const key of shuffle(Object.keys(ctx))) {
    const c = ctx[key];
    try {
      await program.methods.deposit(new anchor.BN(c.depositAmount)).accountsPartial({
        user: c.w.publicKey, vault: vaultPda, vaultAuthority, vaultTokenAccount,
        userTokenAccount: c.userTokenAccount, sharesMint: sharesMintKp.publicKey,
        userPosition: c.userPosition, userSharesAccount: c.userSharesAccount,
        userGateAccount: null, tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).signers([c.w]).rpc({ commitment: "confirmed" });
      c.deposited = true;
      console.log(`    ${key.slice(0,8)}... deposited ${(c.depositAmount/1e6).toFixed(6)} USDC`);
    } catch (e) {
      c.deposited = false;
      console.log(`    ${key.slice(0,8)}... deposit FAILED:`, (e.message||"").split("\n")[0].slice(0,100));
      if (e.logs) console.log("      logs:", e.logs.slice(-4).join(" | "));
    }
  }

  const successfulDepositors = Object.keys(ctx).filter(k => ctx[k].deposited);
  console.log(`[3] ${successfulDepositors.length}/${N_WALLETS} deposits succeeded`);
  if (successfulDepositors.length < 2) { console.log("!! too few succeeded, aborting"); return; }

  const treasuryTokenAccount = getAssociatedTokenAddressSync(USDC_MINT, admin.publicKey, true);

  // ── [4] RANDOM-ORDER full withdrawals ────────────────────────────────────────
  console.log("\n[4] withdrawing (all shares), random order:");
  for (const key of shuffle(successfulDepositors)) {
    const c = ctx[key];
    const pos = await program.account.userPosition.fetch(c.userPosition).catch(() => null);
    if (!pos || pos.shares.isZero()) { console.log(`    ${key.slice(0,8)}... no shares, skip`); continue; }
    const balBefore = (await connection.getTokenAccountBalance(c.userTokenAccount)).value.amount;
    try {
      await program.methods.withdraw(pos.shares, new anchor.BN(0)).accountsPartial({
        user: c.w.publicKey, vault: vaultPda, vaultAuthority, vaultTokenAccount,
        userTokenAccount: c.userTokenAccount, sharesMint: sharesMintKp.publicKey,
        userPosition: c.userPosition, userSharesAccount: c.userSharesAccount,
        treasuryTokenAccount, userGateAccount: null, whitelistEntry: null,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).signers([c.w]).rpc({ commitment: "confirmed" });
      const balAfter = (await connection.getTokenAccountBalance(c.userTokenAccount)).value.amount;
      c.received = (Number(balAfter) - Number(balBefore)) / 1e6;
      c.withdrew = true;
      const diff = c.received - c.depositAmount / 1e6;
      console.log(`    ${key.slice(0,8)}... withdrew ${c.received.toFixed(6)} USDC` +
                  ` (deposited ${(c.depositAmount/1e6).toFixed(6)}, diff ${diff >= 0 ? "+" : ""}${diff.toFixed(6)})`);
    } catch (e) {
      c.withdrew = false;
      console.log(`    ${key.slice(0,8)}... WITHDRAW FAILED:`, (e.message||"").split("\n")[0].slice(0,120));
    }
  }

  // ── [5] FINAL INVARIANT CHECKS ────────────────────────────────────────────────
  console.log("\n[5] === FINAL VERIFICATION ===");
  const finalVault = await program.account.vault.fetch(vaultPda);
  const finalVaultBal = (await connection.getTokenAccountBalance(vaultTokenAccount)).value.amount;
  console.log("    final total_shares:", finalVault.totalShares.toString(), "(expect 0)");
  console.log("    final total_deposits:", finalVault.totalDeposits.toString(), "(expect 0)");
  console.log("    final vault token balance:", finalVaultBal, "(expect 0, no stuck value)");

  let totalIn = 0, totalOut = 0, anyMismatch = false;
  for (const key of successfulDepositors) {
    const c = ctx[key];
    if (!c.withdrew) { anyMismatch = true; continue; }
    totalIn += c.depositAmount / 1e6;
    totalOut += c.received;
    if (Math.abs(c.received - c.depositAmount / 1e6) > 0.000010) anyMismatch = true; // >10 micro-USDC drift is real, not dust
  }
  console.log(`    total deposited: ${totalIn.toFixed(6)} USDC | total received: ${totalOut.toFixed(6)} USDC`);
  console.log(`    net: ${(totalOut - totalIn) >= 0 ? "+" : ""}${(totalOut - totalIn).toFixed(6)} USDC (expect ~0 — no yield source was deployed in this test)`);

  const ok = finalVault.totalShares.isZero() && finalVault.totalDeposits.isZero() &&
             Number(finalVaultBal) < 10 && !anyMismatch;
  console.log("\nRESULT:", ok ? "SAFE_VAULT_MULTI_DEPOSITOR_MATH_OK" : "SAFE_VAULT_MULTI_DEPOSITOR_MATH_BROKEN");
})().catch(e => { console.error("FATAL:", e.message); console.error(e.stack); if (e.logs) console.error(e.logs.slice(-15).join("\n")); process.exit(1); });
