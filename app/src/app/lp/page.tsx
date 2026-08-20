"use client";

/**
 * LP vault page — Phase 2. GATED BEHIND NEXT_PUBLIC_LP_ENABLED.
 *
 * Phase 2 gets deployed on-chain before it is announced: the plan is to run real
 * mainnet LP trials quietly, then reveal when volume slows. Until the flag is "true"
 * this route returns a 404 — not a "coming soon" page, because a teaser invites people
 * to poke at a vault that is still being tested with real money.
 *
 * Not linked from the header nav either (desktop or mobile), so with the flag off the
 * page is unreachable and undiscoverable.
 *
 * Token A/B amounts are human decimal input (e.g. "12.5"), converted via
 * parseDecimalToBaseUnits using each mint's REAL decimals (fetched from the
 * mint account itself, never assumed) — see useLpVault.ts. LP shares use a
 * fixed 9 decimals (the shares mint is always created with mint::decimals=9
 * in initialize_orca_lp_vault_handler).
 */
import { useState } from "react";
import { notFound } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import * as anchor from "@coral-xyz/anchor";
import { useLpVault, LpVaultInfo, parseDecimalToBaseUnits, formatBaseUnitsToDecimal } from "@/hooks/useLpVault";
import { usePhase2Gate } from "@/hooks/usePhase2Gate";

const DEFAULT_SLIPPAGE_BPS = 100; // 1%
// LP shares mint is always created with mint::decimals = 9 — see
// initialize_orca_lp_vault_handler / initialize_raydium_lp_vault_handler in
// lp_vault.rs.
const LP_SHARES_DECIMALS = 9;

// Normalized shape both protocols' quote functions are mapped into here —
// Orca's real quote object has tokenEstA/B (a point estimate) in addition to
// the slippage-adjusted tokenMaxA/B; Raydium's doesn't compute a separate
// estimate, so those fields are left undefined and the UI just omits that
// part of the display for Raydium vaults.
interface DepositQuoteDisplay {
  liquidityDelta: anchor.BN;
  tokenEstA?: anchor.BN;
  tokenEstB?: anchor.BN;
  tokenMaxA: anchor.BN;
  tokenMaxB: anchor.BN;
}
interface WithdrawQuoteDisplay {
  tokenEstA?: anchor.BN;
  tokenEstB?: anchor.BN;
  tokenMinA: anchor.BN;
  tokenMinB: anchor.BN;
}

