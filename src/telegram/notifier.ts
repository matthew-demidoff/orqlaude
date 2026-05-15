import { promises as fs } from "node:fs";
import path from "node:path";
import { StateStore, type Plan, type UserResponseRequest, type UserStream } from "../lib/state.js";
import { TelegramApi, type InlineKeyboardButton } from "./api.js";
import { agnetLabel } from "../lib/agnet.js";
import { readPreferences } from "../lib/preferences.js";
import { localNotification } from "../lib/notifications.js";
import type { TelegramConfig } from "./config.js";

/**
 * Notifier: polls state for changes and pushes diffs to whitelisted chats.
 *
 * v0.10.1: NO MARKDOWN. The Markdown-V1 parser was eating special chars in
 * code paths (parens, dots, dashes inside backticks) and silently failing
 * the send for some messages — users reported phantom "delivered: false"
 * states. We send everything as plain text now. Inline keyboards still work
 * fine because they're a separate transport field, and bold/italic visual
 * styling was never worth the breakage cost. If we ever want rich text
 * back we'll switch to HTML mode (which is more robust than MD-V1).
 *
 * v0.10.1 also moves the primary "answer a question" UX from inline
 * keyboards to Telegram's native reply-to-message. Notifier sends the
 * question with `forceReply: true`; the user's reply carries
 * `reply_to_message.message_id` which `commands.ts` matches back to the
 * UserResponseRequest. Inline keyboards are still attached when `options`
 * are provided as a quick-pick shortcut.
 */

interface NotifierCursor {
  initialized: boolean;
  lastNoteId: string | null;
  taskStatus: Record<string, string>;
  planStatus: Record<string, string>;
  alertedHallucinations: string[];
  notifiedUserNotificationIds: string[];
  notifiedUserRequestIds: string[];
  notifiedUserStreamIds: string[];
}

const STREAM_EDIT_THROTTLE_MS = 1500;

