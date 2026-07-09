"use client";

/**
 * useLpVault.ts — frontend hook for the opt-in, dual-asset Orca Whirlpool
 * LP vault (Phase 2 groundwork, not linked from any nav/page yet).
 *
 * IMPORTANT: this hook targets instructions (initialize_lp_vault, deposit_lp,
 * withdraw_lp, etc.) that exist in lp_vault.rs but are NOT YET DEPLOYED —
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
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
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

const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID || "CVJrJGoKjseTJqiFGctssYde3pLAnPaRZtjAaKXd8pWk"
);
const WHIRLPOOL_PROGRAM_ID = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");

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

export interface LpVaultInfo {
  address: string;
  name: string;
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

      return {
        address: lpVaultAddress,
        name: raw.name,
        tokenAMint: tokenAMint.toBase58(),
        tokenADecimals: mintAInfo.decimals,
        tokenBMint: tokenBMint.toBase58(),
        tokenBDecimals: mintBInfo.decimals,
        whirlpool: (raw.whirlpool as PublicKey).toBase58(),
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
      const whirlpoolPubkey = raw.whirlpool as PublicKey;

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

        return program.methods
          .depositLp(liquidityAmount, tokenMaxA, tokenMaxB, acknowledgeImpermanentLoss)
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
          .rpc();
      });
    },
    [publicKey, wrapTx, fetchLpDepositContext]
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

        return program.methods
          .withdrawLp(shares, tokenMinA, tokenMinB)
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
          .rpc();
      });
    },
    [publicKey, wrapTx, fetchLpDepositContext]
  );

  return {
    txStatus,
    txError,
    fetchLpVault,
    fetchLpPosition,
    getDepositQuote,
    getWithdrawQuote,
    withdrawLp,
    depositLp,
  };
}
