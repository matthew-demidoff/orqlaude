import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { BacklogStore } from "../lib/backlog.js";
import { FLEET_TEMPLATES, findTemplate } from "../lib/templates.js";
import { style } from "../lib/style.js";

/**
 * `orql goal …` — interact with the autopilot backlog from the shell.
 *
 * Subcommands:
 *   list                       Show queued / running / done goals
 *   new <template> [--yes]     Quickstart wizard. Picks a fleet template,
 *                              prompts for the missing pieces (title,
 *                              priority, scope), enqueues the goal so the
 *                              autopilot daemon picks it up on its next
 *                              tick. --yes accepts every default.
 *   show <id>                  Detail view for a single goal.
 *   cancel <id>                Mark a queued goal as cancelled.
 *   templates                  List the bundled fleet templates.
 *
 * The wizard is the headline feature: a single `orql goal new audit-sweep`
 * is the difference between "I have an idea" and "fleet will start working
 * on it next time autopilot wakes". No need to remember the JSON shape of
 * a Goal, no need to open an editor.
 */

export interface GoalCliOpts {
  stateDir: string;
  args: string[];
}

export async function runGoal(opts: GoalCliOpts): Promise<number> {
  const sub = opts.args[0];
  const rest = opts.args.slice(1);

  const backlog = new BacklogStore(opts.stateDir);

  if (!sub || sub === "list" || sub === "ls") return cmdList(backlog, rest);
  if (sub === "templates" || sub === "tpls") return cmdTemplates();
  if (sub === "new" || sub === "add" || sub === "create") return cmdNew(backlog, rest);
  if (sub === "show") return cmdShow(backlog, rest);
  if (sub === "cancel" || sub === "rm") return cmdCancel(backlog, rest);

  process.stderr.write(style.coral(`✗ unknown subcommand: orql goal ${sub}\n`));
  process.stderr.write(style.dim("  try: orql goal list | new <template> | show <id> | cancel <id> | templates\n"));
  return 1;
}

async function cmdList(backlog: BacklogStore, _args: string[]): Promise<number> {
  const goals = await backlog.list();
  if (goals.length === 0) {
    process.stdout.write(`\n  ${style.dim("backlog is empty. add one with")}  ${style.sand("orql goal new <template>")}\n\n`);
    return 0;
  }
  const groups: Record<string, typeof goals> = { queued: [], planning: [], running: [], awaiting_approval: [], done: [], cancelled: [], deferred: [] };
  for (const g of goals) (groups[g.status] ??= []).push(g);

  process.stdout.write("\n");
  for (const group of ["running", "planning", "awaiting_approval", "queued", "deferred", "done", "cancelled"] as const) {
    const items = groups[group] ?? [];
    if (items.length === 0) continue;
    process.stdout.write(`  ${badge(group)}  ${style.dim(`(${items.length})`)}\n`);
    for (const g of items) {
      const dl = g.deadlineAt ? `  ${style.dim("⏰ " + new Date(g.deadlineAt).toISOString().slice(0, 10))}` : "";
      const tags = g.tags && g.tags.length ? `  ${style.dim(g.tags.join(", "))}` : "";
      const tpl = g.template ? `  ${style.sand("[" + g.template + "]")}` : "";
      process.stdout.write(`    ${style.dim(g.shortId)}  ${truncate(g.title, 50).padEnd(50)}  ${("pri " + g.priority).padEnd(7)}${tpl}${dl}${tags}\n`);
    }
    process.stdout.write("\n");
  }
  return 0;
}

function cmdTemplates(): number {
  process.stdout.write("\n  " + style.sand("fleet templates") + "\n");
  process.stdout.write("  " + style.dim("─".repeat(64)) + "\n");
  for (const t of FLEET_TEMPLATES) {
    process.stdout.write(`  ${style.coral(t.id.padEnd(22))}  ${t.title}\n`);
    process.stdout.write(`  ${" ".repeat(22)}  ${style.dim(t.description)}\n\n`);
  }
  return 0;
}

