#!/usr/bin/env node
import path from "node:path";
import { promises as fs } from "node:fs";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { StateStore, type Plan } from "./lib/state.js";
import { AuditLog } from "./lib/audit.js";
import { snapshotSession } from "./lib/jsonl_tail.js";
import { loadConfig, saveConfig, CONFIG_PATH } from "./telegram/config.js";
import { TelegramApi } from "./telegram/api.js";
import { runBot } from "./telegram/bot.js";
import { resolveStateDir } from "./lib/state_dir.js";
import { style, styleStatus, banner } from "./lib/style.js";
import { agnetLabel } from "./lib/agnet.js";

/**
 * orqlaude CLI — read-only inspection of state + audit log + Telegram setup
 * and run.
 *
 * Subcommands:
 *   orqlaude list / status / show / history    — read-only project inspection
 *   orqlaude tg setup / whitelist / start / test / show / help
 *   orqlaude where                              — show resolved state dir
 */

const STATE_DIR_RESOLUTION = resolveStateDir();
const STATE_DIR = STATE_DIR_RESOLUTION.path;

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      printHelp();
      return 0;
    case "list":
      return await cmdList();
    case "status":
      return await cmdStatus(rest[0]);
    case "show":
      return await cmdShow(rest[0]);
    case "history":
      return await cmdHistory(parseLimit(rest));
    case "where":
      return cmdWhere();
    case "tg":
      return await cmdTg(rest);
    default:
      console.error(`Unknown subcommand: ${cmd}`);
      printHelp();
      return 1;
  }
}

function printHelp(): void {
  console.log(banner());
  console.log("");
  console.log(style.bold(style.cream("Inspection")));
  console.log(`  ${style.coral("orqlaude list")}                   List every plan in this project`);
  console.log(`  ${style.coral("orqlaude status")} ${style.sand("<plan_id>")}       Refreshed status of one plan`);
  console.log(`  ${style.coral("orqlaude show")} ${style.sand("<plan_id>")}         Raw plan JSON`);
  console.log(`  ${style.coral("orqlaude history")} ${style.sand("[--limit N]")}    Tail the audit log (default 30)`);
  console.log(`  ${style.coral("orqlaude where")}                  Show resolved state dir (debug)`);
  console.log("");
  console.log(style.bold(style.cream("Telegram")));
  console.log(`  ${style.coral("orqlaude tg setup")}               Configure bot token (interactive)`);
  console.log(`  ${style.coral("orqlaude tg whitelist")} ${style.sand("<id> [--owner] [--label NAME]")}`);
  console.log(`  ${style.coral("orqlaude tg unwhitelist")} ${style.sand("<id>")}`);
  console.log(`  ${style.coral("orqlaude tg show")}                Show current Telegram config`);
  console.log(`  ${style.coral("orqlaude tg test")} ${style.sand("<chat_id>")}      Send a test message`);
  console.log(`  ${style.coral("orqlaude tg start")}               Run the bot (foreground, monitors this project)`);
  console.log(`  ${style.coral("orqlaude tg help")}                Telegram-specific help`);
  console.log("");
  console.log(style.dim(`State dir: ${STATE_DIR}`));
}

// ---- read-only inspection -------------------------------------------------

async function cmdList(): Promise<number> {
  const store = new StateStore(STATE_DIR);
  const plans = await store.read((s) => Object.values(s.plans).sort((a, b) => b.createdAt - a.createdAt));
  if (plans.length === 0) {
    console.log(style.sand("No plans yet in this project."));
    return 0;
  }
  console.log(banner());
  console.log("");
  for (const p of plans) {
    const done = p.tasks.filter((t) => t.status === "done").length;
    const running = p.tasks.filter((t) => t.status === "running" || t.status === "dispatched").length;
    const colored = styleStatus(p.status);
    const status = colored(p.status.padEnd(22));
    const progress = running
      ? `${done}/${p.tasks.length} done, ${style.coral(`${running} running`)}`
      : `${done}/${p.tasks.length} done`;
    console.log(`${style.dim(p.id.slice(0, 8))}…  ${status}  ${progress}  ${style.sand("—")} ${truncate(p.rootTask, 60)}`);
  }
  return 0;
}

