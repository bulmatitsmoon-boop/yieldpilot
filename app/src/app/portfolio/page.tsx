"use client";

/**
 * Split-deposit / portfolio page — Phase 2. GATED BEHIND NEXT_PUBLIC_LP_ENABLED.
 *
 * One screen that funds BOTH the safe (lending/staking) vault and the LP vault from a
 * single decision, with a slider governing the split and a combined preview. It does NOT
 * introduce any new on-chain construct: Phase 1 and Phase 2 are already separate vaults,
 * so "run both" is two ordinary deposits fired in sequence. See project memory
 * (split-deposit-ux) for the design rationale.
 *
 * Honesty constraints baked in here (do not "simplify" these away):
 *  - The LP vault needs BOTH tokens (we chose to make users bring the pair rather than
 *    build a swap), so the slider is a PLANNING dial: it previews the blended APY and the
 *    dollar split, but each leg still deposits with its own native input. We never silently
 *    swap one asset into a pair.
 *  - The "IL risk" acknowledgement is required before the LP leg can run, exactly as on the
 *    standalone /lp page.
 */
import { useEffect, useMemo, useState } from "react";
import { notFound } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import * as anchor from "@coral-xyz/anchor";
import { useYieldPilot } from "@/hooks/useYieldPilot";
import { useApys } from "@/hooks/useApys";
import {
  useLpVault,
  LpVaultInfo,
  parseDecimalToBaseUnits,
  formatBaseUnitsToDecimal,
} from "@/hooks/useLpVault";
import { blendedApy, estYearly, planLegs } from "@/lib/splitDeposit.mjs";
import { portfolioTotals } from "@/lib/portfolio.mjs";
import { usePhase2Gate } from "@/hooks/usePhase2Gate";
import { useSolPrice } from "@/hooks/useSolPrice";

const VAULT_ADDRESSES = (process.env.NEXT_PUBLIC_VAULT_ADDRESSES ?? "")
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean);

// Known LP vaults, shown as click-to-select options instead of a raw address field —
// nobody should have to copy/paste a pubkey to make a deposit. Falls back to the old
// singular env var for compatibility with any existing deploy config, then to a manual
// address field only if genuinely nothing is configured yet (e.g. between shipping this
// page and minting the first LP vault).
const LP_VAULT_ADDRESSES = (
  process.env.NEXT_PUBLIC_LP_VAULT_ADDRESSES ?? process.env.NEXT_PUBLIC_LP_VAULT_ADDRESS ?? ""
)
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean);

const DEFAULT_SLIPPAGE_BPS = 100; // 1%, matching /lp
// LP shares mint is always created with mint::decimals = 9 — see
// initialize_orca_lp_vault_handler / initialize_raydium_lp_vault_handler in lp_vault.rs.
const LP_SHARES_DECIMALS = 9;

interface WithdrawQuoteDisplay { tokenMinA: anchor.BN; tokenMinB: anchor.BN; }

