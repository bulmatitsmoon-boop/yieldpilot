"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useWallet } from "@solana/wallet-adapter-react";
import { useApys } from "@/hooks/useApys";
import { useYieldPilot } from "@/hooks/useYieldPilot";
import { fmt } from "@/components/ui";
import { RoutingVisual } from "@/components/dashboard/RoutingVisual";
import { FleetRadar } from "@/components/dashboard/FleetRadar";

// Only these protocol IDs are actually routable on-chain (have a deploy_to_* instruction).
// Everything else (e.g. Drift) is informational-only and must never show "ROUTING HERE"
// or imply the vault can send funds there.
const ROUTABLE_PROTOCOL_IDS = new Set([
  "kamino-usdc", "kamino-sol", "marinade-sol", "jito-sol", "solend-usdc",
]);

const VAULT_ADDRESSES = (process.env.NEXT_PUBLIC_VAULT_ADDRESSES || "F1r513ZZdofz4tjhRfhNAYDK5hsmc8uCZbMmg2tkPJ6e,8KcoRt5DcCbXBaqDVDorEbW2J6GofTrRyy9Afzb8wwaE")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const IS_MAINNET = process.env.NEXT_PUBLIC_SOLANA_NETWORK === "mainnet-beta";

function Countdown({ seconds }: { seconds: number }) {
  const [remaining, setRemaining] = useState(seconds);
  useEffect(() => {
    const id = setInterval(() => setRemaining(r => (r <= 0 ? seconds : r - 1)), 1000);
    return () => clearInterval(id);
  }, [seconds]);
  const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
  const ss = String(remaining % 60).padStart(2, "0");
  return (
    <span className="mono-num" style={{ color: remaining <= 10 ? "var(--warn)" : "var(--text-hi)" }}>
      {mm}:{ss}
    </span>
  );
}

function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

