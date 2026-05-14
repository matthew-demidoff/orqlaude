import { StateStore, type Plan } from "../lib/state.js";
import { snapshotSession, jsonlPathFor } from "../lib/jsonl_tail.js";
import { detectHallucination, extractToolUses } from "../lib/hallucination.js";
import { style, styleStatus, banner } from "../lib/style.js";
import { agnetLabel } from "../lib/agnet.js";
import { errorLine } from "../lib/error_ui.js";

/**
 * `orql watch <plan_id>` — live-updating fleet dashboard.
 *
 * Polls state + JSONL every second, redraws in place via ANSI cursor
 * controls. Hides the terminal cursor while running and restores it on
 * Ctrl-C. Lines are kept stable-height so each refresh just moves the
 * cursor up and rewrites — no scrollback churn.
 */

const REFRESH_MS = 1000;

const ESC = "\x1b[";
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const CLEAR_LINE = `${ESC}2K`;
const cursorUp = (n: number) => `${ESC}${n}A`;

export async function watchPlan(stateDir: string, planId: string): Promise<number> {
  // First render builds the canvas; subsequent renders move up and rewrite.
  let drawnLines = 0;
  let stopped = false;
  const onSig = () => {
    stopped = true;
  };
  process.on("SIGINT", onSig);
  process.stdout.write(HIDE_CURSOR);

  try {
    while (!stopped) {
      const frame = await renderFrame(stateDir, planId);
      if (drawnLines > 0) {
        process.stdout.write(cursorUp(drawnLines));
      }
      // Clear each line as we redraw to avoid stale trailing characters.
      const lines = frame.split("\n");
      for (const line of lines) {
        process.stdout.write(CLEAR_LINE + "\r" + line + "\n");
      }
      drawnLines = lines.length;
      await sleep(REFRESH_MS);
    }
    return 0;
  } catch (err) {
    process.stdout.write(SHOW_CURSOR);
    process.stderr.write(errorLine((err as Error).message));
    return 1;
  } finally {
    process.stdout.write(SHOW_CURSOR);
    process.removeListener("SIGINT", onSig);
  }
}

async function renderFrame(stateDir: string, planId: string): Promise<string> {
  const store = new StateStore(stateDir);
  let plan: Plan;
  try {
    plan = await store.read((s) => {
      const p = s.plans[planId] ?? Object.values(s.plans).find((x) => x.id.startsWith(planId));
      if (!p) throw new Error(`Plan not found: ${planId}`);
      return p;
    });
  } catch (err) {
    return errorLine((err as Error).message);
  }

  const lines: string[] = [];
  lines.push(banner());
  lines.push("");
  lines.push(
    `${style.bold(style.coral("Plan"))} ${style.dim(plan.id.slice(0, 8))}  ${styleStatus(plan.status)(plan.status)}  ${style.dim(new Date().toLocaleTimeString())}`
  );
  lines.push(`  ${style.sand(truncate(plan.rootTask, 90))}`);
  lines.push("");

  let totalTokens = 0;
  const cwd = process.cwd();
  for (const t of plan.tasks) {
    const agnet = style.coral(agnetLabel(t.agnetName).padEnd(16));
    const status = styleStatus(t.status)(glyphFor(t.status) + " " + t.status.padEnd(10));
    let activity = "";
    let tokens = "";
    if (t.spawnedSessionId) {
      try {
        const snap = await snapshotSession(cwd, t.spawnedSessionId);
        totalTokens += snap.totalEffectiveTokens;
        const tk = Math.round(snap.totalEffectiveTokens / 1000);
        tokens = style.dim(`${tk.toString().padStart(4)}k`);
        if (snap.terminated) {
          activity = style.coral("✓ terminated");
        } else if (snap.lastToolUse) {
          activity = style.cream(snap.lastToolUse.name);
        } else if (snap.lastEventType) {
          activity = style.sand(snap.lastEventType);
        }
        // Per-task budget hint warning
        if (t.budgetHintTokens && snap.totalEffectiveTokens > 0.7 * t.budgetHintTokens) {
          const pct = Math.round((snap.totalEffectiveTokens / t.budgetHintTokens) * 100);
          activity += " " + style.crimson(`⚠ ${pct}% of hint`);
        }
        // Hallucination peek
        try {
          const tu = await extractToolUses(jsonlPathFor(cwd, t.spawnedSessionId));
          const hallu = await detectHallucination(tu, cwd);
          if (hallu.level === "moderate") activity += " " + style.crimson("⚠ hallu?");
          else if (hallu.level === "severe") activity += " " + style.crimson("⚠⚠ severe");
        } catch {
          /* skip */
        }
      } catch {
        activity = style.sand("?");
      }
    }
    lines.push(`  ${status}  ${agnet}  ${truncate(t.title, 36).padEnd(36)}  ${tokens}  ${activity}`);
    if (t.prUrl) lines.push(`        ${style.sand("PR:")} ${style.cream(t.prUrl)}`);
  }

  lines.push("");
  const tk = totalTokens.toLocaleString();
  const cap = plan.budgetCapTokens.toLocaleString();
  const pct = Math.min(100, Math.round((totalTokens / plan.budgetCapTokens) * 100));
  const bar = renderBar(pct, 30);
  lines.push(`  ${style.sand("budget:")} ${bar}  ${style.cream(tk)} / ${cap} (${pct}%)`);
  if (plan.notes.length > 0) lines.push(`  ${style.sand("notes:")}  ${plan.notes.length}`);
  if (plan.claims.length > 0) lines.push(`  ${style.sand("claims:")} ${plan.claims.length}`);

  lines.push("");
  lines.push(style.dim(`(refreshing every ${REFRESH_MS}ms — Ctrl-C to exit)`));
  return lines.join("\n");
}

function renderBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const color = pct >= 100 ? style.crimson : pct >= 80 ? style.crimson : style.coral;
  return color("█".repeat(filled)) + style.dim("░".repeat(empty));
}

function glyphFor(status: string): string {
  switch (status) {
    case "running":
    case "dispatched":
      return "⏵";
    case "done":
    case "collected":
      return "✓";
    case "failed":
      return "✗";
    case "cancelled":
    case "cancelled_overbudget":
      return "🛑";
    default:
      return "·";
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
