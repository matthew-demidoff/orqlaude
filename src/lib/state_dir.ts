import { promises as fs, statSync, readFileSync, accessSync, realpathSync, existsSync, constants } from "node:fs";
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
  source: "env" | "worktree" | "project-root" | "pwd-env" | "home-fallback";
  cwd: string;
  cwdSource: "process.cwd" | "process.env.PWD";
  warnings: string[];
}

/**
 * Resolve "where the user actually meant for us to operate."
 *
 * `process.cwd()` is unreliable when the MCP host (Claude Desktop, etc.)
 * launches us with cwd=/ for sandbox reasons. The shell var `PWD` is often
 * still set by whatever spawned the host, pointing at the user's actual
 * working directory — so we prefer it IF it points at a writable project
 * root. Otherwise we fall back to `process.cwd()` and let downstream
 * heuristics handle the rest.
 */
function resolveCwd(): { cwd: string; source: "process.cwd" | "process.env.PWD" } {
  const realCwd = process.cwd();
  const pwd = process.env.PWD;
  if (pwd && pwd !== realCwd && looksLikeProjectRoot(pwd) && isWritable(pwd)) {
    return { cwd: pwd, source: "process.env.PWD" };
  }
  return { cwd: realCwd, source: "process.cwd" };
}

export function resolveStateDir(): StateDirResolution {
  const warnings: string[] = [];
  const { cwd, source: cwdSource } = resolveCwd();

  if (process.env.ORQLAUDE_STATE_DIR) {
    return { path: process.env.ORQLAUDE_STATE_DIR, source: "env", cwd, cwdSource, warnings };
  }

  const worktree = tryWorktreeResolve(cwd);
  if (worktree) return { path: worktree, source: "worktree", cwd, cwdSource, warnings };

  if (looksLikeProjectRoot(cwd) && isWritable(cwd)) {
    const src = cwdSource === "process.env.PWD" ? "pwd-env" : "project-root";
    return { path: path.join(cwd, ".orqlaude"), source: src, cwd, cwdSource, warnings };
  }

  // Falling back means we couldn't find a useful project root. Note the
  // probable cause so callers can surface it.
  if (SYSTEM_DIRS.has(path.normalize(process.cwd()))) {
    warnings.push(
      `MCP host launched orqlaude with cwd=${process.cwd()}. State writes will go to ~/.orqlaude/projects/. Set ORQLAUDE_STATE_DIR or run from a project root for per-project isolation.`
    );
  } else if (!isWritable(cwd)) {
    warnings.push(`cwd=${cwd} is not writable; state writes will go to ~/.orqlaude/projects/.`);
  }
  return { path: homeFallback(cwd), source: "home-fallback", cwd, cwdSource, warnings };
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

/**
 * Compare two filesystem paths for equivalence, accounting for:
 *   • symlinks (resolved via realpath when the path exists)
 *   • case-insensitive filesystems on macOS / Windows (HFS+/APFS/NTFS default)
 *   • redundant `./` and `../` segments (path.normalize)
 *
 * Returns true if both paths point at the same on-disk location, even when
 * neither directory has been created yet.
 *
 * v0.5.6: used by `orql tg start`'s state-dir mismatch check. The previous
 * raw string comparison yelled at users whose PWD differed from cwd only
 * in case (e.g. typing `cd /users/.../documents/crm` against a directory
 * stored on disk as `Documents/crm`).
 */
export function pathsEquivalent(a: string, b: string): boolean {
  const normA = path.resolve(a);
  const normB = path.resolve(b);
  // Fast path: identical after normalization.
  if (normA === normB) return true;
  // Try realpath if both (or their nearest existing ancestors) resolve to
  // the same canonical location.
  const realA = safeRealpathOfExistingPrefix(normA);
  const realB = safeRealpathOfExistingPrefix(normB);
  if (realA && realB && realA === realB) return true;
  // Case-insensitive fallback on platforms where the filesystem usually is.
  if (process.platform === "darwin" || process.platform === "win32") {
    return normA.toLowerCase() === normB.toLowerCase();
  }
  return false;
}

/**
 * Walk up from `p` until we find an existing ancestor; realpath that, then
 * re-attach the trailing unresolved segments. Lets us compare paths whose
 * leaves don't yet exist on disk (e.g. a not-yet-created state dir).
 */
function safeRealpathOfExistingPrefix(p: string): string | null {
  let cur = p;
  const tail: string[] = [];
  while (cur && cur !== path.dirname(cur)) {
    if (existsSync(cur)) {
      try {
        const real = realpathSync(cur);
        return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
      } catch {
        return null;
      }
    }
    tail.push(path.basename(cur));
    cur = path.dirname(cur);
  }
  return null;
}
