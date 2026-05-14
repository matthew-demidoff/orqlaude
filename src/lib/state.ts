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
 */

export type TaskStatus = "pending" | "dispatched" | "running" | "done" | "failed" | "cancelled";
export type PlanStatus = "draft" | "estimating" | "awaiting_approval" | "approved" | "dispatching" | "running" | "collected" | "cancelled";

export interface Task {
  id: string;
  title: string;        // <60 chars; passed to spawn_task as `title`
  prompt: string;       // the full prompt fed to the spawned agent
  tldr: string;         // 1-2 sentence summary; passed to spawn_task as `tldr`
  scope?: string[];     // optional: files/dirs this task touches (informational)
  branchHint?: string;  // optional: suggested branch name
  status: TaskStatus;
  spawnedSessionId?: string;  // populated once register_spawn is called
  costUsd?: number;     // populated from JSONL tail
  startedAt?: number;   // ms epoch
  finishedAt?: number;
  prUrl?: string;       // populated when agent reports PR opened
  summary?: string;     // populated on completion (child's final message or human-written)
  exitReason?: string;
}

export interface Note {
  id: string;
  fromSessionId: string;     // child session that posted
  taskId: string;            // which task it belongs to
  text: string;
  blocking: boolean;         // if true, agent expects an ack before continuing
  postedAt: number;
  acked: boolean;
}

export interface Message {
  id: string;
  toSessionId: string;       // queued for this child session
  fromTaskId?: string;       // optional: from another agent (via broker)
  text: string;
  queuedAt: number;
  delivered: boolean;
  deliveredAt?: number;
}

export interface Plan {
  id: string;
  createdAt: number;
  rootTask: string;          // user's original task description
  budgetCapUsd: number;      // total cap; per-agent cap is budgetCapUsd / tasks.length
  perAgentCapUsd: number;
  estimatedCostUsd?: number;
  estimatedDurationSec?: number;
  status: PlanStatus;
  approvalToken?: string;    // generated at request_approval, consumed at confirm
  approvedAt?: number;
  tasks: Task[];
  notes: Note[];
  messages: Message[];
}

export interface State {
  schemaVersion: 1;
  plans: Record<string, Plan>;  // keyed by plan id
}

const EMPTY_STATE: State = { schemaVersion: 1, plans: {} };

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
      this.cache = JSON.parse(raw) as State;
    } catch (err: any) {
      if (err.code === "ENOENT") {
        this.cache = structuredClone(EMPTY_STATE);
      } else {
        throw err;
      }
    }
    return this.cache!;
  }

  /** Read-modify-write under a serial lock so concurrent MCP calls don't race. */
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

// ---- Plan helpers (pure functions; mutator-friendly) ----

export function newPlan(rootTask: string, budgetCapUsd: number, tasksInput: Array<Omit<Task, "id" | "status">>): Plan {
  const tasks: Task[] = tasksInput.map((t) => ({
    ...t,
    id: randomUUID(),
    status: "pending" as const,
  }));
  return {
    id: randomUUID(),
    createdAt: Date.now(),
    rootTask,
    budgetCapUsd,
    perAgentCapUsd: tasks.length > 0 ? budgetCapUsd / tasks.length : budgetCapUsd,
    status: "draft",
    tasks,
    notes: [],
    messages: [],
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

export function planForSession(state: State, sessionId: string): { plan: Plan; task: Task } | undefined {
  for (const plan of Object.values(state.plans)) {
    const task = findTaskBySession(plan, sessionId);
    if (task) return { plan, task };
  }
  return undefined;
}
