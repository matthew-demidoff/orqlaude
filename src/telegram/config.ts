import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Per-user Telegram config: bot token + whitelist of Telegram user ids.
 *
 * Stored at ~/.orqlaude/telegram.json with mode 600 (owner-only). The bot
 * token is a secret — never log it, never include it in audit events.
 *
 * Schema (intentionally simple — the bot is a small feature):
 *   {
 *     "botToken":   "1234:ABC..."  // from @BotFather
 *     "whitelist":  [ { "userId": 12345, "chatId": 12345, "label": "Matthew" } ],
 *     "ownerId":    12345          // who can run /whitelist commands
 *     "watchedProjects": [ "/Users/.../project1" ]   // future: monitor multiple
 *   }
 */

export interface WhitelistEntry {
  userId: number;
  chatId: number;
  label?: string;
}

export interface TelegramConfig {
  botToken: string;
  ownerId: number | null;
  whitelist: WhitelistEntry[];
  watchedProjects: string[];
}

const CONFIG_DIR = path.join(os.homedir(), ".orqlaude");
const CONFIG_PATH = path.join(CONFIG_DIR, "telegram.json");

const EMPTY: TelegramConfig = {
  botToken: "",
  ownerId: null,
  whitelist: [],
  watchedProjects: [],
};

export async function loadConfig(): Promise<TelegramConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<TelegramConfig>;
    return { ...EMPTY, ...parsed };
  } catch (err: any) {
    if (err.code === "ENOENT") return { ...EMPTY };
    throw err;
  }
}

export async function saveConfig(cfg: TelegramConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2));
  await fs.rename(tmp, CONFIG_PATH);
  await fs.chmod(CONFIG_PATH, 0o600);
}

export function isAuthorized(cfg: TelegramConfig, userId: number): boolean {
  if (userId === cfg.ownerId) return true;
  return cfg.whitelist.some((w) => w.userId === userId);
}

export { CONFIG_PATH };
