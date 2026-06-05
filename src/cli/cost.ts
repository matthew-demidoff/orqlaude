import { StateStore, type Plan } from "../lib/state.js";
import { style } from "../lib/style.js";

/**
 * `orql cost [--days N] [--plan ID] [--json]` — historical spend analytics.
 *
 * Reads the state file (which has per-task token + cost totals) and walks
 * each task's window to attribute cost to a calendar day. Two views:
 *
 *   • The default — last 14 days. ASCII sparkline of daily billed tokens,
 *     daily cost, per-day breakdown table, and a 7-day-trailing projected
 *     month-end cost so the user can spot drift before the invoice does.
 *   • --plan ID — drill into a single plan. Per-task breakdown, the most
 *     expensive Agnet, time-to-completion, $/100 LOC if a PR landed.
 *
 * Why not pull from the audit log? Audit events carry tool-level metadata
 * but not token totals (those live on task records, updated by the
 * dispatch + status loop). The state file is the authoritative ledger.
 *
 * Why no third-party charting library? A terminal user is by definition
 * fine with ASCII. Sparkline blocks (▁▂▃▄▅▆▇█) are exactly the right
 * fidelity — they communicate trend at a glance without needing axes.
 */

export interface CostCliOpts {
  stateDir: string;
  days?: number;
  planId?: string;
  json?: boolean;
}

interface DailyBucket {
  date: string;       // YYYY-MM-DD
  tokens: number;
  costUsd: number;
  agnetsActive: number;
  planIds: Set<string>;
}

const MAX_DAYS = 365;

export async function runCost(opts: CostCliOpts): Promise<number> {
  const store = new StateStore(opts.stateDir);
  const plans = await store.read((s) => Object.values(s.plans).slice()).catch(() => [] as Plan[]);

  if (opts.planId) {
    return runCostForPlan(plans, opts.planId, opts.json ?? false);
  }
  // Cap `--days` to defend against a fat-finger that would otherwise
  // allocate a bucket per day for the next 100,000 days. 365 covers any
  // legitimate analytics window the CLI is designed for; a future
  // `orql cost --csv-export` could lift this if needed.
  const requestedDays = opts.days ?? 14;
  if (!Number.isFinite(requestedDays) || requestedDays < 1) {
    process.stderr.write(style.coral(`✗ --days must be a positive integer (got ${opts.days})\n`));
    return 1;
  }
  const days = Math.min(MAX_DAYS, Math.floor(requestedDays));
  if (days < requestedDays) {
    process.stderr.write(style.dim(`note: --days capped at ${MAX_DAYS}\n`));
  }
  return runCostOverview(plans, days, opts.json ?? false);
}

