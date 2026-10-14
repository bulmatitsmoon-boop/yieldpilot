// Real end-to-end test of the Orca LP vault's deposit_orca_lp / withdraw_orca_lp on the
// NEW program -- these have never been exercised since the 2026-10-13 close-and-redeploy
// (the vault was only initialized, never deposited into). Mirrors useLpVault.ts's real,
// already-proven account-building logic as closely as possible rather than reinventing it.
const anchor = require("@coral-xyz/anchor");
const {
  Connection, PublicKey, Keypair, Transaction, TransactionMessage, VersionedTransaction,
  AddressLookupTableAccount, ComputeBudgetProgram, SystemProgram,
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddress, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, NATIVE_MINT,
} = require("@solana/spl-token");
const fs = require("fs");

const PROGRAM_ID = new PublicKey("D9YJR8fvGLRSVfX82fpextgS9T7fT2QLm5Esnro6Yjmx");
const WHIRLPOOL_PROGRAM_ID = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const LP_VAULT = new PublicKey("99w4cTCrjgwveLwYWBMWNsV9waEookwxbb8Mn5oKo8LF");
const RPC = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
const ALT_ADDR = new PublicKey("5Hyve3RBPNAk8F4ZYTo2TdedzN33izGZ5Q8L4Vk3V7rF");

function readU128LE(data, offset) {
  const low = data.readBigUInt64LE(offset);
  const high = data.readBigUInt64LE(offset + 8);
  return (high << 64n) | low;
}
function decodeWhirlpool(data) {
  return {
    tickSpacing: data.readUInt16LE(41),
    sqrtPrice: readU128LE(data, 65),
    tickCurrent: data.readInt32LE(81),
    tokenMintA: new PublicKey(data.subarray(101, 133)),
    tokenVaultA: new PublicKey(data.subarray(133, 165)),
    tokenMintB: new PublicKey(data.subarray(181, 213)),
    tokenVaultB: new PublicKey(data.subarray(213, 245)),
  };
}
const TICK_ARRAY_SEED = "tick_array";
const TICKS_PER_ARRAY = 88;
function getStartTickIndex(tickIndex, tickSpacing) {
  const ticksInArray = tickSpacing * TICKS_PER_ARRAY;
  return Math.floor(tickIndex / ticksInArray) * ticksInArray;
}
function getTickArrayPda(whirlpool, tickIndex, tickSpacing) {
  const startTickIndex = getStartTickIndex(tickIndex, tickSpacing);
  const [address] = PublicKey.findProgramAddressSync(
    [Buffer.from(TICK_ARRAY_SEED), whirlpool.toBuffer(), Buffer.from(startTickIndex.toString())],
    WHIRLPOOL_PROGRAM_ID
  );
  return address;
}

async function ensureAtaAndWrapIfNativeIxs(connection, payer, mint, requiredLamports) {
  const ata = await getAssociatedTokenAddress(mint, payer);
  const ixs = [createAssociatedTokenAccountIdempotentInstruction(payer, ata, payer, mint)];
  if (!mint.equals(NATIVE_MINT)) return ixs;
  let currentBalance = 0n;
  try {
    const bal = await connection.getTokenAccountBalance(ata);
    currentBalance = BigInt(bal.value.amount);
  } catch {}
  const required = BigInt(requiredLamports.toString());
  if (required > currentBalance) {
    const topUp = required - currentBalance;
    ixs.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: ata, lamports: Number(topUp) }));
    ixs.push(createSyncNativeInstruction(ata));
  }
  return ixs;
}

async function sendLpV0(connection, signer, instructions, computeUnits = 600000) {
  const fetched = await connection.getAddressLookupTable(ALT_ADDR);
  const lookupTables = fetched.value ? [fetched.value] : [];
  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }), ...instructions],
  }).compileToV0Message(lookupTables);
  const tx = new VersionedTransaction(msg);
  tx.sign([signer]);
  const size = tx.serialize().length;
  console.log("  tx size:", size, "bytes");
  const sig = await connection.sendTransaction(tx, { skipPreflight: false });
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

