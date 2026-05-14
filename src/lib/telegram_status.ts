import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Quick "is Telegram alive" probe for inclusion in ping / notify_user /
 * request_user_response responses.
 *
 * Three signals, oldest to newest:
 *   1. config file at ~/.orqlaude/telegram.json exists + parses + has a
 *      bot token + has at least one whitelist entry → "configured"
 *   2. notifier cursor at <project>/.orqlaude/telegram-cursor.json exists
 *      and has initialized=true → "started"
 *   3. notifier cursor's last-write mtime is fresh (< 30s ago) → "active"
 *
 * We don't try to confirm Telegram's API is reachable — that'd require an
 * extra HTTP call per ping. The three-step check covers the realistic
 * failure modes (token missing, bot never started, bot crashed).
 */

export type TgStatus = "unconfigured" | "configured" | "started" | "active" | "stale";

export interface TgStatusInfo {
  status: TgStatus;
  hasToken: boolean;
  whitelistSize: number;
  notifierLastTickMsAgo: number | null;
  notes: string[];
}

// v0.9.0: resolve at call time so tests overriding HOME mid-run see the
// updated path. The previous module-load-time const captured whatever HOME
// was at import time, defeating the test's HOME swap.
function resolveConfigPath(): string {
  return path.join(os.homedir(), ".orqlaude", "telegram.json");
}

export async function probeTelegramStatus(stateDir: string): Promise<TgStatusInfo> {
  const notes: string[] = [];
  const CONFIG_PATH = resolveConfigPath();
  // 1. Config.
  let hasToken = false;
  let whitelistSize = 0;
  if (!existsSync(CONFIG_PATH)) {
    return {
      status: "unconfigured",
      hasToken: false,
      whitelistSize: 0,
      notifierLastTickMsAgo: null,
      notes: [`No Telegram config at ${CONFIG_PATH}. Run \`orql tg setup\` first.`],
    };
  }
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw) as { botToken?: string; whitelist?: unknown[] };
    hasToken = Boolean(cfg.botToken && cfg.botToken.length > 10);
    whitelistSize = Array.isArray(cfg.whitelist) ? cfg.whitelist.length : 0;
  } catch (err) {
    return {
      status: "unconfigured",
      hasToken: false,
      whitelistSize: 0,
      notifierLastTickMsAgo: null,
      notes: [`Telegram config exists but couldn't be parsed: ${(err as Error).message}`],
    };
  }
  if (!hasToken) {
    return { status: "unconfigured", hasToken: false, whitelistSize, notifierLastTickMsAgo: null, notes: ["Token missing in config; run `orql tg setup`."] };
  }
  if (whitelistSize === 0) {
    notes.push("Whitelist is empty — no one will receive notifications. Run `orql tg whitelist <user_id> --owner`.");
  }
  // 2. Notifier cursor existence (started?).
  const cursorPath = path.join(stateDir, "telegram-cursor.json");
  if (!existsSync(cursorPath)) {
    return {
      status: "configured",
      hasToken,
      whitelistSize,
      notifierLastTickMsAgo: null,
      notes: [...notes, `Config OK but the bot hasn't started yet — run \`orql tg start\` in the project root.`],
    };
  }
  let initialized = false;
  let lastTickMsAgo: number | null = null;
  try {
    const raw = await fs.readFile(cursorPath, "utf8");
    const cursor = JSON.parse(raw) as { initialized?: boolean };
    initialized = Boolean(cursor.initialized);
    const stat = await fs.stat(cursorPath);
    lastTickMsAgo = Date.now() - stat.mtimeMs;
  } catch {
    /* unreadable; treat as just-started */
  }
  if (!initialized) {
    return { status: "started", hasToken, whitelistSize, notifierLastTickMsAgo: lastTickMsAgo, notes: [...notes, "Bot started but not yet initialized."] };
  }
  // 3. Activity check.
  if (lastTickMsAgo !== null && lastTickMsAgo > 30_000) {
    return {
      status: "stale",
      hasToken,
      whitelistSize,
      notifierLastTickMsAgo: lastTickMsAgo,
      notes: [
        ...notes,
        `Notifier cursor hasn't ticked in ${Math.round(lastTickMsAgo / 1000)}s. The bot process may have died — restart with \`orql tg start\`.`,
      ],
    };
  }
  return {
    status: "active",
    hasToken,
    whitelistSize,
    notifierLastTickMsAgo: lastTickMsAgo,
    notes,
  };
}
