"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createWalletClient, createPublicClient, custom, http, type WalletClient, type PublicClient } from "viem";
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_CHAIN_PARAMS, ROBINHOOD_RPC_URL } from "@/lib/hood/constants";

/// Minimal EIP-1193 shape -- both window.ethereum (injected wallets) and the WalletConnect
/// provider satisfy this, so the rest of this hook doesn't need to know which one is active.
export interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  disconnect?: () => Promise<void>;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider & { providers?: (Eip1193Provider & { isMetaMask?: boolean })[]; isMetaMask?: boolean };
  }
}

/// Multiple installed wallets (e.g. Phantom, which also injects an EVM provider) fight over
/// `window.ethereum`. Whichever wins isn't necessarily MetaMask, and Phantom's EVM side isn't
/// aware of custom chains like Robinhood Chain -- explicitly pick out the real MetaMask provider
/// (`providers` is the de-facto multi-wallet array most extensions populate) rather than trusting
/// whichever provider happened to claim `window.ethereum` first.
function getMetaMaskProvider(): Eip1193Provider | null {
  const eth = window.ethereum;
  if (!eth) return null;
  const fromList = eth.providers?.find((p) => p.isMetaMask);
  if (fromList) return fromList;
  return eth.isMetaMask ? eth : null;
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

export const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

/// Connects an EVM wallet -- either an injected extension (MetaMask, Phantom's EVM provider,
/// etc.) or, for anyone without a desktop extension, WalletConnect (QR code / mobile deep link,
/// e.g. Phantom mobile, Rainbow, Trust Wallet). Deliberately built on plain EIP-1193 providers
/// rather than wagmi/RainbowKit -- keeps this feature self-contained rather than restructuring
/// the whole app's existing Solana wallet stack for one new chain.
export function useHoodWallet() {
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [walletClient, setWalletClient] = useState<WalletClient | null>(null);
  const [wrongNetwork, setWrongNetwork] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectionType, setConnectionType] = useState<"injected" | "walletconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const providerRef = useRef<Eip1193Provider | null>(null);

  const bindProvider = useCallback((provider: Eip1193Provider, address0: `0x${string}`, type: "injected" | "walletconnect") => {
    providerRef.current = provider;
    setAddress(address0);
    setWalletClient(createWalletClient({ chain: robinhoodChain, transport: custom(provider) }));
    setConnectionType(type);
  }, []);

  const refreshChain = useCallback(async () => {
    const provider = providerRef.current;
    if (!provider) return;
    const chainIdHex = (await provider.request({ method: "eth_chainId" })) as string;
    setWrongNetwork(parseInt(chainIdHex, 16) !== ROBINHOOD_CHAIN_ID);
  }, []);

  // Auto-reconnect an already-authorized injected wallet (no popup) on page load.
  useEffect(() => {
    const injected = getMetaMaskProvider();
    if (!injected) return;
    injected.request({ method: "eth_accounts" }).then((accs) => {
      const list = accs as string[];
      if (list.length > 0) bindProvider(injected, list[0] as `0x${string}`, "injected");
    });

    const onAccountsChanged = (...args: unknown[]) => {
      const accs = args[0] as string[];
      setAddress(accs.length > 0 ? (accs[0] as `0x${string}`) : null);
    };
    const onChainChanged = () => refreshChain();
    injected.on?.("accountsChanged", onAccountsChanged);
    injected.on?.("chainChanged", onChainChanged);
    return () => {
      injected.removeListener?.("accountsChanged", onAccountsChanged);
      injected.removeListener?.("chainChanged", onChainChanged);
    };
  }, [bindProvider, refreshChain]);

  useEffect(() => {
    if (providerRef.current) refreshChain();
  }, [address, refreshChain]);

  const connect = useCallback(async () => {
    setError(null);
    const injected = getMetaMaskProvider();
    if (!injected) {
      setError("MetaMask not found -- install it, or use \"Connect via mobile\" below. (If another wallet like Phantom is also installed, this button only ever looks for MetaMask.)");
      return;
    }
    setConnecting(true);
    try {
      const accs = (await injected.request({ method: "eth_requestAccounts" })) as string[];
      if (accs.length > 0) bindProvider(injected, accs[0] as `0x${string}`, "injected");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect wallet.");
    } finally {
      setConnecting(false);
    }
  }, [bindProvider]);

  const connectWalletConnect = useCallback(async () => {
    setError(null);
    if (!WALLETCONNECT_PROJECT_ID) {
      setError("Mobile wallet connect isn't configured yet -- check back soon.");
      return;
    }
    setConnecting(true);
    try {
      const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
      const wcProvider = await EthereumProvider.init({
        projectId: WALLETCONNECT_PROJECT_ID,
        chains: [ROBINHOOD_CHAIN_ID],
        rpcMap: { [ROBINHOOD_CHAIN_ID]: ROBINHOOD_RPC_URL },
        showQrModal: true,
        metadata: {
          name: "YieldPilot",
          description: "YieldPilot on Robinhood Chain",
          url: typeof window !== "undefined" ? window.location.origin : "https://yieldpilot.app",
          icons: [],
        },
      });
      await wcProvider.connect();
      const accs = wcProvider.accounts;
      if (accs.length > 0) bindProvider(wcProvider as unknown as Eip1193Provider, accs[0] as `0x${string}`, "walletconnect");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect via WalletConnect.");
    } finally {
      setConnecting(false);
    }
  }, [bindProvider]);

  const switchToRobinhoodChain = useCallback(async () => {
    const provider = providerRef.current;
    if (!provider) return;
    setError(null);
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: ROBINHOOD_CHAIN_PARAMS.chainId }],
      });
    } catch (switchError) {
      // 4902 = chain not added to the wallet yet
      const code = (switchError as { code?: number })?.code;
      if (code === 4902) {
        try {
          await provider.request({
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

  const disconnect = useCallback(async () => {
    if (connectionType === "walletconnect" && providerRef.current?.disconnect) {
      try {
        await providerRef.current.disconnect();
      } catch {
        // best-effort session cleanup
      }
    }
    providerRef.current = null;
    setAddress(null);
    setWalletClient(null);
    setConnectionType(null);
  }, [connectionType]);

  return {
    address,
    connected: !!address,
    connecting,
    connectionType,
    wrongNetwork,
    error,
    connect,
    connectWalletConnect,
    walletConnectAvailable: !!WALLETCONNECT_PROJECT_ID,
    disconnect,
    switchToRobinhoodChain,
    walletClient,
  };
}

