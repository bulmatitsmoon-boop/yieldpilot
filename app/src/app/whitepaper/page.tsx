"use client";

import Link from "next/link";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 48 }}>
      <h2 style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em", marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid var(--border)" }}>{title}</h2>
      {children}
    </div>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p style={{ color: "var(--text-muted)", fontSize: 14, lineHeight: 1.8, marginBottom: 14 }}>{children}</p>;
}

function H3({ children }: { children: React.ReactNode }) {
  return <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8, marginTop: 20 }}>{children}</h3>;
}

function Table({ rows }: { rows: string[][] }) {
  return (
    <div style={{ overflowX: "auto", marginBottom: 20 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            {rows[0].map((h, i) => (
              <th key={i} style={{ textAlign: "left", padding: "10px 14px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontWeight: 700, textTransform: "uppercase", fontSize: 11, letterSpacing: "0.06em" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(1).map((row, i) => (
            <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
              {row.map((cell, j) => (
                <td key={j} style={{ padding: "12px 14px", color: j === 0 ? "var(--text)" : "var(--text-muted)" }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Whitepaper() {
  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "48px 16px 100px" }}>

      <div style={{ marginBottom: 48 }}>
        <div style={{ fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--mono)", marginBottom: 12 }}>YIELDPILOT WHITEPAPER v1.0 — JUNE 2026</div>
        <h1 style={{ fontSize: 36, fontWeight: 900, letterSpacing: "-0.03em", lineHeight: 1.1, marginBottom: 16 }}>
          YieldPilot: Automated Yield<br />Optimization on Solana
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 16, lineHeight: 1.7, maxWidth: 580 }}>
          A non-custodial protocol that automatically routes deposits across Solana&apos;s
          highest-yielding lending and liquidity protocols, compounding returns and
          rebalancing every 15 minutes.
        </p>
      </div>

      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "20px 24px", marginBottom: 48 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>Table of Contents</div>
        {[
          ["1", "Abstract"],
          ["2", "The Problem"],
          ["3", "How YieldPilot Works"],
          ["4", "Smart Contract Architecture"],
          ["5", "Fee Structure"],
          ["6", "Token-Gated Access Tiers"],
          ["7", "Security Model"],
          ["8", "Roadmap"],
          ["9", "Disclaimer"],
        ].map(([n, title]) => (
          <div key={n} style={{ display: "flex", gap: 12, padding: "6px 0", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
            <span style={{ color: "var(--text-dim)", fontFamily: "var(--mono)", minWidth: 20 }}>{n}.</span>
            <span style={{ color: "var(--purple-light)" }}>{title}</span>
          </div>
        ))}
      </div>

      <Section title="1. Abstract">
        <P>YieldPilot is a non-custodial yield optimization protocol built on Solana. Users deposit USDC or SOL into smart contract vaults. A keeper bot continuously monitors APYs across leading Solana lending protocols including Kamino, Marinade, Drift, and Solend, and automatically rebalances the vault to maximize returns.</P>
        <P>Users receive vault shares representing their proportional ownership. Shares appreciate in value as yield accrues. Depositors can withdraw at any time, receiving their principal plus earned yield minus a performance fee charged only on profits.</P>
      </Section>

      <Section title="2. The Problem">
        <P>Solana DeFi offers some of the highest yields in crypto — but capturing those yields requires constant manual monitoring. APYs shift dramatically across protocols hour by hour. A depositor who puts funds into Kamino today may be earning half the yield of Drift by tomorrow, with no automatic mechanism to move their funds.</P>
        <P>Most users either leave money idle in a single protocol, or spend hours manually chasing rates. YieldPilot solves this by automating the entire process.</P>
        <Table rows={[
          ["", "Manual Yield Farming", "YieldPilot"],
          ["Rate monitoring", "Manual, time-consuming", "Automated every 15 min"],
          ["Rebalancing", "Manual transactions", "Automated keeper bot"],
          ["Compounding", "Manual harvest required", "Hourly auto-compound"],
          ["Custody", "Protocol-held funds", "Non-custodial vault shares"],
        ]} />
      </Section>

      <Section title="3. How YieldPilot Works">
        <H3>3.1 Deposit</H3>
        <P>Users deposit USDC or SOL into a YieldPilot vault. Vault shares are minted proportional to the current share price — total vault assets divided by total shares outstanding. Each depositor owns an exact, verifiable fraction of the pool.</P>
        <H3>3.2 Winner-Takes-Most Routing</H3>
        <P>When the keeper bot identifies the highest-yielding protocol, it routes 80% of vault assets there and keeps 20% in the runner-up. This captures most upside while maintaining diversification. Rebalancing only triggers when the APY spread exceeds 0.5%, preventing unnecessary churn from minor fluctuations.</P>
        <H3>3.3 Auto-Compound</H3>
        <P>Every hour, the keeper bot harvests accrued rewards and reinvests them back into the vault. This compounds returns continuously, significantly improving long-term yield versus protocols that require manual harvest.</P>
        <H3>3.4 Withdrawal</H3>
        <P>Users burn their vault shares at any time to receive their proportional share of vault assets. The redemption value reflects principal plus all earned yield. A tiered performance fee is deducted from profits only — the rate depends on your $YPILOT tier. No fee is charged if no profit was earned.</P>
      </Section>

      <Section title="4. Smart Contract Architecture">
        <P>YieldPilot is built with the Anchor framework on Solana. The vault program manages deposits, withdrawals, share minting, rebalancing, and fee collection entirely on-chain.</P>
        <Table rows={[
          ["Instruction", "Description", "Authority"],
          ["initialize_vault", "Create vault with config params", "Admin"],
          ["deposit", "Mint shares in exchange for tokens", "Any user"],
          ["withdraw", "Burn shares, receive tokens + yield", "Any user"],
          ["rebalance", "Update protocol allocations", "Keeper / Admin"],
          ["compound", "Harvest and reinvest rewards", "Keeper / Admin"],
          ["set_paused", "Pause / unpause deposits", "Admin"],
          ["set_tvl_cap", "Update maximum vault TVL", "Admin"],
          ["set_gate_mint", "Update token-gate mint", "Admin"],
          ["set_treasury", "Update fee recipient wallet", "Admin"],
          ["set_keeper", "Update keeper wallet address", "Admin"],
        ]} />
        <P>Program ID (mainnet): <span style={{ fontFamily: "var(--mono)", color: "var(--purple-light)", fontSize: 12 }}>8c7Boyk91MWkn5jabf5CnYD8DrG6p4hYm9eDdAAWXEKH</span>. Verifiable on <a href="https://solscan.io/account/8c7Boyk91MWkn5jabf5CnYD8DrG6p4hYm9eDdAAWXEKH" target="_blank" rel="noopener noreferrer" style={{ color: "var(--purple-light)" }}>Solscan</a>.</P>
      </Section>

      <Section title="5. Fee Structure">
        <P>YieldPilot charges a single fee type: a <strong style={{ color: "var(--text)" }}>performance fee on profits at withdrawal</strong>, tiered by $YPILOT holdings. The fee is automatically deducted and routed to the YieldPilot treasury wallet on-chain — fully transparent and verifiable by anyone.</P>
        <Table rows={[
          ["Fee Type", "Amount", "When Charged"],
          ["Performance fee (Bronze)", "6% of profit", "On withdrawal, profits only"],
          ["Performance fee (Silver)", "3% of profit", "On withdrawal, profits only"],
          ["Performance fee (Gold)", "0%", "No fee"],
          ["Deposit fee", "None", "—"],
          ["Withdrawal fee", "None", "—"],
          ["Management fee", "None", "—"],
        ]} />
        <P>Example: You hold Silver tier and deposit $1,000 USDC. After 6 months your position grows to $1,080. Your $80 profit incurs a 3% fee ($2.40). You receive $1,077.60. Gold tier holders pay no fee at all. No fee is ever charged on principal.</P>
      </Section>

      <Section title="6. Token-Gated Access Tiers">
        <P>Access to YieldPilot vaults is gated by holding $YPILOT tokens. Your token balance determines your tier, which sets both your maximum deposit cap and your performance fee rate. The more $YPILOT you hold, the less you pay and the more you can deposit.</P>
        <Table rows={[
          ["Tier", "Token Requirement", "Deposit Cap", "Performance Fee"],
          ["Gold",   "1,000,000+ $YPILOT", "Unlimited",    "0%"],
          ["Silver", "100,000+ $YPILOT",   "$10,000 USDC", "3%"],
          ["Bronze", "10,000+ $YPILOT",    "$1,000 USDC",  "6%"],
          ["None",   "< 10,000 $YPILOT",   "No access",    "—"],
        ]} />
        <P>This tiered model rewards long-term $YPILOT holders with progressively better terms. Gold holders pay zero performance fees — all yield is theirs. The $YPILOT token is available on pump.fun.</P>
      </Section>

      <Section title="7. Security Model">
        <H3>Non-Custodial</H3>
        <P>YieldPilot never holds user funds directly. All assets are held in on-chain program-derived accounts (PDAs) controlled by the vault smart contract. No individual — including the YieldPilot team — can access or move user funds outside of the defined program instructions.</P>
        <H3>Verifiable On-Chain</H3>
        <P>The smart contract is deployed at a fixed program ID on Solana. Anyone can verify the vault state, fee parameters, and treasury address directly on-chain at any time — no need to trust our word.</P>
        <H3>Emergency Pause</H3>
        <P>The vault admin can pause new deposits in the event of an emergency. Withdrawals remain available at all times — users can always retrieve their funds even when the vault is paused.</P>
        <H3>TVL Cap</H3>
        <P>A configurable TVL cap limits total deposits during the early phase, reducing exposure while the protocol matures.</P>
        <H3>Separated Admin &amp; Keeper Wallets</H3>
        <P>The admin wallet (which controls vault configuration) and the keeper wallet (which executes rebalances) are separate keypairs with separate on-chain authorities. Compromising the keeper grants no ability to change fees, pause the vault, or access funds.</P>
        <H3>Audit Status</H3>
        <P>The code has not yet been formally audited by a third party. A professional audit is planned as the protocol scales. The TVL cap will be raised incrementally as the protocol matures. Until then, deposit only what you are comfortable risking.</P>
      </Section>

      <Section title="8. Roadmap">
        <Table rows={[
          ["Phase", "Milestone", "Status"],
          ["Phase 1", "Smart contract development & testing (14/14 tests passing)", "Complete"],
          ["Phase 1", "Keeper bot — live APY routing & auto-compound", "Complete"],
          ["Phase 1", "Frontend at yieldpilot-chi.vercel.app", "Complete"],
          ["Phase 1", "Devnet deployment & vault initialization", "Complete"],
          ["Phase 1", "Admin / keeper wallet separation", "Complete"],
          ["Phase 1", "Mainnet launch with $YPILOT token gating", "Pending funding"],
          ["Phase 2", "Third-party smart contract audit", "Planned"],
          ["Phase 2", "Additional protocols — Jito, BlazeStake, Solend", "Planned"],
          ["Phase 2", "Referral system — earn a share of referred yield fees", "Planned"],
          ["Phase 3", "Cross-chain deposits via Wormhole", "Research"],
          ["Phase 3", "Auto-bridge to highest cross-chain yield", "Research"],
        ]} />
      </Section>

      <Section title="9. Disclaimer">
        <P>This document is for informational purposes only and does not constitute financial advice or a solicitation to buy or sell any asset. DeFi protocols carry significant risks including smart contract vulnerabilities, protocol failures, and potential loss of funds. Never deposit more than you can afford to lose.</P>
        <P>YieldPilot is deployed on Solana mainnet. Always verify transaction details before signing.</P>
      </Section>

      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 24, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <span style={{ color: "var(--text-dim)", fontSize: 12, fontFamily: "var(--mono)" }}>YieldPilot Whitepaper v1.0 — June 2026</span>
        <Link href="/" style={{ color: "var(--purple-light)", fontSize: 13, textDecoration: "none" }}>Back to home</Link>
      </div>
    </div>
  );
}
