import { promises as fs } from "node:fs";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { StateStore, findPlan, type Plan, type Task } from "../lib/state.js";
import { MemoryStore } from "../lib/memory.js";
import { BacklogStore } from "../lib/backlog.js";
import { GuardrailStore, DEFAULT_GUARDRAILS } from "../lib/guardrails.js";
import { snapshotSession } from "../lib/jsonl_tail.js";
import { isProcessAlive, sleep } from "../lib/process_lib.js";
import { readChildExitRecord } from "../lib/spawn_cli.js";
import {
  fetchPrInfo,
  fetchPrDiff,
  runReviewerTurn,
  applyRule,
  postReviewComment,
  squashMerge,
} from "../lib/auto_merge.js";
import { findTemplate } from "../lib/templates.js";
import { classifyFailure, DEFAULT_RETRY, markForRetry, readTail } from "../lib/retry.js";
import { resolveStateDir } from "../lib/state_dir.js";
import { VERSION } from "../lib/version.js";
import { loadConfig } from "../telegram/config.js";

/**
 * orqlaude autopilot daemon.
 *
 * This is plain Node TS — no Anthropic SDK. When the daemon needs to think,
 * it spawns `claude -p` (via lib/orch_turn.runOrchTurn) which is billed
 * against the user's Claude Max plan, not the API. Cache reads are free on
 * the Plan, so a daemon that ticks every 10s and runs ~50 thinking turns
 * per day costs roughly nothing.
 *
 * Tick loop (every TICK_MS ms):
 *
 *   1. Recover state — for every task with spawnedSessionId, refresh from
 *      JSONL + check PID + check exit-record. Promote `died_at_launch` /
 *      `failed` / `done` as appropriate.
 *
 *   2. Failure recovery — for each task that just transitioned to a
 *      terminal-bad state, call classifyFailure, then either retry or
 *      spawn a debugger Agnet or escalate via Telegram.
 *
 *   3. Auto-PR-review — for each task with a fresh prUrl, fetch the PR,
 *      run a reviewer turn, apply the fleet's auto-merge rule, and either
 *      merge or comment.
 *
 *   4. Goal pickup — if the fleet is idle (no tasks pending/running) and
 *      autopilot is unpaused, pick the next backlog goal and prompt the
 *      user via Telegram with the planner's proposed decomposition.
 *
 *   5. Guardrails — check window/day spend; downgrade or pause as needed.
 *
 * Run with: `orql autopilot start` (foreground) or `orql autopilot start --daemon`
 * (background; writes PID file). Stop with `orql autopilot stop`.
 */

const TICK_MS = 10_000;

interface AutopilotOpts {
  /** Foreground vs daemonized. */
  foreground?: boolean;
  /** Verbose logging. */
  verbose?: boolean;
  /** Override tick interval (ms). */
  tickMs?: number;
}

interface AutopilotState {
  startedAt: number;
  ticks: number;
  paused: boolean;
  /** Per-task retry counts (in-memory; persists on the Task summary too). */
  retries: Record<string, number>;
  /** PR URLs we've already reviewed (avoid double-commenting on each tick). */
  reviewedPrs: Set<string>;
  /** Goals we've already proposed via Telegram (avoid spamming). */
  proposedGoals: Set<string>;
}