async function cmdNew(backlog: BacklogStore, args: string[]): Promise<number> {
  const acceptDefaults = args.includes("--yes") || args.includes("-y");
  const templateId = args.find((a) => !a.startsWith("-"));
  if (!templateId) {
    process.stderr.write(style.coral("✗ missing template id\n"));
    process.stderr.write(style.dim("  try: orql goal templates  to list available templates\n"));
    return 1;
  }
  const template = findTemplate(templateId);
  if (!template) {
    process.stderr.write(style.coral(`✗ no template named "${templateId}"\n`));
    const close = FLEET_TEMPLATES.find((t) => t.id.startsWith(templateId) || t.suggestedForTags?.some((s) => s === templateId));
    if (close) process.stderr.write(style.dim(`  did you mean "${close.id}"?\n`));
    return 1;
  }

  // If stdin is not a TTY and the user didn't pass --yes, the wizard would
  // hang forever waiting for input that will never come (CI, piped scripts,
  // someone running `orql goal new tpl < /dev/null`). Fail fast with a
  // useful suggestion instead.
  if (!acceptDefaults && !stdin.isTTY) {
    process.stderr.write(style.coral("✗ stdin is not a terminal; pass --yes to accept defaults non-interactively\n"));
    process.stderr.write(style.dim("  example: orql goal new ") + style.sand(template.id) + style.dim(" --yes\n"));
    return 1;
  }

  process.stdout.write("\n  " + style.coral("●") + " " + style.sand(`new goal from template "${template.id}"`) + "\n");
  process.stdout.write("  " + style.dim(template.description) + "\n\n");

  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: !acceptDefaults });

  // Pull each field; respect defaults if --yes was passed.
  const ask = async (prompt: string, def: string): Promise<string> => {
    if (acceptDefaults) return def;
    const formatted = `  ${style.dim(prompt)} ${def ? style.dim(`[${def}]`) : ""} `;
    const v = (await rl.question(formatted)).trim();
    return v || def;
  };

  const title = await ask("title:", `${template.title.toLowerCase()}`);
  const priorityRaw = await ask("priority (0–100):", "50");
  const priority = Math.max(0, Math.min(100, parseInt(priorityRaw, 10) || 50));
  const scopeRaw = await ask("scope paths (comma-separated, optional):", "");
  const scope = scopeRaw ? scopeRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const tagsRaw = await ask("tags (comma-separated, optional):", (template.suggestedForTags ?? []).join(", "));
  const tags = tagsRaw ? tagsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const deadlineRaw = await ask("deadline (YYYY-MM-DD or +Nd, optional):", "");
  if (deadlineRaw && !parseDeadline(deadlineRaw)) {
    rl.close();
    process.stderr.write(style.coral(`✗ invalid deadline "${deadlineRaw}" — expected YYYY-MM-DD or +Nd (e.g. +7d)\n`));
    return 1;
  }
  const deadlineAt = parseDeadline(deadlineRaw);
  const descriptionDefault = `Apply the "${template.title}" fleet shape. ${template.agentRoles.length} agnets; per-agnet budget ${template.defaultPerAgnetBudget.toLocaleString()} tokens.`;
  const description = await ask("description:", descriptionDefault);

  rl.close();

  const goal = await backlog.enqueue({
    title,
    description,
    priority,
    scope,
    tags,
    template: template.id,
    deadlineAt: deadlineAt ?? undefined,
    source: "cli:goal new",
  });

  process.stdout.write("\n");
  process.stdout.write(`  ${style.coral("✓")} ${style.sand("goal enqueued")}  ${style.dim(goal.shortId)}\n`);
  process.stdout.write(`  ${style.dim("title    ")} ${goal.title}\n`);
  process.stdout.write(`  ${style.dim("template ")} ${goal.template}\n`);
  process.stdout.write(`  ${style.dim("priority ")} ${goal.priority}\n`);
  if (goal.scope?.length) process.stdout.write(`  ${style.dim("scope    ")} ${goal.scope.join(", ")}\n`);
  if (goal.deadlineAt) process.stdout.write(`  ${style.dim("deadline ")} ${new Date(goal.deadlineAt).toISOString().slice(0, 10)}\n`);
  process.stdout.write("\n");
  process.stdout.write(`  ${style.dim("autopilot will pick this up on its next idle tick.")}\n`);
  process.stdout.write(`  ${style.dim("start the daemon if it isn't running:")} ${style.sand("orql autopilot start")}\n\n`);
  return 0;
}

