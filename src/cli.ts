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
import {
  findDesktopConfigPath,
  readDesktopConfig,
  planPatch,
  writeDesktopConfigAtomic,
  buildOrqlaudeEntry,
} from "./lib/desktop_config.js";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
// v0.6.0 additions
import { hasJsonFlag, emitJson } from "./lib/json_out.js";
import { errorLine, formatError, infoLine } from "./lib/error_ui.js";
import { readPreferences, updatePreferences } from "./lib/preferences.js";
import { maybeCheckForUpdate } from "./lib/update_check.js";
import { pickPlanId } from "./lib/picker.js";
import { localNotification, isNotificationsAvailable } from "./lib/notifications.js";
import { watchPlan } from "./cli/watch.js";
import { runDoctor } from "./cli/doctor.js";
import { tailAudit } from "./cli/tail.js";
import { openPlan } from "./cli/open.js";
import { showAbout } from "./cli/about.js";
import { runEasterEgg } from "./cli/easter_egg.js";

const VERSION = "0.7.2";

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
  // Background tasks (don't block on result).
  const updatePromise = maybeCheckForUpdate(VERSION);

  const [cmd, ...rest] = process.argv.slice(2);

  // First-run welcome — skip for purely informational commands so the user
  // can `orql --version` / `orql about` without forcing the onboarding.
  if (cmd !== "--version" && cmd !== "-v" && cmd !== "about" && cmd !== "help" && cmd !== "--help" && cmd !== "-h") {
    await maybeShowWelcome();
  }
  const isJson = hasJsonFlag(rest);
  let exitCode = 0;
  try {
    switch (cmd) {
      case undefined:
        // Bare `orql` → banner + project summary, not the long help.
        exitCode = await cmdBare();
        break;
      case "help":
      case "-h":
      case "--help":
        printHelp();
        exitCode = 0;
        break;
      case "--version":
      case "-v":
        process.stdout.write(`orqlaude ${VERSION}\n`);
        exitCode = 0;
        break;
      case "list":
        exitCode = await cmdList(isJson);
        break;
      case "status":
        exitCode = await cmdStatus(rest[0], isJson);
        break;
      case "show":
        exitCode = await cmdShow(rest[0], isJson);
        break;
      case "history":
        exitCode = await cmdHistory(parseLimit(rest), isJson);
        break;
      case "where":
        exitCode = cmdWhere(isJson);
        break;
      case "setup":
        exitCode = await cmdSetup(rest);
        break;
      case "watch":
        exitCode = await cmdWatch(rest[0]);
        break;
      case "doctor":
        exitCode = await runDoctor(VERSION);
        break;
      case "tail":
        exitCode = await tailAudit(STATE_DIR, rest[0]);
        break;
      case "open":
        exitCode = await cmdOpen(rest[0]);
        break;
      case "notify":
        exitCode = await cmdNotify(rest);
        break;
      case "about":
        exitCode = showAbout(VERSION);
        break;
      case "tg":
        exitCode = await cmdTg(rest);
        break;
      default:
        process.stderr.write(errorLine(`unknown subcommand: ${cmd}`, `try \`orql help\``));
        exitCode = 1;
    }
  } catch (err) {
    const { message, suggestion } = formatError(err);
    process.stderr.write(errorLine(message, suggestion));
    exitCode = 1;
  }
  // Tail the update-check notice after the main output, if any.
  await updatePromise;
  return exitCode;
}

