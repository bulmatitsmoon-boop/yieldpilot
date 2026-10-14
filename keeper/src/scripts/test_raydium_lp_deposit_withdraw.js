// Real end-to-end test of deposit_raydium_lp / withdraw_raydium_lp on the NEW program --
// never exercised since the Raydium LP vault was (re)initialized. Mirrors useLpVault.ts's
// real, already-fixed account-building logic for Raydium as closely as possible.
const anchor = require("@coral-xyz/anchor");
const {
  Connection, PublicKey, Keypair, TransactionMessage, VersionedTransaction,
  ComputeBudgetProgram, SystemProgram,
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddress, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, NATIVE_MINT,
} = require("@solana/spl-token");
const fs = require("fs");

const PROGRAM_ID = new PublicKey("D9YJR8fvGLRSVfX82fpextgS9T7fT2QLm5Esnro6Yjmx");
const RAYDIUM_CLMM_PROGRAM_ID = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const LP_VAULT = new PublicKey("FxmqpUQWJ5oKXKkpRCrat33LkLx3GFbMnVDqbeRk6b44");
const TREASURY = new PublicKey("CiZb5cLMT6T8Spb4NspPCMgF5yNrZo5nxXimkJYPvnDA");
const RPC = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
const ALT_ADDR = new PublicKey("5Hyve3RBPNAk8F4ZYTo2TdedzN33izGZ5Q8L4Vk3V7rF");

