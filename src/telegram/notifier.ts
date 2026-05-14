import { promises as fs } from "node:fs";
import path from "node:path";
import { StateStore, type Plan, type UserResponseRequest } from "../lib/state.js";
import { TelegramApi, type InlineKeyboardButton } from "./api.js";
import type { TelegramConfig } from "./config.js";

/**
 * Notifier: polls state for changes and pushes diffs to whitelisted chats.
 *
 * v0.4 adds two new outbound channels:
 *   • `userNotifications` — one-way pushes from primary Claude via notify_user.
 *   • `userResponseRequests` — questions from request_user_response. When
 *     `options` is set, we attach an inline keyboard. Telegram message_id and
 *     chat_id are persisted into the request so the bot can edit the
 *     question on response.
 *
 * v0.3.1 fixes (escapeMd, first-tick seed, atomic cursor) retained.
 */

interface NotifierCursor {
  initialized: boolean;
  lastNoteId: string | null;
  taskStatus: Record<string, string>;
  planStatus: Record<string, string>;
  alertedHallucinations: string[];
  /** v0.4: ids of userNotifications already pushed to Telegram. */
  notifiedUserNotificationIds: string[];
  /** v0.4: ids of userResponseRequests already pushed. */
  notifiedUserRequestIds: string[];
}

const EMPTY_CURSOR: NotifierCursor = {
  initialized: false,
  lastNoteId: null,
  taskStatus: {},
  planStatus: {},
  alertedHallucinations: [],
  notifiedUserNotificationIds: [],
  notifiedUserRequestIds: [],
};

