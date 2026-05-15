import { BacklogStore, type Goal, type GoalStatus } from "../lib/backlog.js";
import { style, styleStatus, banner } from "../lib/style.js";
import { hasJsonFlag, emitJson } from "../lib/json_out.js";
import { errorLine, successLine } from "../lib/error_ui.js";

/**
 * `orql backlog` - inspect and curate the goal backlog the autopilot picks
 * from when the fleet is idle.
 *
 *   list   [--status queued|planning|awaiting_approval|running|done|cancelled|deferred|all] [--json]
 *   show   <id>
 *   add    <title> [--priority N] [--deadline <iso>] [--tag t1,t2]
 *   done   <id>
 *   cancel <id>
 *   next
 *
 * `<id>` accepts either the full uuid or its 8-char shortId.
 */

const VALID_STATUSES = new Set<GoalStatus>([
  "queued",
  "planning",
  "awaiting_approval",
  "running",
  "done",
  "cancelled",
  "deferred",
]);

export async function cmdBacklog(stateDir: string, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    case "list":
      return await cmdBacklogList(stateDir, rest);
    case "show":
      return await cmdBacklogShow(stateDir, rest);
    case "add":
      return await cmdBacklogAdd(stateDir, rest);
    case "done":
      return await cmdBacklogSetStatus(stateDir, rest, "done");
    case "cancel":
      return await cmdBacklogSetStatus(stateDir, rest, "cancelled");
    case "next":
      return await cmdBacklogNext(stateDir, rest);
    default:
      process.stderr.write(errorLine(`unknown subcommand: backlog ${sub}`, "try `orql backlog --help`"));
      return 1;
  }
}

function printHelp(): void {
  console.log(banner());
  console.log("");
  console.log(style.bold(style.cream("orql backlog")));
  console.log("");
  console.log(`  ${style.coral("orql backlog list")} ${style.sand("[--status STATUS|all] [--json]")}`);
  console.log(`      List goals (default: queued only). Sorted by effective priority.`);
  console.log(`  ${style.coral("orql backlog show")} ${style.sand("<id>")}`);
  console.log(`      Full record for one goal (accepts 8-char shortId).`);
  console.log(`  ${style.coral("orql backlog add")} ${style.sand("<title> [--priority N] [--deadline <iso>] [--tag t1,t2]")}`);
  console.log(`      Enqueue a new goal. Default priority 50, source 'cli'.`);
  console.log(`  ${style.coral("orql backlog done")} ${style.sand("<id>")}`);
  console.log(`      Mark a goal done (sets finishedAt).`);
  console.log(`  ${style.coral("orql backlog cancel")} ${style.sand("<id>")}`);
  console.log(`      Mark a goal cancelled.`);
  console.log(`  ${style.coral("orql backlog next")}`);
  console.log(`      Show what the autopilot would pick next (or report blocked/empty).`);
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return args[i + 1];
}

function firstPositional(args: string[]): string | undefined {
  // Skip --flag value pairs and bare --flags.
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) return a;
    // skip the value if the flag takes one (priority/deadline/tag/status)
    if (["--priority", "--deadline", "--tag", "--status"].includes(a)) i++;
  }
  return undefined;
}

/**
 * Mirrors backlog.ts's private effectivePriority(): base + deadline boost.
 * Kept in sync intentionally - duplicating ~5 lines beats exporting an
 * internal helper.
 */
function effectivePriority(g: Goal): number {
  let p = g.priority;
  if (g.deadlineAt) {
    const days = (g.deadlineAt - Date.now()) / 86_400_000;
    if (days <= 0) p += 30;
    else if (days < 7) p += Math.round(30 * (1 - days / 7));
  }
  return p;
}

