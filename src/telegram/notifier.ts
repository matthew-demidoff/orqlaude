import { promises as fs } from "node:fs";
import path from "node:path";
import { StateStore, type Plan } from "../lib/state.js";
import { TelegramApi } from "./api.js";
import type { TelegramConfig } from "./config.js";

/**
 * Notifier: polls state for changes and pushes diffs to whitelisted chats.
 *
 * v0.3.1 fixes:
 *   • Markdown escaping (`escapeMd`) so a `_` or `*` in a task title/note
 *     doesn't make sendMessage 400, swallow the error, and lose the message.
 *   • First-tick seed: on initial run with an empty cursor, snapshot the
 *     current task/plan statuses and last note id into the cursor WITHOUT
 *     emitting messages. This prevents replaying every previously-completed
 *     plan as "just happened" on bot startup.
 *   • Cursor write retains atomic mode-600 just for symmetry with the
 *     token file; the cursor itself is non-secret.
 */

interface NotifierCursor {
  initialized: boolean;
  lastNoteId: string | null;
  taskStatus: Record<string, string>;
  planStatus: Record<string, string>;
  alertedHallucinations: string[];
}

const EMPTY_CURSOR: NotifierCursor = {
  initialized: false,
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
    const tmp = `${this.cursorPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.cursor, null, 2));
    await fs.rename(tmp, this.cursorPath);
  }

  /** One pass: detect deltas, push notifications, advance cursor. */
  async tick(): Promise<void> {
    if (this.cfg.whitelist.length === 0) return;
    const cursor = await this.loadCursor();
    const store = new StateStore(path.join(this.projectDir, ".orqlaude"));
    const plans: Plan[] = await store.read((s) => Object.values(s.plans));

    // First-tick seed: silently snapshot current state, no messages.
    if (!cursor.initialized) {
      for (const plan of plans) {
        cursor.planStatus[plan.id] = plan.status;
        for (const task of plan.tasks) cursor.taskStatus[task.id] = task.status;
        if (plan.notes.length > 0) cursor.lastNoteId = plan.notes[plan.notes.length - 1].id;
      }
      cursor.initialized = true;
      await this.saveCursor();
      return;
    }

    const messages: string[] = [];

    for (const plan of plans) {
      const prevStatus = cursor.planStatus[plan.id];
      if (prevStatus !== plan.status) {
        if (!prevStatus && plan.status === "draft") {
          messages.push(`📋 *New plan* \`${plan.id.slice(0, 8)}\` — ${plan.tasks.length} task(s)\n${escapeMd(truncate(plan.rootTask, 100))}`);
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

      for (const task of plan.tasks) {
        const prev = cursor.taskStatus[task.id];
        if (prev !== task.status) {
          if (task.status === "done") {
            const prSuffix = task.prUrl ? `\n${task.prUrl}` : "";
            messages.push(`✓ *${escapeMd(truncate(task.title, 60))}* — done${prSuffix}`);
          } else if (task.status === "failed") {
            messages.push(`❌ *${escapeMd(truncate(task.title, 60))}* — failed${task.exitReason ? `\n${escapeMd(task.exitReason)}` : ""}`);
          } else if (task.status === "cancelled") {
            messages.push(`🛑 *${escapeMd(truncate(task.title, 60))}* — cancelled`);
          }
          cursor.taskStatus[task.id] = task.status;
        }
      }

      // New notes after the last-seen id.
      let foundLast = cursor.lastNoteId === null;
      for (const note of plan.notes) {
        if (!foundLast) {
          if (note.id === cursor.lastNoteId) foundLast = true;
          continue;
        }
        const taskTitle = plan.tasks.find((t) => t.id === note.taskId)?.title ?? note.taskId.slice(0, 8);
        const blocking = note.blocking ? " 🟡 blocking" : "";
        messages.push(
          `📝 *${escapeMd(truncate(taskTitle, 50))}*${blocking}\n${escapeMd(truncate(note.text, 300))}${note.prUrl ? `\n${note.prUrl}` : ""}`
        );
        cursor.lastNoteId = note.id;
      }
    }

    // Save cursor BEFORE sending so a failed send won't re-spam on retry.
    await this.saveCursor();

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

/**
 * Escape characters that Telegram MarkdownV1 treats as syntax.
 *
 * Per https://core.telegram.org/bots/api#markdown-style, V1's reserved set is
 * `_ * ` ` [`. Without escaping these in user-supplied strings, an innocuous
 * branch name like `feature/foo_bar` or a note containing a single `*` makes
 * sendMessage 400 → notifier swallows the error → cursor already advanced →
 * notification permanently lost.
 *
 * URL text (e.g. PR links) is appended raw and not run through this escaper,
 * because backslashing chars in URLs breaks them. Keep URL fragments out of
 * this function's input.
 */
export function escapeMd(s: string): string {
  return s.replace(/([_*`\[])/g, "\\$1");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
