"use client";

/**
 * useLpVault.ts — frontend hook for the opt-in, dual-asset Orca Whirlpool
 * LP vault (Phase 2 groundwork, not linked from any nav/page yet).
 *
 * IMPORTANT: this hook targets instructions (initialize_orca_lp_vault,
 * deposit_orca_lp, withdraw_orca_lp, etc.) that exist in lp_vault.rs but are
 * NOT YET DEPLOYED —
 * the committed mainnet IDL (@/idl/yieldpilot.mainnet.json) won't include
 * them until that program upgrade happens. This hook will not actually work
 * against the live program yet; it's written correctly against the PR's
 * Rust source so it's ready the moment the real IDL catches up.
 *
 * Mirrors useYieldPilot.ts's conventions (getProgram/wrapTx pattern) so it
 * feels consistent once wired into a real page.
 */
import { useCallback, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  Connection,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Transaction,
  AccountMeta,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getMint,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  NATIVE_MINT,
} from "@solana/spl-token";
import IDL from "@/idl/yieldpilot.mainnet.json";

// Real Orca quote math (WASM) — NOT hand-rolled. Concentrated-liquidity
// (Uniswap-V3-style) math is exactly the kind of thing where a subtle
// fixed-point rounding bug means real fund loss, not a loud failure, so we
// use Orca's own official quote functions (same Rust core the on-chain
// program is built from) rather than reimplementing sqrt-price math here.
//
// BUILD-VERIFIED (2026-07-09, standalone Next.js 14.2.3 test project, same
// versions/tsconfig as this repo): a STATIC top-level import of this
// package broke `npm run build` — Next.js's app-router prerender step tries
// to server-render "use client" components too, and the WASM binary isn't
// resolvable in the server bundle's output path (ENOENT during static
// generation). Fixed by dynamically importing it only inside the function
// that uses it, so it never gets pulled into server-side prerendering — a
// clean `npm run build` was confirmed after that fix. Type-only imports are
// erased at compile time and stay static safely (see below).
import type { IncreaseLiquidityQuote, DecreaseLiquidityQuote } from "@orca-so/whirlpools-core";

/**
 * Raydium CLMM pool reward slots.
 *
 * Layout is from Raydium's ON-CHAIN IDL, not guesswork: PoolState.reward_infos at
 * offset 397, 169-byte stride; within each RewardInfo reward_state@0, token_mint@57,
 * token_vault@89. A slot counts as initialized whenever reward_state != 0 — "Ended"
 * still counts.
 *
 * decrease_liquidity (withdraw AND exit) collects rewards in the same instruction and
 * validates remaining_accounts.len() == initialized_rewards * 2, failing
 * InvalidRewardInputAccountNumber (6030) otherwise.
 */
export function readRaydiumRewards(poolData: Buffer | Uint8Array): { mint: PublicKey; vault: PublicKey }[] {
  const b = Buffer.from(poolData);
  const BASE = 397, STRIDE = 169, STATE = 0, MINT = 57, VAULT = 89;
  const out: { mint: PublicKey; vault: PublicKey }[] = [];
  for (let i = 0; i < 3; i++) {
    const o = BASE + i * STRIDE;
    if (o + STRIDE > b.length) break;
    if (b[o + STATE] === 0) continue;
    out.push({
      mint: new PublicKey(b.subarray(o + MINT, o + MINT + 32)),
      vault: new PublicKey(b.subarray(o + VAULT, o + VAULT + 32)),
    });
  }
  return out;
}

/**
 * Send instructions as a VERSIONED (v0) transaction through the Address Lookup Table.
 *
 * Raydium LP instructions do not fit a legacy transaction — initialize_raydium_lp_vault
 * is 1245 bytes against the 1232 limit once the required compute-budget instruction is
 * added, and dropping that instruction makes it run out of compute inside Metaplex
 * instead. With an ALT the same transaction is 878 bytes (measured on the local harness).
 *
 * Set NEXT_PUBLIC_LP_ADDRESS_LOOKUP_TABLE to the published table.
 */
export async function sendLpV0(
  connection: Connection,
  wallet: {
    publicKey: PublicKey;
    signTransaction: <T extends Transaction | VersionedTransaction>(tx: T) => Promise<T>;
  },
  instructions: TransactionInstruction[],
  computeUnits = 600_000
): Promise<string> {
  const lookupTables: AddressLookupTableAccount[] = [];
  const altAddr = process.env.NEXT_PUBLIC_LP_ADDRESS_LOOKUP_TABLE;
  if (altAddr) {
    const fetched = await connection.getAddressLookupTable(new PublicKey(altAddr));
    if (fetched.value) lookupTables.push(fetched.value);
  }

  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
      ...instructions,
    ],
  }).compileToV0Message(lookupTables);

  const tx = new VersionedTransaction(msg);
  const signed = await wallet.signTransaction(tx);
  const size = signed.serialize().length;
  if (size > 1232) {
    throw new Error(
      `Transaction is ${size} bytes, over the 1232 limit. ` +
      `Set NEXT_PUBLIC_LP_ADDRESS_LOOKUP_TABLE to a published lookup table.`
    );
  }
  const sig = await connection.sendTransaction(signed);
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}


const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID || "CVJrJGoKjseTJqiFGctssYde3pLAnPaRZtjAaKXd8pWk"
);
const WHIRLPOOL_PROGRAM_ID = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const RAYDIUM_CLMM_PROGRAM_ID = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");

// ── Whirlpool account decoding ──────────────────────────────────────────────
// Manual byte-offset decode (not a generic Anchor client for Orca's program,
// to avoid pulling in the whole @orca-so/whirlpools-sdk just to read one
// account). Offsets verified against Orca's real source
// (programs/whirlpool/src/state/whirlpool.rs), 2026-07-08.
interface WhirlpoolInfo {
  tickSpacing: number;
  sqrtPrice: bigint;
  tokenMintA: PublicKey;
  tokenVaultA: PublicKey;
  tokenMintB: PublicKey;
  tokenVaultB: PublicKey;
}

