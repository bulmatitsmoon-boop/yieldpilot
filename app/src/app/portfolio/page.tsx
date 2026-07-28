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
import { useMemo, useState } from "react";
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
import { usePhase2Gate } from "@/hooks/usePhase2Gate";

const VAULT_ADDRESSES = (process.env.NEXT_PUBLIC_VAULT_ADDRESSES ?? "")
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean);

// Optional: the LP vault to pair with. When unset, the LP side asks for an address so the
// page still works before an LP vault is minted/known.
const LP_VAULT_ADDRESS = (process.env.NEXT_PUBLIC_LP_VAULT_ADDRESS ?? "").trim();

const DEFAULT_SLIPPAGE_BPS = 100; // 1%, matching /lp

export default function PortfolioPage() {
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();

  // Phase 2 gate. Visible when the reveal flag is on OR the connected wallet is the admin
  // (preview mode). While autoConnect is still settling we render nothing rather than flash
  // a 404 at a reconnecting admin; once settled, a non-admin with the flag off gets a real
  // 404. See usePhase2Gate / phase2Access.mjs — this is a preview gate, not a security
  // boundary, and is only safe while the LP vaults don't exist on mainnet.
  const { visible, adminPreview, deciding } = usePhase2Gate();
  if (!visible) {
    if (deciding) return null;
    notFound();
  }

  const { vaults, deposit } = useYieldPilot(VAULT_ADDRESSES);
  const { apys } = useApys();
  const {
    fetchLpVault,
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
  const [lpVaultAddr, setLpVaultAddr] = useState(LP_VAULT_ADDRESS);
  const [lpInfo, setLpInfo] = useState<LpVaultInfo | null>(null);
  const [lpAmountA, setLpAmountA] = useState("");
  const [ackIl, setAckIl] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadLp() {
    setError(null);
    try {
      const info = await fetchLpVault(lpVaultAddr.trim());
      setLpInfo(info);
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
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Split deposit</h1>
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
          <div style={{ display: "flex", gap: 8 }}>
            <input
              placeholder="LP vault address"
              value={lpVaultAddr}
              onChange={(e) => setLpVaultAddr(e.target.value)}
              style={{ flex: 1 }}
            />
            <button onClick={loadLp} style={btn}>Load</button>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 13, color: "var(--text-mid, #888)", marginBottom: 10 }}>
              {lpInfo.name} · {lpInfo.protocol} · bring both tokens
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
  cursor: "pointer",
};
