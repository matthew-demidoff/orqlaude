import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

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
 * Storage: `<state_dir>/memory.json`. Append-only writes; entries are never
 * deleted, only superseded (a new entry with the same key wins).
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
  private filePath: string;
  private cache: MemoryFile | null = null;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "memory.json");
  }

  private async load(): Promise<MemoryFile> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as MemoryFile;
      this.cache = parsed.schemaVersion === 1 ? parsed : EMPTY;
    } catch (err: any) {
      if (err.code === "ENOENT") this.cache = structuredClone(EMPTY);
      else throw err;
    }
    return this.cache!;
  }

  async list(): Promise<MemoryEntry[]> {
    const file = await this.load();
    return file.entries.filter((e) => !e.supersededBy);
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
    const file = await this.load();
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
        const hit = e.scope.some((s) => scopeSet.has(s) || [...scopeSet].some((ss) => globMatch(ss, s) || globMatch(s, ss)));
        if (!hit) return false;
      }
      return true;
    });
    candidates.sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return b.createdAt - a.createdAt;
    });
    return candidates.slice(0, opts.limit ?? 50);
  }

  /**
   * Remember a new fact. If an existing entry has the same (category, key),
   * it's marked superseded — the older one stays as historical record but
   * doesn't surface in recall() anymore.
   */
  async remember(input: Omit<MemoryEntry, "id" | "createdAt">): Promise<MemoryEntry> {
    return this.withLock(async () => {
      const file = await this.loadFresh();
      const now = Date.now();
      const id = randomUUID();
      const entry: MemoryEntry = {
        ...input,
        id,
        createdAt: now,
      };
      // Supersede prior entries with the same (category, key) so recall()
      // returns the latest only.
      for (const old of file.entries) {
        if (!old.supersededBy && old.category === entry.category && old.key === entry.key && old.id !== id) {
          old.supersededBy = id;
          old.supersededAt = now;
        }
      }
      file.entries.push(entry);
      await this.persist(file);
      return entry;
    });
  }

  /**
   * Bulk-write a batch of entries in one lock acquisition. The post-fleet
   * "atlas update" hook uses this — typically 10-30 file → purpose mappings
   * after a single PR merge.
   */
  async rememberBatch(entries: Array<Omit<MemoryEntry, "id" | "createdAt">>): Promise<MemoryEntry[]> {
    return this.withLock(async () => {
      const file = await this.loadFresh();
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
      await this.persist(file);
      return out;
    });
  }

  async forget(id: string): Promise<boolean> {
    return this.withLock(async () => {
      const file = await this.loadFresh();
      const entry = file.entries.find((e) => e.id === id);
      if (!entry || entry.supersededBy) return false;
      entry.supersededBy = "(forgotten)";
      entry.supersededAt = Date.now();
      await this.persist(file);
      return true;
    });
  }

  /**
   * Compose a memory block to inject into a spawned Agnet's system prompt.
   * Picks pinned entries first, then category-balanced relevant entries up
   * to maxChars. Returns markdown ready to splice into a prompt.
   */
  async composeContextBlock(opts: {
    scope?: string[];
    maxChars?: number;
  }): Promise<string> {
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
    // For scope-tagged entries, prefer ones whose scope overlaps with the
    // requested scope. Otherwise recency.
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
      s += (Date.now() - e.createdAt < 7 * 86400_000) ? 2 : 0;
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

  // ---- internals ----------------------------------------------------------

  private async loadFresh(): Promise<MemoryFile> {
    this.cache = null;
    return this.load();
  }

  private async persist(file: MemoryFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
    this.cache = file;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void = () => {};
    const next = new Promise<void>((res) => (release = res));
    const prev = this.writeLock;
    this.writeLock = prev.then(() => next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Tiny glob matcher — supports `**`, `*`, and literal chars. Used to score
 * scope overlap. Not perfect; intentionally permissive to keep recall noisy
 * rather than silent.
 */
function globMatch(pattern: string, candidate: string): boolean {
  // Anchor + escape regex specials, then re-introduce ** and * patterns.
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const re = "^" + esc.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$";
  try {
    return new RegExp(re).test(candidate);
  } catch {
    return false;
  }
}