function readU128LE(data: Buffer, offset: number): bigint {
  const low = data.readBigUInt64LE(offset);
  const high = data.readBigUInt64LE(offset + 8);
  return (high << 64n) | low;
}

function decodeWhirlpool(data: Buffer): WhirlpoolInfo {
  return {
    tickSpacing: data.readUInt16LE(41),
    sqrtPrice: readU128LE(data, 65),
    tokenMintA: new PublicKey(data.subarray(101, 133)),
    tokenVaultA: new PublicKey(data.subarray(133, 165)),
    tokenMintB: new PublicKey(data.subarray(181, 213)),
    tokenVaultB: new PublicKey(data.subarray(213, 245)),
  };
}

// ── Tick-array PDA derivation ──────────────────────────────────────────────
// Same verified logic as keeper/src/lpVaultHelpers.ts — duplicated here
// (rather than shared) since the app and keeper are separate packages with
// no shared internal library today. Keep both in sync if either changes.
const TICK_ARRAY_SEED = "tick_array";
const TICKS_PER_ARRAY = 88;

function getStartTickIndex(tickIndex: number, tickSpacing: number): number {
  const ticksInArray = tickSpacing * TICKS_PER_ARRAY;
  return Math.floor(tickIndex / ticksInArray) * ticksInArray;
}

function getTickArrayPda(whirlpool: PublicKey, tickIndex: number, tickSpacing: number): PublicKey {
  const startTickIndex = getStartTickIndex(tickIndex, tickSpacing);
  const [address] = PublicKey.findProgramAddressSync(
    [Buffer.from(TICK_ARRAY_SEED), whirlpool.toBuffer(), Buffer.from(startTickIndex.toString())],
    WHIRLPOOL_PROGRAM_ID
  );
  return address;
}

// ── Raydium CLMM pool decoding ──────────────��───────────────────────────────
// Manual byte-offset decode, same rationale as decodeWhirlpool above (avoid
// pulling in @raydium-io/raydium-sdk-v2's full PoolInfoLayout just to read
// one account). Offsets extracted directly from that package's own compiled
// layout.js (0.2.59-alpha) — PoolInfoLayout's field order is: 8-byte
// discriminator, bump(1), configId(32), creator(32), mintA(32), mintB(32),
// vaultA(32), vaultB(32), observationId(32), mintDecimalsA(1),
// mintDecimalsB(1), tickSpacing(2), liquidity(16), sqrtPriceX64(16),
// tickCurrent(4, signed) — matches the running total of offsets below.
interface RaydiumPoolInfo {
  tickSpacing: number;
  sqrtPriceX64: bigint;
  tickCurrent: number;
  tokenMintA: PublicKey;
  tokenVaultA: PublicKey;
  tokenMintB: PublicKey;
  tokenVaultB: PublicKey;
}

function decodeRaydiumPool(data: Buffer): RaydiumPoolInfo {
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

// ── Raydium PDA derivation ───────────────────────────────────────────────────
// IMPORTANT: Raydium encodes tick indices as BIG-ENDIAN bytes, unlike Orca's
// decimal-string encoding above — see adapters/raydium.rs's PDA seed notes
// (verified against raydium-io/raydium-clmm source). Getting this backwards
// silently derives the wrong address rather than failing loudly.
const RAYDIUM_TICK_ARRAY_SEED = "tick_array";
const RAYDIUM_POSITION_SEED = "position";
const RAYDIUM_TICKS_PER_ARRAY = 60; // TICK_ARRAY_SIZE, verified against @raydium-io/raydium-sdk-v2's constants.js

function i32ToBeBytes(n: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(n, 0);
  return buf;
}

function getRaydiumTickArrayStartIndex(tickIndex: number, tickSpacing: number): number {
  const ticksInArray = tickSpacing * RAYDIUM_TICKS_PER_ARRAY;
  return Math.floor(tickIndex / ticksInArray) * ticksInArray;
}

function getRaydiumTickArrayPda(poolState: PublicKey, tickIndex: number, tickSpacing: number): PublicKey {
  const startTickIndex = getRaydiumTickArrayStartIndex(tickIndex, tickSpacing);
  const [address] = PublicKey.findProgramAddressSync(
    [Buffer.from(RAYDIUM_TICK_ARRAY_SEED), poolState.toBuffer(), i32ToBeBytes(startTickIndex)],
    RAYDIUM_CLMM_PROGRAM_ID
  );
  return address;
}

function getRaydiumProtocolPositionPda(poolState: PublicKey, tickLowerIndex: number, tickUpperIndex: number): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [Buffer.from(RAYDIUM_POSITION_SEED), poolState.toBuffer(), i32ToBeBytes(tickLowerIndex), i32ToBeBytes(tickUpperIndex)],
    RAYDIUM_CLMM_PROGRAM_ID
  );
  return address;
}

export interface LpVaultInfo {
  address: string;
  name: string;
  protocol: "orca" | "raydium";
  tokenAMint: string;
  tokenADecimals: number;
  tokenBMint: string;
  tokenBDecimals: number;
  whirlpool: string;
  totalLiquidity: string; // u128 — kept as string, too large for safe JS number
  totalShares: number;
  positionActive: boolean;
  paused: boolean;
}

// ── Decimal <-> base-unit conversion ────────────────────────────────────────
// String-based (not floating-point multiplication) to avoid precision loss
// on amounts near the edge of JS's safe-integer/float range — a decimals
// bug here would silently over/under-scale a real deposit or withdrawal.

/** Parse a human decimal string (e.g. "12.5") into raw base units. */
export function parseDecimalToBaseUnits(input: string, decimals: number): anchor.BN {
  const trimmed = input.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    throw new Error(`Invalid decimal amount: "${input}"`);
  }
  const [wholePart, fracPart = ""] = trimmed.split(".");
  if (fracPart.length > decimals) {
    throw new Error(`Too many decimal places for this token (max ${decimals})`);
  }
  const paddedFrac = fracPart.padEnd(decimals, "0");
  const combined = (wholePart || "0") + paddedFrac;
  // Strip leading zeros (but keep at least one digit) before BN parsing.
  const normalized = combined.replace(/^0+(?=\d)/, "");
  return new anchor.BN(normalized);
}

