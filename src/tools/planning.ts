import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { StateStore, newPlan, findPlan } from "../lib/state.js";
import { estimateAgent, readDailyTokenUsage } from "../lib/budgeting.js";
import type { AuditLog } from "../lib/audit.js";

/**
 * Planning-phase tools: create_plan, estimate, request_approval, confirm.
 *
 * v0.2.0: budgets are now token-based (Max-plan friendly). USD is tracked
 * informationally. The Desktop app's daily-token tally is surfaced in
 * `request_approval` so the user sees their remaining quota.
 */

const TaskInputSchema = z.object({
  title: z.string().min(1).max(60).describe("Imperative action phrase, <60 chars. Becomes the spawned session's chip label."),
  prompt: z.string().min(1).describe("Self-contained prompt for the spawned agent. Must include file paths, scope, and the directive to commit + open a PR. The agent has no memory of this conversation."),
  tldr: z.string().min(1).describe("1-2 sentence plain-English summary shown to the user as a tooltip."),
  scope: z.array(z.string()).optional().describe("Optional list of files/dirs this task touches. Informational only; if you want enforcement use claim_files from the broker."),
  branchHint: z.string().optional().describe("Optional suggested branch name. The spawned agent decides the actual name."),
});

const DEFAULT_BUDGET_TOKENS = 500_000;

