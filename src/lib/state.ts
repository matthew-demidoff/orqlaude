import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * orqlaude state store — single JSON file per project, atomically written.
 *
 * Why JSON not SQLite: state is small (a fleet rarely has more than ~10 agents,
 * a handful of notes/messages), and atomic JSON writes via tmp+rename are
 * sufficient for the concurrency we expect (handful of MCP calls per second).
 * If contention becomes a problem, swap to node:sqlite without changing the
 * external API of this module.
 *
 * Schema version 2 (v0.2.0): tokens-first budget, file claims, audit
 * resumability hooks.
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
  // Cost / token tracking — populated from JSONL tail.
  costUsd?: number;
  tokensUsed?: number;
  startedAt?: number;
  finishedAt?: number;
  prUrl?: string;
  summary?: string;
  exitReason?: string;
  // STOP signal for kill_task. Delivered on next checkin.
  stopRequested?: { reason: string; requestedAt: number };
}

export interface Note {
  id: string;
  fromSessionId: string;
  taskId: string;
  text: string;
  blocking: boolean;
  postedAt: number;
  acked: boolean;
  prUrl?: string; // optional: PR url attached via post_note (mirrored to task)
}

export interface Message {
  id: string;
  toSessionId: string;
  fromTaskId?: string;
  text: string;
  queuedAt: number;
  delivered: boolean;
  deliveredAt?: number;
  kind?: "directed" | "stop"; // "stop" → child agent must terminate
}

export interface FileClaim {
  path: string;          // canonical path (absolute, normalized)
  claimedBy: string;     // session id of the claiming agent
  taskId: string;
  reason?: string;
  claimedAt: number;
}

export interface Plan {
  id: string;
  createdAt: number;
  rootTask: string;
  // Token budget (Max-friendly). USD remains tracked but isn't the gate.
  budgetCapTokens: number;
  perAgentCapTokens: number;
  estimatedTokens?: number;
  // USD informational fields (carried for legacy / non-Max users).
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
  reviewPlanId?: string; // populated when review_prs spawns a review fleet
}

export interface State {
  schemaVersion: 2;
  plans: Record<string, Plan>;
}

const EMPTY_STATE: State = { schemaVersion: 2, plans: {} };

export class StateStore {
  private filePath: string;
  private cache: State | null = null;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "orqlaude-state.json");
  }

  private async load(): Promise<State> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<State>;
      this.cache = migrate(parsed);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        this.cache = structuredClone(EMPTY_STATE);
      } else {
        throw err;
      }
    }
    return this.cache!;
  }

  async update<T>(mutator: (state: State) => T | Promise<T>): Promise<T> {
    let release: () => void = () => {};
    const next = new Promise<void>((res) => (release = res));
    const prev = this.writeLock;
    this.writeLock = prev.then(() => next);
    await prev;
    try {
      const state = await this.load();
      const result = await mutator(state);
      await this.persist(state);
      return result;
    } finally {
      release();
    }
  }

  async read<T>(reader: (state: State) => T): Promise<T> {
    const state = await this.load();
    return reader(state);
  }

  private async persist(state: State): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.rename(tmp, this.filePath);
    this.cache = state;
  }
}

/** Forward-compatible migration from earlier schemas. */
function migrate(input: Partial<State> & { schemaVersion?: number }): State {
  const v = input.schemaVersion ?? 1;
  if (v === 2 && input.plans) return input as State;
  // v1 → v2: synthesize token fields from USD if missing.
  const out: State = { schemaVersion: 2, plans: {} };
  for (const [id, plan] of Object.entries(input.plans ?? {})) {
    const p = plan as Plan & { budgetCapUsd?: number; perAgentCapUsd?: number };
    out.plans[id] = {
      ...p,
      budgetCapTokens: p.budgetCapTokens ?? Math.round((p.budgetCapUsd ?? 5) * 25_000), // rough $0.04/k
      perAgentCapTokens: p.perAgentCapTokens ?? Math.round((p.perAgentCapUsd ?? 1) * 25_000),
      claims: p.claims ?? [],
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
  };
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

/** Locate the plan+task a given child session belongs to. */
export function planForSession(state: State, sessionId: string): { plan: Plan; task: Task } | undefined {
  for (const plan of Object.values(state.plans)) {
    const task = findTaskBySession(plan, sessionId);
    if (task) return { plan, task };
  }
  return undefined;
}

/**
 * Find a dispatched-but-unclaimed task by task_id. Used for self-registration:
 * when a freshly-spawned child agent calls `checkin` with its task_id (which we
 * embed in the spawn prompt), we can adopt it.
 */
export function unclaimedTaskById(state: State, taskId: string): { plan: Plan; task: Task } | undefined {
  for (const plan of Object.values(state.plans)) {
    const task = plan.tasks.find((t) => t.id === taskId && !t.spawnedSessionId);
    if (task) return { plan, task };
  }
  return undefined;
}

/** Normalize a path for claim comparison (handle . , .. , trailing slash, case). */
export function normalizeClaimPath(p: string, cwd: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  return path.normalize(abs);
}
