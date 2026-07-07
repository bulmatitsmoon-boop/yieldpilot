"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import IDL from "@/idl/yieldpilot.mainnet.json";

const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID || "CVJrJGoKjseTJqiFGctssYde3pLAnPaRZtjAaKXd8pWk"
);

export interface FleetActivity {
  signature: string;
  slot: number;
  blockTime: number | null;
}

export interface FleetStats {
  activePositions: number;
  totalDepositors: number; // includes zero-balance / closed positions
  recentActivity: FleetActivity[];
  loading: boolean;
}

/**
 * Real, program-wide aggregate stats — no fabricated numbers. Queries every
 * UserPosition account that exists on-chain (via Anchor's .all(), which
 * matches accounts by their real discriminator) and every recent signature
 * touching the program. Will legitimately show near-zero numbers pre-launch;
 * that's accurate, not a bug.
 */
export function useFleetStats(): FleetStats {
  const { connection } = useConnection();
  const [activePositions, setActivePositions] = useState(0);
  const [totalDepositors, setTotalDepositors] = useState(0);
  const [recentActivity, setRecentActivity] = useState<FleetActivity[]>([]);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    try {
      const provider = new anchor.AnchorProvider(
        connection,
        { publicKey: PublicKey.default, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t },
        { commitment: "confirmed" }
      );
      const program = new anchor.Program(IDL as any, provider);

      const [positions, signatures] = await Promise.all([
        (program.account as any)["userPosition"].all(),
        connection.getSignaturesForAddress(PROGRAM_ID, { limit: 8 }),
      ]);

      const withShares = positions.filter((p: any) => (p.account.shares as anchor.BN).gtn(0));
      setActivePositions(withShares.length);
      setTotalDepositors(positions.length);
      setRecentActivity(
        signatures.map((s) => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null }))
      );
    } catch (err) {
      console.error("useFleetStats error", err);
    } finally {
      setLoading(false);
    }
  }, [connection]);

  useEffect(() => {
    fetch();
    const id = setInterval(fetch, 60_000);
    return () => clearInterval(id);
  }, [fetch]);

  return { activePositions, totalDepositors, recentActivity, loading };
}
