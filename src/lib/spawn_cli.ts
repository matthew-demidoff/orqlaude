import { execSync, spawn } from "node:child_process";
import { promises as fs, existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * orqlaude-owned spawning path — sidesteps the host's choice of tool.
 *
 * Why this exists: the host's `Agent` tool runs the spawned worker in the
 * SAME worktree as the orchestrator, so concurrent siblings collide on git
 * operations. The host's `mcp__ccd_session__spawn_task` does create a
 * worktree but the orchestrator can pick the wrong tool by habit. Solving
 * this from inside orqlaude means owning the spawn end-to-end: we create
 * a dedicated worktree per task, pre-allocate the session id, and exec
 * `claude -p` directly.
 *
 * The cost is that the spawned session won't appear in the Claude Desktop
 * sidebar until the app restarts (the JSONL lives in ~/.claude/projects/
 * but the in-memory cache doesn't see it). That's an acceptable tradeoff
 * for correctness.
 */

export interface SpawnViaCliResult {
  worktreePath: string;
  branch: string;
  sessionId: string;
  pid: number;
  jsonlPath: string;
}

export interface SpawnViaCliInput {
  projectRoot: string;        // the git checkout we worktree off of
  stateDir: string;           // orqlaude's resolved state dir (env-passed to child)
  planId: string;
  taskId: string;
  agnetName?: string;
  prompt: string;
  branchHint?: string;
  /** Per-task token cap. Wired into --max-budget-usd if model pricing is known;
   *  primarily here for the future when claude exposes --max-budget-tokens. */
  budgetCapUsd?: number;
  permissionMode?: "bypassPermissions" | "acceptEdits" | "default";
  /** Override which claude binary to invoke. Defaults to discoverClaudeBinary(). */
  claudeBin?: string;
}

/**
 * Find the `claude` binary in priority order:
 *   1. CLAUDE_BIN env var (explicit override)
 *   2. `which claude` on PATH
 *   3. macOS bundled location:
 *      ~/Library/Application Support/Claude/claude-code/<version>/claude.app/Contents/MacOS/claude
 */
export function discoverClaudeBinary(): string {
  if (process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)) {
    return process.env.CLAUDE_BIN;
  }
  try {
    const out = execSync("which claude", { encoding: "utf8" }).trim();
    if (out && existsSync(out)) return out;
  } catch {
    /* not on PATH */
  }
  // macOS bundled path probe.
  const bundleRoot = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code");
  try {
    const entries = readdirSync(bundleRoot);
    // Highest semver-looking dir wins.
    const versions = entries.filter((e: string) => /^\d/.test(e)).sort().reverse();
    for (const v of versions) {
      const candidate = path.join(bundleRoot, v, "claude.app", "Contents", "MacOS", "claude");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* no bundle */
  }
  throw new Error(
    "claude binary not found. Set CLAUDE_BIN env var, install Claude Code globally, or run from a machine with the Desktop app installed."
  );
}

/**
 * Find the project's git root. We look upward from `start` for `.git` (dir
 * or file). If `start` is already in a worktree, the worktree's `.git` file
 * points back at the main checkout — for spawning fresh worktrees we want
 * the MAIN checkout, not a sibling.
 */
export function findGitRoot(start: string): string {
  let dir = path.resolve(start);
  while (true) {
    const dotGit = path.join(dir, ".git");
    if (existsSync(dotGit)) {
      const stat = statSync(dotGit);
      if (stat.isFile()) {
        // worktree pointer: gitdir: <main>/.git/worktrees/<n>
        const content = readFileSync(dotGit, "utf8");
        const m = content.match(/^gitdir:\s*(.+?)\/worktrees\/[^\/\s]+\s*$/m);
        if (m) return path.dirname(m[1]); // strip /.git to get main checkout
      }
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no git repo found starting from ${start}`);
    dir = parent;
  }
}

/**
 * Create a fresh worktree dedicated to one task. Worktree path:
 *   <project_root>/.orqlaude-worktrees/<plan_short>-<agnet_or_task>
 *
 * Returns the absolute path and the branch name created.
 */
export async function createWorktreeForTask(input: {
  projectRoot: string;
  planId: string;
  taskId: string;
  agnetName?: string;
  branchHint?: string;
}): Promise<{ path: string; branch: string }> {
  const planShort = input.planId.slice(0, 8);
  const agnetSlug =
    (input.agnetName ?? input.taskId.slice(0, 8)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agnet";
  const worktreeBase = path.join(input.projectRoot, ".orqlaude-worktrees");
  await fs.mkdir(worktreeBase, { recursive: true });
  const wtPath = path.join(worktreeBase, `${planShort}-${agnetSlug}`);
  const branch = input.branchHint
    ? input.branchHint
    : `fleet/${planShort}/${agnetSlug}`;
  // If the worktree already exists, reuse it (idempotent).
  if (existsSync(wtPath)) {
    return { path: wtPath, branch };
  }
  try {
    execSync(`git worktree add "${wtPath}" -b "${branch}"`, { cwd: input.projectRoot, stdio: "pipe" });
  } catch (err: any) {
    // Branch might already exist; retry without -b.
    const msg = (err.stderr?.toString?.() ?? err.message ?? "").toLowerCase();
    if (msg.includes("already exists")) {
      execSync(`git worktree add "${wtPath}" "${branch}"`, { cwd: input.projectRoot, stdio: "pipe" });
    } else {
      throw err;
    }
  }
  return { path: wtPath, branch };
}

/**
 * Build a `--mcp-config` JSON inline so the spawned claude session loads
 * orqlaude with the parent's state dir. The child's `process.cwd()` will be
 * the worktree, but its ORQLAUDE_STATE_DIR points back at the parent.
 */
function buildMcpConfig(serverEntryPath: string, stateDir: string): string {
  return JSON.stringify({
    mcpServers: {
      orqlaude: {
        command: "node",
        args: [serverEntryPath],
        env: { ORQLAUDE_STATE_DIR: stateDir },
      },
    },
  });
}

/**
 * Spawn a fresh worktree + a `claude -p` process bound to a pre-allocated
 * session id. Returns immediately — the child runs detached.
 */
export async function spawnAgnetViaCli(input: SpawnViaCliInput): Promise<SpawnViaCliResult> {
  const claudeBin = input.claudeBin ?? discoverClaudeBinary();
  const wt = await createWorktreeForTask({
    projectRoot: input.projectRoot,
    planId: input.planId,
    taskId: input.taskId,
    agnetName: input.agnetName,
    branchHint: input.branchHint,
  });
  const sessionId = randomUUID();
  // Path to orqlaude's server.js — derived from this file's location.
  const thisFile = fileURLToPath(import.meta.url);
  const serverEntry = path.resolve(path.dirname(thisFile), "..", "server.js");
  const mcpConfig = buildMcpConfig(serverEntry, input.stateDir);
  const args = [
    "-p",
    input.prompt,
    "--session-id",
    sessionId,
    "--output-format",
    "stream-json",
    "--permission-mode",
    input.permissionMode ?? "bypassPermissions",
    "--mcp-config",
    mcpConfig,
  ];
  if (input.budgetCapUsd) {
    args.push("--max-budget-usd", String(input.budgetCapUsd));
  }
  // JSONL ends up at ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const jsonlPath = path.join(
    home,
    ".claude",
    "projects",
    wt.path.replace(/\//g, "-"),
    `${sessionId}.jsonl`
  );
  // Spawn detached so it survives the MCP tool call return.
  const child = spawn(claudeBin, args, {
    cwd: wt.path,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ORQLAUDE_STATE_DIR: input.stateDir,
    },
  });
  child.unref();
  return {
    worktreePath: wt.path,
    branch: wt.branch,
    sessionId,
    pid: child.pid ?? -1,
    jsonlPath,
  };
}

/**
 * Remove all orqlaude-managed worktrees for a plan. Safe-by-default: only
 * touches paths under <project>/.orqlaude-worktrees/<plan_short>-*.
 */
export async function cleanupPlanWorktrees(projectRoot: string, planId: string): Promise<string[]> {
  const planShort = planId.slice(0, 8);
  const base = path.join(projectRoot, ".orqlaude-worktrees");
  if (!existsSync(base)) return [];
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(base)).filter((n) => n.startsWith(`${planShort}-`));
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    const wt = path.join(base, entry);
    try {
      execSync(`git worktree remove --force "${wt}"`, { cwd: projectRoot, stdio: "pipe" });
      removed.push(wt);
    } catch {
      // Worktree might be in an inconsistent state. Force-remove the dir.
      try {
        await fs.rm(wt, { recursive: true, force: true });
        removed.push(wt);
      } catch {
        /* leave behind; report and move on */
      }
    }
  }
  return removed;
}