export async function runAutopilot(opts: AutopilotOpts = {}): Promise<number> {
  const { path: stateDir } = { path: resolveStateDir().path };
  const store = new StateStore(stateDir);
  const memory = new MemoryStore(stateDir);
  const backlog = new BacklogStore(stateDir);
  const guardrails = new GuardrailStore(stateDir);
  const pidFile = path.join(stateDir, "autopilot.pid");
  const pauseFile = path.join(stateDir, "autopilot.paused");

  // Detect duplicate daemon.
  if (existsSync(pidFile)) {
    try {
      const existing = parseInt((await fs.readFile(pidFile, "utf8")).trim(), 10);
      if (Number.isFinite(existing) && isProcessAlive(existing)) {
        console.error(`orql autopilot is already running (pid=${existing}). Use 'orql autopilot stop' first.`);
        return 1;
      }
    } catch {
      /* stale, ignore */
    }
  }
  writeFileSync(pidFile, `${process.pid}\n`);

  // Track shutdown hooks.
  const cleanup = async () => {
    try {
      await fs.unlink(pidFile);
    } catch {}
  };
  process.on("SIGTERM", async () => {
    log("SIGTERM received — shutting down");
    await cleanup();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    log("SIGINT received — shutting down");
    await cleanup();
    process.exit(0);
  });

  const state: AutopilotState = {
    startedAt: Date.now(),
    ticks: 0,
    paused: existsSync(pauseFile),
    retries: {},
    reviewedPrs: new Set(),
    proposedGoals: new Set(),
  };

  log(`orqlaude autopilot v${VERSION} started (pid=${process.pid}, state=${stateDir})`);
  if (state.paused) log(`note: autopilot is paused (pause file present at ${pauseFile})`);

  const tickMs = opts.tickMs ?? TICK_MS;
  let stopped = false;
  process.on("beforeExit", () => {
    stopped = true;
  });

  while (!stopped) {
    state.ticks++;
    state.paused = existsSync(pauseFile);
    try {
      await tick(state, store, memory, backlog, guardrails, opts);
    } catch (err) {
      log(`tick #${state.ticks} threw: ${(err as Error).message}`);
    }
    await sleep(tickMs);
  }
  await cleanup();
  return 0;
}

// Module-level logger so tick() can use it too. Writes timestamped lines to
// stderr — keeps stdout clean for any --json modes we add later.
function log(msg: string): void {
  const ts = new Date().toISOString().replace("T", " ").replace(/\..*$/, "");
  process.stderr.write(`[${ts}] ${msg}\n`);
}

