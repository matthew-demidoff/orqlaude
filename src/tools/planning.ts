import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { StateStore, newPlan, findPlan } from "../lib/state.js";
import { estimateAgentCost } from "../lib/pricing.js";

/**
 * Planning-phase tools: create_plan, estimate, request_approval, confirm.
 *
 * Designed so primary Claude calls them in order:
 *   1. create_plan   — hand orqlaude the decomposition
 *   2. estimate      — get budget numbers (uses defaults from plan model + effort)
 *   3. request_approval — get a structured payload to relay via AskUserQuestion
 *   4. confirm       — pass the approval token after user OKs
 *
 * After confirm, the plan moves to "approved" and next_task can be called.
 */

const TaskInputSchema = z.object({
  title: z.string().min(1).max(60).describe("Imperative action phrase, <60 chars. Becomes the spawned session's chip label."),
  prompt: z.string().min(1).describe("Self-contained prompt for the spawned agent. Must include file paths, scope, and the directive to commit + open a PR. The agent has no memory of this conversation."),
  tldr: z.string().min(1).describe("1-2 sentence plain-English summary shown to the user as a tooltip."),
  scope: z.array(z.string()).optional().describe("Optional list of files/dirs this task touches. Informational only."),
  branchHint: z.string().optional().describe("Optional suggested branch name. The spawned agent decides the actual name."),
});