async function maybeShowWelcome(): Promise<void> {
  const prefs = await readPreferences();
  if (prefs.welcomedAt) return;
  console.log(banner());
  console.log("");
  console.log(`  ${style.coral("welcome to orqlaude.")} this is your first run.`);
  console.log("");
  console.log(`  ${style.sand("•")} ${style.cream("orql setup")}        wire into Claude Desktop's MCP config (run from your project root)`);
  console.log(`  ${style.sand("•")} ${style.cream("orql tg setup")}     (optional) configure a Telegram bot for notifications`);
  console.log(`  ${style.sand("•")} ${style.cream("orql doctor")}       check that everything's wired correctly`);
  console.log(`  ${style.sand("•")} ${style.cream("orql watch <id>")}   live dashboard for a running fleet`);
  console.log(`  ${style.sand("•")} ${style.cream("orql help")}         full reference`);
  console.log("");
  console.log(style.dim(`(this message won't show again. happy fleeting.)\n`));
  await updatePreferences((p) => {
    p.welcomedAt = Date.now();
  });
}

async function cmdBare(): Promise<number> {
  // Bare `orql` runs the easter egg — the diamond logo + an animated
  // typewriter cycling through 149 tagline variants. Ctrl-C exits.
  // To see active plans use `orql list`; for the dashboard `orql watch`.
  return runEasterEgg();
}

function printHelp(): void {
  console.log(banner());
  console.log("");
  console.log(style.bold(style.cream("Setup")));
  console.log(`  ${style.coral("orql setup")} ${style.sand("[--state-dir PATH] [--yes]")}    Wire orqlaude into Claude Desktop's MCP config`);
  console.log(`  ${style.coral("orql doctor")}                              Verify your install end-to-end`);
  console.log("");
  console.log(style.bold(style.cream("Live")));
  console.log(`  ${style.coral("orql watch")} ${style.sand("<plan_id>")}                    Live fleet dashboard (1Hz refresh, Ctrl-C to exit)`);
  console.log(`  ${style.coral("orql tail")} ${style.sand("[plan_id]")}                     Stream the audit log; filter by plan prefix if given`);
  console.log(`  ${style.coral("orql open")} ${style.sand("<plan_id>")}                     Open all PRs from a plan in your browser`);
  console.log("");
  console.log(style.bold(style.cream("Inspection")));
  console.log(`  ${style.coral("orql list")} ${style.sand("[--json]")}                      List plans in this project`);
  console.log(`  ${style.coral("orql status")} ${style.sand("[plan_id] [--json]")}          Refreshed status (prompts for plan if omitted)`);
  console.log(`  ${style.coral("orql show")} ${style.sand("[plan_id] [--json]")}            Raw plan JSON`);
  console.log(`  ${style.coral("orql history")} ${style.sand("[--limit N] [--json]")}       Tail the audit log`);
  console.log(`  ${style.coral("orql where")} ${style.sand("[--json]")}                     Show resolved state dir`);
  console.log("");
  console.log(style.bold(style.cream("Notifications")));
  console.log(`  ${style.coral("orql notify on|off|test|status")}           macOS desktop notifications (paired with Telegram)`);
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

async function cmdList(isJson = false): Promise<number> {
  const store = new StateStore(STATE_DIR);
  const plans = await store.read((s) => Object.values(s.plans).sort((a, b) => b.createdAt - a.createdAt));
  if (isJson) {
    emitJson(plans);
    return 0;
  }
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

async function cmdStatus(planId: string | undefined, isJson = false): Promise<number> {
  if (!planId) {
    const picked = await pickPlanId(STATE_DIR);
    if (!picked) return 1;
    planId = picked;
  }
  if (isJson) {
    const store = new StateStore(STATE_DIR);
    const data = await store.read((s) => {
      const p = requirePlan(s.plans, planId!);
      return p;
    });
    emitJson(data);
    return 0;
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

async function cmdShow(planId: string | undefined, isJson = false): Promise<number> {
  if (!planId) {
    const picked = await pickPlanId(STATE_DIR, true);
    if (!picked) return 1;
    planId = picked;
  }
  const store = new StateStore(STATE_DIR);
  try {
    const plan = await store.read((s) => requirePlan(s.plans, planId!));
    if (isJson) {
      emitJson(plan);
    } else {
      console.log(JSON.stringify(plan, null, 2));
    }
    return 0;
  } catch (err) {
    process.stderr.write(errorLine((err as Error).message));
    return 1;
  }
}

// ---- setup -----------------------------------------------------------------

/**
 * Detect a sensible default state dir for the current shell. Walks up from
 * cwd for a `.git`; falls back to cwd.
 */
function defaultStateDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, ".git"))) {
      return path.join(dir, ".orqlaude");
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), ".orqlaude");
}

