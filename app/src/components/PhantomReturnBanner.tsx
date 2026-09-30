"use client";

import type { PhantomResult } from "@/lib/phantomDeeplink";

/// Shows the outcome of a Phantom deeplink round trip once, right after the page reloads
/// back from the Phantom app. Takes the already-decrypted result as a prop from
/// WalletProvider.tsx rather than reading storage itself -- avoids a real ordering race
/// where this component's own mount effect could fire before the parent has actually
/// processed the return.
export function PhantomReturnBanner({ result, onDismiss }: { result: PhantomResult | null; onDismiss: () => void }) {
  if (!result) return null;

  const isConnect = result.kind === "connect";
  const isPending = result.ok && result.pending;
  return (
    <div
      role="status"
      style={{
        position: "fixed", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 200,
        maxWidth: "calc(100vw - 32px)", padding: "12px 18px", borderRadius: 10,
        background: isPending ? "#1e293b" : result.ok ? "#052e16" : "#450a0a",
        border: `1px solid ${isPending ? "#334155" : result.ok ? "#166534" : "#7f1d1d"}`,
        color: isPending ? "#cbd5e1" : result.ok ? "#86efac" : "#fca5a5",
        fontSize: 13, display: "flex", alignItems: "center", gap: 10,
      }}
    >
      <span>
        {isPending
          ? `Confirming${result.label ? ` ${result.label.toLowerCase()}` : " transaction"}...`
          : result.ok
          ? isConnect
            ? "Wallet connected."
            : `${result.label || "Transaction"} confirmed.`
          : `${isConnect ? "Connect" : result.label || "Transaction"} ${result.error?.toLowerCase().includes("reject") ? "cancelled" : "failed"}${result.error ? `: ${result.error}` : "."}`}
      </span>
      {!isPending && (
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 }}
        >
          ×
        </button>
      )}
    </div>
  );
}
