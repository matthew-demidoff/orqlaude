import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StateStore, findPlan, findTask } from "../lib/state.js";
import { jsonlPathFor, snapshotSession } from "../lib/jsonl_tail.js";
import { detectHallucination, extractToolUses } from "../lib/hallucination.js";
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
                tool: "mcp__ccd_session__spawn_task",
                preferred: true,
                isolation: "worktree",
                visibility: "Desktop Code sidebar (each Agnet has its own session)",
                note: "Recommended. Creates an isolated git worktree session. The Agnet self-registers via checkin on its first turn.",
                load_if_missing: "ToolSearch query: 'select:mcp__ccd_session__spawn_task'.",
                args: {
                  title: next.title,
                  prompt: spawnPrompt,
                  tldr: next.tldr,
                },
              },
              {
                priority: 2,
                tool: "Agent (host built-in)",
                isolation: "none (shares parent cwd + filesystem)",
                visibility: "in-session tool use only — no Desktop session",
                note: "Fallback. Faster (no chip click) but loses worktree isolation. Concurrent Agnets WILL race on shared files unless they call claim_files aggressively. Self-registration via checkin still works, but the Agnet runs as a sub-call of YOUR session — when it returns, the broker connection ends.",
                warning: "By choosing this, you accept that parallel file edits between Agnets may collide. claim_files in the broker is your only conflict-detection signal.",
                args: {
                  subagent_type: "general-purpose",
                  description: next.title.slice(0, 60),
                  prompt: spawnPrompt,
                },
              },
              {
                priority: 3,
                tool: "shell: claude -p (headless)",
                isolation: "explicit worktree via --worktree flag",
                visibility: "JSONL only — won't appear in Desktop sidebar until app restart",
                note: "CLI fallback for non-Desktop hosts. Spawn via Bash: `claude -p '<prompt>' --worktree fleet-<short_id> --session-id <new-uuid> --output-format stream-json`. The Agnet self-registers via checkin if orqlaude is in the worktree's .mcp.json.",
                args: {
                  command_template:
                    "claude -p '<PROMPT>' --worktree fleet-" +
                    next.id.slice(0, 8) +
                    " --output-format stream-json --permission-mode bypassPermissions",
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
            const snap = await snapshotSession(cwd, t.spawnedSessionId);
            const toolUses = await extractToolUses(jsonlPathFor(cwd, t.spawnedSessionId));
            const hallu = await detectHallucination(toolUses, cwd);
            // Per-task soft budget warning: if the task has a budgetHintTokens
            // hint and we've blown past 70% of it, surface a yellow flag so the
            // orchestrator can intervene before the plan-wide hard cap fires.
            const taskWarnings: string[] = [];
            if (t.budgetHintTokens && snap.totalEffectiveTokens > 0.7 * t.budgetHintTokens) {
              const pct = Math.round((snap.totalEffectiveTokens / t.budgetHintTokens) * 100);
              taskWarnings.push(
                `task at ${pct}% of hint (${snap.totalEffectiveTokens.toLocaleString()} / ${t.budgetHintTokens.toLocaleString()} tokens). Consider request_stop if it's stalling.`
              );
            }
            return {
              task_id: t.id,
              title: t.title,
              status: snap.terminated ? "done" : t.status,
              session_id: t.spawnedSessionId,
              tokens_used: snap.totalEffectiveTokens,
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
            };
          })
        );

        const totalTokens = snapshots.reduce((sum, s: any) => sum + (s.tokens_used ?? 0), 0);
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
        const overbudget = totalTokens > plan0.budgetCapTokens;
        let autoCancelled = false;
        if (overbudget && plan0.status !== "cancelled_overbudget" && plan0.status !== "cancelled") {
          await store.update((state) => {
            const plan = findPlan(state, plan_id);
            plan.status = "cancelled_overbudget";
            for (const t of plan.tasks) {
              if (t.spawnedSessionId && !t.stopRequested) {
                t.stopRequested = { reason: "fleet overbudget", requestedAt: Date.now(), kind: "hard" };
                plan.messages.push({
                  id: cryptoRandomId(),
                  toSessionId: t.spawnedSessionId,
                  text: `STOP: fleet exceeded token budget (used ${Math.round(totalTokens / 1000)}k of ${Math.round(
                    plan.budgetCapTokens / 1000
                  )}k cap). Commit what you have and exit.`,
                  queuedAt: Date.now(),
                  delivered: false,
                  kind: "stop",
                });
              }
            }
          });
          autoCancelled = true;
        }

        // ---- aggregated hallucination warning -------------------------------
        const concerningAgents = snapshots
          .filter((s: any) => s.hallucination && s.hallucination.score >= 0.3)
          .map((s: any) => ({ task_id: s.task_id, title: s.title, level: s.hallucination.level, concerns: s.hallucination.concerns }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  plan_id,
                  plan_status: autoCancelled ? "cancelled_overbudget" : plan0.status,
                  budget_cap_tokens: plan0.budgetCapTokens,
                  total_tokens_used: totalTokens,
                  budget_remaining_tokens: Math.max(0, plan0.budgetCapTokens - totalTokens),
                  total_cost_usd: totalCost,
                  hallucination_alerts: concerningAgents,
                  orphan_alerts: orphans,
                  agents: snapshots,
                  next_step:
                    orphans.length > 0
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
            const snap = t.spawnedSessionId ? await snapshotSession(cwd, t.spawnedSessionId) : null;
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
}

function buildSpawnPrompt(planId: string, taskId: string, userPrompt: string, branchHint?: string): string {
  const branchSection = branchHint ? `\n\nSuggested branch: \`${branchHint}\`.` : "";
  return `${userPrompt}${branchSection}

═══════════════════════════════════════════════════════════════
ORQLAUDE FLEET PROTOCOL — READ BEFORE DOING ANYTHING ELSE
═══════════════════════════════════════════════════════════════
plan_id: ${planId}
task_id: ${taskId}

▶ STEP 1 — REGISTER YOURSELF (REQUIRED, IMMEDIATELY)
   Your FIRST tool call MUST be \`mcp__orqlaude__checkin\` with:
     • session_id: your own session id (from $CLAUDE_CODE_SESSION_ID env)
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

function cryptoRandomId(): string {
  // small helper to avoid importing crypto in this top-of-file scope twice
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
