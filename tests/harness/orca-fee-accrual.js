// Proves (or disproves) the Orca collect_fees fix — PR #129.
//
// THE POINT: the existing harness could never catch this bug. A local validator
// cloned from mainnet has ZERO trading volume, so no position ever earns fees,
// so `is_position_empty` is trivially satisfied and close_position always
// succeeds. All 12 LP paths "passed" because nothing was ever earned.
//
// This driver generates REAL swaps against the cloned Whirlpool first, so the
// vault's position actually accrues fees, and only then tries to exit.
//
// Expected results, same script against two binaries:
//   yieldpilot_p2.so     (pre-fix)  -> EXIT FAILS  (close_position rejects fees owed)
//   yieldpilot_p2_fix.so (PR #129)  -> EXIT SUCCEEDS
//
// If the pre-fix binary also succeeds, the bug is not what I claimed and the
// PR should not merge.
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

// Range is derived from the LIVE tick at runtime, not hardcoded. The pool is
// cloned from mainnet and keeps trading there, so any baked-in range goes stale
// and silently lands the position out-of-range — where it earns no fees and the
// test proves nothing. (That is exactly what happened on the first run: the
// harness's old -25600/-25536 range was written when tick_current was -25568;
// by the time it ran the pool had moved to -25532 and the position was dead.)
let TICK_LOWER, TICK_UPPER;
const SPAN = 352;                                  // spacing 4 x 88 ticks
const arrayStart = (t) => Math.floor(t / SPAN) * SPAN;
const tickArrayPda = (startTick) => PublicKey.findProgramAddressSync(
  [Buffer.from("tick_array"), POOL.toBuffer(), Buffer.from(String(startTick))], WHIRLPOOL_PROGRAM)[0];

const disc = (n) => crypto.createHash("sha256").update("global:" + n).digest().subarray(0, 8);
const MIN_SQRT_PRICE = 4295048016n;
const MAX_SQRT_PRICE = 79226673515401279992447579055n;

// Orca Position layout (8-byte anchor discriminator + fields).
const readPosition = (data) => ({
  liquidity: data.readBigUInt64LE(72) + (data.readBigUInt64LE(80) << 64n),
  tickLower: data.readInt32LE(88),
  tickUpper: data.readInt32LE(92),
  feeOwedA: data.readBigUInt64LE(112),
  feeOwedB: data.readBigUInt64LE(136),
});

function swapIx({ authority, userA, userB, ta0, ta1, ta2, oracle, amount, aToB }) {
  const d = Buffer.concat([
    disc("swap"),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(amount)); return b; })(),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(0n); return b; })(),          // other_amount_threshold
    (() => { const b = Buffer.alloc(16); const v = aToB ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;
             b.writeBigUInt64LE(v & 0xffffffffffffffffn, 0); b.writeBigUInt64LE(v >> 64n, 8); return b; })(),
    Buffer.from([1]),                                                                    // amount_specified_is_input
    Buffer.from([aToB ? 1 : 0]),
  ]);
  // Order verified against orca-so/whirlpools instructions/swap.rs
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

