"use client";

import React, { useEffect, useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import {
  registerMwa,
  createDefaultAuthorizationCache,
  createDefaultChainSelector,
  createDefaultWalletNotFoundHandler,
} from "@solana-mobile/wallet-standard-mobile";
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
  // MOBILE FIX (2026-08-03, corrected same day): PhantomWalletAdapter/SolflareWalletAdapter
  // both rely on detecting an injected `window.solana`/`window.solflare` browser-extension
  // provider. On a real mobile browser tab (not the wallet app's own in-app browser), no
  // extension exists, so neither adapter has anything to connect to — the connect modal
  // opens fine but tapping a wallet silently does nothing.
  //
  // First attempt used `@solana-mobile/wallet-adapter-mobile`'s SolanaMobileWalletAdapter,
  // added directly to this `wallets` array — shipped, then found LIVE (via a real click
  // through the deployed site, not just a build check) that it silently never appeared in
  // the connect modal at all. Root cause: that package's actual v2.x constructor takes
  // {appIdentity, authorizationCache, chains, chainSelector, onWalletNotFound} — NOT the
  // older {addressSelector, authorizationResultCache, cluster} shape a stale doc described.
  // Passing the wrong shape didn't throw (fields just went `undefined`), so it silently
  // failed instead of erroring, and — more fundamentally — that class isn't even meant to
  // go in the classic `wallets` array; per Solana Mobile's own current docs, the real
  // mechanism is `registerMwa()` from `@solana-mobile/wallet-standard-mobile`, called once
  // as a side effect: it self-registers as a Wallet Standard provider, and
  // `@solana/wallet-adapter-react`'s WalletProvider auto-detects Wallet-Standard wallets
  // on its own — no manual array entry needed at all.
  useEffect(() => {
    registerMwa({
      appIdentity: {
        name: "YieldPilot",
        uri: "https://yieldpilot.fund",
        icon: "/favicon.ico",
      },
      authorizationCache: createDefaultAuthorizationCache(),
      chains: NETWORK === "devnet" ? ["solana:devnet"] : ["solana:mainnet"],
      chainSelector: createDefaultChainSelector(),
      onWalletNotFound: createDefaultWalletNotFoundHandler(),
    });
  }, []);

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
        <WMProv>{children}</WMProv>
      </WProv>
    </Conn>
  );
}