async function tick(
  state: AutopilotState,
  store: StateStore,
  memory: MemoryStore,
  backlog: BacklogStore,
  guardrails: GuardrailStore,
  opts: AutopilotOpts
): Promise<void> {
  // ---- 1. State recovery ----------------------------------------------------
  const plans = await store.read((s) => Object.values(s.plans));
  const cwd = process.cwd();

  // Re-snapshot every running task; reconcile status.
  for (const plan of plans) {
    if (plan.status === "collected" || plan.status === "cancelled" || plan.status === "cancelled_overbudget") {
      continue;
    }
    for (const task of plan.tasks) {
      if (!task.spawnedSessionId) continue;
      if (task.status === "done" || task.status === "failed" || task.status === "cancelled" || task.status === "died_at_launch") {
        continue;
      }
      const snap = await snapshotSession(cwd, task.spawnedSessionId, task.stdoutPath);
      const pidDead = task.pid ? !isProcessAlive(task.pid) : false;
      const exitRec = task.exitJsonPath ? await readChildExitRecord(task.exitJsonPath) : null;
      if (snap.terminated || exitRec) {
        // Promote terminal state.
        await store.update((s) => {
          const p = findPlan(s, plan.id);
          const t = p.tasks.find((tt) => tt.id === task.id);
          if (!t) return;
          if (exitRec) {
            t.status = exitRec.success ? "done" : "failed";
            t.exitReason = exitRec.signal ? `signal=${exitRec.signal}` : `exit_code=${exitRec.exit_code}`;
          } else if (snap.terminated) {
            t.status = "done";
            t.exitReason = snap.terminationReason ?? "transcript end";
          }
          t.finishedAt = t.finishedAt ?? Date.now();
          if (snap.totalEffectiveTokens > 0) t.tokensUsed = snap.totalEffectiveTokens;
          if (snap.totalCostUsd > 0) t.costUsd = snap.totalCostUsd;
        });
        // Telemetry for guardrails.
        if (snap.billedTokens > 0) {
          await guardrails.record({
            ts: Date.now(),
            billed: snap.billedTokens,
            cached: snap.cachedTokens,
            planId: plan.id,
            taskId: task.id,
            source: "task_termination",
          });
        }
      } else if (pidDead && !snap.lastActivityAt) {
        // Died at launch — PID gone and no transcript activity ever recorded.
        await store.update((s) => {
          const p = findPlan(s, plan.id);
          const t = p.tasks.find((tt) => tt.id === task.id);
          if (!t) return;
          t.status = "died_at_launch";
          t.finishedAt = t.finishedAt ?? Date.now();
        });
      }
    }
  }

  // Re-fetch after reconciliation.
  const reconciledPlans = await store.read((s) => Object.values(s.plans));

  // ---- 2. Failure recovery -------------------------------------------------
  for (const plan of reconciledPlans) {
    for (const task of plan.tasks) {
      if (task.status !== "died_at_launch" && task.status !== "failed") continue;
      // Already addressed?
      if (task.summary?.includes("[retry exhausted]") || task.summary?.includes("[debugger spawned]")) continue;
      const stderrTail = await readTail(task.stderrPath, 2000);
      const stdoutTail = await readTail(task.stdoutPath, 2000);
      const decision = await classifyFailure(task, stderrTail, stdoutTail, DEFAULT_RETRY);
      log(`task ${task.agnetName ?? task.id.slice(0, 8)}: classifier said ${decision.action} (${decision.reason})`);
      if (decision.action === "retry") {
        await markForRetry(store, plan.id, task.id, DEFAULT_RETRY);
        await pushOrphanNotification(
          store,
          `🔁 Agnet ${task.agnetName ?? task.id.slice(0, 8)} died at launch — auto-retrying (${decision.reason}).`,
          "low"
        );
      } else if (decision.action === "spawn_debugger") {
        await store.update((s) => {
          const p = findPlan(s, plan.id);
          const t = p.tasks.find((tt) => tt.id === task.id);
          if (!t) return;
          t.summary = `${t.summary ?? ""} [debugger spawned at ${new Date().toISOString()}]`.trim();
        });
        await pushOrphanNotification(
          store,
          `🔍 Agnet ${task.agnetName ?? task.id.slice(0, 8)} failed (${decision.reason}). Marking for debugger Agnet. Use 'orql watch ${plan.id.slice(0, 8)}' to follow.`,
          "normal"
        );
      } else if (decision.action === "escalate") {
        await store.update((s) => {
          const p = findPlan(s, plan.id);
          const t = p.tasks.find((tt) => tt.id === task.id);
          if (!t) return;
          t.summary = `${t.summary ?? ""} [retry exhausted; escalated to user]`.trim();
        });
        await pushOrphanNotification(
          store,
          `🚨 Agnet ${task.agnetName ?? task.id.slice(0, 8)} failed; auto-recovery exhausted. Reason: ${decision.reason}. Manual review needed in plan ${plan.id.slice(0, 8)}.`,
          "high"
        );
      } else {
        // give_up
        await store.update((s) => {
          const p = findPlan(s, plan.id);
          const t = p.tasks.find((tt) => tt.id === task.id);
          if (!t) return;
          t.summary = `${t.summary ?? ""} [given up: ${decision.reason}]`.trim();
        });
      }
    }
  }

  // ---- 3. Auto-PR-review ----------------------------------------------------
  for (const plan of reconciledPlans) {
    const tpl = plan.tasks[0]?.summary?.match(/\[template:([\w-]+)\]/)?.[1];
    const template = tpl ? findTemplate(tpl) : undefined;
    const rule = template?.autoMerge;
    if (!rule) continue;
    for (const task of plan.tasks) {
      if (!task.prUrl || state.reviewedPrs.has(task.prUrl)) continue;
      try {
        const pr = await fetchPrInfo(task.prUrl, cwd);
        if (pr.state !== "OPEN") {
          state.reviewedPrs.add(task.prUrl);
          continue;
        }
        const diff = await fetchPrDiff(task.prUrl, cwd);
        const review = await runReviewerTurn(pr, diff, cwd);
        const decision = applyRule(pr, review, rule);
        log(`PR ${task.prUrl}: review=${review.verdict}, rule=${decision.ok ? "OK" : "BLOCKED"} (${decision.violations.join("; ")})`);
        if (decision.ok) {
          const ok = await squashMerge(task.prUrl, cwd, rule.method ?? "squash");
          await pushOrphanNotification(
            store,
            ok
              ? `✅ Auto-merged PR ${task.prUrl} (reviewer: ${review.verdict}, rule passed).`
              : `⚠️ Auto-merge failed for PR ${task.prUrl} despite passing rules. Manual merge needed.`,
            ok ? "low" : "high"
          );
        } else {
          await postReviewComment(task.prUrl, review, cwd);
          await pushOrphanNotification(
            store,
            `🤖 Auto-review for ${task.prUrl}: ${review.verdict}. Posted comment. Blockers: ${decision.violations.join("; ")}`,
            review.verdict === "BLOCKER" ? "high" : "normal"
          );
        }
        // Remember the decision in the ledger.
        await memory.remember({
          category: "ledger",
          key: `auto-review:${pr.number}`,
          value: `Auto-review verdict ${review.verdict} on ${task.prUrl}. ${review.summary}`,
          rationale: decision.ok ? "Met all auto-merge rules" : `Violations: ${decision.violations.join("; ")}`,
          bornFrom: { planId: plan.id, taskId: task.id },
        });
        state.reviewedPrs.add(task.prUrl);
      } catch (err) {
        log(`auto-review failed for ${task.prUrl}: ${(err as Error).message}`);
      }
    }
  }

  // ---- 4. Goal pickup -------------------------------------------------------
  if (!state.paused) {
    const fleetIdle =
      reconciledPlans.filter((p) => p.status === "running" || p.status === "dispatching").length === 0;
    if (fleetIdle) {
      const goal = await backlog.pickNext();
      if (goal && !state.proposedGoals.has(goal.id)) {
        log(`fleet idle; proposing goal ${goal.shortId}: "${goal.title}"`);
        await pushOrphanNotification(
          store,
          `💡 Autopilot ready for next goal: "${goal.title}" (priority ${goal.priority}). Reply /now to start, /queue to see all, /pause to halt autopilot.`,
          "normal"
        );
        state.proposedGoals.add(goal.id);
      }
    }
  }

  // ---- 5. Guardrails --------------------------------------------------------
  const snap = await guardrails.snapshot(DEFAULT_GUARDRAILS);
  if (snap.level === "yellow" && state.ticks % 60 === 0) {
    await pushOrphanNotification(
      store,
      `⚠️ Budget window at ${Math.round(snap.windowPct * 100)}% — slowing down. Day: ${Math.round(snap.dayPct * 100)}% of soft cap.`,
      "normal"
    );
  } else if (snap.level === "orange") {
    if (state.ticks % 30 === 0) {
      await pushOrphanNotification(
        store,
        `🟠 Budget window at ${Math.round(snap.windowPct * 100)}% — pausing new fleet starts. Use /resume to override.`,
        "high"
      );
    }
    // Force pause for new goals until next window.
    if (!existsSync(pauseFile())) writeFileSync(pauseFile(), `orange_at_${Date.now()}\n`);
  } else if (snap.level === "red") {
    await pushOrphanNotification(
      store,
      `🔴 Budget window at ${Math.round(snap.windowPct * 100)}% — autopilot HALTED. Use /resume after the next 5h reset.`,
      "high"
    );
    if (!existsSync(pauseFile())) writeFileSync(pauseFile(), `red_at_${Date.now()}\n`);
  }
  if (opts.verbose && state.ticks % 6 === 0) {
    log(`tick ${state.ticks}: plans=${reconciledPlans.length} guardrails=${snap.level} (win=${Math.round(snap.windowPct * 100)}%, day=${Math.round(snap.dayPct * 100)}%)`);
  }

  function pauseFile(): string {
    return path.join(resolveStateDir().path, "autopilot.paused");
  }
}

