import path from "node:path";
import { randomUUID } from "node:crypto";
import { JsonStore } from "./json_store.js";

/**
 * Memory module — durable cross-session notebook for orqlaude.
 *
 * Spirit-themed categories (each has its own taxonomy and lifecycle):
 *
 *   • lore     — facts about the user. "Matthew prefers Russian comments in
 *                CRM templates." "Don't auto-deploy on Fridays." Pinned, slow
 *                churn, surfaced into every spawned-Agnet prompt.
 *
 *   • playbook — code conventions / how-we-do-things. "Migrations live in
 *                `<app>/migrations/`." "Use AntD ConfigProvider for dark mode."
 *                Surfaced when a fleet's scope intersects with a playbook
 *                entry's path-glob.
 *
 *   • ledger   — past decisions + their rationale. "PR #21 we chose Sonnet
 *                over Opus for transcription because latency mattered more
 *                than depth." Append-only; surfaced on `recall("ledger")`
 *                when a similar decision recurs.
 *
 *   • atlas    — project map. Module-to-purpose mappings. "deals/views.py
 *                owns DRF deal endpoints; KanBan dnd handled there." Updated
 *                automatically when fleets complete (the post-PR review
 *                writes back an atlas entry per touched file).
 *
 * Storage: `<state_dir>/memory.json`, written atomically through `JsonStore`
 * — cross-process lock + mtime invalidation so the CLI, the MCP server, and
 * the autopilot daemon can all write concurrently without losing entries.
 *
 * Why a separate file (not the main state)? Memory is durable across plans;
 * the main state file lives and breathes with plan lifecycles. Mixing them
 * forces both to share a lock budget. Memory is read-heavy, write-light;
 * separating it lets the autopilot daemon hammer recall() without
 * contending with state mutations.
 */

export type MemoryCategory = "lore" | "playbook" | "ledger" | "atlas";

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  key: string;
  value: string;
  rationale?: string;
  /** ISO path-glob this entry is relevant to. `["**\/migrations/**"]` etc.
   *  Used by the spawn-prompt builder to scope which memories to inject. */
  scope?: string[];
  /** Tags for free-form retrieval. */
  tags?: string[];
  createdAt: number;
  /** Plan / session that birthed this memory. */
  bornFrom?: { planId?: string; taskId?: string; sessionId?: string };
  /** Soft delete — older entries with the same (category, key) tuple. */
  supersededBy?: string;
  supersededAt?: number;
  /** Pinned entries always inject. Otherwise relevance scoring decides. */
  pinned?: boolean;
}

export interface MemoryFile {
  schemaVersion: 1;
  entries: MemoryEntry[];
}

const EMPTY: MemoryFile = { schemaVersion: 1, entries: [] };

export class MemoryStore {
  private store: JsonStore<MemoryFile>;

