"use client";

/**
 * LP vault page — Phase 2 groundwork, deliberately NOT linked from Header's
 * nav (desktop or mobile menu) or anywhere else in the app yet. Reachable
 * only by direct URL, and non-functional until the LP vault instructions
 * are actually deployed (see useLpVault.ts's top-of-file note).
 */
import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import * as anchor from "@coral-xyz/anchor";
import { useLpVault, LpVaultInfo } from "@/hooks/useLpVault";

export default function LpVaultPage() {
  const { connected } = useWallet();
  const { setVisible } = useWalletModal();
  const { txStatus, txError, fetchLpVault, depositLp } = useLpVault();

  const [lpVaultAddress, setLpVaultAddress] = useState("");
  const [vaultInfo, setVaultInfo] = useState<LpVaultInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [acknowledgeIL, setAcknowledgeIL] = useState(false);

  async function handleLoadVault() {
    setLoadError(null);
    setVaultInfo(null);
    try {
      const info = await fetchLpVault(lpVaultAddress.trim());
      setVaultInfo(info);
    } catch (err: any) {
      setLoadError(err.message ?? String(err));
    }
  }

  async function handleDeposit() {
    if (!vaultInfo || !acknowledgeIL) return;
    // NOTE: this passes raw amounts as a stand-in for a real liquidity_amount
    // — see useLpVault.ts's depositLp doc comment. Not accurate until real
    // Whirlpool quote math is wired in. Disabled below until that lands.
    console.warn("LP deposit math not yet implemented — see useLpVault.ts");
  }

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "48px 24px 120px" }}>
      <div style={{
        marginBottom: 8, fontSize: 11, fontWeight: 600, letterSpacing: "0.08em",
        textTransform: "uppercase", color: "var(--warn)", fontFamily: "var(--font-mono)",
      }}>
        Phase 2 — Preview / Not Live
      </div>
      <h1 style={{ fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 700, marginBottom: 12, color: "var(--text-hi)" }}>
        LP Vault (Orca Whirlpools)
      </h1>
      <p style={{ color: "var(--text-mid)", fontSize: 14, lineHeight: 1.7, marginBottom: 32 }}>
        Opt-in, dual-asset liquidity provision. Carries real impermanent loss
        risk on top of any yield earned — separate from YieldPilot&apos;s core
        single-asset auto-routing vaults. Not deployed yet.
      </p>

      {!connected ? (
        <button onClick={() => setVisible(true)} style={{
          background: "var(--signal)", color: "var(--ink-900)", border: "none",
          padding: "12px 26px", borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: "pointer",
        }}>
          Connect Wallet
        </button>
      ) : (
        <>
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: "block", fontSize: 13, color: "var(--text-mid)", marginBottom: 6 }}>
              LP Vault address
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={lpVaultAddress}
                onChange={e => setLpVaultAddress(e.target.value)}
                placeholder="Paste LP vault address"
                style={{
                  flex: 1, padding: "10px 14px", borderRadius: 8, border: "1px solid var(--line)",
                  background: "var(--ink-800)", color: "var(--text-hi)", fontSize: 13, fontFamily: "var(--font-mono)",
                }}
              />
              <button onClick={handleLoadVault} style={{
                padding: "10px 18px", borderRadius: 8, border: "1px solid var(--line)",
                background: "var(--ink-700)", color: "var(--text-hi)", fontSize: 13, cursor: "pointer",
              }}>
                Load
              </button>
            </div>
            {loadError && <div style={{ color: "var(--loss)", fontSize: 12, marginTop: 8 }}>{loadError}</div>}
          </div>

          {vaultInfo && (
            <div style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 20, marginBottom: 24 }}>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 12, color: "var(--text-hi)" }}>{vaultInfo.name}</div>
              <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.9 }}>
                <div>Position active: {vaultInfo.positionActive ? "yes" : "no (mid-reposition)"}</div>
                <div>Total shares: {vaultInfo.totalShares}</div>
                <div>Paused: {vaultInfo.paused ? "yes" : "no"}</div>
              </div>

              <div style={{ marginTop: 20, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <input
                  value={amountA}
                  onChange={e => setAmountA(e.target.value)}
                  placeholder="Token A amount"
                  style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--ink-800)", color: "var(--text-hi)", fontSize: 13 }}
                />
                <input
                  value={amountB}
                  onChange={e => setAmountB(e.target.value)}
                  placeholder="Token B amount"
                  style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--ink-800)", color: "var(--text-hi)", fontSize: 13 }}
                />
              </div>

              <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 16, fontSize: 13, color: "var(--text-mid)", cursor: "pointer" }}>
                <input type="checkbox" checked={acknowledgeIL} onChange={e => setAcknowledgeIL(e.target.checked)} style={{ marginTop: 2 }} />
                <span>I understand LP positions carry impermanent loss risk and my deposit&apos;s value in either token can be less than what I put in, even if the pool earned fees.</span>
              </label>

              <button
                onClick={handleDeposit}
                disabled={!acknowledgeIL || !amountA || !amountB}
                style={{
                  marginTop: 16, width: "100%", padding: "12px", borderRadius: 8, border: "none",
                  background: acknowledgeIL ? "var(--signal)" : "var(--ink-700)",
                  color: acknowledgeIL ? "var(--ink-900)" : "var(--text-low)",
                  fontWeight: 700, fontSize: 14, cursor: acknowledgeIL ? "pointer" : "not-allowed",
                }}
              >
                {txStatus === "signing" || txStatus === "confirming" ? "Confirming…" : "Deposit"}
              </button>
              {txError && <div style={{ color: "var(--loss)", fontSize: 12, marginTop: 8 }}>{txError}</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
