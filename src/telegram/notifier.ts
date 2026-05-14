import { promises as fs } from "node:fs";
import path from "node:path";
import { StateStore, type Plan } from "../lib/state.js";
import { TelegramApi } from "./api.js";
import type { TelegramConfig } from "./config.js";

/**
 * Notifier: polls state files for changes and pushes diffs to whitelisted
 * Telegram chats.
 *
 * Tracks a per-project cursor (`<project>/.orqlaude/telegram-cursor.json`)
 * recording the last note id and per-task status seen. On each tick we read
 * the state and emit messages for:
 *   • newly created plans (status === "draft" first seen)
 *   • plans transitioning to "approved" or "running"
 *   • tasks transitioning to "done", "failed", or "cancelled"
 *   • new notes (only those with id > last seen)
 *   • severe hallucination alerts (when seen for the first time)
 *   • fleet collected (status → "collected")
 *
 * Idempotency: we save the cursor BEFORE sending, so a failed send won't
 * spam. The cost is occasionally missing a notification; that's acceptable.
 */

interface NotifierCursor {
  lastNoteId: string | null;
  taskStatus: Record<string, string>; // task_id → last seen status
  planStatus: Record<string, string>; // plan_id → last seen status
  alertedHallucinations: string[];    // task_ids that were already alerted
}

const EMPTY_CURSOR: NotifierCursor = {
  lastNoteId: null,
  taskStatus: {},
  planStatus: {},
  alertedHallucinations: [],
};

export class Notifier {
  private cursorPath: string;
  private cursor: NotifierCursor | null = null;

  constructor(private projectDir: string, private cfg: TelegramConfig, private api: TelegramApi) {
    this.cursorPath = path.join(projectDir, ".orqlaude", "telegram-cursor.json");
  }

  private async loadCursor(): Promise<NotifierCursor> {
    if (this.cursor) return this.cursor;
    try {
      const raw = await fs.readFile(this.cursorPath, "utf8");
      this.cursor = { ...EMPTY_CURSOR, ...(JSON.parse(raw) as Partial<NotifierCursor>) };
    } catch (err: any) {
      if (err.code === "ENOENT") this.cursor = { ...EMPTY_CURSOR };
      else throw err;
    }
    return this.cursor!;
  }

  private async saveCursor(): Promise<void> {
    if (!this.cursor) return;
    await fs.mkdir(path.dirname(this.cursorPath), { recursive: true });
    const tmp = `${this.cursorPath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.cursor, null, 2));
    await fs.rename(tmp, this.cursorPath);
  }

  /** One pass: detect deltas, push notifications, advance cursor. */
  async tick(): Promise<void> {
    if (this.cfg.whitelist.length === 0) return;
    const cursor = await this.loadCursor();
    const store = new StateStore(path.join(this.projectDir, ".orqlaude"));
    const plans: Plan[] = await store.read((s) => Object.values(s.plans));

    const messages: string[] = [];

    for (const plan of plans) {
      const prevStatus = cursor.planStatus[plan.id];
      // Plan status transitions we care about
      if (prevStatus !== plan.status) {
        if (!prevStatus && plan.status === "draft") {
          messages.push(`📋 *New plan* \`${plan.id.slice(0, 8)}\` — ${plan.tasks.length} task(s)\n${truncate(plan.rootTask, 100)}`);
        } else if (plan.status === "approved" && prevStatus !== "approved") {
          messages.push(`✅ *Approved* \`${plan.id.slice(0, 8)}\` — spawning ${plan.tasks.length} agents`);
        } else if (plan.status === "collected") {
          const total = plan.tasks.length;
          const done = plan.tasks.filter((t) => t.status === "done").length;
          messages.push(`🎉 *Collected* \`${plan.id.slice(0, 8)}\` — ${done}/${total} tasks done`);
        } else if (plan.status === "cancelled_overbudget") {
          messages.push(`💸 *Auto-cancelled* \`${plan.id.slice(0, 8)}\` — fleet exceeded token budget`);
        } else if (plan.status === "cancelled") {
          messages.push(`❌ *Cancelled* \`${plan.id.slice(0, 8)}\``);
        }
        cursor.planStatus[plan.id] = plan.status;
      }

      // Per-task status transitions
      for (const task of plan.tasks) {
        const prev = cursor.taskStatus[task.id];
        if (prev !== task.status) {
          if (task.status === "done") {
            const prSuffix = task.prUrl ? `\n${task.prUrl}` : "";
            messages.push(`✓ *${truncate(task.title, 60)}* — done${prSuffix}`);
          } else if (task.status === "failed") {
            messages.push(`❌ *${truncate(task.title, 60)}* — failed${task.exitReason ? `\n${task.exitReason}` : ""}`);
          } else if (task.status === "cancelled") {
            messages.push(`🛑 *${truncate(task.title, 60)}* — cancelled`);
          }
          cursor.taskStatus[task.id] = task.status;
        }
      }

      // New notes (only after the last-seen note id)
      let foundLast = cursor.lastNoteId === null;
      for (const note of plan.notes) {
        if (!foundLast) {
          if (note.id === cursor.lastNoteId) foundLast = true;
          continue;
        }
        const taskTitle = plan.tasks.find((t) => t.id === note.taskId)?.title ?? note.taskId.slice(0, 8);
        const blocking = note.blocking ? " 🟡 blocking" : "";
        messages.push(`📝 *${truncate(taskTitle, 50)}*${blocking}\n${truncate(note.text, 300)}${note.prUrl ? `\n${note.prUrl}` : ""}`);
        cursor.lastNoteId = note.id;
      }
      // If we never had a cursor, seed it to the last note so we don't blast history.
      if (cursor.lastNoteId === null && plan.notes.length > 0) {
        cursor.lastNoteId = plan.notes[plan.notes.length - 1].id;
      }
    }

    if (messages.length === 0) {
      // still save cursor in case statuses changed but no message produced
      await this.saveCursor();
      return;
    }

    // Save cursor BEFORE sending, to avoid resends on partial failures.
    await this.saveCursor();

    // Push.
    for (const entry of this.cfg.whitelist) {
      for (const msg of messages) {
        try {
          await this.api.sendMessage(entry.chatId, msg, { parseMode: "Markdown" });
        } catch (err) {
          process.stderr.write(`[orqlaude tg notifier] send to ${entry.chatId} failed: ${(err as Error).message}\n`);
        }
      }
    }
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
