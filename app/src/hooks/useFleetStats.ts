"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import IDL from "@/idl/yieldpilot.mainnet.json";
import { useSolPrice } from "@/hooks/useSolPrice";

const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID || "3tAEmHXZ51YVLe9ts8b9cMcgQPgaSamLxLtxR31VpREi"
);
const VAULT_ADDRESSES = (process.env.NEXT_PUBLIC_VAULT_ADDRESSES || "F1r513ZZdofz4tjhRfhNAYDK5hsmc8uCZbMmg2tkPJ6e,8KcoRt5DcCbXBaqDVDorEbW2J6GofTrRyy9Afzb8wwaE")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export interface FleetActivity {
  signature: string;
  slot: number;
  blockTime: number | null;
}

export interface FleetStats {
  activePositions: number;
  totalDepositors: number; // includes zero-balance / closed positions
  recentActivity: FleetActivity[];
  /** Real, realized gain across every vault and every wallet, in USD-equivalent.
   *  null while loading — never 0 as a placeholder, same rule as everywhere else here. */
  totalGainedUsd: number | null;
  loading: boolean;
}

/**
 * Real, program-wide aggregate stats — no fabricated numbers. Queries every
 * UserPosition account that exists on-chain (via Anchor's .all(), which
 * matches accounts by their real discriminator) and every recent signature
 * touching the program. Will legitimately show near-zero numbers pre-launch;
 * that's accurate, not a bug.
 *
 * totalGainedUsd (added 2026-07-30): for each vault, `total_deposits` minus the sum
 * of every position's `deposited_amount` is exactly the realized gain/loss the
 * program has booked — settle_recall's proportional model (#141) and reconcile()
 * keep total_deposits accurate, so this is no longer the "can't be computed
 * honestly" case that made "Total Earned" a labelled PROJECTION elsewhere in this
 * app (see dashboard/page.tsx's comment on that). This reads only fields the vault
 * itself already trusts — no protocol exchange-rate decoding, no estimate.
 */
export function useFleetStats(): FleetStats {
  const { connection } = useConnection();
  const solPrice = useSolPrice();
  const [activePositions, setActivePositions] = useState(0);
  const [totalDepositors, setTotalDepositors] = useState(0);
  const [recentActivity, setRecentActivity] = useState<FleetActivity[]>([]);
  const [totalGainedUsd, setTotalGainedUsd] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    try {
      const provider = new anchor.AnchorProvider(
        connection,
        { publicKey: PublicKey.default, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t },
        { commitment: "confirmed" }
      );
      const program = new anchor.Program(IDL as any, provider);

      const [positions, signatures, vaultAccounts] = await Promise.all([
        (program.account as any)["userPosition"].all(),
        connection.getSignaturesForAddress(PROGRAM_ID, { limit: 8 }),
        Promise.all(
          VAULT_ADDRESSES.map((addr) =>
            (program.account as any)["vault"].fetch(new PublicKey(addr)).catch(() => null)
          )
        ),
      ]);

      const withShares = positions.filter((p: any) => (p.account.shares as anchor.BN).gtn(0));
      setActivePositions(withShares.length);
      setTotalDepositors(positions.length);
      setRecentActivity(
        signatures.map((s) => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null }))
      );

      let gainedUsd = 0;
      let anyVaultResolved = false;
      VAULT_ADDRESSES.forEach((addr, i) => {
        const v = vaultAccounts[i];
        if (!v) return;
        anyVaultResolved = true;
        const isSol = (v.name as string).toUpperCase().includes("SOL");
        const decimals = isSol ? 1e9 : 1e6;

        const totalDepositsRaw = BigInt((v.totalDeposits as anchor.BN).toString());
        const depositedSumRaw = positions
          .filter((p: any) => (p.account.vault as PublicKey).toBase58() === addr)
          .reduce((sum: bigint, p: any) => sum + BigInt((p.account.depositedAmount as anchor.BN).toString()), 0n);
        // saturating: realized loss can't be represented as "negative gain" here,
        // and total_deposits should never legitimately fall below the sum of
        // individual cost bases anyway — floor at 0 rather than show a negative.
        const gainedRaw = totalDepositsRaw > depositedSumRaw ? totalDepositsRaw - depositedSumRaw : 0n;
        const gainedUi = Number(gainedRaw) / decimals;
        gainedUsd += isSol ? gainedUi * solPrice : gainedUi;
      });
      setTotalGainedUsd(anyVaultResolved ? gainedUsd : null);
    } catch (err) {
      console.error("useFleetStats error", err);
    } finally {
      setLoading(false);
    }
  }, [connection, solPrice]);

  useEffect(() => {
    fetch();
    const id = setInterval(fetch, 60_000);
    return () => clearInterval(id);
  }, [fetch]);

  return { activePositions, totalDepositors, recentActivity, totalGainedUsd, loading };
}