export default function LpVaultPage() {
  const { connected } = useWallet();
  const { setVisible } = useWalletModal();

  // Public users see a 404 with the flag off; the admin wallet gets a preview so they can
  // see the real UI before reveal. See usePhase2Gate / phase2Access.mjs -- a client preview
  // gate, not a security boundary, and only safe while the LP vaults don't exist on mainnet.
  const { visible, adminPreview, deciding } = usePhase2Gate();
  if (!visible) {
    if (deciding) return null;
    notFound();
  }
  const {
    txStatus, txError, fetchLpVault,
    getDepositQuote, depositLp, getWithdrawQuote, withdrawLp,
    getRaydiumDepositQuote, depositRaydiumLp, getRaydiumWithdrawQuote, withdrawRaydiumLp,
  } = useLpVault();

  const [lpVaultAddress, setLpVaultAddress] = useState("");
  const [vaultInfo, setVaultInfo] = useState<LpVaultInfo | null>(null);
  const [loadingVault, setLoadingVault] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [amountA, setAmountA] = useState("");
  const [quote, setQuote] = useState<DepositQuoteDisplay | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [acknowledgeIL, setAcknowledgeIL] = useState(false);

  const [withdrawShares, setWithdrawShares] = useState("");
  const [withdrawQuote, setWithdrawQuote] = useState<WithdrawQuoteDisplay | null>(null);
  const [withdrawQuoting, setWithdrawQuoting] = useState(false);
  const [withdrawQuoteError, setWithdrawQuoteError] = useState<string | null>(null);

  async function handleLoadVault() {
    setLoadError(null);
    setVaultInfo(null);
    setQuote(null);
    setLoadingVault(true);
    try {
      const info = await fetchLpVault(lpVaultAddress.trim());
      setVaultInfo(info);
    } catch (err: any) {
      setLoadError(err.message ?? String(err));
    } finally {
      setLoadingVault(false);
    }
  }

  async function handleGetQuote() {
    if (!vaultInfo || !amountA) return;
    setQuoteError(null);
    setQuote(null);
    setQuoting(true);
    try {
      const rawAmountA = parseDecimalToBaseUnits(amountA, vaultInfo.tokenADecimals);
      if (vaultInfo.protocol === "raydium") {
        const q = await getRaydiumDepositQuote(vaultInfo.address, rawAmountA, DEFAULT_SLIPPAGE_BPS);
        setQuote({ liquidityDelta: q.liquidityDelta, tokenMaxA: q.tokenMaxA, tokenMaxB: q.tokenMaxB });
      } else {
        const q = await getDepositQuote(vaultInfo.address, rawAmountA, DEFAULT_SLIPPAGE_BPS);
        setQuote({
          liquidityDelta: new anchor.BN(q.liquidityDelta.toString()),
          tokenEstA: new anchor.BN(q.tokenEstA.toString()),
          tokenEstB: new anchor.BN(q.tokenEstB.toString()),
          tokenMaxA: new anchor.BN(q.tokenMaxA.toString()),
          tokenMaxB: new anchor.BN(q.tokenMaxB.toString()),
        });
      }
    } catch (err: any) {
      setQuoteError(err.message ?? String(err));
    } finally {
      setQuoting(false);
    }
  }

  async function handleDeposit() {
    if (!vaultInfo || !quote || !acknowledgeIL) return;
    if (vaultInfo.protocol === "raydium") {
      await depositRaydiumLp(vaultInfo.address, quote, acknowledgeIL);
    } else {
      await depositLp(vaultInfo.address, quote as any, acknowledgeIL);
    }
    setQuote(null);
    setAmountA("");
  }

  async function handleGetWithdrawQuote() {
    if (!vaultInfo || !withdrawShares) return;
    setWithdrawQuoteError(null);
    setWithdrawQuote(null);
    setWithdrawQuoting(true);
    try {
      const rawShares = parseDecimalToBaseUnits(withdrawShares, LP_SHARES_DECIMALS);
      if (vaultInfo.protocol === "raydium") {
        const q = await getRaydiumWithdrawQuote(vaultInfo.address, rawShares, DEFAULT_SLIPPAGE_BPS);
        setWithdrawQuote({ tokenMinA: q.tokenMinA, tokenMinB: q.tokenMinB });
      } else {
        const q = await getWithdrawQuote(vaultInfo.address, rawShares, DEFAULT_SLIPPAGE_BPS);
        setWithdrawQuote({
          tokenEstA: new anchor.BN(q.tokenEstA.toString()),
          tokenEstB: new anchor.BN(q.tokenEstB.toString()),
          tokenMinA: new anchor.BN(q.tokenMinA.toString()),
          tokenMinB: new anchor.BN(q.tokenMinB.toString()),
        });
      }
    } catch (err: any) {
      setWithdrawQuoteError(err.message ?? String(err));
    } finally {
      setWithdrawQuoting(false);
    }
  }

  async function handleWithdraw() {
    if (!vaultInfo || !withdrawQuote || !withdrawShares) return;
    const rawShares = parseDecimalToBaseUnits(withdrawShares, LP_SHARES_DECIMALS);
    if (vaultInfo.protocol === "raydium") {
      await withdrawRaydiumLp(vaultInfo.address, rawShares, withdrawQuote);
    } else {
      await withdrawLp(vaultInfo.address, rawShares, withdrawQuote as any);
    }
    setWithdrawQuote(null);
    setWithdrawShares("");
  }

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "48px 24px 120px" }}>
      {adminPreview && (
        <div style={{ border: "0.5px solid var(--line, #444)", borderRadius: 8, padding: "8px 12px", marginBottom: 16, fontSize: 13, color: "var(--text-mid, #888)" }}>
          Admin preview - LP is not public yet. Only your wallet sees this.
        </div>
      )}
      <div style={{
        marginBottom: 8, fontSize: 11, fontWeight: 600, letterSpacing: "0.08em",
        textTransform: "uppercase", color: "var(--warn)", fontFamily: "var(--font-mono)",
      }}>
        Phase 2 — Preview / Not Live
      </div>
      <h1 style={{ fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 700, marginBottom: 12, color: "var(--text-hi)" }}>
        LP Vault{vaultInfo ? ` (${vaultInfo.protocol === "raydium" ? "Raydium CLMM" : "Orca Whirlpools"})` : ""}
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
              <button onClick={handleLoadVault} disabled={!lpVaultAddress.trim() || loadingVault} style={{
                padding: "10px 18px", borderRadius: 8, border: "1px solid var(--line)",
                background: "var(--ink-700)", color: "var(--text-hi)", fontSize: 13,
                cursor: !lpVaultAddress.trim() || loadingVault ? "not-allowed" : "pointer",
                opacity: !lpVaultAddress.trim() || loadingVault ? 0.5 : 1,
              }}>
                {loadingVault ? "Loading…" : "Load"}
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
                Token A amount ({vaultInfo.tokenADecimals} decimals)
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={amountA}
                  onChange={e => { setAmountA(e.target.value); setQuote(null); }}
                  placeholder="e.g. 12.5"
                  style={{ flex: 1, padding: "10px 14px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--ink-800)", color: "var(--text-hi)", fontSize: 13 }}
                />
                <button onClick={handleGetQuote} disabled={!amountA || quoting} style={{
                  padding: "10px 18px", borderRadius: 8, border: "1px solid var(--line)",
                  background: "var(--ink-700)", color: "var(--text-hi)", fontSize: 13,
                  cursor: !amountA || quoting ? "not-allowed" : "pointer",
                  opacity: !amountA || quoting ? 0.5 : 1,
                }}>
                  {quoting ? "Quoting…" : "Get Quote"}
                </button>
              </div>
              {quoteError && <div style={{ color: "var(--loss)", fontSize: 12, marginTop: 8 }}>{quoteError}</div>}

              {quote && (
                <div style={{ marginTop: 16, padding: 14, borderRadius: 8, background: "var(--ink-800)", fontSize: 12, color: "var(--text-mid)", fontFamily: "var(--font-mono)" }}>
                  <div>
                    Token A{quote.tokenEstA ? " (est / max)" : " (max)"}: {quote.tokenEstA ? `${formatBaseUnitsToDecimal(quote.tokenEstA, vaultInfo.tokenADecimals)} / ` : ""}{formatBaseUnitsToDecimal(quote.tokenMaxA, vaultInfo.tokenADecimals)}
                  </div>
                  <div>
                    Token B{quote.tokenEstB ? " (est / max)" : " (max)"}: {quote.tokenEstB ? `${formatBaseUnitsToDecimal(quote.tokenEstB, vaultInfo.tokenBDecimals)} / ` : ""}{formatBaseUnitsToDecimal(quote.tokenMaxB, vaultInfo.tokenBDecimals)}
                  </div>
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
              {txStatus === "success" && <div style={{ color: "var(--signal)", fontSize: 12, marginTop: 8 }}>✓ Confirmed</div>}

              <div style={{ marginTop: 32, paddingTop: 24, borderTop: "1px solid var(--line)" }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12, color: "var(--text-hi)" }}>Withdraw</div>
                <label style={{ display: "block", fontSize: 13, color: "var(--text-mid)", marginBottom: 6 }}>
                  Shares to withdraw ({LP_SHARES_DECIMALS} decimals)
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    value={withdrawShares}
                    onChange={e => { setWithdrawShares(e.target.value); setWithdrawQuote(null); }}
                    placeholder="e.g. 1.5"
                    style={{ flex: 1, padding: "10px 14px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--ink-800)", color: "var(--text-hi)", fontSize: 13 }}
                  />
                  <button onClick={handleGetWithdrawQuote} disabled={!withdrawShares || withdrawQuoting} style={{
                    padding: "10px 18px", borderRadius: 8, border: "1px solid var(--line)",
                    background: "var(--ink-700)", color: "var(--text-hi)", fontSize: 13,
                    cursor: !withdrawShares || withdrawQuoting ? "not-allowed" : "pointer",
                    opacity: !withdrawShares || withdrawQuoting ? 0.5 : 1,
                  }}>
                    {withdrawQuoting ? "Quoting…" : "Get Quote"}
                  </button>
                </div>
                {withdrawQuoteError && <div style={{ color: "var(--loss)", fontSize: 12, marginTop: 8 }}>{withdrawQuoteError}</div>}

                {withdrawQuote && (
                  <div style={{ marginTop: 16, padding: 14, borderRadius: 8, background: "var(--ink-800)", fontSize: 12, color: "var(--text-mid)", fontFamily: "var(--font-mono)" }}>
                    <div>
                      Token A{withdrawQuote.tokenEstA ? " (est / min)" : " (min)"}: {withdrawQuote.tokenEstA ? `${formatBaseUnitsToDecimal(withdrawQuote.tokenEstA, vaultInfo.tokenADecimals)} / ` : ""}{formatBaseUnitsToDecimal(withdrawQuote.tokenMinA, vaultInfo.tokenADecimals)}
                    </div>
                    <div>
                      Token B{withdrawQuote.tokenEstB ? " (est / min)" : " (min)"}: {withdrawQuote.tokenEstB ? `${formatBaseUnitsToDecimal(withdrawQuote.tokenEstB, vaultInfo.tokenBDecimals)} / ` : ""}{formatBaseUnitsToDecimal(withdrawQuote.tokenMinB, vaultInfo.tokenBDecimals)}
                    </div>
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
                {txStatus === "success" && <div style={{ color: "var(--signal)", fontSize: 12, marginTop: 8 }}>✓ Confirmed</div>}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
