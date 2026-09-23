"use client";

import { useCallback } from "react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useWallet } from "@solana/wallet-adapter-react";
import { PhantomDeeplinkWalletName } from "./wallets/PhantomDeeplinkAdapter";

/**
 * Shared click handler for every "Connect" / "Connect Wallet" button in the app.
 *
 * MOBILE FIX (2026-08-03, superseded 2026-09-22) — the reported "wallet connect isn't
 * working on mobile" bug.
 *
 * Root cause: on a real mobile browser tab (Safari/Chrome on a phone — NOT a wallet's
 * own in-app browser) there is no browser extension to inject a provider, so
 * PhantomWalletAdapter reports readyState "NotDetected" and selecting it in the modal
 * does nothing at all, with no error. The modal itself opens fine, which is why this
 * looked like a UI bug rather than an adapter-availability one.
 *
 * ORIGINAL fix (2026-08-03): send the user into Phantom's in-app BROWSER, taking over the
 * whole browsing session. Works, but Lloyd wanted the connect step itself to round-trip
 * back to the user's own browser tab instead of handing the whole session to Phantom's
 * browser — see PhantomDeeplinkAdapter, which implements Phantom's real Connect deeplink
 * (leaves to Phantom, approve, comes straight back here). That adapter is registered in
 * WalletProvider.tsx; this hook just selects+connects it directly instead of opening the
 * modal, since every entry in the modal besides it is unreachable on mobile anyway.
 *
 * Deliberately NOT solved with a Mobile Wallet Adapter package. Both were tried and
 * verified live before landing the original fix:
 *   - @solana-mobile/wallet-adapter-mobile: silently never registered (its real v2.x
 *     constructor takes a different shape than the docs example used, and that class
 *     isn't meant for the `wallets` array at all).
 *   - @solana-mobile/wallet-standard-mobile: pulled ~226 transitive packages and
 *     force-bumped bs58 to a new major on a live money-handling app, which broke
 *     client-side React hydration site-wide on the preview deploy (every button on
 *     every page inert, desktop included). A green build does not catch this.
 * MWA is also Android-only, so it would have left iOS users broken regardless.
 */

function isMobileBrowser(): boolean {
  if (typeof window === "undefined") return false;
  return /Android|iPhone|iPad|iPod/i.test(window.navigator.userAgent);
}

/**
 * True when some wallet has injected a provider — i.e. a browser extension on desktop,
 * or we're inside a wallet app's in-app browser (a real provider exists there too, so
 * the normal desktop-style modal flow already works unchanged and should be preferred
 * over the deeplink adapter).
 */
function hasInjectedProvider(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as any;
  return Boolean(w.solana || w.solflare || w.phantom);
}

export function useConnectWallet(): () => void {
  const { setVisible } = useWalletModal();
  const { select, connect } = useWallet();

  return useCallback(() => {
    if (isMobileBrowser() && !hasInjectedProvider()) {
      select(PhantomDeeplinkWalletName);
      // select() only stages the choice; wallet-adapter-react connects on the next
      // render via its own effect, but calling connect() here too is a harmless no-op
      // in that case and is what actually fires it the first time a given wallet name
      // is selected (mirrors the library's own WalletModal button behavior).
      connect().catch(() => {
        // PhantomDeeplinkWalletAdapter's connect() never resolves by design (redirects
        // the whole page away) -- this only ever catches a genuine, immediate failure.
      });
      return;
    }
    setVisible(true);
  }, [setVisible, select, connect]);
}