/** Format raw base units into a human decimal string. */
export function formatBaseUnitsToDecimal(raw: bigint | string, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, "0");
  const wholePart = s.slice(0, s.length - decimals) || "0";
  const fracPart = decimals > 0 ? s.slice(s.length - decimals) : "";
  const trimmedFrac = fracPart.replace(/0+$/, "");
  return trimmedFrac ? `${wholePart}.${trimmedFrac}` : wholePart;
}

export interface LpUserPositionInfo {
  lpVault: string;
  shares: number;
  liquidityAtDeposit: string;
}

/**
 * Ensure a user's ATA for `mint` exists and, if `mint` is native SOL, holds at least
 * `requiredLamports` as WRAPPED SOL — LP deposits transfer via SPL token::transfer, which
 * needs an actual WSOL token account, not just a native SOL balance in the wallet.
 *
 * Confirmed live 2026-08-27: a wallet that has only ever held native SOL (i.e. every
 * wallet, by default — nobody wraps SOL until something asks them to) has no WSOL ATA at
 * all, so the very first LP deposit attempt failed simulation with AccountNotInitialized
 * on user_token_a_account. This existed on both the Orca and Raydium deposit paths, and
 * would have hit every real user's first deposit, not just this one.
 *
 * Returns the instructions to prepend to the deposit transaction — does not send anything
 * itself, so it composes into the same atomic transaction as the actual deposit (if the
 * deposit fails, the wrap never happened either, instead of leaving a stray WSOL balance
 * behind from a separate transaction).
 */
async function ensureAtaAndWrapIfNativeIxs(
  connection: Connection,
  payer: PublicKey,
  mint: PublicKey,
  requiredLamports: anchor.BN
): Promise<TransactionInstruction[]> {
  const ata = await getAssociatedTokenAddress(mint, payer);
  const ixs: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(payer, ata, payer, mint),
  ];
  if (!mint.equals(NATIVE_MINT)) return ixs;

  let currentBalance = 0n;
  try {
    const bal = await connection.getTokenAccountBalance(ata);
    currentBalance = BigInt(bal.value.amount);
  } catch {
    // Account doesn't exist yet — the idempotent create instruction above handles that;
    // currentBalance stays 0, so the full required amount gets wrapped below.
  }
  const required = BigInt(requiredLamports.toString());
  if (required > currentBalance) {
    const topUp = required - currentBalance;
    ixs.push(anchor.web3.SystemProgram.transfer({ fromPubkey: payer, toPubkey: ata, lamports: Number(topUp) }));
    ixs.push(createSyncNativeInstruction(ata));
  }
  return ixs;
}

/**
 * Real, current USD value of an LP vault's ENTIRE position — not per-user, the whole
 * vault. Used by the homepage / dashboard TVL stats so an LP deposit actually shows up
 * there (confirmed live 2026-08-27: it did not, because those stats only ever read the
 * safe-vault Vault/UserPosition types, never lpVault).
 *
 * Same principle as useFleetStats' zero-share guard: if totalShares is 0, nobody has a
 * claim on this vault, so its value is $0 for display purposes regardless of what
 * totalLiquidity still reads — an LP vault that's been fully exited should read as
 * empty, not as some leftover dust value.
 *
 * Uses each protocol's own official quote math (same as getWithdrawQuote /
 * getRaydiumWithdrawQuote) evaluated at the vault's full totalLiquidity, so this is a
 * real current-price valuation, not the historical deposit amount.
 */
