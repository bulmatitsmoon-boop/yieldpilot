"use client";

import React, { useEffect, useMemo, useRef } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { clusterApiUrl } from "@solana/web3.js";
import { PhantomDeeplinkWalletAdapter } from "./wallets/PhantomDeeplinkAdapter";
import { PhantomReturnBanner } from "./PhantomReturnBanner";
import * as phantomDeeplink from "@/lib/phantomDeeplink";

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
  // A SolanaMobileWalletAdapter from @solana-mobile/wallet-adapter-mobile was briefly
  // tried here and is not present: it was verified LIVE on production to never appear in
  // the connect modal at all. Its real v2.x constructor takes {appIdentity,
  // authorizationCache, chains, chainSelector, onWalletNotFound} — not the
  // {addressSelector, authorizationResultCache, cluster} shape used here — so the wrong
  // keys silently became `undefined` instead of throwing, and that class isn't meant for
  // this array in the first place (MWA registers itself via the Wallet Standard). Note
  // @solana/wallet-adapter-react already carries the MWA package transitively, so nothing
  // is lost by not depending on it directly.
  //
  // Phantom's real Connect deeplink (round-trips back to THIS browser tab, not into
  // Phantom's own in-app browser) for mobile browsers with no injected provider — see
  // wallets/PhantomDeeplinkAdapter.ts and useConnectWallet.ts, which routes mobile users
  // to this adapter directly instead of showing PhantomWalletAdapter/SolflareWalletAdapter
  // (permanently "NotDetected" there).
  const phantomDeeplinkAdapter = useRef<PhantomDeeplinkWalletAdapter | null>(null);
  if (!phantomDeeplinkAdapter.current) {
    phantomDeeplinkAdapter.current = new PhantomDeeplinkWalletAdapter();
  }

  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter(), phantomDeeplinkAdapter.current!],
    []
  );

  // Result of a Phantom deeplink return, if this page load is one -- passed down to the
  // banner as a prop (not read independently by the banner itself) so there's no race
  // between two components both trying to read/clear the same one-shot storage key.
  const [phantomResult, setPhantomResult] = React.useState<phantomDeeplink.PhantomResult | null>(null);

  // Runs after WProv (below, a child in this tree) has already mounted and subscribed to
  // adapter events -- React fires child effects before parent effects on mount, so
  // emitting "connect" here is guaranteed to be caught, not missed.
  useEffect(() => {
    const result = phantomDeeplink.handleReturnIfPresent();
    if (result) {
      phantomDeeplinkAdapter.current?.handlePossibleReturn(result);
      setPhantomResult(result);
    }
  }, []);

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
  const endpoint = useMemo(() => {
    if (typeof window !== "undefined") {
      return `${window.location.origin}/api/rpc`;
    }
    return SSR_FALLBACK_RPC_URL; // never actually reaches a browser
  }, []);

  // WEBSOCKET FIX (2026-07-30): the comment that used to sit here claimed "no
  // WebSocket subscriptions are used anywhere in this app... the wallet-adapter's
  // default derived wsEndpoint is simply never used." That was wrong. web3.js's
  // Connection.confirmTransaction() subscribes over WebSocket internally for
  // "confirmed"/"finalized" commitment REGARDLESS of whether app code explicitly
  // calls .onSignature() — a source grep for "WebSocket" never turns that up,
  // because it's inside the library's own default confirm behavior, not visible
  // in application code. Left unconfigured, web3.js auto-derives the WS endpoint
  // by swapping https->wss on the SAME url — i.e. wss://<site>/api/rpc — but
  // /api/rpc is a plain Next.js POST route with no WebSocket upgrade support
  // (confirmed live: the upgrade attempt gets HTTP 405). The subscription can
  // never succeed, and every withdraw/deposit through the real site UI hung
  // forever on "Confirming on-chain..." — reproduced live via a connected
  // Phantom session, traced to this exact cause.
  //
  // Fix: point wsEndpoint at a real, working, keyless public WS RPC. Subscription
  // traffic is just "tell me when this one signature confirms" — lightweight,
  // and unlike the HTTP endpoint it carries no paid API key to protect.
  // ConnectionProvider's own default config is `{ commitment: 'confirmed' }` — passing
  // a `config` prop at all REPLACES that default outright (it isn't merged), so this
  // must restate `commitment` explicitly or every RPC call silently loses it.
  const connectionConfig = useMemo(() => ({
    commitment: "confirmed" as const,
    wsEndpoint: NETWORK === "devnet" ? "wss://api.devnet.solana.com" : "wss://api.mainnet-beta.solana.com",
  }), []);

  return (
    <Conn endpoint={endpoint} config={connectionConfig}>
      <WProv wallets={wallets} autoConnect>
        <WMProv>
          <PhantomReturnBanner result={phantomResult} onDismiss={() => setPhantomResult(null)} />
          {children}
        </WMProv>
      </WProv>
    </Conn>
  );
}
