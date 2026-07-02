"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

const IS_MAINNET = process.env.NEXT_PUBLIC_SOLANA_NETWORK === "mainnet-beta";
const PROGRAM_ID = process.env.NEXT_PUBLIC_PROGRAM_ID || "8c7Boyk91MWkn5jabf5CnYD8DrG6p4hYm9eDdAAWXEKH";

const SECTIONS: [string, string][] = [
  ["abstract", "1. Abstract"],
  ["problem", "2. The Problem"],
  ["how-it-works", "3. How YieldPilot Works"],
  ["architecture", "4. Smart Contract Architecture"],
  ["fees", "5. Fee Structure"],
  ["tiers", "6. Token-Gated Access Tiers"],
  ["security", "7. Security Model"],
  ["roadmap", "8. Roadmap"],
  ["disclaimer", "9. Disclaimer"],
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} style={{ marginBottom: 56, scrollMarginTop: 90 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-low)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
        {title.split(".")[0]}
      </div>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 700, letterSpacing: "-0.015em", marginBottom: 18, paddingBottom: 14, borderBottom: "1px solid var(--line)", color: "var(--text-hi)" }}>
        {title.split(". ")[1]}
      </h2>
      {children}
    </section>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p style={{ color: "var(--text-mid)", fontSize: 15, lineHeight: 1.85, marginBottom: 16 }}>{children}</p>;
}

function H3({ children }: { children: React.ReactNode }) {
  return <h3 style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 700, marginBottom: 8, marginTop: 24, color: "var(--text-hi)" }}>{children}</h3>;
}