// Real symbols for the two mints every configured LP vault actually uses, so the UI can
// say "SOL" / "USDC" instead of the vague "Token A" / "Token B" that comes straight out of
// the on-chain struct field names. Falls back to a truncated address for any future vault
// using a mint not in this list, rather than guessing.
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
function symbolForMint(mint: string): string {
  if (mint === SOL_MINT) return "SOL";
  if (mint === USDC_MINT) return "USDC";
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

export default function PortfolioPage() {
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();

  // Phase 2 gate. Visible when the reveal flag is on OR the connected wallet is the admin
  // (preview mode). See usePhase2Gate / phase2Access.mjs — this is a preview gate, not a
  // security boundary, and is only safe while the LP vaults don't exist on mainnet.
  //
  // IMPORTANT: this must NOT early-return here, before the rest of this component's hooks
  // are called — every hook below (useYieldPilot, useApys, useLpVault, the useState/useEffect
  // calls) has to run on EVERY render regardless of gate state, or the hook count changes
  // between the "still deciding" render and the "resolved" render and React throws error
  // #310 ("Rendered more hooks than during the previous render"). Confirmed live 2026-08-27
  // — the gate check used to sit right here as an early return, which is exactly this bug.
  // The actual gating now happens once, right before the final JSX return below.
  const { visible, adminPreview, deciding } = usePhase2Gate();

  const { vaults, positions, deposit } = useYieldPilot(VAULT_ADDRESSES);
  const solPrice = useSolPrice();

  // Combined portfolio total across the safe vaults (LP value needs a live quote — shown
  // separately below). Pure, tested math (portfolio.mjs / verify-split-deposit.mjs).
  const totals = portfolioTotals(positions, vaults, solPrice);
  const hasSafe = totals.rows.some((r) => r.valueUsd > 0);
  const { apys } = useApys();
  const {
    fetchLpVault,
    fetchLpPosition,
    getDepositQuote,
    depositLp,
    getRaydiumDepositQuote,
    depositRaydiumLp,
    getWithdrawQuote,
    withdrawLp,
    getRaydiumWithdrawQuote,
    withdrawRaydiumLp,
    txStatus,
    txError,
  } = useLpVault();

  // ── Slider: % of the plan that goes to the SAFE side. Pure preview math. ──
  const [safePct, setSafePct] = useState(70);
  const lpPct = 100 - safePct;

  // Live APYs for the preview. Safe = the vault the user will fund; LP = the paired vault.
  const safeVault = vaults[0] ?? null;
  const safeApy = useMemo(() => {
    // Blended live rate of the safe vault's current allocation, if available; else 0.
    const a = apys.find((x) => safeVault && x.asset && safeVault.name.toUpperCase().includes(x.asset.toUpperCase()));
    return a?.apyPercent ?? 0;
  }, [apys, safeVault]);
  // LP preview rate: the best live concentrated-liquidity fee APR we have (orca/raydium).
  const lpApy = useMemo(() => {
    const lp = apys.filter((x) => /orca|raydium/i.test(x.protocolId));
    return lp.length ? Math.max(...lp.map((x) => x.apyPercent ?? 0)) : 0;
  }, [apys]);

  // Plan amount is a preview figure the user types once; each leg still confirms its own
  // real input below. Kept in dollars for the blended-yield display only.
  const [planUsd, setPlanUsd] = useState(2000);
  const blended = blendedApy(safePct, safeApy, lpApy);
  const yearly = estYearly(planUsd, blended);

  // ── Real deposit inputs (one per leg — the LP leg brings the pair) ──
  const [safeAmount, setSafeAmount] = useState("");
  const [lpOptions, setLpOptions] = useState<LpVaultInfo[]>([]);
  const [lpOptionsLoading, setLpOptionsLoading] = useState(LP_VAULT_ADDRESSES.length > 0);
  const [manualLpAddr, setManualLpAddr] = useState("");
  const [lpInfo, setLpInfo] = useState<LpVaultInfo | null>(null);
  const [lpPosition, setLpPosition] = useState<{ shares: number } | null>(null);
  const [lpAmountA, setLpAmountA] = useState("");
  const [ackIl, setAckIl] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live quote for the OTHER side of the pair — nothing on this page previously showed
  // the user how much of token B their token A amount actually requires before they hit
  // deposit, even though the app always computed it internally right before sending the
  // transaction. Debounced so it doesn't refetch on every keystroke.
  const [lpQuoteB, setLpQuoteB] = useState<string | null>(null);
  const [lpQuoteLoading, setLpQuoteLoading] = useState(false);
  useEffect(() => {
    if (!lpInfo || !lpAmountA || Number(lpAmountA) <= 0) {
      setLpQuoteB(null);
      return;
    }
    let cancelled = false;
    setLpQuoteLoading(true);
    const timer = setTimeout(async () => {
      try {
        const rawA = new anchor.BN(parseDecimalToBaseUnits(lpAmountA, lpInfo.tokenADecimals).toString());
        const q = lpInfo.protocol === "raydium"
          ? await getRaydiumDepositQuote(lpInfo.address, rawA, DEFAULT_SLIPPAGE_BPS)
          : await getDepositQuote(lpInfo.address, rawA, DEFAULT_SLIPPAGE_BPS);
        if (cancelled) return;
        setLpQuoteB(formatBaseUnitsToDecimal(q.tokenMaxB.toString(), lpInfo.tokenBDecimals));
      } catch {
        if (!cancelled) setLpQuoteB(null);
      } finally {
        if (!cancelled) setLpQuoteLoading(false);
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lpInfo, lpAmountA]);

  // Fetch every configured LP vault's info ONCE on mount so they can render as
  // click-to-select options with real names/protocols, not a blank address field the
  // user has to already know how to fill in.
  useEffect(() => {
    if (LP_VAULT_ADDRESSES.length === 0) {
      setLpOptionsLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const results = await Promise.allSettled(LP_VAULT_ADDRESSES.map((a) => fetchLpVault(a)));
      if (cancelled) return;
      setLpOptions(
        results
          .filter((r): r is PromiseFulfilledResult<LpVaultInfo> => r.status === "fulfilled")
          .map((r) => r.value)
      );
      setLpOptionsLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Withdraw side — was only ever built on the separate /lp page, which meant a
  // real user had to know that page existed and navigate away from the deposit flow
  // just to get their money back. Same vault, same card, one page. ──
  const [lpTab, setLpTab] = useState<"deposit" | "withdraw">("deposit");
  const [withdrawSharesInput, setWithdrawSharesInput] = useState("");
  const [withdrawQuote, setWithdrawQuote] = useState<WithdrawQuoteDisplay | null>(null);
  const [withdrawQuoteLoading, setWithdrawQuoteLoading] = useState(false);

  async function selectLp(info: LpVaultInfo) {
    setError(null);
    setLpInfo(info);
    try {
      const pos = await fetchLpPosition(info.address);
      setLpPosition(pos ? { shares: pos.shares } : null);
    } catch {
      setLpPosition(null);
    }
  }

  function setWithdrawMax() {
    if (!lpPosition) return;
    setWithdrawSharesInput(formatBaseUnitsToDecimal(lpPosition.shares.toString(), LP_SHARES_DECIMALS));
  }

  useEffect(() => {
    if (!lpInfo || !withdrawSharesInput || Number(withdrawSharesInput) <= 0) {
      setWithdrawQuote(null);
      return;
    }
    let cancelled = false;
    setWithdrawQuoteLoading(true);
    const timer = setTimeout(async () => {
      try {
        const rawShares = parseDecimalToBaseUnits(withdrawSharesInput, LP_SHARES_DECIMALS);
        const q = lpInfo.protocol === "raydium"
          ? await getRaydiumWithdrawQuote(lpInfo.address, rawShares, DEFAULT_SLIPPAGE_BPS)
          : await getWithdrawQuote(lpInfo.address, rawShares, DEFAULT_SLIPPAGE_BPS);
        if (cancelled) return;
        setWithdrawQuote({ tokenMinA: new anchor.BN(q.tokenMinA.toString()), tokenMinB: new anchor.BN(q.tokenMinB.toString()) });
      } catch {
        if (!cancelled) setWithdrawQuote(null);
      } finally {
        if (!cancelled) setWithdrawQuoteLoading(false);
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lpInfo, withdrawSharesInput]);

  async function withdrawLpLeg() {
    if (!lpInfo || !withdrawSharesInput || !withdrawQuote) return;
    setBusy(true);
    setError(null);
    try {
      const rawShares = parseDecimalToBaseUnits(withdrawSharesInput, LP_SHARES_DECIMALS);
      if (lpInfo.protocol === "raydium") {
        await withdrawRaydiumLp(lpInfo.address, rawShares, withdrawQuote);
      } else {
        await withdrawLp(lpInfo.address, rawShares, withdrawQuote as any);
      }
      setWithdrawSharesInput("");
      setWithdrawQuote(null);
      const pos = await fetchLpPosition(lpInfo.address);
      setLpPosition(pos ? { shares: pos.shares } : null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function loadManualLp() {
    setError(null);
    try {
      const info = await fetchLpVault(manualLpAddr.trim());
      await selectLp(info);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function depositSafe() {
    if (!safeVault || !safeAmount) return;
    // Safe vault decimals: USDC=6, SOL=9. Mint decimals live on the vault; use name as the
    // decimals hint the rest of the app already relies on.
    const decimals = safeVault.name.toUpperCase().includes("SOL") ? 9 : 6;
    const amount = new anchor.BN(parseDecimalToBaseUnits(safeAmount, decimals).toString());
    await deposit(safeVault.address, safeVault.mint, amount);
  }

  async function depositLpLeg() {
    if (!lpInfo || !lpAmountA || !ackIl) return;
    const rawA = new anchor.BN(
      parseDecimalToBaseUnits(lpAmountA, lpInfo.tokenADecimals).toString()
    );
    if (lpInfo.protocol === "raydium") {
      const q = await getRaydiumDepositQuote(lpInfo.address, rawA, DEFAULT_SLIPPAGE_BPS);
      await depositRaydiumLp(lpInfo.address, q, ackIl);
    } else {
      const q = await getDepositQuote(lpInfo.address, rawA, DEFAULT_SLIPPAGE_BPS);
      await depositLp(lpInfo.address, q, ackIl);
    }
  }

  async function depositBoth() {
    // Which legs actually fire is decided by the shared, tested logic (planLegs) — the
    // same rules the verify:split-deposit check asserts: no zero deposits, and the LP leg
    // never fires without a loaded vault + a positive amount + the IL acknowledgement.
    const legs = planLegs({ safeAmount, lpReady: !!lpInfo, lpAmountA, ackIl });
    if (!legs.runSafe && !legs.runLp) {
      setError(legs.reason);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (legs.runSafe) await depositSafe();
      if (legs.runLp) await depositLpLeg();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Gate check happens HERE — after every hook above has already run this render — not as
  // an early return further up. See the comment on usePhase2Gate() for why.
  if (!visible) {
    if (deciding) return null;
    notFound();
  }

  if (!connected) {
    return (
      <main style={{ maxWidth: 640, margin: "0 auto", padding: "3rem 1.5rem" }}>
        <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 12 }}>Split deposit</h1>
        <p style={{ color: "var(--text-mid, #888)", marginBottom: 20 }}>
          Fund the safe vault and the LP vault from one screen.
        </p>
        <button onClick={() => setVisible(true)} style={btn}>Connect wallet</button>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "2.5rem 1.5rem" }}>
      {adminPreview && (
        <div style={{
          border: "0.5px solid var(--line, #444)", borderRadius: 8, padding: "8px 12px",
          marginBottom: 16, fontSize: 13, color: "var(--text-mid, #888)",
        }}>
          Admin preview — LP is not public yet. Only your wallet sees this.
        </div>
      )}
      {/* ── Combined portfolio: everything you hold across both vaults ── */}
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 16 }}>Your portfolio</h1>
      <div style={{ background: "var(--ink-800, #1a1a1a)", borderRadius: 12, padding: "1.25rem 1.5rem", marginBottom: 24 }}>
        <div style={{ fontSize: 13, color: "var(--text-mid, #888)" }}>Total value</div>
        <div style={{ fontSize: 30, fontWeight: 500, marginBottom: 4 }}>
          ${totals.totalValueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </div>
        {totals.totalEarnedUsd > 0 && (
          <div style={{ fontSize: 13, color: "#22b37e" }}>
            +${totals.totalEarnedUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })} earned
          </div>
        )}

        {hasSafe && (
          <div style={{ borderTop: "0.5px solid var(--line, #2a2a2a)", marginTop: 14, paddingTop: 12 }}>
            {totals.rows.filter((r) => r.valueUsd > 0).map((r) => (
              <div key={r.name} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "4px 0" }}>
                <span style={{ color: "var(--text-mid, #888)" }}>{r.name.replace("YieldPilot ", "")} · safe</span>
                <span>
                  ${r.valueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  {r.earnedUsd > 0 && <span style={{ color: "#22b37e", marginLeft: 8 }}>+${r.earnedUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>}
                </span>
              </div>
            ))}
          </div>
        )}

        {lpInfo && lpPosition && lpPosition.shares > 0 && (
          <div style={{ borderTop: "0.5px solid var(--line, #2a2a2a)", marginTop: 8, paddingTop: 12, display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span style={{ color: "var(--text-mid, #888)" }}>
              {lpInfo.name} · LP <span style={{ background: "rgba(216,90,48,0.12)", color: "#d85a30", fontSize: 11, padding: "1px 6px", borderRadius: 12, marginLeft: 4 }}>IL risk</span>
            </span>
            <span style={{ color: "var(--text-mid, #888)" }}>
              live value on the <a href="/lp" style={{ color: "var(--text-accent, #6ea8fe)" }}>LP page</a>
            </span>
          </div>
        )}

        {!hasSafe && !(lpPosition && lpPosition.shares > 0) && (
          <div style={{ fontSize: 13, color: "var(--text-mid, #888)", marginTop: 4 }}>
            No positions yet — fund a vault below to start.
          </div>
        )}
      </div>

      <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 4 }}>Add to your position</h2>
      <p style={{ color: "var(--text-mid, #888)", marginBottom: 24, fontSize: 14 }}>
        The dial previews how a deposit splits. Each vault is funded separately — the LP vault
        needs both tokens, so bring the pair.
      </p>

      {/* ── planning dial ── */}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
        <span>Plan amount</span>
        <input
          type="number"
          value={planUsd}
          onChange={(e) => setPlanUsd(Number(e.target.value) || 0)}
          style={{ width: 110, textAlign: "right" }}
        />
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={safePct}
        onChange={(e) => setSafePct(Number(e.target.value))}
        style={{ width: "100%" }}
      />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, margin: "6px 2px 20px" }}>
        <span><b>{safePct}%</b> safe</span>
        <span>quick <b>{lpPct}%</b></span>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
        <div style={statCard}>
          <div style={statLabel}>Blended APY</div>
          <div style={statValue}>{blended.toFixed(1)}%</div>
        </div>
        <div style={statCard}>
          <div style={statLabel}>Est. yearly</div>
          <div style={statValue}>${yearly.toLocaleString()}</div>
        </div>
      </div>

      {/* ── safe leg ── */}
      <section style={card}>
        <div style={{ fontWeight: 500, marginBottom: 8 }}>Safe vault</div>
        <div style={{ fontSize: 13, color: "var(--text-mid, #888)", marginBottom: 10 }}>
          {safeVault ? safeVault.name : "No vault configured"} · lending &amp; staking
        </div>
        <input
          placeholder="Amount"
          value={safeAmount}
          onChange={(e) => setSafeAmount(e.target.value)}
          style={{ width: "100%" }}
        />
      </section>

      {/* ── LP leg ── */}
      <section style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontWeight: 500 }}>LP vault</span>
          <span style={ilBadge}>IL risk</span>
        </div>
        {!lpInfo ? (
          lpOptionsLoading ? (
            <div style={{ fontSize: 13, color: "var(--text-mid, #888)" }}>Loading available LP vaults…</div>
          ) : lpOptions.length > 0 ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {lpOptions.map((opt) => {
                // Same live fee-APY numbers as the Live Rates page (useApys) — matched by
                // protocolId containing the protocol name, same pattern lpApy above uses.
                const rate = apys.find((x) => x.protocolId?.toLowerCase().includes(opt.protocol.toLowerCase()));
                return (
                  <button
                    key={opt.address}
                    onClick={() => selectLp(opt)}
                    style={{ ...btn, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4, minWidth: 140 }}
                  >
                    <span>{opt.name} · {opt.protocol}</span>
                    <span style={{ fontSize: 16, fontWeight: 600, color: rate?.stale ? "var(--text-mid, #888)" : "#22b37e" }}>
                      {rate && !rate.stale ? `${rate.apyPercent.toFixed(1)}%` : "—"}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            // Fallback only: no LP vaults configured yet (NEXT_PUBLIC_LP_VAULT_ADDRESSES
            // unset/empty), or every configured one failed to load. Manual entry keeps this
            // page usable in that gap rather than dead-ending — not the normal path.
            <div style={{ display: "flex", gap: 8 }}>
              <input
                placeholder="LP vault address"
                value={manualLpAddr}
                onChange={(e) => setManualLpAddr(e.target.value)}
                style={{ flex: 1 }}
              />
              <button onClick={loadManualLp} style={btn}>Load</button>
            </div>
          )
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontSize: 13, color: "var(--text-mid, #888)" }}>
                {lpInfo.name} · {lpInfo.protocol} · needs both {symbolForMint(lpInfo.tokenAMint)} and {symbolForMint(lpInfo.tokenBMint)}
              </span>
              {lpOptions.length > 1 && (
                <button
                  onClick={() => { setLpInfo(null); setLpAmountA(""); setAckIl(false); }}
                  style={{ ...btn, padding: "2px 10px", fontSize: 12 }}
                >
                  Change
                </button>
              )}
            </div>

            <div style={{ display: "flex", gap: 4, marginBottom: 14, background: "var(--ink-900, #0a0a0a)", borderRadius: 8, padding: 3 }}>
              {(["deposit", "withdraw"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setLpTab(t)}
                  style={{
                    flex: 1, padding: "6px 0", borderRadius: 6, border: "none", cursor: "pointer",
                    fontSize: 13, fontWeight: 500, textTransform: "capitalize",
                    background: lpTab === t ? "var(--ink-700, #2a2a2a)" : "transparent",
                    color: lpTab === t ? "var(--text-hi, #E8EDF2)" : "var(--text-mid, #888)",
                  }}
                >
                  {t}
                </button>
              ))}
            </div>

            {lpTab === "deposit" ? (
              <>
                <input
                  placeholder={`${symbolForMint(lpInfo.tokenAMint)} amount`}
                  value={lpAmountA}
                  onChange={(e) => setLpAmountA(e.target.value)}
                  style={{ width: "100%", marginBottom: 6 }}
                />
                <div style={{ fontSize: 13, color: "var(--text-mid, #888)", marginBottom: 10, minHeight: 18 }}>
                  {lpAmountA && Number(lpAmountA) > 0 && (
                    lpQuoteLoading
                      ? "Calculating required " + symbolForMint(lpInfo.tokenBMint) + "…"
                      : lpQuoteB
                        ? `You'll also need up to ~${lpQuoteB} ${symbolForMint(lpInfo.tokenBMint)} (pool's current price + 1% slippage buffer)`
                        : "Couldn't get a live quote — try a different amount."
                  )}
                </div>
                <label style={{ display: "flex", gap: 8, fontSize: 13, alignItems: "flex-start" }}>
                  <input type="checkbox" checked={ackIl} onChange={(e) => setAckIl(e.target.checked)} />
                  <span>I understand LP positions carry impermanent-loss risk and my deposit&apos;s value can fall relative to holding.</span>
                </label>
              </>
            ) : (
              <>
                <div style={{ fontSize: 13, color: "var(--text-mid, #888)", marginBottom: 8 }}>
                  Your position:{" "}
                  {lpPosition && lpPosition.shares > 0
                    ? `${formatBaseUnitsToDecimal(lpPosition.shares.toString(), LP_SHARES_DECIMALS)} shares`
                    : "nothing to withdraw"}
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                  <input
                    placeholder="Shares to withdraw"
                    value={withdrawSharesInput}
                    onChange={(e) => setWithdrawSharesInput(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button
                    onClick={setWithdrawMax}
                    disabled={!lpPosition || lpPosition.shares === 0}
                    style={{ ...btn, padding: "8px 14px" }}
                  >
                    MAX
                  </button>
                </div>
                <div style={{ fontSize: 13, color: "var(--text-mid, #888)", marginBottom: 14, minHeight: 18 }}>
                  {withdrawSharesInput && Number(withdrawSharesInput) > 0 && (
                    withdrawQuoteLoading
                      ? "Calculating payout…"
                      : withdrawQuote
                        ? `You'll receive at least ~${formatBaseUnitsToDecimal(withdrawQuote.tokenMinA.toString(), lpInfo.tokenADecimals)} ${symbolForMint(lpInfo.tokenAMint)} + ~${formatBaseUnitsToDecimal(withdrawQuote.tokenMinB.toString(), lpInfo.tokenBDecimals)} ${symbolForMint(lpInfo.tokenBMint)}`
                        : "Couldn't get a live quote — try a different amount."
                  )}
                </div>
                <button
                  onClick={withdrawLpLeg}
                  disabled={busy || !withdrawQuote}
                  style={{ ...btn, width: "100%", height: 40 }}
                >
                  {busy ? "Withdrawing…" : "Withdraw"}
                </button>
              </>
            )}
          </>
        )}
      </section>

      {/* Exactly what will happen if this button is pressed right now — computed from the
          real state of the two legs, not a generic label. Nothing fires that isn't listed here. */}
      {(() => {
        const willRunSafe = !!(safeVault && safeAmount && Number(safeAmount) > 0);
        const willRunLp = !!(lpInfo && lpAmountA && Number(lpAmountA) > 0 && ackIl);
        const parts: string[] = [];
        if (willRunSafe) parts.push(`${safeAmount} ${safeVault!.name.toUpperCase().includes("SOL") ? "SOL" : "USDC"} → ${safeVault!.name}`);
        if (willRunLp) {
          const symA = symbolForMint(lpInfo!.tokenAMint);
          const symB = symbolForMint(lpInfo!.tokenBMint);
          parts.push(`${lpAmountA} ${symA}${lpQuoteB ? ` + up to ~${lpQuoteB} ${symB}` : ""} → ${lpInfo!.name}`);
        }
        return (
          <div style={{ fontSize: 13, color: "var(--text-mid, #888)", marginBottom: 12 }}>
            {parts.length > 0
              ? <>This will send: {parts.map((p, i) => <span key={i}>{i > 0 && " and "}<b style={{ color: "var(--text-hi, #E8EDF2)" }}>{p}</b></span>)}.</>
              : "Enter an amount above to see exactly what this will send."}
          </div>
        );
      })()}

      {error && <div style={{ color: "#c0392b", fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {txStatus && <div style={{ fontSize: 13, marginBottom: 12 }}>{txStatus}</div>}
      {txError && <div style={{ color: "#c0392b", fontSize: 13, marginBottom: 12 }}>{txError}</div>}

      <button onClick={depositBoth} disabled={busy} style={{ ...btn, width: "100%", height: 44 }}>
        {busy ? "Depositing…" : "Confirm and deposit"}
      </button>
      <p style={{ textAlign: "center", fontSize: 12, color: "var(--text-mid, #888)", marginTop: 8 }}>
        Each leg above is a separate on-chain transaction · funds stay in separate vaults, they are never combined
      </p>
    </main>
  );
}

const card: React.CSSProperties = {
  border: "0.5px solid var(--line, #2a2a2a)",
  borderRadius: 12,
  padding: "1rem 1.25rem",
  marginBottom: 16,
};
const statCard: React.CSSProperties = { flex: 1, background: "var(--ink-800, #1a1a1a)", borderRadius: 8, padding: "1rem" };
const statLabel: React.CSSProperties = { fontSize: 13, color: "var(--text-mid, #888)", marginBottom: 4 };
const statValue: React.CSSProperties = { fontSize: 24, fontWeight: 500 };
const ilBadge: React.CSSProperties = {
  marginLeft: "auto",
  fontSize: 11,
  background: "rgba(216,90,48,0.12)",
  color: "#d85a30",
  padding: "2px 8px",
  borderRadius: 20,
};
const btn: React.CSSProperties = {
  border: "0.5px solid var(--line, #444)",
  borderRadius: 8,
  padding: "8px 16px",
  background: "transparent",
  color: "var(--text-hi, #E8EDF2)",
  cursor: "pointer",
};
