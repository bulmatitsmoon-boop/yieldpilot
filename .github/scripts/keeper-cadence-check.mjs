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
const SAMPLE = 24; // last N landed runs — doubled alongside the hourly schedule bump below

// SEPARATE threshold for total-outage detection (see below) — this is deliberately its
// own constant, not reused from MAX_ALERT_MIN, because it answers a different question
// ("has anything run recently at all?") from the historical-gap stats, which only ever
// look at gaps AMONG runs that already exist in history.
const SILENCE_ALERT_MIN = 90;

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

// ── Total-outage check — runs BEFORE the "not enough history" bailout below, and
// independently of it, on purpose. ─────────────────────────────────────────────
//
// THE BUG THIS FIXES: if the external cron-job.org pinger dies entirely, this
// workflow's own /runs query keeps returning the SAME stale historical runs
// forever — their gaps among each other are still ~30m (from back when the
// keeper was healthy), so the old gap-only check below stayed silent through a
// total outage. It could only ever alert on DEGRADED cadence, never on a full
// stop, because it never compared anything to wall-clock "now". Confirmed live
// 2026-09-02: this was the exact blind spot.
//
// Fix: independently check how long it's been since the MOST RECENT run,
// against actual current time — this catches "nothing has run in N minutes"
// regardless of what history looks like, including a fresh repo with zero
// prior runs (an empty `times` array still has a well-defined "infinite" gap
// here, which correctly alerts rather than silently exiting like the old
// `times.length < 3` bailout used to for a brand-new or fully-stalled keeper).
const now = Date.now();
const lastRunAt = times.length > 0 ? times[times.length - 1] : null;
const silenceMin = lastRunAt === null ? Infinity : Math.round((now - lastRunAt) / 60000);

if (silenceMin > SILENCE_ALERT_MIN) {
  const desc = lastRunAt === null
    ? "no keeper runs found at all"
    : `last run was ${silenceMin}m ago (at ${new Date(lastRunAt).toISOString()})`;
  await telegram(
    `🚨 <b>Keeper appears STOPPED</b>\n` +
      `${desc} — that's past the ${SILENCE_ALERT_MIN}m silence threshold.\n` +
      `This usually means the cron-job.org pinger died, not just a slow gap — check ` +
      `https://github.com/${REPO}/actions/workflows/${KEEPER_WORKFLOW} directly.`
  );
  console.log(`SILENCE ALERT sent: ${desc}`);
  process.exit(0);
}
console.log(`Last run ${silenceMin === Infinity ? "never" : silenceMin + "m ago"} — within the ${SILENCE_ALERT_MIN}m silence threshold.`);

if (times.length < 3) {
  console.log(`Only ${times.length} runs found — not enough to measure cadence drift yet (silence check above still applies).`);
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