function Table({ rows }: { rows: string[][] }) {
  return (
    <div style={{ overflowX: "auto", marginBottom: 20, border: "1px solid var(--line)", borderRadius: 8 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            {rows[0].map((h, i) => (
              <th key={i} style={{ textAlign: "left", padding: "10px 14px", background: "var(--ink-700)", borderBottom: "1px solid var(--line)", color: "var(--text-low)", fontWeight: 600, textTransform: "uppercase", fontSize: 11, letterSpacing: "0.06em", fontFamily: "var(--font-mono)" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(1).map((row, i) => (
            <tr key={i} style={{ borderBottom: i === rows.length - 2 ? "none" : "1px solid var(--line)" }}>
              {row.map((cell, j) => (
                <td key={j} className={j > 0 ? "mono-num" : undefined} style={{ padding: "12px 14px", color: j === 0 ? "var(--text-hi)" : "var(--text-mid)" }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CopyableId({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span className="mono-num" style={{ color: "var(--signal)", fontSize: 13 }}>{value}</span>
      <button
        onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        style={{ background: "var(--ink-700)", border: "1px solid var(--line)", color: "var(--text-mid)", fontSize: 11, padding: "2px 8px", borderRadius: 4, cursor: "pointer", fontFamily: "var(--font-mono)" }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

export default function Whitepaper() {
  const [progress, setProgress] = useState(0);
  const [activeSection, setActiveSection] = useState(SECTIONS[0][0]);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onScroll() {
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - doc.clientHeight;
      setProgress(scrollable > 0 ? Math.min(1, window.scrollY / scrollable) : 0);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveSection(entry.target.id);
        }
      },
      { rootMargin: "-100px 0px -70% 0px" }
    );
    SECTIONS.forEach(([id]) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  return (
    <div>
      {/* Reading progress bar */}
      <div style={{ position: "fixed", top: 60, left: 0, right: 0, height: 2, background: "var(--line)", zIndex: 40 }}>
        <div style={{ height: "100%", width: `${progress * 100}%`, background: "var(--signal)", transition: "width 0.1s linear" }} />
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "48px 16px 100px", display: "grid", gridTemplateColumns: "220px 1fr", gap: 48 }}>

        {/* TOC rail */}
        <div style={{ display: "none" }} className="whitepaper-toc">
        <aside style={{ position: "sticky", top: 90, maxHeight: "calc(100vh - 110px)", overflowY: "auto" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-low)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12, fontFamily: "var(--font-mono)" }}>
            Contents
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, borderLeft: "1px solid var(--line)" }}>
            {SECTIONS.map(([id, title]) => (
              <a
                key={id}
                href={`#${id}`}
                style={{
                  padding: "6px 0 6px 14px", fontSize: 13, textDecoration: "none",
                  borderLeft: activeSection === id ? "2px solid var(--signal)" : "2px solid transparent",
                  marginLeft: -1,
                  color: activeSection === id ? "var(--signal)" : "var(--text-mid)",
                  fontWeight: activeSection === id ? 600 : 400,
                }}
              >
                {title}
              </a>
            ))}
          </div>
        </aside>
        </div>

        {/* Content */}
        <div ref={contentRef} style={{ maxWidth: "68ch" }}>
          <div style={{ marginBottom: 48 }}>
            <div className="mono-num" style={{ fontSize: 12, color: "var(--text-low)", marginBottom: 12 }}>YIELDPILOT WHITEPAPER v1.0 — JULY 2026</div>
            <h1 style={{ fontFamily: "var(--font-display)", fontSize: 34, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.15, marginBottom: 16, color: "var(--text-hi)" }}>
              YieldPilot: Automated Yield Optimization on Solana
            </h1>
            <p style={{ color: "var(--text-mid)", fontSize: 16, lineHeight: 1.7 }}>
              A non-custodial protocol that automatically routes deposits across Solana&apos;s
              highest-yielding lending and liquid staking protocols, compounding returns and
              rebalancing every 15 minutes.
            </p>
            {!IS_MAINNET && (
              <div style={{
                marginTop: 20, padding: "10px 16px", borderRadius: 8,
                background: "rgba(245,184,75,0.1)", border: "1px solid rgba(245,184,75,0.25)",
                fontSize: 13, color: "var(--warn)",
              }}>
                Currently running on Solana devnet while protocol integrations are being finalized ahead of mainnet launch.
              </div>
            )}
          </div>

          <Section id="abstract" title="1. Abstract">
            <P>YieldPilot is a non-custodial yield optimization protocol built on Solana. Users deposit USDC or SOL into smart contract vaults. A keeper bot continuously monitors APYs across leading Solana lending and liquid staking protocols — including Kamino, Marinade, Jito, and Solend — and automatically rebalances the vault to maximize returns.</P>
            <P>Users receive vault shares representing their proportional ownership. Shares appreciate in value as yield accrues. Depositors can withdraw at any time, receiving their principal plus earned yield minus a performance fee charged only on profits.</P>
          </Section>

          <Section id="problem" title="2. The Problem">
            <P>Solana DeFi offers some of the highest yields in crypto — but capturing those yields requires constant manual monitoring. APYs shift across protocols hour by hour. A depositor who puts funds into one protocol today may be earning meaningfully less than a competing protocol by tomorrow, with no automatic mechanism to move their funds.</P>
            <P>Most users either leave money idle in a single protocol, or spend hours manually chasing rates. YieldPilot solves this by automating the entire process.</P>
            <Table rows={[
              ["", "Manual Yield Farming", "YieldPilot"],
              ["Rate monitoring", "Manual, time-consuming", "Automated every 15 min"],
              ["Rebalancing", "Manual transactions", "Automated keeper bot"],
              ["Compounding", "Manual harvest required", "Hourly auto-compound"],
              ["Custody", "Protocol-held funds", "Non-custodial vault shares"],
            ]} />
          </Section>

          <Section id="how-it-works" title="3. How YieldPilot Works">
            <H3>3.1 Deposit</H3>
            <P>Users deposit USDC or SOL into a YieldPilot vault. Vault shares are minted proportional to the current share price — total vault assets divided by total shares outstanding. Each depositor owns an exact, verifiable fraction of the pool.</P>
            <H3>3.2 Winner-Takes-Most Routing</H3>
            <P>When the keeper bot identifies the highest-yielding protocol, it routes 80% of vault assets there and keeps 20% in the runner-up. This captures most upside while maintaining diversification. Rebalancing only triggers when the APY spread exceeds 0.5%, preventing unnecessary churn from minor fluctuations.</P>
            <H3>3.3 Auto-Compound</H3>
            <P>Every hour, the keeper bot harvests accrued rewards and reinvests them back into the vault. This compounds returns continuously, improving long-term yield versus protocols that require manual harvest.</P>
            <H3>3.4 Withdrawal</H3>
            <P>Users burn their vault shares at any time to receive their proportional share of vault assets. The redemption value reflects principal plus all earned yield. A tiered performance fee is deducted from profits only — the rate depends on your $YPILOT holdings. No fee is charged if no profit was earned.</P>
          </Section>

          <Section id="architecture" title="4. Smart Contract Architecture">
            <P>YieldPilot is built with the Anchor framework on Solana. The vault program manages deposits, withdrawals, share minting, rebalancing, and fee collection entirely on-chain.</P>
            <Table rows={[
              ["Instruction", "Description", "Authority"],
              ["initialize_vault", "Create vault with config params", "Admin"],
              ["deposit", "Mint shares in exchange for tokens", "Any user"],
              ["withdraw", "Burn shares, receive tokens + yield", "Any user"],
              ["rebalance", "Update protocol target allocations", "Keeper"],
              ["compound", "Harvest and reinvest rewards", "Keeper"],
              ["deploy_to_* / recall_from_*", "Move funds to/from a protocol", "Keeper"],
              ["set_paused", "Pause / unpause new deposits", "Admin"],
              ["raise_tvl_cap", "Raise the vault's maximum TVL (one-way only, cannot decrease)", "Admin"],
              ["set_gate_mint", "Set the token-gate mint (one-time only, immutable after)", "Admin"],
              ["set_keeper", "Update keeper wallet address", "Admin"],
              ["propose_admin / accept_admin", "Two-step admin ownership transfer", "Admin / new admin"],
              ["update_tier_thresholds", "Adjust $YPILOT tier thresholds", "Admin"],
              ["emergency_close", "Reclaim rent from an empty vault only", "Admin"],
            ]} />
            <P>
              Program ID{IS_MAINNET ? " (mainnet)" : " (devnet — mainnet deployment pending)"}: <CopyableId value={PROGRAM_ID} /> — verifiable on{" "}
              <a href={`https://solscan.io/account/${PROGRAM_ID}?cluster=${IS_MAINNET ? "mainnet-beta" : "devnet"}`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--signal)" }}>Solscan</a>.
            </P>
          </Section>

          <Section id="fees" title="5. Fee Structure">
            <P>YieldPilot charges a single fee type: a <strong style={{ color: "var(--text-hi)" }}>performance fee on profits at withdrawal</strong>, tiered by $YPILOT holdings. The fee is automatically deducted and routed to the YieldPilot treasury wallet on-chain — fully transparent and verifiable by anyone.</P>
            <Table rows={[
              ["Fee Type", "Amount", "When Charged"],
              ["Performance fee (Standard — no $YPILOT required)", "9% of profit", "On withdrawal, profits only"],
              ["Performance fee (Bronze)", "6% of profit", "On withdrawal, profits only"],
              ["Performance fee (Silver)", "3% of profit", "On withdrawal, profits only"],
              ["Performance fee (Gold)", "0%", "No fee"],
              ["Deposit fee", "None", "—"],
              ["Withdrawal fee", "None", "—"],
              ["Management fee", "None", "—"],
            ]} />
            <P>Example: you hold Silver tier and deposit $5,000 USDC. At a representative ~8% APY, after one year your position grows to roughly $5,400. Your $400 profit incurs a 3% fee ($12). You receive approximately $5,388. Gold tier holders pay no fee at all. No fee is ever charged on principal — only on realized profit.</P>
          </Section>

          <Section id="tiers" title="6. Token-Gated Access Tiers">
            <P>Access to YieldPilot&apos;s fee tiers is gated by holding $YPILOT tokens, measured as an absolute token balance — not a percentage of supply. The more $YPILOT you hold, the lower your performance fee.</P>
            <Table rows={[
              ["Tier", "$YPILOT Required", "Performance Fee"],
              ["Gold",     "1,000,000+", "0%"],
              ["Silver",   "100,000+",   "3%"],
              ["Bronze",   "10,000+",    "6%"],
              ["Standard", "None required", "9%"],
            ]} />
            <P>This tiered model rewards $YPILOT holders with progressively better terms. Gold holders pay zero performance fees — all yield is theirs. Everyone can deposit and withdraw any amount regardless of holdings — there is no deposit cap at any tier. The tier only affects the performance fee rate charged on profit. The $YPILOT token is available on pump.fun.</P>
          </Section>

          <Section id="security" title="7. Security Model">
            <H3>Non-Custodial</H3>
            <P>YieldPilot never holds user funds directly. All assets are held in on-chain program-derived accounts (PDAs) controlled by the vault smart contract. No individual — including the YieldPilot team — can access or move user funds outside of the defined program instructions.</P>
            <H3>Verifiable On-Chain</H3>
            <P>The smart contract is deployed at a fixed program ID on Solana. Anyone can verify the vault state, fee parameters, and treasury address directly on-chain at any time — no need to trust our word.</P>
            <H3>Emergency Pause</H3>
            <P>The vault admin can pause new deposits in the event of an emergency. Withdrawals remain available at all times — users can always retrieve their funds even when the vault is paused.</P>
            <H3>TVL Cap</H3>
            <P>A configurable TVL cap limits total deposits during the early phase, reducing exposure while the protocol matures. The cap can only be raised, never lowered — it cannot be used to trap funds or block withdrawals.</P>
            <H3>Separated Admin &amp; Keeper Wallets</H3>
            <P>The admin wallet (which controls vault configuration) and the keeper wallet (which executes rebalances) are separate keypairs with separate on-chain authorities. Compromising the keeper grants no ability to change fees, pause the vault, or access funds.</P>
            <H3>Audit Status</H3>
            <P>The code has not yet been formally audited by a third party. A professional audit is planned once the protocol has demonstrated real user demand. The TVL cap will be raised incrementally as the protocol matures. Until then, deposit only what you are comfortable risking.</P>
          </Section>

          <Section id="roadmap" title="8. Roadmap">
            <Table rows={[
              ["Phase", "Milestone", "Status"],
              ["Phase 1", "Smart contract development & testing", "Complete"],
              ["Phase 1", "Keeper bot — live APY routing & auto-compound", "Complete"],
              ["Phase 1", "Kamino, Marinade, Jito, Solend integrations", "Complete"],
              ["Phase 1", "Frontend", "Complete"],
              ["Phase 1", "Devnet deployment & vault initialization", "Complete"],
              ["Phase 1", "Admin / keeper wallet separation", "Complete"],
              ["Phase 1", "Mainnet launch with $YPILOT token gating", "Pending"],
              ["Phase 2", "Third-party smart contract audit", "Planned, pending demonstrated demand"],
              ["Phase 2", "Referral system — earn a share of referred yield fees", "Planned"],
              ["Phase 3", "Cross-chain deposits via Wormhole", "Research"],
              ["Phase 3", "Auto-bridge to highest cross-chain yield", "Research"],
            ]} />
          </Section>

          <Section id="disclaimer" title="9. Disclaimer">
            <P>This document is for informational purposes only and does not constitute financial advice or a solicitation to buy or sell any asset. DeFi protocols carry significant risks including smart contract vulnerabilities, protocol failures, and potential loss of funds. Never deposit more than you can afford to lose.</P>
            <P>{IS_MAINNET ? "YieldPilot is deployed on Solana mainnet." : "YieldPilot is currently deployed on Solana devnet — devnet tokens have no value, and mainnet deployment is pending further testing."} Always verify transaction details before signing.</P>
          </Section>

          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 24, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
            <span className="mono-num" style={{ color: "var(--text-low)", fontSize: 12 }}>YieldPilot Whitepaper v1.0 — July 2026</span>
            <Link href="/" style={{ color: "var(--signal)", fontSize: 13, textDecoration: "none" }}>Back to home</Link>
          </div>
        </div>
      </div>

      <style>{`
        @media (min-width: 960px) {
          .whitepaper-toc { display: block !important; }
        }
      `}</style>
    </div>
  );
}
