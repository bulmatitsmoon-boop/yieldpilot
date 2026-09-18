"use client";
import { useCallback, useEffect, useState } from "react";
import { formatUnits, parseUnits, type WalletClient } from "viem";
import { hoodPublicClient } from "@/hooks/useHoodWallet";
import { erc20Abi, hoodVaultAbi, hookAbi } from "@/lib/hood/abi";
import { HOOD_WRAPPER_ADDRESS, HOOK_ADDRESS, POOL_KEY, USDE_ADDRESS, USDG_ADDRESS, TOKEN_META } from "@/lib/hood/constants";

export interface HoodPoolState {
  reserve0: bigint; // USDe
  reserve1: bigint; // USDG
  totalShares: bigint;
  bootstrapped: boolean;
}

export interface HoodUserState {
  balance0: bigint;
  balance1: bigint;
  userShares: bigint;
  isWhitelisted: boolean;
  allowance0: bigint;
  allowance1: bigint;
}

const DEADLINE_SECONDS = 3600;

export function useHoodPool() {
  const [pool, setPool] = useState<HoodPoolState | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [reserves, totalShares, bootstrapped] = await Promise.all([
        hoodPublicClient.readContract({
          address: HOOK_ADDRESS,
          abi: hookAbi,
          functionName: "getReserves",
          args: [POOL_KEY],
        }) as Promise<readonly [bigint, bigint]>,
        hoodPublicClient.readContract({
          address: HOOD_WRAPPER_ADDRESS,
          abi: hoodVaultAbi,
          functionName: "totalShares",
        }) as Promise<bigint>,
        hoodPublicClient.readContract({
          address: HOOD_WRAPPER_ADDRESS,
          abi: hoodVaultAbi,
          functionName: "bootstrapped",
        }) as Promise<boolean>,
      ]);
      setPool({ reserve0: reserves[0], reserve1: reserves[1], totalShares, bootstrapped });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15000);
    return () => clearInterval(id);
  }, [refresh]);

  return { pool, loading, refresh };
}

export function useHoodUser(address: `0x${string}` | null) {
  const [user, setUser] = useState<HoodUserState | null>(null);

  const refresh = useCallback(async () => {
    if (!address) {
      setUser(null);
      return;
    }
    const [balance0, balance1, userShares, isWhitelisted, allowance0, allowance1] = await Promise.all([
      hoodPublicClient.readContract({ address: USDE_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] }) as Promise<bigint>,
      hoodPublicClient.readContract({ address: USDG_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] }) as Promise<bigint>,
      hoodPublicClient.readContract({ address: HOOD_WRAPPER_ADDRESS, abi: hoodVaultAbi, functionName: "userShares", args: [address] }) as Promise<bigint>,
      hoodPublicClient.readContract({ address: HOOD_WRAPPER_ADDRESS, abi: hoodVaultAbi, functionName: "whitelist", args: [address] }) as Promise<boolean>,
      hoodPublicClient.readContract({ address: USDE_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [address, HOOD_WRAPPER_ADDRESS] }) as Promise<bigint>,
      hoodPublicClient.readContract({ address: USDG_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [address, HOOD_WRAPPER_ADDRESS] }) as Promise<bigint>,
    ]);
    setUser({ balance0, balance1, userShares, isWhitelisted, allowance0, allowance1 });
  }, [address]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { user, refresh };
}

export function fmtToken(amount: bigint, token: typeof USDE_ADDRESS | typeof USDG_ADDRESS, dp = 4) {
  const meta = TOKEN_META[token];
  return Number(formatUnits(amount, meta.decimals)).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function parseToken(amount: string, token: typeof USDE_ADDRESS | typeof USDG_ADDRESS): bigint {
  const meta = TOKEN_META[token];
  return parseUnits(amount || "0", meta.decimals);
}

/// Computes hook-level `sharesToMint` proportional to the desired token0/token1 amounts, the
/// same math the wrapper/hook itself use internally, so a preview matches the real result.
export function previewDepositShares(pool: HoodPoolState, amount0: bigint, amount1: bigint): bigint {
  if (pool.totalShares === 0n || pool.reserve0 === 0n) return amount0; // first depositor edge case, not expected post-bootstrap
  const fromReserve0 = (amount0 * pool.totalShares) / pool.reserve0;
  const fromReserve1 = pool.reserve1 > 0n ? (amount1 * pool.totalShares) / pool.reserve1 : fromReserve0;
  return fromReserve0 < fromReserve1 ? fromReserve0 : fromReserve1;
}

export async function approveIfNeeded(
  walletClient: WalletClient,
  account: `0x${string}`,
  token: `0x${string}`,
  currentAllowance: bigint,
  neededAmount: bigint
) {
  if (currentAllowance >= neededAmount) return null;
  const hash = await walletClient.writeContract({
    account,
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [HOOD_WRAPPER_ADDRESS, neededAmount],
    chain: walletClient.chain,
  });
  await hoodPublicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function depositToHood(
  walletClient: WalletClient,
  account: `0x${string}`,
  sharesToMint: bigint,
  maxAmount0: bigint,
  maxAmount1: bigint
) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
  const hash = await walletClient.writeContract({
    account,
    address: HOOD_WRAPPER_ADDRESS,
    abi: hoodVaultAbi,
    functionName: "deposit",
    args: [sharesToMint, maxAmount0, maxAmount1, deadline],
    chain: walletClient.chain,
  });
  return hoodPublicClient.waitForTransactionReceipt({ hash });
}

export async function withdrawFromHood(walletClient: WalletClient, account: `0x${string}`, sharesToBurn: bigint) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
  const hash = await walletClient.writeContract({
    account,
    address: HOOD_WRAPPER_ADDRESS,
    abi: hoodVaultAbi,
    functionName: "withdraw",
    args: [sharesToBurn, 0n, 0n, deadline],
    chain: walletClient.chain,
  });
  return hoodPublicClient.waitForTransactionReceipt({ hash });
}