function runCostOverview(plans: Plan[], days: number, asJson: boolean): number {
  const today = startOfDay(Date.now());
  const buckets = new Map<string, DailyBucket>();
  for (let i = 0; i < days; i++) {
    const ts = today - i * 86_400_000;
    const date = ymd(ts);
    buckets.set(date, { date, tokens: 0, costUsd: 0, agnetsActive: 0, planIds: new Set() });
  }
  const cutoff = today - (days - 1) * 86_400_000;

  let allTimeTokens = 0;
  let allTimeCost = 0;
  for (const plan of plans) {
    for (const task of plan.tasks) {
      const tokens = task.tokensUsed ?? 0;
      const cost = task.costUsd ?? 0;
      allTimeTokens += tokens;
      allTimeCost += cost;
      const start = task.startedAt ?? plan.createdAt;
      if (start < cutoff) continue;
      const date = ymd(startOfDay(start));
      const b = buckets.get(date);
      if (!b) continue;
      b.tokens += tokens;
      b.costUsd += cost;
      b.agnetsActive += 1;
      b.planIds.add(plan.id);
    }
  }

  const ordered = [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
  const windowTokens = ordered.reduce((s, b) => s + b.tokens, 0);
  const windowCost = ordered.reduce((s, b) => s + b.costUsd, 0);

  // Trailing 7-day avg → projected month spend.
  const last7 = ordered.slice(-7);
  const last7Cost = last7.reduce((s, b) => s + b.costUsd, 0);
  const projectedMonthly = (last7Cost / Math.max(1, last7.length)) * 30;

  if (asJson) {
    process.stdout.write(JSON.stringify({
      windowDays: days,
      allTime: { tokens: allTimeTokens, costUsd: allTimeCost },
      window: { tokens: windowTokens, costUsd: windowCost },
      projectedMonthlyUsd: projectedMonthly,
      daily: ordered.map((b) => ({
        date: b.date, tokens: b.tokens, costUsd: b.costUsd,
        agnetsActive: b.agnetsActive, distinctPlans: b.planIds.size,
      })),
    }, null, 2) + "\n");
    return 0;
  }

  const out: string[] = [];
  out.push("");
  out.push(`  ${style.coral("●")} ${style.sand(`orqlaude cost — last ${days} days`)}`);
  out.push("");
  out.push(`  ${style.dim("window tokens")}  ${formatTokens(windowTokens).padStart(10)}    ${style.dim("window cost")}  ${formatCost(windowCost).padStart(10)}`);
  out.push(`  ${style.dim("all-time tok ")}  ${formatTokens(allTimeTokens).padStart(10)}    ${style.dim("all-time   ")}  ${formatCost(allTimeCost).padStart(10)}`);
  out.push(`  ${style.dim("proj. /month ")}  ${formatCost(projectedMonthly).padStart(10)}    ${style.dim("trailing 7d")}  ${formatCost(last7Cost).padStart(10)}`);
  out.push("");

  // Sparkline of daily cost (more visceral than tokens for a Plan user).
  const sparkVals = ordered.map((b) => b.costUsd);
  const sparkTokenVals = ordered.map((b) => b.tokens);
  out.push(`  ${style.dim("cost   ")} ${sparkline(sparkVals)}  ${style.dim(`max ${formatCost(Math.max(...sparkVals, 0))}`)}`);
  out.push(`  ${style.dim("tokens ")} ${sparkline(sparkTokenVals)}  ${style.dim(`max ${formatTokens(Math.max(...sparkTokenVals, 0))}`)}`);
  out.push("");

  // Per-day table — most recent first.
  out.push(`  ${style.dim("date         tokens      cost   agnets   plans")}`);
  out.push(`  ${style.dim("─".repeat(50))}`);
  for (const b of [...ordered].reverse()) {
    const isWeekend = isWeekendDay(b.date);
    const label = isWeekend ? style.dim(b.date) : b.date;
    out.push(
      `  ${label}  ${formatTokens(b.tokens).padStart(8)}  ${formatCost(b.costUsd).padStart(8)}  ${String(b.agnetsActive).padStart(6)}   ${String(b.planIds.size).padStart(5)}`
    );
  }
  out.push("");

  // Top plans by spend in window
  const planSpend = new Map<string, { plan: Plan; cost: number; tokens: number }>();
  for (const plan of plans) {
    let cost = 0;
    let tokens = 0;
    for (const task of plan.tasks) {
      const start = task.startedAt ?? plan.createdAt;
      if (start < cutoff) continue;
      cost += task.costUsd ?? 0;
      tokens += task.tokensUsed ?? 0;
    }
    if (cost > 0 || tokens > 0) planSpend.set(plan.id, { plan, cost, tokens });
  }
  const topPlans = [...planSpend.values()].sort((a, b) => b.cost - a.cost).slice(0, 5);
  if (topPlans.length > 0) {
    out.push(`  ${style.sand("top plans in window")}`);
    out.push(`  ${style.dim("─".repeat(50))}`);
    for (const { plan, cost, tokens } of topPlans) {
      const title = truncate(plan.rootTask || "(no description)", 38);
      out.push(`  ${plan.id.slice(0, 8)}  ${formatCost(cost).padStart(8)}  ${formatTokens(tokens).padStart(8)}  ${style.dim(title)}`);
    }
    out.push("");
  }

  process.stdout.write(out.join("\n") + "\n");
  return 0;
}

function runCostForPlan(plans: Plan[], idOrShort: string, asJson: boolean): number {
  // Exact match wins outright. Otherwise: prefix match, but disambiguate
  // when more than one plan shares the same prefix. v0.12.0 silently
  // returned the first match, which could attribute spend to the wrong
  // plan on collisions.
  const exact = plans.find((p) => p.id === idOrShort);
  let plan: Plan | undefined = exact;
  if (!plan) {
    const matches = plans.filter((p) => p.id.startsWith(idOrShort));
    if (matches.length === 0) {
      process.stderr.write(style.coral(`✗ no plan matches "${idOrShort}"\n`));
      return 1;
    }
    if (matches.length > 1) {
      process.stderr.write(style.coral(`✗ "${idOrShort}" matches ${matches.length} plans; disambiguate:\n`));
      for (const m of matches.slice(0, 8)) {
        process.stderr.write(`  ${style.dim(m.id.slice(0, 12))}  ${truncate(m.rootTask || "(no description)", 50)}\n`);
      }
      return 1;
    }
    plan = matches[0]!;
  }
  const tasks = [...plan.tasks].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
  const totalCost = tasks.reduce((s, t) => s + (t.costUsd ?? 0), 0);
  const totalTokens = tasks.reduce((s, t) => s + (t.tokensUsed ?? 0), 0);
  const cap = plan.budgetCapTokens;
  const pct = cap > 0 ? (totalTokens / cap) * 100 : 0;

  if (asJson) {
    process.stdout.write(JSON.stringify({
      planId: plan.id,
      rootTask: plan.rootTask,
      status: plan.status,
      budgetCapTokens: cap,
      tokensUsed: totalTokens,
      tokensPct: pct,
      costUsd: totalCost,
      tasks: tasks.map((t) => ({
        id: t.id, title: t.title, agnetName: t.agnetName, status: t.status,
        tokensUsed: t.tokensUsed ?? 0, costUsd: t.costUsd ?? 0,
        startedAt: t.startedAt, finishedAt: t.finishedAt,
        durationSec: t.startedAt && t.finishedAt ? Math.round((t.finishedAt - t.startedAt) / 1000) : null,
        prUrl: t.prUrl,
      })),
    }, null, 2) + "\n");
    return 0;
  }

  const out: string[] = [];
  out.push("");
  out.push(`  ${style.coral("●")} ${style.sand(`plan ${plan.id.slice(0, 8)}`)}  ${style.dim(plan.rootTask)}`);
  out.push("");
  out.push(`  ${style.dim("status   ")}  ${plan.status}`);
  out.push(`  ${style.dim("tokens   ")}  ${formatTokens(totalTokens)} / ${formatTokens(cap)}  (${pct.toFixed(1)}% of cap)`);
  out.push(`  ${style.dim("cost     ")}  ${formatCost(totalCost)}`);
  out.push("");
  out.push(`  ${style.dim("agnet         status      tokens      cost     duration   PR")}`);
  out.push(`  ${style.dim("─".repeat(70))}`);
  for (const t of tasks) {
    const name = (t.agnetName || t.id.slice(0, 8)).padEnd(12);
    const status = t.status.padEnd(10);
    const tokens = formatTokens(t.tokensUsed ?? 0).padStart(8);
    const cost = formatCost(t.costUsd ?? 0).padStart(8);
    const dur = t.startedAt && t.finishedAt
      ? formatDuration(t.finishedAt - t.startedAt).padStart(8)
      : "—".padStart(8);
    const pr = t.prUrl ? style.dim(t.prUrl.replace(/^https?:\/\/github\.com\//, "")) : style.dim("—");
    out.push(`  ${name}  ${status}  ${tokens}  ${cost}  ${dur}   ${pr}`);
  }
  out.push("");
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}

// ---- formatting helpers --------------------------------------------------

/**
 * Bucket boundary at the start of the user's LOCAL day. We deliberately do
 * not use UTC here: a developer running `orql cost` at 5pm PST expects
 * "today" to mean their local today, not "the calendar day in London."
 *
 * Caveat: a user who travels across timezones between fleet runs will see
 * their old fleet's start time land in whatever local TZ they're in now,
 * potentially shifting buckets by ±1 day at boundaries. For a single-user
 * dev tool this is preferable to the UTC alternative, which would split
 * every west-coast evening's spend across two days.
 */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function ymd(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isWeekendDay(ymdStr: string): boolean {
  const [y, m, d] = ymdStr.split("-").map(Number);
  const dt = new Date(y!, m! - 1, d!);
  const dow = dt.getDay();
  return dow === 0 || dow === 6;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "k";
  return (n / 1_000_000).toFixed(2) + "M";
}

function formatCost(n: number): string {
  // Negative / NaN guard — defensive; cost should never be negative but
  // a corrupt state file shouldn't crash the report.
  if (!Number.isFinite(n) || n <= 0) return "$0";
  // Sub-cent costs are rendered as "<$0.01" rather than "$0.000" — both
  // are informational, but the former visibly signals "small but non-zero"
  // where the latter is indistinguishable from a true zero at a glance.
  if (n < 0.01) return "<$0.01";
  if (n < 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(2);
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return Math.round(ms / 1000) + "s";
  if (ms < 3_600_000) return Math.round(ms / 60_000) + "m";
  return (ms / 3_600_000).toFixed(1) + "h";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/**
 * Render a sparkline from a numeric series. Empty / all-zero series render
 * as a flat dim baseline (`▁▁▁▁`) rather than blanks — silence is signal.
 */
export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  // Defensive: replace non-finite values (NaN, Infinity from a malformed
  // import) with 0 before scaling. Without this, Math.max could return
  // NaN and every glyph would index into `undefined`.
  const safe = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const max = Math.max(...safe);
  if (max <= 0) return style.dim(blocks[0]!.repeat(safe.length));
  return safe
    .map((v) => {
      if (v <= 0) return style.dim(blocks[0]!);
      const idx = Math.min(blocks.length - 1, Math.max(0, Math.round((v / max) * (blocks.length - 1))));
      return blocks[idx]!;
    })
    .map((ch, i) => (i >= safe.length - 7 ? style.coral(ch) : style.sand(ch)))
    .join("");
}
