/**
 * Does an OUT-OF-RANGE position actually convert to one token, and does a centred range
 * actually fail to redeploy from it?
 *
 * WHY: PR #135 (side-aware ranges) was justified by "33.43 WSOL stranded on the harness".
 * A later run showed that residue came from the test redeploying only LIQ/4 — the holdings
 * were 50/50 and the centred range was fine. So the stated evidence was WRONG and the bug
 * is, so far, only reasoned about. This settles it by force: push the price clean out of
 * the range, exit, and measure what the vault is actually holding.
 */
const anchor = require("@coral-xyz/anchor");
const { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY,
        Transaction, TransactionInstruction } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
        createAssociatedTokenAccountInstruction, createSyncNativeInstruction } = require("@solana/spl-token");
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");

const RPC = "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey("8c7Boyk91MWkn5jabf5CnYD8DrG6p4hYm9eDdAAWXEKH");
const WP = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const POOL = new PublicKey("Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE");
const SOL = new PublicKey("So11111111111111111111111111111111111111112");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const VA = new PublicKey("EUuUbDcafPrmVTD5M6qoJAoyyNbihBhugADAxRMn5he9");
const VB = new PublicKey("2WLWEuKDgkDUccTpbwYp1GToYktiSB1cXvreHUwiSUVP");
const SPAN = 352, aS = t => Math.floor(t / SPAN) * SPAN;
const taPda = s => PublicKey.findProgramAddressSync(
  [Buffer.from("tick_array"), POOL.toBuffer(), Buffer.from(String(s))], WP)[0];
const disc = n => crypto.createHash("sha256").update("global:" + n).digest().subarray(0, 8);
const MIN_SQRT = 4295048016n, MAX_SQRT = 79226673515401279992447579055n;

function swapIx({ auth, userA, userB, arrays, oracle, amount, aToB }) {
  const b8 = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(Math.floor(v))); return b; };
  const lim = aToB ? MIN_SQRT : MAX_SQRT;
  const b16 = Buffer.alloc(16);
  b16.writeBigUInt64LE(lim & 0xffffffffffffffffn, 0); b16.writeBigUInt64LE(lim >> 64n, 8);
  return new TransactionInstruction({ programId: WP,
    data: Buffer.concat([disc("swap"), b8(amount), b8(0), b16, Buffer.from([1]), Buffer.from([aToB ? 1 : 0])]),
    keys: [
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: auth, isSigner: true, isWritable: false },
      { pubkey: POOL, isSigner: false, isWritable: true },
      { pubkey: userA, isSigner: false, isWritable: true },
      { pubkey: VA, isSigner: false, isWritable: true },
      { pubkey: userB, isSigner: false, isWritable: true },
      { pubkey: VB, isSigner: false, isWritable: true },
      { pubkey: arrays[0], isSigner: false, isWritable: true },
      { pubkey: arrays[1], isSigner: false, isWritable: true },
      { pubkey: arrays[2], isSigner: false, isWritable: true },
      { pubkey: oracle, isSigner: false, isWritable: false },
    ]});
}

