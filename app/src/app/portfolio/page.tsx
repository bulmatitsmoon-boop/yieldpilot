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
 *
 * UI pass v2 (2026-09): two-column dashboard layout (overview left, sticky deposit card
 * right) with a donut + risk chip for the allocation dial, matching a mockup Lloyd
 * approved. Deliberately did NOT add a unified "one amount field" or a wallet-balance
 * display from the mockup — the real architecture has two independent leg inputs (safe
 * amount, LP token-A amount) and no wired USDC-balance hook, and faking either would be
 * dishonest UI. The "quick amount" chips instead set the existing preview-only `planUsd`
 * field. No change to data flow, hook usage, effects, or any handler logic below —
 * visual/structure only.
 */
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
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
  computeLpVaultValueUsd,
} from "@/hooks/useLpVault";
import { useConnection } from "@solana/wallet-adapter-react";
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

// idleA/idleB are DISPLAY-ONLY (the vault's idle balance — where collected-but-not-
// yet-redeployed LP fees sit — added on top of the deployed-position quote for the
// "you'll receive" text). NEVER add them into tokenMinA/tokenMinB: those two are
// forwarded as-is into the on-chain CPI's slippage floor, which only ever covers the
// deployed position — inflating them makes the real (smaller) payout fail
// TokenMinSubceeded. Confirmed live 2026-09-01. See getWithdrawQuote's own comment.
interface WithdrawQuoteDisplay { tokenMinA: anchor.BN; tokenMinB: anchor.BN; idleA?: anchor.BN; idleB?: anchor.BN; }

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

// ---- small presentational helpers (styling only, no logic) ----

function Badge({ tone, children }: { tone: "ok" | "warn" | "neutral" | "loss"; children: ReactNode }) {
  const colors: Record<string, { bg: string; fg: string }> = {
    ok: { bg: "rgba(46, 204, 113, 0.12)", fg: "var(--signal, #2ecc71)" },
    warn: { bg: "rgba(216, 90, 48, 0.12)", fg: "var(--warn, #d85a30)" },
    loss: { bg: "rgba(192, 57, 43, 0.12)", fg: "var(--loss, #c0392b)" },
    neutral: { bg: "var(--ink-800)", fg: "var(--text-mid)" },
  };
  const c = colors[tone];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "2px 9px", borderRadius: 999, fontSize: 11, fontWeight: 600,
      background: c.bg, color: c.fg, fontFamily: "var(--font-mono)",
    }}>
      {children}
    </span>
  );
}

function SectionLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-low, #666)" }}>
        {children}
      </div>
      {hint && <div style={{ fontSize: 12, color: "var(--text-mid)", marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

// Risk label derived purely from the LP percentage already computed below — no new state.
function riskLabel(lpPctValue: number): { text: string; tone: "ok" | "warn" | "loss" } {
  if (lpPctValue <= 15) return { text: "Conservative", tone: "ok" };
  if (lpPctValue <= 45) return { text: "Balanced", tone: "warn" };
  return { text: "Aggressive", tone: "loss" };
}

// Small allocation donut built from the same safePct/lpPct the slider already drives —
// pure SVG, no charting library needed for two segments.
function AllocationDonut({ safePctValue }: { safePctValue: number }) {
  const r = 15.5;
  const circumference = 2 * Math.PI * r;
  const lpPctValue = 100 - safePctValue;
  const safeLen = (circumference * safePctValue) / 100;
  const lpLen = (circumference * lpPctValue) / 100;
  return (
    <div style={{ position: "relative", width: 88, height: 88, flex: "none" }}>
      <svg viewBox="0 0 36 36" width="88" height="88">
        <circle cx="18" cy="18" r={r} fill="none" stroke="var(--ink-800)" strokeWidth="4" />
        <circle
          cx="18" cy="18" r={r} fill="none" stroke="var(--signal)" strokeWidth="4"
          strokeDasharray={`${safeLen} ${circumference}`} strokeDashoffset="0"
          transform="rotate(-90 18 18)" strokeLinecap="round"
        />
        <circle
          cx="18" cy="18" r={r} fill="none" stroke="var(--warn)" strokeWidth="4"
          strokeDasharray={`${lpLen} ${circumference}`} strokeDashoffset={-safeLen}
          transform="rotate(-90 18 18)" strokeLinecap="round"
        />
      </svg>
      <div style={{
        position: "absolute", inset: 0, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
      }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 700, color: "var(--text-hi)" }}>
          {safePctValue}/{lpPctValue}
        </span>
        <span style={{ fontSize: 9, color: "var(--text-low, #666)", textTransform: "uppercase", letterSpacing: "0.05em" }}>split</span>
      </div>
    </div>
  );
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
  const { connection } = useConnection();

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

  // ── Real LP holdings across EVERY configured vault, not just whichever one is
  // currently open in the deposit/withdraw form below. ──
  //
  // Before this, the "Your portfolio" total only ever knew about an LP position if the
  // user had ALREADY clicked that specific vault's option in the form THIS SESSION —
  // selectLp() is what populates lpInfo/lpPosition, and that only fires on a click. A
  // real deposit that happened in an earlier session (or even just before a page
  // refresh) was completely invisible here: "$0 · No positions yet" over an actual
  // ~$600+ position. Confirmed live 2026-08-27. This scans every configured vault on
  // load instead of waiting for the user to click into the one they already funded.
  const [lpHoldings, setLpHoldings] = useState<{ info: LpVaultInfo; shares: number; valueUsd: number }[]>([]);
  useEffect(() => {
    if (!publicKey || lpOptions.length === 0 || solPrice <= 0) return;
    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        lpOptions.map(async (info) => {
          try {
            const pos = await fetchLpPosition(info.address);
            if (!pos || pos.shares <= 0 || info.totalShares <= 0) return null;
            const vaultValueUsd = await computeLpVaultValueUsd(connection, info.address, solPrice);
            const valueUsd = vaultValueUsd * (pos.shares / info.totalShares);
            return { info, shares: pos.shares, valueUsd };
          } catch {
            return null;
          }
        })
      );
      if (!cancelled) {
        setLpHoldings(results.filter((r): r is { info: LpVaultInfo; shares: number; valueUsd: number } => r !== null));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey, lpOptions, solPrice, connection]);

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
        const qAny = q as any;
        setWithdrawQuote({
          tokenMinA: new anchor.BN(q.tokenMinA.toString()),
          tokenMinB: new anchor.BN(q.tokenMinB.toString()),
          idleA: qAny.idleA !== undefined ? new anchor.BN(qAny.idleA.toString()) : undefined,
          idleB: qAny.idleB !== undefined ? new anchor.BN(qAny.idleB.toString()) : undefined,
        });
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
        <Badge tone="warn">Phase 2 · Preview — not public</Badge>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 700, marginTop: 12, marginBottom: 12, color: "var(--text-hi)" }}>
          Split deposit
        </h1>
        <p style={{ color: "var(--text-mid)", fontSize: 14, lineHeight: 1.7, marginBottom: 24 }}>
          Fund the safe vault and the LP vault from one screen.
        </p>
        <button onClick={() => setVisible(true)} style={primaryBtn(true)}>Connect wallet</button>
      </main>
    );
  }

  const totalValueUsd = totals.totalValueUsd + lpHoldings.reduce((s, h) => s + h.valueUsd, 0);
  const totalEarnedUsd = totals.totalEarnedUsd; // LP earnings aren't separately tracked yet — safe-side only, same as before.
  const hasAnyPosition = hasSafe || lpHoldings.length > 0;
  const risk = riskLabel(lpPct);

  const willRunSafe = !!(safeVault && safeAmount && Number(safeAmount) > 0);
  const willRunLp = !!(lpInfo && lpAmountA && Number(lpAmountA) > 0 && ackIl);
  const depositLabel = willRunSafe || willRunLp
    ? `Deposit${willRunSafe ? ` ${safeAmount} ${safeVault!.name.toUpperCase().includes("SOL") ? "SOL" : "USDC"}` : ""}${willRunSafe && willRunLp ? " +" : ""}${willRunLp ? ` ${lpAmountA} ${symbolForMint(lpInfo!.tokenAMint)}` : ""}`
    : "Enter an amount to deposit";

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: "2.5rem 1.5rem 5rem" }}>
      {adminPreview && (
        <div style={{
          border: "1px solid var(--line)", borderRadius: 8, padding: "10px 14px", marginBottom: 16,
          fontSize: 13, color: "var(--text-mid)", display: "flex", alignItems: "center", gap: 8,
        }}>
          <span style={{ fontSize: 15 }}>👁</span>
          Admin preview — LP is not public yet. Only your wallet sees this.
        </div>
      )}

      <div style={{ marginBottom: 18 }}>
        <Badge tone="warn">Phase 2 · Preview — not public</Badge>
      </div>

      <div style={twoColLayout}>
        {/* ══════════ LEFT: overview ══════════ */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

          {/* ── portfolio hero ── */}
          <div style={cardStyle}>
            <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-low, #666)" }}>
              Total value
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 34, fontWeight: 700, color: "var(--text-hi)", letterSpacing: "-0.01em" }}>
              ${totalValueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </div>

            {!hasAnyPosition ? (
              <>
                <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-hi)", marginTop: 14, marginBottom: 6 }}>
                  Your vault is ready.
                </div>
                <p style={{ color: "var(--text-mid)", fontSize: 14, lineHeight: 1.6, marginBottom: 16, maxWidth: "46ch" }}>
                  Deposit once — YieldPilot routes to the best Solana rates automatically.
                </p>
                <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                  {[100, 500, 2000].map((v) => (
                    <button key={v} onClick={() => setPlanUsd(v)} style={secondaryBtn(true)}>
                      ${v.toLocaleString()}
                    </button>
                  ))}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <div style={{ flex: 1, height: 6, borderRadius: 999, background: "var(--ink-800)", overflow: "hidden", display: "flex" }}>
                    <div style={{ width: `${safePct}%`, background: "var(--signal)" }} />
                    <div style={{ width: `${lpPct}%`, background: "var(--warn)" }} />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 14, fontSize: 12, color: "var(--text-mid)" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--signal)" }} /> Safe yield · lending &amp; staking
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--warn)" }} /> LP yield · optional, IL risk
                  </span>
                </div>
              </>
            ) : (
              <>
                {totalEarnedUsd > 0 && (
                  <div style={{ fontSize: 13, color: "var(--signal, #2ecc71)", fontWeight: 600, marginTop: 4 }}>
                    +${totalEarnedUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })} earned
                  </div>
                )}
                {hasSafe && (
                  <div style={{ borderTop: "1px solid var(--line)", marginTop: 16, paddingTop: 12 }}>
                    {totals.rows.filter((r) => r.valueUsd > 0).map((r) => (
                      <div key={r.name} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "5px 0" }}>
                        <span style={{ color: "var(--text-mid)" }}>{r.name.replace("YieldPilot ", "")} · safe</span>
                        <span style={{ color: "var(--text-hi)", fontFamily: "var(--font-mono)" }}>
                          ${r.valueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          {r.earnedUsd > 0 && <span style={{ color: "var(--signal, #2ecc71)", marginLeft: 8 }}>+${r.earnedUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {lpHoldings.length > 0 && (
                  <div style={{ borderTop: hasSafe ? "1px solid var(--line)" : undefined, marginTop: hasSafe ? 4 : 16, paddingTop: hasSafe ? 8 : 12 }}>
                    {lpHoldings.map((h) => (
                      <div key={h.info.address} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, padding: "5px 0" }}>
                        <span style={{ color: "var(--text-mid)", display: "flex", alignItems: "center", gap: 6 }}>
                          {h.info.name} · LP <Badge tone="warn">IL risk</Badge>
                        </span>
                        <span style={{ color: "var(--text-hi)", fontFamily: "var(--font-mono)" }}>${h.valueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            <div style={{
              display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: "var(--text-mid)",
              marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--line)",
            }}>
              <span>Non-custodial</span>
              <span>·</span>
              <span>On-chain program</span>
              <span>·</span>
              <span>Performance fee only, on profit</span>
            </div>
          </div>

          {/* ── allocation dial ── */}
          <div style={cardStyle}>
            <SectionLabel hint="Preview only — each leg below still confirms its own amount.">
              Allocation
            </SectionLabel>

            <div style={{ display: "flex", gap: 20, alignItems: "center", marginBottom: 8 }}>
              <AllocationDonut safePctValue={safePct} />
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--text-hi)", fontWeight: 600 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--signal)" }} /> Safe yield
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-hi)" }}>{safePct}%</span>
                </div>
                <div style={{ color: "var(--text-mid)", fontSize: 12, marginTop: -4 }}>Lending &amp; staking</div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--text-hi)", fontWeight: 600 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--warn)" }} /> LP yield
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-hi)" }}>{lpPct}%</span>
                </div>
                <div style={{ color: "var(--text-mid)", fontSize: 12, marginTop: -4 }}>Liquidity provision · carries IL risk</div>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6, marginTop: 14 }}>
              <span style={{ color: "var(--text-mid)" }}>Plan amount</span>
              <input
                type="number"
                value={planUsd}
                onChange={(e) => setPlanUsd(Number(e.target.value) || 0)}
                style={{ ...inputStyle(), width: 110, textAlign: "right" }}
              />
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={safePct}
              onChange={(e) => setSafePct(Number(e.target.value))}
              style={{ width: "100%", accentColor: "var(--signal)" }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-low, #666)", margin: "2px 2px 12px" }}>
              <span>All LP</span><span>All Safe</span>
            </div>

            <Badge tone={risk.tone}>{risk.text}</Badge>

            <div style={{
              display: "flex", justifyContent: "space-between", alignItems: "baseline",
              background: "var(--ink-800)", borderRadius: 10, padding: "14px 16px", marginTop: 14,
            }}>
              <div style={{ fontSize: 13, color: "var(--text-mid)" }}>
                Blended APR <b style={{ color: "var(--text-hi)", fontFamily: "var(--font-mono)" }}>{blended.toFixed(1)}%</b>
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 700, color: "var(--text-hi)" }}>
                ${yearly.toLocaleString()}/yr
              </div>
            </div>

            <div style={{
              fontSize: 12.5, color: "var(--text-mid)", background: "rgba(216, 90, 48, 0.08)",
              borderRadius: 8, padding: "10px 12px", marginTop: 14,
            }}>
              LP can lose principal if the pool price moves. Safe vault does not.
            </div>
          </div>
        </div>

        {/* ══════════ RIGHT: action ══════════ */}
        <div style={{ ...cardStyle, position: "sticky", top: 24, alignSelf: "start" }}>
          <SectionLabel>Add to position</SectionLabel>

          {/* ── safe leg ── */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)", marginBottom: 4 }}>Safe vault</div>
            <div style={{ fontSize: 12.5, color: "var(--text-mid)", marginBottom: 10 }}>
              {safeVault ? safeVault.name : "No vault configured"} · lending &amp; staking
            </div>
            <input
              placeholder="Amount"
              value={safeAmount}
              onChange={(e) => setSafeAmount(e.target.value)}
              style={{ ...inputStyle(), width: "100%" }}
            />
          </div>

          {/* ── LP leg ── */}
          <div style={{ marginBottom: 18, paddingTop: 18, borderTop: "1px solid var(--line)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)" }}>LP vault</div>
              <Badge tone="warn">IL risk</Badge>
            </div>
            {!lpInfo ? (
              lpOptionsLoading ? (
                <div style={{ fontSize: 13, color: "var(--text-mid)" }}>Loading available LP vaults…</div>
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
                        style={{ ...secondaryBtn(true), display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4, minWidth: 130 }}
                      >
                        <span>{opt.name} · {opt.protocol}</span>
                        <span style={{ fontSize: 15, fontWeight: 700, color: rate?.stale ? "var(--text-mid)" : "var(--signal, #2ecc71)" }}>
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
                    style={{ ...inputStyle(), flex: 1, fontFamily: "var(--font-mono)" }}
                  />
                  <button onClick={loadManualLp} style={secondaryBtn(true)}>Load</button>
                </div>
              )
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <span style={{ fontSize: 12.5, color: "var(--text-mid)" }}>
                    {lpInfo.name} · {lpInfo.protocol} · needs both {symbolForMint(lpInfo.tokenAMint)} and {symbolForMint(lpInfo.tokenBMint)}
                  </span>
                  {lpOptions.length > 1 && (
                    <button
                      onClick={() => { setLpInfo(null); setLpAmountA(""); setAckIl(false); }}
                      style={{ ...secondaryBtn(true), padding: "3px 10px", fontSize: 12 }}
                    >
                      Change
                    </button>
                  )}
                </div>

                <div style={{ display: "flex", borderBottom: "1px solid var(--line)", marginBottom: 16 }}>
                  {(["deposit", "withdraw"] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setLpTab(t)}
                      style={{
                        flex: 1, padding: "9px 0", background: "none", border: "none", cursor: "pointer",
                        fontSize: 13.5, fontWeight: 700, textTransform: "capitalize",
                        color: lpTab === t ? "var(--text-hi)" : "var(--text-low, #666)",
                        borderBottom: lpTab === t ? "2px solid var(--signal)" : "2px solid transparent",
                        marginBottom: -1, transition: "color 0.15s ease",
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
                      style={{ ...inputStyle(), width: "100%", marginBottom: 8 }}
                    />
                    <div style={{ fontSize: 12.5, color: "var(--text-mid)", marginBottom: 12, minHeight: 18 }}>
                      {lpAmountA && Number(lpAmountA) > 0 && (
                        lpQuoteLoading
                          ? "Calculating required " + symbolForMint(lpInfo.tokenBMint) + "…"
                          : lpQuoteB
                            ? `You'll also need up to ~${lpQuoteB} ${symbolForMint(lpInfo.tokenBMint)} (pool's current price + 1% slippage buffer)`
                            : "Couldn't get a live quote — try a different amount."
                      )}
                    </div>
                    <label style={{ display: "flex", gap: 8, fontSize: 12.5, color: "var(--text-mid)", alignItems: "flex-start", cursor: "pointer", lineHeight: 1.5 }}>
                      <input type="checkbox" checked={ackIl} onChange={(e) => setAckIl(e.target.checked)} style={{ marginTop: 2 }} />
                      <span>I understand LP positions carry impermanent-loss risk and my deposit&apos;s value can fall relative to holding.</span>
                    </label>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 12.5, color: "var(--text-mid)", marginBottom: 10 }}>
                      Your position:{" "}
                      <span style={{ color: "var(--text-hi)", fontFamily: "var(--font-mono)" }}>
                        {lpPosition && lpPosition.shares > 0
                          ? `${formatBaseUnitsToDecimal(lpPosition.shares.toString(), LP_SHARES_DECIMALS)} shares`
                          : "nothing to withdraw"}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                      <input
                        placeholder="Shares to withdraw"
                        value={withdrawSharesInput}
                        onChange={(e) => setWithdrawSharesInput(e.target.value)}
                        style={{ ...inputStyle(), flex: 1 }}
                      />
                      <button
                        onClick={setWithdrawMax}
                        disabled={!lpPosition || lpPosition.shares === 0}
                        style={secondaryBtn(!!lpPosition && lpPosition.shares > 0)}
                      >
                        MAX
                      </button>
                    </div>
                    <div style={{ fontSize: 12.5, color: "var(--text-mid)", marginBottom: 16, minHeight: 18 }}>
                      {withdrawSharesInput && Number(withdrawSharesInput) > 0 && (
                        withdrawQuoteLoading
                          ? "Calculating payout…"
                          : withdrawQuote
                            ? `You'll receive at least ~${formatBaseUnitsToDecimal(withdrawQuote.tokenMinA.add(withdrawQuote.idleA ?? new anchor.BN(0)).toString(), lpInfo.tokenADecimals)} ${symbolForMint(lpInfo.tokenAMint)} + ~${formatBaseUnitsToDecimal(withdrawQuote.tokenMinB.add(withdrawQuote.idleB ?? new anchor.BN(0)).toString(), lpInfo.tokenBDecimals)} ${symbolForMint(lpInfo.tokenBMint)}`
                            : "Couldn't get a live quote — try a different amount."
                      )}
                    </div>
                    <button
                      onClick={withdrawLpLeg}
                      disabled={busy || !withdrawQuote}
                      style={primaryBtn(!busy && !!withdrawQuote)}
                    >
                      {busy ? "Withdrawing…" : "Withdraw"}
                    </button>
                  </>
                )}
              </>
            )}
          </div>

          {/* ── exactly what will happen ── */}
          {(willRunSafe || willRunLp) && (
            <div style={{
              fontSize: 13, color: "var(--text-mid)", marginBottom: 14, padding: 12,
              borderRadius: 8, background: "var(--ink-800)", border: "1px solid var(--line)",
            }}>
              This will send:{" "}
              {willRunSafe && <b style={{ color: "var(--text-hi)" }}>{safeAmount} {safeVault!.name.toUpperCase().includes("SOL") ? "SOL" : "USDC"} → {safeVault!.name}</b>}
              {willRunSafe && willRunLp && " and "}
              {willRunLp && (
                <b style={{ color: "var(--text-hi)" }}>
                  {lpAmountA} {symbolForMint(lpInfo!.tokenAMint)}{lpQuoteB ? ` + up to ~${lpQuoteB} ${symbolForMint(lpInfo!.tokenBMint)}` : ""} → {lpInfo!.name}
                </b>
              )}
              .
            </div>
          )}

          {error && <div style={{ color: "var(--loss)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
          {txStatus && <div style={{ fontSize: 13, marginBottom: 10, color: "var(--text-mid)" }}>{txStatus}</div>}
          {txError && <div style={{ color: "var(--loss)", fontSize: 13, marginBottom: 10 }}>{txError}</div>}

          <button onClick={depositBoth} disabled={busy} style={{ ...primaryBtn(!busy), width: "100%", height: 46 }}>
            {busy ? "Depositing…" : depositLabel}
          </button>
          <p style={{ textAlign: "center", fontSize: 11.5, color: "var(--text-low, #666)", marginTop: 10 }}>
            Each leg above is a separate on-chain transaction · funds stay in separate vaults
          </p>
        </div>
      </div>
    </main>
  );
}

const twoColLayout: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1.15fr 0.85fr",
  gap: 24,
  alignItems: "start",
};

const cardStyle: CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: 14,
  padding: 24,
};

function inputStyle(): CSSProperties {
  return {
    padding: "10px 14px", borderRadius: 8, border: "1px solid var(--line)",
    background: "var(--ink-800)", color: "var(--text-hi)", fontSize: 14,
  };
}

function primaryBtn(enabled: boolean): CSSProperties {
  return {
    padding: "12px 26px", borderRadius: 8, border: "none",
    background: enabled ? "var(--signal)" : "var(--ink-700)",
    color: enabled ? "var(--ink-900)" : "var(--text-low)",
    fontWeight: 700, fontSize: 14, cursor: enabled ? "pointer" : "not-allowed",
  };
}

function secondaryBtn(enabled: boolean): CSSProperties {
  return {
    padding: "8px 16px", borderRadius: 8, border: "1px solid var(--line)",
    background: "var(--ink-700)", color: "var(--text-hi)", fontSize: 13, fontWeight: 600,
    cursor: enabled ? "pointer" : "not-allowed", opacity: enabled ? 1 : 0.5,
  };
}