async function cmdShow(backlog: BacklogStore, args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    process.stderr.write(style.coral("✗ usage: orql goal show <id>\n"));
    return 1;
  }
  const goal = await backlog.findById(id);
  if (!goal) {
    process.stderr.write(style.coral(`✗ no goal matches "${id}"\n`));
    return 1;
  }
  const out: string[] = [];
  out.push("");
  out.push(`  ${badge(goal.status)}  ${style.sand(goal.title)}  ${style.dim(goal.shortId)}`);
  if (goal.description) out.push(`  ${style.dim(goal.description)}`);
  out.push("");
  out.push(`  ${style.dim("priority  ")} ${goal.priority}`);
  if (goal.template) out.push(`  ${style.dim("template  ")} ${goal.template}`);
  if (goal.scope?.length) out.push(`  ${style.dim("scope     ")} ${goal.scope.join(", ")}`);
  if (goal.tags?.length) out.push(`  ${style.dim("tags      ")} ${goal.tags.join(", ")}`);
  if (goal.deadlineAt) out.push(`  ${style.dim("deadline  ")} ${new Date(goal.deadlineAt).toISOString()}`);
  if (goal.dependsOn?.length) out.push(`  ${style.dim("depends   ")} ${goal.dependsOn.map((d) => d.slice(0,8)).join(", ")}`);
  if (goal.planId) out.push(`  ${style.dim("plan      ")} ${goal.planId.slice(0, 8)}`);
  if (goal.outcome) out.push(`  ${style.dim("outcome   ")} ${goal.outcome.ok ? "✓" : "✗"} ${goal.outcome.note ?? ""}`);
  out.push(`  ${style.dim("created   ")} ${new Date(goal.createdAt).toISOString()}`);
  if (goal.startedAt) out.push(`  ${style.dim("started   ")} ${new Date(goal.startedAt).toISOString()}`);
  if (goal.finishedAt) out.push(`  ${style.dim("finished  ")} ${new Date(goal.finishedAt).toISOString()}`);
  out.push("");
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}

async function cmdCancel(backlog: BacklogStore, args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    process.stderr.write(style.coral("✗ usage: orql goal cancel <id>\n"));
    return 1;
  }
  // Throwing from inside `backlog.update`'s mutator propagates the error up
  // and triggers a cache rollback inside JsonStore — but we have to catch
  // it here, otherwise the CLI exits with an unhandled-error stack trace
  // instead of a friendly message.
  let goal;
  try {
    goal = await backlog.update(id, (g) => {
      if (g.status === "done") throw new Error(`goal ${g.shortId} is already done`);
      if (g.status === "cancelled") throw new Error(`goal ${g.shortId} is already cancelled`);
      g.status = "cancelled";
      g.finishedAt = Date.now();
      g.outcome = { ok: false, note: "cancelled from CLI" };
    });
  } catch (err) {
    process.stderr.write(style.coral(`✗ ${(err as Error).message}\n`));
    return 1;
  }
  if (!goal) {
    process.stderr.write(style.coral(`✗ no goal matches "${id}"\n`));
    return 1;
  }
  process.stdout.write(`\n  ${style.coral("✓")} cancelled  ${style.dim(goal.shortId)}  ${goal.title}\n\n`);
  return 0;
}

function badge(status: string): string {
  switch (status) {
    case "queued":            return style.sand("◇ queued       ");
    case "planning":          return style.coral("◆ planning     ");
    case "awaiting_approval": return style.coral("◆ approval     ");
    case "running":           return style.coral("◆ running      ");
    case "done":              return style.dim ("✓ done         ");
    case "cancelled":         return style.dim ("· cancelled    ");
    case "deferred":          return style.dim ("· deferred     ");
    default:                  return style.dim(status.padEnd(15));
  }
}

/**
 * Parse a deadline argument. Accepts:
 *
 *   • `YYYY-MM-DD`         — absolute date, end-of-day local time
 *   • `+Nd` / `+Nw`        — relative: N days or weeks from now
 *   • empty string         — returns null
 *
 * Rejects out-of-range values that JS's `Date` constructor would otherwise
 * silently roll over (e.g. `2026-13-45` becoming Feb 2027). Validation
 * round-trips through `Date` and compares the month/day back to what the
 * user typed — only an exact match is accepted.
 *
 * Exported for unit-test coverage.
 */
export function parseDeadline(s: string): number | null {
  if (!s) return null;
  const trimmed = s.trim();

  const rel = /^\+(\d+)([dw])$/i.exec(trimmed);
  if (rel) {
    const n = Number(rel[1]);
    if (!Number.isFinite(n) || n <= 0 || n > 3650) return null;
    const mult = rel[2]!.toLowerCase() === "w" ? 7 : 1;
    return Date.now() + n * mult * 86_400_000;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const [, y, m, d] = match;
  const yy = Number(y), mm = Number(m), dd = Number(d);
  // Reject the obvious out-of-range cases before letting `Date` roll them
  // over. (Date.UTC(2026, 13, 1) silently becomes Feb 2027.)
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const dt = new Date(yy, mm - 1, dd, 23, 59, 59);
  if (!Number.isFinite(dt.getTime())) return null;
  // Round-trip check: if the constructed Date doesn't agree with the input,
  // the user gave us something like Feb 30 — refuse it.
  if (dt.getFullYear() !== yy || dt.getMonth() !== mm - 1 || dt.getDate() !== dd) return null;
  return dt.getTime();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