export function registerPlanning(server: McpServer, store: StateStore): void {
  // ---- create_plan ----------------------------------------------------------
  server.tool(
    "create_plan",
    "Register a fleet plan with orqlaude. Pass the user's root task description and the array of sub-tasks you've decomposed it into. Returns a plan_id used in all subsequent calls. Call this AFTER you've decided the work is parallelizable and have written self-contained prompts for each subtask.",
    {
      root_task: z.string().min(1).describe("The user's original task description, used for audit and history."),
      tasks: z.array(TaskInputSchema).min(1).max(12).describe("The decomposed subtasks. Each will become one spawned agent. Keep under ~6 unless you've discussed a larger fleet with the user."),
      budget_cap_usd: z.number().positive().default(10).describe("Hard ceiling for the whole fleet, USD. Per-agent cap is derived as budget_cap_usd / tasks.length."),
      model_for_estimate: z.string().default("claude-sonnet-4-6").describe("Model assumed when estimating cost. Spawn_task itself uses the user's default; this is only for the cost estimate."),
      effort_multiplier: z.number().positive().default(1.0).describe("Rough difficulty multiplier per agent. 0.5 for trivial, 1 for moderate, 2+ for heavy refactors."),
    },
    async ({ root_task, tasks, budget_cap_usd, model_for_estimate, effort_multiplier }) => {
      const plan = await store.update((state) => {
        const p = newPlan(root_task, budget_cap_usd, tasks);
        const perAgent = estimateAgentCost(model_for_estimate, effort_multiplier);
        p.estimatedCostUsd = perAgent * p.tasks.length;
        p.estimatedDurationSec = 60 * Math.max(2, Math.ceil(4 * effort_multiplier)); // rough: 4 min × effort, min 2 min
        state.plans[p.id] = p;
        return p;
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                plan_id: plan.id,
                task_count: plan.tasks.length,
                per_agent_cap_usd: plan.perAgentCapUsd,
                total_cap_usd: plan.budgetCapUsd,
                estimated_cost_usd: plan.estimatedCostUsd,
                estimated_duration_sec: plan.estimatedDurationSec,
                tasks: plan.tasks.map((t) => ({ id: t.id, title: t.title, tldr: t.tldr })),
                next_step: "Call `estimate` to refresh numbers, then `request_approval` to build the user prompt.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ---- estimate -------------------------------------------------------------
  server.tool(
    "estimate",
    "Refresh cost/time estimates for a plan. Useful if you want to recompute against a different model or effort multiplier without rebuilding the plan.",
    {
      plan_id: z.string().describe("Plan id returned by create_plan."),
      model: z.string().optional().describe("Model to assume. Default keeps the prior estimate's model."),
      effort_multiplier: z.number().positive().optional().describe("Override effort multiplier."),
    },
    async ({ plan_id, model, effort_multiplier }) => {
      const result = await store.update((state) => {
        const plan = findPlan(state, plan_id);
        const m = model ?? "claude-sonnet-4-6";
        const e = effort_multiplier ?? 1;
        const perAgent = estimateAgentCost(m, e);
        plan.estimatedCostUsd = perAgent * plan.tasks.length;
        plan.estimatedDurationSec = 60 * Math.max(2, Math.ceil(4 * e));
        return {
          model: m,
          effort_multiplier: e,
          per_agent_cost_usd: perAgent,
          total_cost_usd: plan.estimatedCostUsd,
          estimated_duration_sec: plan.estimatedDurationSec,
          budget_cap_usd: plan.budgetCapUsd,
          fits_budget: plan.estimatedCostUsd <= plan.budgetCapUsd,
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ---- request_approval -----------------------------------------------------
  server.tool(
    "request_approval",
    "Generate an approval payload the primary Claude should relay to the user via AskUserQuestion. Returns an approval_token to pass back to `confirm` once the user OKs. The plan transitions to `awaiting_approval`. The token is single-use.",
    {
      plan_id: z.string().describe("Plan id."),
    },
    async ({ plan_id }) => {
      const result = await store.update((state) => {
        const plan = findPlan(state, plan_id);
        plan.status = "awaiting_approval";
        plan.approvalToken = randomUUID();
        return {
          approval_token: plan.approvalToken,
          summary: `Spawn ${plan.tasks.length} parallel agents, estimated ~$${plan.estimatedCostUsd?.toFixed(2)} (cap $${plan.budgetCapUsd}), ~${Math.round((plan.estimatedDurationSec ?? 240) / 60)} min wall-time`,
          tasks: plan.tasks.map((t) => ({ title: t.title, tldr: t.tldr })),
          ask_user_question: {
            question: `Approve spawning ${plan.tasks.length} parallel agents? Estimated cost ~$${plan.estimatedCostUsd?.toFixed(2)}, cap $${plan.budgetCapUsd}.`,
            header: "Spawn fleet",
            options: [
              { label: "Approve and spawn", description: `${plan.tasks.length} agents. Each opens its own session/worktree/PR.` },
              { label: "Cancel", description: "Don't spawn. The plan stays draft so you can revise." },
            ],
          },
          next_step:
            "Show the user the question via AskUserQuestion. If they pick 'Approve and spawn', call `confirm` with this approval_token. If 'Cancel', stop.",
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ---- confirm --------------------------------------------------------------
  server.tool(
    "confirm",
    "Confirm an approved plan, locking it for dispatch. Call this AFTER the user explicitly approved the spawn via the AskUserQuestion you showed them. The approval_token from `request_approval` is required and is consumed on use.",
    {
      plan_id: z.string().describe("Plan id."),
      approval_token: z.string().describe("The single-use token returned by request_approval."),
    },
    async ({ plan_id, approval_token }) => {
      const result = await store.update((state) => {
        const plan = findPlan(state, plan_id);
        if (plan.status !== "awaiting_approval") {
          throw new Error(`Plan ${plan_id} is not awaiting approval (status=${plan.status})`);
        }
        if (plan.approvalToken !== approval_token) {
          throw new Error(`Approval token mismatch.`);
        }
        plan.status = "approved";
        plan.approvedAt = Date.now();
        plan.approvalToken = undefined;
        return {
          plan_id,
          status: plan.status,
          approved_at: plan.approvedAt,
          next_step: "Loop: call `next_task` to pull a task, then call `mcp__ccd_session__spawn_task` with its title/prompt/tldr, then call `register_spawn` once you have the new session_id from the user clicking the chip.",
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