(async () => {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(path.resolve(os.homedir(), ".config/solana/id.json"), "utf8"))));
  const connection = new Connection(RPC, { commitment: "confirmed" });
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.resolve(__dirname, "idl_p2.json"), "utf8"));
  const program = new anchor.Program(idl, provider);

  // Large swaps need a large bankroll; airdrop in chunks (per-request cap).
  for (let i = 0; i < 12; i++) {
    if ((await connection.getBalance(admin.publicKey)) > 3000e9) break;
    try { await connection.confirmTransaction(await connection.requestAirdrop(admin.publicKey, 500e9), "confirmed"); }
    catch { break; }
  }
  console.log("[0] admin SOL:", ((await connection.getBalance(admin.publicKey)) / 1e9).toFixed(1));

  const poolInfo = await connection.getAccountInfo(POOL);
  if (!poolInfo) throw new Error("whirlpool not cloned");
  const tickCurrent = poolInfo.data.readInt32LE(81);
  const poolLiquidity = poolInfo.data.readBigUInt64LE(49) + (poolInfo.data.readBigUInt64LE(57) << 64n);

  // Straddle the live tick, spacing-aligned, and stay inside ONE initialised
  // tick array so both bounds resolve to cloned accounts.
  const align = (t) => Math.round(t / 4) * 4;
  TICK_LOWER = align(tickCurrent - 28);
  TICK_UPPER = align(tickCurrent + 28);
  console.log("    pool tick_current:", tickCurrent, "| derived range:", TICK_LOWER, "->", TICK_UPPER);
  console.log("    pool active liquidity:", poolLiquidity.toString());
  if (arrayStart(TICK_LOWER) !== arrayStart(TICK_UPPER)) {
    console.log("    (range spans two tick arrays — both must be cloned)");
  }

  const [lpVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_vault"), SOL_MINT.toBuffer(), USDC_MINT.toBuffer(), admin.publicKey.toBuffer()], PROGRAM_ID);
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

  // ── [1] init vault (opens the position) ────────────────────────────────────
  const initIx = await program.methods.initializeOrcaLpVault({
      keeper: admin.publicKey, treasury: admin.publicKey,
      tickLowerIndex: TICK_LOWER, tickUpperIndex: TICK_UPPER,
      tickArrayLowerStartIndex: 0, tickArrayUpperStartIndex: 0,
      name: "FEE TEST ORCA SOL-USDC",
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

  // ── [2] fund user, deposit liquidity ───────────────────────────────────────
  const userWsol = getAssociatedTokenAddressSync(SOL_MINT, admin.publicKey);
  const userUsdc = getAssociatedTokenAddressSync(USDC_MINT, admin.publicKey);
  const userShares = getAssociatedTokenAddressSync(sharesMintKp.publicKey, admin.publicKey);
  const prep = new Transaction();
  if (!(await connection.getAccountInfo(userWsol)))
    prep.add(createAssociatedTokenAccountInstruction(admin.publicKey, userWsol, admin.publicKey, SOL_MINT));
  prep.add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: userWsol, lamports: 1500 * 1e9 }));
  prep.add(createSyncNativeInstruction(userWsol));
  prep.add(createAssociatedTokenAccountInstruction(admin.publicKey, userShares, admin.publicKey, sharesMintKp.publicKey));
  await provider.sendAndConfirm(prep, []);

  const [userPositionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_position"), lpVault.toBuffer(), admin.publicKey.toBuffer()], PROGRAM_ID);
  const depositAccounts = {
    user: admin.publicKey, lpVault, vaultAuthority, userPosition: userPositionPda,
    userTokenAAccount: userWsol, userTokenBAccount: userUsdc, userSharesAccount: userShares,
    vaultTokenAAccount: vaultTokenA, vaultTokenBAccount: vaultTokenB,
    lpSharesMint: sharesMintKp.publicKey, whirlpool: POOL, position, positionTokenAccount,
    tokenVaultA: VAULT_A, tokenVaultB: VAULT_B, tickArrayLower, tickArrayUpper,
    tokenProgram: TOKEN_PROGRAM_ID, whirlpoolProgram: WHIRLPOOL_PROGRAM, systemProgram: SystemProgram.programId,
  };
  // Fees are split by liquidity share. The old harness deposited 5e8 against a
  // pool holding 1.1e15 — a 0.000045% share, where any realistic swap rounds our
  // cut to zero. Size the position to a few percent of the pool so accrual is
  // actually observable.
  const LIQUIDITY = 50_000_000_000_000;
  await program.methods.depositOrcaLp(
    new anchor.BN(LIQUIDITY), new anchor.BN(1200 * 1e9), new anchor.BN(45_000 * 1e6), true
  ).accounts(depositAccounts).rpc({ commitment: "confirmed" });
  const posAfterDep = readPosition((await connection.getAccountInfo(position)).data);
  console.log("[2] deposited. position liquidity:", posAfterDep.liquidity.toString(),
              "| share of pool:", (Number(posAfterDep.liquidity) / Number(poolLiquidity) * 100).toFixed(4) + "%");
  console.log("    fees owed A/B:", posAfterDep.feeOwedA.toString(), "/", posAfterDep.feeOwedB.toString());

  // ── [3] GENERATE REAL TRADING — this is what the harness never did ────────
  const [oracle] = PublicKey.findProgramAddressSync([Buffer.from("oracle"), POOL.toBuffer()], WHIRLPOOL_PROGRAM);
  const cur = arrayStart(tickCurrent);
  const downArrays = [cur, cur - SPAN, cur - 2 * SPAN].map(tickArrayPda);
  const upArrays   = [cur, cur + SPAN, cur + 2 * SPAN].map(tickArrayPda);

  let swaps = 0;
  for (let i = 0; i < 6; i++) {
    const aToB = i % 2 === 0;                       // alternate so price oscillates around our range
    const arrays = aToB ? downArrays : upArrays;
    const amount = aToB ? 20 * 1e9 : 1500 * 1e6;    // 20 WSOL  or  1500 USDC
    try {
      await provider.sendAndConfirm(new Transaction().add(swapIx({
        authority: admin.publicKey, userA: userWsol, userB: userUsdc,
        ta0: arrays[0], ta1: arrays[1], ta2: arrays[2], oracle, amount, aToB,
      })), [], { commitment: "confirmed" });
      swaps++;
    } catch (e) {
      console.log(`    swap ${i} (${aToB ? "A->B" : "B->A"}) failed:`, (e.message || "").split("\n")[0].slice(0, 120));
    }
  }
  const poolAfter = await connection.getAccountInfo(POOL);
  console.log(`[3] executed ${swaps}/6 swaps. tick_current now:`, poolAfter.data.readInt32LE(81));
  if (swaps === 0) { console.log("!! no swaps landed — test is inconclusive, aborting"); return; }

  // Fees accrue to fee_growth_global immediately, but the POSITION's fee_owed
  // fields only refresh when the position is touched. Poke it so we can observe
  // the accrual directly rather than inferring it.
  try {
    await provider.sendAndConfirm(new Transaction().add(new TransactionInstruction({
      programId: WHIRLPOOL_PROGRAM,
      keys: [
        { pubkey: POOL, isSigner: false, isWritable: true },
        { pubkey: position, isSigner: false, isWritable: true },
        { pubkey: tickArrayLower, isSigner: false, isWritable: false },
        { pubkey: tickArrayUpper, isSigner: false, isWritable: false },
      ],
      data: disc("update_fees_and_rewards"),
    })), [], { commitment: "confirmed" });
  } catch (e) { console.log("    (update_fees_and_rewards failed:", (e.message||"").split("\n")[0].slice(0,90), ")"); }

  const posAfterSwaps = readPosition((await connection.getAccountInfo(position)).data);
  console.log("[4] position fees owed after trading:  A =", posAfterSwaps.feeOwedA.toString(),
              " B =", posAfterSwaps.feeOwedB.toString());
  const earned = posAfterSwaps.feeOwedA > 0n || posAfterSwaps.feeOwedB > 0n;
  console.log("    position has earned fees:", earned, earned ? "-> close_position MUST be gated" : "-> test inconclusive");

  // ── [5] THE ACTUAL TEST — exit with fees outstanding ──────────────────────
  console.log("\n[5] >>> exit_orca_lp_position WITH FEES OUTSTANDING <<<");
  try {
    const sig = await program.methods.exitOrcaLpPosition().accounts({
      keeper: admin.publicKey, lpVault, vaultAuthority,
      vaultTokenAAccount: vaultTokenA, vaultTokenBAccount: vaultTokenB,
      whirlpool: POOL, position, positionMint: positionMintKp.publicKey, positionTokenAccount,
      tokenVaultA: VAULT_A, tokenVaultB: VAULT_B, tickArrayLower, tickArrayUpper,
      tokenProgram: TOKEN_PROGRAM_ID, whirlpoolProgram: WHIRLPOOL_PROGRAM,
    }).rpc({ commitment: "confirmed" });
    const vA = await connection.getTokenAccountBalance(vaultTokenA);
    const vB = await connection.getTokenAccountBalance(vaultTokenB);
    const lv = await program.account.lpVault.fetch(lpVault);
    console.log("*** EXIT SUCCEEDED *** tx:", sig);
    console.log("    vault idle after exit:", vA.value.uiAmountString, "WSOL /", vB.value.uiAmountString, "USDC");
    console.log("    position_active:", lv.positionActive, "(expect false)");
    console.log("\nRESULT: EXIT_OK");
  } catch (e) {
    console.error("*** EXIT FAILED ***:", (e.message || "").split("\n")[0]);
    if (e.logs) console.error("--- last logs ---\n" + e.logs.slice(-10).join("\n"));
    console.log("\nRESULT: EXIT_FAILED");
  }
})().catch(e => { console.error("FATAL:", e.message); if (e.logs) console.error(e.logs.slice(-15).join("\n")); process.exit(1); });