export default function Home() {
  const { setVisible } = useWalletModal();
  const { connected } = useWallet();
  const { apys } = useApys();
  const { vaults } = useYieldPilot(VAULT_ADDRESSES);

  const routable = apys.filter(a => ROUTABLE_PROTOCOL_IDS.has(a.protocolId)).sort((a, b) => b.apyBps - a.apyBps);
  const informational = apys.filter(a => !ROUTABLE_PROTOCOL_IDS.has(a.protocolId));
  const best = routable[0];
  const runnerUp = routable[1];

  // Real TVL across both vaults, normalized to a USD-equivalent for the
  // headline number (SOL vault priced at a rough $150/SOL estimate — good
  // enough for a directional "total value" figure, not a precise oracle read).
  const usdcVault = vaults.find(v => v.name.toUpperCase().includes("USDC"));
  const solVault = vaults.find(v => v.name.toUpperCase().includes("SOL"));
  const totalDepositedUsd =
    (usdcVault ? usdcVault.totalDeposits / 1e6 : 0) +
    (solVault ? (solVault.totalDeposits / 1e9) * 150 : 0);
  const routableApys = apys.filter(a => ROUTABLE_PROTOCOL_IDS.has(a.protocolId));
  const blendedApy = routableApys.length
    ? routableApys.reduce((s, a) => s + a.apyPercent, 0) / routableApys.length
    : 0;

  return (
    <div style={{ position: "relative" }}>
      {/* ── Devnet banner ────────────────────────────────────────────────── */}
      {!IS_MAINNET && (
        <div style={{
          background: "rgba(245,184,75,0.1)", borderBottom: "1px solid rgba(245,184,75,0.25)",
          padding: "8px 24px", textAlign: "center", fontSize: 12, color: "var(--warn)",
          fontWeight: 500,
        }}>
          Devnet — do not deposit real funds. Devnet tokens have no value.
        </div>
      )}

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px 120px", position: "relative" }}>
        <div className="aurora-bg" />

        {/* ── Hero ────────────────────────────────────────────────────────── */}
        <div style={{
          display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 48,
          alignItems: "center", padding: "88px 0 72px", position: "relative", zIndex: 1,
        }}>
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          >
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 28 }}>
              <div className="live-dot" style={{
                width: 6, height: 6, borderRadius: "50%",
                background: IS_MAINNET ? "var(--signal)" : "var(--warn)",
                boxShadow: IS_MAINNET ? "0 0 6px var(--signal)" : "0 0 6px var(--warn)",
              }} />
              <span style={{ fontSize: 12, color: "var(--text-mid)", letterSpacing: "0.04em", fontFamily: "var(--font-mono)" }}>
                {IS_MAINNET ? "LIVE ON SOLANA MAINNET" : "RUNNING ON SOLANA DEVNET"}
              </span>
            </div>

            <h1 className="hero-h1" style={{
              fontFamily: "var(--font-display)",
              fontSize: "clamp(34px, 4.2vw, 52px)", fontWeight: 700,
              letterSpacing: "-0.02em", lineHeight: 1.08, marginBottom: 10, color: "var(--text-hi)",
            }}>
              Deposit once.
            </h1>
            <h1 className="hero-h1" style={{
              fontFamily: "var(--font-display)",
              fontSize: "clamp(34px, 4.2vw, 52px)", fontWeight: 700,
              letterSpacing: "-0.02em", lineHeight: 1.08, marginBottom: 28,
              color: "var(--signal)",
            }}>
              Earn the best rate, automatically.
            </h1>

            <p style={{
              color: "var(--text-mid)", fontSize: 16, lineHeight: 1.75,
              maxWidth: 460, marginBottom: 40,
            }}>
              YieldPilot routes your USDC or SOL to the top Solana protocol every 15 minutes.
              No manual moves. No missed rates. Non-custodial the whole way.
            </p>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              {connected ? (
                <Link href="/dashboard" style={{
                  background: "var(--signal)", color: "var(--ink-900)",
                  padding: "12px 26px", borderRadius: 8,
                  fontWeight: 700, fontSize: 14, textDecoration: "none",
                }}>
                  Open Dashboard
                </Link>
              ) : (
                <button onClick={() => setVisible(true)} style={{
                  background: "var(--signal)", color: "var(--ink-900)", border: "none",
                  padding: "12px 26px", borderRadius: 8,
                  fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "var(--font-body)",
                }}>
                  Connect Wallet
                </button>
              )}
              <Link href="/apys" style={{
                color: "var(--text-mid)", fontSize: 14, textDecoration: "none",
              }}>
                Live rates →
              </Link>
            </div>

            <div style={{ display: "flex", gap: 32, marginTop: 48, flexWrap: "wrap" }}>
              {[
                { value: "15 min", label: "rebalance cycle" },
                { value: "0–9%", label: "perf fee · tiered by $YPILOT held" },
                { value: "Non-custodial", label: "on-chain smart contract" },
              ].map(({ value, label }) => (
                <div key={label}>
                  <div className="mono-num" style={{ fontSize: 18, fontWeight: 500, color: "var(--text-hi)" }}>
                    {value}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-low)", marginTop: 3 }}>{label}</div>
                </div>
              ))}
            </div>
          </motion.div>

          {/* Compact instrument cluster preview */}
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.7, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
            style={{
              background: "var(--ink-800)", border: "1px solid var(--line)", borderRadius: 12,
              padding: 24, position: "relative", overflow: "hidden",
            }}
          >
            <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-low)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 }}>
              Best route now
            </div>
            {best ? (
              <>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
                  <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 20, color: "var(--text-hi)" }}>
                    {best.name}
                  </span>
                  <span style={{ fontSize: 12, color: "var(--text-mid)", fontFamily: "var(--font-mono)" }}>{best.asset}</span>
                </div>
                <div className="mono-num" style={{ fontSize: 40, fontWeight: 500, color: "var(--signal)", lineHeight: 1, marginBottom: 16 }}>
                  {fmt(best.apyPercent)}%
                  <span style={{ fontSize: 14, color: "var(--text-low)", marginLeft: 6 }}>APY</span>
                </div>
              </>
            ) : (
              <div style={{ height: 66 }} />
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18, fontSize: 12, color: "var(--signal)" }}>
              <div className="live-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--signal)" }} />
              <span style={{ fontFamily: "var(--font-mono)" }}>LIVE</span>
              <span style={{ color: "var(--text-low)" }}>· Next rebalance</span>
              <Countdown seconds={15 * 60} />
            </div>

            {/* Flight-path routing visual */}
            <RoutingVisual bestName={best?.name ?? null} bestApy={best?.apyPercent ?? null} runnerUpName={runnerUp?.name ?? null} />

            {/* 80/20 allocation gauge */}
            {best && (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-mid)", marginBottom: 6, fontFamily: "var(--font-mono)" }}>
                  <span>{best.name} 80%</span>
                  {runnerUp && <span>{runnerUp.name} 20%</span>}
                </div>
                <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", background: "var(--ink-700)" }}>
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: "80%" }}
                    transition={{ duration: 0.9, delay: 0.5, ease: [0.22, 1, 0.36, 1] }}
                    style={{ background: "var(--signal)" }}
                  />
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: "20%" }}
                    transition={{ duration: 0.9, delay: 0.5, ease: [0.22, 1, 0.36, 1] }}
                    style={{ background: "var(--signal-dim)", opacity: 0.5 }}
                  />
                </div>
              </div>
            )}
          </motion.div>
        </div>

        {/* ── Fleet Radar (real, live data — no fabricated numbers) ──────────── */}
        <FleetRadar totalDeposited={totalDepositedUsd} blendedApy={blendedApy} />

        {/* ── How it works ──────────────────────────────────────────────────── */}
        <div style={{ marginBottom: 96, position: "relative", zIndex: 1 }}>
          <Reveal>
            <div style={{ marginBottom: 40 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-low)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10, fontFamily: "var(--font-mono)" }}>
                How it works
              </div>
              <h2 style={{ fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 700, letterSpacing: "-0.015em", color: "var(--text-hi)" }}>
                Set it up once. The protocol handles the rest.
              </h2>
            </div>
          </Reveal>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden" }}>
            {[
              { n: "01", title: "Deposit", desc: "Deposit USDC or SOL into the vault. You receive shares proportional to your stake in the pool." },
              { n: "02", title: "Monitor", desc: "The keeper bot fetches live APY data from every supported protocol on a 15-minute cycle." },
              { n: "03", title: "Route", desc: "80% of the vault moves to the highest-yielding protocol. 20% stays in the runner-up." },
              { n: "04", title: "Compound", desc: "Yield is harvested and reinvested every hour. Your position grows without any action from you." },
            ].map(({ n, title, desc }, i) => (
              <Reveal key={n} delay={i * 0.06}>
                <div style={{
                  padding: "32px 28px", height: "100%",
                  background: "var(--ink-800)",
                  borderLeft: i > 0 ? "1px solid var(--line)" : "none",
                }}>
                  <div className="mono-num" style={{ fontSize: 11, color: "var(--text-low)", marginBottom: 20, fontWeight: 500 }}>{n}</div>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: "var(--text-hi)" }}>{title}</div>
                  <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.65 }}>{desc}</div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>

        {/* ── Live rates ─────────────────────────────────────────────────────── */}
        <div style={{ marginBottom: 96, position: "relative", zIndex: 1 }}>
          <Reveal>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 24 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-low)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
                  Live rates
                </div>
                <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 700, letterSpacing: "-0.01em", color: "var(--text-hi)" }}>
                  Where your money goes right now.
                </h2>
              </div>
              <Link href="/apys" style={{ fontSize: 13, color: "var(--text-mid)", textDecoration: "none" }}>
                All protocols →
              </Link>
            </div>
          </Reveal>

          <Reveal delay={0.08}>
            <div style={{ border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden" }}>
              <div style={{
                display: "grid", gridTemplateColumns: "1fr 100px 100px",
                padding: "10px 20px", background: "var(--ink-700)",
                fontSize: 11, fontWeight: 600, color: "var(--text-low)",
                textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: "var(--font-mono)",
              }}>
                <span>Protocol</span>
                <span style={{ textAlign: "right" }}>Asset</span>
                <span style={{ textAlign: "right" }}>APY</span>
              </div>
              {routable.slice(0, 5).map((p, i) => (
                <div key={p.protocolId} style={{
                  display: "grid", gridTemplateColumns: "1fr 100px 100px",
                  padding: "14px 20px", borderTop: "1px solid var(--line)",
                  alignItems: "center",
                  background: "var(--ink-800)",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: p.color, flexShrink: 0 }} />
                    <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text-hi)" }}>{p.name}</span>
                    {i === 0 && (
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                        background: "rgba(63,224,160,0.12)", color: "var(--signal)",
                        border: "1px solid rgba(63,224,160,0.25)", letterSpacing: "0.04em",
                        fontFamily: "var(--font-mono)",
                      }}>ROUTING HERE</span>
                    )}
                    {i === 1 && (
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                        background: "rgba(34,179,126,0.1)", color: "var(--signal-dim)",
                        border: "1px solid rgba(34,179,126,0.2)", letterSpacing: "0.04em",
                        fontFamily: "var(--font-mono)",
                      }}>20% HERE</span>
                    )}
                  </div>
                  <span className="mono-num" style={{ textAlign: "right", color: "var(--text-mid)", fontSize: 12 }}>
                    {p.asset}
                  </span>
                  <span className="mono-num" style={{
                    textAlign: "right", fontWeight: 500, fontSize: 15,
                    color: i === 0 ? "var(--signal)" : "var(--text-hi)",
                  }}>
                    {fmt(p.apyPercent)}%
                  </span>
                </div>
              ))}
              {informational.map((p) => (
                <div key={p.protocolId} style={{
                  display: "grid", gridTemplateColumns: "1fr 100px 100px",
                  padding: "14px 20px", borderTop: "1px solid var(--line)",
                  alignItems: "center",
                  background: "var(--ink-800)",
                  opacity: 0.5,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: p.color, flexShrink: 0 }} />
                    <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text-hi)" }}>{p.name}</span>
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                      background: "rgba(154,168,184,0.1)", color: "var(--text-mid)",
                      border: "1px solid var(--line)", letterSpacing: "0.04em",
                      fontFamily: "var(--font-mono)",
                    }}>REFERENCE ONLY</span>
                  </div>
                  <span className="mono-num" style={{ textAlign: "right", color: "var(--text-mid)", fontSize: 12 }}>
                    {p.asset}
                  </span>
                  <span className="mono-num" style={{ textAlign: "right", fontWeight: 500, fontSize: 15, color: "var(--text-mid)" }}>
                    {fmt(p.apyPercent)}%
                  </span>
                </div>
              ))}
            </div>
          </Reveal>
        </div>

        {/* ── Access tiers ──────────────────────────────────────────────────── */}
        <div style={{ marginBottom: 96, position: "relative", zIndex: 1 }}>
          <Reveal>
            <div style={{ marginBottom: 40 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-low)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10, fontFamily: "var(--font-mono)" }}>
                Access tiers
              </div>
              <h2 style={{ fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 700, letterSpacing: "-0.015em", color: "var(--text-hi)", marginBottom: 16 }}>
                Hold $YPILOT. Pay less on profit.
              </h2>
              <p style={{ color: "var(--text-mid)", fontSize: 14, maxWidth: 520, lineHeight: 1.65 }}>
                Performance fees are tiered by how much $YPILOT you hold — Gold pays nothing, Silver pays 3%,
                Bronze pays 6%. No $YPILOT at all still works, at the 9% standard rate. No deposit fees, no
                management fees, ever. Fees apply to profit only — never your principal.
              </p>
            </div>
          </Reveal>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            {[
              { tier: "Gold", color: "var(--token)", req: "1,000,000+ $YPILOT", fee: "0%" },
              { tier: "Silver", color: "var(--text-mid)", req: "100,000+ $YPILOT", fee: "3%" },
              { tier: "Bronze", color: "#CD7F32", req: "10,000+ $YPILOT", fee: "6%" },
              { tier: "Standard", color: "var(--text-low)", req: "No $YPILOT required", fee: "9%" },
            ].map(({ tier, color, req, fee }, i) => (
              <Reveal key={tier} delay={i * 0.05}>
                <div style={{
                  border: "1px solid var(--line)", borderRadius: 12, padding: "22px 20px",
                  background: "var(--ink-800)", height: "100%",
                }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color, marginBottom: 4, fontFamily: "var(--font-display)" }}>{tier}</div>
                  <div style={{ fontSize: 12, color: "var(--text-low)", marginBottom: 16 }}>{req}</div>
                  <div className="mono-num" style={{ fontSize: 28, fontWeight: 500, color: "var(--text-hi)", marginBottom: 2 }}>{fee}</div>
                  <div style={{ fontSize: 11, color: "var(--text-low)" }}>on profit at exit — no deposit cap, ever</div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>

        {/* ── Transparency ──────────────────────────────────────────────────── */}
        <div style={{ marginBottom: 96, position: "relative", zIndex: 1 }}>
          <Reveal>
            <div style={{ marginBottom: 32 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-low)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10, fontFamily: "var(--font-mono)" }}>
                Transparency
              </div>
              <h2 style={{ fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 700, letterSpacing: "-0.015em", color: "var(--text-hi)", marginBottom: 16 }}>
                Open source. On-chain. Verify it yourself.
              </h2>
              <p style={{ color: "var(--text-mid)", fontSize: 14, maxWidth: 520, lineHeight: 1.65 }}>
                No individual — including the YieldPilot team — can access or move your funds outside
                of the defined program instructions. The code is public.
              </p>
            </div>
          </Reveal>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
            <Reveal>
              <div style={{
                background: "var(--ink-800)", border: "1px solid var(--line)",
                borderRadius: 10, padding: "20px 24px",
                display: "flex", flexDirection: "column", gap: 10, height: "100%",
              }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-low)", textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: "var(--font-mono)" }}>Program</div>
                <div className="mono-num" style={{ fontSize: 12, color: "var(--text-mid)", wordBreak: "break-all" }}>
                  {process.env.NEXT_PUBLIC_PROGRAM_ID || "8c7Boyk91MWkn5jabf5CnYD8DrG6p4hYm9eDdAAWXEKH"}
                </div>
                <a
                  href={`https://solscan.io/account/${process.env.NEXT_PUBLIC_PROGRAM_ID || "8c7Boyk91MWkn5jabf5CnYD8DrG6p4hYm9eDdAAWXEKH"}?cluster=${IS_MAINNET ? "mainnet-beta" : "devnet"}`}
                  target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 12, color: "var(--signal)", textDecoration: "none" }}
                >
                  View on Solscan →
                </a>
              </div>
            </Reveal>

            <Reveal delay={0.06}>
              <div style={{
                background: "var(--ink-800)", border: "1px solid var(--line)",
                borderRadius: 10, padding: "20px 24px",
                display: "flex", flexDirection: "column", gap: 8, height: "100%",
              }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-low)", textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: "var(--font-mono)" }}>Built with</div>
                {["Anchor 0.31", "Kamino", "Marinade", "Jito", "Solend"].map(t => (
                  <span key={t} style={{ fontSize: 13, color: "var(--text-mid)" }}>{t}</span>
                ))}
              </div>
            </Reveal>
          </div>
        </div>

        {/* ── FAQ ───────────────────────────────────────────────────────────── */}
        <div style={{ marginBottom: 96, position: "relative", zIndex: 1 }}>
          <Reveal>
            <div style={{ marginBottom: 32 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-low)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10, fontFamily: "var(--font-mono)" }}>FAQ</div>
              <h2 style={{ fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 700, letterSpacing: "-0.015em", color: "var(--text-hi)" }}>Common questions.</h2>
            </div>
          </Reveal>

          <Reveal delay={0.08}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              {[
                ["Is this non-custodial?", "Yes. Funds are held in on-chain smart contracts governed by the program. No one — including us — can access your funds outside the defined instructions."],
                ["What are the fees?", "Performance fees are tiered by how much $YPILOT you hold: Gold (1,000,000+) pays 0%, Silver (100,000+) pays 3%, Bronze (10,000+) pays 6%, and holding none still works at 9%. Fees apply on profits only, collected at withdrawal. Nothing on deposits or idle balances."],
                ["How does routing work?", "A keeper bot fetches live APY data every 15 minutes. When a better rate exists beyond a 0.5% threshold, it rebalances — 80% to the top protocol, 20% to the runner-up."],
                ["Can I withdraw anytime?", "Yes. Withdrawals are always available, even if the vault is paused for deposits. You receive your principal plus all earned yield, minus the tiered performance fee on profits (9% base, down to 0% for Gold)."],
                ["Has the code been audited?", `Not yet — the team is validating real product interest before commissioning a paid audit. The on-chain program ID is publicly verifiable on Solscan at any time${IS_MAINNET ? "" : ", and the protocol is currently running on devnet while integrations are being finalized"}.`],
              ].map(([q, a], i) => (
                <details key={i} style={{ borderTop: "1px solid var(--line)" }}>
                  <summary style={{
                    fontWeight: 600, fontSize: 14, listStyle: "none", cursor: "pointer",
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "20px 0", userSelect: "none",
                  }}>
                    <span style={{ color: "var(--text-hi)" }}>{q}</span>
                    <span style={{ color: "var(--text-low)", fontSize: 18, fontWeight: 300, flexShrink: 0, marginLeft: 16 }}>+</span>
                  </summary>
                  <p style={{ color: "var(--text-mid)", fontSize: 14, lineHeight: 1.7, paddingBottom: 20, marginTop: 0 }}>{a}</p>
                </details>
              ))}
              <div style={{ borderTop: "1px solid var(--line)" }} />
            </div>
          </Reveal>
        </div>

        {/* ── Bottom CTA ────────────────────────────────────────────────────── */}
        <Reveal>
          <div style={{
            border: "1px solid var(--line)", borderRadius: 16,
            padding: "56px 48px", background: "var(--ink-800)",
            position: "relative", zIndex: 1,
          }}>
            <div style={{ maxWidth: 480 }}>
              <h2 style={{ fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 700, letterSpacing: "-0.015em", marginBottom: 4, color: "var(--text-hi)" }}>
                Your capital. Always working.
              </h2>
              <h2 style={{ fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 700, letterSpacing: "-0.015em", color: "var(--signal)", marginBottom: 20 }}>
                Never leaving money on the table.
              </h2>
              <p style={{ color: "var(--text-mid)", fontSize: 14, marginBottom: 32, lineHeight: 1.65 }}>
                Non-custodial. Transparent. Open source.
              </p>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                {connected ? (
                  <Link href="/dashboard" style={{
                    background: "var(--signal)", color: "var(--ink-900)",
                    padding: "12px 26px", borderRadius: 8,
                    fontWeight: 700, fontSize: 14, textDecoration: "none",
                  }}>
                    Open Dashboard
                  </Link>
                ) : (
                  <button onClick={() => setVisible(true)} style={{
                    background: "var(--signal)", color: "var(--ink-900)", border: "none",
                    padding: "12px 26px", borderRadius: 8,
                    fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "var(--font-body)",
                  }}>
                    Connect Wallet
                  </button>
                )}
                <Link href="/whitepaper" style={{
                  color: "var(--text-mid)", fontSize: 14, textDecoration: "none",
                  display: "flex", alignItems: "center",
                }}>
                  Read the whitepaper →
                </Link>
              </div>
            </div>
          </div>
        </Reveal>

      </div>
    </div>
  );
}
