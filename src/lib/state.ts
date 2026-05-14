import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * orqlaude state store — single JSON file per project, atomically written
 * with cross-process file-lock serialization (v0.3.1+).
 *
 * Concurrency model:
 *   • In-process: a Promise chain (`writeLock`) serializes mutations within
 *     one Node process. Reads also funnel through it so they don't observe
 *     mid-mutation state.
 *   • Cross-process: each mutation grabs a sidecar lock file (`<dir>/lock`)
 *     via fs.open with O_CREAT|O_EXCL. Stale locks (PID no longer alive) are
 *     reclaimed on retry. This serializes orqlaude MCP-server writes against
 *     CLI / Telegram-bot writes against agent self-registrations.
 *   • Atomic writes: tmp file + rename, never partial.
 *   • Rollback: a deep snapshot is taken before each mutator runs; on throw,
 *     the in-memory cache is restored.
 *
 * Schema v2: tokens-first budgets, file claims, lifecycle hooks.
 */

export type TaskStatus = "pending" | "dispatched" | "running" | "done" | "failed" | "cancelled";
export type PlanStatus =
  | "draft"
  | "estimating"
  | "awaiting_approval"
  | "approved"
  | "dispatching"
  | "running"
  | "collected"
  | "cancelled"
  | "cancelled_overbudget";

export interface Task {
  id: string;
  title: string;
  prompt: string;
  tldr: string;
  scope?: string[];
  branchHint?: string;
  status: TaskStatus;
  spawnedSessionId?: string;
  /** Optional per-task token budget hint. If set, status() surfaces a soft
   *  warning when usage exceeds 70% of this value, separate from the
   *  plan-wide hard cap. */
  budgetHintTokens?: number;
  costUsd?: number;
  tokensUsed?: number;
  startedAt?: number;
  finishedAt?: number;
  prUrl?: string;
  summary?: string;
  exitReason?: string;
  stopRequested?: { reason: string; requestedAt: number; kind: "hard" | "soft" };
}

export interface Note {
  id: string;
  fromSessionId: string;
  taskId: string;
  text: string;
  blocking: boolean;
  postedAt: number;
  acked: boolean;
  prUrl?: string;
}

export interface Message {
  id: string;
  toSessionId: string;
  fromTaskId?: string;
  text: string;
  queuedAt: number;
  delivered: boolean;
  deliveredAt?: number;
  /**
   * - `directed`: informational message; agent reads and continues.
   * - `stop`: hard stop; agent must commit what it has and exit immediately.
   * - `soft_stop`: polite request to wind down; agent should finish the
   *   current operation, commit, push, then exit. Used by request_stop.
   */
  kind?: "directed" | "stop" | "soft_stop";
}

export interface FileClaim {
  path: string;
  claimedBy: string;
  taskId: string;
  reason?: string;
  claimedAt: number;
}

/**
 * Outbound message from primary Claude to the user. Pushed to Telegram by
 * the notifier on its next tick. Lives on the plan so it can be filtered by
 * which fleet it belongs to.
 */
export interface UserNotification {
  id: string;
  taskId?: string;
  text: string;
  urgency: "low" | "normal" | "high";
  createdAt: number;
  delivered: boolean;
  deliveredAt?: number;
}

/**
 * Outbound question from primary Claude to the user, with an awaited
 * response. The notifier pushes to Telegram (with an inline keyboard if
 * `options` is set). The bot writes the user's choice/text back here on
 * callback_query. Primary Claude polls via `poll_user_response`.
 */
export interface UserResponseRequest {
  id: string;
  shortId: string;          // first 8 chars of id, used in Telegram for human-friendly ref
  taskId?: string;
  prompt: string;
  options?: string[];
  createdAt: number;
  timeoutAt: number;
  delivered: boolean;
  deliveredAt?: number;
  /** Telegram message_id of the question, so the bot can edit it on response. */
  telegramMessageId?: number;
  telegramChatId?: number;
  response?: string;
  respondedAt?: number;
  cancelled?: boolean;
}