const EMPTY_CURSOR: NotifierCursor = {
  initialized: false,
  lastNoteId: null,
  taskStatus: {},
  planStatus: {},
  alertedHallucinations: [],
  notifiedUserNotificationIds: [],
  notifiedUserRequestIds: [],
  notifiedUserStreamIds: [],
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
    const { plans, orphanNotifications, orphanResponseRequests } = await store.read((s) => ({
      plans: Object.values(s.plans),
      orphanNotifications: s.orphanNotifications ?? [],
      orphanResponseRequests: s.orphanResponseRequests ?? [],
    }));

    // First-tick seed: silently snapshot current state, no messages.
    if (!cursor.initialized) {
      for (const plan of plans) {
        cursor.planStatus[plan.id] = plan.status;
        for (const task of plan.tasks) cursor.taskStatus[task.id] = task.status;
        if (plan.notes.length > 0) cursor.lastNoteId = plan.notes[plan.notes.length - 1].id;
        for (const n of plan.userNotifications) cursor.notifiedUserNotificationIds.push(n.id);
        for (const r of plan.userResponseRequests) cursor.notifiedUserRequestIds.push(r.id);
        for (const s of plan.userStreams) cursor.notifiedUserStreamIds.push(s.id);
      }
      cursor.initialized = true;
      await this.saveCursor();
      return;
    }

    const plainMessages: string[] = [];
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
            `📋 New plan ${plan.id.slice(0, 8)} — ${plan.tasks.length} task(s)\n${truncate(plan.rootTask, 100)}`
          );
        } else if (plan.status === "approved" && prevStatus !== "approved") {
          plainMessages.push(`✅ Approved ${plan.id.slice(0, 8)} — spawning ${plan.tasks.length} agents`);
        } else if (plan.status === "collected") {
          const total = plan.tasks.length;
          const done = plan.tasks.filter((t) => t.status === "done").length;
          plainMessages.push(`🎉 Collected ${plan.id.slice(0, 8)} — ${done}/${total} tasks done`);
        } else if (plan.status === "cancelled_overbudget") {
          plainMessages.push(`💸 Auto-cancelled ${plan.id.slice(0, 8)} — fleet exceeded token budget`);
        } else if (plan.status === "cancelled") {
          plainMessages.push(`❌ Cancelled ${plan.id.slice(0, 8)}`);
        }
        cursor.planStatus[plan.id] = plan.status;
      }

      for (const task of plan.tasks) {
        const prev = cursor.taskStatus[task.id];
        if (prev !== task.status) {
          const agnet = agnetLabel(task.agnetName);
          const title = truncate(task.title, 50);
          if (task.status === "done") {
            const prSuffix = task.prUrl ? `\n${task.prUrl}` : "";
            plainMessages.push(`✓ ${agnet} finished — ${title}${prSuffix}`);
          } else if (task.status === "failed") {
            plainMessages.push(
              `❌ ${agnet} failed — ${title}${task.exitReason ? `\n${task.exitReason}` : ""}`
            );
          } else if (task.status === "cancelled") {
            plainMessages.push(`🛑 ${agnet} cancelled — ${title}`);
          } else if (task.status === "running" && prev === "dispatched") {
            plainMessages.push(`▶ ${agnet} started — ${title}`);
          }
          cursor.taskStatus[task.id] = task.status;
        }
      }

      // ---- agent (Agnet) notes ----
      let foundLast = cursor.lastNoteId === null;
      for (const note of plan.notes) {
        if (!foundLast) {
          if (note.id === cursor.lastNoteId) foundLast = true;
          continue;
        }
        const task = plan.tasks.find((t) => t.id === note.taskId);
        const agnet = agnetLabel(task?.agnetName);
        const blocking = note.blocking ? " 🟡 blocking" : "";
        plainMessages.push(
          `📝 ${agnet}${blocking}\n${truncate(note.text, 300)}${note.prUrl ? `\n${note.prUrl}` : ""}`
        );
        cursor.lastNoteId = note.id;
      }

      // ---- user notifications ----
      for (const n of plan.userNotifications) {
        if (cursor.notifiedUserNotificationIds.includes(n.id)) continue;
        const emoji = URGENCY_EMOJI[n.urgency] ?? URGENCY_EMOJI.normal;
        plainMessages.push(`${emoji} ${n.text}`);
        cursor.notifiedUserNotificationIds.push(n.id);
      }

      // ---- user response requests ----
      for (const r of plan.userResponseRequests) {
        if (cursor.notifiedUserRequestIds.includes(r.id)) continue;
        if (r.cancelled || r.response !== undefined) {
          cursor.notifiedUserRequestIds.push(r.id);
          continue;
        }
        const text = buildQuestionText(r);
        const inlineKeyboard = r.options ? buildInlineKeyboard(r.shortId, r.options) : undefined;
        questionPushes.push({ req: r, text, inlineKeyboard });
        cursor.notifiedUserRequestIds.push(r.id);
      }
    }

    // ---- orphan notifications (no plan_id) ----
    for (const n of orphanNotifications) {
      if (cursor.notifiedUserNotificationIds.includes(n.id)) continue;
      const emoji = URGENCY_EMOJI[n.urgency] ?? URGENCY_EMOJI.normal;
      plainMessages.push(`${emoji} ${n.text}`);
      cursor.notifiedUserNotificationIds.push(n.id);
    }
    for (const r of orphanResponseRequests) {
      if (cursor.notifiedUserRequestIds.includes(r.id)) continue;
      if (r.cancelled || r.response !== undefined) {
        cursor.notifiedUserRequestIds.push(r.id);
        continue;
      }
      const text = buildQuestionText(r);
      const inlineKeyboard = r.options ? buildInlineKeyboard(r.shortId, r.options) : undefined;
      questionPushes.push({ req: r, text, inlineKeyboard });
      cursor.notifiedUserRequestIds.push(r.id);
    }

    await this.saveCursor();

    // Send plain notifications. NO parse_mode — v0.10.1 ships plain text.
    for (const entry of this.cfg.whitelist) {
      for (const msg of plainMessages) {
        try {
          await this.api.sendMessage(entry.chatId, msg);
        } catch (err) {
          process.stderr.write(`[orqlaude tg notifier] send to ${entry.chatId} failed: ${(err as Error).message}\n`);
        }
      }
    }

    // Local macOS notifications (opt-in).
    try {
      const prefs = await readPreferences();
      if (prefs.localNotifications && plainMessages.length > 0) {
        for (const msg of plainMessages) {
          const { title, body } = splitForNotification(msg);
          localNotification(title, body, "orqlaude");
        }
      }
    } catch {
      /* swallow */
    }

    // Streams.
    for (const plan of plans) {
      for (const stream of plan.userStreams) {
        const isNew = !cursor.notifiedUserStreamIds.includes(stream.id);
        const hasNewContent = stream.lastDeliveredContent !== stream.content;
        const justEnded = stream.status === "ended" && !stream.finalSent;
        if (!isNew && !hasNewContent && !justEnded) continue;
        const now = Date.now();
        if (!isNew && !justEnded && stream.lastEditedAt && now - stream.lastEditedAt < STREAM_EDIT_THROTTLE_MS) {
          continue;
        }
        for (const entry of this.cfg.whitelist) {
          await openOrEditEditMode(this.api, store, stream, entry.chatId, justEnded);
        }
        if (isNew) cursor.notifiedUserStreamIds.push(stream.id);
      }
    }

    // Send question pushes. Plain text + optional inline keyboard.
    // forceReply pops Telegram's input pre-targeted at this message so the
    // user can just type without remembering /respond syntax.
    for (const qp of questionPushes) {
      for (const entry of this.cfg.whitelist) {
        try {
          // If we have inline-keyboard options, those take precedence over
          // forceReply (Telegram won't let us set both). Otherwise use
          // forceReply to bias the user toward replying to this message.
          const useForceReply = !qp.inlineKeyboard;
          const { message_id } = await this.api.sendMessage(entry.chatId, qp.text, {
            inlineKeyboard: qp.inlineKeyboard,
            forceReply: useForceReply,
          });
          if (qp.req.telegramMessageId === undefined) {
            await store.update((state) => {
              const all = [
                ...Object.values(state.plans).flatMap((p) => p.userResponseRequests),
                ...(state.orphanResponseRequests ?? []),
              ];
              const r = all.find((x) => x.id === qp.req.id);
              if (r) {
                r.telegramMessageId = message_id;
                r.telegramChatId = entry.chatId;
                r.delivered = true;
                r.deliveredAt = Date.now();
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

/**
 * Build the plain-text body of a question message. v0.10.1: tells the user
 * to REPLY to this message (using Telegram's native reply UI) — that's the
 * primary path. If `options` are set, an inline keyboard is also attached
 * as a quick-pick.
 */
function buildQuestionText(r: UserResponseRequest): string {
  const lines: string[] = [];
  lines.push(`❓ ${r.prompt}`);
  if (r.options && r.options.length > 0) {
    lines.push("");
    lines.push("Tap a button below, OR reply to this message with your answer.");
  } else {
    lines.push("");
    lines.push("Reply to this message with your answer.");
  }
  // Show the short id for fallback /respond use, but in plain text.
  lines.push("");
  lines.push(`(id: ${r.shortId})`);
  return lines.join("\n");
}

function formatStreamMessage(stream: UserStream): string {
  // No Markdown — plain text title + body.
  const body = stream.content ? `\n${stream.content}` : "";
  return `${stream.title}${body}`;
}

function formatStreamEnded(stream: UserStream): string {
  const body = stream.content ? `\n${stream.content}` : "";
  return `${stream.title} ✓${body}`;
}

async function openOrEditEditMode(
  api: TelegramApi,
  store: StateStore,
  stream: UserStream,
  chatId: number,
  justEnded: boolean
): Promise<void> {
  if (!stream.telegramMessageId) {
    try {
      const { message_id } = await api.sendMessage(chatId, formatStreamMessage(stream));
      await store.update((state) => {
        for (const p of Object.values(state.plans)) {
          const s = p.userStreams.find((x) => x.id === stream.id);
          if (s) {
            s.transport = "edit";
            s.telegramMessageId = message_id;
            s.telegramChatId = chatId;
            s.lastDeliveredContent = stream.content;
            s.lastEditedAt = Date.now();
          }
        }
      });
      if (justEnded) {
        try {
          await api.editMessageText(chatId, message_id, formatStreamEnded(stream));
          await store.update((state) => {
            for (const p of Object.values(state.plans)) {
              const s = p.userStreams.find((x) => x.id === stream.id);
              if (s) s.finalSent = true;
            }
          });
        } catch (err) {
          process.stderr.write(`[orqlaude tg stream] edit-mode final edit failed: ${(err as Error).message}\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`[orqlaude tg stream] edit-mode open failed: ${(err as Error).message}\n`);
    }
    return;
  }

  try {
    const text = justEnded ? formatStreamEnded(stream) : formatStreamMessage(stream);
    await api.editMessageText(stream.telegramChatId!, stream.telegramMessageId, text);
    await store.update((state) => {
      for (const p of Object.values(state.plans)) {
        const s = p.userStreams.find((x) => x.id === stream.id);
        if (s) {
          s.lastDeliveredContent = text;
          s.lastEditedAt = Date.now();
          if (justEnded) s.finalSent = true;
        }
      }
    });
  } catch (err) {
    process.stderr.write(`[orqlaude tg stream] edit-mode update failed: ${(err as Error).message}\n`);
  }
}

function splitForNotification(msg: string): { title: string; body: string } {
  // No Markdown to strip anymore, but keep the line-split logic.
  const plain = msg.trim();
  const newlineAt = plain.indexOf("\n");
  if (newlineAt === -1 || newlineAt > 80) {
    return { title: plain.slice(0, 80), body: plain.length > 80 ? plain.slice(80, 280) : "" };
  }
  return { title: plain.slice(0, newlineAt).slice(0, 80), body: plain.slice(newlineAt + 1, newlineAt + 280) };
}

function buildInlineKeyboard(shortId: string, options: string[]): InlineKeyboardButton[][] {
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
 * Retained as an exported no-op for back-compat — older code (and any
 * third-party plugin we don't know about) imports `escapeMd` from here.
 * v0.10.1 doesn't ship Markdown anymore so escaping is a pass-through.
 */
export function escapeMd(s: string): string {
  return s;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
