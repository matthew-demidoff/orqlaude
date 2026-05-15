import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FLEET_TEMPLATES, findTemplate, suggestTemplates } from "../lib/templates.js";
import type { AuditLog } from "../lib/audit.js";

/**
 * Fleet template tools: list_fleet_templates, suggest_fleet_template, apply_fleet_template.
 *
 * Templates encode the user's "this is how we ship feature X" patterns so the
 * planner Agnet doesn't reinvent the wheel each time. v0.10.0+.
 */

export function registerTemplates(server: McpServer, audit: AuditLog): void {
  // ---- list_fleet_templates ------------------------------------------------
  server.tool(
    "list_fleet_templates",
    "List all known fleet templates. Each describes the typical Agnet layout, default budgets, suggested auto-merge rule, and which tags hint at this template. Use before create_plan when the task fits a common pattern (backend-feature, frontend-feature, migration-only, audit-sweep, dep-upgrade, i18n-pass, test-coverage-fill, bug-hunt).",
    {},
    audit.wrap(
      "list_fleet_templates",
      async () => {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  templates: FLEET_TEMPLATES.map((t) => ({
                    id: t.id,
                    title: t.title,
                    description: t.description,
                    agent_count: t.agentRoles.length,
                    roles: t.agentRoles.map((r) => ({ role: r.role, model: r.model ?? "sonnet", purpose: r.purpose })),
                    default_per_agnet_budget: t.defaultPerAgnetBudget,
                    suggested_for_tags: t.suggestedForTags,
                    auto_merge: t.autoMerge,
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

  // ---- suggest_fleet_template ---------------------------------------------
  server.tool(
    "suggest_fleet_template",
    "Given a list of tags (or keywords from the user's request), return matching fleet templates ranked by tag overlap. Primary Claude can present these to the user as a quick-pick before calling create_plan.",
    {
      tags: z.array(z.string()).min(1).max(20).describe("Keywords / tags describing the task. E.g. ['migration', 'recurring tasks']."),
    },
    audit.wrap(
      "suggest_fleet_template",
      async ({ tags }) => {
        const matches = suggestTemplates(tags);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  query_tags: tags,
                  matches: matches.map((m) => ({
                    id: m.id,
                    title: m.title,
                    description: m.description,
                    agent_count: m.agentRoles.length,
                  })),
                  fallback: matches.length === 0 ? "No templates matched. Use create_plan directly without a template." : null,
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

  // ---- apply_fleet_template -----------------------------------------------
  server.tool(
    "apply_fleet_template",
    "Stamp out a fleet template into a tasks-array shape suitable for create_plan. Substitutes the user's `root_task` and per-role scope hints into the template's role prompts. Returns the tasks array plus suggested budget. Primary Claude reviews the output, may tweak, then calls create_plan with the result.",
    {
      template_id: z.string().describe("From list_fleet_templates."),
      root_task: z.string().min(1).max(2000).describe("The actual feature/task description."),
      scope_overrides: z.record(z.array(z.string())).optional().describe("Map of role-name → path globs to override the template's default scope hints. E.g. {'implementer': ['backend/recurring/**']}."),
    },
    audit.wrap(
      "apply_fleet_template",
      async ({ template_id, root_task, scope_overrides }) => {
        const tpl = findTemplate(template_id);
        if (!tpl) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: false, note: `Unknown template: ${template_id}` }, null, 2),
              },
            ],
          };
        }
        const tasks = tpl.agentRoles.map((r) => ({
          title: `${tpl.title} — ${r.role}`,
          tldr: r.purpose,
          prompt: `# Task: ${tpl.title} — ${r.role}\n\n## Root task\n${root_task}\n\n## Your role\n${r.purpose}\n\n## Model\n${r.model ?? "sonnet"}\n\nFollow the project's playbook conventions (use \`mcp__orqlaude__recall\` with category=playbook for code conventions). Coordinate with other Agnets via \`mcp__orqlaude__post_note\` if you encounter overlap.`,
          scope: scope_overrides?.[r.role] ?? r.scopeHint ?? [],
          model: r.model ?? "sonnet",
          role: r.role,
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  template_id,
                  template_title: tpl.title,
                  tasks,
                  total_budget: tpl.defaultPerAgnetBudget * tpl.agentRoles.length,
                  per_agnet_budget: tpl.defaultPerAgnetBudget,
                  permission_mode: tpl.permissionMode,
                  auto_merge_rule: tpl.autoMerge,
                  next_step: "Pass `tasks` to create_plan. Override budget/permission_mode as needed. Auto-merge rule is informational — the autopilot daemon will apply it when reviewing PRs.",
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