export interface Plan {
  id: string;
  createdAt: number;
  rootTask: string;
  budgetCapTokens: number;
  perAgentCapTokens: number;
  estimatedTokens?: number;
  budgetCapUsd?: number;
  perAgentCapUsd?: number;
  estimatedCostUsd?: number;
  estimatedDurationSec?: number;
  modelForEstimate?: string;
  effortMultiplier?: number;
  status: PlanStatus;
  approvalToken?: string;
  approvedAt?: number;
  tasks: Task[];
  notes: Note[];
  messages: Message[];
  claims: FileClaim[];
  /** v0.4+: outbound notifications / questions from primary Claude to user. */
  userNotifications: UserNotification[];
  userResponseRequests: UserResponseRequest[];
  reviewPlanId?: string;
}

export interface State {
  schemaVersion: 3;
  plans: Record<string, Plan>;
}

const EMPTY_STATE: State = { schemaVersion: 3, plans: {} };
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_BASE_MS = 30;

export class StateStore {
  private filePath: string;
  private lockPath: string;
  private cache: State | null = null;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "orqlaude-state.json");
    this.lockPath = path.join(stateDir, "lock");
  }

  /**
   * Always reload from disk under the lock to defeat cross-process staleness.
   */
  private async loadFresh(): Promise<State> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<State>;
      const state = migrate(parsed);
      this.cache = state;
      return state;
    } catch (err: any) {
      if (err.code === "ENOENT") {
        this.cache = structuredClone(EMPTY_STATE);
        return this.cache;
      }
      throw err;
    }
  }

  /** Read path: still funneled through the writeLock so we never see torn
   *  state from a partially-applied mutator in this process. */
  async read<T>(reader: (state: State) => T): Promise<T> {
    let release: () => void = () => {};
    const next = new Promise<void>((res) => (release = res));
    const prev = this.writeLock;
    this.writeLock = prev.then(() => next);
    await prev;
    try {
      // Cheap path: if we have a cache, use it. Cache is always written
      // through after a successful persist, so it reflects the last
      // committed state.
      const state = this.cache ?? (await this.loadFresh());
      return reader(state);
    } finally {
      release();
    }
  }

  /**
   * Mutate state under both an in-process lock and a cross-process file lock.
   * Re-reads from disk before applying the mutator to pick up writes from
   * other processes (Telegram bot, CLI, fresh MCP invocation). On throw,
   * restores the in-memory cache from the pre-mutation snapshot.
   */
  async update<T>(mutator: (state: State) => T | Promise<T>): Promise<T> {
    let releaseInProcess: () => void = () => {};
    const next = new Promise<void>((res) => (releaseInProcess = res));
    const prev = this.writeLock;
    this.writeLock = prev.then(() => next);
    await prev;
    try {
      await this.acquireFileLock();
      // Always reload from disk under the lock — another process may have
      // written since we last cached.
      const fresh = await this.loadFresh();
      const snapshot = structuredClone(fresh);
      try {
        const result = await mutator(fresh);
        await this.persist(fresh);
        return result;
      } catch (err) {
        // Roll back the in-memory cache to the pre-mutation snapshot so
        // subsequent readers see the correct state.
        this.cache = snapshot;
        throw err;
      } finally {
        await this.releaseFileLock();
      }
    } finally {
      releaseInProcess();
    }
  }

  private async acquireFileLock(): Promise<void> {
    await fs.mkdir(path.dirname(this.lockPath), { recursive: true });
    const start = Date.now();
    while (Date.now() - start < LOCK_TIMEOUT_MS) {
      try {
        const fh = await fs.open(this.lockPath, "wx", 0o600);
        await fh.write(`${process.pid}\n${Date.now()}\n`);
        await fh.close();
        return;
      } catch (err: any) {
        if (err.code !== "EEXIST") throw err;
        // Lock exists. Check if it's stale (PID no longer alive).
        try {
          const held = (await fs.readFile(this.lockPath, "utf8")).split("\n")[0]?.trim();
          const heldPid = parseInt(held ?? "", 10);
          if (Number.isFinite(heldPid) && !isProcessAlive(heldPid)) {
            await fs.unlink(this.lockPath).catch(() => {});
            continue;
          }
        } catch {
          /* race: someone deleted it before we read. retry. */
        }
        await sleep(LOCK_RETRY_BASE_MS + Math.random() * LOCK_RETRY_BASE_MS);
      }
    }
    throw new Error(`orqlaude: could not acquire state lock (${this.lockPath}) within ${LOCK_TIMEOUT_MS}ms`);
  }

  private async releaseFileLock(): Promise<void> {
    await fs.unlink(this.lockPath).catch(() => {
      /* already gone; not fatal */
    });
  }

  private async persist(state: State): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
    this.cache = state;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Forward-compatible migration from earlier schemas. v1 → v3 in one pass. */
