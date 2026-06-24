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
const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://misty-misty-night.solana-mainnet.quiknode.pro/2d88bb1c0c939a28ab1e0c99aa863249b9d947a2/";

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
