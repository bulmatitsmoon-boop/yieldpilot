"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseAbiItem } from "viem";
import { hoodPublicClient } from "@/hooks/useHoodWallet";
import {
  HOOD_WRAPPER_ADDRESS,
  USDE_ADDRESS,
  USDG_ADDRESS,
  HOOD_TREASURY_ADDRESS,
  ROBINHOOD_EXPLORER_URL,
  HOOK_ADDRESS,
  POOL_KEY,
} from "@/lib/hood/constants";
import { hoodVaultAbi, hookAbi, erc20Abi } from "@/lib/hood/abi";

export interface HoodActivity {
  id: string; // tx hash
  chain: "robinhood";
  blockTime: number | null;
  explorerUrl: string;
}

export interface HoodFleetStats {
  hoodDepositedUsd: number; // real pool reserves, stablecoins ~= USD 1:1
  hoodFeesUsd: number; // real treasury balance -- all-time fee revenue collected
  hoodActivePositions: number; // unique real depositors with a nonzero share balance right now
  hoodActivity: HoodActivity[];
  loading: boolean;
}

const depositedEvent = parseAbiItem("event Deposited(address indexed user, uint256 amount0, uint256 amount1, uint256 sharesMinted)");
const withdrawnEvent = parseAbiItem("event Withdrawn(address indexed user, uint256 amount0, uint256 amount1, uint256 sharesBurned, uint256 feeBps)");

/// Real, on-chain Robinhood Chain stats -- same "no fabricated numbers" discipline as
/// useFleetStats.ts on the Solana side. Deliberately queries real event logs + real
/// contract reads, not a cached/estimated figure.
export function useHoodFleetStats(): HoodFleetStats {
  const [hoodDepositedUsd, setHoodDepositedUsd] = useState(0);
  const [hoodFeesUsd, setHoodFeesUsd] = useState(0);
  const [hoodActivePositions, setHoodActivePositions] = useState(0);
  const [hoodActivity, setHoodActivity] = useState<HoodActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const requestIdRef = useRef(0);

  const fetchStats = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    try {
      const [reserves, treasuryUsde, treasuryUsdg, depositLogs, withdrawLogs] = await Promise.all([
        hoodPublicClient.readContract({
          address: HOOK_ADDRESS,
          abi: hookAbi,
          functionName: "getReserves",
          args: [POOL_KEY],
        }) as Promise<readonly [bigint, bigint]>,
        hoodPublicClient.readContract({ address: USDE_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [HOOD_TREASURY_ADDRESS] }) as Promise<bigint>,
        hoodPublicClient.readContract({ address: USDG_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [HOOD_TREASURY_ADDRESS] }) as Promise<bigint>,
        hoodPublicClient.getLogs({
          address: HOOD_WRAPPER_ADDRESS,
          event: depositedEvent,
          fromBlock: "earliest",
          toBlock: "latest",
        }),
        hoodPublicClient.getLogs({
          address: HOOD_WRAPPER_ADDRESS,
          event: withdrawnEvent,
          fromBlock: "earliest",
          toBlock: "latest",
        }),
      ]);

      if (requestId !== requestIdRef.current) return;

      // Reserves are USDe (18 dec) + USDG (6 dec), both real stablecoins ~= $1 each.
      const depositedUsd = Number(reserves[0]) / 1e18 + Number(reserves[1]) / 1e6;
      const feesUsd = Number(treasuryUsde) / 1e18 + Number(treasuryUsdg) / 1e6;

      // Unique real depositor addresses (from real Deposited events), then check who
      // STILL holds a nonzero share balance right now -- not just "ever deposited".
      const uniqueUsers = Array.from(new Set(depositLogs.map((l) => l.args.user as `0x${string}`)));
      const shareBalances = await Promise.all(
        uniqueUsers.map((u) =>
          hoodPublicClient.readContract({ address: HOOD_WRAPPER_ADDRESS, abi: hoodVaultAbi, functionName: "userShares", args: [u] }) as Promise<bigint>
        )
      );
      const activePositions = shareBalances.filter((s) => s > 0n).length;

      // Real recent activity, both deposits and withdrawals, most recent first.
      const allLogs = [...depositLogs, ...withdrawLogs].sort((a, b) => Number(b.blockNumber - a.blockNumber)).slice(0, 8);
      const blocks = await Promise.all(
        Array.from(new Set(allLogs.map((l) => l.blockNumber))).map((bn) => hoodPublicClient.getBlock({ blockNumber: bn }))
      );
      const blockTimeByNumber = new Map(blocks.map((b) => [b.number, Number(b.timestamp)]));
      const activity: HoodActivity[] = allLogs.map((l) => ({
        id: l.transactionHash,
        chain: "robinhood" as const,
        blockTime: blockTimeByNumber.get(l.blockNumber) ?? null,
        explorerUrl: `${ROBINHOOD_EXPLORER_URL}/tx/${l.transactionHash}`,
      }));

      if (requestId !== requestIdRef.current) return;
      setHoodDepositedUsd(depositedUsd);
      setHoodFeesUsd(feesUsd);
      setHoodActivePositions(activePositions);
      setHoodActivity(activity);
    } catch (err) {
      console.error("useHoodFleetStats error", err);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const id = setInterval(fetchStats, 60_000);
    return () => clearInterval(id);
  }, [fetchStats]);

  return { hoodDepositedUsd, hoodFeesUsd, hoodActivePositions, hoodActivity, loading };
}
