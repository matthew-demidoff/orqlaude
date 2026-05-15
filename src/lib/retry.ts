import { promises as fs } from "node:fs";
import path from "node:path";
import { runOrchTurn } from "./orch_turn.js";
import type { StateStore, Plan, Task } from "./state.js";
import { findPlan, findTask } from "./state.js";

/**
 * Retry orchestrator.
 *
 * Two failure modes get retries:
 *
 *   1. died_at_launch (PID gone within ~1.5s of spawn). Usually a CLI env
 *      issue — "Not logged in", malformed --mcp-config, claude binary
 *      missing. We retry up to N times with exponential backoff. After the
 *      retry budget is exhausted, we escalate to the user via Telegram.
 *
 *   2. failed-after-work-started (Agnet ran for a while then crashed or
 *      exited without producing a PR). We don't blindly retry — we spawn
 *      a "debugger" Agnet whose only job is to read the failed worktree
 *      + stderr/stdout + JSONL, identify the failure mode, and either:
 *        (a) suggest a fix the user can apply by hand,
 *        (b) say "try again, this was flaky", or
 *        (c) declare it unsalvageable and recommend rolling back.
 *
 * The debugger runs as a regular orqlaude Agnet so it inherits the full
 * tool surface (can read other files, query memory, post notes). Its
 * report is appended to the failed task's `summary` field.
 *
 * Plan-billing: classifier turn (deciding which failure mode + whether to
 * retry) is `claude -p` — cheap. Debugger Agnet is a full spawn — has its
 * own per-Agnet budget cap.
 */

export interface RetryConfig {
  /** Max retries for died_at_launch. Default 2. */
  maxDiedAtLaunchRetries: number;
  /** Backoff between retries, ms. Default 30000. */
  retryBackoffMs: number;
  /** Whether to spawn a debugger Agnet for failed-after-work-started.
   *  Default true. */
  spawnDebuggerOnFailure: boolean;
}

export const DEFAULT_RETRY: RetryConfig = {
  maxDiedAtLaunchRetries: 2,
  retryBackoffMs: 30_000,
  spawnDebuggerOnFailure: true,
};

export interface RetryDecision {
  action: "retry" | "spawn_debugger" | "escalate" | "give_up";
  reason: string;
  retryAfterMs?: number;
  /** Debugger-prompt body if action === "spawn_debugger". */
  debuggerPrompt?: string;
}

/**
 * Classify a task failure via runOrchTurn — cheap, Plan-billed. Returns a
 * RetryDecision the daemon's recovery loop will act on.
 */
export async function classifyFailure(
  task: Task,
  stderrSnippet: string,
  stdoutSnippet: string,
  cfg: RetryConfig
): Promise<RetryDecision> {
  const retryCount = countRetries(task);
  const isLaunchDeath = task.status === "died_at_launch" || (task.status === "failed" && !task.startedAt);

  // Fast path: died_at_launch with budget remaining → just retry with backoff.
  if (isLaunchDeath && retryCount < cfg.maxDiedAtLaunchRetries) {
    return {
      action: "retry",
      reason: `died_at_launch retry ${retryCount + 1}/${cfg.maxDiedAtLaunchRetries}`,
      retryAfterMs: cfg.retryBackoffMs,
    };
  }
  if (isLaunchDeath && retryCount >= cfg.maxDiedAtLaunchRetries) {
    return {
      action: "escalate",
      reason: `Exhausted ${cfg.maxDiedAtLaunchRetries} died_at_launch retries. Likely a misconfig (claude binary, env, MCP) — needs user inspection.`,
    };
  }

  // Failed-after-work-started — run a classifier turn to see if it's
  // worth a debugger Agnet or if we should just give up.
  const prompt = `You are a triage agent for a coding agent that crashed mid-task. Decide what to do next.

Task title: ${task.title}
Task tldr: ${task.tldr}
Status: ${task.status}
Exit reason: ${task.exitReason ?? "(unknown)"}
Already retried: ${retryCount} time(s)
Worktree branch: ${task.worktreeBranch ?? "(none)"}

stderr (last 2KB):
${stderrSnippet || "(empty)"}

stdout (last 2KB):
${stdoutSnippet || "(empty)"}

Decide which of these actions is right:
  • "retry"            — the failure looks flaky (network blip, ephemeral file lock). Retry the same task.
  • "spawn_debugger"   — the failure needs investigation. Spawn a dedicated Agnet to read the worktree + logs and report.
  • "escalate"         — needs human eyes; the failure mode is unclear or systemic.
  • "give_up"          — the task is unsalvageable and shouldn't be retried.

Output STRICT JSON, no prose:
{
  "action": "retry" | "spawn_debugger" | "escalate" | "give_up",
  "reason": string,
  "retry_after_ms": number  // only for action=retry; otherwise omit
}`;

  const result = await runOrchTurn({ prompt, model: "sonnet", timeoutMs: 90_000, expectJson: true });
  if (!result.ok || !result.parsedJson) {
    return cfg.spawnDebuggerOnFailure
      ? { action: "spawn_debugger", reason: "Classifier turn failed; defaulting to debugger Agnet.", debuggerPrompt: defaultDebuggerPrompt(task) }
      : { action: "escalate", reason: "Classifier turn failed and debugger spawning disabled." };
  }
  const v = result.parsedJson as { action?: string; reason?: string; retry_after_ms?: number };
  const action = (v.action ?? "escalate") as RetryDecision["action"];
  return {
    action,
    reason: v.reason ?? "(no reason given)",
    retryAfterMs: v.retry_after_ms,
    debuggerPrompt: action === "spawn_debugger" ? defaultDebuggerPrompt(task) : undefined,
  };
}