  constructor(stateDir: string) {
    this.store = new JsonStore<MemoryFile>({
      filePath: path.join(stateDir, "memory.json"),
      empty: EMPTY,
      migrate: (raw) => {
        const parsed = raw as Partial<MemoryFile> | undefined;
        if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.entries)) {
          return parsed as MemoryFile;
        }
        return EMPTY;
      },
    });
  }

  async list(): Promise<MemoryEntry[]> {
    return this.store.read((f) => f.entries.filter((e) => !e.supersededBy));
  }

  /**
   * Recall entries matching a query. The query is permissive — any of:
   *   • exact key match (case-insensitive)
   *   • substring in key or value
   *   • tag membership
   *   • path-glob overlap with `scope`
   *
   * Pinned entries always come first, then by recency.
   */
  async recall(opts: {
    category?: MemoryCategory;
    key?: string;
    query?: string;
    scope?: string[];
    limit?: number;
  }): Promise<MemoryEntry[]> {
    return this.store.read((file) => {
      const q = opts.query?.toLowerCase();
      const scopeSet = new Set(opts.scope ?? []);
      const candidates = file.entries.filter((e) => {
        if (e.supersededBy) return false;
        if (opts.category && e.category !== opts.category) return false;
        if (opts.key && e.key.toLowerCase() !== opts.key.toLowerCase()) return false;
        if (q) {
          const hay = `${e.key}\n${e.value}\n${(e.tags ?? []).join(" ")}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        if (scopeSet.size > 0 && e.scope) {
          const hit = e.scope.some(
            (s) => scopeSet.has(s) || [...scopeSet].some((ss) => globMatch(ss, s) || globMatch(s, ss))
          );
          if (!hit) return false;
        }
        return true;
      });
      candidates.sort((a, b) => {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        return b.createdAt - a.createdAt;
      });
      return candidates.slice(0, opts.limit ?? 50);
    });
  }

  /**
   * Remember a new fact. If an existing entry has the same (category, key),
   * it's marked superseded — the older one stays as historical record but
   * doesn't surface in recall() anymore.
   */
  async remember(input: Omit<MemoryEntry, "id" | "createdAt">): Promise<MemoryEntry> {
    return this.store.update((file) => {
      const now = Date.now();
      const id = randomUUID();
      const entry: MemoryEntry = { ...input, id, createdAt: now };
      for (const old of file.entries) {
        if (!old.supersededBy && old.category === entry.category && old.key === entry.key && old.id !== id) {
          old.supersededBy = id;
          old.supersededAt = now;
        }
      }
      file.entries.push(entry);
      return entry;
    });
  }

  /**
   * Bulk-write a batch of entries in one lock acquisition. The post-fleet
   * "atlas update" hook uses this — typically 10-30 file → purpose mappings
   * after a single PR merge.
   */
  async rememberBatch(entries: Array<Omit<MemoryEntry, "id" | "createdAt">>): Promise<MemoryEntry[]> {
    return this.store.update((file) => {
      const now = Date.now();
      const out: MemoryEntry[] = [];
      for (const input of entries) {
        const id = randomUUID();
        const entry: MemoryEntry = { ...input, id, createdAt: now };
        for (const old of file.entries) {
          if (
            !old.supersededBy &&
            old.category === entry.category &&
            old.key === entry.key &&
            old.id !== id
          ) {
            old.supersededBy = id;
            old.supersededAt = now;
          }
        }
        file.entries.push(entry);
        out.push(entry);
      }
      return out;
    });
  }

  async forget(id: string): Promise<boolean> {
    return this.store.update((file) => {
      const entry = file.entries.find((e) => e.id === id);
      if (!entry || entry.supersededBy) return false;
      entry.supersededBy = "(forgotten)";
      entry.supersededAt = Date.now();
      return true;
    });
  }

  /**
   * Compose a memory block to inject into a spawned Agnet's system prompt.
   * Picks pinned entries first, then category-balanced relevant entries up
   * to maxChars. Returns markdown ready to splice into a prompt.
   */
  async composeContextBlock(opts: { scope?: string[]; maxChars?: number }): Promise<string> {
    const max = opts.maxChars ?? 2000;
    const all = await this.list();
    const pinned = all.filter((e) => e.pinned);
    const byCat: Record<MemoryCategory, MemoryEntry[]> = {
      lore: [],
      playbook: [],
      ledger: [],
      atlas: [],
    };
    for (const e of all) if (!e.pinned) byCat[e.category].push(e);
    const scopeSet = new Set(opts.scope ?? []);
    const rank = (e: MemoryEntry): number => {
      let s = 0;
      if (e.scope && scopeSet.size > 0) {
        for (const s1 of e.scope) {
          for (const s2 of scopeSet) {
            if (s1 === s2 || globMatch(s1, s2) || globMatch(s2, s1)) s += 5;
          }
        }
      }
      s += Date.now() - e.createdAt < 7 * 86400_000 ? 2 : 0;
      return s;
    };
    for (const cat of Object.keys(byCat) as MemoryCategory[]) {
      byCat[cat].sort((a, b) => rank(b) - rank(a));
    }
    const blocks: string[] = [];
    let used = 0;
    const push = (s: string) => {
      if (used + s.length > max) return false;
      blocks.push(s);
      used += s.length;
      return true;
    };
    if (pinned.length > 0) {
      push("## Pinned facts (read these every time)\n");
      for (const e of pinned) {
        if (!push(`- **${e.key}** (${e.category}): ${e.value}\n`)) break;
      }
    }
    for (const cat of ["lore", "playbook", "atlas", "ledger"] as MemoryCategory[]) {
      const items = byCat[cat].slice(0, 6);
      if (items.length === 0) continue;
      push(`\n## ${cat}\n`);
      for (const e of items) {
        if (!push(`- **${e.key}**: ${e.value}${e.rationale ? ` _(why: ${e.rationale})_` : ""}\n`)) break;
      }
    }
    return blocks.join("");
  }
}

/**
 * Tiny glob matcher — supports `**`, `*`, and literal chars. Used to score
 * scope overlap. Not perfect; intentionally permissive to keep recall noisy
 * rather than silent.
 */
function globMatch(pattern: string, candidate: string): boolean {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const re = "^" + esc.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$";
  try {
    return new RegExp(re).test(candidate);
  } catch {
    return false;
  }
}