async function cmdSetup(args: string[]): Promise<number> {
  console.log(banner());
  console.log("");
  console.log(style.bold(style.cream("Setup")));
  console.log("Wires orqlaude into Claude Desktop's MCP config.");
  console.log("");

  // Parse flags
  const stateDirIdx = args.indexOf("--state-dir");
  const overrideStateDir = stateDirIdx !== -1 ? args[stateDirIdx + 1] : null;
  const yes = args.includes("--yes") || args.includes("-y");
  const configPathIdx = args.indexOf("--config-path");
  const configPath =
    configPathIdx !== -1 ? args[configPathIdx + 1] : findDesktopConfigPath();

  console.log(`  ${style.sand("config:")}    ${configPath}`);

  // 1. Read existing config (preserve everything we don't own).
  let existing;
  try {
    existing = await readDesktopConfig(configPath);
  } catch (err) {
    console.error("");
    console.error(style.crimson(`✗ ${(err as Error).message}`));
    return 1;
  }
  if (!existing) {
    console.log(`  ${style.sand("status:")}    ${style.crimson("config file does not exist — will create")}`);
  } else {
    const otherServerCount = Object.keys(existing.mcpServers ?? {}).filter((k) => k !== "orqlaude").length;
    const orqEntry = existing.mcpServers?.orqlaude;
    const has = orqEntry ? style.coral("orqlaude entry present") : style.sand("no orqlaude entry yet");
    console.log(`  ${style.sand("status:")}    ${has}, ${otherServerCount} other server(s) preserved`);
  }

  // 2. Pick state dir.
  let stateDir = overrideStateDir;
  if (!stateDir) {
    const suggested = defaultStateDir();
    if (yes) {
      stateDir = suggested;
    } else {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      const answer = (await rl.question(`\n  ${style.coral("?")} state dir (where plans/audit live) [${suggested}]: `)).trim();
      rl.close();
      stateDir = answer || suggested;
    }
  }
  stateDir = path.resolve(stateDir);

  // 3. Compute patch.
  const plan = planPatch(existing, stateDir);
  console.log("");
  console.log(style.bold(style.cream("Plan")));
  switch (plan.action) {
    case "noop":
      console.log(`  ${style.coral("✓")} already correct; nothing to do`);
      return 0;
    case "create-config":
      console.log(`  ${style.coral("→")} create ${configPath} with one server (orqlaude → ${stateDir})`);
      break;
    case "create-server":
      console.log(`  ${style.coral("→")} add orqlaude entry (→ ${stateDir}); preserve existing servers + preferences`);
      break;
    case "update-server":
      console.log(`  ${style.coral("→")} update orqlaude entry`);
      console.log(`        ${style.sand("before:")}  ${JSON.stringify(plan.before)}`);
      console.log(`        ${style.sand("after:")}   ${JSON.stringify(plan.after)}`);
      break;
  }

  // 4. Confirm + write.
  if (!yes) {
    const rl2 = readline.createInterface({ input: stdin, output: stdout });
    const ans = (await rl2.question(`\n  ${style.coral("?")} apply? [Y/n] `)).trim().toLowerCase();
    rl2.close();
    if (ans && ans !== "y" && ans !== "yes") {
      console.log(style.crimson("  ✗ cancelled"));
      return 1;
    }
  }
  const { backupPath } = await writeDesktopConfigAtomic(configPath, plan.config);
  console.log("");
  console.log(style.bold(style.coral("Done.")));
  console.log(`  ${style.sand("config:")}    ${configPath}`);
  if (backupPath) console.log(`  ${style.sand("backup:")}    ${backupPath}`);
  console.log(`  ${style.sand("state dir:")} ${stateDir}`);
  console.log("");
  console.log(style.dim("Next steps:"));
  console.log(style.dim("  1. Fully quit Claude Desktop (Cmd-Q on macOS) and relaunch."));
  console.log(style.dim("  2. Open a session in this project. Call `mcp__orqlaude__ping` — it should report state_dir_source:'env'."));
  console.log(style.dim("  3. (Optional) Set up the Telegram bot: `orql tg setup`."));
  return 0;
}

