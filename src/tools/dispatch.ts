import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StateStore, findPlan, findTask, type BudgetMode } from "../lib/state.js";
import { jsonlPathFor, snapshotSession } from "../lib/jsonl_tail.js";
import { detectHallucination, extractToolUses } from "../lib/hallucination.js";
import { spawnAgnetViaCli, findGitRoot, cleanupPlanWorktrees, readChildExitRecord } from "../lib/spawn_cli.js";
import { isProcessAlive } from "../lib/process_lib.js";
import { resolveStateDir } from "../lib/state_dir.js";
import { probeTelegramStatus } from "../lib/telegram_status.js";
import { VERSION } from "../lib/version.js";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AuditLog } from "../lib/audit.js";

/**
 * Dispatch-phase tools: next_task, register_spawn, status, collect.
 *
 * v0.2.0:
 *  • status() now includes per-agent hallucination report + token usage.
 *  • status() flips the plan to `cancelled_overbudget` and queues STOP
 *    broker messages when total token usage exceeds the budget cap.
 *  • The spawn prompt embeds the task_id so children can self-register via
 *    `checkin` on their first turn — register_spawn becomes a fallback.
 */

export function registerDispatch(server: McpServer, store: StateStore, audit: AuditLog): void {
  // ---- next_task ------------------------------------------------------------
  server.tool(
    "next_task",
    "Return the next pending task to dispatch, plus a priority-ordered list of `spawn_strategies` describing exactly which tool to call with what args. The recommended strategy uses `mcp__ccd_session__spawn_task` (worktree isolation + Desktop sidebar). Fallbacks: the host's built-in `Agent` tool (in-session, no isolation), or a shelled-out `claude -p` (headless CLI). Pick deliberately — picking the host's Agent tool by habit loses orqlaude's worktree isolation and means agents may collide on shared files.",
    { plan_id: z.string() },
    audit.wrap(
      "next_task",
      async ({ plan_id }) => {
        const result = await store.update((state) => {
          const plan = findPlan(state, plan_id);
          if (plan.status !== "approved" && plan.status !== "dispatching") {
            throw new Error(`Plan ${plan_id} is not approved (status=${plan.status}). Call confirm first.`);
          }
          plan.status = "dispatching";
          const next = plan.tasks.find((t) => t.status === "pending");
          if (!next) {
            plan.status = "running";
            return { plan_id, task: null, message: "All tasks dispatched." };
          }
          next.status = "dispatched";
          next.startedAt = Date.now();
          const spawnPrompt = buildSpawnPrompt(plan.id, next.id, next.prompt, next.branchHint);
          return {
            plan_id,
            task: {
              task_id: next.id,
              title: next.title,
              prompt: spawnPrompt,
              tldr: next.tldr,
              scope: next.scope ?? [],
              agnet: next.agnetName ? `Agnet ${next.agnetName}` : "Agnet",
            },
            // Priority-ordered spawn options. Orchestrators should walk the
            // list and pick the first one they have available in context.
            spawn_strategies: [
              {
                priority: 1,
                tool: "mcp__orqlaude__spawn_via_cli",
                preferred: true,
                isolation: "dedicated git worktree per task (created by orqlaude)",
                visibility: "JSONL on disk; appears in Desktop sidebar on app restart",
                note: "RECOMMENDED. orqlaude creates the worktree, pre-allocates the session id, spawns claude -p directly. No reliance on the orchestrator picking the right tool, no worktree collisions between siblings, broker is wired automatically. Call mcp__orqlaude__spawn_via_cli(plan_id, task_id) — no other args needed; the prompt is already in state.",
                args: {
                  plan_id: plan.id,
                  task_id: next.id,
                },
              },
              {
                priority: 2,
                tool: "mcp__ccd_session__spawn_task",
                isolation: "worktree (host-managed)",
                visibility: "Claude Desktop Code sidebar (live)",
                note: "Use this if you want the Agnet visible in your Desktop sidebar immediately. The host creates the worktree. The Agnet self-registers via checkin on first turn. Worktree-collision bug observed in 0.4.x — prefer spawn_via_cli for reliability until further validation.",
                load_if_missing: "ToolSearch query: 'select:mcp__ccd_session__spawn_task'.",
                args: {
                  title: next.title,
                  prompt: spawnPrompt,
                  tldr: next.tldr,
                },
              },
              {
                priority: 3,
                tool: "Agent (host built-in)",
                isolation: "NONE — shares the orchestrator's cwd + filesystem",
                visibility: "in-session tool use only — no Desktop session",
                warning:
                  "AVOID for parallel fleets. The Agnet runs in the SAME worktree as you. Concurrent siblings will collide on git operations, potentially wiping uncommitted work. Only use if you're running a single task or have verified there's no sibling activity. Even then, claim_files is your only collision signal.",
                args: {
                  subagent_type: "general-purpose",
                  description: next.title.slice(0, 60),
                  prompt: spawnPrompt,
                },
              },
            ],
            next_step:
              "Pick a strategy and call its tool. Strategy 1 (mcp__ccd_session__spawn_task) is strongly preferred — it gives worktree isolation, Desktop sidebar visibility, and the cleanest broker integration. The Agnet will self-register via checkin on first turn; you don't need to call register_spawn manually unless strategy 2 was used and the Agnet failed to call checkin.",
          };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      ({ plan_id }) => ({ planId: plan_id })
    )
  );

  // ---- spawn_via_cli (orqlaude-owned spawning, v0.5.3+) --------------------
  server.tool(
    "spawn_via_cli",
    "PREFERRED SPAWN PATH. orqlaude creates a dedicated git worktree for this task, pre-allocates the Agnet's session_id, and spawns `claude -p` directly. No reliance on the orchestrator picking the right spawn tool. The Agnet's broker is auto-wired (orqlaude is passed inline via --mcp-config). Returns the worktree path + session_id + pid. Side effects: creates `<project>/.orqlaude-worktrees/<plan_short>-<agnet>/`. Requires the `claude` binary on PATH or via CLAUDE_BIN env. Caveat: spawned sessions don't appear in Desktop sidebar until app restart (the JSONL is on disk; the in-memory cache hasn't seen it).",
    {
      plan_id: z.string(),
      task_id: z.string(),
      project_root: z.string().optional().describe("Optional override of the git root. Defaults to walking up from cwd until a .git is found."),
      claude_bin: z.string().optional().describe("Optional override of the claude binary path."),
    },
    audit.wrap(
      "spawn_via_cli",
      async ({ plan_id, task_id, project_root, claude_bin }) => {
        const result = await store.update(async (state) => {
          const plan = findPlan(state, plan_id);
          const task = findTask(plan, task_id);
          if (task.spawnedSessionId) {
            throw new Error(`Task ${task_id} already has a spawned session (${task.spawnedSessionId}). Use kill_task / cleanup_worktrees if you want to re-spawn.`);
          }
          const root = project_root ?? findGitRoot(process.cwd());
          const stateDir = resolveStateDir().path;
          // v0.10.5: pre-allocate session_id HERE so it can be embedded in
          // the prompt. The agent will see the exact id under "session_id:"
          // in the protocol footer and use it for checkin — no env-var
          // ambiguity.
          const presetSessionId = randomUUID();
          const spawn = await spawnAgnetViaCli({
            projectRoot: root,
            stateDir,
            planId: plan.id,
            taskId: task.id,
            agnetName: task.agnetName,
            prompt: buildSpawnPrompt(plan.id, task.id, task.prompt, task.branchHint, presetSessionId),
            branchHint: task.branchHint,
            claudeBin: claude_bin,
            sessionId: presetSessionId,
          });
          // Pre-register the session so checkin from the child is idempotent.
          // v0.7.0: also record pid + command line + log file paths for
          // post-mortem and PID-liveness checks in status().
          task.spawnedSessionId = spawn.sessionId;
          task.worktreePath = spawn.worktreePath;
          task.worktreeBranch = spawn.branch;
          task.pid = spawn.pid;
          task.commandLine = spawn.commandLine;
          task.stderrPath = spawn.stderrPath;
          task.stdoutPath = spawn.stdoutPath;
          task.exitJsonPath = spawn.exitJsonPath;
          task.status = "running";
          task.startedAt = Date.now();
          // v0.10.7: clear lifecycle leftovers from a prior spawn (e.g. the
          // stopRequested signal set by kill_task before the spawn lock was
          // released). Without this, the new agent's first checkin sees a
          // stale HARD STOP and immediately bails — observed during the
          // Verdant re-spawn in self-test fleet d47c0448.
          task.stopRequested = undefined;
          task.finishedAt = undefined;
          task.exitReason = undefined;
          return {
            plan_id,
            task_id,
            agnet: task.agnetName ? `Agnet ${task.agnetName}` : "Agnet",
            session_id: spawn.sessionId,
            worktree_path: spawn.worktreePath,
            branch: spawn.branch,
            pid: spawn.pid,
            jsonl_path: spawn.jsonlPath,
            command_line: spawn.commandLine,
            stderr_path: spawn.stderrPath,
            stdout_path: spawn.stdoutPath,
            mcp_config_path: spawn.mcpConfigPath,
            next_step:
              "The Agnet is running detached. Poll status(plan_id) for activity. If the child dies silently, status() detects it via PID liveness and flips the task to status=`died_at_launch` with a stderr snippet you can use to debug.",
          };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      ({ plan_id }) => ({ planId: plan_id })
    )
  );

  // ---- cleanup_worktrees (companion to spawn_via_cli, v0.5.3+) -------------
  server.tool(
    "cleanup_worktrees",
    "Remove all orqlaude-managed worktrees for a plan (typically called after `collect`). Only touches paths under <project>/.orqlaude-worktrees/<plan_short>-*. Force-removes via `git worktree remove --force` then falls back to rm -rf if git refuses. v0.9.0: also releases the spawn locks on every task whose worktree was removed - so the orchestrator can re-spawn against the same plan_id + task_id without create_plan churn.",
    {
      plan_id: z.string(),
      project_root: z.string().optional(),
    },
    audit.wrap(
      "cleanup_worktrees",
      async ({ plan_id, project_root }) => {
        const root = project_root ?? findGitRoot(process.cwd());
        const removed = await cleanupPlanWorktrees(root, plan_id);
        // v0.9.0: walk the plan's tasks and release any spawn lock whose
        // worktreePath was just removed. This makes cleanup_worktrees the
        // canonical "reset this plan, let me re-spawn fresh" entry point.
        const released = await store.update((state) => {
          const plan = findPlan(state, plan_id);
          const releasedIds: string[] = [];
          for (const t of plan.tasks) {
            if (t.worktreePath && removed.includes(t.worktreePath)) {
              t.spawnedSessionId = undefined;
              t.pid = undefined;
              t.exitJsonPath = undefined;
              // Reset to pending so next_task / spawn_via_cli treat it fresh.
              // Preserve worktreePath/branch for audit but they'll be
              // overwritten on the next spawn.
              if (t.status === "running" || t.status === "dispatched" || t.status === "died_at_launch") {
                t.status = "pending";
              }
              releasedIds.push(t.id);
            }
          }
          return releasedIds;
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  plan_id,
                  removed_count: removed.length,
                  removed,
                  released_task_ids: released,
                  next_step:
                    released.length > 0
                      ? `Released ${released.length} spawn lock(s). You can call spawn_via_cli on the same task_ids to re-fire.`
                      : undefined,
                },
                null,
                2
              ),
            },
          ],
        };
      },
      ({ plan_id }) => ({ planId: plan_id })
    )
  );

  // ---- register_spawn (MANUAL FALLBACK; rarely needed) ---------------------
  server.tool(
    "register_spawn",
    "MANUAL FALLBACK ONLY. Normally the spawned agent self-registers on its first `checkin` call (the prompt next_task generates instructs it to). Only call this if a child fails to self-register within ~30s — symptom: status() shows the task as `dispatched` long after spawn_task succeeded.",
    {
      plan_id: z.string(),
      task_id: z.string(),
      session_id: z.string(),
    },
    audit.wrap(
      "register_spawn",
      async ({ plan_id, task_id, session_id }) => {
        const result = await store.update((state) => {
          const plan = findPlan(state, plan_id);
          const task = findTask(plan, task_id);
          task.spawnedSessionId = session_id;
          task.status = "running";
          return { plan_id, task_id, session_id, status: task.status, source: "manual" };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      ({ plan_id }) => ({ planId: plan_id })
    )
  );

  // ---- status ---------------------------------------------------------------
  server.tool(
    "status",
    "Snapshot of every tracked task: current activity, cumulative cost+tokens, last assistant preview, termination state, AND a hallucination report per agent (path validation, tool-pattern sanity). Auto-cancels the plan and queues STOP messages if total token usage exceeds the budget cap. Call this when the user asks how agents are doing or to drive automated decisions.",
    { plan_id: z.string() },
    audit.wrap(
      "status",
      async ({ plan_id }) => {
        const plan0 = await store.read((state) => findPlan(state, plan_id));
        const cwd = process.cwd();

        // Gather snapshots + hallucination reports in parallel.
        const snapshots = await Promise.all(
          plan0.tasks.map(async (t) => {
            if (!t.spawnedSessionId) {
              return {
                task_id: t.id,
                title: t.title,
                status: t.status,
                session_id: null as string | null,
                tokens_used: 0,
                cost_usd: 0,
                note: "Not yet spawned (waiting for chip click + self-registration).",
              };
            }
            const snap = await snapshotSession(cwd, t.spawnedSessionId, t.stdoutPath);
            // v0.9.0: fast-path terminal-state read. If the child wrote an
            // exit record via the spawn_via_cli on('exit') handler, surface
            // it - the orchestrator doesn't have to re-poll until isProcessAlive
            // ticks over. Falls through to the regular PID/snapshot path if
            // the file is missing (server restart after spawn, etc).
            const exitRecord = t.exitJsonPath ? await readChildExitRecord(t.exitJsonPath) : null;
            const toolUses = await extractToolUses(jsonlPathFor(cwd, t.spawnedSessionId));
            const hallu = await detectHallucination(toolUses, cwd);
            const taskWarnings: string[] = [];

            // v0.7.0: PID-liveness check. If we have a recorded pid and it's
            // no longer alive AND there's no JSONL activity, the child died
            // silently — flip the task to died_at_launch so the orchestrator
            // stops polling a corpse.
            let derivedStatus: typeof t.status = snap.terminated ? "done" : t.status;
            let stderrExcerpt: string | null = null;
            // v0.9.0: terminal-state precedence:
            //   1. exit-record file (most authoritative; written by the
            //      parent's on('exit') handler).
            //   2. snap.terminated (result row in the event stream).
            //   3. PID liveness + empty stream = died_at_launch.
            if (exitRecord) {
              derivedStatus = exitRecord.success ? "done" : "failed";
              if (!exitRecord.success && t.stderrPath) {
                try {
                  const buf = await fs.readFile(t.stderrPath, "utf8");
                  stderrExcerpt = buf.slice(0, 1000);
                } catch {
                  /* file missing */
                }
              }
              t.status = derivedStatus;
              if (!t.finishedAt) t.finishedAt = exitRecord.terminated_at;
            }
            // died_at_launch is now defined as "PID dead AND no event was
            // ever parsed from either stream source." Earlier versions
            // checked `!snap.exists` which broke once we started creating
            // the stdout log file at spawn time (the file exists but is
            // empty when the child exits before writing). Use
            // lastActivityAt + tokens-used == 0 as the canonical signal.
            const producedNothing =
              !snap.lastActivityAt &&
              snap.totalEffectiveTokens === 0 &&
              !snap.lastAssistantText &&
              !snap.lastToolUse;
            if (
              t.pid &&
              !isProcessAlive(t.pid) &&
              producedNothing &&
              (t.status === "running" || t.status === "dispatched")
            ) {
              derivedStatus = "died_at_launch";
              if (t.stderrPath) {
                try {
                  const buf = await fs.readFile(t.stderrPath, "utf8");
                  stderrExcerpt = buf.slice(0, 1000);
                } catch {
                  /* file missing or unreadable */
                }
              }
              taskWarnings.push(
                `Child PID ${t.pid} is dead and no events were parsed from either the Desktop JSONL or the spawn_via_cli stdout log. ` +
                  `Inspect stderr at ${t.stderrPath ?? "(unknown)"} or re-run the command: ${t.commandLine ?? "(unknown)"}`
              );
              // Persist the new status so subsequent calls don't redo this.
              t.status = "died_at_launch";
            }

            // Per-task soft budget warning: if the task has a budgetHintTokens
            // hint and we've blown past 70% of it, surface a yellow flag so the
            // orchestrator can intervene before the plan-wide hard cap fires.
            // v0.9.2: compare against billed (not total) to match the new
            // default plan-level budget mode.
            const taskBudgetRelevant = (plan0.budgetMode ?? "billed") === "billed"
              ? snap.billedTokens
              : snap.totalEffectiveTokens;
            if (t.budgetHintTokens && taskBudgetRelevant > 0.7 * t.budgetHintTokens) {
              const pct = Math.round((taskBudgetRelevant / t.budgetHintTokens) * 100);
              taskWarnings.push(
                `task at ${pct}% of hint (${taskBudgetRelevant.toLocaleString()} / ${t.budgetHintTokens.toLocaleString()} tokens, mode=${plan0.budgetMode ?? "billed"}). Consider request_stop if it's stalling.`
              );
            }
            return {
              task_id: t.id,
              title: t.title,
              status: derivedStatus,
              session_id: t.spawnedSessionId,
              pid: t.pid ?? null,
              pid_alive: t.pid ? isProcessAlive(t.pid) : null,
              // v0.9.2: `tokens_used` retained as the back-compat field
              // (= totalEffectiveTokens). Prefer `billed_tokens` for
              // Plan-cost decisions.
              tokens_used: snap.totalEffectiveTokens,
              billed_tokens: snap.billedTokens,
              cached_tokens: snap.cachedTokens,
              budget_hint_tokens: t.budgetHintTokens ?? null,
              cost_usd: snap.totalCostUsd,
              last_event_type: snap.lastEventType,
              last_activity_at: snap.lastActivityAt,
              last_assistant_preview: snap.lastAssistantText?.slice(0, 200) ?? null,
              current_tool: snap.lastToolUse?.name ?? null,
              terminated: snap.terminated,
              termination_reason: snap.terminationReason,
              hallucination: { score: hallu.score, level: hallu.level, concerns: hallu.concerns },
              warnings: taskWarnings,
              stop_requested: t.stopRequested ?? null,
              stderr_excerpt: stderrExcerpt,
              stderr_path: t.stderrPath ?? null,
              stdout_path: t.stdoutPath ?? null,
              stream_source: snap.source,
              exit_record: exitRecord,
              command_line: t.commandLine ?? null,
              // Internal hand-off for enforceBudget below.
              __billed: snap.billedTokens,
              __cached: snap.cachedTokens,
            };
          })
        );

        const totalCost = snapshots.reduce((sum, s: any) => sum + (s.cost_usd ?? 0), 0);

        // v0.5.2: orphan detection — dispatched > 60s ago without
        // self-registering. Often means the orchestrator used a non-orqlaude
        // spawn tool (e.g. host's Agent) and the Agnet skipped checkin.
        const ORPHAN_THRESHOLD_MS = 60_000;
        const orphans = plan0.tasks
          .filter(
            (t) =>
              t.status === "dispatched" &&
              !t.spawnedSessionId &&
              t.startedAt &&
              Date.now() - t.startedAt > ORPHAN_THRESHOLD_MS
          )
          .map((t) => ({
            task_id: t.id,
            title: t.title,
            agnet: t.agnetName ? `Agnet ${t.agnetName}` : "Agnet",
            dispatched_ago_sec: Math.round((Date.now() - (t.startedAt ?? 0)) / 1000),
            likely_cause:
              "Spawned via host Agent tool (or chip not clicked). The Agnet didn't call checkin. Either (a) it never started, (b) it bypassed the orqlaude protocol footer, or (c) it spawned but completed too fast to register.",
            remedy:
              "If you can identify its session id via mcp__ccd_session_mgmt__list_sessions, call register_spawn manually. Otherwise the task is invisible to orqlaude until a follow-up checkin arrives.",
          }));

        // ---- budget enforcement: kill on overbudget --------------------------
        // v0.9.2: shared helper, billed-vs-total aware. The helper picks
        // billed (input + output, default) or total (all four buckets)
        // based on `plan.budgetMode`.
        const budget = await enforceBudget(
          store,
          plan_id,
          snapshots.map((s: any) => ({
            billed: s.__billed ?? 0,
            cached: s.__cached ?? 0,
          }))
        );
        // Strip the internal hand-off keys so they don't leak into the
        // public response.
        for (const s of snapshots as any[]) {
          delete s.__billed;
          delete s.__cached;
        }
        const totalTokens = budget.total_all; // for the legacy field
        const autoCancelled = budget.auto_cancelled;

        // ---- aggregated hallucination warning -------------------------------
        const concerningAgents = snapshots
          .filter((s: any) => s.hallucination && s.hallucination.score >= 0.3)
          .map((s: any) => ({ task_id: s.task_id, title: s.title, level: s.hallucination.level, concerns: s.hallucination.concerns }));

        // ---- aggregated died-at-launch warning ------------------------------
        const deadAgents = snapshots
          .filter((s: any) => s.status === "died_at_launch")
          .map((s: any) => ({
            task_id: s.task_id,
            title: s.title,
            pid: s.pid,
            stderr_path: s.stderr_path,
            stderr_excerpt: s.stderr_excerpt,
            command_line: s.command_line,
          }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  plan_id,
                  plan_status: autoCancelled ? "cancelled_overbudget" : plan0.status,
                  budget_cap_tokens: budget.budget_cap_tokens,
                  // v0.9.2: legacy field; sum of all four token buckets.
                  // For Plan-cost decisions read `tokens.billed` instead.
                  total_tokens_used: totalTokens,
                  budget_remaining_tokens: budget.budget_remaining_tokens,
                  total_cost_usd: totalCost,
                  // v0.9.2: explicit token breakdown so orchestrators can
                  // distinguish "cost-relevant" from "cache churn".
                  tokens: {
                    billed: budget.total_billed,
                    cached: budget.total_cached,
                    total: budget.total_all,
                    budget_mode: budget.budget_mode,
                    budget_relevant: budget.total_for_budget,
                    budget_pct: budget.budget_pct,
                  },
                  hallucination_alerts: concerningAgents,
                  orphan_alerts: orphans,
                  died_at_launch_alerts: deadAgents,
                  agents: snapshots,
                  next_step:
                    deadAgents.length > 0
                      ? `${deadAgents.length} Agnet(s) died at launch — claude -p exited before writing any JSONL. Each entry has a stderr_excerpt + command_line for debugging. Common causes: auth not configured (run \`claude auth login\`), malformed --mcp-config, or the prompt parsed as a subcommand name.`
                      : orphans.length > 0
                      ? `${orphans.length} Agnet(s) appear orphaned — dispatched > 60s without self-registering via checkin. Likely cause: spawn used host Agent tool instead of mcp__ccd_session__spawn_task. Check orphan_alerts[].remedy.`
                      : concerningAgents.length > 0
                      ? "One or more agents show hallucination signs. Consider `send_message` to nudge, or `kill_task` if the agent is irrecoverable."
                      : autoCancelled
                      ? "Fleet auto-cancelled (overbudget). STOP messages queued to all running children."
                      : undefined,
                },
                null,
                2
              ),
            },
          ],
        };
      },
      ({ plan_id }) => ({ planId: plan_id })
    )
  );

  // ---- wait_for_status_change (long-poll) ----------------------------------
  // v0.9.0: replaces the orchestrator's polling-loop pattern. Blocks for up
  // to `timeout_sec` (default 60s) until ANY task in the plan transitions
  // state, finishes, opens a PR, dies at launch, or chews through a
  // material slice of its token budget. Cheap internal poll (every 2s
  // file-stat + tiny snapshot read), but holds the connection open so the
  // primary Claude can sleep without waking up to call status() every 90s.
  server.tool(
    "wait_for_status_change",
    "Long-poll: blocks up to `timeout_sec` (default 45, max 45 in v0.10.6+) and returns as soon as the fleet state changes (task transition, new PR url, exit-record, +1 KB token delta) - OR returns the unchanged state when the timeout elapses. Use this INSTEAD of ScheduleWakeup + status() polling: pass the `fingerprint` from the prior response as `since_fingerprint` and the call returns the moment something useful happens. Loop pattern: while (!terminal(result)) result = wait_for_status_change(plan_id, result.fingerprint). v0.9.0+. v0.10.6: capped at 45s to stay under MCP client default timeout (60s); when not all tasks have terminated, just call again with same fingerprint — each call wakes within ~2s of any actual event.",
    {
      plan_id: z.string(),
      since_fingerprint: z.string().optional().describe("The `fingerprint` field from the prior wait_for_status_change (or status) response. Omit on first call - the server returns immediately with the current snapshot + the fresh fingerprint to thread through subsequent calls."),
      timeout_sec: z.number().int().positive().max(45).default(45).describe("Max seconds the call blocks before returning the unchanged state. Default 45, cap 45 (v0.10.6: bounded to stay under MCP client's 60s default per-request timeout). Loop the tool to extend the wait."),
    },
    audit.wrap(
      "wait_for_status_change",
      async ({ plan_id, since_fingerprint, timeout_sec }) => {
        const cwd = process.cwd();
        const POLL_INTERVAL_MS = 2_000;
        const deadline = Date.now() + timeout_sec * 1000;

        const buildSnapshot = async () => {
          const plan = await store.read((state) => findPlan(state, plan_id));
          const agents = await Promise.all(
            plan.tasks.map(async (t) => {
              if (!t.spawnedSessionId) {
                return {
                  task_id: t.id,
                  title: t.title,
                  status: t.status,
                  tokens_used: 0,
                  billed_tokens: 0,
                  cached_tokens: 0,
                  pr_url: t.prUrl ?? null,
                  pid_alive: null as boolean | null,
                  exit_record: null as Awaited<ReturnType<typeof readChildExitRecord>>,
                  terminated: false,
                  stop_kind: t.stopRequested?.kind ?? null,
                };
              }
              const snap = await snapshotSession(cwd, t.spawnedSessionId, t.stdoutPath);
              const exitRecord = t.exitJsonPath ? await readChildExitRecord(t.exitJsonPath) : null;
              return {
                task_id: t.id,
                title: t.title,
                status: exitRecord ? (exitRecord.success ? "done" : "failed") : t.status,
                tokens_used: snap.totalEffectiveTokens,
                billed_tokens: snap.billedTokens,
                cached_tokens: snap.cachedTokens,
                pr_url: t.prUrl ?? null,
                pid_alive: t.pid ? isProcessAlive(t.pid) : null,
                exit_record: exitRecord,
                terminated: snap.terminated || !!exitRecord,
                stop_kind: t.stopRequested?.kind ?? null,
              };
            })
          );
          // v0.9.2: enforce budget on every poll, not just from status().
          // The plan-level kill needs to fire whether the orchestrator is
          // calling status() or wait_for_status_change.
          const budget = await enforceBudget(
            store,
            plan_id,
            agents.map((a) => ({ billed: a.billed_tokens, cached: a.cached_tokens }))
          );
          return {
            plan_id,
            plan_status: budget.auto_cancelled ? "cancelled_overbudget" : plan.status,
            agents,
            budget,
          };
        };

        const computeFingerprint = (snap: Awaited<ReturnType<typeof buildSnapshot>>): string => {
          // v0.9.1: hash-safe encoding via JSON.stringify. The previous
          // pipe-joined / colon-separated form was fragile if a task_id or
          // pr_url ever contained a `|` or `:` (today both are sanitized
          // UUIDs / GitHub URLs, but pinning the structure costs nothing).
          // Also includes `stop_kind` so kill_task / request_stop transitions
          // wake the long-poll without waiting for the child to actually
          // terminate - useful when a soft-stop is in flight.
          // v0.9.2: bucket runs off `billed_tokens` (input + output) so
          // cache-read churn doesn't trip the fingerprint every 2s. The
          // long-poll now fires only when something cost-relevant moves.
          // v0.10.9: bucket is /256 not /1024. The kb-bucket was too coarse
          // for the early-mid of an agent's lifecycle - an agent at 1300
          // billed could climb to 1999 across multiple poll windows
          // without tripping any fingerprint change (kb=1 the whole way),
          // so the orchestrator saw "no change" for minutes despite real
          // progress. /256 still ignores the cache-read noise but wakes
          // the long-poll roughly 4x more often during meaningful growth.
          const parts: Array<unknown> = [snap.plan_status];
          for (const a of snap.agents) {
            const bucket = Math.floor(a.billed_tokens / 256);
            parts.push([
              a.task_id,
              a.status,
              a.pr_url ?? null,
              bucket,
              a.exit_record
                ? { code: a.exit_record.exit_code, sig: a.exit_record.signal }
                : null,
              a.terminated,
              a.pid_alive,
              a.stop_kind,
            ]);
          }
          return JSON.stringify(parts);
        };

        // First read - if no fingerprint, return immediately with the
        // current state (still useful as a fresh dispatch).
        let snapshot = await buildSnapshot();
        let fingerprint = computeFingerprint(snapshot);
        if (!since_fingerprint || fingerprint !== since_fingerprint) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ...snapshot,
                    fingerprint,
                    changed: !!since_fingerprint,
                    elapsed_sec: 0,
                    timed_out: false,
                    next_step:
                      "Call wait_for_status_change again with this `fingerprint` as `since_fingerprint` to block until the next transition.",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Poll loop until fingerprint changes or deadline hits.
        const startedAt = Date.now();
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          snapshot = await buildSnapshot();
          fingerprint = computeFingerprint(snapshot);
          if (fingerprint !== since_fingerprint) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      ...snapshot,
                      fingerprint,
                      changed: true,
                      elapsed_sec: Math.round((Date.now() - startedAt) / 1000),
                      timed_out: false,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        }
        // Timeout - return unchanged state.
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ...snapshot,
                  fingerprint,
                  changed: false,
                  elapsed_sec: Math.round((Date.now() - startedAt) / 1000),
                  timed_out: true,
                  next_step:
                    "Nothing changed during the wait window. Call wait_for_status_change again with the same `since_fingerprint` to keep waiting, OR call status() for a deeper read.",
                },
                null,
                2
              ),
            },
          ],
        };
      },
      ({ plan_id }) => ({ planId: plan_id })
    )
  );

  // ---- collect --------------------------------------------------------------
  server.tool(
    "collect",
    "Final result aggregation: per-task summary, PR URLs, total tokens+cost, exit reasons. Call once all agents have terminated. The result includes a `ready_for_review` flag suggesting you call `review_prs` (when available) to spawn reviewers.",
    { plan_id: z.string() },
    audit.wrap(
      "collect",
      async ({ plan_id }) => {
        const plan = await store.update((state) => {
          const p = findPlan(state, plan_id);
          const allDone = p.tasks.every((t) => t.status === "done" || t.status === "failed" || t.status === "cancelled");
          if (allDone && p.status !== "collected") p.status = "collected";
          return p;
        });
        const cwd = process.cwd();
        const results = await Promise.all(
          plan.tasks.map(async (t) => {
            const snap = t.spawnedSessionId
              ? await snapshotSession(cwd, t.spawnedSessionId, t.stdoutPath)
              : null;
            return {
              task_id: t.id,
              title: t.title,
              status: t.status,
              session_id: t.spawnedSessionId ?? null,
              pr_url: t.prUrl ?? null,
              tokens_used: snap?.totalEffectiveTokens ?? 0,
              cost_usd: snap?.totalCostUsd ?? t.costUsd ?? 0,
              summary: t.summary ?? snap?.lastAssistantText?.slice(0, 300) ?? null,
              exit_reason: t.exitReason ?? snap?.terminationReason ?? null,
            };
          })
        );
        const totalTokens = results.reduce((s, r) => s + r.tokens_used, 0);
        const totalCost = results.reduce((s, r) => s + r.cost_usd, 0);
        const withPr = results.filter((r) => r.pr_url);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  plan_id,
                  plan_status: plan.status,
                  root_task: plan.rootTask,
                  total_tokens_used: totalTokens,
                  total_cost_usd: totalCost,
                  ready_for_review: withPr.length > 0,
                  pr_count: withPr.length,
                  results,
                  next_step:
                    withPr.length > 0
                      ? "Consider calling `review_prs(plan_id)` to spawn reviewer agents for each PR."
                      : "No PRs opened yet — wait for agents to post their PR URLs via post_note.",
                },
                null,
                2
              ),
            },
          ],
        };
      },
      ({ plan_id }) => ({ planId: plan_id })
    )
  );

  // ---- fleet_summary (v0.9.0 dashboard, one-tool aggregation) --------------
  // Single-call replacement for ping + status + list_plans + telegram probe.
  // Use this at the START of a fresh session ("what's in flight?") and any
  // time you want a wide view of every active plan without making 4 round
  // trips. Returns:
  //   - server health (version, cwd, state dir, telegram status)
  //   - per-plan rollup (counts of pending/running/done/failed, PR list)
  //   - cross-plan totals (active Agnets, total tokens spent today)
  server.tool(
    "fleet_summary",
    "Single-call dashboard for the entire orqlaude state. Returns server health + per-plan rollup + cross-plan totals. Use at session start to discover in-flight fleets; use mid-fleet for a wide view without ping + status + list_plans round-trips. v0.9.0+.",
    {},
    audit.wrap(
      "fleet_summary",
      async () => {
        const cwd = process.cwd();
        const stateDir = resolveStateDir().path;
        const tg = await probeTelegramStatus(stateDir);
        const { plans, orphanNotificationCount, orphanResponseCount } = await store.read((s) => ({
          plans: Object.values(s.plans),
          orphanNotificationCount: (s.orphanNotifications ?? []).length,
          orphanResponseCount: (s.orphanResponseRequests ?? []).length,
        }));
        const planRollups = await Promise.all(
          plans.map(async (p) => {
            // Fast per-task counts WITHOUT the full snapshotSession read.
            const counts = { pending: 0, dispatched: 0, running: 0, done: 0, failed: 0, cancelled: 0, died_at_launch: 0 } as Record<string, number>;
            const prs: string[] = [];
            // v0.9.1: parallelize the per-task snapshot reads. The first
            // post-restart call is O(plans × tasks) IO; the inner Promise.all
            // makes the per-plan inner loop concurrent. Cache makes
            // subsequent calls cheap regardless.
            for (const t of p.tasks) {
              const status = t.status ?? "pending";
              counts[status] = (counts[status] ?? 0) + 1;
              if (t.prUrl) prs.push(t.prUrl);
            }
            const taskTokens = await Promise.all(
              p.tasks.map(async (t) => {
                if (!t.spawnedSessionId) return { billed: 0, cached: 0, total: 0 };
                const snap = await snapshotSession(cwd, t.spawnedSessionId, t.stdoutPath);
                return {
                  billed: snap.billedTokens,
                  cached: snap.cachedTokens,
                  total: snap.totalEffectiveTokens,
                };
              })
            );
            const tokensBilled = taskTokens.reduce((s, v) => s + v.billed, 0);
            const tokensCached = taskTokens.reduce((s, v) => s + v.cached, 0);
            const tokensTotal = taskTokens.reduce((s, v) => s + v.total, 0);
            // v0.9.2: budget_pct reflects the plan's chosen mode (billed
            // default). Plan users see the cost-relevant pct, not the
            // cache-inflated total.
            const mode: BudgetMode = p.budgetMode ?? "billed";
            const tokensForBudget = mode === "billed" ? tokensBilled : tokensTotal;
            const allDone = p.tasks.length > 0 && p.tasks.every((t) => t.status === "done" || t.status === "failed" || t.status === "cancelled");
            return {
              plan_id: p.id,
              status: p.status,
              created_at: p.createdAt,
              root_task: p.rootTask.slice(0, 120),
              task_count: p.tasks.length,
              task_status_counts: counts,
              tokens_used: tokensTotal, // legacy field (sum of all four buckets)
              tokens: {
                billed: tokensBilled,
                cached: tokensCached,
                total: tokensTotal,
                budget_mode: mode,
                budget_relevant: tokensForBudget,
              },
              budget_cap_tokens: p.budgetCapTokens,
              budget_pct: p.budgetCapTokens ? Math.round((tokensForBudget / p.budgetCapTokens) * 100) : 0,
              prs,
              all_terminal: allDone,
              suggested_next:
                p.status === "draft"
                  ? "request_approval + confirm"
                  : counts.pending > 0
                  ? "spawn_via_cli (per-task) or next_task"
                  : counts.running + counts.dispatched > 0
                  ? "wait_for_status_change"
                  : allDone
                  ? "collect + cleanup_worktrees"
                  : "status",
            };
          })
        );
        const activeAgnets = planRollups.reduce(
          (sum, r) => sum + (r.task_status_counts.running ?? 0) + (r.task_status_counts.dispatched ?? 0),
          0
        );
        const grandTokens = planRollups.reduce((sum, r) => sum + r.tokens_used, 0);
        const grandBilled = planRollups.reduce((sum, r) => sum + r.tokens.billed, 0);
        const grandCached = planRollups.reduce((sum, r) => sum + r.tokens.cached, 0);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  server: { version: VERSION, cwd, state_dir: stateDir },
                  telegram: tg,
                  plans: planRollups.sort((a, b) => b.created_at - a.created_at),
                  totals: {
                    plan_count: plans.length,
                    active_agnets: activeAgnets,
                    grand_total_tokens: grandTokens, // legacy: sum of all buckets
                    grand_billed_tokens: grandBilled, // v0.9.2: input + output only
                    grand_cached_tokens: grandCached, // v0.9.2: cache reads + creations
                  },
                  orphan_queue: {
                    notifications: orphanNotificationCount,
                    response_requests: orphanResponseCount,
                  },
                  next_step:
                    activeAgnets > 0
                      ? `${activeAgnets} Agnet(s) actively running. Call wait_for_status_change(<plan_id>) to block until any transitions.`
                      : planRollups.some((r) => r.status === "draft")
                      ? "One or more plans are draft - confirm or cancel."
                      : planRollups.some((r) => r.all_terminal && r.status !== "collected")
                      ? "All Agnets on at least one plan are terminal. Call collect + cleanup_worktrees."
                      : "Idle.",
                },
                null,
                2
              ),
            },
          ],
        };
      },
      () => ({})
    )
  );
}

