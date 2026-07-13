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
// Fallback is the public Solana RPC (heavily rate-limited but has zero
// embedded credentials) — NEVER hardcode a paid provider's URL here. This
// file is a client component, so anything in it ships to every visitor's
// browser and sits in git history regardless of what NEXT_PUBLIC_RPC_URL is
// currently set to in Vercel. A real QuickNode URL with an embedded token
// was previously hardcoded here; found during a security audit and removed
// — rotate that QuickNode key if it's still live, same as the earlier
// Helius key rotation (see project_yieldpilot_critical_keys.md).
const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || clusterApiUrl(NETWORK);

// Wallet adapter FC types lag behind @types/react@18 — cast to any
const Conn = ConnectionProvider as any;
const WProv = WalletProvider as any;
const WMProv = WalletModalProvider as any;

export function WalletContextProvider({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );

  return (
    <Conn endpoint={RPC_URL}>
      <WProv wallets={wallets} autoConnect>
        <WMProv>{children}</WMProv>
      </WProv>
    </Conn>
  );
}
