import { StateStore, type Plan, findUserResponseRequest } from "../lib/state.js";
import { snapshotSession } from "../lib/jsonl_tail.js";
import { TelegramApi } from "./api.js";
import { loadConfig, saveConfig, isAuthorized } from "./config.js";
import path from "node:path";
import type { TelegramMessage, TelegramCallbackQuery } from "./api.js";

/**
 * Telegram command handlers.
 *
 * v0.10.1: NO MARKDOWN anywhere. All replies are plain text. Three answer
 * paths for questions:
 *   1. Native reply-to-message (PRIMARY) — user replies to the question
 *      message; we match by reply_to_message.message_id.
 *   2. Inline-keyboard button — when the question has `options`, callback_query
 *      resolves the request by shortId.
 *   3. /respond <short_id> <text> — legacy fallback for power users; never
 *      removed because it's the only path that works in group chats with
 *      multiple bots, etc.
 *
 * Slash commands:
 *   /start, /help, /whoami, /plans, /status <id>, /show <id>, /notes <id>,
 *   /kill <plan> <task> <reason>, /whitelist <user_id> [label], /respond
 */

export async function handleCommand(
  api: TelegramApi,
  msg: TelegramMessage,
  projectDir: string
): Promise<void> {
  const text = (msg.text ?? "").trim();
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!userId) return;

  const cfg = await loadConfig();
  if (text === "/start") {
    await api.sendMessage(
      chatId,
      `👋 orqlaude bot.\n\nYour Telegram user id: ${userId}\n\nAsk the bot owner to whitelist you with:\norqlaude tg whitelist ${userId}\n\nOr if you ARE the owner and haven't set yourself up yet:\norqlaude tg whitelist ${userId} --owner`
    );
    return;
  }

  if (!isAuthorized(cfg, userId)) {
    await api.sendMessage(chatId, `⛔ Unauthorized. Your user id is ${userId}. Owner must whitelist you.`);
    return;
  }

  // v0.10.1: reply-to-message is the primary answer path. Before slash-command
  // dispatch, check if this message is a reply to a known question. If so,
  // resolve that request and bail — don't try to parse the body as a command.
  if (msg.reply_to_message?.message_id && text && !text.startsWith("/")) {
    const handled = await tryHandleReplyToQuestion(api, msg, projectDir);
    if (handled) return;
    // If we didn't find a matching question, fall through to the slash-command
    // dispatcher so legitimate /respond etc. still works.
  }

  const stateStore = new StateStore(`${projectDir}/.orqlaude`);

  if (text === "/help") {
    await api.sendMessage(
      chatId,
      [
        "orqlaude commands:",
        "/plans — list active plans",
        "/status <plan_id> — refresh one plan",
        "/show <plan_id> — raw plan JSON",
        "/notes <plan_id> — recent agent notes",
        "/kill <plan> <task> <reason> — STOP a task",
        "/whoami — your user id",
        "/help — this",
        "",
        "To answer a question, REPLY TO THE MESSAGE in Telegram with your answer.",
        "Or tap an inline-keyboard button if the question has options.",
        "/respond <short_id> <text> still works as a fallback.",
      ].join("\n")
    );
    return;
  }

  if (text === "/whoami") {
    await api.sendMessage(chatId, `user_id: ${userId}\nproject: ${projectDir}`);
    return;
  }

  if (text === "/plans") {
    const plans = await stateStore.read((s) =>
      Object.values(s.plans)
        .filter((p) => p.status !== "collected")
        .sort((a, b) => b.createdAt - a.createdAt)
    );
    if (plans.length === 0) {
      await api.sendMessage(chatId, "No active plans.");
      return;
    }
    const lines = plans.map((p) => {
      const done = p.tasks.filter((t) => t.status === "done").length;
      return `• ${p.id.slice(0, 8)} ${p.status} ${done}/${p.tasks.length} — ${truncate(p.rootTask, 50)}`;
    });
    await api.sendMessage(chatId, `Active plans:\n${lines.join("\n")}`);
    return;
  }

  if (text.startsWith("/status")) {
    const planId = text.split(/\s+/)[1];
    if (!planId) return void await api.sendMessage(chatId, "usage: /status <plan_id>");
    try {
      const plan = await stateStore.read((s) => requirePlan(s.plans, planId));
      await api.sendMessage(chatId, await renderStatus(plan, projectDir));
    } catch (err) {
      await api.sendMessage(chatId, `error: ${(err as Error).message}`);
    }
    return;
  }

  if (text.startsWith("/show")) {
    const planId = text.split(/\s+/)[1];
    if (!planId) return void await api.sendMessage(chatId, "usage: /show <plan_id>");
    try {
      const plan = await stateStore.read((s) => requirePlan(s.plans, planId));
      const json = JSON.stringify(plan, null, 2);
      await api.sendMessage(chatId, truncate(json, 3800));
    } catch (err) {
      await api.sendMessage(chatId, `error: ${(err as Error).message}`);
    }
    return;
  }

  if (text.startsWith("/notes")) {
    const planId = text.split(/\s+/)[1];
    if (!planId) return void await api.sendMessage(chatId, "usage: /notes <plan_id>");
    try {
      const plan = await stateStore.read((s) => requirePlan(s.plans, planId));
      const recent = plan.notes.slice(-10);
      if (recent.length === 0) {
        await api.sendMessage(chatId, "(no notes yet)");
        return;
      }
      const lines = recent.map((n) => {
        const taskTitle = plan.tasks.find((t) => t.id === n.taskId)?.title ?? n.taskId.slice(0, 8);
        const blocking = n.blocking ? (n.acked ? "✓" : "🟡") : "";
        return `• [${truncate(taskTitle, 30)}]${blocking} ${truncate(n.text, 200)}${n.prUrl ? `\n  ${n.prUrl}` : ""}`;
      });
      await api.sendMessage(chatId, `Recent notes for ${planId.slice(0, 8)}:\n${lines.join("\n\n")}`);
    } catch (err) {
      await api.sendMessage(chatId, `error: ${(err as Error).message}`);
    }
    return;
  }

  if (text.startsWith("/kill")) {
    const parts = text.split(/\s+/);
    const [, planId, taskId, ...reasonParts] = parts;
    const reason = reasonParts.join(" ") || "killed from Telegram";
    if (!planId || !taskId) return void await api.sendMessage(chatId, "usage: /kill <plan_id> <task_id> <reason>");
    try {
      await stateStore.update((s) => {
        const plan = requirePlan(s.plans, planId);
        const task = plan.tasks.find((t) => t.id === taskId);
        if (!task) throw new Error(`task ${taskId} not in plan ${planId}`);
        if (!task.spawnedSessionId) {
          task.status = "cancelled";
        } else {
          task.stopRequested = { reason, requestedAt: Date.now(), kind: "hard" };
          plan.messages.push({
            id: crypto.randomUUID(),
            toSessionId: task.spawnedSessionId,
            text: `STOP: ${reason}. Commit what you have and exit.`,
            queuedAt: Date.now(),
            delivered: false,
            kind: "stop",
          });
        }
      });
      await api.sendMessage(chatId, `🛑 STOP queued for task ${taskId.slice(0, 8)}: ${reason}`);
    } catch (err) {
      await api.sendMessage(chatId, `error: ${(err as Error).message}`);
    }
    return;
  }

  if (text.startsWith("/whitelist")) {
    if (cfg.ownerId !== userId) {
      await api.sendMessage(chatId, "Only the owner can manage the whitelist.");
      return;
    }
    const [, target, ...rest] = text.split(/\s+/);
    const targetId = Number(target);
    if (!Number.isFinite(targetId)) return void await api.sendMessage(chatId, "usage: /whitelist <user_id> [label]");
    const label = rest.join(" ") || undefined;
    if (!cfg.whitelist.some((w) => w.userId === targetId)) {
      cfg.whitelist.push({ userId: targetId, chatId: targetId, label });
      await saveConfig(cfg);
    }
    await api.sendMessage(chatId, `✓ Whitelisted ${targetId}${label ? ` (${label})` : ""}.`);
    return;
  }

  // Legacy /respond <short_id> <text>.
  if (text.startsWith("/respond")) {
    const m = text.match(/^\/respond\s+(\S+)\s+([\s\S]+)$/);
    if (!m) return void await api.sendMessage(chatId, "usage: /respond <short_id> <your answer>");
    const [, shortId, answer] = m;
    await resolveQuestionByShortId(api, chatId, shortId, answer, projectDir);
    return;
  }

  if (text.startsWith("/")) {
    await api.sendMessage(chatId, `unknown command. /help for the list.`);
  }
}