(async () => {
  const connection = new Connection(RPC, "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.argv[2], "utf8"))));
  console.log("Signer:", admin.publicKey.toBase58());

  const EXPECTED_ADMIN = "yaZDx7cKF8WqJyaVQJDhiTgi1UEB6rgjSpg5sW4GpD7";
  if (admin.publicKey.toBase58() !== EXPECTED_ADMIN) {
    console.error("ABORT: signer is not the expected admin wallet.");
    process.exit(1);
  }

  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const IDL = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  IDL.address = PROGRAM_ID.toBase58();
  const program = new anchor.Program(IDL, provider);

  const { increaseLiquidityQuoteA, decreaseLiquidityQuote } = await import("@orca-so/whirlpools-core");

  const raw = await program.account.lpVault.fetch(LP_VAULT);
  const whirlpoolPubkey = raw.pool;
  const whirlpoolAccountInfo = await connection.getAccountInfo(whirlpoolPubkey);
  const whirlpoolInfo = decodeWhirlpool(whirlpoolAccountInfo.data);
  console.log("Whirlpool:", whirlpoolPubkey.toBase58(), "tickSpacing:", whirlpoolInfo.tickSpacing);

  const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_vault_authority"), LP_VAULT.toBuffer()], PROGRAM_ID
  );
  const [positionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_position"), LP_VAULT.toBuffer(), admin.publicKey.toBuffer()], PROGRAM_ID
  );

  const tokenAMint = raw.tokenAMint, tokenBMint = raw.tokenBMint, sharesMint = raw.lpSharesMint;
  const vaultTokenAAccount = raw.vaultTokenAAccount, vaultTokenBAccount = raw.vaultTokenBAccount;
  const position = raw.position, positionTokenAccount = raw.positionTokenAccount;
  const tickLowerIndex = raw.tickLowerIndex, tickUpperIndex = raw.tickUpperIndex;
  const tickArrayLower = getTickArrayPda(whirlpoolPubkey, tickLowerIndex, whirlpoolInfo.tickSpacing);
  const tickArrayUpper = getTickArrayPda(whirlpoolPubkey, tickUpperIndex, whirlpoolInfo.tickSpacing);

  const userTokenAAccount = await getAssociatedTokenAddress(tokenAMint, admin.publicKey);
  const userTokenBAccount = await getAssociatedTokenAddress(tokenBMint, admin.publicKey);
  const userSharesAccount = await getAssociatedTokenAddress(sharesMint, admin.publicKey);

  console.log("\n===== DEPOSIT =====");
  // Tiny real test size: 0.5 USDC worth of token A.
  const isAUsdc = tokenAMint.toBase58() === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const tokenAAmount = new anchor.BN(isAUsdc ? 500000 : 5000000); // 0.5 USDC or 0.005 SOL depending on side
  const quote = increaseLiquidityQuoteA(
    BigInt(tokenAAmount.toString()), 100, whirlpoolInfo.sqrtPrice, tickLowerIndex, tickUpperIndex
  );
  console.log("quote liquidityDelta:", quote.liquidityDelta.toString(), "tokenMaxA:", quote.tokenMaxA.toString(), "tokenMaxB:", quote.tokenMaxB.toString());

  const liquidityAmount = new anchor.BN(quote.liquidityDelta.toString());
  const tokenMaxA = new anchor.BN(quote.tokenMaxA.toString());
  const tokenMaxB = new anchor.BN(quote.tokenMaxB.toString());

  const depositPreIxs = [
    ...(await ensureAtaAndWrapIfNativeIxs(connection, admin.publicKey, tokenAMint, tokenMaxA)),
    ...(await ensureAtaAndWrapIfNativeIxs(connection, admin.publicKey, tokenBMint, tokenMaxB)),
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, userSharesAccount, admin.publicKey, sharesMint),
  ];

  const depositIx = await program.methods
    .depositOrcaLp(liquidityAmount, tokenMaxA, tokenMaxB, true)
    .accountsPartial({
      user: admin.publicKey, lpVault: LP_VAULT, vaultAuthority: vaultAuthorityPda,
      userPosition: positionPda, userTokenAAccount, userTokenBAccount, userSharesAccount,
      vaultTokenAAccount, vaultTokenBAccount, lpSharesMint: sharesMint,
      whirlpool: whirlpoolPubkey, position, positionTokenAccount,
      tokenVaultA: whirlpoolInfo.tokenVaultA, tokenVaultB: whirlpoolInfo.tokenVaultB,
      tickArrayLower, tickArrayUpper, tokenProgram: TOKEN_PROGRAM_ID,
      whirlpoolProgram: WHIRLPOOL_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .instruction();

  const depositSig = await sendLpV0(connection, admin, [...depositPreIxs, depositIx]);
  console.log("DEPOSIT SUCCESS:", depositSig);

  console.log("\n===== VERIFY POSITION =====");
  const pos = await program.account.lpUserPosition.fetch(positionPda);
  console.log("shares after deposit:", pos.shares.toString());

  console.log("\n===== WITHDRAW (full) =====");
  const vaultAfterDeposit = await program.account.lpVault.fetch(LP_VAULT);
  const totalLiquidity = BigInt(vaultAfterDeposit.totalLiquidity.toString());
  const totalShares = BigInt(vaultAfterDeposit.totalShares.toString());
  const shares = pos.shares;
  const liquidityDelta = (BigInt(shares.toString()) * totalLiquidity) / totalShares;
  const wQuote = decreaseLiquidityQuote(liquidityDelta, 100, whirlpoolInfo.sqrtPrice, tickLowerIndex, tickUpperIndex);
  console.log("withdraw quote tokenMinA:", wQuote.tokenMinA.toString(), "tokenMinB:", wQuote.tokenMinB.toString());

  const tokenMinA = new anchor.BN(wQuote.tokenMinA.toString());
  const tokenMinB = new anchor.BN(wQuote.tokenMinB.toString());
  const zero = new anchor.BN(0);
  const withdrawPreIxs = [
    ...(await ensureAtaAndWrapIfNativeIxs(connection, admin.publicKey, tokenAMint, zero)),
    ...(await ensureAtaAndWrapIfNativeIxs(connection, admin.publicKey, tokenBMint, zero)),
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, userSharesAccount, admin.publicKey, sharesMint),
  ];

  const withdrawIx = await program.methods
    .withdrawOrcaLp(shares, tokenMinA, tokenMinB)
    .accountsPartial({
      user: admin.publicKey, lpVault: LP_VAULT, vaultAuthority: vaultAuthorityPda,
      userPosition: positionPda, userTokenAAccount, userTokenBAccount, userSharesAccount,
      vaultTokenAAccount, vaultTokenBAccount, lpSharesMint: sharesMint,
      whirlpool: whirlpoolPubkey, position, positionTokenAccount,
      tokenVaultA: whirlpoolInfo.tokenVaultA, tokenVaultB: whirlpoolInfo.tokenVaultB,
      tickArrayLower, tickArrayUpper, tokenProgram: TOKEN_PROGRAM_ID,
      whirlpoolProgram: WHIRLPOOL_PROGRAM_ID,
    })
    .instruction();

  const withdrawSig = await sendLpV0(connection, admin, [...withdrawPreIxs, withdrawIx]);
  console.log("WITHDRAW SUCCESS:", withdrawSig);

  console.log("\n===== FINAL CHECK =====");
  const posAfter = await program.account.lpUserPosition.fetch(positionPda).catch(() => null);
  console.log("shares after withdraw:", posAfter ? posAfter.shares.toString() : "(position closed/0)");
})().catch(e => { console.error("FAILED:", e); process.exit(1); });
