import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryStore } from "../lib/memory.js";
import type { AuditLog } from "../lib/audit.js";

/**
 * Memory tools: `remember`, `recall`, `forget`, `compose_context`.
 *
 * Spirit-themed categories — `lore` (user preferences), `playbook` (code
 * conventions), `ledger` (past decisions + rationale), `atlas` (project map).
 *
 * The autopilot daemon also reads these — when it spawns a fleet, it auto-
 * injects a memory block matching the fleet's scope, so each Agnet sees the
 * relevant pinned facts + conventions without primary Claude having to
 * re-state them every time.
 */

const CATEGORY = z.enum(["lore", "playbook", "ledger", "atlas"]);

export function registerMemory(server: McpServer, memory: MemoryStore, audit: AuditLog): void {
  // ---- remember -----------------------------------------------------------
  server.tool(
    "remember",
    "Write a durable fact into orqlaude's memory. v0.10.0+. Spirit-themed categories: `lore` (user preferences / quirks), `playbook` (code conventions), `ledger` (past decisions + their rationale, append-only), `atlas` (project map: file/module → purpose). New entries with the same (category, key) supersede the old one — the older entry is kept for history but won't surface in recall(). Use `pinned: true` for facts that should inject into EVERY future Agnet spawn (e.g. 'Russian comments in CRM templates', 'don't auto-deploy Fridays').",
    {
      category: CATEGORY,
      key: z.string().min(1).max(120).describe("Short identifier. Same (category, key) supersedes."),
      value: z.string().min(1).max(4000).describe("The fact itself. Markdown OK."),
      rationale: z.string().max(2000).optional().describe("Why this matters / how we learned it. Surfaces in ledger recalls."),
      scope: z.array(z.string()).max(20).optional().describe("Path globs this entry applies to. E.g. ['**/migrations/**', 'frontend/src/components/Kanban/**']. Used to scope which memories inject into a fleet."),
      tags: z.array(z.string()).max(20).optional().describe("Free-form tags for retrieval."),
      pinned: z.boolean().default(false).describe("Pinned entries inject into every Agnet spawn regardless of scope."),
      plan_id: z.string().optional().describe("Optional: plan this memory was learned during. Audit trail."),
      task_id: z.string().optional(),
      session_id: z.string().optional(),
    },
    audit.wrap(
      "remember",
      async ({ category, key, value, rationale, scope, tags, pinned, plan_id, task_id, session_id }) => {
        const entry = await memory.remember({
          category,
          key,
          value,
          rationale,
          scope,
          tags,
          pinned,
          bornFrom: { planId: plan_id, taskId: task_id, sessionId: session_id },
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  id: entry.id,
                  category: entry.category,
                  key: entry.key,
                  pinned: !!entry.pinned,
                  next_step:
                    "Memory written. Future Agnet spawns scoped to overlapping paths will see this in their context block. Test with `recall`.",
                },
                null,
                2
              ),
            },
          ],
        };
      },
      ({ plan_id }) => ({ planId: plan_id ?? "(memory)" })
    )
  );

  // ---- recall -------------------------------------------------------------
  server.tool(
    "recall",
    "Retrieve memory entries. v0.10.0+. Filter by category, exact key, free-text query (matches key/value/tags), or scope (path globs). Pinned entries always come first, then recency. Use this when primary Claude needs to remember 'how did we handle X last time' or 'what was the user's preference for Y'.",
    {
      category: CATEGORY.optional(),
      key: z.string().optional().describe("Exact key match (case-insensitive)."),
      query: z.string().optional().describe("Free-text query against key, value, and tags."),
      scope: z.array(z.string()).max(20).optional().describe("Path globs — entries whose scope overlaps will rank first."),
      limit: z.number().int().positive().max(200).default(20),
    },
    audit.wrap(
      "recall",
      async ({ category, key, query, scope, limit }) => {
        const entries = await memory.recall({ category, key, query, scope, limit });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  count: entries.length,
                  entries: entries.map((e) => ({
                    id: e.id,
                    category: e.category,
                    key: e.key,
                    value: e.value,
                    rationale: e.rationale,
                    scope: e.scope,
                    tags: e.tags,
                    pinned: !!e.pinned,
                    created_at: e.createdAt,
                    born_from: e.bornFrom,
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

  // ---- forget -------------------------------------------------------------
  server.tool(
    "forget",
    "Mark a memory entry as forgotten so it won't surface in recall() anymore. Soft delete — the entry stays in the file for history but is invisible to read paths. Pass the entry's id (from `recall`).",
    {
      id: z.string().describe("Entry id from recall()."),
    },
    audit.wrap(
      "forget",
      async ({ id }) => {
        const ok = await memory.forget(id);
        return {
          content: [{ type: "text", text: JSON.stringify({ ok, id }, null, 2) }],
        };
      },
      () => ({})
    )
  );

  // ---- compose_context ----------------------------------------------------
  server.tool(
    "compose_memory_context",
    "Render a memory block ready to splice into a spawned-Agnet prompt. Picks pinned entries + scope-relevant entries up to `max_chars`. Useful when primary Claude is hand-crafting a spawn prompt and wants to include the same memory injection the autopilot daemon does.",
    {
      scope: z.array(z.string()).max(20).optional().describe("Path globs the spawn will touch."),
      max_chars: z.number().int().positive().max(8000).default(2000),
    },
    audit.wrap(
      "compose_memory_context",
      async ({ scope, max_chars }) => {
        const block = await memory.composeContextBlock({ scope, maxChars: max_chars });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  context_block: block,
                  length: block.length,
                  budget: max_chars,
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
