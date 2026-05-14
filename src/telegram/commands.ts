import { StateStore, type Plan } from "../lib/state.js";
import { snapshotSession } from "../lib/jsonl_tail.js";
import { TelegramApi } from "./api.js";
import { loadConfig, saveConfig, isAuthorized } from "./config.js";
import type { TelegramMessage } from "./api.js";

/**
 * Telegram command handlers.
 *
 * Supported commands (all require whitelisted sender):
 *   /start        — register the sender (one-shot welcome)
 *   /help         — list commands
 *   /plans        — list active plans in the watched project(s)
 *   /status <id>  — refreshed status of one plan
 *   /show <id>    — full plan JSON (truncated)
 *   /notes <id>   — recent notes for a plan
 *   /kill <plan> <task> <reason>  — STOP a task
 *   /whitelist <user_id> [label]  — owner-only: add a user
 *   /approve <plan_id> <token>    — confirm a plan from Telegram (future)
 *
 * Each project's state is read via StateStore against that project's path.
 * The single configured set of watchedProjects determines which projects are
 * accessible. For v0.3 we support a single watched project at a time; the
 * config schema is forward-compatible for multi-project later.
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
  // /start is open: it just prints the sender's ID so they can be whitelisted later.
  if (text === "/start") {
    await api.sendMessage(
      chatId,
      `👋 orqlaude bot.\n\nYour Telegram user id: \`${userId}\`\n\nAsk the bot owner to whitelist you with:\n\`orqlaude tg whitelist ${userId}\`\n\nOr if you ARE the owner and haven't set yourself up yet:\n\`orqlaude tg whitelist ${userId} --owner\``,
      { parseMode: "Markdown" }
    );
    return;
  }

  if (!isAuthorized(cfg, userId)) {
    await api.sendMessage(chatId, `⛔ Unauthorized. Your user id is ${userId}. Owner must whitelist you.`);
    return;
  }

  const stateStore = new StateStore(`${projectDir}/.orqlaude`);

  if (text === "/help") {
    await api.sendMessage(
      chatId,
      [
        "*orqlaude commands*",
        "`/plans` — list active plans",
        "`/status <plan_id>` — refresh one plan",
        "`/show <plan_id>` — raw plan JSON",
        "`/notes <plan_id>` — recent agent notes",
        "`/kill <plan> <task> <reason>` — STOP a task",
        "`/whoami` — your user id",
        "`/help` — this",
      ].join("\n"),
      { parseMode: "Markdown" }
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
      return `• \`${p.id.slice(0, 8)}\` ${p.status} ${done}/${p.tasks.length} — ${truncate(p.rootTask, 50)}`;
    });
    await api.sendMessage(chatId, `*Active plans:*\n${lines.join("\n")}`, { parseMode: "Markdown" });
    return;
  }

  // /status <plan_id> ---------------------------------------------------------
  if (text.startsWith("/status")) {
    const planId = text.split(/\s+/)[1];
    if (!planId) return api.sendMessage(chatId, "usage: /status <plan_id>");
    try {
      const plan = await stateStore.read((s) => requirePlan(s.plans, planId));
      await api.sendMessage(chatId, await renderStatus(plan, projectDir), { parseMode: "Markdown" });
    } catch (err) {
      await api.sendMessage(chatId, `error: ${(err as Error).message}`);
    }
    return;
  }

  if (text.startsWith("/show")) {
    const planId = text.split(/\s+/)[1];
    if (!planId) return api.sendMessage(chatId, "usage: /show <plan_id>");
    try {
      const plan = await stateStore.read((s) => requirePlan(s.plans, planId));
      const json = JSON.stringify(plan, null, 2);
      await api.sendMessage(chatId, "```json\n" + truncate(json, 3500) + "\n```", { parseMode: "Markdown" });
    } catch (err) {
      await api.sendMessage(chatId, `error: ${(err as Error).message}`);
    }
    return;
  }

  if (text.startsWith("/notes")) {
    const planId = text.split(/\s+/)[1];
    if (!planId) return api.sendMessage(chatId, "usage: /notes <plan_id>");
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
      await api.sendMessage(chatId, `*Recent notes for ${planId.slice(0, 8)}:*\n${lines.join("\n\n")}`, {
        parseMode: "Markdown",
      });
    } catch (err) {
      await api.sendMessage(chatId, `error: ${(err as Error).message}`);
    }
    return;
  }

  // /kill <plan> <task> <reason...>
  if (text.startsWith("/kill")) {
    const parts = text.split(/\s+/);
    const [, planId, taskId, ...reasonParts] = parts;
    const reason = reasonParts.join(" ") || "killed from Telegram";
    if (!planId || !taskId) return api.sendMessage(chatId, "usage: /kill <plan_id> <task_id> <reason>");
    try {
      await stateStore.update((s) => {
        const plan = requirePlan(s.plans, planId);
        const task = plan.tasks.find((t) => t.id === taskId);
        if (!task) throw new Error(`task ${taskId} not in plan ${planId}`);
        if (!task.spawnedSessionId) {
          task.status = "cancelled";
        } else {
          task.stopRequested = { reason, requestedAt: Date.now() };
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
    if (!Number.isFinite(targetId)) return api.sendMessage(chatId, "usage: /whitelist <user_id> [label]");
    const label = rest.join(" ") || undefined;
    if (!cfg.whitelist.some((w) => w.userId === targetId)) {
      cfg.whitelist.push({ userId: targetId, chatId: targetId, label });
      await saveConfig(cfg);
    }
    await api.sendMessage(chatId, `✓ Whitelisted ${targetId}${label ? ` (${label})` : ""}.`);
    return;
  }

  // Default: unknown command
  if (text.startsWith("/")) {
    await api.sendMessage(chatId, `unknown command. /help for the list.`);
  }
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
    `*${plan.id.slice(0, 8)}* — ${plan.status}`,
    `${truncate(plan.rootTask, 80)}`,
    `tokens: ${tokK}k / ${capK}k`,
    ...taskLines,
  ].join("\n");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
