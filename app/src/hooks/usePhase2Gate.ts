"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { phase2Visible } from "@/lib/phase2Access.mjs";

/**
 * Client gate for Phase 2 (LP + split-deposit) pages.
 *
 * Visible when the reveal flag is on OR the connected wallet is the admin. Because
 * autoConnect populates the wallet a beat after mount, `deciding` stays true for a short
 * grace window so an admin's page does not flash a 404 before their wallet reconnects.
 * Callers should render nothing (or a spinner) while `deciding`, then `notFound()` if not
 * `visible`.
 *
 * See phase2Access.mjs — this is a preview gate, not a security boundary.
 */
export function usePhase2Gate(): {
  visible: boolean;
  adminPreview: boolean;
  deciding: boolean;
} {
  const { publicKey, connecting } = useWallet();
  const flagOn = process.env.NEXT_PUBLIC_LP_ENABLED === "true";
  const adminWallet = process.env.NEXT_PUBLIC_ADMIN_WALLET;

  const { visible, adminPreview } = phase2Visible(
    publicKey ? publicKey.toBase58() : null,
    flagOn,
    adminWallet
  );

  // Grace window for autoConnect so a returning admin isn't 404'd mid-reconnect.
  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGraceOver(true), 500);
    return () => clearTimeout(t);
  }, []);

  // Still deciding while the wallet is connecting or the grace window is open — but only
  // when the flag is off (if the flag is on, everyone is allowed and there's nothing to wait for).
  const deciding = !flagOn && !visible && (connecting || !graceOver);

  return { visible, adminPreview, deciding };
}
