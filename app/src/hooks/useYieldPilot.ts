"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import { Transaction, SystemProgram as SP } from "@solana/web3.js";
import IDL from "@/idl/yieldpilot.mainnet.json";

const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID || "CVJrJGoKjseTJqiFGctssYde3pLAnPaRZtjAaKXd8pWk"
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
  gateMint: string;
  goldThreshold: number;
  silverThreshold: number;
  bronzeThreshold: number;
  protocols: {
    name: string;
    targetBps: number;
    currentBalance: number;
    enabled: boolean;
    vaultReceiptAccount: string;
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
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [txHistory, setTxHistory] = useState<{ sig: string; type: string; ts: number }[]>([]);
  const [userGateBalance, setUserGateBalance] = useState<number>(0);

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
            gateMint: ((raw.gateMint as any)?.toBase58 ? (raw.gateMint as any).toBase58() : ""),
            goldThreshold: (raw.goldThreshold as anchor.BN).toNumber(),
            silverThreshold: (raw.silverThreshold as anchor.BN).toNumber(),
            bronzeThreshold: (raw.bronzeThreshold as anchor.BN).toNumber(),
            protocols: (raw.protocols as any[])
              .slice(0, raw.protocolCount as number)
              .map((p) => ({
                name: Buffer.from(p.label).toString("utf8").replace(/\0/g, ""),
                targetBps: p.targetBps.toNumber(),
                currentBalance: p.deployedBalance.toNumber(),
                enabled: p.targetBps > 0,
                vaultReceiptAccount: (p.vaultReceiptAccount as PublicKey).toBase58(),
              })),
          } as VaultInfo;
        })
      );
      setVaults(
        results
          .filter((r): r is PromiseFulfilledResult<VaultInfo> => r.status === "fulfilled")
          .map((r) => r.value)
      );
    } catch (err: any) {
      console.error("fetchVaults error", err);
      setVaultError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [vaultAddresses, getProgram]);

  // ── Fetch user positions ─────────────────────────────────────────────────

  const fetchPositions = useCallback(async () => {
    if (!publicKey || vaults.length === 0) return;
    try {
      const program = getProgram();
      // Fetch user's gate token balance for tier calculation
      const gateMint = vaults.find(v => v.gateMint && v.gateMint !== '11111111111111111111111111111111')?.gateMint;
      if (gateMint) {
        try {
          const gateAta = await (await import("@solana/spl-token")).getAssociatedTokenAddress(
            new PublicKey(gateMint), publicKey
          );
          const gateAcct = await connection.getTokenAccountBalance(gateAta);
          setUserGateBalance(gateAcct.value.amount ? parseInt(gateAcct.value.amount) : 0);
        } catch {
          setUserGateBalance(0);
        }
      }
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
          .filter((p) => p.shares > 0 && (vaults.find(v => v.address === p.vault)?.totalShares ?? 0) > 0)
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
        setTxHistory(h => [{ sig, type: "transaction", ts: Date.now() }, ...h].slice(0, 20));
        setTimeout(() => { fetchVaults(); fetchPositions(); }, 2000);
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

        // Resolve gate account for deposit: required when vault.gate_mint != SystemProgram
        const gateMint = new PublicKey((vaultRaw.gateMint as PublicKey).toBase58());
        const isGatingEnabled = gateMint.toBase58() !== PublicKey.default.toBase58() &&
          gateMint.toBase58() !== SystemProgram.programId.toBase58();
        const userGateAccount = isGatingEnabled
          ? await getAssociatedTokenAddress(gateMint, publicKey)
          : null;

        const isSOL = mintPubkey.toBase58() === NATIVE_MINT.toBase58();
        const preIxs: anchor.web3.TransactionInstruction[] = [];
        const postIxs: anchor.web3.TransactionInstruction[] = [];

        if (isSOL) {
          const ataInfo = await connection.getAccountInfo(userTokenAccount);
          if (!ataInfo) {
            preIxs.push(createAssociatedTokenAccountInstruction(publicKey, userTokenAccount, publicKey, NATIVE_MINT));
          }
          preIxs.push(SP.transfer({ fromPubkey: publicKey, toPubkey: userTokenAccount, lamports: BigInt(amount.toString()) }));
          preIxs.push(createSyncNativeInstruction(userTokenAccount));
          postIxs.push(createCloseAccountInstruction(userTokenAccount, publicKey, publicKey));
        }

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
            userGateAccount: userGateAccount as any,
            whitelistEntry: null as any,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions(preIxs)
          .postInstructions(postIxs)
          .rpc({ skipPreflight: true, commitment: "confirmed", preflightCommitment: "confirmed" });
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

        // Treasury token account: derived from the vault's treasury WALLET address
        // (vaultRaw.treasury) — must always be passed, since withdraw() requires it
        // whenever the withdrawal realizes any profit (perf_fee > 0). Passing null
        // here caused every profitable withdrawal to fail (the exact bug hit live
        // in rounds 2/3/5 — see the program-side fix in withdraw()'s treasury check).
        const treasuryPubkey = new PublicKey((vaultRaw.treasury as PublicKey).toBase58());
        const treasuryTokenAccount = await getAssociatedTokenAddress(mintPubkey, treasuryPubkey);

        const gateMint = new PublicKey((vaultRaw.gateMint as PublicKey).toBase58());
        const isGatingEnabled = gateMint.toBase58() !== PublicKey.default.toBase58();
        const userGateAccount = isGatingEnabled
          ? await getAssociatedTokenAddress(gateMint, publicKey)
          : null;

        // Resolve whitelist entry PDA — only pass it if it actually exists on-chain,
        // otherwise the program treats the account as absent (no fee waiver).
        const [whitelistPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("wl"), vaultPubkey.toBuffer(), publicKey.toBuffer()],
          PROGRAM_ID
        );
        const whitelistInfo = await connection.getAccountInfo(whitelistPda);
        const whitelistEntry = whitelistInfo ? whitelistPda : null;

        const isSOL = mintPubkey.toBase58() === NATIVE_MINT.toBase58();
        const preIxs: anchor.web3.TransactionInstruction[] = [];
        const postIxs: anchor.web3.TransactionInstruction[] = [];

        // Ensure the user token account exists before the program tries to send tokens into it
        const ataInfo = await connection.getAccountInfo(userTokenAccount);
        if (!ataInfo) {
          preIxs.push(createAssociatedTokenAccountInstruction(publicKey, userTokenAccount, publicKey, mintPubkey));
        }
        // For SOL: after the program sends wSOL back, close the wSOL account → native SOL
        if (isSOL) {
          postIxs.push(createCloseAccountInstruction(userTokenAccount, publicKey, publicKey));
        }

        // Value the withdrawal against total vault value (idle + deployed) — must
        // match the on-chain math in withdraw() exactly (idle + total_deployed()),
        // since minAmountOut is what protects the user from being underpaid.
        const totalSharesBN: anchor.BN = vaultRaw.totalShares;
        const vaultTokenAcct = await connection.getTokenAccountBalance(vaultTokenAccount);
        const idleBN = new anchor.BN(vaultTokenAcct.value.amount);
        const protocolCount: number = vaultRaw.protocolCount;
        const protocols = (vaultRaw.protocols as any[]).slice(0, protocolCount);
        const totalDeployedBN = protocols.reduce(
          (sum: anchor.BN, p: any) => sum.add(p.deployedBalance as anchor.BN),
          new anchor.BN(0)
        );
        const totalValueBN = idleBN.add(totalDeployedBN);
        const amountOutBN = totalSharesBN.gtn(0) ? shares.mul(totalValueBN).div(totalSharesBN) : new anchor.BN(0);
        const minAmountOut = amountOutBN.muln(99).divn(100); // 1% slippage buffer

        // If idle can't cover the fair payout, bundle a recall instruction ahead
        // of withdraw() in the same transaction — recalls the vault's ENTIRE
        // position from whichever protocol currently holds the most (simplest
        // safe choice: no exchange-rate math needed, guaranteed to free up at
        // least that protocol's full deployed value; any excess just stays idle
        // until the keeper's next cycle redeploys it). Relies on the on-chain
        // recall_from_* change that allows any signer to call recall as long as
        // a matching withdraw() for the same user is in the same transaction —
        // see the "PERMISSIONLESS BY DESIGN" comments in lib.rs.
        if (idleBN.lt(amountOutBN) && protocols.length > 0) {
          const bestIdx = protocols.reduce(
            (best: number, p: any, i: number) => (p.deployedBalance.gt(protocols[best].deployedBalance) ? i : best),
            0
          );
          const bestProtocol = protocols[bestIdx];
          if ((bestProtocol.deployedBalance as anchor.BN).gtn(0)) {
            const label = Buffer.from(bestProtocol.label).toString("utf8").replace(/\0/g, "");
            const receiptAccountPubkey = new PublicKey((bestProtocol.vaultReceiptAccount as PublicKey).toBase58());
            const receiptBalance = await connection.getTokenAccountBalance(receiptAccountPubkey);
            const recallAmount = new anchor.BN(receiptBalance.value.amount);

            if (recallAmount.gtn(0)) {
              const res = await fetch(`/api/recall-accounts?label=${encodeURIComponent(label)}`);
              if (!res.ok) {
                throw new Error(`Insufficient idle liquidity and could not fetch recall accounts for ${label}`);
              }
              const { instructionName, accounts: apiAccounts, remainingAccounts } = await res.json();

              const receiptFieldByLabel: Record<string, string> = {
                "kamino-usdc": "vaultCollateralAccount",
                "kamino-sol": "vaultCollateralAccount",
                "marinade-sol": "vaultMsolAccount",
                "jito-sol": "vaultLstAccount",
                "solend-usdc": "vaultCollateralAccount",
              };
              const receiptFieldName = receiptFieldByLabel[label] ?? "vaultCollateralAccount";

              const recallAccounts: Record<string, PublicKey> = {
                keeper: publicKey,
                vault: vaultPubkey,
                txInstructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
                vaultAuthority: vaultAuthorityPda,
                vaultTokenAccount,
                [receiptFieldName]: receiptAccountPubkey,
              };
              for (const [key, val] of Object.entries(apiAccounts as Record<string, string | undefined>)) {
                if (val) recallAccounts[key] = new PublicKey(val);
              }

              let builder = (program.methods as any)[instructionName](bestIdx, recallAmount).accounts(recallAccounts);
              if (remainingAccounts) {
                builder = builder.remainingAccounts(
                  (remainingAccounts as string[]).map((pk) => ({
                    pubkey: new PublicKey(pk),
                    isSigner: false,
                    isWritable: false,
                  }))
                );
              }
              const recallIx = await builder.instruction();
              preIxs.unshift(recallIx); // must execute before withdraw() in the same tx
            }
          }
        }

        return program.methods
          .withdraw(shares, minAmountOut)
          .accountsPartial({
            user: publicKey,
            vault: vaultPubkey,
            vaultAuthority: vaultAuthorityPda,
            vaultTokenAccount,
            userTokenAccount,
            sharesMint,
            userPosition: positionPda,
            userSharesAccount,
            treasuryTokenAccount,
            userGateAccount: userGateAccount as any,
            whitelistEntry: whitelistEntry as any,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .preInstructions(preIxs)
          .postInstructions(postIxs)
          .rpc({ skipPreflight: true, commitment: "confirmed", preflightCommitment: "confirmed" });
      });
    },
    [publicKey, getProgram, wrapTx]
  );


  const updateSettings = useCallback(
    async (vaultAddress: string, autoCompound: boolean, autoRebalance: boolean) => {
      if (!publicKey) return;
      return wrapTx(async () => {
        const program = getProgram();
        return program.methods
          .updateSettings(autoCompound, autoRebalance)
          .accounts({ admin: publicKey, vault: new PublicKey(vaultAddress) })
          .rpc({ commitment: "confirmed" });
      });
    },
    [publicKey, getProgram, wrapTx]
  );

  const addToWhitelist = useCallback(
    async (vaultAddress: string, wallet: string) => {
      if (!publicKey) return;
      return wrapTx(async () => {
        const program = getProgram();
        const vaultPubkey = new PublicKey(vaultAddress);
        const walletPubkey = new PublicKey(wallet);
        const [whitelistPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("wl"), vaultPubkey.toBuffer(), walletPubkey.toBuffer()],
          PROGRAM_ID
        );
        return program.methods
          .addToWhitelist(walletPubkey)
          .accounts({
            admin: publicKey,
            vault: vaultPubkey,
            whitelistEntry: whitelistPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc({ commitment: "confirmed" });
      });
    },
    [publicKey, getProgram, wrapTx]
  );

  const removeFromWhitelist = useCallback(
    async (vaultAddress: string, wallet: string) => {
      if (!publicKey) return;
      return wrapTx(async () => {
        const program = getProgram();
        const vaultPubkey = new PublicKey(vaultAddress);
        const walletPubkey = new PublicKey(wallet);
        const [whitelistPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("wl"), vaultPubkey.toBuffer(), walletPubkey.toBuffer()],
          PROGRAM_ID
        );
        return program.methods
          .removeFromWhitelist(walletPubkey)
          .accounts({
            admin: publicKey,
            vault: vaultPubkey,
            whitelistEntry: whitelistPda,
          })
          .rpc({ commitment: "confirmed" });
      });
    },
    [publicKey, getProgram, wrapTx]
  );

  const isWhitelisted = useCallback(
    async (vaultAddress: string, wallet: string) => {
      const vaultPubkey = new PublicKey(vaultAddress);
      const walletPubkey = new PublicKey(wallet);
      const [whitelistPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("wl"), vaultPubkey.toBuffer(), walletPubkey.toBuffer()],
        PROGRAM_ID
      );
      const info = await connection.getAccountInfo(whitelistPda);
      return info !== null;
    },
    [connection]
  );

  return {
    vaults,
    positions,
    loading,
    txStatus,
    txError,
    vaultError,
    lastTxSig,
    txHistory,
    userGateBalance,
    deposit,
    withdraw,
    updateSettings,
    addToWhitelist,
    removeFromWhitelist,
    isWhitelisted,
    refresh: () => { fetchVaults(); fetchPositions(); },
  };
}
