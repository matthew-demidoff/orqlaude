import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isProcessAlive, sleep } from "./process_lib.js";

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

export type TaskStatus =
  | "pending"
  | "dispatched"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  /** v0.7.0+: spawn_via_cli succeeded the initial process-create but the
   *  child exited before producing any JSONL. status() flips a task here
   *  when PID is dead AND last_activity_at is null. */
  | "died_at_launch";
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
  /** v0.5.3+: filesystem path of the worktree this Agnet is running in.
   *  Populated when spawned via spawn_via_cli; null for host-spawned. */
  worktreePath?: string;
  /** v0.5.3+: feature branch the worktree is on. */
  worktreeBranch?: string;
  /** v0.7.0+: detached child PID. status() uses this to detect children
   *  that died silently. */
  pid?: number;
  /** v0.7.0+: shell-quoted command line spawn_via_cli actually ran. Useful
   *  for the orchestrator to reproduce a failure by hand. */
  commandLine?: string;
  /** v0.7.0+: paths to the captured stdout/stderr log files. */
  stderrPath?: string;
  stdoutPath?: string;
  /**
   * v0.9.0+: path to the per-task exit-record file written by the
   * `child.on('exit')` handler in spawn_via_cli. Read as a fast-path
   * in status() instead of waiting on a poll cycle.
   */
  exitJsonPath?: string;
  /** v0.5+: Human-friendly Agnet designation (e.g. "Zenith"). Used in CLI
   *  output and Telegram notifications. Stable per task_id. */
  agnetName?: string;
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
 * v0.5+: Streamed message from primary Claude to user. A stream is a long-
 * running message that gets *edited in place* as new chunks arrive — the
 * Telegram-shaped equivalent of a streamed assistant reply.
 *
 * Lifecycle:
 *   1. stream_to_user_start writes the initial record + first content.
 *      Notifier sends the message and records telegramMessageId.
 *   2. stream_to_user_append adds a chunk to `content`. Notifier edits the
 *      Telegram message on its next tick (throttled to ~1 edit/1.5s by
 *      Telegram rate limits).
 *   3. stream_to_user_end finalizes. Notifier does a final edit with an
 *      "✓ complete" marker.
 */
export interface UserStream {
  id: string;
  shortId: string;
  taskId?: string;
  /** Title shown in bold at the top of the message (e.g. "Agnet Verdant"). */
  title: string;
  /** Full accumulated content. */
  content: string;
  status: "active" | "ended";
  createdAt: number;
  endedAt?: number;
  /** v0.5.1 added a sendMessageDraft transport which was reverted in v0.5.4.
   *  Field retained for backward-compatible deserialization of old state files. */
  draftId?: number;
  /** v0.5.1 added "draft" alongside "edit". v0.5.4 removed the draft path;
   *  only "edit" remains in use. Field retained for back-compat. */
  transport?: "draft" | "edit";
  /** Per-chat persistence so the notifier knows which message to edit. */
  telegramChatId?: number;
  telegramMessageId?: number;
  /** v0.5.1+: whether the stream's final persisted message has been sent. */
  finalSent?: boolean;
  /** Last delivered content snapshot (so notifier knows what to send / edit). */
  lastDeliveredContent?: string;
  lastEditedAt?: number;
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
  /** v0.5+: streaming-message records (edit-in-place Telegram messages). */
  userStreams: UserStream[];
  reviewPlanId?: string;
}

export interface State {
  schemaVersion: 3;
  plans: Record<string, Plan>;
  /**
   * v0.9.0+: notifications + response requests that aren't bound to any
   * plan (e.g. session-startup pings, ad-hoc "I'm done" messages from the
   * orchestrator). The notifier daemon drains these the same way it
   * drains per-plan notifications.
   */
  orphanNotifications?: UserNotification[];
  orphanResponseRequests?: UserResponseRequest[];
}