const URGENCY_EMOJI: Record<string, string> = { low: "💬", normal: "📢", high: "🚨" };

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
        for (const n of plan.userNotifications) cursor.notifiedUserNotificationIds.push(n.id);
        for (const r of plan.userResponseRequests) cursor.notifiedUserRequestIds.push(r.id);
      }
      cursor.initialized = true;
      await this.saveCursor();
      return;
    }

    // Plain text messages (no inline keyboard).
    const plainMessages: string[] = [];
    // Response-request messages need persistence of message_id + chat_id.
    // Format: { req, chatId, text, inlineKeyboard? }
    interface QuestionPush {
      req: UserResponseRequest;
      text: string;
      inlineKeyboard?: InlineKeyboardButton[][];
    }
    const questionPushes: QuestionPush[] = [];

    for (const plan of plans) {
      // ---- plan/task status transitions ----
      const prevStatus = cursor.planStatus[plan.id];
      if (prevStatus !== plan.status) {
        if (!prevStatus && plan.status === "draft") {
          plainMessages.push(
            `📋 *New plan* \`${plan.id.slice(0, 8)}\` — ${plan.tasks.length} task(s)\n${escapeMd(truncate(plan.rootTask, 100))}`
          );
        } else if (plan.status === "approved" && prevStatus !== "approved") {
          plainMessages.push(`✅ *Approved* \`${plan.id.slice(0, 8)}\` — spawning ${plan.tasks.length} agents`);
        } else if (plan.status === "collected") {
          const total = plan.tasks.length;
          const done = plan.tasks.filter((t) => t.status === "done").length;
          plainMessages.push(`🎉 *Collected* \`${plan.id.slice(0, 8)}\` — ${done}/${total} tasks done`);
        } else if (plan.status === "cancelled_overbudget") {
          plainMessages.push(`💸 *Auto-cancelled* \`${plan.id.slice(0, 8)}\` — fleet exceeded token budget`);
        } else if (plan.status === "cancelled") {
          plainMessages.push(`❌ *Cancelled* \`${plan.id.slice(0, 8)}\``);
        }
        cursor.planStatus[plan.id] = plan.status;
      }

      for (const task of plan.tasks) {
        const prev = cursor.taskStatus[task.id];
        if (prev !== task.status) {
          if (task.status === "done") {
            const prSuffix = task.prUrl ? `\n${task.prUrl}` : "";
            plainMessages.push(`✓ *${escapeMd(truncate(task.title, 60))}* — done${prSuffix}`);
          } else if (task.status === "failed") {
            plainMessages.push(
              `❌ *${escapeMd(truncate(task.title, 60))}* — failed${task.exitReason ? `\n${escapeMd(task.exitReason)}` : ""}`
            );
          } else if (task.status === "cancelled") {
            plainMessages.push(`🛑 *${escapeMd(truncate(task.title, 60))}* — cancelled`);
          }
          cursor.taskStatus[task.id] = task.status;
        }
      }

      // ---- agent notes ----
      let foundLast = cursor.lastNoteId === null;
      for (const note of plan.notes) {
        if (!foundLast) {
          if (note.id === cursor.lastNoteId) foundLast = true;
          continue;
        }
        const taskTitle = plan.tasks.find((t) => t.id === note.taskId)?.title ?? note.taskId.slice(0, 8);
        const blocking = note.blocking ? " 🟡 blocking" : "";
        plainMessages.push(
          `📝 *${escapeMd(truncate(taskTitle, 50))}*${blocking}\n${escapeMd(truncate(note.text, 300))}${note.prUrl ? `\n${note.prUrl}` : ""}`
        );
        cursor.lastNoteId = note.id;
      }

      // ---- v0.4: user notifications ----
      for (const n of plan.userNotifications) {
        if (cursor.notifiedUserNotificationIds.includes(n.id)) continue;
        const emoji = URGENCY_EMOJI[n.urgency] ?? URGENCY_EMOJI.normal;
        plainMessages.push(`${emoji} ${escapeMd(n.text)}`);
        cursor.notifiedUserNotificationIds.push(n.id);
      }

      // ---- v0.4: user response requests ----
      for (const r of plan.userResponseRequests) {
        if (cursor.notifiedUserRequestIds.includes(r.id)) continue;
        if (r.cancelled || r.response !== undefined) {
          // Already resolved before we got to it; just record so we don't re-send.
          cursor.notifiedUserRequestIds.push(r.id);
          continue;
        }
        const headline = `❓ *Question from orqlaude* \\(${r.shortId}\\)\n${escapeMd(r.prompt)}`;
        const trailer = r.options
          ? ""
          : `\n\nReply with: \`/respond ${r.shortId} <your answer>\``;
        const text = headline + trailer;
        const inlineKeyboard = r.options
          ? buildInlineKeyboard(r.shortId, r.options)
          : undefined;
        questionPushes.push({ req: r, text, inlineKeyboard });
        cursor.notifiedUserRequestIds.push(r.id);
      }
    }

    // Persist cursor BEFORE we attempt sends — so a failed network call
    // doesn't cause re-spam on retry.
    await this.saveCursor();

    // Send plain notifications to every whitelisted chat.
    for (const entry of this.cfg.whitelist) {
      for (const msg of plainMessages) {
        try {
          await this.api.sendMessage(entry.chatId, msg, { parseMode: "Markdown" });
        } catch (err) {
          process.stderr.write(`[orqlaude tg notifier] send to ${entry.chatId} failed: ${(err as Error).message}\n`);
        }
      }
    }

    // Send question pushes. Persist message_id back into state so the bot
    // can edit on response.
    for (const qp of questionPushes) {
      for (const entry of this.cfg.whitelist) {
        try {
          const { message_id } = await this.api.sendMessage(entry.chatId, qp.text, {
            parseMode: "Markdown",
            inlineKeyboard: qp.inlineKeyboard,
          });
          // Save message_id + chat_id of FIRST whitelisted recipient so the
          // bot can edit the question into a "✓ answered" form on response.
          if (qp.req.telegramMessageId === undefined) {
            await store.update((state) => {
              for (const plan of Object.values(state.plans)) {
                const r = plan.userResponseRequests.find((x) => x.id === qp.req.id);
                if (r) {
                  r.telegramMessageId = message_id;
                  r.telegramChatId = entry.chatId;
                  r.delivered = true;
                  r.deliveredAt = Date.now();
                }
              }
            });
          }
        } catch (err) {
          process.stderr.write(`[orqlaude tg notifier] question send to ${entry.chatId} failed: ${(err as Error).message}\n`);
        }
      }
    }
  }
}

function buildInlineKeyboard(shortId: string, options: string[]): InlineKeyboardButton[][] {
  // Two columns max; one row per pair. callback_data format:
  //   orq:resp:<shortId>:<optionIdx>
  // Telegram's callback_data is capped at 64 bytes; shortId (8) + prefix (~10)
  // + index (1-2) is well under.
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < options.length; i += 2) {
    const row: InlineKeyboardButton[] = [
      { text: options[i], callback_data: `orq:resp:${shortId}:${i}` },
    ];
    if (i + 1 < options.length) {
      row.push({ text: options[i + 1], callback_data: `orq:resp:${shortId}:${i + 1}` });
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Escape Telegram MarkdownV1 reserved chars in user-supplied strings:
 * `_ * ` [`. Backslashing parens / hyphens / dots etc. is unnecessary in
 * V1 (those are syntax only in V2 / MarkdownV2).
 */
export function escapeMd(s: string): string {
  return s.replace(/([_*`\[])/g, "\\$1");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
