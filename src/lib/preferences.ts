import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Per-user orqlaude preferences (separate from per-project state).
 *
 * Stored at `~/.orqlaude/preferences.json`. Tracks small bits of state
 * that span projects: whether the user has seen the welcome screen,
 * whether local desktop notifications are enabled, when we last checked
 * npm for an update, etc.
 *
 * The file format is forgiving — unknown keys are preserved on write
 * so a future field doesn't get blown away by an older orql.
 */

export interface Preferences {
  welcomedAt?: number;
  /** When true, the Telegram notifier also fires a macOS osascript notification. */
  localNotifications?: boolean;
  lastUpdateCheckAt?: number;
  lastKnownLatestVersion?: string;
  /** Catch-all for forward compat. */
  [extra: string]: unknown;
}

const PREFS_DIR = path.join(os.homedir(), ".orqlaude");
const PREFS_PATH = path.join(PREFS_DIR, "preferences.json");

export async function readPreferences(): Promise<Preferences> {
  if (!existsSync(PREFS_PATH)) return {};
  try {
    const raw = await fs.readFile(PREFS_PATH, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw) as Preferences;
  } catch {
    return {};
  }
}

export async function writePreferences(prefs: Preferences): Promise<void> {
  await fs.mkdir(PREFS_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${PREFS_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(prefs, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, PREFS_PATH);
}

export async function updatePreferences(mutate: (p: Preferences) => void): Promise<Preferences> {
  const cur = await readPreferences();
  mutate(cur);
  await writePreferences(cur);
  return cur;
}

export { PREFS_PATH };