export function registerPlanning(server: McpServer, store: StateStore, audit: AuditLog): void {
  // ---- create_plan ----------------------------------------------------------
  server.tool(
    "create_plan",
    "Register a fleet plan with orqlaude. Pass the user's root task description and the decomposed subtasks. Returns a plan_id used in all subsequent calls. Budget is in tokens (Max-plan friendly). Call this AFTER you've decided the work is parallelizable and written self-contained prompts.",
    {
      root_task: z.string().min(1).describe("The user's original task description, for audit and history."),
      tasks: z.array(TaskInputSchema).min(1).max(12).describe("The decomposed subtasks. Each becomes one spawned agent. Keep under ~6 unless you've discussed a larger fleet."),
      budget_cap_tokens: z.number().int().positive().default(DEFAULT_BUDGET_TOKENS).describe("Hard ceiling for the whole fleet in tokens. Per-agent cap is derived as budget_cap_tokens / tasks.length. Default 500k tokens (~5 agents × 100k each)."),
      model_for_estimate: z.string().default("claude-sonnet-4-6").describe("Model assumed for cost estimation (informational USD only; doesn't control what spawn_task uses)."),
      effort_multiplier: z.number().positive().default(1.0).describe("Rough difficulty multiplier. 0.5 trivial, 1 moderate, 2+ heavy refactors."),
    },
    audit.wrap(
      "create_plan",
      async ({ root_task, tasks, budget_cap_tokens, model_for_estimate, effort_multiplier }) => {
        const plan = await store.update((state) => {
          const p = newPlan(root_task, budget_cap_tokens, tasks);
          const est = estimateAgent(model_for_estimate, effort_multiplier);
          p.estimatedTokens = est.tokens.totalEffective * p.tasks.length;
          p.estimatedCostUsd = est.costUsd * p.tasks.length;
          p.budgetCapUsd = p.budgetCapTokens / 25_000; // rough USD shadow
          p.perAgentCapUsd = p.budgetCapUsd / p.tasks.length;
          p.modelForEstimate = model_for_estimate;
          p.effortMultiplier = effort_multiplier;
          p.estimatedDurationSec = 60 * Math.max(2, Math.ceil(4 * effort_multiplier));
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
                  budget_cap_tokens: plan.budgetCapTokens,
                  per_agent_cap_tokens: plan.perAgentCapTokens,
                  estimated_tokens: plan.estimatedTokens,
                  estimated_cost_usd: plan.estimatedCostUsd,
                  estimated_duration_sec: plan.estimatedDurationSec,
                  tasks: plan.tasks.map((t) => ({ id: t.id, title: t.title, tldr: t.tldr })),
                  next_step: "Call `request_approval` to build the user prompt.",
                },
                null,
                2
              ),
            },
          ],
        };
      },
      (_args, result: any) => ({ planId: tryGetPlanId(result) })
    )
  );

  // ---- estimate -------------------------------------------------------------
  server.tool(
    "estimate",
    "Refresh cost/time estimates for a plan with a different model or effort multiplier.",
    {
      plan_id: z.string(),
      model: z.string().optional(),
      effort_multiplier: z.number().positive().optional(),
    },
    audit.wrap(
      "estimate",
      async ({ plan_id, model, effort_multiplier }) => {
        const result = await store.update((state) => {
          const plan = findPlan(state, plan_id);
          const m = model ?? plan.modelForEstimate ?? "claude-sonnet-4-6";
          const e = effort_multiplier ?? plan.effortMultiplier ?? 1;
          const est = estimateAgent(m, e);
          plan.estimatedTokens = est.tokens.totalEffective * plan.tasks.length;
          plan.estimatedCostUsd = est.costUsd * plan.tasks.length;
          plan.estimatedDurationSec = 60 * Math.max(2, Math.ceil(4 * e));
          plan.modelForEstimate = m;
          plan.effortMultiplier = e;
          return {
            model: m,
            effort_multiplier: e,
            per_agent_tokens: est.tokens.totalEffective,
            per_agent_cost_usd: est.costUsd,
            total_tokens: plan.estimatedTokens,
            total_cost_usd: plan.estimatedCostUsd,
            budget_cap_tokens: plan.budgetCapTokens,
            fits_budget: plan.estimatedTokens <= plan.budgetCapTokens,
            estimated_duration_sec: plan.estimatedDurationSec,
          };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      ({ plan_id }) => ({ planId: plan_id })
    )
  );

  // ---- request_approval -----------------------------------------------------
  server.tool(
    "request_approval",
    "Generate an approval payload for the primary Claude to relay via AskUserQuestion. Returns an approval_token to pass back to `confirm` once the user OKs. Also surfaces remaining daily-token quota from the Desktop app.",
    { plan_id: z.string() },
    audit.wrap(
      "request_approval",
      async ({ plan_id }) => {
        const daily = await readDailyTokenUsage();
        const today = new Date().toISOString().slice(0, 10);
        const usedToday = daily && daily.date === today ? daily.tokens : 0;
        const result = await store.update((state) => {
          const plan = findPlan(state, plan_id);
          plan.status = "awaiting_approval";
          plan.approvalToken = randomUUID();
          const tokenCostSummary = `~${Math.round((plan.estimatedTokens ?? 0) / 1000)}k tokens (cap ${Math.round(plan.budgetCapTokens / 1000)}k)`;
          const usdShadow = plan.estimatedCostUsd ? ` (informational: ~$${plan.estimatedCostUsd.toFixed(2)})` : "";
          const quotaLine =
            usedToday > 0
              ? `\nYou've used ~${Math.round(usedToday / 1000)}k tokens today across all Claude Code sessions.`
              : "";
          return {
            approval_token: plan.approvalToken,
            summary: `Spawn ${plan.tasks.length} parallel agents, estimated ${tokenCostSummary}${usdShadow}, ~${Math.round((plan.estimatedDurationSec ?? 240) / 60)} min wall-time.`,
            daily_token_usage: { date: today, used: usedToday },
            tasks: plan.tasks.map((t) => ({ title: t.title, tldr: t.tldr })),
            ask_user_question: {
              question: `Approve spawning ${plan.tasks.length} parallel agents? Estimated ${tokenCostSummary}.${quotaLine}`,
              header: "Spawn fleet",
              options: [
                { label: "Approve and spawn", description: `${plan.tasks.length} agents. Each opens its own session/worktree/PR.` },
                { label: "Cancel", description: "Don't spawn. The plan stays draft so you can revise." },
              ],
            },
            next_step:
              "Show the user the question via AskUserQuestion. If they approve, call `confirm` with this approval_token.",
          };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      ({ plan_id }) => ({ planId: plan_id })
    )
  );

  // ---- confirm --------------------------------------------------------------
  server.tool(
    "confirm",
    "Confirm an approved plan, locking it for dispatch. Call this AFTER the user explicitly approved the spawn. The approval_token from request_approval is required and is consumed on use.",
    {
      plan_id: z.string(),
      approval_token: z.string(),
    },
    audit.wrap(
      "confirm",
      async ({ plan_id, approval_token }) => {
        const result = await store.update((state) => {
          const plan = findPlan(state, plan_id);
          if (plan.status !== "awaiting_approval") {
            throw new Error(`Plan ${plan_id} is not awaiting approval (status=${plan.status}).`);
          }
          if (plan.approvalToken !== approval_token) {
            throw new Error("Approval token mismatch.");
          }
          plan.status = "approved";
          plan.approvedAt = Date.now();
          plan.approvalToken = undefined;
          return {
            plan_id,
            status: plan.status,
            approved_at: plan.approvedAt,
            next_step:
              "Loop: `next_task` → `mcp__ccd_session__spawn_task` (with the returned title/prompt/tldr) → the spawned agent will self-register on first turn via checkin (no register_spawn needed unless that doesn't happen).",
          };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      ({ plan_id }) => ({ planId: plan_id })
    )
  );
}

function tryGetPlanId(result: any): string | undefined {
  try {
    const text = result?.content?.[0]?.text;
    if (typeof text !== "string") return undefined;
    return JSON.parse(text).plan_id;
  } catch {
    return undefined;
  }
}