function buildSpawnPrompt(
  planId: string,
  taskId: string,
  userPrompt: string,
  branchHint?: string,
  /**
   * v0.10.5+: when orqlaude spawns via spawn_via_cli, it pre-allocates a
   * session_id and embeds it here so the agent checkins with the exact
   * value orqlaude expects. The agent's $CLAUDE_CODE_SESSION_ID env var
   * is set by Claude Code itself and may NOT match the --session-id flag
   * orqlaude passed; before v0.10.5 the protocol told agents to use the
   * env var which led to checkin conflicts.
   */
  sessionId?: string
): string {
  const branchSection = branchHint ? `\n\nSuggested branch: \`${branchHint}\`.` : "";
  const sessionIdLine = sessionId
    ? `     • session_id: ${sessionId}  (EXACT value, pre-allocated by orqlaude — use this, NOT $CLAUDE_CODE_SESSION_ID)`
    : `     • session_id: your own session id (from $CLAUDE_CODE_SESSION_ID env, or the orqlaude-allocated id if visible)`;
  return `${userPrompt}${branchSection}

═══════════════════════════════════════════════════════════════
ORQLAUDE FLEET PROTOCOL — READ BEFORE DOING ANYTHING ELSE
═══════════════════════════════════════════════════════════════
plan_id: ${planId}
task_id: ${taskId}${sessionId ? `\nsession_id: ${sessionId}` : ""}

▶ STEP 1 — REGISTER YOURSELF (REQUIRED, IMMEDIATELY)
   Your FIRST tool call MUST be \`mcp__orqlaude__checkin\` with:
${sessionIdLine}
     • task_id:    ${taskId}  (from this prompt)

   If you skip this, the orchestrator can't see you, your work is
   invisible in status(), and any STOP / kill signals will go
   undelivered. You will be classified as an ORPHAN Agnet within 60s.

   If \`mcp__orqlaude__checkin\` is not available as a tool, run:
     ToolSearch  query: "select:mcp__orqlaude__checkin"
   and try again. If that still fails, orqlaude isn't loaded in your
   .mcp.json — STOP and tell the orchestrator before doing any work.

▶ STEP 2 — DO THE WORK
   Complete the task above. Read before editing. Run tests before committing.

▶ STEP 3 — PERIODIC CHECK-INS
   Call \`mcp__orqlaude__checkin\` every few turns. Pulls queued
   messages from the orchestrator. If you receive a STOP message,
   commit what you have and exit immediately.

▶ STEP 4 — SHARE FINDINGS (OPTIONAL)
   Discovered something other Agnets should know (a removed function,
   a schema change)? Call \`mcp__orqlaude__post_note\` with the finding.
   \`blocking: true\` if it must be ack'd before you continue.

▶ STEP 5 — CLAIM FILES (RECOMMENDED FOR PARALLEL FLEETS)
   Before editing files that others might touch, call
   \`mcp__orqlaude__claim_files\` with the absolute paths. Conflicts
   surface to the orchestrator. ESPECIALLY IMPORTANT if the orchestrator
   spawned you via the host's \`Agent\` tool (no worktree isolation).

▶ STEP 6 — FINISH
   Commit, push, open a PR via \`gh pr create\`, then call
   \`mcp__orqlaude__post_note\` with the PR URL. The orchestrator's
   \`collect\` reads it from there.
═══════════════════════════════════════════════════════════════
`;
}

