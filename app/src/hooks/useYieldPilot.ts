"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import IDL from "@/idl/yieldpilot.json";

const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID || "YPiLt1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ12"
);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface VaultInfo {
  address: string;
  name: string;
  mint: string;
  totalDeposits: number;
  totalShares: number;
  perfFeeBps: number;
  autoCompound: boolean;
  autoRebalance: boolean;
  lastCompoundTs: number;
  protocolCount: number;
  protocols: {
    name: string;
    targetBps: number;
    currentBalance: number;
    enabled: boolean;
  }[];
}

export interface UserPosition {
  vault: string;
  shares: number;
  depositedAmount: number;
  lastDepositTs: number;
  // Derived
  currentValue: number;
  earnedValue: number;
}

export interface TokenBalance {
  mint: string;
  symbol: string;
  amount: number;
  decimals: number;
  uiAmount: number;
}

export type TxStatus = "idle" | "signing" | "confirming" | "success" | "error";

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function useYieldPilot(vaultAddresses: string[]) {
  const { connection } = useConnection();
  const { publicKey, signTransaction, sendTransaction } = useWallet();

  const [vaults, setVaults] = useState<VaultInfo[]>([]);
  const [positions, setPositions] = useState<UserPosition[]>([]);
  const [loading, setLoading] = useState(false);
  const [txStatus, setTxStatus] = useState<TxStatus>("idle");
  const [txError, setTxError] = useState<string | null>(null);
  const [lastTxSig, setLastTxSig] = useState<string | null>(null);

  // Build Anchor program (read-only, no wallet needed for fetching)
  const getProgram = useCallback(() => {
    const provider = new anchor.AnchorProvider(
      connection,
      // Dummy wallet for read-only
      {
        publicKey: publicKey || PublicKey.default,
        signTransaction: signTransaction as any,
        signAllTransactions: async (txs: any) => txs,
      },
      { commitment: "confirmed" }
    );
    return new anchor.Program(IDL as any, provider);
  }, [connection, publicKey, signTransaction]);

  // ── Fetch vault state ───────────────────────────────────────────────────

  const fetchVaults = useCallback(async () => {
    if (vaultAddresses.length === 0) return;
    setLoading(true);
    try {
      const program = getProgram();
      const results = await Promise.allSettled(
        vaultAddresses.map(async (addr) => {
          const pubkey = new PublicKey(addr);
          const raw = await (program.account as any)["vault"].fetch(pubkey);
          return {
            address: addr,
            name: raw.name as string,
            mint: (raw.mint as PublicKey).toBase58(),
            totalDeposits: (raw.totalDeposits as anchor.BN).toNumber(),
            totalShares: (raw.totalShares as anchor.BN).toNumber(),
            perfFeeBps: (raw.perfFeeBps as anchor.BN).toNumber(),
            autoCompound: raw.autoCompound as boolean,
            autoRebalance: raw.autoRebalance as boolean,
            lastCompoundTs: (raw.lastCompoundTs as anchor.BN).toNumber(),
            protocolCount: raw.protocolCount as number,
            protocols: (raw.protocols as any[])
              .slice(0, raw.protocolCount as number)
              .map((p) => ({
                name: Buffer.from(p.name).toString("utf8").replace(/\0/g, ""),
                targetBps: p.targetBps.toNumber(),
                currentBalance: p.currentBalance.toNumber(),
                enabled: p.enabled,
              })),
          } as VaultInfo;
        })
      );
      setVaults(
        results
          .filter((r): r is PromiseFulfilledResult<VaultInfo> => r.status === "fulfilled")
          .map((r) => r.value)
      );
    } catch (err) {
      console.error("fetchVaults error", err);
    } finally {
      setLoading(false);
    }
  }, [vaultAddresses, getProgram]);

  // ── Fetch user positions ─────────────────────────────────────────────────

  const fetchPositions = useCallback(async () => {
    if (!publicKey || vaults.length === 0) return;
    try {
      const program = getProgram();
      const results = await Promise.allSettled(
        vaults.map(async (vault) => {
          const vaultPubkey = new PublicKey(vault.address);
          const [positionPda] = PublicKey.findProgramAddressSync(
            [
              Buffer.from("position"),
              vaultPubkey.toBuffer(),
              publicKey.toBuffer(),
            ],
            PROGRAM_ID
          );
          const raw = await (program.account as any)["userPosition"].fetch(positionPda);
          const shares = (raw.shares as anchor.BN).toNumber();
          const depositedAmount = (raw.depositedAmount as anchor.BN).toNumber();

          // Compute current value based on share price
          const currentValue =
            vault.totalShares > 0
              ? (shares / vault.totalShares) * vault.totalDeposits
              : depositedAmount;
          const earnedValue = Math.max(0, currentValue - depositedAmount);

          return {
            vault: vault.address,
            shares,
            depositedAmount,
            lastDepositTs: (raw.lastDepositTs as anchor.BN).toNumber(),
            currentValue,
            earnedValue,
          } as UserPosition;
        })
      );
      setPositions(
        results
          .filter((r): r is PromiseFulfilledResult<UserPosition> => r.status === "fulfilled")
          .map((r) => r.value)
          .filter((p) => p.shares > 0)
      );
    } catch (err) {
      console.error("fetchPositions error", err);
    }
  }, [publicKey, vaults, getProgram]);

  // Poll on mount and when wallet connects
  useEffect(() => {
    fetchVaults();
    const id = setInterval(fetchVaults, 30_000); // refresh every 30s
    return () => clearInterval(id);
  }, [fetchVaults]);

  useEffect(() => {
    fetchPositions();
  }, [fetchPositions]);

  // ── Transactions ─────────────────────────────────────────────────────────

  const wrapTx = useCallback(
    async (fn: () => Promise<string>) => {
      if (!publicKey) return;
      setTxStatus("signing");
      setTxError(null);
      try {
        setTxStatus("confirming");
        const sig = await fn();
        setLastTxSig(sig);
        setTxStatus("success");
        // Refresh state after tx confirms
        setTimeout(() => {
          fetchVaults();
          fetchPositions();
        }, 2000);
        setTimeout(() => setTxStatus("idle"), 5000);
        return sig;
      } catch (err: any) {
        console.error("Transaction error", err);
        setTxError(err.message || "Transaction failed");
        setTxStatus("error");
        setTimeout(() => setTxStatus("idle"), 6000);
      }
    },
    [publicKey, fetchVaults, fetchPositions]
  );

  const deposit = useCallback(
    async (vaultAddress: string, mint: string, amount: anchor.BN) => {
      if (!publicKey) return;
      return wrapTx(async () => {
        const program = getProgram();
        const vaultPubkey = new PublicKey(vaultAddress);
        const mintPubkey = new PublicKey(mint);

        const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), vaultPubkey.toBuffer()],
          PROGRAM_ID
        );
        const [positionPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("position"), vaultPubkey.toBuffer(), publicKey.toBuffer()],
          PROGRAM_ID
        );
        const vaultRaw = await (program.account as any)["vault"].fetch(vaultPubkey);
        const vaultTokenAccount = new PublicKey((vaultRaw.vaultTokenAccount as PublicKey).toBase58());
        const sharesMint = new PublicKey((vaultRaw.sharesMint as PublicKey).toBase58());
        const userTokenAccount = await getAssociatedTokenAddress(mintPubkey, publicKey);
        const userSharesAccount = await getAssociatedTokenAddress(sharesMint, publicKey);

        return program.methods
          .deposit(amount)
          .accounts({
            user: publicKey,
            vault: vaultPubkey,
            vaultAuthority: vaultAuthorityPda,
            vaultTokenAccount,
            userTokenAccount,
            sharesMint,
            userPosition: positionPda,
            userSharesAccount,
            userGateAccount: null as any,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      });
    },
    [publicKey, getProgram, wrapTx]
  );

  const withdraw = useCallback(
    async (vaultAddress: string, mint: string, shares: anchor.BN) => {
      if (!publicKey) return;
      return wrapTx(async () => {
        const program = getProgram();
        const vaultPubkey = new PublicKey(vaultAddress);
        const mintPubkey = new PublicKey(mint);

        const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), vaultPubkey.toBuffer()],
          PROGRAM_ID
        );
        const [positionPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("position"), vaultPubkey.toBuffer(), publicKey.toBuffer()],
          PROGRAM_ID
        );
        const vaultRaw = await (program.account as any)["vault"].fetch(vaultPubkey);
        const vaultTokenAccount = new PublicKey((vaultRaw.vaultTokenAccount as PublicKey).toBase58());
        const sharesMint = new PublicKey((vaultRaw.sharesMint as PublicKey).toBase58());
        const userTokenAccount = await getAssociatedTokenAddress(mintPubkey, publicKey);
        const userSharesAccount = await getAssociatedTokenAddress(sharesMint, publicKey);

        const vaultRawForWithdraw = await (program.account as any)["vault"].fetch(vaultPubkey);
        const gateMint = new PublicKey((vaultRawForWithdraw.gateMint as PublicKey).toBase58());
        const isGatingEnabled = gateMint.toBase58() !== PublicKey.default.toBase58();
        const userGateAccount = isGatingEnabled
          ? await getAssociatedTokenAddress(gateMint, publicKey)
          : null;

        return program.methods
          .withdraw(shares)
          .accounts({
            user: publicKey,
            vault: vaultPubkey,
            vaultAuthority: vaultAuthorityPda,
            vaultTokenAccount,
            userTokenAccount,
            sharesMint,
            userPosition: positionPda,
            userSharesAccount,
            treasuryTokenAccount: null as any,
            userGateAccount: userGateAccount as any,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
      });
    },
    [publicKey, getProgram, wrapTx]
  );

  return {
    vaults,
    positions,
    loading,
    txStatus,
    txError,
    lastTxSig,
    deposit,
    withdraw,
    refresh: () => { fetchVaults(); fetchPositions(); },
  };
}