const EMPTY_STATE: State = { schemaVersion: 3, plans: {}, orphanNotifications: [], orphanResponseRequests: [] };
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

  /**
   * v0.8.0: every acquisition mints a fresh per-instance UUID and writes it
   * into the lock file alongside the PID. Release uses that UUID to confirm
   * we still own the lock before deleting; if another process reclaimed
   * the lock as "stale" while we were working, we leave it alone instead of
   * deleting THEIR lock and exposing a race window to a third process.
   */
  private currentLockToken: string | null = null;

  private async acquireFileLock(): Promise<void> {
    await fs.mkdir(path.dirname(this.lockPath), { recursive: true });
    const start = Date.now();
    const token = randomUUID();
    while (Date.now() - start < LOCK_TIMEOUT_MS) {
      try {
        const fh = await fs.open(this.lockPath, "wx", 0o600);
        // PID on line 1 (for stale-PID reclaim), token on line 2 (for
        // ownership verification on release), timestamp on line 3.
        await fh.write(`${process.pid}\n${token}\n${Date.now()}\n`);
        await fh.close();
        this.currentLockToken = token;
        return;
      } catch (err: any) {
        if (err.code !== "EEXIST") throw err;
        // Lock exists. Check if it's stale (PID no longer alive).
        try {
          const held = (await fs.readFile(this.lockPath, "utf8")).split("\n")[0]?.trim();
          const heldPid = parseInt(held ?? "", 10);
          if (Number.isFinite(heldPid) && !isProcessAlive(heldPid)) {
            // Race-safe stale-lock reclaim: only delete if the file STILL
            // contains the same PID (in case the legitimate holder rewrote
            // it between our reads).
            try {
              const recheck = (await fs.readFile(this.lockPath, "utf8")).split("\n")[0]?.trim();
              if (recheck === String(heldPid)) {
                await fs.unlink(this.lockPath).catch(() => {});
              }
            } catch {
              /* race: file gone; retry will succeed */
            }
            continue;
          }
        } catch {
          /* race: someone deleted/rewrote the file before we read. retry. */
        }
        await sleep(LOCK_RETRY_BASE_MS + Math.random() * LOCK_RETRY_BASE_MS);
      }
    }
    throw new Error(`orqlaude: could not acquire state lock (${this.lockPath}) within ${LOCK_TIMEOUT_MS}ms`);
  }

  private async releaseFileLock(): Promise<void> {
    const myToken = this.currentLockToken;
    this.currentLockToken = null;
    if (!myToken) {
      await fs.unlink(this.lockPath).catch(() => {});
      return;
    }
    try {
      const content = await fs.readFile(this.lockPath, "utf8");
      const heldToken = content.split("\n")[1]?.trim();
      if (heldToken !== myToken) {
        // The lock was reclaimed by another process (or our entry was
        // overwritten). Don't unlink — we'd nuke their lock and let a third
        // process race in.
        return;
      }
      await fs.unlink(this.lockPath);
    } catch {
      /* already gone; not fatal */
    }
  }

  private async persist(state: State): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
    this.cache = state;
  }
}

/** Forward-compatible migration from earlier schemas. v1 → v3 in one pass. */
function migrate(input: Partial<State> & { schemaVersion?: number }): State {
  const v = input.schemaVersion ?? 1;
  if (v === 3 && input.plans) {
    // v0.9.0: backfill orphan arrays so older v3 state files load cleanly.
    const out = input as State;
    out.orphanNotifications = out.orphanNotifications ?? [];
    out.orphanResponseRequests = out.orphanResponseRequests ?? [];
    return out;
  }
  const out: State = {
    schemaVersion: 3,
    plans: {},
    orphanNotifications: input.orphanNotifications ?? [],
    orphanResponseRequests: input.orphanResponseRequests ?? [],
  };
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
      userStreams: p.userStreams ?? [],
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
    userStreams: [],
  };
}

export function findUserStream(state: State, streamId: string): { plan: Plan; stream: UserStream } | undefined {
  for (const plan of Object.values(state.plans)) {
    const stream = plan.userStreams.find((s) => s.id === streamId || s.shortId === streamId);
    if (stream) return { plan, stream };
  }
  return undefined;
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