/**
 * v0.10.1: try to match a non-slash message that's a reply-to of a bot
 * message to a pending UserResponseRequest. Returns true if matched.
 */
async function tryHandleReplyToQuestion(
  api: TelegramApi,
  msg: TelegramMessage,
  projectDir: string
): Promise<boolean> {
  const repliedToId = msg.reply_to_message?.message_id;
  if (!repliedToId) return false;
  const answer = (msg.text ?? "").trim();
  if (!answer) return false;
  const chatId = msg.chat.id;
  const store = new StateStore(path.join(projectDir, ".orqlaude"));
  let resolvedShortId: string | null = null;
  let editTarget: { chatId: number; messageId: number } | null = null;
  const status = await store.update((state) => {
    const all = [
      ...Object.values(state.plans).flatMap((p) => p.userResponseRequests),
      ...(state.orphanResponseRequests ?? []),
    ];
    const req = all.find((r) => r.telegramMessageId === repliedToId && r.telegramChatId === chatId);
    if (!req) return "no_match";
    if (req.response !== undefined) return "already_answered";
    if (req.cancelled) return "cancelled";
    if (Date.now() > req.timeoutAt) return "timed_out";
    req.response = answer;
    req.respondedAt = Date.now();
    resolvedShortId = req.shortId;
    if (req.telegramMessageId && req.telegramChatId) {
      editTarget = { chatId: req.telegramChatId, messageId: req.telegramMessageId };
    }
    return "ok";
  });
  if (status === "no_match") return false;
  if (status === "ok" && resolvedShortId) {
    // Acknowledge with a small ✓ message rather than spamming a long confirmation.
    await api.sendMessage(chatId, `✓ Answer recorded (${resolvedShortId}).`);
    if (editTarget) {
      const e = editTarget as { chatId: number; messageId: number };
      await api.editMessageText(
        e.chatId,
        e.messageId,
        `✓ Answered (${resolvedShortId}): ${truncate(answer, 200)}`
      );
    }
    return true;
  }
  // Recognized as a reply-to but not actionable — surface the status.
  await api.sendMessage(chatId, `reply to question ${repliedToId}: ${status}`);
  return true;
}

