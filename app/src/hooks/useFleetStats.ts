"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  /** Real, realized gain currently sitting in the vaults, in USD-equivalent — a LIVE
   *  snapshot (total_deposits minus current depositors' cost basis) that resets toward
   *  0 whenever everyone withdraws, since there's no longer anything "currently gaining."
   *  null while loading — never 0 as a placeholder, same rule as everywhere else here. */
  totalGainedUsd: number | null;
  /** Cumulative, ALL-TIME realized gain across every vault, in USD-equivalent — reads
   *  the on-chain `lifetime_gains` counter directly (added 2026-08-03), which only ever
   *  increases and survives full withdrawals. This is the number that answers "how much
   *  has this ever earned", as distinct from totalGainedUsd's "how much is it earning
   *  right now". null while loading, same rule as totalGainedUsd. */
  lifetimeGainedUsd: number | null;
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
  const [lifetimeGainedUsd, setLifetimeGainedUsd] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  // Guards against out-of-order responses: the effect below re-fires this fetch every
  // time solPrice ticks (not just every 60s), so two reads can be in flight at once —
  // with no cancellation, whichever RESOLVES last wins the setState calls, even if it
  // STARTED first and its data is now stale relative to a newer, faster response. Hit
  // live 2026-08-25: a poll landing mid-burst of our own recall/redeploy/withdraw
  // transactions produced one bogus "$2.39" reading before self-correcting on the next
  // tick. Each fetch stamps its own id; a response only commits state if it's still the
  // most recently STARTED call by the time it resolves — stale ones are discarded.
  const requestIdRef = useRef(0);

  const fetch = useCallback(async () => {
    const requestId = ++requestIdRef.current;
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

      // A newer fetch already started (and possibly finished) while this one was in
      // flight — discard this response rather than let a stale read overwrite it.
      if (requestId !== requestIdRef.current) return;

      const withShares = positions.filter((p: any) => (p.account.shares as anchor.BN).gtn(0));
      setActivePositions(withShares.length);
      setTotalDepositors(positions.length);
      setRecentActivity(
        signatures.map((s) => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null }))
      );

      let gainedUsd = 0;
      let lifetimeUsd = 0;
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

        // Falls back to 0 (not skipped) on vaults whose ProgramData predates the
        // 2026-08-03 upgrade — Anchor's Borsh decoder returns undefined for a field
        // added to the IDL but not yet present at that byte offset on an old account;
        // `?? 0n` treats that as "no lifetime gains recorded yet" rather than crashing.
        const lifetimeRaw = BigInt((v.lifetimeGains as anchor.BN | undefined)?.toString() ?? "0");
        const lifetimeUi = Number(lifetimeRaw) / decimals;
        lifetimeUsd += isSol ? lifetimeUi * solPrice : lifetimeUi;
      });
      setTotalGainedUsd(anyVaultResolved ? gainedUsd : null);
      setLifetimeGainedUsd(anyVaultResolved ? lifetimeUsd : null);
    } catch (err) {
      console.error("useFleetStats error", err);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [connection, solPrice]);

  useEffect(() => {
    fetch();
    const id = setInterval(fetch, 60_000);
    return () => clearInterval(id);
  }, [fetch]);

  return { activePositions, totalDepositors, recentActivity, totalGainedUsd, lifetimeGainedUsd, loading };
}
