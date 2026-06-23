"use client";

import Link from "next/link";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useWallet } from "@solana/wallet-adapter-react";
import { useApys } from "@/hooks/useApys";
import { fmt } from "@/components/ui";

export default function Home() {
  const { setVisible } = useWalletModal();
  const { connected } = useWallet();
  const { apys } = useApys();
  const sorted = [...apys].sort((a, b) => b.apyBps - a.apyBps);
  const best = sorted[0];

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "0 24px 120px" }}>

      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <div style={{ padding: "88px 0 72px", maxWidth: 700 }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 28 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--green)" }} />
          <span style={{ fontSize: 12, color: "var(--text-muted)", letterSpacing: "0.04em" }}>
            Live on Solana devnet
          </span>
        </div>

        <h1 style={{
          fontSize: "clamp(34px, 5.5vw, 56px)", fontWeight: 800,
          letterSpacing: "-0.035em", lineHeight: 1.1, marginBottom: 10, color: "var(--text)",
        }}>
          Deposit once.
        </h1>
        <h1 style={{
          fontSize: "clamp(34px, 5.5vw, 56px)", fontWeight: 800,
          letterSpacing: "-0.035em", lineHeight: 1.1, marginBottom: 28,
          color: "var(--purple-light)",
        }}>
          Earn the best rate automatically.
        </h1>

        <p style={{
          color: "var(--text-muted)", fontSize: 16, lineHeight: 1.75,
          maxWidth: 500, marginBottom: 40,
        }}>
          YieldPilot routes your USDC or SOL to the highest-yielding Solana lending protocol
          every 15 minutes. No manual moves. No missed rates.
        </p>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          {connected ? (
            <Link href="/dashboard" style={{
              background: "var(--purple)", color: "#fff",
              padding: "11px 26px", borderRadius: 8,
              fontWeight: 600, fontSize: 14, textDecoration: "none",
            }}>
              Open Dashboard
            </Link>
          ) : (
            <button onClick={() => setVisible(true)} style={{
              background: "var(--purple)", color: "#fff", border: "none",
              padding: "11px 26px", borderRadius: 8,
              fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "Inter, sans-serif",
            }}>
              Connect Wallet
            </button>
          )}
          <Link href="/apys" style={{
            color: "var(--text-muted)", fontSize: 14, textDecoration: "none",
          }}>
            View live rates →
          </Link>
        </div>

        {/* Inline proof points */}
        <div style={{ display: "flex", gap: 32, marginTop: 48, flexWrap: "wrap" }}>
          {[
            { value: "15 min", label: "rebalance cycle" },
            { value: "0–6%", label: "perf fee · tiered by $YPILOT held" },
            { value: "Non-custodial", label: "on-chain smart contract" },
            ...(best ? [{ value: `${fmt(best.apyPercent)}%`, label: `best rate now · ${best.name}` }] : []),
          ].map(({ value, label }) => (
            <div key={label}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 18, fontWeight: 700, color: "var(--text)" }}>
                {value}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}>{label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── How it works ──────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 96 }}>
        <div style={{ marginBottom: 40 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>How it works</div>
          <h2 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.025em", color: "var(--text)", marginBottom: 4 }}>
            Set it up once.
          </h2>
          <h2 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.025em", color: "var(--purple-light)" }}>
            The protocol handles the rest.
          </h2>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
          {[
            { n: "01", title: "Deposit", desc: "Deposit USDC or SOL into the vault. You receive shares proportional to your stake in the pool." },
            { n: "02", title: "Monitor", desc: "The keeper bot fetches live APY data from every supported protocol on a 15-minute cycle." },
            { n: "03", title: "Route", desc: "80% of the vault moves to the highest-yielding protocol. 20% stays in the runner-up." },
            { n: "04", title: "Compound", desc: "Yield is harvested and reinvested every hour. Your position grows without any action from you." },
          ].map(({ n, title, desc }, i) => (
            <div key={n} style={{
              padding: "32px 28px",
              background: "var(--surface)",
              borderLeft: i > 0 ? "1px solid var(--border)" : "none",
            }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", marginBottom: 20, fontWeight: 600 }}>{n}</div>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10, color: "var(--text)" }}>{title}</div>
              <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.65 }}>{desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Live rates strip ──────────────────────────────────────────────── */}
      <div style={{ marginBottom: 96 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 24 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>Live rates</div>
            <h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>
              Where your money goes right now.
            </h2>
          </div>
          <Link href="/apys" style={{ fontSize: 13, color: "var(--text-muted)", textDecoration: "none" }}>
            All protocols →
          </Link>
        </div>

        <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 100px 100px",
            padding: "10px 20px", background: "var(--surface-2)",
            fontSize: 11, fontWeight: 700, color: "var(--text-dim)",
            textTransform: "uppercase", letterSpacing: "0.06em",
          }}>
            <span>Protocol</span>
            <span style={{ textAlign: "right" }}>Asset</span>
            <span style={{ textAlign: "right" }}>APY</span>
          </div>
          {sorted.slice(0, 5).map((p, i) => (
            <div key={p.protocolId} style={{
              display: "grid", gridTemplateColumns: "1fr 100px 100px",
              padding: "14px 20px", borderTop: "1px solid var(--border)",
              alignItems: "center",
              background: "var(--surface)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: p.color, flexShrink: 0 }} />
                <span style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</span>
                {i === 0 && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                    background: "rgba(52,211,153,0.12)", color: "var(--green)",
                    border: "1px solid rgba(52,211,153,0.2)", letterSpacing: "0.04em",
                  }}>ROUTING HERE</span>
                )}
              </div>
              <span style={{ textAlign: "right", color: "var(--text-muted)", fontSize: 12, fontFamily: "var(--mono)" }}>
                {p.asset}
              </span>
              <span style={{
                textAlign: "right", fontFamily: "var(--mono)", fontWeight: 700, fontSize: 15,
                color: i === 0 ? "var(--green)" : "var(--text)",
              }}>
                {fmt(p.apyPercent)}%
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Access tiers ──────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 96 }}>
        <div style={{ marginBottom: 40 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Access tiers</div>
          <h2 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.025em", color: "var(--text)", marginBottom: 4 }}>
            Hold $YPILOT.
          </h2>
          <h2 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.025em", color: "var(--purple-light)", marginBottom: 16 }}>
            Unlock higher deposit limits.
          </h2>
          <p style={{ color: "var(--text-muted)", fontSize: 14, maxWidth: 480, lineHeight: 1.65 }}>
            Performance fees are tiered by how much $YPILOT you hold — Gold pays nothing, Silver pays 3%,
            Bronze pays 6%. No deposit fees, no management fees. The more you hold, the less you pay.
          </p>
        </div>

        <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1fr 1fr 100px",
            padding: "10px 24px", background: "var(--surface-2)",
            fontSize: 11, fontWeight: 700, color: "var(--text-dim)",
            textTransform: "uppercase", letterSpacing: "0.06em",
          }}>
            <span>Tier</span>
            <span>$YPILOT required</span>
            <span>Deposit cap</span>
            <span>Perf. fee</span>
          </div>
          {[
            { tier: "Gold",   color: "#F59E0B", req: "1,000,000+", cap: "Unlimited",  fee: "0%", muted: false },
            { tier: "Silver", color: "#94A3B8", req: "100,000+",   cap: "$10,000",    fee: "3%", muted: false },
            { tier: "Bronze", color: "#CD7F32", req: "10,000+",    cap: "$1,000",     fee: "6%", muted: false },
            { tier: "None",   color: "#6B7280", req: "< 10,000",   cap: "No access",  fee: "—",  muted: true  },
          ].map(({ tier, color, req, cap, fee, muted }) => (
            <div key={tier} style={{
              display: "grid", gridTemplateColumns: "1fr 1fr 1fr 100px",
              padding: "18px 24px", borderTop: "1px solid var(--border)",
              alignItems: "center", background: "var(--surface)",
              opacity: muted ? 0.45 : 1,
            }}>
              <span style={{ fontWeight: 700, fontSize: 14, color }}>{tier}</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--text-muted)", paddingLeft: 8 }}>{req}</span>
              <span style={{ fontSize: 13, color: cap === "Unlimited" ? "var(--green)" : cap === "No access" ? "var(--text-dim)" : "var(--text)", paddingLeft: 8 }}>
                {cap}
              </span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--text-muted)", paddingLeft: 8 }}>{fee}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── On-chain proof ────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 96 }}>
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Transparency</div>
          <h2 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.025em", color: "var(--text)", marginBottom: 4 }}>
            Open source. On-chain.
          </h2>
          <h2 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.025em", color: "var(--purple-light)", marginBottom: 16 }}>
            Verify everything yourself.
          </h2>
          <p style={{ color: "var(--text-muted)", fontSize: 14, maxWidth: 500, lineHeight: 1.65 }}>
            No individual — including the YieldPilot team — can access or move your funds outside
            of the defined program instructions. The code is public.
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
          {[
            {
              label: "Program",
              id: process.env.NEXT_PUBLIC_PROGRAM_ID || "8c7Boyk91MWkn5jabf5CnYD8DrG6p4hYm9eDdAAWXEKH",
              network: "devnet",
            },
          ].map(({ label, id, network }) => (
            <div key={label} style={{
              background: "var(--surface)", border: "1px solid var(--border)",
              borderRadius: 10, padding: "20px 24px",
              display: "flex", flexDirection: "column", gap: 10,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-muted)", wordBreak: "break-all" }}>{id}</div>
              <a
                href={`https://solscan.io/account/${id}?cluster=${network}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 12, color: "var(--purple-light)", textDecoration: "none" }}
              >
                View on Solscan →
              </a>
            </div>
          ))}

          <div style={{
            background: "var(--surface)", border: "1px solid var(--border)",
            borderRadius: 10, padding: "20px 24px",
            display: "flex", flexDirection: "column", gap: 8,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Built with</div>
            {["Solana", "Anchor 0.31", "Solend", "Kamino", "Marinade"].map(t => (
              <span key={t} style={{ fontSize: 13, color: "var(--text-muted)" }}>{t}</span>
            ))}
          </div>
        </div>
      </div>

      {/* ── FAQ ───────────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 96 }}>
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>FAQ</div>
          <h2 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.025em" }}>Common questions.</h2>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          {[
            ["Is this non-custodial?", "Yes. Funds are held in on-chain smart contracts governed by the program. No one — including us — can access your funds outside the defined instructions."],
            ["What are the fees?", "Performance fees are tiered by $YPILOT held: Bronze (10k+) pays 6%, Silver (100k+) pays 3%, Gold (1M+) pays 0%. Fees apply on profits only, collected at withdrawal. Nothing on deposits or idle balances."],
            ["How does routing work?", "A keeper bot fetches live APY data every 15 minutes. When a better rate exists beyond a 0.5% threshold, it rebalances — 80% to the top protocol, 20% to the runner-up."],
            ["Can I withdraw anytime?", "Yes. Withdrawals are always available, even if the vault is paused for deposits. You receive your principal plus all earned yield, minus the tiered performance fee on profits (6% Bronze, 3% Silver, 0% Gold)."],
            ["Has the code been audited?", "Not yet. A third-party audit is planned before mainnet launch. The on-chain program ID is publicly verifiable on Solscan at any time."],
          ].map(([q, a], i) => (
            <details key={i} style={{ borderTop: "1px solid var(--border)" }}>
              <summary style={{
                fontWeight: 600, fontSize: 14, listStyle: "none", cursor: "pointer",
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "20px 0", userSelect: "none",
              }}>
                <span style={{ color: "var(--text)" }}>{q}</span>
                <span style={{ color: "var(--text-dim)", fontSize: 18, fontWeight: 300, flexShrink: 0, marginLeft: 16 }}>+</span>
              </summary>
              <p style={{ color: "var(--text-muted)", fontSize: 14, lineHeight: 1.7, paddingBottom: 20, marginTop: 0 }}>{a}</p>
            </details>
          ))}
          <div style={{ borderTop: "1px solid var(--border)" }} />
        </div>
      </div>

      {/* ── Bottom CTA ────────────────────────────────────────────────────── */}
      <div style={{
        border: "1px solid var(--border)", borderRadius: 16,
        padding: "56px 48px", background: "var(--surface)",
      }}>
        <div style={{ maxWidth: 480 }}>
          <h2 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.025em", marginBottom: 4 }}>
            Your capital. Always working.
          </h2>
          <h2 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.025em", color: "var(--purple-light)", marginBottom: 20 }}>
            Never leaving money on the table.
          </h2>
          <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 32, lineHeight: 1.65 }}>
            Non-custodial. Transparent. Open source.
          </p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {connected ? (
              <Link href="/dashboard" style={{
                background: "var(--purple)", color: "#fff",
                padding: "11px 26px", borderRadius: 8,
                fontWeight: 600, fontSize: 14, textDecoration: "none",
              }}>
                Open Dashboard
              </Link>
            ) : (
              <button onClick={() => setVisible(true)} style={{
                background: "var(--purple)", color: "#fff", border: "none",
                padding: "11px 26px", borderRadius: 8,
                fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "Inter, sans-serif",
              }}>
                Connect Wallet
              </button>
            )}
            <Link href="/whitepaper" style={{
              color: "var(--text-muted)", fontSize: 14, textDecoration: "none",
              display: "flex", alignItems: "center",
            }}>
              Read the whitepaper →
            </Link>
          </div>
        </div>
      </div>

    </div>
  );
}