function migrate(input: Partial<State> & { schemaVersion?: number }): State {
  const v = input.schemaVersion ?? 1;
  if (v === 3 && input.plans) return input as State;
  const out: State = { schemaVersion: 3, plans: {} };
  for (const [id, plan] of Object.entries(input.plans ?? {})) {
    const p = plan as Plan & { budgetCapUsd?: number; perAgentCapUsd?: number };
    out.plans[id] = {
      ...p,
      budgetCapTokens: p.budgetCapTokens ?? Math.round((p.budgetCapUsd ?? 5) * 25_000),
      perAgentCapTokens: p.perAgentCapTokens ?? Math.round((p.perAgentCapUsd ?? 1) * 25_000),
      tasks: p.tasks ?? [],
      notes: p.notes ?? [],
      messages: p.messages ?? [],
      claims: p.claims ?? [],
      userNotifications: p.userNotifications ?? [],
      userResponseRequests: p.userResponseRequests ?? [],
    } as Plan;
  }
  return out;
}

// ---- Plan helpers (pure functions; mutator-friendly) ----

export function newPlan(
  rootTask: string,
  budgetCapTokens: number,
  tasksInput: Array<Omit<Task, "id" | "status">>
): Plan {
  const tasks: Task[] = tasksInput.map((t) => ({
    ...t,
    id: randomUUID(),
    status: "pending" as const,
  }));
  return {
    id: randomUUID(),
    createdAt: Date.now(),
    rootTask,
    budgetCapTokens,
    perAgentCapTokens: tasks.length > 0 ? Math.floor(budgetCapTokens / tasks.length) : budgetCapTokens,
    status: "draft",
    tasks,
    notes: [],
    messages: [],
    claims: [],
    userNotifications: [],
    userResponseRequests: [],
  };
}

export function findUserResponseRequest(
  state: State,
  requestId: string
): { plan: Plan; req: UserResponseRequest } | undefined {
  for (const plan of Object.values(state.plans)) {
    const req = plan.userResponseRequests.find((r) => r.id === requestId || r.shortId === requestId);
    if (req) return { plan, req };
  }
  return undefined;
}

export function findPlan(state: State, planId: string): Plan {
  const plan = state.plans[planId];
  if (!plan) throw new Error(`Plan not found: ${planId}`);
  return plan;
}

export function findTask(plan: Plan, taskId: string): Task {
  const task = plan.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task not found in plan ${plan.id}: ${taskId}`);
  return task;
}

export function findTaskBySession(plan: Plan, sessionId: string): Task | undefined {
  return plan.tasks.find((t) => t.spawnedSessionId === sessionId);
}

export function planForSession(state: State, sessionId: string): { plan: Plan; task: Task } | undefined {
  for (const plan of Object.values(state.plans)) {
    const task = findTaskBySession(plan, sessionId);
    if (task) return { plan, task };
  }
  return undefined;
}

export function unclaimedTaskById(state: State, taskId: string): { plan: Plan; task: Task } | undefined {
  for (const plan of Object.values(state.plans)) {
    const task = plan.tasks.find((t) => t.id === taskId && !t.spawnedSessionId);
    if (task) return { plan, task };
  }
  return undefined;
}

export function normalizeClaimPath(p: string, cwd: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  return path.normalize(abs);
}
