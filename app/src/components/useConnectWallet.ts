"use client";

import { useCallback } from "react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

/**
 * Shared click handler for every "Connect" / "Connect Wallet" button in the app.
 *
 * MOBILE FIX (2026-08-03) — the reported "wallet connect isn't working on mobile" bug.
 *
 * Root cause: on a real mobile browser tab (Safari/Chrome on a phone — NOT a wallet's
 * own in-app browser) there is no browser extension to inject a provider, so
 * PhantomWalletAdapter reports readyState "NotDetected" and selecting it in the modal
 * does nothing at all, with no error. The modal itself opens fine, which is why this
 * looked like a UI bug rather than an adapter-availability one.
 *
 * Fix: when we're on mobile with no injected provider, skip the modal (every entry in
 * it is unreachable anyway) and send the user into a wallet's in-app browser, where a
 * provider genuinely exists and the normal desktop flow works unchanged.
 *
 * Deliberately NOT solved with a Mobile Wallet Adapter package. Both were tried and
 * verified live before landing this:
 *   - @solana-mobile/wallet-adapter-mobile: silently never registered (its real v2.x
 *     constructor takes a different shape than the docs example used, and that class
 *     isn't meant for the `wallets` array at all).
 *   - @solana-mobile/wallet-standard-mobile: pulled ~226 transitive packages and
 *     force-bumped bs58 to a new major on a live money-handling app, which broke
 *     client-side React hydration site-wide on the preview deploy (every button on
 *     every page inert, desktop included). A green build does not catch this.
 * MWA is also Android-only, so it would have left iOS users broken regardless.
 * This approach costs zero new dependencies and covers both platforms.
 */

function isMobileBrowser(): boolean {
  if (typeof window === "undefined") return false;
  return /Android|iPhone|iPad|iPod/i.test(window.navigator.userAgent);
}

/**
 * True when some wallet has injected a provider — i.e. a browser extension on desktop,
 * or we're already inside a wallet app's in-app browser (where the deep link would be
 * both unnecessary and an infinite loop back into the same place).
 */
function hasInjectedProvider(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as any;
  return Boolean(w.solana || w.solflare || w.phantom);
}

export function useConnectWallet(): () => void {
  const { setVisible } = useWalletModal();

  return useCallback(() => {
    if (isMobileBrowser() && !hasInjectedProvider()) {
      // Phantom universal link — opens this exact page inside Phantom's in-app browser.
      // Format per Phantom's own deeplink docs: https://phantom.app/ul/browse/<url>?ref=<ref>
      // with BOTH values percent-encoded.
      const target = encodeURIComponent(window.location.href);
      const ref = encodeURIComponent(window.location.origin);
      window.location.href = `https://phantom.app/ul/browse/${target}?ref=${ref}`;
      return;
    }
    setVisible(true);
  }, [setVisible]);
}
