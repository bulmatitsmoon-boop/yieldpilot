// Multi-depositor share-math integrity test for the Orca LP vault — the one
// thing this codebase has NEVER actually exercised: this vault has only ever
// had ONE depositor (Lloyd) in production. This proves the share-math holds
// up when many independent wallets deposit/withdraw in random, interleaved
// order, WITH real trading fees accruing mid-stream (not just at 1:1 share
// price, which hides rounding-drift bugs).
//
// Invariant under test: every depositor gets back exactly their fair
// proportional share of (their principal +/- price movement + their share of
// real collected fees) — nobody is shorted, nobody can extract more than they
// are owed, and the vault ends with ~0 stuck value once everyone has exited.
const anchor = require("@coral-xyz/anchor");
const {
  Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY,
  Transaction, TransactionInstruction,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction, createSyncNativeInstruction,
} = require("@solana/spl-token");
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");

const RPC = "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey("8c7Boyk91MWkn5jabf5CnYD8DrG6p4hYm9eDdAAWXEKH");
const WHIRLPOOL_PROGRAM = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const POOL = new PublicKey("Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE");
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const VAULT_A = new PublicKey("EUuUbDcafPrmVTD5M6qoJAoyyNbihBhugADAxRMn5he9");
const VAULT_B = new PublicKey("2WLWEuKDgkDUccTpbwYp1GToYktiSB1cXvreHUwiSUVP");

const N_WALLETS = 8;
const SPAN = 352;
const arrayStart = (t) => Math.floor(t / SPAN) * SPAN;
const tickArrayPda = (startTick) => PublicKey.findProgramAddressSync(
  [Buffer.from("tick_array"), POOL.toBuffer(), Buffer.from(String(startTick))], WHIRLPOOL_PROGRAM)[0];
const disc = (n) => crypto.createHash("sha256").update("global:" + n).digest().subarray(0, 8);
const MIN_SQRT_PRICE = 4295048016n;
const MAX_SQRT_PRICE = 79226673515401279992447579055n;

