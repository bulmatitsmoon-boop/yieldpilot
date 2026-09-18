"use client";
import { useCallback, useEffect, useState } from "react";
import { createWalletClient, createPublicClient, custom, http, type WalletClient, type PublicClient } from "viem";
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_CHAIN_PARAMS, ROBINHOOD_RPC_URL } from "@/lib/hood/constants";

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on?: (event: string, handler: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
    };
  }
}

const robinhoodChain = {
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_RPC_URL] } },
} as const;

// Public (read-only) client -- always available, no wallet needed.
export const hoodPublicClient: PublicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(ROBINHOOD_RPC_URL),
}) as PublicClient;

/// Connects an injected EVM wallet (MetaMask, etc.), switching/adding Robinhood Chain as needed.
/// Deliberately a plain window.ethereum integration (no wagmi/RainbowKit) -- keeps this feature
/// self-contained rather than restructuring the whole app's wallet stack for one new chain.
export function useHoodWallet() {
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [walletClient, setWalletClient] = useState<WalletClient | null>(null);
  const [wrongNetwork, setWrongNetwork] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshChain = useCallback(async () => {
    if (!window.ethereum) return;
    const chainIdHex = (await window.ethereum.request({ method: "eth_chainId" })) as string;
    setWrongNetwork(parseInt(chainIdHex, 16) !== ROBINHOOD_CHAIN_ID);
  }, []);

  useEffect(() => {
    if (!window.ethereum) return;
    window.ethereum.request({ method: "eth_accounts" }).then((accs) => {
      const list = accs as string[];
      if (list.length > 0) {
        setAddress(list[0] as `0x${string}`);
        setWalletClient(createWalletClient({ chain: robinhoodChain, transport: custom(window.ethereum!) }));
      }
    });
    refreshChain();

    const onAccountsChanged = (...args: unknown[]) => {
      const accs = args[0] as string[];
      setAddress(accs.length > 0 ? (accs[0] as `0x${string}`) : null);
    };
    const onChainChanged = () => refreshChain();
    window.ethereum.on?.("accountsChanged", onAccountsChanged);
    window.ethereum.on?.("chainChanged", onChainChanged);
    return () => {
      window.ethereum?.removeListener?.("accountsChanged", onAccountsChanged);
      window.ethereum?.removeListener?.("chainChanged", onChainChanged);
    };
  }, [refreshChain]);

  const connect = useCallback(async () => {
    setError(null);
    if (!window.ethereum) {
      setError("No wallet found -- install MetaMask or another EVM wallet extension.");
      return;
    }
    setConnecting(true);
    try {
      const accs = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
      if (accs.length > 0) {
        setAddress(accs[0] as `0x${string}`);
        setWalletClient(createWalletClient({ chain: robinhoodChain, transport: custom(window.ethereum) }));
      }
      await refreshChain();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect wallet.");
    } finally {
      setConnecting(false);
    }
  }, [refreshChain]);

  const switchToRobinhoodChain = useCallback(async () => {
    if (!window.ethereum) return;
    setError(null);
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: ROBINHOOD_CHAIN_PARAMS.chainId }],
      });
    } catch (switchError) {
      // 4902 = chain not added to the wallet yet
      const code = (switchError as { code?: number })?.code;
      if (code === 4902) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [ROBINHOOD_CHAIN_PARAMS],
          });
        } catch (addError) {
          setError(addError instanceof Error ? addError.message : "Failed to add Robinhood Chain.");
        }
      } else {
        setError(switchError instanceof Error ? switchError.message : "Failed to switch network.");
      }
    }
    await refreshChain();
  }, [refreshChain]);

  const disconnect = useCallback(() => {
    setAddress(null);
    setWalletClient(null);
  }, []);

  return { address, connected: !!address, connecting, wrongNetwork, error, connect, disconnect, switchToRobinhoodChain, walletClient };
}