function readU128LE(data, offset) {
  const low = data.readBigUInt64LE(offset);
  const high = data.readBigUInt64LE(offset + 8);
  return (high << 64n) | low;
}
function decodeRaydiumPool(data) {
  return {
    tokenMintA: new PublicKey(data.subarray(73, 105)),
    tokenMintB: new PublicKey(data.subarray(105, 137)),
    tokenVaultA: new PublicKey(data.subarray(137, 169)),
    tokenVaultB: new PublicKey(data.subarray(169, 201)),
    tickSpacing: data.readUInt16LE(235),
    sqrtPriceX64: readU128LE(data, 253),
    tickCurrent: data.readInt32LE(269),
  };
}
function readRaydiumRewards(poolData) {
  const b = Buffer.from(poolData);
  const BASE = 397, STRIDE = 169, STATE = 0, MINT = 57, VAULT = 89;
  const out = [];
  for (let i = 0; i < 3; i++) {
    const o = BASE + i * STRIDE;
    if (o + STRIDE > b.length) break;
    if (b[o + STATE] === 0) continue;
    out.push({ mint: new PublicKey(b.subarray(o + MINT, o + MINT + 32)), vault: new PublicKey(b.subarray(o + VAULT, o + VAULT + 32)) });
  }
  return out;
}
const RAYDIUM_TICK_ARRAY_SEED = "tick_array";
const RAYDIUM_TICKS_PER_ARRAY = 60;
function i32ToBeBytes(n) {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(n, 0);
  return buf;
}
function getRaydiumTickArrayStartIndex(tickIndex, tickSpacing) {
  const ticksInArray = tickSpacing * RAYDIUM_TICKS_PER_ARRAY;
  return Math.floor(tickIndex / ticksInArray) * ticksInArray;
}
function getRaydiumTickArrayPda(poolState, tickIndex, tickSpacing) {
  const startTickIndex = getRaydiumTickArrayStartIndex(tickIndex, tickSpacing);
  const [address] = PublicKey.findProgramAddressSync(
    [Buffer.from(RAYDIUM_TICK_ARRAY_SEED), poolState.toBuffer(), i32ToBeBytes(startTickIndex)],
    RAYDIUM_CLMM_PROGRAM_ID
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

  const { LiquidityMathUtil, TickUtil } = await import("@raydium-io/raydium-sdk-v2");

  const raw = await program.account.lpVault.fetch(LP_VAULT);
  const poolStatePubkey = raw.pool;
  const poolAccountInfo = await connection.getAccountInfo(poolStatePubkey);
  const poolInfo = decodeRaydiumPool(poolAccountInfo.data);
  console.log("Raydium pool:", poolStatePubkey.toBase58(), "tickSpacing:", poolInfo.tickSpacing);

  const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_vault_authority"), LP_VAULT.toBuffer()], PROGRAM_ID
  );
  const [positionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_position"), LP_VAULT.toBuffer(), admin.publicKey.toBuffer()], PROGRAM_ID
  );

  const tokenAMint = raw.tokenAMint, tokenBMint = raw.tokenBMint, sharesMint = raw.lpSharesMint;
  const vaultTokenAAccount = raw.vaultTokenAAccount, vaultTokenBAccount = raw.vaultTokenBAccount;
  const personalPosition = raw.position, protocolPosition = raw.protocolPosition, nftAccount = raw.positionTokenAccount;
  const tickLowerIndex = raw.tickLowerIndex, tickUpperIndex = raw.tickUpperIndex;
  const tickArrayLower = getRaydiumTickArrayPda(poolStatePubkey, tickLowerIndex, poolInfo.tickSpacing);
  const tickArrayUpper = getRaydiumTickArrayPda(poolStatePubkey, tickUpperIndex, poolInfo.tickSpacing);

  const userTokenAAccount = await getAssociatedTokenAddress(tokenAMint, admin.publicKey);
  const userTokenBAccount = await getAssociatedTokenAddress(tokenBMint, admin.publicKey);
  const userSharesAccount = await getAssociatedTokenAddress(sharesMint, admin.publicKey);

  console.log("\n===== DEPOSIT =====");
  const isAUsdc = tokenAMint.toBase58() === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const tokenAAmount = new anchor.BN(isAUsdc ? 500000 : 5000000);

  const BN = anchor.BN;
  const sqrtPriceCurrentX64 = new BN(poolInfo.sqrtPriceX64.toString());
  const sqrtPriceLowerX64 = TickUtil.getSqrtPriceAtTick(tickLowerIndex);
  const sqrtPriceUpperX64 = TickUtil.getSqrtPriceAtTick(tickUpperIndex);
  const hugeAmountB = new BN(2).pow(new BN(64)).subn(1);
  const liquidityDelta = LiquidityMathUtil.getLiquidityFromAmounts(
    sqrtPriceCurrentX64, sqrtPriceLowerX64, sqrtPriceUpperX64, tokenAAmount, hugeAmountB
  );
  const { amountSlippageA, amountSlippageB } = LiquidityMathUtil.getAmountsFromLiquidityWithSlippage(
    sqrtPriceCurrentX64, sqrtPriceLowerX64, sqrtPriceUpperX64, liquidityDelta, true, true, 0.01
  );
  const tokenMaxA = amountSlippageA, tokenMaxB = amountSlippageB;
  console.log("quote liquidityDelta:", liquidityDelta.toString(), "tokenMaxA:", tokenMaxA.toString(), "tokenMaxB:", tokenMaxB.toString());

  const depositPreIxs = [
    ...(await ensureAtaAndWrapIfNativeIxs(connection, admin.publicKey, tokenAMint, tokenMaxA)),
    ...(await ensureAtaAndWrapIfNativeIxs(connection, admin.publicKey, tokenBMint, tokenMaxB)),
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, userSharesAccount, admin.publicKey, sharesMint),
  ];

  const depositIx = await program.methods
    .depositRaydiumLp(liquidityDelta, tokenMaxA, tokenMaxB, true)
    .accountsPartial({
      user: admin.publicKey, lpVault: LP_VAULT, vaultAuthority: vaultAuthorityPda,
      userPosition: positionPda, userTokenAAccount, userTokenBAccount, userSharesAccount,
      vaultTokenAAccount, vaultTokenBAccount, lpSharesMint: sharesMint,
      nftAccount, poolState: poolStatePubkey, protocolPosition, personalPosition,
      tickArrayLower, tickArrayUpper,
      tokenVault0: poolInfo.tokenVaultA, tokenVault1: poolInfo.tokenVaultB,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      raydiumProgram: RAYDIUM_CLMM_PROGRAM_ID,
      userGateAccount: null,
    })
    .instruction();

  const depositSig = await sendLpV0(connection, admin, [...depositPreIxs, depositIx]);
  console.log("DEPOSIT SUCCESS:", depositSig);

  console.log("\n===== VERIFY POSITION =====");
  const pos = await program.account.lpUserPosition.fetch(positionPda);
  console.log("shares after deposit:", pos.shares.toString());

  console.log("\n===== WITHDRAW (full) =====");
  const vaultAfterDeposit = await program.account.lpVault.fetch(LP_VAULT);
  const totalLiquidity = vaultAfterDeposit.totalLiquidity;
  const totalShares = vaultAfterDeposit.totalShares;
  const shares = pos.shares;
  const wLiquidityDelta = shares.mul(totalLiquidity).div(totalShares);
  const w = LiquidityMathUtil.getAmountsFromLiquidityWithSlippage(
    sqrtPriceCurrentX64, sqrtPriceLowerX64, sqrtPriceUpperX64, wLiquidityDelta, false, false, 0.01
  );
  const tokenMinA = w.amountSlippageA, tokenMinB = w.amountSlippageB;
  console.log("withdraw tokenMinA:", tokenMinA.toString(), "tokenMinB:", tokenMinB.toString());

  const treasuryTokenAAccount = await getAssociatedTokenAddress(tokenAMint, TREASURY);
  const treasuryTokenBAccount = await getAssociatedTokenAddress(tokenBMint, TREASURY);

  const poolAcct2 = await connection.getAccountInfo(poolStatePubkey);
  const rewards = poolAcct2 ? readRaydiumRewards(poolAcct2.data) : [];
  const rewardRemaining = [];
  const rewardPreIxs = [];
  for (const r of rewards) {
    const recipient = await getAssociatedTokenAddress(r.mint, vaultAuthorityPda, true);
    rewardPreIxs.push(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, recipient, vaultAuthorityPda, r.mint));
    rewardRemaining.push({ pubkey: r.vault, isSigner: false, isWritable: true });
    rewardRemaining.push({ pubkey: recipient, isSigner: false, isWritable: true });
  }
  console.log("initialized rewards:", rewards.length);

  const withdrawPreIxs = [
    ...(await ensureAtaAndWrapIfNativeIxs(connection, admin.publicKey, tokenAMint, new anchor.BN(0))),
    ...(await ensureAtaAndWrapIfNativeIxs(connection, admin.publicKey, tokenBMint, new anchor.BN(0))),
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, userSharesAccount, admin.publicKey, sharesMint),
    ...rewardPreIxs,
  ];

  const withdrawIx = await program.methods
    .withdrawRaydiumLp(shares, tokenMinA, tokenMinB)
    .accountsPartial({
      user: admin.publicKey, lpVault: LP_VAULT, vaultAuthority: vaultAuthorityPda,
      userPosition: positionPda, userTokenAAccount, userTokenBAccount, userSharesAccount,
      vaultTokenAAccount, vaultTokenBAccount, lpSharesMint: sharesMint,
      nftAccount, poolState: poolStatePubkey, protocolPosition, personalPosition,
      tickArrayLower, tickArrayUpper,
      tokenVault0: poolInfo.tokenVaultA, tokenVault1: poolInfo.tokenVaultB,
      tokenProgram: TOKEN_PROGRAM_ID, raydiumProgram: RAYDIUM_CLMM_PROGRAM_ID,
      userGateAccount: null, treasuryTokenAAccount, treasuryTokenBAccount,
    })
    .remainingAccounts(rewardRemaining)
    .instruction();

  const withdrawSig = await sendLpV0(connection, admin, [...withdrawPreIxs, withdrawIx]);
  console.log("WITHDRAW SUCCESS:", withdrawSig);

  console.log("\n===== FINAL CHECK =====");
  const posAfter = await program.account.lpUserPosition.fetch(positionPda).catch(() => null);
  console.log("shares after withdraw:", posAfter ? posAfter.shares.toString() : "(position closed/0)");
})().catch(e => { console.error("FAILED:", e); process.exit(1); });
