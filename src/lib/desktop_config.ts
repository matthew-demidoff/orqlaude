import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Read / patch the Claude Desktop MCP config (`claude_desktop_config.json`).
 *
 * Goals:
 *   • Preserve every key we don't own. Other MCP servers (lm-studio, etc.),
 *     the entire `preferences` block, and any future top-level keys must
 *     survive a patch.
 *   • Atomic writes via tmp + rename, with a timestamped `.bak` copy so the
 *     user can revert.
 *   • Cross-platform: macOS, Linux, Windows.
 *   • Idempotent: re-running `orql setup` against an already-correct config
 *     reports "no changes" instead of churning the file.
 */

export interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  [extra: string]: unknown;
}

export interface DesktopConfig {
  mcpServers?: Record<string, McpServerEntry>;
  preferences?: Record<string, unknown>;
  /** Catch-all so we don't drop top-level keys we don't recognize. */
  [extra: string]: unknown;
}

const NPM_PACKAGE = "@synaplink/orqlaude";
const MCP_KEY = "orqlaude";

/** Resolve the Claude Desktop config path for the current platform. */
export function findDesktopConfigPath(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

/**
 * Read the desktop config. Returns null if the file doesn't exist;
 * throws on a parse error (we don't want to silently overwrite a malformed
 * but probably-valuable file).
 */
export async function readDesktopConfig(filePath: string): Promise<DesktopConfig | null> {
  if (!existsSync(filePath)) return null;
  const raw = await fs.readFile(filePath, "utf8");
  // Some users may have empty files. Treat as empty config.
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as DesktopConfig;
  } catch (err) {
    throw new Error(
      `Failed to parse ${filePath}: ${(err as Error).message}. ` +
        `Inspect / fix the file manually before re-running setup — orql refuses to overwrite a malformed config.`
    );
  }
}

/**
 * Build the orqlaude MCP server entry pointing at the npm package + a
 * concrete state dir.
 */
export function buildOrqlaudeEntry(stateDir: string): McpServerEntry {
  return {
    command: "npx",
    args: ["-y", "-p", NPM_PACKAGE, "orqlaude-mcp"],
    env: {
      ORQLAUDE_STATE_DIR: stateDir,
    },
  };
}

export type PatchAction = "noop" | "create-config" | "create-server" | "update-server";

export interface PatchResult {
  action: PatchAction;
  before: McpServerEntry | null;
  after: McpServerEntry;
  config: DesktopConfig;
}

/**
 * Return what would change if we patched in `stateDir`. Doesn't write
 * anything — caller persists with `writeDesktopConfigAtomic`.
 */
export function planPatch(existing: DesktopConfig | null, stateDir: string): PatchResult {
  const next: DesktopConfig = existing ? structuredClone(existing) : {};
  const targetEntry = buildOrqlaudeEntry(stateDir);
  let action: PatchAction = "noop";
  let before: McpServerEntry | null = null;

  if (!existing) {
    action = "create-config";
    next.mcpServers = { [MCP_KEY]: targetEntry };
  } else {
    if (!next.mcpServers || typeof next.mcpServers !== "object") {
      next.mcpServers = {};
    }
    before = next.mcpServers[MCP_KEY] ?? null;
    if (!before) {
      action = "create-server";
      next.mcpServers[MCP_KEY] = targetEntry;
    } else {
      // Compare semantically — only update if something is meaningfully off.
      const equal =
        before.command === targetEntry.command &&
        sameArray(before.args, targetEntry.args) &&
        (before.env?.ORQLAUDE_STATE_DIR === targetEntry.env?.ORQLAUDE_STATE_DIR);
      if (!equal) {
        action = "update-server";
        // Preserve other env keys the user might have added.
        const mergedEnv = { ...(before.env ?? {}), ...targetEntry.env };
        next.mcpServers[MCP_KEY] = { ...before, ...targetEntry, env: mergedEnv };
      }
    }
  }
  return { action, before, after: next.mcpServers![MCP_KEY] as McpServerEntry, config: next };
}

function sameArray(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Persist a config back to disk. Writes a timestamped `.bak` first if the
 * file existed, then tmp + rename for atomicity. Never partial.
 */
export async function writeDesktopConfigAtomic(filePath: string, config: DesktopConfig): Promise<{ backupPath: string | null }> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let backupPath: string | null = null;
  if (existsSync(filePath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = `${filePath}.bak.${ts}`;
    await fs.copyFile(filePath, backupPath);
  }
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + "\n");
  await fs.rename(tmp, filePath);
  return { backupPath };
}

/**
 * One-shot convenience: patch the config at `filePath` so orqlaude points at
 * `stateDir`. Returns the action that was taken and the backup path (if a
 * backup was created).
 */
export async function applyPatch(filePath: string, stateDir: string): Promise<{ result: PatchResult; backupPath: string | null }> {
  const existing = await readDesktopConfig(filePath);
  const result = planPatch(existing, stateDir);
  if (result.action === "noop") {
    return { result, backupPath: null };
  }
  const { backupPath } = await writeDesktopConfigAtomic(filePath, result.config);
  return { result, backupPath };
}
