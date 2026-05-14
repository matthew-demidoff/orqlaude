import { TelegramApi } from "./api.js";
import { loadConfig } from "./config.js";
import { handleCommand, handleCallbackQuery } from "./commands.js";
import { Notifier } from "./notifier.js";
import { StateStore } from "../lib/state.js";
import { resolveStateDir } from "../lib/state_dir.js";
import { style } from "../lib/style.js";
import path from "node:path";
import { existsSync } from "node:fs";

/**
 * Bot main loop.
 *
 *   getUpdates loop:  long-poll Telegram (timeout 30s), dispatch incoming
 *                     messages to handleCommand
 *   notifier loop:    every 5s, run Notifier.tick() against the project
 *                     state to detect deltas and push notifications
 *
 * Run as a long-lived process: `orqlaude tg start`. Stop with Ctrl-C.
 */

export async function runBot(projectDir: string): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.botToken) {
    throw new Error("No bot token configured. Run `orqlaude tg setup` first.");
  }
  const api = new TelegramApi(cfg.botToken);
  const me = await api.getMe();

  // v0.5.4: print a self-diagnostic block so a mismatch between the MCP
  // server's state dir and the bot's watched dir is immediately visible.
  // This is the single most common cause of "I called notify_user but
  // nothing arrived" — the MCP server runs with cwd=/ → state goes to
  // ~/.orqlaude/projects/root-..., but the bot was started from a real
  // project directory and watches that project's .orqlaude/ instead.
  const stateDir = path.join(projectDir, ".orqlaude");
  const stateFile = path.join(stateDir, "orqlaude-state.json");
  const stateExists = existsSync(stateFile);
  let planCount = 0;
  let pendingNotifications = 0;
  if (stateExists) {
    try {
      const store = new StateStore(stateDir);
      const stats = await store.read((s) => {
        const plans = Object.values(s.plans);
        const pending = plans.reduce(
          (acc, p) => acc + p.userNotifications.filter((n) => !n.delivered).length,
          0
        );
        return { count: plans.length, pending };
      });
      planCount = stats.count;
      pendingNotifications = stats.pending;
    } catch {
      /* malformed state; leave counts at 0 */
    }
  }
  // Where would the MCP server REALLY put state if it were launched right now?
  const wouldBeStateDir = resolveStateDir();

  process.stdout.write(`${style.coral("◆ orqlaude tg")} — running\n`);
  process.stdout.write(`  ${style.sand("bot:")}      @${me.username} (id ${me.id})\n`);
  process.stdout.write(`  ${style.sand("watching:")} ${projectDir}\n`);
  process.stdout.write(`  ${style.sand("state:")}    ${stateFile} ${stateExists ? style.coral("(exists)") : style.crimson("(missing)")}\n`);
  if (stateExists) {
    process.stdout.write(`             ${planCount} plan(s), ${pendingNotifications} pending notification(s)\n`);
  }
  process.stdout.write(`  ${style.sand("whitelist:")} ${cfg.whitelist.length} user(s), owner=${cfg.ownerId ?? "none"}\n`);

  // Loud warning if the MCP server (if it were starting from THIS bot's cwd)
  // would resolve to a different state dir. Surfaces the cwd=/ mismatch.
  if (wouldBeStateDir.path !== stateDir) {
    process.stdout.write(
      `\n  ${style.crimson("⚠ STATE-DIR MISMATCH:")} an MCP server starting from this dir would resolve to:\n` +
        `      ${wouldBeStateDir.path}\n` +
        `      (source: ${wouldBeStateDir.source})\n` +
        `  If your orqlaude MCP is launched with a different cwd (cwd=/ is common in MCP hosts), it's writing\n` +
        `  state to ITS resolved dir, not this one. Set ORQLAUDE_STATE_DIR in the MCP server's .mcp.json env block\n` +
        `  to ${stateDir} so they share state.\n\n`
    );
  }

  if (cfg.whitelist.length === 0 && !cfg.ownerId) {
    process.stdout.write(
      `  ${style.crimson("NO whitelist yet.")} Have your user message /start to learn your id, then run\n` +
        `  ${style.coral(`orql tg whitelist <id> --owner`)}\n`
    );
  }
  process.stdout.write(`\n${style.dim("polling for updates…")}\n`);

  const notifier = new Notifier(projectDir, cfg, api);

  // Notifier loop runs concurrently.
  const stopFlag = { stopped: false };
  const notifierTask = (async () => {
    while (!stopFlag.stopped) {
      try {
        await notifier.tick();
      } catch (err) {
        process.stderr.write(`[notifier] ${(err as Error).message}\n`);
      }
      await sleep(5000);
    }
  })();

  // Updates loop.
  let offset = 0;
  process.on("SIGINT", () => {
    stopFlag.stopped = true;
    process.stdout.write("\norqlaude tg: shutting down.\n");
    process.exit(0);
  });

  while (!stopFlag.stopped) {
    try {
      const updates = await api.getUpdates(offset, 30);
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) {
          await handleCommand(api, u.message, projectDir).catch((err) => {
            process.stderr.write(`[command] ${(err as Error).message}\n`);
          });
        } else if (u.callback_query) {
          await handleCallbackQuery(api, u.callback_query, projectDir).catch((err: unknown) => {
            process.stderr.write(`[callback] ${(err as Error).message}\n`);
          });
        }
      }
    } catch (err) {
      process.stderr.write(`[getUpdates] ${(err as Error).message}\n`);
      await sleep(5000);
    }
  }

  await notifierTask;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
