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
              {lpOptions.map((opt) => (
                <button key={opt.address} onClick={() => selectLp(opt)} style={btn}>
                  {opt.name} · {opt.protocol}
                </button>
              ))}
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
                {lpInfo.name} · {lpInfo.protocol} · bring both tokens
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
            <input
              placeholder="Token A amount"
              value={lpAmountA}
              onChange={(e) => setLpAmountA(e.target.value)}
              style={{ width: "100%", marginBottom: 10 }}
            />
            <label style={{ display: "flex", gap: 8, fontSize: 13, alignItems: "flex-start" }}>
              <input type="checkbox" checked={ackIl} onChange={(e) => setAckIl(e.target.checked)} />
              <span>I understand LP positions carry impermanent-loss risk and my deposit&apos;s value can fall relative to holding.</span>
            </label>
          </>
        )}
      </section>

      {error && <div style={{ color: "#c0392b", fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {txStatus && <div style={{ fontSize: 13, marginBottom: 12 }}>{txStatus}</div>}
      {txError && <div style={{ color: "#c0392b", fontSize: 13, marginBottom: 12 }}>{txError}</div>}

      <button onClick={depositBoth} disabled={busy} style={{ ...btn, width: "100%", height: 44 }}>
        {busy ? "Depositing…" : "Deposit into both vaults"}
      </button>
      <p style={{ textAlign: "center", fontSize: 12, color: "var(--text-mid, #888)", marginTop: 8 }}>
        Two on-chain deposits, one flow · funds stay in separate vaults
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
