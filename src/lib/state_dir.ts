import { promises as fs, statSync, readFileSync, accessSync, constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

/**
 * Resolve where orqlaude's state directory lives.
 *
 * MCP servers don't get to pick their cwd — the host (Claude Desktop, an
 * IDE plugin, a shell) chooses it. Some hosts launch with cwd=/ or another
 * unwritable dir for sandbox reasons. We can't crash there.
 *
 * Resolution order (first match wins):
 *
 *   1. `ORQLAUDE_STATE_DIR` env var — explicit override always wins.
 *   2. Git worktree resolution: if `<cwd>/.git` is a regular FILE pointing at
 *      `<main>/.git/worktrees/<n>`, resolve to `<main>/.orqlaude`. This is
 *      what lets spawn_task'd children share state with the parent fleet.
 *   3. If cwd looks like a project root (writable + has `.git/`,
 *      `package.json`, `pyproject.toml`, or `Cargo.toml`) → `<cwd>/.orqlaude`.
 *   4. Otherwise → `~/.orqlaude/projects/<basename>-<hash>/` where hash is
 *      derived from the cwd path. Stable across restarts; per-cwd isolated.
 *
 * Step 4 is the safety net for cwd=/ and similar. We also write a one-line
 * note to stderr so the developer sees where state landed.
 */

const SYSTEM_DIRS = new Set([
  "/",
  "/private",
  "/tmp",
  "/var",
  "/usr",
  "/etc",
  "/Applications",
  "/Library",
  "/System",
  "/Volumes",
  "/opt",
  "/bin",
  "/sbin",
]);

const PROJECT_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"];

export interface StateDirResolution {
  path: string;
  source: "env" | "worktree" | "project-root" | "home-fallback";
  cwd: string;
}

export function resolveStateDir(): StateDirResolution {
  const cwd = process.cwd();

  if (process.env.ORQLAUDE_STATE_DIR) {
    return { path: process.env.ORQLAUDE_STATE_DIR, source: "env", cwd };
  }

  const worktree = tryWorktreeResolve(cwd);
  if (worktree) return { path: worktree, source: "worktree", cwd };

  if (looksLikeProjectRoot(cwd) && isWritable(cwd)) {
    return { path: path.join(cwd, ".orqlaude"), source: "project-root", cwd };
  }

  return { path: homeFallback(cwd), source: "home-fallback", cwd };
}

function tryWorktreeResolve(cwd: string): string | null {
  try {
    const dotGit = path.join(cwd, ".git");
    const stat = statSync(dotGit);
    if (!stat.isFile()) return null;
    const content = readFileSync(dotGit, "utf8");
    // Format: "gitdir: /path/to/main/.git/worktrees/<name>"
    const m = content.match(/^gitdir:\s*(.+?)\/worktrees\/[^\/\s]+\s*$/m);
    if (!m) return null;
    const mainGitDir = m[1]; // /path/to/main/.git
    const mainCheckout = path.dirname(mainGitDir);
    return path.join(mainCheckout, ".orqlaude");
  } catch {
    return null;
  }
}

function looksLikeProjectRoot(dir: string): boolean {
  if (SYSTEM_DIRS.has(path.normalize(dir))) return false;
  for (const marker of PROJECT_MARKERS) {
    try {
      statSync(path.join(dir, marker));
      return true;
    } catch {
      /* missing; try next */
    }
  }
  return false;
}

function isWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function homeFallback(cwd: string): string {
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  const safeBasename = (path.basename(cwd) || "root").replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(os.homedir(), ".orqlaude", "projects", `${safeBasename}-${hash}`);
}

/**
 * Convenience used by server.ts and cli.ts: resolve, ensure dir exists, log
 * a one-line note to stderr if we fell back to the home dir. Safe to call
 * multiple times.
 */
export async function resolveAndEnsureStateDir(): Promise<StateDirResolution> {
  const r = resolveStateDir();
  await fs.mkdir(r.path, { recursive: true, mode: 0o700 });
  if (r.source === "home-fallback") {
    process.stderr.write(
      `[orqlaude] cwd=${r.cwd} is not a project root; state stored at ${r.path}. ` +
        `Set ORQLAUDE_STATE_DIR to override.\n`
    );
  }
  return r;
}