async function cmdBacklogList(stateDir: string, args: string[]): Promise<number> {
  const isJson = hasJsonFlag(args);
  const rawStatus = flagValue(args, "--status");
  let statusFilter: GoalStatus | undefined;
  if (rawStatus && rawStatus !== "all") {
    if (!VALID_STATUSES.has(rawStatus as GoalStatus)) {
      process.stderr.write(errorLine(`unknown status: ${rawStatus}`, "queued|planning|awaiting_approval|running|done|cancelled|deferred|all"));
      return 1;
    }
    statusFilter = rawStatus as GoalStatus;
  } else if (!rawStatus) {
    statusFilter = "queued";
  }

  const store = new BacklogStore(stateDir);
  const goals = await store.list(statusFilter ? { status: statusFilter } : {});
  const doneIds = new Set(goals.filter((g) => g.status === "done").map((g) => g.id));

  if (isJson) {
    emitJson(goals.map((g) => ({
      ...g,
      effectivePriority: effectivePriority(g),
      depsResolved: (g.dependsOn ?? []).every((d) => doneIds.has(d)),
    })));
    return 0;
  }

  console.log(banner());
  console.log("");
  if (goals.length === 0) {
    console.log(style.sand(statusFilter ? `(no goals with status '${statusFilter}')` : "(backlog empty)"));
    return 0;
  }
  console.log(style.bold(style.cream(`backlog (${goals.length})`)));
  console.log("");
  const head = `  ${"id".padEnd(8)}  ${"status".padEnd(18)}  ${"prio".padEnd(10)}  ${"deps".padEnd(8)}  title`;
  console.log(style.dim(head));
  for (const g of goals) {
    const short = style.dim(g.shortId.padEnd(8));
    const stat = styleStatus(g.status)(g.status.padEnd(18));
    const eff = effectivePriority(g);
    const prioStr = eff !== g.priority ? `${g.priority}->${eff}` : `${g.priority}`;
    const prio = style.cream(prioStr.padEnd(10));
    const deps = g.dependsOn ?? [];
    let depsCell: string;
    if (deps.length === 0) {
      depsCell = style.dim("none    ");
    } else if (deps.every((d) => doneIds.has(d))) {
      depsCell = style.coral("✓       ");
    } else {
      depsCell = style.crimson("blocked ");
    }
    const title = truncate(g.title, 60);
    console.log(`  ${short}  ${stat}  ${prio}  ${depsCell}  ${title}`);
  }
  return 0;
}

async function cmdBacklogShow(stateDir: string, args: string[]): Promise<number> {
  const isJson = hasJsonFlag(args);
  const id = firstPositional(args);
  if (!id) {
    process.stderr.write(errorLine("usage: orql backlog show <id>"));
    return 2;
  }
  const store = new BacklogStore(stateDir);
  const goal = await store.findById(id);
  if (!goal) {
    process.stderr.write(errorLine(`goal not found: ${id}`, "try `orql backlog list --status all`"));
    return 1;
  }
  if (isJson) {
    emitJson({ ...goal, effectivePriority: effectivePriority(goal) });
    return 0;
  }
  console.log(banner());
  console.log("");
  console.log(style.bold(style.cream(`goal ${goal.shortId}`)));
  console.log(`  ${style.sand("id:")}            ${style.dim(goal.id)}`);
  console.log(`  ${style.sand("title:")}         ${style.cream(goal.title)}`);
  if (goal.description) console.log(`  ${style.sand("description:")}   ${goal.description}`);
  console.log(`  ${style.sand("status:")}        ${styleStatus(goal.status)(goal.status)}`);
  const eff = effectivePriority(goal);
  const prioLine = eff !== goal.priority ? `${goal.priority} (effective ${eff})` : `${goal.priority}`;
  console.log(`  ${style.sand("priority:")}      ${prioLine}`);
  if (goal.deadlineAt) console.log(`  ${style.sand("deadline:")}      ${new Date(goal.deadlineAt).toISOString()}`);
  if (goal.dependsOn && goal.dependsOn.length > 0) console.log(`  ${style.sand("depends_on:")}    ${goal.dependsOn.join(", ")}`);
  if (goal.scope && goal.scope.length > 0) console.log(`  ${style.sand("scope:")}         ${goal.scope.join(", ")}`);
  if (goal.template) console.log(`  ${style.sand("template:")}      ${goal.template}`);
  if (goal.tags && goal.tags.length > 0) console.log(`  ${style.sand("tags:")}          ${goal.tags.join(", ")}`);
  console.log(`  ${style.sand("source:")}        ${goal.source}`);
  console.log(`  ${style.sand("created:")}       ${style.dim(new Date(goal.createdAt).toISOString())}`);
  if (goal.startedAt) console.log(`  ${style.sand("started:")}       ${style.dim(new Date(goal.startedAt).toISOString())}`);
  if (goal.finishedAt) console.log(`  ${style.sand("finished:")}      ${style.dim(new Date(goal.finishedAt).toISOString())}`);
  if (goal.planId) console.log(`  ${style.sand("plan_id:")}       ${goal.planId}`);
  if (goal.telegramThreadId) console.log(`  ${style.sand("tg_thread:")}     ${goal.telegramThreadId}`);
  if (goal.outcome) console.log(`  ${style.sand("outcome:")}       ${JSON.stringify(goal.outcome)}`);
  return 0;
}