async function pushOrphanNotification(store: StateStore, text: string, urgency: "low" | "normal" | "high"): Promise<void> {
  const { randomUUID } = await import("node:crypto");
  await store.update((s) => {
    s.orphanNotifications = s.orphanNotifications ?? [];
    s.orphanNotifications.push({
      id: randomUUID(),
      text,
      urgency,
      createdAt: Date.now(),
      delivered: false,
    });
  });
}

// ----- CLI subcommand handlers --------------------------------------------

export async function cmdAutopilot(args: string[]): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case "start":
      return runAutopilot({
        verbose: args.includes("--verbose") || args.includes("-v"),
        tickMs: extractFlag(args, "--tick-ms") ? parseInt(extractFlag(args, "--tick-ms")!, 10) : undefined,
      });
    case "stop":
      return autopilotStop();
    case "status":
      return autopilotStatus();
    case "pause":
      return autopilotPause();
    case "resume":
      return autopilotResume();
    default:
      printAutopilotHelp();
      return sub ? 1 : 0;
  }
}

function extractFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

async function autopilotStop(): Promise<number> {
  const stateDir = resolveStateDir().path;
  const pidFile = path.join(stateDir, "autopilot.pid");
  if (!existsSync(pidFile)) {
    process.stdout.write("autopilot is not running\n");
    return 0;
  }
  const pid = parseInt((await fs.readFile(pidFile, "utf8")).trim(), 10);
  if (!Number.isFinite(pid) || !isProcessAlive(pid)) {
    await fs.unlink(pidFile).catch(() => {});
    process.stdout.write("autopilot pid was stale; cleared\n");
    return 0;
  }
  try {
    process.kill(pid, "SIGTERM");
    process.stdout.write(`sent SIGTERM to autopilot pid=${pid}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`failed to signal pid=${pid}: ${(err as Error).message}\n`);
    return 1;
  }
}

async function autopilotStatus(): Promise<number> {
  const stateDir = resolveStateDir().path;
  const pidFile = path.join(stateDir, "autopilot.pid");
  const pauseFile = path.join(stateDir, "autopilot.paused");
  if (!existsSync(pidFile)) {
    process.stdout.write("autopilot: stopped\n");
    return 0;
  }
  const pid = parseInt((await fs.readFile(pidFile, "utf8")).trim(), 10);
  const alive = Number.isFinite(pid) && isProcessAlive(pid);
  const paused = existsSync(pauseFile);
  process.stdout.write(
    `autopilot: ${alive ? "running" : "stale-pid"} (pid=${pid}${paused ? ", paused" : ""}, state_dir=${stateDir})\n`
  );
  // Snapshot from guardrails.
  const gs = new GuardrailStore(stateDir);
  const snap = await gs.snapshot(DEFAULT_GUARDRAILS);
  process.stdout.write(
    `budget: window ${Math.round(snap.windowPct * 100)}% (${formatTokens(snap.windowBilled)}/${formatTokens(snap.windowCap)}), day ${Math.round(snap.dayPct * 100)}% [${snap.level}]\n`
  );
  return alive ? 0 : 1;
}

async function autopilotPause(): Promise<number> {
  const stateDir = resolveStateDir().path;
  const pauseFile = path.join(stateDir, "autopilot.paused");
  writeFileSync(pauseFile, `paused_at=${Date.now()}\n`);
  process.stdout.write("autopilot paused (daemon will refuse to start new goals)\n");
  return 0;
}

async function autopilotResume(): Promise<number> {
  const stateDir = resolveStateDir().path;
  const pauseFile = path.join(stateDir, "autopilot.paused");
  if (existsSync(pauseFile)) {
    await fs.unlink(pauseFile).catch(() => {});
  }
  process.stdout.write("autopilot resumed\n");
  return 0;
}

function printAutopilotHelp(): void {
  process.stdout.write(
    `orql autopilot — persistent orchestrator daemon\n\n` +
      `  orql autopilot start [--verbose] [--tick-ms N]\n` +
      `      Run the daemon in the foreground.\n` +
      `  orql autopilot stop\n` +
      `      SIGTERM the running daemon.\n` +
      `  orql autopilot status\n` +
      `      Show daemon status + current budget burn.\n` +
      `  orql autopilot pause\n` +
      `      Stop picking new goals. In-flight fleets continue.\n` +
      `  orql autopilot resume\n` +
      `      Reverse pause.\n\n` +
      `The daemon uses Plan-billed \`claude -p\` for all thinking turns —\n` +
      `no Anthropic API key required. Cache reads are free on the Plan, so\n` +
      `a full day of ticking burns a tiny fraction of the quota.\n`
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
