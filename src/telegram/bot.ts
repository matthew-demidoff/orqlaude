import { TelegramApi } from "./api.js";
import { loadConfig } from "./config.js";
import { handleCommand } from "./commands.js";
import { Notifier } from "./notifier.js";

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
  process.stdout.write(`orqlaude tg: connected as @${me.username} (bot id ${me.id})\n`);
  process.stdout.write(`orqlaude tg: watching ${projectDir}\n`);
  if (cfg.whitelist.length === 0 && !cfg.ownerId) {
    process.stdout.write(`orqlaude tg: NO whitelist yet. Have your user message /start to learn your id, then run \`orqlaude tg whitelist <id> --owner\`.\n`);
  } else {
    process.stdout.write(`orqlaude tg: whitelist has ${cfg.whitelist.length} user(s), owner=${cfg.ownerId ?? "none"}.\n`);
  }

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