(async () => {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(path.resolve(os.homedir(), ".config/solana/id.json"), "utf8"))));
  const c = new Connection(RPC, { commitment: "confirmed" });
  const provider = new anchor.AnchorProvider(c, new anchor.Wallet(admin), { commitment: "confirmed" });
  const program = new anchor.Program(JSON.parse(fs.readFileSync("idl_p2.json", "utf8")), provider);

  // Need a very large WSOL balance: moving a pool holding ~8e14 liquidity even a dozen
  // ticks takes tens of thousands of SOL. The validator will airdrop as much as we ask.
  for (let i = 0; i < 900; i++) {
    if ((await c.getBalance(admin.publicKey)) > 400000e9) break;
    try { await c.confirmTransaction(await c.requestAirdrop(admin.publicKey, 500e9), "confirmed"); } catch { break; }
  }
  console.log("admin SOL:", ((await c.getBalance(admin.publicKey)) / 1e9).toFixed(0));

  const t0 = (await c.getAccountInfo(POOL)).data.readInt32LE(81);
  const align = t => Math.round(t / 4) * 4;
  // Deliberately NARROW so a swap can push price clean through it.
  const LOW = align(t0 - 12), UP = align(t0 + 12);
  console.log(`start tick ${t0} | narrow range ${LOW}..${UP}`);

  const [lpVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_vault"), SOL.toBuffer(), USDC.toBuffer(), admin.publicKey.toBuffer()], PROGRAM_ID);
  const [vAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_vault_authority"), lpVault.toBuffer()], PROGRAM_ID);
  const pMint = Keypair.generate(), sMint = Keypair.generate();
  const [position] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), pMint.publicKey.toBuffer()], WP);
  const pAcct = getAssociatedTokenAddressSync(pMint.publicKey, vAuth, true);
  const vaultA = getAssociatedTokenAddressSync(SOL, vAuth, true);
  const vaultB = getAssociatedTokenAddressSync(USDC, vAuth, true);
  const taL = taPda(aS(LOW)), taU = taPda(aS(UP));
  const [oracle] = PublicKey.findProgramAddressSync([Buffer.from("oracle"), POOL.toBuffer()], WP);

  await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({
    fromPubkey: admin.publicKey, toPubkey: vAuth, lamports: 0.4 * 1e9 })), []);

  const ix = await program.methods.initializeOrcaLpVault({
      keeper: admin.publicKey, treasury: admin.publicKey,
      tickLowerIndex: LOW, tickUpperIndex: UP,
      tickArrayLowerStartIndex: 0, tickArrayUpperStartIndex: 0, name: "ONESIDE TEST",
    }).accounts({
      admin: admin.publicKey, lpVault, vaultAuthority: vAuth, tokenAMint: SOL, tokenBMint: USDC,
      vaultTokenAAccount: vaultA, vaultTokenBAccount: vaultB, lpSharesMint: sMint.publicKey,
      position, positionMint: pMint.publicKey, positionTokenAccount: pAcct,
      whirlpool: POOL, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      whirlpoolProgram: WP,
    }).instruction();
  const pm = ix.keys.find(k => k.pubkey.equals(pMint.publicKey)); if (pm) pm.isSigner = true;
  await provider.sendAndConfirm(new Transaction().add(ix), [pMint, sMint], { commitment: "confirmed" });

  const userW = getAssociatedTokenAddressSync(SOL, admin.publicKey);
  const userU = getAssociatedTokenAddressSync(USDC, admin.publicKey);
  const userS = getAssociatedTokenAddressSync(sMint.publicKey, admin.publicKey);
  const prep = new Transaction();
  if (!(await c.getAccountInfo(userW)))
    prep.add(createAssociatedTokenAccountInstruction(admin.publicKey, userW, admin.publicKey, SOL));
  prep.add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: userW, lamports: 300000 * 1e9 }));
  prep.add(createSyncNativeInstruction(userW));
  prep.add(createAssociatedTokenAccountInstruction(admin.publicKey, userS, admin.publicKey, sMint.publicKey));
  await provider.sendAndConfirm(prep, []);

  const [userPos] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_position"), lpVault.toBuffer(), admin.publicKey.toBuffer()], PROGRAM_ID);
  await program.methods.depositOrcaLp(new anchor.BN(20_000_000_000_000), new anchor.BN(1200*1e9), new anchor.BN(45_000*1e6), true)
    .accounts({ user: admin.publicKey, lpVault, vaultAuthority: vAuth, userPosition: userPos,
      userTokenAAccount: userW, userTokenBAccount: userU, userSharesAccount: userS,
      vaultTokenAAccount: vaultA, vaultTokenBAccount: vaultB, lpSharesMint: sMint.publicKey,
      whirlpool: POOL, position, positionTokenAccount: pAcct, tokenVaultA: VA, tokenVaultB: VB,
      tickArrayLower: taL, tickArrayUpper: taU, tokenProgram: TOKEN_PROGRAM_ID,
      whirlpoolProgram: WP, systemProgram: SystemProgram.programId }).rpc({ commitment: "confirmed" });
  console.log("deposited into the narrow range");

  // ── push the price clean OUT of the range, one direction only ──────────────
  const cur = aS(t0);
  // Push DOWN by selling WSOL. The local validator airdrops unlimited SOL, whereas the
  // crafted USDC account is capped at 50k -- nowhere near enough to move a pool holding
  // ~8e14 liquidity. Price falling THROUGH the range leaves the position 100% token A.
  const down = [cur, cur - SPAN, cur - 2 * SPAN].map(taPda);
  let tick = t0;
  for (let i = 0; i < 40 && tick >= LOW; i++) {
    try {
      await provider.sendAndConfirm(new Transaction().add(swapIx({
        auth: admin.publicKey, userA: userW, userB: userU, arrays: down, oracle,
        // ~2262 SOL moves this pool 15 ticks (L=8.26e14). 600 SOL is ~4 ticks per swap:
        // small enough to stay inside the cloned tick arrays — a swap that would cross
        // beyond them fails outright, which is what a 20000 SOL swap did.
        amount: 600 * 1e9, aToB: true })), [], { commitment: "confirmed" });
    } catch (e) { console.log("  swap stopped at tick " + tick + ":", String(e.message||"").slice(0,70)); break; }
    tick = (await c.getAccountInfo(POOL)).data.readInt32LE(81);
    if (i % 5 === 0) console.log("    tick now", tick);
  }
  console.log(`tick pushed to ${tick} | range was ${LOW}..${UP} | OUT OF RANGE: ${tick > UP || tick < LOW}`);
  if (tick <= UP && tick >= LOW) { console.log("\nCOULD NOT push price out of range — test inconclusive"); return; }

  // ── exit and measure what we are actually left holding ────────────────────
  await program.methods.exitOrcaLpPosition().accounts({
    keeper: admin.publicKey, lpVault, vaultAuthority: vAuth,
    vaultTokenAAccount: vaultA, vaultTokenBAccount: vaultB,
    whirlpool: POOL, position, positionMint: pMint.publicKey, positionTokenAccount: pAcct,
    tokenVaultA: VA, tokenVaultB: VB, tickArrayLower: taL, tickArrayUpper: taU,
    tokenProgram: TOKEN_PROGRAM_ID, whirlpoolProgram: WP }).rpc({ commitment: "confirmed" });

  const a = Number((await c.getTokenAccountBalance(vaultA)).value.amount);
  const b = Number((await c.getTokenAccountBalance(vaultB)).value.amount);
  const price = Math.pow(1.0001, tick);
  const shareA = (a + b / price) > 0 ? a / (a + b / price) : 0;
  console.log(`\npost-exit holdings: ${(a/1e9).toFixed(4)} WSOL / ${(b/1e6).toFixed(2)} USDC`);
  console.log(`shareA = ${(shareA*100).toFixed(2)}%`);
  console.log(shareA >= 0.95 || shareA <= 0.05
    ? "=> ONE-SIDED confirmed. A centred range cannot be funded from this — PR #135 is justified."
    : "=> still mixed. The one-sided premise does NOT hold here.");
})().catch(e => { console.error("FATAL:", e.message); if (e.logs) console.error(e.logs.slice(-12).join("\n")); process.exit(1); });