async function cmdBacklogAdd(stateDir: string, args: string[]): Promise<number> {
  const title = firstPositional(args);
  if (!title) {
    process.stderr.write(errorLine("usage: orql backlog add <title> [--priority N] [--deadline <iso>] [--tag t1,t2]"));
    return 2;
  }

  let priority = 50;
  const rawPriority = flagValue(args, "--priority");
  if (rawPriority !== undefined) {
    const n = Number(rawPriority);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      process.stderr.write(errorLine(`invalid --priority: ${rawPriority}`, "expected a number between 0 and 100"));
      return 1;
    }
    priority = n;
  }

  let deadlineAt: number | undefined;
  const rawDeadline = flagValue(args, "--deadline");
  if (rawDeadline !== undefined) {
    const t = Date.parse(rawDeadline);
    if (!Number.isFinite(t)) {
      process.stderr.write(errorLine(`invalid --deadline: ${rawDeadline}`, "expected ISO-8601 (e.g. 2026-06-01T00:00:00Z)"));
      return 1;
    }
    deadlineAt = t;
  }

  let tags: string[] | undefined;
  const rawTags = flagValue(args, "--tag");
  if (rawTags !== undefined) {
    tags = rawTags.split(",").map((t) => t.trim()).filter(Boolean);
    if (tags.length === 0) tags = undefined;
  }

  const store = new BacklogStore(stateDir);
  const goal = await store.enqueue({
    title,
    priority,
    deadlineAt,
    tags,
    source: "cli",
  });

  if (hasJsonFlag(args)) {
    emitJson(goal);
    return 0;
  }
  process.stdout.write(successLine(`enqueued ${goal.shortId} (priority ${goal.priority})`));
  return 0;
}

async function cmdBacklogSetStatus(stateDir: string, args: string[], status: GoalStatus): Promise<number> {
  const id = firstPositional(args);
  if (!id) {
    process.stderr.write(errorLine(`usage: orql backlog ${status === "done" ? "done" : "cancel"} <id>`));
    return 2;
  }
  const store = new BacklogStore(stateDir);
  const updated = await store.update(id, (g) => {
    g.status = status;
    g.finishedAt = Date.now();
  });
  if (!updated) {
    process.stderr.write(errorLine(`goal not found: ${id}`));
    return 1;
  }
  process.stdout.write(successLine(`${updated.shortId} -> ${status}`));
  return 0;
}

async function cmdBacklogNext(stateDir: string, args: string[]): Promise<number> {
  const isJson = hasJsonFlag(args);
  const store = new BacklogStore(stateDir);
  const goal = await store.pickNext();
  if (!goal) {
    if (isJson) {
      emitJson(null);
      return 0;
    }
    const all = await store.list({ status: "queued" });
    const msg = all.length === 0 ? "backlog empty" : "all queued goals are blocked by deps";
    console.log(style.sand(`(${msg})`));
    return 0;
  }
  if (isJson) {
    emitJson({ ...goal, effectivePriority: effectivePriority(goal) });
    return 0;
  }
  console.log(banner());
  console.log("");
  console.log(style.bold(style.cream("next goal")));
  const eff = effectivePriority(goal);
  const prioLine = eff !== goal.priority ? `${goal.priority} (effective ${eff})` : `${goal.priority}`;
  console.log(`  ${style.sand("id:")}        ${style.dim(goal.shortId)}  ${style.dim(goal.id)}`);
  console.log(`  ${style.sand("title:")}     ${style.cream(goal.title)}`);
  console.log(`  ${style.sand("priority:")}  ${prioLine}`);
  if (goal.deadlineAt) console.log(`  ${style.sand("deadline:")}  ${new Date(goal.deadlineAt).toISOString()}`);
  if (goal.tags && goal.tags.length > 0) console.log(`  ${style.sand("tags:")}      ${goal.tags.join(", ")}`);
  console.log(`  ${style.sand("source:")}    ${goal.source}`);
  return 0;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
