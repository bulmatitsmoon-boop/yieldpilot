#!/usr/bin/env node
/**
 * audit-claims.mjs — fail the build when the site claims something the code does not do.
 *
 * WHY THIS EXISTS
 * Six false user-facing claims were found on 2026-07-21, none of them written to
 * deceive: each described what the product was *going to* do, the code then changed,
 * and the copy didn't. "The keeper harvests rewards hourly" was presumably true to the
 * plan when it was typed — compound() just never ended up doing it. That drift is
 * structural and will keep happening, so it needs a check rather than vigilance.
 *
 * DESIGN: facts are DERIVED FROM THE CODE, never hardcoded here. If someone changes
 * the rebalance threshold, this file needs no edit — it re-reads the constant and
 * re-checks the copy against the new value. A hardcoded expectation would itself go
 * stale and become the very thing it is meant to catch.
 *
 * Usage:  node scripts/audit-claims.mjs [--json]
 * Exit:   0 = clean, 1 = contradictions found
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), "utf8"); } catch { return null; } };

// ── 1. Derive ground truth from the code ─────────────────────────────────────
function deriveFacts() {
  const f = {};
  const reb = read("keeper/src/rebalancer.ts") || "";
  const lib = read("programs/yieldpilot/src/lib.rs") || "";
  const cron = read(".github/workflows/keeper-cron.yml") || "";

  // Rebalance drift threshold, in bps -> percent
  const thr = reb.match(/REBALANCE_THRESHOLD_BPS\s*=\s*parseInt\([^|]*\|\|\s*"(\d+)"/);
  f.thresholdPct = thr ? Number(thr[1]) / 100 : null;

  // Allocation shape: does the optimizer split, or concentrate?
  const allocs = [...reb.matchAll(/allocations\[eligible\[(\d+)\]\.i\]\s*=\s*(BPS_DENOM|\d+)/g)]
    .map((m) => ({ rank: Number(m[1]), val: m[2] === "BPS_DENOM" ? 10000 : Number(m[2]) }));
  const nonZero = allocs.filter((a) => a.val > 0);
  f.concentrates = nonZero.length <= 1 || nonZero.every((a) => a.rank === 0);
  f.allocPcts = [...new Set(nonZero.map((a) => a.val / 100))];

  // Does compound() actually move value? Look for any CPI/transfer inside its body.
  const ci = lib.indexOf("pub fn compound");
  const body = ci >= 0 ? lib.slice(ci, lib.indexOf("\n    pub fn", ci + 10)) : "";
  f.compoundMovesFunds = /invoke|CpiContext|transfer|deposit|harvest/i.test(body);
  f.compoundFound = ci >= 0;

  // Keeper cadence. "*/45" fires at :00 and :45 — a 45/15 split, NOT "every 45 minutes".
  const sched = cron.match(/cron:\s*["']([^"']+)["']/);
  f.cronExpr = sched ? sched[1] : null;
  f.cronIsEvenInterval = f.cronExpr ? (() => {
    const m = f.cronExpr.split(/\s+/)[0];
    const step = m.match(/^\*\/(\d+)$/);
    return step ? 60 % Number(step[1]) === 0 : true;
  })() : null;

  return f;
}

// ── 2. Rules: each maps a copy pattern to a code fact ────────────────────────
function buildRules(f) {
  const R = [];

  if (f.compoundFound && !f.compoundMovesFunds) {
    R.push({
      id: "compound-is-inert",
      re: /(harvest|reinvest)[a-z]*\s+(accrued\s+)?(rewards?|yield)|auto-?compounds?\s+(hourly|every)|reinvests?\s+rewards?/i,
      msg: "compound() moves no funds (no CPI/transfer in its body) — copy must not claim rewards are harvested or reinvested. Yield compounds via receipt-token appreciation.",
    });
  }

  if (f.concentrates) {
    R.push({
      id: "no-split-allocation",
      re: /\b80\s*\/\s*20\b|\b80%\s+(of|to)\b|runner-?up\s+(allocation|rate)?\s*(gets|holds|receives|—)?\s*\b20%|20%\s+(stays|to the runner)/i,
      msg: `Optimizer routes ${f.allocPcts.join("/")}% to the top rate only — copy must not describe a split allocation.`,
    });
  }

  if (f.thresholdPct != null) {
    R.push({
      id: "rebalance-threshold",
      test: (line) => {
        const m = line.match(/([\d.]+)\s*%\s*(drift\s*)?(threshold|spread)|(threshold|spread)[^.]{0,24}?([\d.]+)\s*%/i);
        if (!m) return false;
        const val = Number(m[1] ?? m[5]);
        return Number.isFinite(val) && Math.abs(val - f.thresholdPct) > 0.001;
      },
      msg: `REBALANCE_THRESHOLD_BPS resolves to ${f.thresholdPct}% — copy states a different threshold.`,
    });
  }

  if (f.cronIsEvenInterval === false) {
    R.push({
      id: "cadence-not-even-interval",
      re: /every\s*45\s*(min|minutes)|every\s*45\b/i,
      msg: `Cron is "${f.cronExpr}", which fires at fixed minutes (a 45-then-15 split), not "every 45 minutes" — and GitHub Actions cron is best-effort. Say "~hourly".`,
    });
  }

  return R;
}

// ── 3. Scan user-facing copy ─────────────────────────────────────────────────
function walk(dir, out = []) {
  let entries; try { entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (!/node_modules|\.next/.test(e.name)) walk(rel, out); }
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(rel);
  }
  return out;
}

const facts = deriveFacts();
const rules = buildRules(facts);
const findings = [];

for (const file of walk("app/src")) {
  const src = read(file);
  if (!src) continue;
  src.split("\n").forEach((line, i) => {
    const t = line.trim();
    // Skip code comments — they explain the rules, they aren't claims to users.
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("{/*")) return;
    for (const r of rules) {
      const hit = r.test ? r.test(line) : r.re.test(line);
      if (hit) findings.push({ file, line: i + 1, rule: r.id, msg: r.msg, text: t.slice(0, 140) });
    }
  });
}

// ── 4. Report ────────────────────────────────────────────────────────────────
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ facts, findings }, null, 2));
} else {
  console.log("Derived from code:");
  console.log(`  rebalance threshold : ${facts.thresholdPct}%`);
  console.log(`  allocation          : ${facts.concentrates ? "100% to top rate" : "split " + facts.allocPcts.join("/") + "%"}`);
  console.log(`  compound() moves funds: ${facts.compoundMovesFunds}`);
  console.log(`  keeper cron         : ${facts.cronExpr}${facts.cronIsEvenInterval === false ? "  (NOT an even interval)" : ""}`);
  console.log(`\nRules active: ${rules.length}   Files scanned: ${walk("app/src").length}\n`);
  if (!findings.length) console.log("✅ No contradictions between site copy and code.");
  else {
    console.log(`❌ ${findings.length} claim(s) contradict the code:\n`);
    for (const x of findings) {
      console.log(`  ${x.file}:${x.line}  [${x.rule}]`);
      console.log(`     claim : ${x.text}`);
      console.log(`     code  : ${x.msg}\n`);
    }
  }
}
process.exit(findings.length ? 1 : 0);