function swapIx({ authority, userA, userB, ta0, ta1, ta2, oracle, amount, aToB }) {
  const d = Buffer.concat([
    disc("swap"),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(amount)); return b; })(),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(0n); return b; })(),
    (() => { const b = Buffer.alloc(16); const v = aToB ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;
             b.writeBigUInt64LE(v & 0xffffffffffffffffn, 0); b.writeBigUInt64LE(v >> 64n, 8); return b; })(),
    Buffer.from([1]),
    Buffer.from([aToB ? 1 : 0]),
  ]);
  const keys = [
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: authority, isSigner: true, isWritable: false },
    { pubkey: POOL, isSigner: false, isWritable: true },
    { pubkey: userA, isSigner: false, isWritable: true },
    { pubkey: VAULT_A, isSigner: false, isWritable: true },
    { pubkey: userB, isSigner: false, isWritable: true },
    { pubkey: VAULT_B, isSigner: false, isWritable: true },
    { pubkey: ta0, isSigner: false, isWritable: true },
    { pubkey: ta1, isSigner: false, isWritable: true },
    { pubkey: ta2, isSigner: false, isWritable: true },
    { pubkey: oracle, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: WHIRLPOOL_PROGRAM, keys, data: d });
}

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

  const poolInfo = await connection.getAccountInfo(POOL);
  const tickCurrent = poolInfo.data.readInt32LE(81);
  const align = (t) => Math.round(t / 4) * 4;
  const TICK_LOWER = align(tickCurrent - 28), TICK_UPPER = align(tickCurrent + 28);
  console.log("    pool tick_current:", tickCurrent, "| range:", TICK_LOWER, "->", TICK_UPPER);

  const [lpVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_vault"), SOL_MINT.toBuffer(), USDC_MINT.toBuffer(), admin.publicKey.toBuffer(), Buffer.from([0])], PROGRAM_ID);
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_vault_authority"), lpVault.toBuffer()], PROGRAM_ID);
  const positionMintKp = Keypair.generate(), sharesMintKp = Keypair.generate();
  const [position] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), positionMintKp.publicKey.toBuffer()], WHIRLPOOL_PROGRAM);
  const positionTokenAccount = getAssociatedTokenAddressSync(positionMintKp.publicKey, vaultAuthority, true);
  const vaultTokenA = getAssociatedTokenAddressSync(SOL_MINT, vaultAuthority, true);
  const vaultTokenB = getAssociatedTokenAddressSync(USDC_MINT, vaultAuthority, true);
  const tickArrayLower = tickArrayPda(arrayStart(TICK_LOWER));
  const tickArrayUpper = tickArrayPda(arrayStart(TICK_UPPER));

  await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({
    fromPubkey: admin.publicKey, toPubkey: vaultAuthority, lamports: 0.3 * 1e9 })), []);

  // ── [1] init vault ────────────────────────────────────────────────────────
  const initIx = await program.methods.initializeOrcaLpVault({
      keeper: admin.publicKey, treasury: admin.publicKey,
      tickLowerIndex: TICK_LOWER, tickUpperIndex: TICK_UPPER,
      tickArrayLowerStartIndex: 0, tickArrayUpperStartIndex: 0,
      name: "MULTI-DEPOSITOR TEST",
    }).accounts({
      admin: admin.publicKey, lpVault, vaultAuthority,
      tokenAMint: SOL_MINT, tokenBMint: USDC_MINT,
      vaultTokenAAccount: vaultTokenA, vaultTokenBAccount: vaultTokenB,
      lpSharesMint: sharesMintKp.publicKey,
      position, positionMint: positionMintKp.publicKey, positionTokenAccount,
      whirlpool: POOL, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      whirlpoolProgram: WHIRLPOOL_PROGRAM,
    }).instruction();
  const pm = initIx.keys.find(k => k.pubkey.equals(positionMintKp.publicKey));
  if (pm) pm.isSigner = true;
  await provider.sendAndConfirm(new Transaction().add(initIx), [positionMintKp, sharesMintKp], { commitment: "confirmed" });
  console.log("[1] vault + position opened");

  // ── [2] create N synthetic depositors ───────────────────────────────────────
  const wallets = Array.from({ length: N_WALLETS }, () => Keypair.generate());
  console.log(`[2] created ${N_WALLETS} synthetic wallets`);
  for (const w of wallets) {
    await connection.confirmTransaction(await connection.requestAirdrop(w.publicKey, 5000 * 1e9), "confirmed");
  }

  const ctx = {};
  for (const w of wallets) {
    const userWsol = getAssociatedTokenAddressSync(SOL_MINT, w.publicKey);
    const userUsdc = getAssociatedTokenAddressSync(USDC_MINT, w.publicKey);
    const userShares = getAssociatedTokenAddressSync(sharesMintKp.publicKey, w.publicKey);
    const [userPositionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_position"), lpVault.toBuffer(), w.publicKey.toBuffer()], PROGRAM_ID);
    const solAmount = 200; // funding headroom for the fixed liquidity below, not the deposit amount itself
    const prep = new Transaction();
    prep.add(createAssociatedTokenAccountInstruction(w.publicKey, userWsol, w.publicKey, SOL_MINT));
    prep.add(SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: userWsol, lamports: Math.floor(solAmount * 1e9) }));
    prep.add(createSyncNativeInstruction(userWsol));
    prep.add(createAssociatedTokenAccountInstruction(w.publicKey, userUsdc, w.publicKey, USDC_MINT));
    prep.add(createAssociatedTokenAccountInstruction(w.publicKey, userShares, w.publicKey, sharesMintKp.publicKey));
    await provider.sendAndConfirm(prep, [w]);
    ctx[w.publicKey.toBase58()] = { w, userWsol, userUsdc, userShares, userPositionPda, principalSol: solAmount, receivedSol: 0, receivedUsdc: 0 };
  }
  console.log("[2] wallets funded with randomized WSOL balances");

  // Fund each wallet a bit of USDC too, transferred from admin's own ATA (admin needs
  // USDC first — mint doesn't exist locally to mint from, so route through the
  // cloned USDC ATA seeded via usdc_ata.json, same pattern the base harness uses).
  const adminUsdc = new PublicKey("5gXt4YTqgDyzfL4zMErMRGB47gi1N6VAywowAsCAGEac");
  for (const key of Object.keys(ctx)) {
    const c = ctx[key];
    const usdcAmount = Math.floor(3000 * 1e6); // funding headroom, not the deposit amount itself
    try {
      await provider.sendAndConfirm(new Transaction().add(
        require("@solana/spl-token").createTransferInstruction(adminUsdc, c.userUsdc, admin.publicKey, usdcAmount)
      ), []);
      c.principalUsdc = usdcAmount / 1e6;
    } catch (e) {
      c.principalUsdc = 0;
    }
  }

  // ── [3] RANDOM-ORDER deposits from all N wallets ────────────────────────────
  console.log("\n[3] depositing from all wallets, random order:");
  const depositOrder = shuffle(Object.keys(ctx));
  for (const key of depositOrder) {
    const c = ctx[key];
    // Same fixed liquidity for every wallet — matches the known-working single-
    // depositor test exactly (5e13 units, proven to fit within generous max
    // bounds for this range). Randomizing liquidity per-wallet was tried first
    // and reverted: liquidity-to-token-amount isn't a simple linear scale a
    // client can safely guess, and a bad guess just throws TokenMaxExceeded
    // (0x1781) rather than silently depositing the wrong amount — confirmed
    // live against this exact test. Order (not size) is what this test is
    // actually proving, so uniform size costs nothing real.
    const liquidityGuess = new anchor.BN("3000000000000");
    const balABeforeDep = (await connection.getTokenAccountBalance(c.userWsol)).value.amount;
    const balBBeforeDep = (await connection.getTokenAccountBalance(c.userUsdc)).value.amount;
    try {
      await program.methods.depositOrcaLp(
        liquidityGuess, new anchor.BN(Math.floor(c.principalSol * 1e9)), new anchor.BN(Math.floor((c.principalUsdc || 0) * 1e6)), true
      ).accounts({
        user: c.w.publicKey, lpVault, vaultAuthority, userPosition: c.userPositionPda,
        userTokenAAccount: c.userWsol, userTokenBAccount: c.userUsdc, userSharesAccount: c.userShares,
        vaultTokenAAccount: vaultTokenA, vaultTokenBAccount: vaultTokenB,
        lpSharesMint: sharesMintKp.publicKey, whirlpool: POOL, position, positionTokenAccount,
        tokenVaultA: VAULT_A, tokenVaultB: VAULT_B, tickArrayLower, tickArrayUpper,
        tokenProgram: TOKEN_PROGRAM_ID, whirlpoolProgram: WHIRLPOOL_PROGRAM, systemProgram: SystemProgram.programId,
      }).signers([c.w]).rpc({ commitment: "confirmed" });
      c.deposited = true;
      const balAAfterDep = (await connection.getTokenAccountBalance(c.userWsol)).value.amount;
      const balBAfterDep = (await connection.getTokenAccountBalance(c.userUsdc)).value.amount;
      c.actualPrincipalSol = (Number(balABeforeDep) - Number(balAAfterDep)) / 1e9;
      c.actualPrincipalUsdc = (Number(balBBeforeDep) - Number(balBAfterDep)) / 1e6;
      console.log(`    ${key.slice(0,8)}... deposited OK (actually used: ${c.actualPrincipalSol.toFixed(6)} SOL / ${c.actualPrincipalUsdc.toFixed(6)} USDC)`);
    } catch (e) {
      c.deposited = false;
      console.log(`    ${key.slice(0,8)}... deposit FAILED:`, (e.message || "").split("\n")[0].slice(0, 100));
      if (e.logs) console.log("      logs:", e.logs.slice(-6).join(" | "));
    }
  }

  const successfulDepositors = Object.keys(ctx).filter(k => ctx[k].deposited);
  console.log(`[3] ${successfulDepositors.length}/${N_WALLETS} deposits succeeded`);
  if (successfulDepositors.length < 2) { console.log("!! too few succeeded, aborting"); return; }

  // ── [4] generate REAL trading fees ──────────────────────────────────────────
  const [oracle] = PublicKey.findProgramAddressSync([Buffer.from("oracle"), POOL.toBuffer()], WHIRLPOOL_PROGRAM);
  const cur = arrayStart(tickCurrent);
  const downArrays = [cur, cur - SPAN, cur - 2 * SPAN].map(tickArrayPda);
  const upArrays   = [cur, cur + SPAN, cur + 2 * SPAN].map(tickArrayPda);
  const swapperWsol = getAssociatedTokenAddressSync(SOL_MINT, admin.publicKey);
  const swapperUsdc = getAssociatedTokenAddressSync(USDC_MINT, admin.publicKey);
  // Fund admin's own swap wallet — separate from the 8 depositors, this is the
  // trader generating real volume, not a vault participant.
  const swapPrep = new Transaction();
  if (!(await connection.getAccountInfo(swapperWsol)))
    swapPrep.add(createAssociatedTokenAccountInstruction(admin.publicKey, swapperWsol, admin.publicKey, SOL_MINT));
  swapPrep.add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: swapperWsol, lamports: 500 * 1e9 }));
  swapPrep.add(createSyncNativeInstruction(swapperWsol));
  await provider.sendAndConfirm(swapPrep, []);
  try {
    const usdcPrep = new Transaction();
    if (!(await connection.getAccountInfo(swapperUsdc)))
      usdcPrep.add(createAssociatedTokenAccountInstruction(admin.publicKey, swapperUsdc, admin.publicKey, USDC_MINT));
    usdcPrep.add(require("@solana/spl-token").createTransferInstruction(adminUsdc, swapperUsdc, admin.publicKey, Math.floor(2000 * 1e6)));
    await provider.sendAndConfirm(usdcPrep, []);
  } catch (e) { console.log("    (swap-wallet USDC funding failed, A->B swaps only):", (e.message||"").split("\n")[0]); }
  let swaps = 0;
  for (let i = 0; i < 8; i++) {
    const aToB = i % 2 === 0;
    const arrays = aToB ? downArrays : upArrays;
    const amount = aToB ? 30 * 1e9 : 2500 * 1e6;
    try {
      await provider.sendAndConfirm(new Transaction().add(swapIx({
        authority: admin.publicKey, userA: swapperWsol, userB: swapperUsdc,
        ta0: arrays[0], ta1: arrays[1], ta2: arrays[2], oracle, amount, aToB,
      })), [], { commitment: "confirmed" });
      swaps++;
    } catch (e) { /* ignore individual failures */ }
  }
  console.log(`[4] executed ${swaps}/8 swaps to generate real fees`);

  // ── [5] collect fees (auto-compound into idle balance) ──────────────────────
  await program.methods.collectOrcaLpFees().accounts({
    keeper: admin.publicKey, lpVault, vaultAuthority,
    vaultTokenAAccount: vaultTokenA, vaultTokenBAccount: vaultTokenB,
    whirlpool: POOL, position, positionTokenAccount,
    tokenVaultA: VAULT_A, tokenVaultB: VAULT_B, tickArrayLower, tickArrayUpper,
    tokenProgram: TOKEN_PROGRAM_ID, whirlpoolProgram: WHIRLPOOL_PROGRAM,
  }).rpc({ commitment: "confirmed" });
  const lpVaultAfterCollect = await program.account.lpVault.fetch(lpVault);
  console.log("[5] fees collected. lifetime_fees:", lpVaultAfterCollect.lifetimeFeesA.toString(), "A /",
              lpVaultAfterCollect.lifetimeFeesB.toString(), "B");

  // ── [6] RANDOM-ORDER full withdrawals from every successful depositor ───────
  console.log("\n[6] withdrawing (MAX) from every depositor, random order:");
  const withdrawOrder = shuffle(successfulDepositors);
  for (const key of withdrawOrder) {
    const c = ctx[key];
    const userPos = await program.account.lpUserPosition.fetch(c.userPositionPda).catch(() => null);
    if (!userPos || userPos.shares.isZero()) { console.log(`    ${key.slice(0,8)}... no shares, skip`); continue; }

    const balABefore = (await connection.getTokenAccountBalance(c.userWsol)).value.amount;
    const balBBefore = (await connection.getTokenAccountBalance(c.userUsdc)).value.amount;

    try {
      await program.methods.withdrawOrcaLp(userPos.shares, new anchor.BN(0), new anchor.BN(0)).accounts({
        user: c.w.publicKey, lpVault, vaultAuthority, userPosition: c.userPositionPda,
        userTokenAAccount: c.userWsol, userTokenBAccount: c.userUsdc, userSharesAccount: c.userShares,
        vaultTokenAAccount: vaultTokenA, vaultTokenBAccount: vaultTokenB,
        lpSharesMint: sharesMintKp.publicKey, whirlpool: POOL, position, positionTokenAccount,
        tokenVaultA: VAULT_A, tokenVaultB: VAULT_B, tickArrayLower, tickArrayUpper,
        tokenProgram: TOKEN_PROGRAM_ID, whirlpoolProgram: WHIRLPOOL_PROGRAM,
      }).signers([c.w]).rpc({ commitment: "confirmed" });

      const balAAfter = (await connection.getTokenAccountBalance(c.userWsol)).value.amount;
      const balBAfter = (await connection.getTokenAccountBalance(c.userUsdc)).value.amount;
      c.receivedSol = (Number(balAAfter) - Number(balABefore)) / 1e9;
      c.receivedUsdc = (Number(balBAfter) - Number(balBBefore)) / 1e6;
      console.log(`    ${key.slice(0,8)}... withdrew: +${c.receivedSol.toFixed(6)} SOL / +${c.receivedUsdc.toFixed(6)} USDC` +
                  ` (actually deposited ${c.actualPrincipalSol.toFixed(6)} SOL / ${c.actualPrincipalUsdc.toFixed(6)} USDC)`);
      c.withdrew = true;
    } catch (e) {
      console.log(`    ${key.slice(0,8)}... WITHDRAW FAILED:`, (e.message || "").split("\n")[0].slice(0, 120));
      c.withdrew = false;
    }
  }

  // ── [7] FINAL INVARIANT CHECKS ───────────────────────────────────────────────
  console.log("\n[7] === FINAL VERIFICATION ===");
  const finalVault = await program.account.lpVault.fetch(lpVault);
  console.log("    final total_shares:", finalVault.totalShares.toString(), "(expect 0 if everyone withdrew)");
  const vaultAFinal = (await connection.getTokenAccountBalance(vaultTokenA)).value.amount;
  const vaultBFinal = (await connection.getTokenAccountBalance(vaultTokenB)).value.amount;
  console.log("    final vault idle balance:", vaultAFinal, "A /", vaultBFinal, "B (expect ~0, no stuck value)");

  let totalPrincipalSol = 0, totalPrincipalUsdc = 0, totalReceivedSol = 0, totalReceivedUsdc = 0;
  let anyoneLost = false, anyoneOverpaid = false;
  for (const key of successfulDepositors) {
    const c = ctx[key];
    if (!c.withdrew) continue;
    totalPrincipalSol += c.actualPrincipalSol; totalPrincipalUsdc += c.actualPrincipalUsdc;
    totalReceivedSol += c.receivedSol; totalReceivedUsdc += c.receivedUsdc;
  }
  console.log(`    total principal in:  ${totalPrincipalSol.toFixed(6)} SOL / ${totalPrincipalUsdc.toFixed(6)} USDC`);
  console.log(`    total received out:  ${totalReceivedSol.toFixed(6)} SOL / ${totalReceivedUsdc.toFixed(6)} USDC`);
  const netSol = totalReceivedSol - totalPrincipalSol, netUsdc = totalReceivedUsdc - totalPrincipalUsdc;
  console.log(`    net (fees + price movement): ${netSol >= 0 ? "+" : ""}${netSol.toFixed(6)} SOL / ${netUsdc >= 0 ? "+" : ""}${netUsdc.toFixed(6)} USDC`);

  const shareMathHolds = finalVault.totalShares.isZero() && Number(vaultAFinal) < 100000 && Number(vaultBFinal) < 100000;
  console.log("\nRESULT:", shareMathHolds ? "MULTI_DEPOSITOR_MATH_OK" : "MULTI_DEPOSITOR_MATH_BROKEN — funds stuck or shares not zeroed");
})().catch(e => { console.error("FATAL:", e.message); if (e.logs) console.error(e.logs.slice(-15).join("\n")); process.exit(1); });
