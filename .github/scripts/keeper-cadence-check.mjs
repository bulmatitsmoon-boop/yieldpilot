/**
 * keeper-cadence-check.mjs — self-hosted watchdog for how often the keeper actually runs.
 *
 * Runs on GitHub Actions (see keeper-cadence-check.yml), NOT on anyone's laptop. It reads
 * the keeper's own run history, measures the real gaps between landed runs, and pings the
 * Telegram alerts channel ONLY when cadence has drifted — quiet when healthy.
 *
 * Why this exists: the keeper cron is best-effort (GitHub skips scheduled ticks under load),
 * and the site claims "~hourly". If reality drifts past that, someone needs to know without
 * depending on a person remembering to check. This is that someone.
 *
 * No dependencies — Node 20 fetch + the GitHub token the workflow already has.
 */

const REPO = process.env.GITHUB_REPOSITORY; // "owner/repo", provided by Actions
const GH_TOKEN = process.env.GH_TOKEN;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const KEEPER_WORKFLOW = "keeper-cron.yml";

// Thresholds. Alert when the typical gap is well past hourly, or any single gap is very long.
const AVG_ALERT_MIN = 90;
const MAX_ALERT_MIN = 180;
const SAMPLE = 12; // last N landed runs

async function gh(path) {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "keeper-cadence-check" },
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

async function telegram(text) {
  if (!TG_TOKEN || !TG_CHAT) {
    console.log("Telegram not configured — skipping alert. Message was:\n" + text);
    return;
  }
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!r.ok) console.log("Telegram send failed:", r.status, await r.text().catch(() => ""));
}

const runs = await gh(`/repos/${REPO}/actions/workflows/${KEEPER_WORKFLOW}/runs?per_page=${SAMPLE + 1}`);
const times = (runs.workflow_runs || [])
  .map((r) => new Date(r.created_at).getTime())
  .sort((a, b) => a - b);

if (times.length < 3) {
  console.log(`Only ${times.length} runs found — not enough to measure cadence yet.`);
  process.exit(0);
}

const gaps = [];
for (let i = 1; i < times.length; i++) gaps.push(Math.round((times[i] - times[i - 1]) / 60000));
const avg = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
const min = Math.min(...gaps);
const max = Math.max(...gaps);

console.log(`cadence over last ${gaps.length} gaps — avg ${avg}m, min ${min}m, max ${max}m`);

const drifted = avg > AVG_ALERT_MIN || max > MAX_ALERT_MIN;
if (!drifted) {
  console.log(`Within tolerance (avg <= ${AVG_ALERT_MIN}m, max <= ${MAX_ALERT_MIN}m). No alert.`);
  process.exit(0);
}

await telegram(
  `⚠️ <b>Keeper cadence drift</b>\n` +
    `Runs are landing <b>${avg}m apart</b> on average (min ${min}m, max ${max}m) over the last ${gaps.length} gaps.\n` +
    `The site claims "~hourly". GitHub cron is skipping scheduled runs.\n` +
    `Options: soften the copy to an honest range, or drive the keeper from an external pinger for reliable hourly.`
);
console.log("Drift alert sent to Telegram.");
