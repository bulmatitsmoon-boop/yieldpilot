/**
 * All 6 Orca LP paths, run WITH REAL TRADING VOLUME and a LIVE-DERIVED tick range.
 *
 * WHY THIS EXISTS
 * The original harness reported all 12 LP paths passing. That result was weak for two
 * structural reasons, both proven on 2026-07-21:
 *   1. Zero trading volume — a cloned validator has no swaps, so fee_owed stays 0 and
 *      close_position's emptiness gate is trivially satisfied. That hid a real revert bug
 *      for weeks (PR #129).
 *   2. A hardcoded tick range — the cloned pool keeps trading on mainnet, so a baked-in
 *      range goes stale and silently lands the position OUT OF RANGE, where it earns
 *      nothing and every "pass" is meaningless.
 *
 * So every path here runs against a position that is in-range and has actually earned
 * fees. Swaps are injected before the operations where accrued fees change behaviour.
 *
 * Run:  node orca_full_suite.js
 */
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

const SPAN = 352;                                   // tick_spacing 4 x 88 ticks per array
const arrayStart = (t) => Math.floor(t / SPAN) * SPAN;
const tickArrayPda = (s) => PublicKey.findProgramAddressSync(
  [Buffer.from("tick_array"), POOL.toBuffer(), Buffer.from(String(s))], WHIRLPOOL_PROGRAM)[0];
const disc = (n) => crypto.createHash("sha256").update("global:" + n).digest().subarray(0, 8);
const MIN_SQRT = 4295048016n, MAX_SQRT = 79226673515401279992447579055n;
const readPos = (d) => ({
  liquidity: d.readBigUInt64LE(72) + (d.readBigUInt64LE(80) << 64n),
  feeA: d.readBigUInt64LE(112), feeB: d.readBigUInt64LE(136),
});

const results = [];
const record = (name, ok, note = "") => {
  results.push({ name, ok, note });
  console.log(`${ok ? "  ✓ PASS" : "  ✗ FAIL"}  ${name}${note ? "  — " + note : ""}`);
};

