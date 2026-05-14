import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StateStore, findPlan, findTask } from "../lib/state.js";
import { snapshotSession } from "../lib/jsonl_tail.js";

/**
 * Dispatch-phase tools: next_task, register_spawn, status, collect.
 *
 * After `confirm`, primary Claude pulls one task at a time via `next_task`,
 * calls `mcp__ccd_session__spawn_task` (the Desktop app's native chip-based
 * spawner) with the returned prompt/title/tldr, and reports the resulting
 * session id back via `register_spawn`. Then `status` snapshots progress by
 * tailing the spawned agents' JSONL files.
 */

export function registerDispatch(server: McpServer, store: StateStore): void {
  // ---- next_task ------------------------------------------------------------
  server.tool(
    "next_task",
    "Return the next pending task to dispatch, or null if all tasks have been spawned. The returned object has the exact `title`, `prompt`, and `tldr` to pass to `mcp__ccd_session__spawn_task`. The task is moved to status=`dispatched` so subsequent calls return the next one.",
    {
      plan_id: z.string().describe("Plan id."),
    },
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
          return { plan_id, task: null, message: "No more pending tasks. All spawns dispatched." };
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
            "Call `mcp__ccd_session__spawn_task` with this task's title/prompt/tldr. The user clicks the chip, which creates a new session. Find its session_id from list_sessions or by asking the user, then call `register_spawn(plan_id, task_id, session_id)`.",
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ---- register_spawn -------------------------------------------------------
  server.tool(
    "register_spawn",
    "Tell orqlaude which session_id corresponds to a dispatched task. Call this once the user has clicked the spawn_task chip and the new session is running. Get the session_id from `mcp__ccd_session_mgmt__list_sessions` (most recent matching the task title) or from the user.",
    {
      plan_id: z.string(),
      task_id: z.string(),
      session_id: z.string().describe("The Claude Code CLI session id (UUID, without 'local_' prefix). orqlaude uses this to tail the session's JSONL for status."),
    },
    async ({ plan_id, task_id, session_id }) => {
      const result = await store.update((state) => {
        const plan = findPlan(state, plan_id);
        const task = findTask(plan, task_id);
        task.spawnedSessionId = session_id;
        task.status = "running";
        return { plan_id, task_id, session_id, status: task.status };
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ---- status ---------------------------------------------------------------
  server.tool(
    "status",
    "Snapshot of every tracked task in a plan: current activity, cumulative cost, last assistant message preview, termination state. Reads each spawned session's JSONL file. Call this any time the user asks 'how are my agents doing?' or before deciding whether to send broker messages.",
    {
      plan_id: z.string(),
    },
    async ({ plan_id }) => {
      const plan = await store.read((state) => findPlan(state, plan_id));
      const snapshots = await Promise.all(
        plan.tasks.map(async (t) => {
          if (!t.spawnedSessionId) {
            return {
              task_id: t.id,
              title: t.title,
              status: t.status,
              session_id: null,
              note: "Not yet spawned.",
            };
          }
          const snap = await snapshotSession(process.cwd(), t.spawnedSessionId);
          return {
            task_id: t.id,
            title: t.title,
            status: snap.terminated ? "done" : t.status,
            session_id: t.spawnedSessionId,
            cost_usd: snap.totalCostUsd,
            input_tokens: snap.inputTokens,
            output_tokens: snap.outputTokens,
            last_event_type: snap.lastEventType,
            last_activity_at: snap.lastActivityAt,
            last_assistant_preview: snap.lastAssistantText?.slice(0, 200) ?? null,
            current_tool: snap.lastToolUse?.name ?? null,
            terminated: snap.terminated,
            termination_reason: snap.terminationReason,
          };
        })
      );
      const totalCost = snapshots.reduce((sum, s: any) => sum + (s.cost_usd ?? 0), 0);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                plan_id,
                plan_status: plan.status,
                budget_cap_usd: plan.budgetCapUsd,
                total_cost_usd: totalCost,
                budget_remaining_usd: Math.max(0, plan.budgetCapUsd - totalCost),
                agents: snapshots,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ---- collect --------------------------------------------------------------
  server.tool(
    "collect",
    "Final result aggregation: returns per-task summary, PR URLs (if the agent reported one via post_note), total cost, and exit reasons. Call this once all agents have terminated (or you want a snapshot of what's done so far).",
    {
      plan_id: z.string(),
    },
    async ({ plan_id }) => {
      const plan = await store.update((state) => {
        const p = findPlan(state, plan_id);
        const allDone = p.tasks.every((t) => t.status === "done" || t.status === "failed" || t.status === "cancelled");
        if (allDone && p.status !== "collected") p.status = "collected";
        return p;
      });
      const results = await Promise.all(
        plan.tasks.map(async (t) => {
          const snap = t.spawnedSessionId ? await snapshotSession(process.cwd(), t.spawnedSessionId) : null;
          return {
            task_id: t.id,
            title: t.title,
            status: t.status,
            session_id: t.spawnedSessionId ?? null,
            pr_url: t.prUrl ?? null,
            cost_usd: snap?.totalCostUsd ?? t.costUsd ?? 0,
            summary: t.summary ?? snap?.lastAssistantText?.slice(0, 300) ?? null,
            exit_reason: t.exitReason ?? snap?.terminationReason ?? null,
          };
        })
      );
      const totalCost = results.reduce((sum, r) => sum + r.cost_usd, 0);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                plan_id,
                plan_status: plan.status,
                root_task: plan.rootTask,
                total_cost_usd: totalCost,
                results,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}

/**
 * Wrap the user-supplied task prompt with the protocol scaffolding every
 * spawned agent needs: how to check in, when to post notes, how to report a
 * completed PR. Keeps the user-provided prompt visible at the top so the agent
 * understands its task first.
 */
function buildSpawnPrompt(planId: string, taskId: string, userPrompt: string, branchHint?: string): string {
  const branchSection = branchHint ? `\n\nSuggested branch name: \`${branchHint}\` (use your judgment; commit on this branch).` : "";
  return `${userPrompt}${branchSection}

---

You are part of an orqlaude fleet (plan_id=${planId}, task_id=${taskId}).

When you finish:
1. Commit your changes to a feature branch.
2. Push and open a PR via \`gh pr create\`.
3. Call \`orqlaude.post_note\` with your session id and the PR URL so the primary Claude can collect it.

If you discover something other fleet agents should know (a shared schema change, a removed function, etc.), call \`orqlaude.post_note\` with the finding. If the discovery blocks you, set \`blocking: true\` and pause until \`orqlaude.checkin\` returns an ack message.

Periodically call \`orqlaude.checkin\` to pull any directed messages from the primary Claude.
`;
}
