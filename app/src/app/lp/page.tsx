"use client";

/**
 * LP vault page — Phase 2 groundwork, deliberately NOT linked from Header's
 * nav (desktop or mobile menu) or anywhere else in the app yet. Reachable
 * only by direct URL, and non-functional until the LP vault instructions
 * are actually deployed (see useLpVault.ts's top-of-file note).
 *
 * Amounts here are RAW BASE UNITS (the mint's smallest denomination), not
 * human decimal amounts — this preview page deliberately skips decimals
 * conversion (would need to fetch each mint's decimals) rather than risk a
 * silent scaling bug. A real production UI needs that conversion.
 */
import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import * as anchor from "@coral-xyz/anchor";
import { useLpVault, LpVaultInfo } from "@/hooks/useLpVault";
import type { IncreaseLiquidityQuote, DecreaseLiquidityQuote } from "@orca-so/whirlpools-core";

const DEFAULT_SLIPPAGE_BPS = 100; // 1%

export default function LpVaultPage() {
  const { connected } = useWallet();
  const { setVisible } = useWalletModal();
  const { txStatus, txError, fetchLpVault, getDepositQuote, depositLp, getWithdrawQuote, withdrawLp } = useLpVault();

  const [lpVaultAddress, setLpVaultAddress] = useState("");
  const [vaultInfo, setVaultInfo] = useState<LpVaultInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [amountA, setAmountA] = useState("");
  const [quote, setQuote] = useState<IncreaseLiquidityQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [acknowledgeIL, setAcknowledgeIL] = useState(false);

  const [withdrawShares, setWithdrawShares] = useState("");
  const [withdrawQuote, setWithdrawQuote] = useState<DecreaseLiquidityQuote | null>(null);
  const [withdrawQuoteError, setWithdrawQuoteError] = useState<string | null>(null);

  async function handleLoadVault() {
    setLoadError(null);
    setVaultInfo(null);
    setQuote(null);
    try {
      const info = await fetchLpVault(lpVaultAddress.trim());
      setVaultInfo(info);
    } catch (err: any) {
      setLoadError(err.message ?? String(err));
    }
  }

  async function handleGetQuote() {
    if (!vaultInfo || !amountA) return;
    setQuoteError(null);
    setQuote(null);
    try {
      const q = await getDepositQuote(vaultInfo.address, new anchor.BN(amountA), DEFAULT_SLIPPAGE_BPS);
      setQuote(q);
    } catch (err: any) {
      setQuoteError(err.message ?? String(err));
    }
  }

  async function handleDeposit() {
    if (!vaultInfo || !quote || !acknowledgeIL) return;
    await depositLp(vaultInfo.address, quote, acknowledgeIL);
    setQuote(null);
    setAmountA("");
  }

  async function handleGetWithdrawQuote() {
    if (!vaultInfo || !withdrawShares) return;
    setWithdrawQuoteError(null);
    setWithdrawQuote(null);
    try {
      const q = await getWithdrawQuote(vaultInfo.address, new anchor.BN(withdrawShares), DEFAULT_SLIPPAGE_BPS);
      setWithdrawQuote(q);
    } catch (err: any) {
      setWithdrawQuoteError(err.message ?? String(err));
    }
  }

  async function handleWithdraw() {
    if (!vaultInfo || !withdrawQuote || !withdrawShares) return;
    await withdrawLp(vaultInfo.address, new anchor.BN(withdrawShares), withdrawQuote);
    setWithdrawQuote(null);
    setWithdrawShares("");
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

              <label style={{ display: "block", fontSize: 13, color: "var(--text-mid)", marginTop: 20, marginBottom: 6 }}>
                Token A amount (raw base units)
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={amountA}
                  onChange={e => { setAmountA(e.target.value); setQuote(null); }}
                  placeholder="e.g. 1000000"
                  style={{ flex: 1, padding: "10px 14px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--ink-800)", color: "var(--text-hi)", fontSize: 13 }}
                />
                <button onClick={handleGetQuote} disabled={!amountA} style={{
                  padding: "10px 18px", borderRadius: 8, border: "1px solid var(--line)",
                  background: "var(--ink-700)", color: "var(--text-hi)", fontSize: 13, cursor: amountA ? "pointer" : "not-allowed",
                }}>
                  Get Quote
                </button>
              </div>
              {quoteError && <div style={{ color: "var(--loss)", fontSize: 12, marginTop: 8 }}>{quoteError}</div>}

              {quote && (
                <div style={{ marginTop: 16, padding: 14, borderRadius: 8, background: "var(--ink-800)", fontSize: 12, color: "var(--text-mid)", fontFamily: "var(--font-mono)" }}>
                  <div>Token A (est / max): {quote.tokenEstA.toString()} / {quote.tokenMaxA.toString()}</div>
                  <div>Token B (est / max): {quote.tokenEstB.toString()} / {quote.tokenMaxB.toString()}</div>
                  <div>Liquidity delta: {quote.liquidityDelta.toString()}</div>
                </div>
              )}

              <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 16, fontSize: 13, color: "var(--text-mid)", cursor: "pointer" }}>
                <input type="checkbox" checked={acknowledgeIL} onChange={e => setAcknowledgeIL(e.target.checked)} style={{ marginTop: 2 }} />
                <span>I understand LP positions carry impermanent loss risk and my deposit&apos;s value in either token can be less than what I put in, even if the pool earned fees.</span>
              </label>

              <button
                onClick={handleDeposit}
                disabled={!acknowledgeIL || !quote}
                style={{
                  marginTop: 16, width: "100%", padding: "12px", borderRadius: 8, border: "none",
                  background: acknowledgeIL && quote ? "var(--signal)" : "var(--ink-700)",
                  color: acknowledgeIL && quote ? "var(--ink-900)" : "var(--text-low)",
                  fontWeight: 700, fontSize: 14, cursor: acknowledgeIL && quote ? "pointer" : "not-allowed",
                }}
              >
                {txStatus === "signing" || txStatus === "confirming" ? "Confirming…" : "Deposit"}
              </button>
              {txError && <div style={{ color: "var(--loss)", fontSize: 12, marginTop: 8 }}>{txError}</div>}

              <div style={{ marginTop: 32, paddingTop: 24, borderTop: "1px solid var(--line)" }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12, color: "var(--text-hi)" }}>Withdraw</div>
                <label style={{ display: "block", fontSize: 13, color: "var(--text-mid)", marginBottom: 6 }}>
                  Shares to withdraw
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    value={withdrawShares}
                    onChange={e => { setWithdrawShares(e.target.value); setWithdrawQuote(null); }}
                    placeholder="e.g. 1000000"
                    style={{ flex: 1, padding: "10px 14px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--ink-800)", color: "var(--text-hi)", fontSize: 13 }}
                  />
                  <button onClick={handleGetWithdrawQuote} disabled={!withdrawShares} style={{
                    padding: "10px 18px", borderRadius: 8, border: "1px solid var(--line)",
                    background: "var(--ink-700)", color: "var(--text-hi)", fontSize: 13, cursor: withdrawShares ? "pointer" : "not-allowed",
                  }}>
                    Get Quote
                  </button>
                </div>
                {withdrawQuoteError && <div style={{ color: "var(--loss)", fontSize: 12, marginTop: 8 }}>{withdrawQuoteError}</div>}

                {withdrawQuote && (
                  <div style={{ marginTop: 16, padding: 14, borderRadius: 8, background: "var(--ink-800)", fontSize: 12, color: "var(--text-mid)", fontFamily: "var(--font-mono)" }}>
                    <div>Token A (est / min): {withdrawQuote.tokenEstA.toString()} / {withdrawQuote.tokenMinA.toString()}</div>
                    <div>Token B (est / min): {withdrawQuote.tokenEstB.toString()} / {withdrawQuote.tokenMinB.toString()}</div>
                  </div>
                )}

                <button
                  onClick={handleWithdraw}
                  disabled={!withdrawQuote}
                  style={{
                    marginTop: 16, width: "100%", padding: "12px", borderRadius: 8, border: "none",
                    background: withdrawQuote ? "var(--signal)" : "var(--ink-700)",
                    color: withdrawQuote ? "var(--ink-900)" : "var(--text-low)",
                    fontWeight: 700, fontSize: 14, cursor: withdrawQuote ? "pointer" : "not-allowed",
                  }}
                >
                  {txStatus === "signing" || txStatus === "confirming" ? "Confirming…" : "Withdraw"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