async function cmdStatus(planId: string | undefined): Promise<number> {
  if (!planId) {
    console.error("usage: orqlaude status <plan_id>");
    return 2;
  }
  const store = new StateStore(STATE_DIR);
  let plan: Plan;
  try {
    plan = await store.read((s) => requirePlan(s.plans, planId));
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  console.log(banner());
  console.log("");
  console.log(`${style.bold(style.coral("Plan"))} ${style.dim(plan.id)}`);
  console.log(`  ${style.sand("status:")}     ${styleStatus(plan.status)(plan.status)}`);
  console.log(`  ${style.sand("root_task:")}  ${plan.rootTask}`);
  console.log(`  ${style.sand("budget:")}     ${style.cream(plan.budgetCapTokens.toLocaleString())} tokens ${style.dim(`(${Math.round(plan.budgetCapTokens / 1000)}k)`)}`);
  console.log(`  ${style.sand("created:")}    ${style.dim(new Date(plan.createdAt).toISOString())}`);
  if (plan.approvedAt) console.log(`  ${style.sand("approved:")}   ${style.dim(new Date(plan.approvedAt).toISOString())}`);
  console.log(`  ${style.sand("tasks:")}`);
  let totalTokens = 0;
  for (const t of plan.tasks) {
    const agnet = style.coral(agnetLabel(t.agnetName).padEnd(16));
    const tStatus = styleStatus(t.status)(`[${t.status.padEnd(10)}]`);
    let extra = "";
    if (t.spawnedSessionId) {
      const snap = await snapshotSession(process.cwd(), t.spawnedSessionId);
      totalTokens += snap.totalEffectiveTokens;
      const tokens = style.dim(`${snap.totalEffectiveTokens.toLocaleString()}t`);
      const activity = snap.terminated ? style.coral("✓") : style.sand(snap.lastToolUse?.name ?? snap.lastEventType ?? "");
      extra = `  ${tokens}  ${activity}`;
    }
    console.log(`    ${tStatus} ${agnet} ${truncate(t.title, 40).padEnd(40)}${extra}`);
    if (t.prUrl) console.log(`        ${style.sand("PR:")} ${style.cream(t.prUrl)}`);
  }
  console.log(`  ${style.sand("used:")}       ${style.cream(totalTokens.toLocaleString())} tokens`);
  if (plan.notes.length > 0) console.log(`  ${style.sand("notes:")}      ${plan.notes.length}`);
  if (plan.claims.length > 0) console.log(`  ${style.sand("claims:")}     ${plan.claims.length}`);
  return 0;
}

async function cmdShow(planId: string | undefined): Promise<number> {
  if (!planId) {
    console.error("usage: orqlaude show <plan_id>");
    return 2;
  }
  const store = new StateStore(STATE_DIR);
  try {
    const plan = await store.read((s) => requirePlan(s.plans, planId));
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

function cmdWhere(): number {
  console.log(banner());
  console.log("");
  console.log(`  ${style.sand("cwd:")}        ${STATE_DIR_RESOLUTION.cwd}`);
  console.log(`  ${style.sand("state dir:")}  ${style.cream(STATE_DIR_RESOLUTION.path)}`);
  console.log(`  ${style.sand("source:")}     ${style.coral(STATE_DIR_RESOLUTION.source)}`);
  console.log(``);
  console.log(style.dim(`Resolution order: ORQLAUDE_STATE_DIR env > git worktree > project root > ~/.orqlaude/projects/<hash>`));
  return 0;
}

async function cmdHistory(limit: number): Promise<number> {
  const audit = new AuditLog(STATE_DIR);
  const events = await audit.tail(limit);
  if (events.length === 0) {
    console.log("(no audit events yet)");
    return 0;
  }
  for (const e of events) {
    const ts = style.dim(new Date(e.ts).toISOString().slice(11, 19));
    const ok = e.ok ? style.coral("  ok") : style.crimson("ERR ");
    const id = e.planId
      ? style.sand(` plan=${e.planId.slice(0, 8)}`)
      : e.sessionId
      ? style.sand(` sess=${e.sessionId.slice(0, 8)}`)
      : "";
    const tool = style.cream(e.tool.padEnd(22));
    const dur = style.dim(`${e.durationMs.toString().padStart(4)}ms`);
    console.log(`${ts}  ${ok}  ${tool} ${dur}${id}  ${e.resultSummary ? truncate(e.resultSummary, 80) : e.error ?? ""}`);
  }
  return 0;
}

// ---- Telegram subcommands -------------------------------------------------

async function cmdTg(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
      printTgHelp();
      return 0;
    case "setup":
      return await cmdTgSetup();
    case "show":
      return await cmdTgShow();
    case "whitelist":
      return await cmdTgWhitelist(rest);
    case "unwhitelist":
      return await cmdTgUnwhitelist(rest);
    case "test":
      return await cmdTgTest(rest);
    case "start":
      return await cmdTgStart();
    default:
      console.error(`Unknown tg subcommand: ${sub}`);
      printTgHelp();
      return 1;
  }
}

function printTgHelp(): void {
  console.log(`orqlaude tg — Telegram bot

Commands:
  orqlaude tg setup                       Interactively set the bot token
  orqlaude tg show                        Show current config
  orqlaude tg whitelist <user_id> [--owner] [--label NAME]
  orqlaude tg unwhitelist <user_id>
  orqlaude tg test <chat_id>              Send a test message
  orqlaude tg start                       Run the bot (foreground)

Config file: ${CONFIG_PATH}
The bot watches the current working directory's .orqlaude state.`);
}

async function cmdTgSetup(): Promise<number> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const cfg = await loadConfig();
  console.log("Telegram bot setup.\n");
  console.log("1. Open Telegram, search for @BotFather, create a new bot, and copy the token.\n");
  const token = (await rl.question(`Bot token${cfg.botToken ? " (press enter to keep existing)" : ""}: `)).trim();
  if (token) cfg.botToken = token;
  rl.close();
  if (!cfg.botToken) {
    console.error("No token provided.");
    return 1;
  }
  // Verify
  const api = new TelegramApi(cfg.botToken);
  try {
    const me = await api.getMe();
    console.log(`\n✓ Verified: @${me.username} (bot id ${me.id})`);
  } catch (err) {
    console.error(`Failed to verify token: ${(err as Error).message}`);
    return 1;
  }
  await saveConfig(cfg);
  console.log(`Saved to ${CONFIG_PATH} (mode 600).`);
  console.log("\nNext: message your bot with /start in Telegram. It'll print your user id. Then run:");
  console.log(`  orqlaude tg whitelist <your_user_id> --owner`);
  console.log(`Then:`);
  console.log(`  orqlaude tg start`);
  return 0;
}

async function cmdTgShow(): Promise<number> {
  const cfg = await loadConfig();
  console.log(`Telegram config (${CONFIG_PATH}):`);
  console.log(`  bot token:  ${cfg.botToken ? cfg.botToken.slice(0, 8) + "…" : "(not set)"}`);
  console.log(`  owner:      ${cfg.ownerId ?? "(none)"}`);
  console.log(`  whitelist:  ${cfg.whitelist.length} user(s)`);
  for (const w of cfg.whitelist) {
    console.log(`    - ${w.userId}${w.label ? ` (${w.label})` : ""}`);
  }
  return 0;
}

async function cmdTgWhitelist(args: string[]): Promise<number> {
  const userId = Number(args[0]);
  if (!Number.isFinite(userId)) {
    console.error("usage: orqlaude tg whitelist <user_id> [--owner] [--label NAME]");
    return 2;
  }
  const isOwner = args.includes("--owner");
  const labelIdx = args.indexOf("--label");
  const label = labelIdx !== -1 ? args[labelIdx + 1] : undefined;
  const cfg = await loadConfig();
  if (!cfg.whitelist.some((w) => w.userId === userId)) {
    cfg.whitelist.push({ userId, chatId: userId, label });
  }
  if (isOwner) cfg.ownerId = userId;
  await saveConfig(cfg);
  console.log(`✓ Whitelisted ${userId}${label ? ` (${label})` : ""}${isOwner ? " — set as owner" : ""}.`);
  return 0;
}

async function cmdTgUnwhitelist(args: string[]): Promise<number> {
  const userId = Number(args[0]);
  if (!Number.isFinite(userId)) {
    console.error("usage: orqlaude tg unwhitelist <user_id>");
    return 2;
  }
  const cfg = await loadConfig();
  cfg.whitelist = cfg.whitelist.filter((w) => w.userId !== userId);
  if (cfg.ownerId === userId) cfg.ownerId = null;
  await saveConfig(cfg);
  console.log(`✓ Removed ${userId}.`);
  return 0;
}

async function cmdTgTest(args: string[]): Promise<number> {
  const chatId = Number(args[0]);
  if (!Number.isFinite(chatId)) {
    console.error("usage: orqlaude tg test <chat_id>");
    return 2;
  }
  const cfg = await loadConfig();
  if (!cfg.botToken) {
    console.error("No bot token. Run `orqlaude tg setup` first.");
    return 1;
  }
  const api = new TelegramApi(cfg.botToken);
  try {
    await api.sendMessage(chatId, "🦾 orqlaude bot test — if you see this, the wiring works.");
    console.log("✓ Sent.");
    return 0;
  } catch (err) {
    console.error(`Failed: ${(err as Error).message}`);
    return 1;
  }
}

async function cmdTgStart(): Promise<number> {
  try {
    await runBot(process.cwd());
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

// ---- helpers --------------------------------------------------------------

function requirePlan(plans: Record<string, Plan>, planId: string): Plan {
  const full = plans[planId] ?? Object.values(plans).find((p) => p.id.startsWith(planId));
  if (!full) throw new Error(`Plan not found: ${planId}`);
  return full;
}

function parseLimit(args: string[]): number {
  const idx = args.indexOf("--limit");
  if (idx === -1 || !args[idx + 1]) return 30;
  const n = parseInt(args[idx + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