/**
 * Inline-keyboard tap handler. callback_data format: `orq:resp:<shortId>:<optionIdx>`.
 */
export async function handleCallbackQuery(
  api: TelegramApi,
  q: TelegramCallbackQuery,
  projectDir: string
): Promise<void> {
  const cfg = await loadConfig();
  const userId = q.from?.id;
  if (!userId || !isAuthorized(cfg, userId)) {
    await api.answerCallbackQuery(q.id, "Unauthorized.");
    return;
  }
  const data = q.data ?? "";
  const m = data.match(/^orq:resp:([^:]+):(\d+)$/);
  if (!m) {
    await api.answerCallbackQuery(q.id, "unknown action");
    return;
  }
  const [, shortId, idxStr] = m;
  const idx = Number(idxStr);
  const store = new StateStore(path.join(projectDir, ".orqlaude"));
  let answer: string | null = null;
  let editTarget: { chatId: number; messageId: number } | null = null;
  const status = await store.update((state) => {
    const found = findUserResponseRequest(state, shortId);
    if (!found) return "not_found";
    const { req } = found;
    if (req.response !== undefined) return "already_answered";
    if (req.cancelled) return "cancelled";
    if (Date.now() > req.timeoutAt) return "timed_out";
    if (!req.options || idx >= req.options.length) return "bad_option";
    answer = req.options[idx];
    req.response = answer;
    req.respondedAt = Date.now();
    if (req.telegramMessageId && req.telegramChatId) {
      editTarget = { chatId: req.telegramChatId, messageId: req.telegramMessageId };
    }
    return "ok";
  });
  if (status === "ok" && answer !== null) {
    await api.answerCallbackQuery(q.id, `✓ ${answer as string}`);
    if (editTarget) {
      const e = editTarget as { chatId: number; messageId: number };
      await api.editMessageText(
        e.chatId,
        e.messageId,
        `✓ Answered (${shortId}): ${answer as string}`
      );
    }
  } else {
    await api.answerCallbackQuery(q.id, status);
  }
}