function swapIx({ authority, userA, userB, arrays, oracle, amount, aToB }) {
  const buf8 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const lim = aToB ? MIN_SQRT : MAX_SQRT;
  const b16 = Buffer.alloc(16);
  b16.writeBigUInt64LE(lim & 0xffffffffffffffffn, 0); b16.writeBigUInt64LE(lim >> 64n, 8);
  const data = Buffer.concat([disc("swap"), buf8(amount), buf8(0), b16, Buffer.from([1]), Buffer.from([aToB ? 1 : 0])]);
  // Order verified against orca-so/whirlpools instructions/swap.rs
  return new TransactionInstruction({ programId: WHIRLPOOL_PROGRAM, data, keys: [
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: authority, isSigner: true, isWritable: false },
    { pubkey: POOL, isSigner: false, isWritable: true },
    { pubkey: userA, isSigner: false, isWritable: true },
    { pubkey: VAULT_A, isSigner: false, isWritable: true },
    { pubkey: userB, isSigner: false, isWritable: true },
    { pubkey: VAULT_B, isSigner: false, isWritable: true },
    { pubkey: arrays[0], isSigner: false, isWritable: true },
    { pubkey: arrays[1], isSigner: false, isWritable: true },
    { pubkey: arrays[2], isSigner: false, isWritable: true },
    { pubkey: oracle, isSigner: false, isWritable: false },
  ]});
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
    try { await connection.confirmTransaction(await connection.requestAirdrop(admin.publicKey, 500e9), "confirmed"); } catch { break; }
  }

  const poolInfo = await connection.getAccountInfo(POOL);
  if (!poolInfo) throw new Error("whirlpool not cloned — validator misconfigured");
  const tickCurrent = poolInfo.data.readInt32LE(81);
  const poolLiq = poolInfo.data.readBigUInt64LE(49) + (poolInfo.data.readBigUInt64LE(57) << 64n);
  const align = (t) => Math.round(t / 4) * 4;
  const TICK_LOWER = align(tickCurrent - 28), TICK_UPPER = align(tickCurrent + 28);
  console.log(`pool tick_current ${tickCurrent} | range ${TICK_LOWER}..${TICK_UPPER} | pool liq ${poolLiq}`);

  const [lpVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_vault"), SOL_MINT.toBuffer(), USDC_MINT.toBuffer(), admin.publicKey.toBuffer()], PROGRAM_ID);
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_vault_authority"), lpVault.toBuffer()], PROGRAM_ID);
  const posMint = Keypair.generate(), sharesMint = Keypair.generate();
  const [position] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), posMint.publicKey.toBuffer()], WHIRLPOOL_PROGRAM);
  const posTokenAcct = getAssociatedTokenAddressSync(posMint.publicKey, vaultAuthority, true);
  const vaultA = getAssociatedTokenAddressSync(SOL_MINT, vaultAuthority, true);
  const vaultB = getAssociatedTokenAddressSync(USDC_MINT, vaultAuthority, true);
  const taLower = tickArrayPda(arrayStart(TICK_LOWER)), taUpper = tickArrayPda(arrayStart(TICK_UPPER));
  const [oracle] = PublicKey.findProgramAddressSync([Buffer.from("oracle"), POOL.toBuffer()], WHIRLPOOL_PROGRAM);

  await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({
    fromPubkey: admin.publicKey, toPubkey: vaultAuthority, lamports: 0.4 * 1e9 })), []);

  // ── 1. initialize (CPIs open_position) ──────────────────────────────────────
  console.log("\n[1] initialize_orca_lp_vault");
  try {
    const ix = await program.methods.initializeOrcaLpVault({
        keeper: admin.publicKey, treasury: admin.publicKey,
        tickLowerIndex: TICK_LOWER, tickUpperIndex: TICK_UPPER,
        tickArrayLowerStartIndex: 0, tickArrayUpperStartIndex: 0, name: "FULL SUITE ORCA",
      }).accounts({
        admin: admin.publicKey, lpVault, vaultAuthority, tokenAMint: SOL_MINT, tokenBMint: USDC_MINT,
        vaultTokenAAccount: vaultA, vaultTokenBAccount: vaultB, lpSharesMint: sharesMint.publicKey,
        position, positionMint: posMint.publicKey, positionTokenAccount: posTokenAcct,
        whirlpool: POOL, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        whirlpoolProgram: WHIRLPOOL_PROGRAM,
      }).instruction();
    const pm = ix.keys.find(k => k.pubkey.equals(posMint.publicKey)); if (pm) pm.isSigner = true;
    await provider.sendAndConfirm(new Transaction().add(ix), [posMint, sharesMint], { commitment: "confirmed" });
    record("initialize_orca_lp_vault", true);
  } catch (e) { record("initialize_orca_lp_vault", false, (e.message||"").split("\n")[0].slice(0,90)); return summary(); }

  // fund the user
  const userWsol = getAssociatedTokenAddressSync(SOL_MINT, admin.publicKey);
  const userUsdc = getAssociatedTokenAddressSync(USDC_MINT, admin.publicKey);
  const userShares = getAssociatedTokenAddressSync(sharesMint.publicKey, admin.publicKey);
  const prep = new Transaction();
  if (!(await connection.getAccountInfo(userWsol)))
    prep.add(createAssociatedTokenAccountInstruction(admin.publicKey, userWsol, admin.publicKey, SOL_MINT));
  prep.add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: userWsol, lamports: 2000 * 1e9 }));
  prep.add(createSyncNativeInstruction(userWsol));
  prep.add(createAssociatedTokenAccountInstruction(admin.publicKey, userShares, admin.publicKey, sharesMint.publicKey));
  await provider.sendAndConfirm(prep, []);

  const [userPos] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_position"), lpVault.toBuffer(), admin.publicKey.toBuffer()], PROGRAM_ID);
  const depAcc = {
    user: admin.publicKey, lpVault, vaultAuthority, userPosition: userPos,
    userTokenAAccount: userWsol, userTokenBAccount: userUsdc, userSharesAccount: userShares,
    vaultTokenAAccount: vaultA, vaultTokenBAccount: vaultB, lpSharesMint: sharesMint.publicKey,
    whirlpool: POOL, position, positionTokenAccount: posTokenAcct,
    tokenVaultA: VAULT_A, tokenVaultB: VAULT_B, tickArrayLower: taLower, tickArrayUpper: taUpper,
    tokenProgram: TOKEN_PROGRAM_ID, whirlpoolProgram: WHIRLPOOL_PROGRAM, systemProgram: SystemProgram.programId,
  };
  const LIQ = 50_000_000_000_000;   // ~4-5% of pool, so fees are observable

  // ── 2. deposit ──────────────────────────────────────────────────────────────
  console.log("\n[2] deposit_orca_lp");
  try {
    // The handler transfers token_max_a/token_max_b from the user FIRST, then increases
    // liquidity and refunds the remainder. So the caps must be <= the USER'S BALANCE, not
    // merely >= what the position needs. 60k USDC against a 50k balance failed with a bare
    // "insufficient funds" from the SPL transfer, which reads like a program bug and is not
    // one — it is the test asking for more than the wallet holds.
    await program.methods.depositOrcaLp(new anchor.BN(LIQ), new anchor.BN(1200*1e9), new anchor.BN(45_000*1e6), true)
      .accounts(depAcc).rpc({ commitment: "confirmed" });
    const p = readPos((await connection.getAccountInfo(position)).data);
    record("deposit_orca_lp", p.liquidity > 0n, `liquidity ${p.liquidity}`);
  } catch (e) { record("deposit_orca_lp", false, (e.message||"").split("\n")[0].slice(0,90)); return summary(); }

  // ── generate trading so every later path faces accrued fees ────────────────
  const cur = arrayStart(tickCurrent);
  const down = [cur, cur-SPAN, cur-2*SPAN].map(tickArrayPda);
  const up   = [cur, cur+SPAN, cur+2*SPAN].map(tickArrayPda);
  async function trade(rounds = 6) {
    let n = 0;
    for (let i = 0; i < rounds; i++) {
      const aToB = i % 2 === 0;
      try {
        await provider.sendAndConfirm(new Transaction().add(swapIx({
          authority: admin.publicKey, userA: userWsol, userB: userUsdc,
          arrays: aToB ? down : up, oracle, amount: aToB ? 20*1e9 : 1500*1e6, aToB })), [], { commitment: "confirmed" });
        n++;
      } catch {}
    }
    try {
      await provider.sendAndConfirm(new Transaction().add(new TransactionInstruction({
        programId: WHIRLPOOL_PROGRAM, data: disc("update_fees_and_rewards"), keys: [
          { pubkey: POOL, isSigner: false, isWritable: true },
          { pubkey: position, isSigner: false, isWritable: true },
          { pubkey: taLower, isSigner: false, isWritable: false },
          { pubkey: taUpper, isSigner: false, isWritable: false },
        ]})), [], { commitment: "confirmed" });
    } catch {}
    return n;
  }
  const n1 = await trade();
  const afterTrade = readPos((await connection.getAccountInfo(position)).data);
  console.log(`\n    generated ${n1} swaps -> fees owed A=${afterTrade.feeA} B=${afterTrade.feeB}`);
  if (afterTrade.feeA === 0n && afterTrade.feeB === 0n)
    console.log("    ⚠ NO FEES ACCRUED — results below are NOT meaningfully stronger than the old harness");

  // ── 3. withdraw (partial, with fees outstanding) ────────────────────────────
  console.log("\n[3] withdraw_orca_lp  (with fees outstanding)");
  try {
    const sh = await connection.getTokenAccountBalance(userShares);
    const half = new anchor.BN(sh.value.amount).divn(2);
    const wsolBefore = Number((await connection.getTokenAccountBalance(userWsol)).value.amount);
    await program.methods.withdrawOrcaLp(half, new anchor.BN(0), new anchor.BN(0))
      .accounts(depAcc).rpc({ commitment: "confirmed" });
    const wsolAfter = Number((await connection.getTokenAccountBalance(userWsol)).value.amount);
    record("withdraw_orca_lp", wsolAfter > wsolBefore, `returned ${((wsolAfter-wsolBefore)/1e9).toFixed(4)} WSOL`);
  } catch (e) { record("withdraw_orca_lp", false, (e.message||"").split("\n")[0].slice(0,90)); }

  // ── 4. exit (the path #129 fixed) ──────────────────────────────────────────
  await trade(4);
  const preExit = readPos((await connection.getAccountInfo(position)).data);
  console.log(`\n[4] exit_orca_lp_position  (fees owed A=${preExit.feeA} B=${preExit.feeB})`);
  try {
    await program.methods.exitOrcaLpPosition().accounts({
      keeper: admin.publicKey, lpVault, vaultAuthority, vaultTokenAAccount: vaultA, vaultTokenBAccount: vaultB,
      whirlpool: POOL, position, positionMint: posMint.publicKey, positionTokenAccount: posTokenAcct,
      tokenVaultA: VAULT_A, tokenVaultB: VAULT_B, tickArrayLower: taLower, tickArrayUpper: taUpper,
      tokenProgram: TOKEN_PROGRAM_ID, whirlpoolProgram: WHIRLPOOL_PROGRAM,
    }).rpc({ commitment: "confirmed" });
    const lv = await program.account.lpVault.fetch(lpVault);
    record("exit_orca_lp_position", !lv.positionActive, "position_active=false");
  } catch (e) { record("exit_orca_lp_position", false, (e.message||"").split("\n")[0].slice(0,90)); return summary(); }

  // ── 5. open_new at a fresh live-derived range ──────────────────────────────
  const t2 = (await connection.getAccountInfo(POOL)).data.readInt32LE(81);
  const NL = align(t2 - 40), NU = align(t2 + 40);
  const newMint = Keypair.generate();
  const [newPosition] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), newMint.publicKey.toBuffer()], WHIRLPOOL_PROGRAM);
  const newPosAcct = getAssociatedTokenAddressSync(newMint.publicKey, vaultAuthority, true);
  console.log(`\n[5] open_new_orca_lp_position  (tick now ${t2}, new range ${NL}..${NU})`);
  try {
    const ix = await program.methods.openNewOrcaLpPosition(NL, NU).accounts({
        authority: admin.publicKey, lpVault, vaultAuthority, position: newPosition,
        positionMint: newMint.publicKey, positionTokenAccount: newPosAcct, whirlpool: POOL,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        whirlpoolProgram: WHIRLPOOL_PROGRAM,
      }).instruction();
    const m = ix.keys.find(k => k.pubkey.equals(newMint.publicKey)); if (m) m.isSigner = true;
    await provider.sendAndConfirm(new Transaction().add(ix), [newMint], { commitment: "confirmed" });
    record("open_new_orca_lp_position", !!(await connection.getAccountInfo(newPosition)));
  } catch (e) { record("open_new_orca_lp_position", false, (e.message||"").split("\n")[0].slice(0,90)); return summary(); }

  // ── 6. redeploy the idle funds into the new position ───────────────────────
  console.log("\n[6] redeploy_orca_lp_liquidity");
  const idleA = Number((await connection.getTokenAccountBalance(vaultA)).value.amount);
  const idleB = Number((await connection.getTokenAccountBalance(vaultB)).value.amount);
  console.log(`    vault idle: ${(idleA/1e9).toFixed(4)} WSOL / ${(idleB/1e6).toFixed(2)} USDC`);
  try {
    const nl = tickArrayPda(arrayStart(NL)), nu = tickArrayPda(arrayStart(NU));
    await program.methods.redeployOrcaLpLiquidity(
        new anchor.BN(LIQ / 4), new anchor.BN(idleA), new anchor.BN(idleB))
      .accounts({
        keeper: admin.publicKey, lpVault, vaultAuthority, vaultTokenAAccount: vaultA, vaultTokenBAccount: vaultB,
        whirlpool: POOL, position: newPosition, positionTokenAccount: newPosAcct,
        tokenVaultA: VAULT_A, tokenVaultB: VAULT_B, tickArrayLower: nl, tickArrayUpper: nu,
        tokenProgram: TOKEN_PROGRAM_ID, whirlpoolProgram: WHIRLPOOL_PROGRAM,
      }).rpc({ commitment: "confirmed" });
    const lv = await program.account.lpVault.fetch(lpVault);
    const restA = Number((await connection.getTokenAccountBalance(vaultA)).value.amount);
    record("redeploy_orca_lp_liquidity", lv.positionActive,
      `active=${lv.positionActive}, idle left ${(restA/1e9).toFixed(4)} WSOL`);
  } catch (e) { record("redeploy_orca_lp_liquidity", false, (e.message||"").split("\n")[0].slice(0,90)); }

  summary();

  function summary() {
    console.log("\n" + "=".repeat(58));
    console.log("ORCA SUITE — with real volume and a live-derived range");
    results.forEach(r => console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}`));
    const p = results.filter(r => r.ok).length;
    console.log(`\n  ${p}/${results.length} passed (of 6 Orca paths)`);
  }
})().catch(e => { console.error("FATAL:", e.message); if (e.logs) console.error(e.logs.slice(-15).join("\n")); process.exit(1); });
