"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import IDL from "@/idl/yieldpilot.mainnet.json";
import { useSolPrice } from "@/hooks/useSolPrice";
import type { ProtocolApy } from "@/hooks/useApys";

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
  /** Same figure, but ticking in real time between on-chain snapshots. total_deposits
   *  only actually updates on-chain when a deposit/withdraw/rebalance reconciles it
   *  (confirmed live 2026-10-14: the keeper never calls reconcile() on a timer, only as
   *  a side effect of those actions) -- between those events totalGainedUsd above is
   *  frozen, which reads as broken for a "currently gaining" label. This interpolates
   *  forward from the last real snapshot using each vault's actual deployed balance x
   *  its live APY -- a real accrual rate, not an animation -- and re-anchors to the true
   *  on-chain value every time a fresh snapshot lands, so it can never drift into fiction.
   *  null while loading, same rule as totalGainedUsd. */
  totalGainedUsdLive: number | null;
  /** Cumulative, ALL-TIME realized gain across every vault, in USD-equivalent — reads
   *  the on-chain `lifetime_gains` counter directly (added 2026-08-03), which only ever
   *  increases and survives full withdrawals. This is the number that answers "how much
   *  has this ever earned", as distinct from totalGainedUsd's "how much is it earning
   *  right now". null while loading, same rule as totalGainedUsd. */
  lifetimeGainedUsd: number | null;
  loading: boolean;
}

/**
 * activePositions / totalDepositors: real counts from on-chain UserPosition +
 * LpUserPosition accounts (program.account["userPosition"].all() — Anchor's filter
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
 *
 * totalGainedUsdLive (added 2026-10-14): see the field's own doc comment above.
 */
export function useFleetStats(apys: ProtocolApy[] = []): FleetStats {
  const { connection } = useConnection();
  const solPrice = useSolPrice();
  const [activePositions, setActivePositions] = useState(0);
  const [totalDepositors, setTotalDepositors] = useState(0);
  const [recentActivity, setRecentActivity] = useState<FleetActivity[]>([]);
  const [totalGainedUsd, setTotalGainedUsd] = useState<number | null>(null);
  const [totalGainedUsdLive, setTotalGainedUsdLive] = useState<number | null>(null);
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
  // Real accrual rate (USD per millisecond), recomputed every snapshot from each
  // vault's actual deployed balance x its live APY -- the live-ticker's engine.
  const accrualRateRef = useRef(0);
  const lastSnapshotRef = useRef<{ value: number; atMs: number } | null>(null);

  const apysRef = useRef(apys);
  apysRef.current = apys;

  const fetch = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    try {
      const provider = new anchor.AnchorProvider(
        connection,
        { publicKey: PublicKey.default, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t },
        { commitment: "confirmed" }
      );
      const program = new anchor.Program(IDL as any, provider);

      const [positions, lpPositions, signatures, vaultAccounts] = await Promise.all([
        (program.account as any)["userPosition"].all(),
        // LP positions are a SEPARATE account type (lpUserPosition) from the safe-vault
        // UserPosition above — a real LP deposit was invisible to "active positions" and
        // every other stat here until this was added, confirmed live 2026-08-27.
        (program.account as any)["lpUserPosition"].all().catch(() => []),
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
      const withLpShares = lpPositions.filter((p: any) => (p.account.shares as anchor.BN).gtn(0));
      setActivePositions(withShares.length + withLpShares.length);
      setTotalDepositors(positions.length + lpPositions.length);
      setRecentActivity(
        signatures.map((s) => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null }))
      );

      let gainedUsd = 0;
      let lifetimeUsd = 0;
      let anyVaultResolved = false;
      // USD per millisecond this vault set is really earning right now, derived from
      // each vault's actual on-chain deployed balance x the live APY of whichever
      // protocol it's actually deployed to (not a blended/average rate).
      let accrualRateUsdPerMs = 0;
      const msPerYear = 365 * 24 * 60 * 60 * 1000;
      const liveApys = apysRef.current;

      VAULT_ADDRESSES.forEach((addr, i) => {
        const v = vaultAccounts[i];
        if (!v) return;
        anyVaultResolved = true;
        const isSol = (v.name as string).toUpperCase().includes("SOL");
        const decimals = isSol ? 1e9 : 1e6;

        // total_shares === 0 means nobody currently holds a claim on this vault. Whatever
        // total_deposits still reads in that state belongs to no depositor — it is not a
        // "realized gain currently sitting in the vault" for anyone, regardless of what the
        // raw field says. Confirmed live 2026-08-27: the SOL vault read total_deposits =
        // 33,139,492 lamports with total_shares = 0, idle balance = 0, and zero deployed
        // balance across all 4 registered protocols — money the on-chain data itself cannot
        // explain the location of. Attributing that to "currently gaining" produced a
        // completely fabricated-looking number the moment the vault's only depositor
        // withdrew everything. Treat a zero-share vault as contributing $0 here until the
        // underlying total_deposits accounting issue is found and fixed at the source —
        // showing nothing is honest; showing an unexplained number is not.
        if ((v.totalShares as anchor.BN).isZero()) return;

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

        // Accrual rate: sum each registered protocol's real deployedBalance x its live
        // APY. Only the protocol actually holding funds (deployedBalance > 0) ever
        // contributes — matches the on-chain reality of a winner-take-all router.
        const protocols = (v.protocols as any[]).slice(0, v.protocolCount as number);
        for (const p of protocols) {
          const deployedRaw = BigInt((p.deployedBalance as anchor.BN).toString());
          if (deployedRaw === 0n) continue;
          const label = Buffer.from(p.label as Buffer).toString("utf8").replace(/\0/g, "");
          const match = liveApys.find((a) => a.protocolId === label && !a.stale);
          if (!match) continue; // no live rate for this protocol — contribute nothing rather than guess
          const deployedUi = Number(deployedRaw) / decimals;
          const deployedUsd = isSol ? deployedUi * solPrice : deployedUi;
          accrualRateUsdPerMs += (deployedUsd * (match.apyPercent / 100)) / msPerYear;
        }
      });
      setTotalGainedUsd(anyVaultResolved ? gainedUsd : null);
      setLifetimeGainedUsd(anyVaultResolved ? lifetimeUsd : null);

      if (anyVaultResolved) {
        accrualRateRef.current = accrualRateUsdPerMs;
        lastSnapshotRef.current = { value: gainedUsd, atMs: Date.now() };
        setTotalGainedUsdLive(gainedUsd);
      } else {
        lastSnapshotRef.current = null;
        setTotalGainedUsdLive(null);
      }
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

  // The actual live tick: every second, re-anchor from the last real on-chain
  // snapshot plus (real accrual rate x elapsed ms) — never a free-running animation,
  // always pinned to the most recent truth.
  useEffect(() => {
    const id = setInterval(() => {
      const snap = lastSnapshotRef.current;
      if (!snap) return;
      const elapsedMs = Date.now() - snap.atMs;
      setTotalGainedUsdLive(snap.value + accrualRateRef.current * elapsedMs);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return { activePositions, totalDepositors, recentActivity, totalGainedUsd, totalGainedUsdLive, lifetimeGainedUsd, loading };
}
