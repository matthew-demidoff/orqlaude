import path from "node:path";
import { randomUUID } from "node:crypto";
import { JsonStore } from "./json_store.js";

/**
 * Backlog — a durable queue of Goals the autopilot daemon picks from when
 * the fleet is idle. Separate from main state for the same reason memory is:
 * different lifecycle, different write cadence, simpler lock budget.
 *
 * A `Goal` is a one-line description of something the user eventually wants
 * done. When the daemon's spawn-loop ticks and nothing is in flight, it
 * picks the next unblocked goal in priority order, spawns a planner Agnet
 * to decompose it into tasks, presents the plan via Telegram (request_user_response
 * with options approve/edit/skip), and on approval kicks off the fleet.
 *
 * Goals can declare dependencies on other goals (only spawn after dep is
 * "done") and deadlines (priority gets boosted as deadline approaches).
 *
 * Storage: `<state_dir>/backlog.json`, written atomically through `JsonStore`
 * — cross-process lock + mtime invalidation so the CLI (orql backlog add),
 * the autopilot daemon, and the MCP server can all touch it concurrently.
 */

export type GoalStatus =
  | "queued"
  | "planning"      // planner Agnet is spawning a fleet for it
  | "awaiting_approval"
  | "running"       // fleet is mid-flight
  | "done"
  | "cancelled"
  | "deferred";     // user said "not yet"

export interface Goal {
  id: string;
  shortId: string;          // 8-char prefix for human refs
  title: string;
  description?: string;
  priority: number;          // 0-100; higher = sooner
  /** Optional ISO timestamp; daemon boosts priority as deadline approaches. */
  deadlineAt?: number;
  /** Other goal ids that must finish first. */
  dependsOn?: string[];
  /** Scope hint — path globs the resulting fleet will likely touch. Used
   *  to inject relevant memory into the planner Agnet's prompt and to
   *  detect conflicts with currently-running fleets. */
  scope?: string[];
  /** Suggested fleet template (see lib/templates.ts). Optional; planner Agnet
   *  may override. */
  template?: string;
  tags?: string[];
  createdAt: number;
  status: GoalStatus;
  /** Plan id once the planner Agnet has produced one. */
  planId?: string;
  /** Telegram message id where this goal was approved / discussed. */
  telegramThreadId?: string;
  /** Who put this in the backlog. "user" / "claude" / "system". */
  source: string;
  startedAt?: number;
  finishedAt?: number;
  outcome?: { ok: boolean; note?: string; prUrls?: string[] };
}

export interface BacklogFile {
  schemaVersion: 1;
  goals: Goal[];
}

const EMPTY: BacklogFile = { schemaVersion: 1, goals: [] };

export class BacklogStore {
  private store: JsonStore<BacklogFile>;

  constructor(stateDir: string) {
    this.store = new JsonStore<BacklogFile>({
      filePath: path.join(stateDir, "backlog.json"),
      empty: EMPTY,
      migrate: (raw) => {
        const parsed = raw as Partial<BacklogFile> | undefined;
        if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.goals)) {
          return parsed as BacklogFile;
        }
        return EMPTY;
      },
    });
  }

  async list(opts: { status?: GoalStatus | GoalStatus[]; limit?: number } = {}): Promise<Goal[]> {
    return this.store.read((file) => {
      const statuses = Array.isArray(opts.status)
        ? new Set(opts.status)
        : opts.status
        ? new Set([opts.status])
        : null;
      const out = file.goals.filter((g) => (statuses ? statuses.has(g.status) : true));
      out.sort((a, b) => {
        const pa = effectivePriority(a);
        const pb = effectivePriority(b);
        if (pa !== pb) return pb - pa;
        return b.createdAt - a.createdAt;
      });
      return out.slice(0, opts.limit ?? 200);
    });
  }

  async findById(id: string): Promise<Goal | undefined> {
    return this.store.read((file) => file.goals.find((g) => g.id === id || g.shortId === id));
  }

  async enqueue(
    input: Omit<Goal, "id" | "shortId" | "createdAt" | "status"> & { status?: GoalStatus }
  ): Promise<Goal> {
    return this.store.update((file) => {
      const id = randomUUID();
      const shortId = id.slice(0, 8);
      const goal: Goal = {
        ...input,
        id,
        shortId,
        createdAt: Date.now(),
        status: input.status ?? "queued",
      };
      file.goals.push(goal);
      return goal;
    });
  }

  async update(id: string, mut: (g: Goal) => void): Promise<Goal | undefined> {
    return this.store.update((file) => {
      const goal = file.goals.find((g) => g.id === id || g.shortId === id);
      if (!goal) return undefined;
      mut(goal);
      return goal;
    });
  }

  /**
   * Pick the next goal the autopilot daemon should work on. Returns undefined
   * if nothing is ready (all queued goals are blocked by deps, or backlog is
   * empty).
   */
  async pickNext(): Promise<Goal | undefined> {
    const all = await this.list();
    const done = new Set(all.filter((g) => g.status === "done").map((g) => g.id));
    const queued = all.filter((g) => g.status === "queued");
    for (const g of queued) {
      const deps = g.dependsOn ?? [];
      if (deps.every((d) => done.has(d))) return g;
    }
    return undefined;
  }
}

/**
 * Effective priority = base + deadline boost.
 *
 * Boost = 30 * clamp(0, 1, (1 - daysUntilDeadline / 7)). i.e. if the deadline
 * is a week away, no boost. Day-of, +30. Day-after, capped at +30. This makes
 * a priority-50 goal naturally float to the top as its deadline nears, even
 * if a priority-70 goal is sitting behind it without a deadline.
 */
function effectivePriority(g: Goal): number {
  let p = g.priority;
  if (g.deadlineAt) {
    const days = (g.deadlineAt - Date.now()) / 86_400_000;
    if (days <= 0) p += 30;
    else if (days < 7) p += Math.round(30 * (1 - days / 7));
  }
  return p;
}
