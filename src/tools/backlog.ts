import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BacklogStore } from "../lib/backlog.js";
import type { AuditLog } from "../lib/audit.js";

/**
 * Backlog tools: enqueue_goal, list_goals, update_goal, pick_next_goal.
 *
 * Primary Claude uses these mid-session to capture "things the user mentioned
 * we should do next" without immediately starting a fleet. The autopilot
 * daemon (running separately) consumes the queue when it's idle.
 *
 * Example: user says "after we ship analytics, let's do recurring tasks then
 * email templates". Primary Claude calls enqueue_goal three times with the
 * appropriate dependency chain, then immediately spawns the analytics fleet.
 * The daemon picks up the next one when analytics completes.
 */

const STATUS = z.enum(["queued", "planning", "awaiting_approval", "running", "done", "cancelled", "deferred"]);

export function registerBacklog(server: McpServer, backlog: BacklogStore, audit: AuditLog): void {
  // ---- enqueue_goal -------------------------------------------------------
  server.tool(
    "enqueue_goal",
    "Add a Goal to the autopilot backlog. v0.10.0+. Goals are durable, persist across sessions, and get picked up by the `orql autopilot` daemon when the fleet is idle. Use this to capture 'things to do next' the user mentions mid-session without immediately spawning a fleet. Use `depends_on` to express ordering (e.g. 'do analytics, then recurring tasks, then email templates') and `deadline_at` to escalate as a deadline nears.",
    {
      title: z.string().min(1).max(200).describe("One-line description of what should happen."),
      description: z.string().max(8000).optional().describe("Full context — what the user said, links, screenshots referenced, etc."),
      priority: z.number().int().min(0).max(100).default(50).describe("0-100; higher = sooner. Deadlines boost effective priority automatically."),
      deadline_at: z.number().int().optional().describe("Unix-ms timestamp. Priority gets boosted as the deadline approaches."),
      depends_on: z.array(z.string()).max(10).optional().describe("Goal short_ids that must finish first."),
      scope: z.array(z.string()).max(20).optional().describe("Path globs the resulting fleet will likely touch. Used to inject relevant memory + detect fleet conflicts."),
      template: z.string().optional().describe("Suggested fleet template id (see fleet_templates list). Planner Agnet may override."),
      tags: z.array(z.string()).max(20).optional(),
      source: z.string().default("claude").describe("'user' / 'claude' / 'system' / 'autopilot'."),
    },
    audit.wrap(
      "enqueue_goal",
      async ({ title, description, priority, deadline_at, depends_on, scope, template, tags, source }) => {
        const goal = await backlog.enqueue({
          title,
          description,
          priority,
          deadlineAt: deadline_at,
          dependsOn: depends_on,
          scope,
          template,
          tags,
          source,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  goal_id: goal.id,
                  short_id: goal.shortId,
                  priority: goal.priority,
                  next_step:
                    "Goal added. The autopilot daemon will pick it up when idle. List with `list_goals`. To force-start now, call `pick_next_goal` then create_plan.",
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

  // ---- list_goals ---------------------------------------------------------
  server.tool(
    "list_goals",
    "List Goals in the backlog. Sorted by effective priority (base + deadline boost). Returns status, priority, deps, and the dependency-resolved 'ready to pick' bit.",
    {
      status: STATUS.optional().describe("Filter by a single status. Omit for all."),
      limit: z.number().int().positive().max(500).default(50),
    },
    audit.wrap(
      "list_goals",
      async ({ status, limit }) => {
        const goals = await backlog.list({ status, limit });
        const doneIds = new Set((await backlog.list({ status: "done" })).map((g) => g.id));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  count: goals.length,
                  goals: goals.map((g) => ({
                    short_id: g.shortId,
                    id: g.id,
                    title: g.title,
                    status: g.status,
                    priority: g.priority,
                    deadline_at: g.deadlineAt,
                    depends_on: g.dependsOn,
                    deps_resolved: (g.dependsOn ?? []).every((d) => doneIds.has(d)),
                    scope: g.scope,
                    template: g.template,
                    tags: g.tags,
                    plan_id: g.planId,
                    source: g.source,
                    created_at: g.createdAt,
                    started_at: g.startedAt,
                    finished_at: g.finishedAt,
                    outcome: g.outcome,
                  })),
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

  // ---- update_goal --------------------------------------------------------
  server.tool(
    "update_goal",
    "Update a Goal — change priority, status, deadline, link a plan_id, mark outcome, etc. Use status=`cancelled` when the user changes their mind, status=`deferred` for 'not yet', status=`done` to record completion + outcome.",
    {
      id: z.string().describe("Goal short_id or full id."),
      status: STATUS.optional(),
      priority: z.number().int().min(0).max(100).optional(),
      deadline_at: z.number().int().nullable().optional().describe("Pass null to clear."),
      plan_id: z.string().optional().describe("Link a created plan to this goal."),
      outcome_ok: z.boolean().optional(),
      outcome_note: z.string().max(2000).optional(),
      outcome_pr_urls: z.array(z.string()).max(20).optional(),
    },
    audit.wrap(
      "update_goal",
      async ({ id, status, priority, deadline_at, plan_id, outcome_ok, outcome_note, outcome_pr_urls }) => {
        const goal = await backlog.update(id, (g) => {
          if (status) {
            g.status = status;
            if (status === "running" && !g.startedAt) g.startedAt = Date.now();
            if ((status === "done" || status === "cancelled") && !g.finishedAt) g.finishedAt = Date.now();
          }
          if (typeof priority === "number") g.priority = priority;
          if (deadline_at === null) g.deadlineAt = undefined;
          else if (typeof deadline_at === "number") g.deadlineAt = deadline_at;
          if (plan_id) g.planId = plan_id;
          if (outcome_ok !== undefined || outcome_note || outcome_pr_urls) {
            g.outcome = {
              ok: outcome_ok ?? g.outcome?.ok ?? true,
              note: outcome_note ?? g.outcome?.note,
              prUrls: outcome_pr_urls ?? g.outcome?.prUrls,
            };
          }
        });
        if (!goal) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, note: "goal not found" }, null, 2) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, goal_id: goal.id, status: goal.status }, null, 2) }] };
      },
      () => ({})
    )
  );

  // ---- pick_next_goal -----------------------------------------------------
  server.tool(
    "pick_next_goal",
    "Return the highest-priority queued goal whose dependencies are all done. Returns undefined if backlog is empty or everything is blocked. Read-only — doesn't change goal status; call `update_goal` to transition into `planning`.",
    {},
    audit.wrap(
      "pick_next_goal",
      async () => {
        const goal = await backlog.pickNext();
        if (!goal) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { ok: false, picked: null, note: "No goals are ready. Backlog empty or everything is blocked by deps." },
                  null,
                  2
                ),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  picked: {
                    short_id: goal.shortId,
                    id: goal.id,
                    title: goal.title,
                    description: goal.description,
                    priority: goal.priority,
                    scope: goal.scope,
                    template: goal.template,
                  },
                  next_step:
                    "Transition with update_goal(id, status='planning'), then spawn a planner Agnet (or call create_plan directly).",
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