export async function computeLpVaultValueUsd(
  connection: Connection,
  lpVaultAddress: string,
  solPrice: number
): Promise<number> {
  const provider = new anchor.AnchorProvider(
    connection,
    { publicKey: PublicKey.default, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any,
    { commitment: "confirmed" }
  );
  const program = new anchor.Program(IDL as any, provider);
  const raw: any = await (program.account as any)["lpVault"].fetch(new PublicKey(lpVaultAddress));

  if ((raw.totalShares as anchor.BN).isZero()) return 0;

  const tokenAMint = raw.tokenAMint as PublicKey;
  const tokenBMint = raw.tokenBMint as PublicKey;
  const [mintA, mintB] = await Promise.all([getMint(connection, tokenAMint), getMint(connection, tokenBMint)]);
  const isSolA = tokenAMint.equals(NATIVE_MINT);
  const isSolB = tokenBMint.equals(NATIVE_MINT);

  let rawA: bigint, rawB: bigint;

  if (raw.protocol && "raydium" in raw.protocol) {
    const poolInfoAccount = await connection.getAccountInfo(raw.pool as PublicKey);
    if (!poolInfoAccount) return 0;
    const poolInfo = decodeRaydiumPool(poolInfoAccount.data);
    const { LiquidityMathUtil, TickUtil } = await import("@raydium-io/raydium-sdk-v2");
    const sqrtPriceCurrentX64 = new anchor.BN(poolInfo.sqrtPriceX64.toString());
    const sqrtPriceLowerX64 = TickUtil.getSqrtPriceAtTick(raw.tickLowerIndex as number);
    const sqrtPriceUpperX64 = TickUtil.getSqrtPriceAtTick(raw.tickUpperIndex as number);
    const { amountSlippageA, amountSlippageB } = LiquidityMathUtil.getAmountsFromLiquidityWithSlippage(
      sqrtPriceCurrentX64, sqrtPriceLowerX64, sqrtPriceUpperX64, raw.totalLiquidity as anchor.BN, false, false, 0
    );
    rawA = BigInt(amountSlippageA.toString());
    rawB = BigInt(amountSlippageB.toString());
  } else {
    const whirlpoolAccount = await connection.getAccountInfo(raw.pool as PublicKey);
    if (!whirlpoolAccount) return 0;
    const whirlpoolInfo = decodeWhirlpool(whirlpoolAccount.data);
    const { decreaseLiquidityQuote } = await import("@orca-so/whirlpools-core");
    const quote = decreaseLiquidityQuote(
      BigInt((raw.totalLiquidity as anchor.BN).toString()),
      0,
      whirlpoolInfo.sqrtPrice,
      raw.tickLowerIndex as number,
      raw.tickUpperIndex as number
    );
    rawA = BigInt(quote.tokenEstA.toString());
    rawB = BigInt(quote.tokenEstB.toString());
  }

  const uiA = Number(rawA) / Math.pow(10, mintA.decimals);
  const uiB = Number(rawB) / Math.pow(10, mintB.decimals);
  const usdA = isSolA ? uiA * solPrice : uiA;
  const usdB = isSolB ? uiB * solPrice : uiB;
  return usdA + usdB;
}

export function useLpVault() {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const [txStatus, setTxStatus] = useState<"idle" | "signing" | "confirming" | "success" | "error">("idle");
  const [txError, setTxError] = useState<string | null>(null);

  const getProgram = useCallback(() => {
    const provider = new anchor.AnchorProvider(
      connection,
      {
        publicKey: publicKey || PublicKey.default,
        signTransaction: signTransaction as any,
        signAllTransactions: async (txs: any) => txs,
      },
      { commitment: "confirmed" }
    );
    return new anchor.Program(IDL as any, provider);
  }, [connection, publicKey, signTransaction]);

  const wrapTx = useCallback(
    async (fn: () => Promise<string>) => {
      if (!publicKey) return;
      setTxStatus("signing");
      setTxError(null);
      try {
        setTxStatus("confirming");
        const sig = await fn();
        setTxStatus("success");
        setTimeout(() => setTxStatus("idle"), 5000);
        return sig;
      } catch (err: any) {
        console.error("LP vault transaction error", err);
        setTxError(err.message ?? String(err));
        setTxStatus("error");
        throw err;
      }
    },
    [publicKey]
  );

  const fetchLpVault = useCallback(
    async (lpVaultAddress: string): Promise<LpVaultInfo> => {
      const program = getProgram();
      const pubkey = new PublicKey(lpVaultAddress);
      const raw = await (program.account as any)["lpVault"].fetch(pubkey);
      const tokenAMint = raw.tokenAMint as PublicKey;
      const tokenBMint = raw.tokenBMint as PublicKey;

      // Real decimals from each mint's own account — never assume/guess a
      // token's decimals (e.g. USDC=6, SOL=9 aren't universal; any new pair
      // could differ), since that's exactly the kind of silent scaling bug
      // that would over/under-value a user's deposit.
      const [mintAInfo, mintBInfo] = await Promise.all([
        getMint(connection, tokenAMint),
        getMint(connection, tokenBMint),
      ]);

      // Anchor represents a fieldless Rust enum variant as an object keyed
      // by the lowercased variant name, e.g. `{ orca: {} }` / `{ raydium: {} }`.
      const protocol: "orca" | "raydium" = "raydium" in (raw.protocol as object) ? "raydium" : "orca";

      return {
        address: lpVaultAddress,
        name: raw.name,
        protocol,
        tokenAMint: tokenAMint.toBase58(),
        tokenADecimals: mintAInfo.decimals,
        tokenBMint: tokenBMint.toBase58(),
        tokenBDecimals: mintBInfo.decimals,
        whirlpool: (raw.pool as PublicKey).toBase58(),
        totalLiquidity: (raw.totalLiquidity as anchor.BN).toString(),
        totalShares: (raw.totalShares as anchor.BN).toNumber(),
        positionActive: raw.positionActive as boolean,
        paused: raw.paused as boolean,
      };
    },
    [connection, getProgram]
  );

  const fetchLpPosition = useCallback(
    async (lpVaultAddress: string): Promise<LpUserPositionInfo | null> => {
      if (!publicKey) return null;
      const program = getProgram();
      const lpVaultPubkey = new PublicKey(lpVaultAddress);
      const [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_position"), lpVaultPubkey.toBuffer(), publicKey.toBuffer()],
        PROGRAM_ID
      );
      try {
        const raw = await (program.account as any)["lpUserPosition"].fetch(positionPda);
        return {
          lpVault: lpVaultAddress,
          shares: (raw.shares as anchor.BN).toNumber(),
          liquidityAtDeposit: (raw.liquidityAtDeposit as anchor.BN).toString(),
        };
      } catch {
        return null; // position doesn't exist yet — user has never deposited
      }
    },
    [publicKey, getProgram]
  );

  /**
   * Shared context fetch for deposit/withdraw: pulls the LpVault account and
   * decodes the real Whirlpool account it points to (tick spacing, sqrt
   * price, token vaults — all live on Orca's account, not ours).
   */
  const fetchLpDepositContext = useCallback(
    async (lpVaultAddress: string) => {
      const program = getProgram();
      const lpVaultPubkey = new PublicKey(lpVaultAddress);
      const raw = await (program.account as any)["lpVault"].fetch(lpVaultPubkey);
      const whirlpoolPubkey = raw.pool as PublicKey;

      const whirlpoolAccountInfo = await connection.getAccountInfo(whirlpoolPubkey);
      if (!whirlpoolAccountInfo) throw new Error("Whirlpool account not found");
      const whirlpoolInfo = decodeWhirlpool(whirlpoolAccountInfo.data);

      return { program, lpVaultPubkey, raw, whirlpoolPubkey, whirlpoolInfo };
    },
    [connection, getProgram]
  );

  /**
   * Compute a real deposit quote from a desired token A amount, using
   * Orca's own official quote function (WASM) — see the import note above
   * for why this isn't hand-rolled math.
   */
  const getDepositQuote = useCallback(
    async (lpVaultAddress: string, tokenAAmount: anchor.BN, slippageToleranceBps: number): Promise<IncreaseLiquidityQuote> => {
      const { raw, whirlpoolInfo } = await fetchLpDepositContext(lpVaultAddress);
      const tickLowerIndex = raw.tickLowerIndex as number;
      const tickUpperIndex = raw.tickUpperIndex as number;
      // Dynamic import, browser-only — see the top-of-file build note for
      // why this can't be a static top-level import.
      const { increaseLiquidityQuoteA } = await import("@orca-so/whirlpools-core");
      return increaseLiquidityQuoteA(
        BigInt(tokenAAmount.toString()),
        slippageToleranceBps,
        whirlpoolInfo.sqrtPrice,
        tickLowerIndex,
        tickUpperIndex
      );
    },
    [fetchLpDepositContext]
  );

  /**
   * Deposit both tokens into the LP vault. `quote` must come from
   * getDepositQuote (or the symmetric increaseLiquidityQuoteB) — this
   * function does not compute it itself, so a caller can show the quote to
   * the user for review before submitting.
   */
  const depositLp = useCallback(
    async (
      lpVaultAddress: string,
      quote: IncreaseLiquidityQuote,
      acknowledgeImpermanentLoss: boolean
    ) => {
      if (!publicKey) return;
      return wrapTx(async () => {
        const { program, lpVaultPubkey, raw, whirlpoolPubkey, whirlpoolInfo } = await fetchLpDepositContext(lpVaultAddress);

        const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("lp_vault_authority"), lpVaultPubkey.toBuffer()],
          PROGRAM_ID
        );
        const [positionPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("lp_position"), lpVaultPubkey.toBuffer(), publicKey.toBuffer()],
          PROGRAM_ID
        );

        const tokenAMint = raw.tokenAMint as PublicKey;
        const tokenBMint = raw.tokenBMint as PublicKey;
        const sharesMint = raw.lpSharesMint as PublicKey;
        const vaultTokenAAccount = raw.vaultTokenAAccount as PublicKey;
        const vaultTokenBAccount = raw.vaultTokenBAccount as PublicKey;
        const position = raw.position as PublicKey;
        const positionTokenAccount = raw.positionTokenAccount as PublicKey;
        const tickLowerIndex = raw.tickLowerIndex as number;
        const tickUpperIndex = raw.tickUpperIndex as number;

        const tickArrayLower = getTickArrayPda(whirlpoolPubkey, tickLowerIndex, whirlpoolInfo.tickSpacing);
        const tickArrayUpper = getTickArrayPda(whirlpoolPubkey, tickUpperIndex, whirlpoolInfo.tickSpacing);

        const userTokenAAccount = await getAssociatedTokenAddress(tokenAMint, publicKey);
        const userTokenBAccount = await getAssociatedTokenAddress(tokenBMint, publicKey);
        const userSharesAccount = await getAssociatedTokenAddress(sharesMint, publicKey);

        const liquidityAmount = new anchor.BN(quote.liquidityDelta.toString());
        const tokenMaxA = new anchor.BN(quote.tokenMaxA.toString());
        const tokenMaxB = new anchor.BN(quote.tokenMaxB.toString());

        const preIxs = [
          ...(await ensureAtaAndWrapIfNativeIxs(connection, publicKey, tokenAMint, tokenMaxA)),
          ...(await ensureAtaAndWrapIfNativeIxs(connection, publicKey, tokenBMint, tokenMaxB)),
          createAssociatedTokenAccountIdempotentInstruction(publicKey, userSharesAccount, publicKey, sharesMint),
        ];

        const ix = await program.methods
          .depositOrcaLp(liquidityAmount, tokenMaxA, tokenMaxB, acknowledgeImpermanentLoss)
          .accountsPartial({
            user: publicKey,
            lpVault: lpVaultPubkey,
            vaultAuthority: vaultAuthorityPda,
            userPosition: positionPda,
            userTokenAAccount,
            userTokenBAccount,
            userSharesAccount,
            vaultTokenAAccount,
            vaultTokenBAccount,
            lpSharesMint: sharesMint,
            whirlpool: whirlpoolPubkey,
            position,
            positionTokenAccount,
            tokenVaultA: whirlpoolInfo.tokenVaultA,
            tokenVaultB: whirlpoolInfo.tokenVaultB,
            tickArrayLower,
            tickArrayUpper,
            tokenProgram: TOKEN_PROGRAM_ID,
            whirlpoolProgram: WHIRLPOOL_PROGRAM_ID,
          })
          .instruction();

        // v0 + ALT, not Anchor's plain legacy .rpc() — this instruction alone (25
        // accounts) already serializes to 973/1232 bytes on its own, leaving almost no
        // room for a wallet's own safety-simulation instructions (Phantom's "Lighthouse"
        // guard) appended before signing. Confirmed live 2026-08-27: Phantom warned about
        // this exact transaction being unable to fit its own guard. See sendLpV0's doc
        // comment for the measured before/after on the same class of transaction.
        return sendLpV0(connection, { publicKey, signTransaction: signTransaction! }, [...preIxs, ix]);
      });
    },
    [publicKey, signTransaction, wrapTx, fetchLpDepositContext, connection]
  );

  /**
   * Compute a real withdraw quote for a given share amount, using Orca's
   * own official decreaseLiquidityQuote (WASM) — symmetric to
   * getDepositQuote, same "don't hand-roll fixed-point math" reasoning.
   */
  const getWithdrawQuote = useCallback(
    async (lpVaultAddress: string, shares: anchor.BN, slippageToleranceBps: number): Promise<DecreaseLiquidityQuote> => {
      const { raw, whirlpoolInfo } = await fetchLpDepositContext(lpVaultAddress);
      const tickLowerIndex = raw.tickLowerIndex as number;
      const tickUpperIndex = raw.tickUpperIndex as number;
      const totalLiquidity = BigInt((raw.totalLiquidity as anchor.BN).toString());
      const totalShares = BigInt((raw.totalShares as anchor.BN).toString());
      if (totalShares === 0n) throw new Error("Vault has no shares outstanding");
      const liquidityDelta = (BigInt(shares.toString()) * totalLiquidity) / totalShares;

      // Dynamic import, browser-only — see the top-of-file build note.
      const { decreaseLiquidityQuote } = await import("@orca-so/whirlpools-core");
      return decreaseLiquidityQuote(
        liquidityDelta,
        slippageToleranceBps,
        whirlpoolInfo.sqrtPrice,
        tickLowerIndex,
        tickUpperIndex
      );
    },
    [fetchLpDepositContext]
  );

  /**
   * Withdraw shares from the LP vault. `quote` must come from
   * getWithdrawQuote — this function does not compute it itself, so a
   * caller can show the quote to the user for review before submitting.
   */
  const withdrawLp = useCallback(
    async (lpVaultAddress: string, shares: anchor.BN, quote: DecreaseLiquidityQuote) => {
      if (!publicKey) return;
      return wrapTx(async () => {
        const { program, lpVaultPubkey, raw, whirlpoolPubkey, whirlpoolInfo } = await fetchLpDepositContext(lpVaultAddress);

        const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("lp_vault_authority"), lpVaultPubkey.toBuffer()],
          PROGRAM_ID
        );
        const [positionPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("lp_position"), lpVaultPubkey.toBuffer(), publicKey.toBuffer()],
          PROGRAM_ID
        );

        const tokenAMint = raw.tokenAMint as PublicKey;
        const tokenBMint = raw.tokenBMint as PublicKey;
        const sharesMint = raw.lpSharesMint as PublicKey;
        const vaultTokenAAccount = raw.vaultTokenAAccount as PublicKey;
        const vaultTokenBAccount = raw.vaultTokenBAccount as PublicKey;
        const position = raw.position as PublicKey;
        const positionTokenAccount = raw.positionTokenAccount as PublicKey;
        const tickLowerIndex = raw.tickLowerIndex as number;
        const tickUpperIndex = raw.tickUpperIndex as number;

        const tickArrayLower = getTickArrayPda(whirlpoolPubkey, tickLowerIndex, whirlpoolInfo.tickSpacing);
        const tickArrayUpper = getTickArrayPda(whirlpoolPubkey, tickUpperIndex, whirlpoolInfo.tickSpacing);

        const userTokenAAccount = await getAssociatedTokenAddress(tokenAMint, publicKey);
        const userTokenBAccount = await getAssociatedTokenAddress(tokenBMint, publicKey);
        const userSharesAccount = await getAssociatedTokenAddress(sharesMint, publicKey);

        const tokenMinA = new anchor.BN(quote.tokenMinA.toString());
        const tokenMinB = new anchor.BN(quote.tokenMinB.toString());

        // A withdraw needs somewhere to RECEIVE tokenA/tokenB — on this wallet's very
        // first withdraw (no prior deposit/swap ever created these ATAs), they don't
        // exist yet and the on-chain transfer fails with AccountNotInitialized. No
        // wrapping needed here (we're receiving, not sending native SOL in), so pass 0
        // as the required amount — ensureAtaAndWrapIfNativeIxs's idempotent create
        // instruction still runs, its wrap-top-up path just never fires.
        const zero = new anchor.BN(0);
        const preIxs = [
          ...(await ensureAtaAndWrapIfNativeIxs(connection, publicKey, tokenAMint, zero)),
          ...(await ensureAtaAndWrapIfNativeIxs(connection, publicKey, tokenBMint, zero)),
          createAssociatedTokenAccountIdempotentInstruction(publicKey, userSharesAccount, publicKey, sharesMint),
        ];

        const ix = await program.methods
          .withdrawOrcaLp(shares, tokenMinA, tokenMinB)
          .accountsPartial({
            user: publicKey,
            lpVault: lpVaultPubkey,
            vaultAuthority: vaultAuthorityPda,
            userPosition: positionPda,
            userTokenAAccount,
            userTokenBAccount,
            userSharesAccount,
            vaultTokenAAccount,
            vaultTokenBAccount,
            lpSharesMint: sharesMint,
            whirlpool: whirlpoolPubkey,
            position,
            positionTokenAccount,
            tokenVaultA: whirlpoolInfo.tokenVaultA,
            tokenVaultB: whirlpoolInfo.tokenVaultB,
            tickArrayLower,
            tickArrayUpper,
            tokenProgram: TOKEN_PROGRAM_ID,
            whirlpoolProgram: WHIRLPOOL_PROGRAM_ID,
          })
          .instruction();

        return sendLpV0(connection, { publicKey, signTransaction: signTransaction! }, [...preIxs, ix]);
      });
    },
    [publicKey, signTransaction, wrapTx, fetchLpDepositContext, connection]
  );

  // ── Raydium CLMM side ────────────────────────────────────────────────────
  // Mirrors the Orca functions above 1:1 in shape (same quote-then-submit
  // pattern), but reads a Raydium pool_state instead of a Whirlpool and uses
  // @raydium-io/raydium-sdk-v2's own verified Q64.64 liquidity math instead
  // of hand-rolling it — same "don't reimplement concentrated-liquidity
  // fixed-point math" reasoning as the Orca WASM import above. Uses the
  // lower-level LiquidityMathUtil primitives (getLiquidityFromAmounts /
  // getAmountsForLiquidity / getAmountsFromLiquidityWithSlippage) rather
  // than the package's getLiquidityAndAmountsFromAmount convenience
  // wrapper — that wrapper's compiled output re-derives amounts from the
  // *input* amount instead of the *computed* liquidity, which looks like a
  // real bug in the published build; the three primitives used here are
  // each a single, individually-inspectable Q64.64 operation.

  const fetchRaydiumLpDepositContext = useCallback(
    async (lpVaultAddress: string) => {
      const program = getProgram();
      const lpVaultPubkey = new PublicKey(lpVaultAddress);
      const raw = await (program.account as any)["lpVault"].fetch(lpVaultPubkey);
      const poolStatePubkey = raw.pool as PublicKey;

      const poolAccountInfo = await connection.getAccountInfo(poolStatePubkey);
      if (!poolAccountInfo) throw new Error("Raydium pool_state account not found");
      const poolInfo = decodeRaydiumPool(poolAccountInfo.data);

      return { program, lpVaultPubkey, raw, poolStatePubkey, poolInfo };
    },
    [connection, getProgram]
  );

  const getRaydiumDepositQuote = useCallback(
    async (lpVaultAddress: string, tokenAAmount: anchor.BN, slippageToleranceBps: number) => {
      const { raw, poolInfo } = await fetchRaydiumLpDepositContext(lpVaultAddress);
      const tickLowerIndex = raw.tickLowerIndex as number;
      const tickUpperIndex = raw.tickUpperIndex as number;

      const { LiquidityMathUtil, TickUtil } = await import("@raydium-io/raydium-sdk-v2");
      const BN = anchor.BN;
      const sqrtPriceCurrentX64 = new BN(poolInfo.sqrtPriceX64.toString());
      const sqrtPriceLowerX64 = TickUtil.getSqrtPriceAtTick(tickLowerIndex);
      const sqrtPriceUpperX64 = TickUtil.getSqrtPriceAtTick(tickUpperIndex);

      // Cap by tokenAAmount alone (token B budget treated as unlimited) —
      // mirrors Orca's increaseLiquidityQuoteA semantics: "given this much
      // of token A, how much liquidity and token B does that require".
      const hugeAmountB = new BN(2).pow(new BN(64)).subn(1);
      const liquidityDelta = LiquidityMathUtil.getLiquidityFromAmounts(
        sqrtPriceCurrentX64, sqrtPriceLowerX64, sqrtPriceUpperX64, tokenAAmount, hugeAmountB
      );

      const slippage = slippageToleranceBps / 10_000;
      const { amountSlippageA, amountSlippageB } = LiquidityMathUtil.getAmountsFromLiquidityWithSlippage(
        sqrtPriceCurrentX64, sqrtPriceLowerX64, sqrtPriceUpperX64, liquidityDelta, true, true, slippage
      );

      return { liquidityDelta, tokenMaxA: amountSlippageA as anchor.BN, tokenMaxB: amountSlippageB as anchor.BN };
    },
    [fetchRaydiumLpDepositContext]
  );

  const depositRaydiumLp = useCallback(
    async (
      lpVaultAddress: string,
      quote: { liquidityDelta: anchor.BN; tokenMaxA: anchor.BN; tokenMaxB: anchor.BN },
      acknowledgeImpermanentLoss: boolean
    ) => {
      if (!publicKey) return;
      return wrapTx(async () => {
        const { program, lpVaultPubkey, raw, poolStatePubkey, poolInfo } = await fetchRaydiumLpDepositContext(lpVaultAddress);

        const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("lp_vault_authority"), lpVaultPubkey.toBuffer()],
          PROGRAM_ID
        );
        const [positionPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("lp_position"), lpVaultPubkey.toBuffer(), publicKey.toBuffer()],
          PROGRAM_ID
        );

        const tokenAMint = raw.tokenAMint as PublicKey;
        const tokenBMint = raw.tokenBMint as PublicKey;
        const sharesMint = raw.lpSharesMint as PublicKey;
        const vaultTokenAAccount = raw.vaultTokenAAccount as PublicKey;
        const vaultTokenBAccount = raw.vaultTokenBAccount as PublicKey;
        const personalPosition = raw.position as PublicKey;
        const protocolPosition = raw.protocolPosition as PublicKey;
        const nftAccount = raw.positionTokenAccount as PublicKey;
        const tickLowerIndex = raw.tickLowerIndex as number;
        const tickUpperIndex = raw.tickUpperIndex as number;

        const tickArrayLower = getRaydiumTickArrayPda(poolStatePubkey, tickLowerIndex, poolInfo.tickSpacing);
        const tickArrayUpper = getRaydiumTickArrayPda(poolStatePubkey, tickUpperIndex, poolInfo.tickSpacing);

        const userTokenAAccount = await getAssociatedTokenAddress(tokenAMint, publicKey);
        const userTokenBAccount = await getAssociatedTokenAddress(tokenBMint, publicKey);
        const userSharesAccount = await getAssociatedTokenAddress(sharesMint, publicKey);

        const preIxs = [
          ...(await ensureAtaAndWrapIfNativeIxs(connection, publicKey, tokenAMint, quote.tokenMaxA)),
          ...(await ensureAtaAndWrapIfNativeIxs(connection, publicKey, tokenBMint, quote.tokenMaxB)),
          createAssociatedTokenAccountIdempotentInstruction(publicKey, userSharesAccount, publicKey, sharesMint),
        ];

        const ix = await program.methods
          .depositRaydiumLp(quote.liquidityDelta, quote.tokenMaxA, quote.tokenMaxB, acknowledgeImpermanentLoss)
          .accountsPartial({
            user: publicKey,
            lpVault: lpVaultPubkey,
            vaultAuthority: vaultAuthorityPda,
            userPosition: positionPda,
            userTokenAAccount,
            userTokenBAccount,
            userSharesAccount,
            vaultTokenAAccount,
            vaultTokenBAccount,
            lpSharesMint: sharesMint,
            nftAccount,
            poolState: poolStatePubkey,
            protocolPosition,
            personalPosition,
            tickArrayLower,
            tickArrayUpper,
            tokenVault0: poolInfo.tokenVaultA,
            tokenVault1: poolInfo.tokenVaultB,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
            raydiumProgram: RAYDIUM_CLMM_PROGRAM_ID,
          })
          .instruction();

        return sendLpV0(connection, { publicKey, signTransaction: signTransaction! }, [...preIxs, ix]);
      });
    },
    [publicKey, signTransaction, connection, wrapTx, fetchRaydiumLpDepositContext]
  );

  const getRaydiumWithdrawQuote = useCallback(
    async (lpVaultAddress: string, shares: anchor.BN, slippageToleranceBps: number) => {
      const { raw, poolInfo } = await fetchRaydiumLpDepositContext(lpVaultAddress);
      const tickLowerIndex = raw.tickLowerIndex as number;
      const tickUpperIndex = raw.tickUpperIndex as number;
      const totalLiquidity = (raw.totalLiquidity as anchor.BN);
      const totalShares = (raw.totalShares as anchor.BN);
      if (totalShares.isZero()) throw new Error("Vault has no shares outstanding");
      const liquidityDelta = shares.mul(totalLiquidity).div(totalShares);

      const { LiquidityMathUtil, TickUtil } = await import("@raydium-io/raydium-sdk-v2");
      const BN = anchor.BN;
      const sqrtPriceCurrentX64 = new BN(poolInfo.sqrtPriceX64.toString());
      const sqrtPriceLowerX64 = TickUtil.getSqrtPriceAtTick(tickLowerIndex);
      const sqrtPriceUpperX64 = TickUtil.getSqrtPriceAtTick(tickUpperIndex);

      const slippage = slippageToleranceBps / 10_000;
      const { amountSlippageA, amountSlippageB } = LiquidityMathUtil.getAmountsFromLiquidityWithSlippage(
        sqrtPriceCurrentX64, sqrtPriceLowerX64, sqrtPriceUpperX64, liquidityDelta, false, false, slippage
      );

      return { liquidityDelta, tokenMinA: amountSlippageA as anchor.BN, tokenMinB: amountSlippageB as anchor.BN };
    },
    [fetchRaydiumLpDepositContext]
  );

  const withdrawRaydiumLp = useCallback(
    async (
      lpVaultAddress: string,
      shares: anchor.BN,
      quote: { tokenMinA: anchor.BN; tokenMinB: anchor.BN }
    ) => {
      if (!publicKey) return;
      return wrapTx(async () => {
        const { program, lpVaultPubkey, raw, poolStatePubkey, poolInfo } = await fetchRaydiumLpDepositContext(lpVaultAddress);

        const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("lp_vault_authority"), lpVaultPubkey.toBuffer()],
          PROGRAM_ID
        );
        const [positionPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("lp_position"), lpVaultPubkey.toBuffer(), publicKey.toBuffer()],
          PROGRAM_ID
        );

        const tokenAMint = raw.tokenAMint as PublicKey;
        const tokenBMint = raw.tokenBMint as PublicKey;
        const sharesMint = raw.lpSharesMint as PublicKey;
        const vaultTokenAAccount = raw.vaultTokenAAccount as PublicKey;
        const vaultTokenBAccount = raw.vaultTokenBAccount as PublicKey;
        const personalPosition = raw.position as PublicKey;
        const protocolPosition = raw.protocolPosition as PublicKey;
        const nftAccount = raw.positionTokenAccount as PublicKey;
        const tickLowerIndex = raw.tickLowerIndex as number;
        const tickUpperIndex = raw.tickUpperIndex as number;

        const tickArrayLower = getRaydiumTickArrayPda(poolStatePubkey, tickLowerIndex, poolInfo.tickSpacing);
        const tickArrayUpper = getRaydiumTickArrayPda(poolStatePubkey, tickUpperIndex, poolInfo.tickSpacing);

        const userTokenAAccount = await getAssociatedTokenAddress(tokenAMint, publicKey);
        const userTokenBAccount = await getAssociatedTokenAddress(tokenBMint, publicKey);
        const userSharesAccount = await getAssociatedTokenAddress(sharesMint, publicKey);

        // Reward recipients must EXIST before decrease_liquidity runs, so create them
        // idempotently in the same transaction.
        const poolAcct = await connection.getAccountInfo(poolStatePubkey);
        const rewards = poolAcct ? readRaydiumRewards(poolAcct.data) : [];
        const rewardRemaining: AccountMeta[] = [];
        const rewardPreIxs: TransactionInstruction[] = [];
        for (const r of rewards) {
          const recipient = await getAssociatedTokenAddress(r.mint, vaultAuthorityPda, true);
          rewardPreIxs.push(
            createAssociatedTokenAccountIdempotentInstruction(publicKey, recipient, vaultAuthorityPda, r.mint)
          );
          rewardRemaining.push({ pubkey: r.vault, isSigner: false, isWritable: true });
          rewardRemaining.push({ pubkey: recipient, isSigner: false, isWritable: true });
        }

        return program.methods
          .withdrawRaydiumLp(shares, quote.tokenMinA, quote.tokenMinB)
          .accountsPartial({
            user: publicKey,
            lpVault: lpVaultPubkey,
            vaultAuthority: vaultAuthorityPda,
            userPosition: positionPda,
            userTokenAAccount,
            userTokenBAccount,
            userSharesAccount,
            vaultTokenAAccount,
            vaultTokenBAccount,
            lpSharesMint: sharesMint,
            nftAccount,
            poolState: poolStatePubkey,
            protocolPosition,
            personalPosition,
            tickArrayLower,
            tickArrayUpper,
            tokenVault0: poolInfo.tokenVaultA,
            tokenVault1: poolInfo.tokenVaultB,
            tokenProgram: TOKEN_PROGRAM_ID,
            raydiumProgram: RAYDIUM_CLMM_PROGRAM_ID,
          })
          // Raydium collects reward emissions inside decrease_liquidity and validates
          // the remaining-account count against the pool's initialized rewards; passing
          // none fails InvalidRewardInputAccountNumber (6030).
          .remainingAccounts(rewardRemaining)
          .instruction()
          .then((ix) =>
            sendLpV0(connection, { publicKey, signTransaction: signTransaction! }, [...rewardPreIxs, ix])
          );
      });
    },
    [publicKey, signTransaction, connection, wrapTx, fetchRaydiumLpDepositContext]
  );

  return {
    txStatus,
    txError,
    fetchLpVault,
    fetchLpPosition,
    getDepositQuote,
    getWithdrawQuote,
    getRaydiumDepositQuote,
    getRaydiumWithdrawQuote,
    depositRaydiumLp,
    withdrawRaydiumLp,
    withdrawLp,
    depositLp,
  };
}