/**
 * Shared resolution: by shortId (used by both /respond and tryHandleReplyToQuestion
 * fallback). Plain-text everywhere.
 */
async function resolveQuestionByShortId(
  api: TelegramApi,
  chatId: number,
  shortId: string,
  answer: string,
  projectDir: string
): Promise<void> {
  const store = new StateStore(path.join(projectDir, ".orqlaude"));
  let editTarget: { chatId: number; messageId: number } | null = null;
  const status = await store.update((state) => {
    const found = findUserResponseRequest(state, shortId);
    if (!found) return "not_found";
    const { req } = found;
    if (req.response !== undefined) return "already_answered";
    if (req.cancelled) return "cancelled";
    if (Date.now() > req.timeoutAt) return "timed_out";
    req.response = answer;
    req.respondedAt = Date.now();
    if (req.telegramMessageId && req.telegramChatId) {
      editTarget = { chatId: req.telegramChatId, messageId: req.telegramMessageId };
    }
    return "ok";
  });
  if (status === "ok") {
    await api.sendMessage(chatId, `✓ Response recorded for ${shortId}.`);
    if (editTarget) {
      const e = editTarget as { chatId: number; messageId: number };
      await api.editMessageText(
        e.chatId,
        e.messageId,
        `✓ Answered (${shortId}): ${truncate(answer, 200)}`
      );
    }
  } else if (status === "not_found") {
    await api.sendMessage(chatId, `no request with short_id ${shortId}`);
  } else {
    await api.sendMessage(chatId, `request ${shortId}: ${status}`);
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function requirePlan(plans: Record<string, Plan>, planId: string): Plan {
  const full = plans[planId] ?? Object.values(plans).find((p) => p.id.startsWith(planId));
  if (!full) throw new Error(`plan not found: ${planId}`);
  return full;
}

async function renderStatus(plan: Plan, projectDir: string): Promise<string> {
  let totalTokens = 0;
  const taskLines: string[] = [];
  for (const t of plan.tasks) {
    let extra = "";
    if (t.spawnedSessionId) {
      const snap = await snapshotSession(projectDir, t.spawnedSessionId);
      totalTokens += snap.totalEffectiveTokens;
      const tokK = Math.round(snap.totalEffectiveTokens / 1000);
      const flag = snap.terminated ? "✓" : "▶";
      extra = ` ${flag} ${tokK}k`;
    }
    const prSuffix = t.prUrl ? ` 📎` : "";
    taskLines.push(`  • ${truncate(t.title, 35)}${extra}${prSuffix}`);
  }
  const tokK = Math.round(totalTokens / 1000);
  const capK = Math.round(plan.budgetCapTokens / 1000);
  return [
    `${plan.id.slice(0, 8)} — ${plan.status}`,
    truncate(plan.rootTask, 80),
    `tokens: ${tokK}k / ${capK}k`,
    ...taskLines,
  ].join("\n");
}
