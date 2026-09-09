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
 *
 * UI pass (2026-09): restyled into a guided, tabbed flow (Deposit / Withdraw)
 * instead of both actions stacked on the page at once, with status shown as
 * badges rather than raw text lines. No change to data flow, hook usage, or
 * any handler logic below — visual/structure only.
 */
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
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

// ---- small presentational helpers (styling only, no logic) ----

function Badge({ tone, children }: { tone: "ok" | "warn" | "neutral"; children: ReactNode }) {
  const colors: Record<string, { bg: string; fg: string }> = {
    ok: { bg: "rgba(46, 204, 113, 0.12)", fg: "var(--signal, #2ecc71)" },
    warn: { bg: "rgba(255, 176, 32, 0.12)", fg: "var(--warn, #ffb020)" },
    neutral: { bg: "var(--ink-800)", fg: "var(--text-mid)" },
  };
  const c = colors[tone];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "3px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600,
      background: c.bg, color: c.fg, fontFamily: "var(--font-mono)",
    }}>
      {children}
    </span>
  );
}

function FieldLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--text-hi)" }}>{children}</label>
      {hint && <div style={{ fontSize: 12, color: "var(--text-low, #666)", marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

function inputStyle(): CSSProperties {
  return {
    flex: 1, padding: "11px 14px", borderRadius: 8, border: "1px solid var(--line)",
    background: "var(--ink-800)", color: "var(--text-hi)", fontSize: 14,
  };
}

function primaryButtonStyle(enabled: boolean): CSSProperties {
  return {
    width: "100%", padding: "13px", borderRadius: 8, border: "none",
    background: enabled ? "var(--signal)" : "var(--ink-700)",
    color: enabled ? "var(--ink-900)" : "var(--text-low)",
    fontWeight: 700, fontSize: 14, cursor: enabled ? "pointer" : "not-allowed",
    transition: "opacity 0.15s ease",
  };
}

function secondaryButtonStyle(enabled: boolean): CSSProperties {
  return {
    padding: "11px 18px", borderRadius: 8, border: "1px solid var(--line)",
    background: "var(--ink-700)", color: "var(--text-hi)", fontSize: 13, fontWeight: 600,
    cursor: enabled ? "pointer" : "not-allowed", opacity: enabled ? 1 : 0.5, whiteSpace: "nowrap",
  };
}

function QuotePanel({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <div style={{
      marginTop: 16, padding: 16, borderRadius: 10, background: "var(--ink-800)",
      border: "1px solid var(--line)",
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-low, #666)", marginBottom: 10 }}>
        Quote
      </div>
      <div style={{ display: "grid", rowGap: 8 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontFamily: "var(--font-mono)" }}>
            <span style={{ color: "var(--text-mid)" }}>{r.label}</span>
            <span style={{ color: "var(--text-hi)", fontWeight: 600 }}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function LpVaultPage() {
  const { connected } = useWallet();
  const { setVisible } = useWalletModal();

  // Public users see a 404 with the flag off; the admin wallet gets a preview so they can
  // see the real UI before reveal. See usePhase2Gate / phase2Access.mjs -- a client preview
  // gate, not a security boundary, and only safe while the LP vaults don't exist on mainnet.
  //
  // IMPORTANT: do NOT early-return here, before the rest of this component's hooks are
  // called (useLpVault + a dozen useState calls below) — the hook count would differ
  // between the "still deciding" render and the "resolved" render, which throws minified
  // React error #310. Same bug, same fix as portfolio/page.tsx (confirmed live 2026-08-27).
  // The actual gating happens once, right before the final JSX return below.
  const { visible, adminPreview, deciding } = usePhase2Gate();
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

  // Presentational only — which action tab is showing. Doesn't affect any handler.
  const [activeTab, setActiveTab] = useState<"deposit" | "withdraw">("deposit");

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

  // Gate check happens HERE — after every hook above has already run this render — not as
  // an early return further up. See the comment on usePhase2Gate() for why.
  if (!visible) {
    if (deciding) return null;
    notFound();
  }

  const busy = txStatus === "signing" || txStatus === "confirming";

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "48px 24px 120px" }}>
      {adminPreview && (
        <div style={{
          border: "1px solid var(--line, #444)", borderRadius: 8, padding: "10px 14px", marginBottom: 20,
          fontSize: 13, color: "var(--text-mid, #888)", display: "flex", alignItems: "center", gap: 8,
        }}>
          <span style={{ fontSize: 15 }}>👁</span>
          Admin preview — LP is not public yet. Only your wallet sees this.
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <div style={{
          fontSize: 11, fontWeight: 700, letterSpacing: "0.08em",
          textTransform: "uppercase", color: "var(--warn)", fontFamily: "var(--font-mono)",
        }}>
          Phase 2 — Preview / Not Live
        </div>
      </div>

      <h1 style={{ fontFamily: "var(--font-display)", fontSize: 30, fontWeight: 700, marginBottom: 12, color: "var(--text-hi)" }}>
        LP Vault{vaultInfo ? ` — ${vaultInfo.protocol === "raydium" ? "Raydium CLMM" : "Orca Whirlpools"}` : ""}
      </h1>
      <p style={{ color: "var(--text-mid)", fontSize: 14, lineHeight: 1.7, marginBottom: 32, maxWidth: 520 }}>
        Opt-in, dual-asset liquidity provision. Carries real impermanent loss
        risk on top of any yield earned — separate from YieldPilot&apos;s core
        single-asset auto-routing vaults. Not deployed yet.
      </p>

      {!connected ? (
        <div style={{
          border: "1px solid var(--line)", borderRadius: 12, padding: 32, textAlign: "center",
        }}>
          <div style={{ fontSize: 14, color: "var(--text-mid)", marginBottom: 18 }}>
            Connect a wallet to load and manage an LP vault.
          </div>
          <button onClick={() => setVisible(true)} style={{
            background: "var(--signal)", color: "var(--ink-900)", border: "none",
            padding: "12px 26px", borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: "pointer",
          }}>
            Connect Wallet
          </button>
        </div>
      ) : (
        <>
          {/* Step 1 — load the vault */}
          <div style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 20, marginBottom: 20 }}>
            <FieldLabel hint="Paste the address of the LP vault you want to interact with.">
              1 &nbsp;·&nbsp; LP vault address
            </FieldLabel>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={lpVaultAddress}
                onChange={e => setLpVaultAddress(e.target.value)}
                placeholder="Paste LP vault address"
                style={{ ...inputStyle(), fontFamily: "var(--font-mono)" }}
              />
              <button onClick={handleLoadVault} disabled={!lpVaultAddress.trim() || loadingVault} style={secondaryButtonStyle(!!lpVaultAddress.trim() && !loadingVault)}>
                {loadingVault ? "Loading…" : "Load Vault"}
              </button>
            </div>
            {loadError && <div style={{ color: "var(--loss)", fontSize: 12, marginTop: 8 }}>{loadError}</div>}
          </div>

          {vaultInfo && (
            <div style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 20, marginBottom: 20 }}>
              {/* Vault status summary */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                <div style={{ fontWeight: 700, fontSize: 17, color: "var(--text-hi)" }}>{vaultInfo.name}</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Badge tone={vaultInfo.paused ? "warn" : "ok"}>{vaultInfo.paused ? "Paused" : "Active"}</Badge>
                  <Badge tone={vaultInfo.positionActive ? "ok" : "warn"}>
                    {vaultInfo.positionActive ? "In position" : "Mid-reposition"}
                  </Badge>
                </div>
              </div>
              <div style={{
                display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20,
                fontSize: 13, color: "var(--text-mid)",
              }}>
                <div>
                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-low, #666)", marginBottom: 4 }}>Total shares</div>
                  <div style={{ fontFamily: "var(--font-mono)", color: "var(--text-hi)", fontWeight: 600 }}>{vaultInfo.totalShares}</div>
                </div>
              </div>

              {/* Tabs */}
              <div style={{ display: "flex", borderBottom: "1px solid var(--line)", marginBottom: 20 }}>
                {(["deposit", "withdraw"] as const).map(tab => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    style={{
                      flex: 1, padding: "10px 0", background: "none", border: "none", cursor: "pointer",
                      fontSize: 14, fontWeight: 700, textTransform: "capitalize",
                      color: activeTab === tab ? "var(--text-hi)" : "var(--text-low, #666)",
                      borderBottom: activeTab === tab ? "2px solid var(--signal)" : "2px solid transparent",
                      marginBottom: -1, transition: "color 0.15s ease",
                    }}
                  >
                    {tab}
                  </button>
                ))}
              </div>

              {activeTab === "deposit" && (
                <div>
                  <FieldLabel hint={`Enter how much of token A you want to deposit (${vaultInfo.tokenADecimals} decimals). The vault pairs it automatically.`}>
                    2 &nbsp;·&nbsp; Amount to deposit
                  </FieldLabel>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      value={amountA}
                      onChange={e => { setAmountA(e.target.value); setQuote(null); }}
                      placeholder="e.g. 12.5"
                      style={inputStyle()}
                    />
                    <button onClick={handleGetQuote} disabled={!amountA || quoting} style={secondaryButtonStyle(!!amountA && !quoting)}>
                      {quoting ? "Quoting…" : "Get Quote"}
                    </button>
                  </div>
                  {quoteError && <div style={{ color: "var(--loss)", fontSize: 12, marginTop: 8 }}>{quoteError}</div>}

                  {quote && (
                    <QuotePanel rows={[
                      {
                        label: quote.tokenEstA ? "Token A (est / max)" : "Token A (max)",
                        value: quote.tokenEstA
                          ? `${formatBaseUnitsToDecimal(quote.tokenEstA, vaultInfo.tokenADecimals)} / ${formatBaseUnitsToDecimal(quote.tokenMaxA, vaultInfo.tokenADecimals)}`
                          : formatBaseUnitsToDecimal(quote.tokenMaxA, vaultInfo.tokenADecimals),
                      },
                      {
                        label: quote.tokenEstB ? "Token B (est / max)" : "Token B (max)",
                        value: quote.tokenEstB
                          ? `${formatBaseUnitsToDecimal(quote.tokenEstB, vaultInfo.tokenBDecimals)} / ${formatBaseUnitsToDecimal(quote.tokenMaxB, vaultInfo.tokenBDecimals)}`
                          : formatBaseUnitsToDecimal(quote.tokenMaxB, vaultInfo.tokenBDecimals),
                      },
                      { label: "Liquidity delta", value: quote.liquidityDelta.toString() },
                    ]} />
                  )}

                  <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 18, fontSize: 13, color: "var(--text-mid)", cursor: "pointer", lineHeight: 1.5 }}>
                    <input type="checkbox" checked={acknowledgeIL} onChange={e => setAcknowledgeIL(e.target.checked)} style={{ marginTop: 2 }} />
                    <span>I understand LP positions carry impermanent loss risk and my deposit&apos;s value in either token can be less than what I put in, even if the pool earned fees.</span>
                  </label>

                  <div style={{ marginTop: 18 }}>
                    <button onClick={handleDeposit} disabled={!acknowledgeIL || !quote} style={primaryButtonStyle(!!acknowledgeIL && !!quote)}>
                      {busy ? "Confirming…" : "Deposit"}
                    </button>
                  </div>
                  {txError && <div style={{ color: "var(--loss)", fontSize: 12, marginTop: 8 }}>{txError}</div>}
                  {txStatus === "success" && (
                    <div style={{ marginTop: 8 }}><Badge tone="ok">✓ Confirmed</Badge></div>
                  )}
                </div>
              )}

              {activeTab === "withdraw" && (
                <div>
                  <FieldLabel hint={`Enter how many LP shares to redeem (${LP_SHARES_DECIMALS} decimals).`}>
                    2 &nbsp;·&nbsp; Shares to withdraw
                  </FieldLabel>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      value={withdrawShares}
                      onChange={e => { setWithdrawShares(e.target.value); setWithdrawQuote(null); }}
                      placeholder="e.g. 1.5"
                      style={inputStyle()}
                    />
                    <button onClick={handleGetWithdrawQuote} disabled={!withdrawShares || withdrawQuoting} style={secondaryButtonStyle(!!withdrawShares && !withdrawQuoting)}>
                      {withdrawQuoting ? "Quoting…" : "Get Quote"}
                    </button>
                  </div>
                  {withdrawQuoteError && <div style={{ color: "var(--loss)", fontSize: 12, marginTop: 8 }}>{withdrawQuoteError}</div>}

                  {withdrawQuote && (
                    <QuotePanel rows={[
                      {
                        label: withdrawQuote.tokenEstA ? "Token A (est / min)" : "Token A (min)",
                        value: withdrawQuote.tokenEstA
                          ? `${formatBaseUnitsToDecimal(withdrawQuote.tokenEstA, vaultInfo.tokenADecimals)} / ${formatBaseUnitsToDecimal(withdrawQuote.tokenMinA, vaultInfo.tokenADecimals)}`
                          : formatBaseUnitsToDecimal(withdrawQuote.tokenMinA, vaultInfo.tokenADecimals),
                      },
                      {
                        label: withdrawQuote.tokenEstB ? "Token B (est / min)" : "Token B (min)",
                        value: withdrawQuote.tokenEstB
                          ? `${formatBaseUnitsToDecimal(withdrawQuote.tokenEstB, vaultInfo.tokenBDecimals)} / ${formatBaseUnitsToDecimal(withdrawQuote.tokenMinB, vaultInfo.tokenBDecimals)}`
                          : formatBaseUnitsToDecimal(withdrawQuote.tokenMinB, vaultInfo.tokenBDecimals),
                      },
                    ]} />
                  )}

                  <div style={{ marginTop: 18 }}>
                    <button onClick={handleWithdraw} disabled={!withdrawQuote} style={primaryButtonStyle(!!withdrawQuote)}>
                      {busy ? "Confirming…" : "Withdraw"}
                    </button>
                  </div>
                  {txStatus === "success" && (
                    <div style={{ marginTop: 8 }}><Badge tone="ok">✓ Confirmed</Badge></div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
