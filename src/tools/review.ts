import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StateStore, newPlan, findPlan } from "../lib/state.js";
import { estimateAgent } from "../lib/budgeting.js";
import type { AuditLog } from "../lib/audit.js";

/**
 * review_prs — spawn a review fleet against the PRs produced by an
 * already-completed plan.
 *
 * The implementation creates a NEW plan whose tasks correspond 1:1 with the
 * source plan's tasks-with-PR-URLs. Each new task's prompt instructs the
 * reviewer agent to fetch the PR via `gh pr view`, inspect the diff, run any
 * applicable tests, and post findings via post_note (with `pr_url` set to the
 * source PR so the original collect() picks them up).
 *
 * The review plan is automatically approved (skipping the AskUserQuestion
 * step) because the user already approved the parent fleet. If they want a
 * confirmation per review, they can set `auto_approve: false`.
 */

export function registerReview(server: McpServer, store: StateStore, audit: AuditLog): void {
  server.tool(
    "review_prs",
    "Spawn a reviewer agent for each PR produced by a completed plan. Creates a NEW plan (the 'review plan') whose tasks dispatch via the normal next_task/spawn_task loop. Auto-approved by default — pass `auto_approve: false` to require a fresh user approval. Source plan's review_plan_id is updated so you can trace the relationship.",
    {
      plan_id: z.string().describe("Plan id of the COMPLETED fleet whose PRs should be reviewed."),
      auto_approve: z.boolean().default(true).describe("Skip the user approval gate. The parent fleet already had an approval; this is asking 'do you want a separate prompt for reviewing your own PRs?' Default false-equivalent is to do request_approval/confirm manually."),
      budget_cap_tokens: z.number().int().positive().default(300_000).describe("Token budget for the review fleet."),
    },
    audit.wrap(
      "review_prs",
      async ({ plan_id, auto_approve, budget_cap_tokens }) => {
        const result = await store.update((state) => {
          const source = findPlan(state, plan_id);
          const prTasks = source.tasks.filter((t) => t.prUrl);
          if (prTasks.length === 0) {
            return { created: false, note: "No PRs to review yet. Agents must call post_note with a pr_url first." };
          }
          const reviewTasks = prTasks.map((t) => ({
            title: `Review: ${truncate(t.title, 50)}`,
            prompt: buildReviewPrompt(t.prUrl!, t.title, source.rootTask),
            tldr: `Review the PR opened for "${t.title}".`,
            scope: [t.prUrl!],
          }));
          const reviewPlan = newPlan(`Review of PRs from plan ${plan_id}`, budget_cap_tokens, reviewTasks);
          const est = estimateAgent(source.modelForEstimate ?? "claude-sonnet-4-6", source.effortMultiplier ?? 0.6);
          reviewPlan.estimatedTokens = est.tokens.totalEffective * reviewPlan.tasks.length;
          reviewPlan.estimatedCostUsd = est.costUsd * reviewPlan.tasks.length;
          reviewPlan.estimatedDurationSec = 60 * 3; // reviewers are typically shorter than implementers
          reviewPlan.modelForEstimate = source.modelForEstimate;
          reviewPlan.effortMultiplier = 0.6;
          if (auto_approve) {
            reviewPlan.status = "approved";
            reviewPlan.approvedAt = Date.now();
          }
          state.plans[reviewPlan.id] = reviewPlan;
          source.reviewPlanId = reviewPlan.id;
          return {
            created: true,
            review_plan_id: reviewPlan.id,
            source_plan_id: plan_id,
            task_count: reviewPlan.tasks.length,
            status: reviewPlan.status,
            estimated_tokens: reviewPlan.estimatedTokens,
            next_step: auto_approve
              ? "Loop next_task → spawn_task for each reviewer just like the parent fleet. Reviewers will post their findings as notes."
              : "Call request_approval on the review plan to get a user prompt, then confirm.",
          };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      ({ plan_id }) => ({ planId: plan_id })
    )
  );
}

function buildReviewPrompt(prUrl: string, originalTitle: string, rootTask: string): string {
  return `Review the pull request: ${prUrl}

Context: this PR was produced by an orqlaude fleet member working on the task "${originalTitle}", part of the larger effort: "${rootTask}".

Your job:
1. Fetch the PR locally: \`gh pr checkout <number>\` or \`gh pr view ${prUrl} --json files,title,body\`.
2. Read the diff. Walk every changed file. Don't trust the description; verify against the code.
3. Check for:
   - Bugs (off-by-one, null handling, race conditions, error swallowing)
   - Missed tests (any new logic without coverage?)
   - Design issues (does the change fit the surrounding code's idioms?)
   - Security concerns (input validation, secret handling, injection vectors)
   - Documentation gaps
4. Run the project's test suite if there is one (\`npm test\`, \`pytest\`, etc.). Report failures.
5. Post your findings via \`mcp__orqlaude__post_note\` with:
   - \`session_id\`: your session id (self-register first via checkin with the task_id below).
   - \`text\`: a concise review. Bullet points. Severity-tagged: [BLOCKER], [CONCERN], [NIT].
   - \`pr_url\`: ${prUrl}  (so the orchestrator attaches it to your task)
6. If you find a [BLOCKER], also leave a GitHub review comment via \`gh pr review <pr> -c -b "..."\` so the human sees it inline.

Be specific. "Looks good" is not a review. If you have nothing to say, say "No issues found — read N files, all match the surrounding style and have test coverage."
`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
