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
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import IDL from "@/idl/yieldpilot.mainnet.json";

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
  tokenMintA: PublicKey;
  tokenVaultA: PublicKey;
  tokenMintB: PublicKey;
  tokenVaultB: PublicKey;
}

function decodeWhirlpool(data: Buffer): WhirlpoolInfo {
  return {
    tickSpacing: data.readUInt16LE(41),
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
  tokenBMint: string;
  whirlpool: string;
  totalLiquidity: string; // u128 — kept as string, too large for safe JS number
  totalShares: number;
  positionActive: boolean;
  paused: boolean;
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
      return {
        address: lpVaultAddress,
        name: raw.name,
        tokenAMint: (raw.tokenAMint as PublicKey).toBase58(),
        tokenBMint: (raw.tokenBMint as PublicKey).toBase58(),
        whirlpool: (raw.whirlpool as PublicKey).toBase58(),
        totalLiquidity: (raw.totalLiquidity as anchor.BN).toString(),
        totalShares: (raw.totalShares as anchor.BN).toNumber(),
        positionActive: raw.positionActive as boolean,
        paused: raw.paused as boolean,
      };
    },
    [getProgram]
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
   * Deposit both tokens into the LP vault.
   *
   * NOTE: `liquidityAmount` must be computed off-chain from the desired
   * token amounts and the pool's current sqrt_price (real concentrated-
   * liquidity math — needs the actual formula from Orca's SDK, not yet
   * wired in here; a wrong liquidityAmount just fails the CPI's own
   * slippage/max-token checks, it can't silently misprice a deposit).
   * `tokenMaxA`/`tokenMaxB` are the on-chain slippage guard regardless of
   * how liquidityAmount was computed.
   */
  const depositLp = useCallback(
    async (
      lpVaultAddress: string,
      liquidityAmount: anchor.BN,
      tokenMaxA: anchor.BN,
      tokenMaxB: anchor.BN,
      acknowledgeImpermanentLoss: boolean
    ) => {
      if (!publicKey) return;
      return wrapTx(async () => {
        const program = getProgram();
        const lpVaultPubkey = new PublicKey(lpVaultAddress);

        const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("lp_vault_authority"), lpVaultPubkey.toBuffer()],
          PROGRAM_ID
        );
        const [positionPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("lp_position"), lpVaultPubkey.toBuffer(), publicKey.toBuffer()],
          PROGRAM_ID
        );

        const raw = await (program.account as any)["lpVault"].fetch(lpVaultPubkey);
        const tokenAMint = raw.tokenAMint as PublicKey;
        const tokenBMint = raw.tokenBMint as PublicKey;
        const whirlpoolPubkey = raw.whirlpool as PublicKey;
        const sharesMint = raw.lpSharesMint as PublicKey;
        const vaultTokenAAccount = raw.vaultTokenAAccount as PublicKey;
        const vaultTokenBAccount = raw.vaultTokenBAccount as PublicKey;
        const position = raw.position as PublicKey;
        const positionTokenAccount = raw.positionTokenAccount as PublicKey;
        const tickLowerIndex = raw.tickLowerIndex as number;
        const tickUpperIndex = raw.tickUpperIndex as number;

        // Fetch the real Whirlpool account to get tick spacing and its own
        // token vault addresses — these live on Orca's account, not ours.
        const whirlpoolAccountInfo = await connection.getAccountInfo(whirlpoolPubkey);
        if (!whirlpoolAccountInfo) throw new Error("Whirlpool account not found");
        const whirlpoolInfo = decodeWhirlpool(whirlpoolAccountInfo.data);

        const tickArrayLower = getTickArrayPda(whirlpoolPubkey, tickLowerIndex, whirlpoolInfo.tickSpacing);
        const tickArrayUpper = getTickArrayPda(whirlpoolPubkey, tickUpperIndex, whirlpoolInfo.tickSpacing);

        const userTokenAAccount = await getAssociatedTokenAddress(tokenAMint, publicKey);
        const userTokenBAccount = await getAssociatedTokenAddress(tokenBMint, publicKey);
        const userSharesAccount = await getAssociatedTokenAddress(sharesMint, publicKey);

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
    [publicKey, connection, getProgram, wrapTx]
  );

  return {
    txStatus,
    txError,
    fetchLpVault,
    fetchLpPosition,
    depositLp,
  };
}