/**
 * v0.9.2: shared budget-enforcement helper called from both `status()`
 * and `wait_for_status_change`. The latter previously skipped the kill,
 * meaning a fleet over budget would only get cancelled if the orchestrator
 * happened to call status() (not just wait + collect).
 *
 * `agents` are flat token rollups extracted from snapshots; the helper
 * is metric-agnostic and uses whichever bucket matches `plan.budgetMode`
 * (defaults to "billed" - input + output only, ignoring free-on-the-Plan
 * cache reads).
 *
 * Side effect: when over budget, the plan flips to `cancelled_overbudget`
 * and STOP messages are queued for every still-running task. Idempotent -
 * subsequent calls observe the already-cancelled state and return
 * `auto_cancelled: false`.
 */
export interface BudgetSnapshot {
  total_billed: number;
  total_cached: number;
  total_all: number;
  total_for_budget: number;
  budget_mode: BudgetMode;
  budget_cap_tokens: number;
  budget_remaining_tokens: number;
  budget_pct: number;
  overbudget: boolean;
  auto_cancelled: boolean;
}

async function enforceBudget(
  store: StateStore,
  plan_id: string,
  agents: Array<{ billed: number; cached: number }>
): Promise<BudgetSnapshot> {
  const plan0 = await store.read((state) => findPlan(state, plan_id));
  const totalBilled = agents.reduce((s, a) => s + a.billed, 0);
  const totalCached = agents.reduce((s, a) => s + a.cached, 0);
  const totalAll = totalBilled + totalCached;
  const budgetMode: BudgetMode = plan0.budgetMode ?? "billed";
  const totalForBudget = budgetMode === "billed" ? totalBilled : totalAll;
  const cap = plan0.budgetCapTokens;
  const overbudget = totalForBudget > cap;
  const alreadyCancelled =
    plan0.status === "cancelled_overbudget" || plan0.status === "cancelled";
  let autoCancelled = false;

  if (overbudget && !alreadyCancelled) {
    await store.update((state) => {
      const plan = findPlan(state, plan_id);
      // Re-check inside the lock - another concurrent call may have raced us.
      if (plan.status === "cancelled_overbudget" || plan.status === "cancelled") return;
      plan.status = "cancelled_overbudget";
      for (const t of plan.tasks) {
        if (t.spawnedSessionId && !t.stopRequested) {
          t.stopRequested = { reason: "fleet overbudget", requestedAt: Date.now(), kind: "hard" };
          plan.messages.push({
            id: randomUUID(),
            toSessionId: t.spawnedSessionId,
            text:
              `STOP: fleet exceeded token budget (used ${Math.round(totalForBudget / 1000)}k of ` +
              `${Math.round(cap / 1000)}k cap, mode=${budgetMode}). Commit what you have and exit.`,
            queuedAt: Date.now(),
            delivered: false,
            kind: "stop",
          });
        }
      }
    });
    autoCancelled = true;
  }

  return {
    total_billed: totalBilled,
    total_cached: totalCached,
    total_all: totalAll,
    total_for_budget: totalForBudget,
    budget_mode: budgetMode,
    budget_cap_tokens: cap,
    budget_remaining_tokens: Math.max(0, cap - totalForBudget),
    budget_pct: cap > 0 ? Math.round((totalForBudget / cap) * 100) : 0,
    overbudget,
    auto_cancelled: autoCancelled,
  };
}

