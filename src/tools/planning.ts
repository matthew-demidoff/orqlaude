import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { StateStore, newPlan, findPlan, type Plan } from "../lib/state.js";
import { estimateAgent, readDailyTokenUsage } from "../lib/budgeting.js";
import { pickAgnetName, agnetLabel } from "../lib/agnet.js";
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
  scope: z.array(z.string()).optional().describe("Optional list of files/dirs this task touches. Used (1) to detect overlap with other tasks at plan creation, and (2) as a hint to the spawned agent for which files to claim_files. If two tasks declare the same path, create_plan returns a `scope_overlaps` warning (and rejects with `strict_scope: true`)."),
  branchHint: z.string().optional().describe("Optional suggested branch name. The spawned agent decides the actual name."),
  budgetHintTokens: z.number().int().positive().optional().describe("Optional per-task token budget hint. status() will surface a soft warning when this task's usage exceeds 70% of this value. The plan-wide budget_cap_tokens still hard-stops everything at 100%."),
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
      budget_cap_tokens: z.number().int().positive().default(DEFAULT_BUDGET_TOKENS).describe("Hard ceiling for the whole fleet in tokens. Per-agent cap is derived as budget_cap_tokens / tasks.length unless tasks have individual budgetHintTokens. Default 500k tokens (~5 agents × 100k each)."),
      budget_mode: z.enum(["billed", "total"]).default("billed").describe("v0.9.2+: which token bucket the cap constrains. `billed` (default) counts only input + output tokens - cache reads are free on the Claude Plan so excluding them stops spurious overbudget kills. `total` counts everything including cache reads; pick this if you're paying per-token via the API."),
      model_for_estimate: z.string().default("claude-sonnet-4-6").describe("Model assumed for cost estimation (informational USD only; doesn't control what spawn_task uses)."),
      effort_multiplier: z.number().positive().default(1.0).describe("Rough difficulty multiplier. 0.5 trivial, 1 moderate, 2+ heavy refactors."),
      strict_scope: z.boolean().default(false).describe("If true, reject the plan when two tasks declare overlapping `scope` paths. Default false (warn but allow)."),
    },
    audit.wrap(
      "create_plan",
      async ({ root_task, tasks, budget_cap_tokens, budget_mode, model_for_estimate, effort_multiplier, strict_scope }) => {
        // Pre-check: scope overlap. Surface as warning, or reject if strict.
        const overlaps = detectScopeOverlaps(tasks);
        if (overlaps.length > 0 && strict_scope) {
          throw new Error(
            `strict_scope: scope overlap between tasks. ${overlaps
              .map((o) => `"${o.path}" claimed by ${o.tasks.join(" + ")}`)
              .join("; ")}`
          );
        }
        let plan: Plan;
        try {
          plan = await store.update<Plan>((state) => {
            const p = newPlan(root_task, budget_cap_tokens, tasks);
            p.budgetMode = budget_mode;
            // Assign Agnet names — stable per task_id, unique within plan.
            const taken = new Set<string>();
            for (const t of p.tasks) {
              t.agnetName = pickAgnetName(t.id, taken);
              taken.add(t.agnetName);
            }
            const est = estimateAgent(model_for_estimate, effort_multiplier);
            p.estimatedTokens = est.tokens.totalEffective * p.tasks.length;
            p.estimatedCostUsd = est.costUsd * p.tasks.length;
            p.budgetCapUsd = p.budgetCapTokens / 25_000;
            p.perAgentCapUsd = p.budgetCapUsd / p.tasks.length;
            p.modelForEstimate = model_for_estimate;
            p.effortMultiplier = effort_multiplier;
            p.estimatedDurationSec = 60 * Math.max(2, Math.ceil(4 * effort_multiplier));
            state.plans[p.id] = p;
            return p;
          });
        } catch (err: any) {
          // Diagnose common launch-config failures with a self-describing
          // message rather than the raw fs error.
          if (err && (err.code === "EACCES" || err.code === "EPERM" || err.code === "EROFS")) {
            throw new Error(
              `orqlaude can't write its state directory (${err.code}). The MCP host probably launched the server from an unwritable cwd. Fix: set ORQLAUDE_STATE_DIR in your .mcp.json env block to a path orqlaude can write to (e.g. \"$HOME/.orqlaude/myproject\"). Original error: ${err.message}`
            );
          }
          if (err && err.code === "ENOENT" && err.path) {
            throw new Error(
              `orqlaude can't reach its state directory: ${err.path} (ENOENT). Likely the parent directory doesn't exist or the cwd is invalid. Set ORQLAUDE_STATE_DIR explicitly. Original error: ${err.message}`
            );
          }
          throw err;
        }
        const responsePayload: Record<string, unknown> = {
          plan_id: plan.id,
          task_count: plan.tasks.length,
          budget_cap_tokens: plan.budgetCapTokens,
          budget_mode: plan.budgetMode ?? "billed",
          per_agent_cap_tokens: plan.perAgentCapTokens,
          estimated_tokens: plan.estimatedTokens,
          estimated_cost_usd: plan.estimatedCostUsd,
          estimated_duration_sec: plan.estimatedDurationSec,
          tasks: plan.tasks.map((t) => ({
            id: t.id,
            title: t.title,
            tldr: t.tldr,
            agnet: agnetLabel(t.agnetName),  // v0.5+: human-friendly designation
            scope: t.scope ?? [],
            budget_hint_tokens: t.budgetHintTokens ?? null,
          })),
          workflow_hint: {
            phase: "planned",
            next: "request_approval",
            full_flow:
              "create_plan → request_approval (returns ask_user_question for AskUserQuestion) → confirm → loop[next_task → mcp__ccd_session__spawn_task → child self-registers via checkin] → status / poll_notes / send_message → collect → optional review_prs.",
          },
        };
        if (overlaps.length > 0) {
          responsePayload.scope_overlaps = overlaps;
          responsePayload.scope_overlap_advice =
            "Tasks declare overlapping scope. They may collide at merge time. Either revise the decomposition, or instruct the agents to use claim_files for serialization. Pass strict_scope=true to fail loudly instead of warning.";
        }
        return { content: [{ type: "text", text: JSON.stringify(responsePayload, null, 2) }] };
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

/**
 * Detect scope overlaps between tasks. Returns one entry per overlapping
 * normalized path with the list of titles that claim it. Normalization is
 * intentionally simple (lowercase + trim) — false positives are fine here
 * because we only warn, and false negatives are caught by claim_files at
 * runtime.
 */
function detectScopeOverlaps(
  tasks: Array<{ title: string; scope?: string[] }>
): Array<{ path: string; tasks: string[] }> {
  const map = new Map<string, Set<string>>();
  for (const t of tasks) {
    if (!t.scope) continue;
    for (const raw of t.scope) {
      const norm = raw.trim().toLowerCase();
      if (!norm) continue;
      if (!map.has(norm)) map.set(norm, new Set());
      map.get(norm)!.add(t.title);
    }
  }
  const out: Array<{ path: string; tasks: string[] }> = [];
  for (const [norm, titles] of map.entries()) {
    if (titles.size > 1) out.push({ path: norm, tasks: [...titles] });
  }
  return out;
}
