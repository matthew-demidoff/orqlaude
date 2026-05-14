import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { StateStore, findPlan, findTask } from "../lib/state.js";
import { snapshotSession } from "../lib/jsonl_tail.js";
import type { AuditLog } from "../lib/audit.js";

/**
 * Lifecycle tools: kill_task, resume_plan, list_plans.
 *
 * `kill_task` queues a STOP broker message and returns the session id ready to
 * pass into `mcp__ccd_session_mgmt__archive_session` if the agent doesn't
 * shut itself down cleanly.
 *
 * `resume_plan` lets the primary Claude pick up an in-progress fleet after a
 * Desktop-app restart or new session — it returns the current state plus a
 * prescriptive "do this next" hint.
 *
 * `list_plans` returns a short summary of every plan in this project's state
 * file (active first), so a fresh session can find what's in flight.
 */

export function registerLifecycle(server: McpServer, store: StateStore, audit: AuditLog): void {
  // ---- kill_task (HARD STOP) ----------------------------------------------
  server.tool(
    "kill_task",
    "HARD STOP a running task. Queues a STOP broker message saying 'commit what you have and exit immediately', and returns the session id ready for `mcp__ccd_session_mgmt__archive_session` if the agent doesn't comply within ~30s. Use this when an agent is hallucinating, looping, or otherwise off the rails. For a polite 'we don't need this anymore, please wind down' alternative, use `request_stop`.",
    {
      plan_id: z.string(),
      task_id: z.string(),
      reason: z.string().describe("Why you're killing this task. Surfaced to the agent and stored in audit log."),
    },
    audit.wrap(
      "kill_task",
      async ({ plan_id, task_id, reason }) => {
        const result = await store.update((state) => {
          const plan = findPlan(state, plan_id);
          const task = findTask(plan, task_id);
          if (!task.spawnedSessionId) {
            task.status = "cancelled";
            return { plan_id, task_id, status: "cancelled_before_spawn", session_id: null };
          }
          task.stopRequested = { reason, requestedAt: Date.now(), kind: "hard" };
          plan.messages.push({
            id: randomUUID(),
            toSessionId: task.spawnedSessionId,
            text: `STOP: ${reason}. Commit what you have and exit.`,
            queuedAt: Date.now(),
            delivered: false,
            kind: "stop",
          });
          return {
            plan_id,
            task_id,
            session_id: task.spawnedSessionId,
            queued_stop: true,
            next_step:
              "Wait ~30s for the agent to acknowledge via checkin. If it doesn't terminate cleanly, call `mcp__ccd_session_mgmt__archive_session` with the session_id above.",
          };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      ({ plan_id, task_id }) => ({ planId: plan_id })
    )
  );

  // ---- request_stop (SOFT, POLITE) ----------------------------------------
  server.tool(
    "request_stop",
    "POLITE SOFT-STOP. Asks the agent to finish what it's currently doing, commit, push, and exit cleanly. Unlike kill_task this doesn't say 'STOP NOW' — it's appropriate when the user has changed their mind mid-fleet or the work is 'good enough' and you don't want to lose progress. The agent receives a soft_stop message on its next checkin.",
    {
      plan_id: z.string(),
      task_id: z.string(),
      reason: z.string().describe("Why you're winding down. Shown to the agent so it can decide what 'finish what you're doing' means."),
    },
    audit.wrap(
      "request_stop",
      async ({ plan_id, task_id, reason }) => {
        const result = await store.update((state) => {
          const plan = findPlan(state, plan_id);
          const task = findTask(plan, task_id);
          if (!task.spawnedSessionId) {
            task.status = "cancelled";
            return { plan_id, task_id, status: "cancelled_before_spawn", session_id: null };
          }
          task.stopRequested = { reason, requestedAt: Date.now(), kind: "soft" };
          plan.messages.push({
            id: randomUUID(),
            toSessionId: task.spawnedSessionId,
            text: `Soft stop requested by orchestrator: ${reason}. Please finish the current operation, commit what you have, push, open a PR, then exit. Don't start any new substantive work.`,
            queuedAt: Date.now(),
            delivered: false,
            kind: "soft_stop",
          });
          return {
            plan_id,
            task_id,
            session_id: task.spawnedSessionId,
            queued_soft_stop: true,
            next_step:
              "Poll status() periodically. The agent should terminate cleanly within a few turns. If it ignores the soft-stop or you change your mind toward hard cancel, use kill_task.",
          };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      ({ plan_id, task_id }) => ({ planId: plan_id })
    )
  );

  // ---- resume_plan ----------------------------------------------------------
  server.tool(
    "resume_plan",
    "Resume monitoring of an in-flight plan after a Desktop-app restart or new primary-Claude session. Returns plan state, per-task status (refreshed from JSONL), and a 'do this next' hint. Use when you spot a plan in `list_plans` and the user wants to continue.",
    { plan_id: z.string() },
    audit.wrap(
      "resume_plan",
      async ({ plan_id }) => {
        const plan = await store.read((state) => findPlan(state, plan_id));
        const cwd = process.cwd();
        const tasks = await Promise.all(
          plan.tasks.map(async (t) => {
            const snap = t.spawnedSessionId ? await snapshotSession(cwd, t.spawnedSessionId) : null;
            return {
              task_id: t.id,
              title: t.title,
              status: snap?.terminated ? "done" : t.status,
              session_id: t.spawnedSessionId ?? null,
              tokens_used: snap?.totalEffectiveTokens ?? 0,
              cost_usd: snap?.totalCostUsd ?? 0,
              pr_url: t.prUrl ?? null,
              terminated: snap?.terminated ?? false,
            };
          })
        );
        const pending = tasks.filter((t) => t.status === "pending");
        const running = tasks.filter((t) => t.status === "running" || t.status === "dispatched");
        const done = tasks.filter((t) => t.status === "done" || t.status === "failed" || t.status === "cancelled");
        const nextStep =
          plan.status === "awaiting_approval"
            ? "Plan is awaiting user approval — call request_approval again to regenerate the prompt, then confirm."
            : pending.length > 0
            ? `Plan has ${pending.length} pending task(s). Call \`next_task\` to dispatch the next one.`
            : running.length > 0
            ? `${running.length} agent(s) still running. Poll \`status\` and \`poll_notes\` periodically.`
            : done.length === plan.tasks.length
            ? "All agents have terminated. Call `collect` for final results, then `review_prs` if available."
            : "Inspect via `status`.";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  plan_id,
                  root_task: plan.rootTask,
                  status: plan.status,
                  created_at: plan.createdAt,
                  approved_at: plan.approvedAt ?? null,
                  budget_cap_tokens: plan.budgetCapTokens,
                  tasks,
                  pending_count: pending.length,
                  running_count: running.length,
                  done_count: done.length,
                  next_step: nextStep,
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

  // ---- list_plans -----------------------------------------------------------
  server.tool(
    "list_plans",
    "List every plan known to orqlaude in this project. Active plans first. Useful at the start of a fresh session to see what's in flight.",
    {
      include_collected: z.boolean().default(false).describe("Include plans whose status is `collected` (finished and reviewed)."),
    },
    audit.wrap(
      "list_plans",
      async ({ include_collected }) => {
        const plans = await store.read((state) => {
          return Object.values(state.plans)
            .filter((p) => include_collected || p.status !== "collected")
            .map((p) => ({
              plan_id: p.id,
              root_task: p.rootTask,
              status: p.status,
              created_at: p.createdAt,
              task_count: p.tasks.length,
              tasks_done: p.tasks.filter((t) => t.status === "done").length,
              tasks_running: p.tasks.filter((t) => t.status === "running" || t.status === "dispatched").length,
              budget_cap_tokens: p.budgetCapTokens,
              // Dedup union of all task scopes — useful for "which plan owns
              // this file" lookups without a status() round-trip.
              expected_files: Array.from(new Set(p.tasks.flatMap((t) => t.scope ?? []))),
            }))
            .sort((a, b) => b.created_at - a.created_at);
        });
        return { content: [{ type: "text", text: JSON.stringify({ plans }, null, 2) }] };
      },
      () => ({})
    )
  );
}
