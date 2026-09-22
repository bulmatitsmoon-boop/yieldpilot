"use client";
import { useCallback, useEffect, useState } from "react";
import { formatUnits, parseUnits, type WalletClient } from "viem";
import { hoodPublicClient } from "@/hooks/useHoodWallet";
import { erc20Abi } from "@/lib/hood/abi";
import { lpVaultAbi } from "@/lib/hood/lpAbi";
import { LP_VAULT_ADDRESS } from "@/lib/hood/lpConstants";
import { USDG_ADDRESS } from "@/lib/hood/constants";

export interface LpVaultState {
  totalAssets: bigint; // USDG units (6 dec)
  totalShares: bigint;
  depositCap: bigint;
  depositsPaused: boolean;
}

export interface LpUserState {
  usdgBalance: bigint;
  usdgAllowance: bigint;
  shares: bigint;
  value: bigint; // current USDG value of the user's shares, before the profit fee
  costBasis: bigint; // USDG actually paid in
}

export function useLpVaultState() {
  const [state, setState] = useState<LpVaultState | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [totalAssets, totalShares, depositCap, depositsPaused] = await Promise.all([
        hoodPublicClient.readContract({ address: LP_VAULT_ADDRESS, abi: lpVaultAbi, functionName: "totalAssets" }) as Promise<bigint>,
        hoodPublicClient.readContract({ address: LP_VAULT_ADDRESS, abi: lpVaultAbi, functionName: "totalShares" }) as Promise<bigint>,
        hoodPublicClient.readContract({ address: LP_VAULT_ADDRESS, abi: lpVaultAbi, functionName: "depositCap" }) as Promise<bigint>,
        hoodPublicClient.readContract({ address: LP_VAULT_ADDRESS, abi: lpVaultAbi, functionName: "depositsPaused" }) as Promise<boolean>,
      ]);
      setState({ totalAssets, totalShares, depositCap, depositsPaused });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15000);
    return () => clearInterval(id);
  }, [refresh]);

  return { state, loading, refresh };
}

export function useLpUser(address: `0x${string}` | null) {
  const [user, setUser] = useState<LpUserState | null>(null);

  const refresh = useCallback(async () => {
    if (!address) {
      setUser(null);
      return;
    }
    const [usdgBalance, usdgAllowance, shares, value, costBasis] = await Promise.all([
      hoodPublicClient.readContract({ address: USDG_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] }) as Promise<bigint>,
      hoodPublicClient.readContract({ address: USDG_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [address, LP_VAULT_ADDRESS] }) as Promise<bigint>,
      hoodPublicClient.readContract({ address: LP_VAULT_ADDRESS, abi: lpVaultAbi, functionName: "shares", args: [address] }) as Promise<bigint>,
      hoodPublicClient.readContract({ address: LP_VAULT_ADDRESS, abi: lpVaultAbi, functionName: "valueOf", args: [address] }) as Promise<bigint>,
      hoodPublicClient.readContract({ address: LP_VAULT_ADDRESS, abi: lpVaultAbi, functionName: "costBasis", args: [address] }) as Promise<bigint>,
    ]);
    setUser({ usdgBalance, usdgAllowance, shares, value, costBasis });
  }, [address]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { user, refresh };
}

export function fmtUsdg(amount: bigint, dp = 4) {
  return Number(formatUnits(amount, 6)).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function parseUsdg(amount: string): bigint {
  return parseUnits(amount || "0", 6);
}

export async function approveUsdgIfNeeded(
  walletClient: WalletClient,
  account: `0x${string}`,
  currentAllowance: bigint,
  neededAmount: bigint
) {
  if (currentAllowance >= neededAmount) return null;
  const hash = await walletClient.writeContract({
    account,
    address: USDG_ADDRESS,
    abi: erc20Abi,
    functionName: "approve",
    args: [LP_VAULT_ADDRESS, neededAmount],
    chain: walletClient.chain,
  });
  await hoodPublicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function depositToLpVault(walletClient: WalletClient, account: `0x${string}`, usdgIn: bigint) {
  const hash = await walletClient.writeContract({
    account,
    address: LP_VAULT_ADDRESS,
    abi: lpVaultAbi,
    functionName: "deposit",
    args: [usdgIn],
    chain: walletClient.chain,
  });
  return hoodPublicClient.waitForTransactionReceipt({ hash });
}

export async function withdrawFromLpVault(walletClient: WalletClient, account: `0x${string}`, sharesIn: bigint) {
  const hash = await walletClient.writeContract({
    account,
    address: LP_VAULT_ADDRESS,
    abi: lpVaultAbi,
    functionName: "withdraw",
    args: [sharesIn],
    chain: walletClient.chain,
  });
  return hoodPublicClient.waitForTransactionReceipt({ hash });
}