function defaultDebuggerPrompt(task: Task): string {
  return `# Task: debug a failed Agnet

A sibling Agnet ("${task.title}") failed. Your job is to read the wreckage and report.

## Failed Agnet's info
  - status: ${task.status}
  - branch: ${task.worktreeBranch ?? "(none)"}
  - worktree: ${task.worktreePath ?? "(none)"}
  - stderr log: ${task.stderrPath ?? "(none)"}
  - stdout log: ${task.stdoutPath ?? "(none)"}
  - exit reason: ${task.exitReason ?? "(unknown)"}

## Your steps
  1. Read the stderr and stdout logs (full content, not just the snippet).
  2. If the worktree exists, inspect it: \`git status\`, \`git diff main\`, look at the last few files touched.
  3. Look at the JSONL transcript if you can find it.
  4. Determine the failure mode: was it a code bug, a tool error, hit a budget cap, hallucination, network?
  5. If it's recoverable (the agent's partial work is salvageable), describe how to pick up where they left off.
  6. If it's not, describe what went wrong so the user can avoid it next time.

## Output
Use \`mcp__orqlaude__post_note\` to your parent plan with a single comprehensive note containing your findings. Use \`mcp__orqlaude__remember\` to write a \`ledger\` entry capturing "X failed because Y; next time do Z."

Be brief but complete. The user is the audience.`;
}

function countRetries(task: Task): number {
  // We encode retry counts in the task summary as "[retry N/M]" markers.
  // Daemon writes these when it re-spawns.
  const m = (task.summary ?? "").match(/\[retry (\d+)\/\d+\]/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Read last N bytes from a file. Used to get stderr/stdout tails for the
 * classifier prompt.
 */
export async function readTail(filePath: string | undefined, maxBytes: number): Promise<string> {
  if (!filePath) return "";
  try {
    const stat = await fs.stat(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fh = await fs.open(filePath, "r");
    try {
      const buf = Buffer.alloc(stat.size - start);
      await fh.read(buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
}

/**
 * Mark a task as being retried — increments the retry counter and resets
 * its lifecycle fields so spawn_via_cli can re-fire cleanly.
 */
export async function markForRetry(store: StateStore, planId: string, taskId: string, cfg: RetryConfig): Promise<void> {
  await store.update((state) => {
    const plan = findPlan(state, planId);
    const task = findTask(plan, taskId);
    const current = countRetries(task);
    const next = current + 1;
    task.status = "pending";
    task.spawnedSessionId = undefined;
    task.pid = undefined;
    task.startedAt = undefined;
    task.finishedAt = undefined;
    task.exitReason = undefined;
    task.summary = `${(task.summary ?? "").replace(/\[retry \d+\/\d+\]/g, "").trim()} [retry ${next}/${cfg.maxDiedAtLaunchRetries}]`.trim();
  });
}
