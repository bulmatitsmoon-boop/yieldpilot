"use client";

import { useState } from "react";

/**
 * BuyCryptoButton.tsx — opens the MoonPay on-ramp widget so a user with no SOL/USDC yet
 * can buy some with a card, landing directly in their own connected wallet (never YieldPilot
 * custody) before depositing normally. Built 2026-10-20 — see project memory
 * (project_future_feature_ideas / the "onramp for normies" line in recent posts).
 *
 * Deliberately NOT a backend integration: MoonPay's Web SDK is a client-side script that
 * opens their own hosted widget as an overlay. MoonPay collects the actual payment details
 * inside their own UI — this code never touches card data, same boundary as Stripe Checkout
 * or any other hosted payment widget.
 *
 * `environment` is read from NEXT_PUBLIC_MOONPAY_ENV (defaults to "sandbox") rather than
 * hardcoded, specifically so switching to real money later is a Vercel env var change, not
 * a code change -- the publishable key currently configured is a pk_test_ key, and sandbox
 * transactions must never run against anything but a test key (MoonPay's own quickstart docs
 * warn a real card used against a sandbox widget can get the account flagged).
 *
 * Currency codes (sol / usdc_sol) verified live against MoonPay's own
 * GET https://api.moonpay.com/v3/currencies -- usdc_sol's on-chain contractAddress matches
 * our own USDC mint (EPjFWdd...) exactly, confirming it's the right code for Solana USDC
 * specifically (MoonPay has a separate usdc_* code per chain).
 */

declare global {
  interface Window {
    MoonPayWebSdk?: {
      init: (config: Record<string, unknown>) => { show: () => void; close: () => void };
    };
  }
}

const SDK_URL = "https://static.moonpay.com/web-sdk/v1/moonpay-web-sdk.min.js";

let sdkLoadPromise: Promise<void> | null = null;
function loadMoonPaySdk(): Promise<void> {
  if (window.MoonPayWebSdk) return Promise.resolve();
  if (sdkLoadPromise) return sdkLoadPromise;
  sdkLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load the MoonPay widget — try again in a moment."));
    document.head.appendChild(script);
  });
  return sdkLoadPromise;
}

interface Props {
  walletAddress: string | null;
  /** "SOL" or "USDC" — which asset the user is about to need (matches the Safe vault's
   *  currently-selected leg, so the widget defaults to the right thing). */
  asset: "SOL" | "USDC";
}

export function BuyCryptoButton({ walletAddress, asset }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apiKey = process.env.NEXT_PUBLIC_MOONPAY_API_KEY;
  // Defaults to sandbox on purpose -- see the module doc comment above for why this must
  // never silently become "production" without an explicit env var change.
  const environment = process.env.NEXT_PUBLIC_MOONPAY_ENV === "production" ? "production" : "sandbox";

  if (!apiKey) return null; // not configured yet — render nothing rather than a dead button

  async function openWidget() {
    if (!walletAddress) return;
    setError(null);
    setLoading(true);
    try {
      await loadMoonPaySdk();
      const sdk = window.MoonPayWebSdk!.init({
        flow: "buy",
        environment,
        variant: "overlay",
        params: {
          apiKey,
          baseCurrencyCode: "usd",
          defaultCurrencyCode: asset === "SOL" ? "sol" : "usdc_sol",
          walletAddress,
        },
      });
      sdk.show();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ marginBottom: 10 }}>
      <button
        onClick={openWidget}
        disabled={!walletAddress || loading}
        style={{
          background: "none", border: "1px solid var(--line)", color: "var(--text-mid)",
          fontSize: 12, padding: "6px 12px", borderRadius: 7, cursor: walletAddress ? "pointer" : "not-allowed",
          fontFamily: "var(--font-body)", display: "inline-flex", alignItems: "center", gap: 6,
        }}
      >
        💳 {loading ? "Opening…" : `Buy ${asset} with card`}
        {environment === "sandbox" && (
          <span style={{ color: "var(--warn)", fontSize: 10, fontWeight: 700, textTransform: "uppercase" }}>test mode</span>
        )}
      </button>
      {error && <div style={{ color: "var(--loss)", fontSize: 11.5, marginTop: 6 }}>{error}</div>}
    </div>
  );
}