function cmdWhere(isJson = false): number {
  if (isJson) {
    emitJson(STATE_DIR_RESOLUTION);
    return 0;
  }
  console.log(banner());
  console.log("");
  console.log(`  ${style.sand("cwd:")}        ${STATE_DIR_RESOLUTION.cwd}`);
  console.log(`  ${style.sand("state dir:")}  ${style.cream(STATE_DIR_RESOLUTION.path)}`);
  console.log(`  ${style.sand("source:")}     ${style.coral(STATE_DIR_RESOLUTION.source)}`);
  console.log(``);
  console.log(style.dim(`Resolution order: ORQLAUDE_STATE_DIR env > git worktree > project root > ~/.orqlaude/projects/<hash>`));
  return 0;
}

// ---- v0.6.0 commands -------------------------------------------------------

async function cmdWatch(planIdArg: string | undefined): Promise<number> {
  let planId = planIdArg;
  if (!planId) {
    const picked = await pickPlanId(STATE_DIR);
    if (!picked) return 1;
    planId = picked;
  }
  return watchPlan(STATE_DIR, planId);
}

async function cmdOpen(planIdArg: string | undefined): Promise<number> {
  let planId = planIdArg;
  if (!planId) {
    const picked = await pickPlanId(STATE_DIR, true);
    if (!picked) return 1;
    planId = picked;
  }
  return openPlan(STATE_DIR, planId);
}

async function cmdNotify(args: string[]): Promise<number> {
  const [sub] = args;
  switch (sub) {
    case "on":
      if (!isNotificationsAvailable()) {
        process.stderr.write(errorLine("macOS desktop notifications only — your platform isn't supported."));
        return 1;
      }
      await updatePreferences((p) => {
        p.localNotifications = true;
      });
      console.log(style.coral("✓ ") + "local notifications enabled. The Telegram bot will also fire macOS notifications.");
      console.log(style.dim("  (run `orql notify test` to verify.)"));
      return 0;
    case "off":
      await updatePreferences((p) => {
        p.localNotifications = false;
      });
      console.log(style.coral("✓ ") + "local notifications disabled.");
      return 0;
    case "test":
      if (!isNotificationsAvailable()) {
        process.stderr.write(errorLine("macOS desktop notifications only."));
        return 1;
      }
      localNotification("orqlaude", "if you see this, notifications work.", "test");
      console.log(style.coral("✓ ") + "test notification sent.");
      return 0;
    case "status":
    case undefined: {
      const prefs = await readPreferences();
      const enabled = !!prefs.localNotifications;
      console.log(`  ${style.sand("local notifications:")} ${enabled ? style.coral("on") : style.crimson("off")}`);
      console.log(`  ${style.sand("platform supported:")}  ${isNotificationsAvailable() ? style.coral("yes (macOS)") : style.crimson("no")}`);
      return 0;
    }
    default:
      process.stderr.write(errorLine(`unknown subcommand: ${sub}`, "try `orql notify on|off|test|status`"));
      return 1;
  }
}

async function cmdHistory(limit: number, isJson = false): Promise<number> {
  const audit = new AuditLog(STATE_DIR);
  const events = await audit.tail(limit);
  if (isJson) {
    emitJson(events);
    return 0;
  }
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
