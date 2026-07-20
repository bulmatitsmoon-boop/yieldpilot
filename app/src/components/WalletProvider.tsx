"use client";

import React, { useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { clusterApiUrl } from "@solana/web3.js";

import "@solana/wallet-adapter-react-ui/styles.css";

const NETWORK = (process.env.NEXT_PUBLIC_SOLANA_NETWORK as any) || "mainnet-beta";
// SSR-only fallback (never actually reaches a browser — see endpoint below).
// Fallback is the public Solana RPC (heavily rate-limited but has zero
// embedded credentials) — NEVER hardcode a paid provider's URL here. A real
// QuickNode URL with an embedded token was previously hardcoded here; found
// during a security audit and removed — see project memory.
const SSR_FALLBACK_RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || clusterApiUrl(NETWORK);

// Wallet adapter FC types lag behind @types/react@18 — cast to any
const Conn = ConnectionProvider as any;
const WProv = WalletProvider as any;
const WMProv = WalletModalProvider as any;

export function WalletContextProvider({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );

  // Route every RPC call through the app's own /api/rpc proxy instead of
  // talking to the real provider directly. Two reasons:
  // 1. NEXT_PUBLIC_RPC_URL is, by definition, shipped to every visitor's
  //    browser — if it's ever set to a real paid provider URL (Helius/
  //    QuickNode), that API key is visible in plain sight in the network
  //    tab of anyone who opens devtools. /api/rpc keeps the real target in
  //    a server-only env var (MAINNET_RPC_URL), never exposed to the client.
  // 2. /api/rpc already has real Upstash-Redis-backed rate limiting wired up
  //    (40 req/10s/IP) that was otherwise protecting nothing, since nothing
  //    in the app actually called it — see project memory, 2026-07-09 audit.
  // Computed client-side (window.location.origin) rather than hardcoded so
  // this works correctly on preview deployments too, not just production.
  // No WebSocket subscriptions are used anywhere in this app (confirmed via
  // a full-repo search), so a plain HTTP JSON-RPC proxy is sufficient — the
  // wallet-adapter's default derived wsEndpoint is simply never used.
  const endpoint = useMemo(() => {
    if (typeof window !== "undefined") {
      return `${window.location.origin}/api/rpc`;
    }
    return SSR_FALLBACK_RPC_URL; // never actually reaches a browser
  }, []);

  return (
    <Conn endpoint={endpoint}>
      <WProv wallets={wallets} autoConnect>
        <WMProv>{children}</WMProv>
      </WProv>
    </Conn>
  );
}
