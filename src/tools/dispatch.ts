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
    "Return the next pending task to dispatch, or null if all tasks have been spawned. The returned prompt embeds the task_id and instructs the agent to self-register via `checkin` on its first turn — so register_spawn is usually unnecessary.",
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
          return {
            plan_id,
            task: {
              task_id: next.id,
              title: next.title,
              prompt: buildSpawnPrompt(plan.id, next.id, next.prompt, next.branchHint),
              tldr: next.tldr,
              scope: next.scope ?? [],
            },
            next_step:
              "Call `mcp__ccd_session__spawn_task` with this title/prompt/tldr. The spawned agent will self-register via checkin on its first turn — usually no manual register_spawn needed.",
          };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      ({ plan_id }) => ({ planId: plan_id })
    )
  );

  // ---- register_spawn (manual fallback) ------------------------------------
  server.tool(
    "register_spawn",
    "Manually register a spawn (fallback). Normally the spawned agent self-registers on first checkin; only call this if a child fails to do so within ~30s.",
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
            return {
              task_id: t.id,
              title: t.title,
              status: snap.terminated ? "done" : t.status,
              session_id: t.spawnedSessionId,
              tokens_used: snap.totalEffectiveTokens,
              cost_usd: snap.totalCostUsd,
              last_event_type: snap.lastEventType,
              last_activity_at: snap.lastActivityAt,
              last_assistant_preview: snap.lastAssistantText?.slice(0, 200) ?? null,
              current_tool: snap.lastToolUse?.name ?? null,
              terminated: snap.terminated,
              termination_reason: snap.terminationReason,
              hallucination: { score: hallu.score, level: hallu.level, concerns: hallu.concerns },
              stop_requested: t.stopRequested ?? null,
            };
          })
        );

        const totalTokens = snapshots.reduce((sum, s: any) => sum + (s.tokens_used ?? 0), 0);
        const totalCost = snapshots.reduce((sum, s: any) => sum + (s.cost_usd ?? 0), 0);

        // ---- budget enforcement: kill on overbudget --------------------------
        const overbudget = totalTokens > plan0.budgetCapTokens;
        let autoCancelled = false;
        if (overbudget && plan0.status !== "cancelled_overbudget" && plan0.status !== "cancelled") {
          await store.update((state) => {
            const plan = findPlan(state, plan_id);
            plan.status = "cancelled_overbudget";
            for (const t of plan.tasks) {
              if (t.spawnedSessionId && !t.stopRequested) {
                t.stopRequested = { reason: "fleet overbudget", requestedAt: Date.now() };
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
                  agents: snapshots,
                  next_step: concerningAgents.length > 0
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

---

ORQLAUDE FLEET PROTOCOL
plan_id: ${planId}
task_id: ${taskId}

Step 1 — register yourself.
Your FIRST action must be to call \`mcp__orqlaude__checkin\` with your session id (from $CLAUDE_CODE_SESSION_ID) AND the task_id above. This claims your task and lets the orchestrator track you.

Step 2 — do the work.
Complete the task above. Read before editing. Run tests before committing.

Step 3 — periodic check-ins.
Call \`mcp__orqlaude__checkin\` every few turns to pull any directed messages from the orchestrator (the primary Claude). If you receive a STOP message, commit what you have and exit immediately.

Step 4 — share findings (optional).
If you discover something other agents should know (a removed function, a schema change), call \`mcp__orqlaude__post_note\` with the finding. Set \`blocking: true\` if it must be ack'd before you continue.

Step 5 — claim files (optional, recommended).
Before editing files that others might touch, call \`mcp__orqlaude__claim_files\` with the absolute paths. Conflicts surface to the orchestrator.

Step 6 — finish.
When done, commit, push, open a PR via \`gh pr create\`, then call \`mcp__orqlaude__post_note\` with the PR URL. The orchestrator's \`collect\` reads it from there.
`;
}

function cryptoRandomId(): string {
  // small helper to avoid importing crypto in this top-of-file scope twice
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
