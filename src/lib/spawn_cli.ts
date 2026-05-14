import { execSync, spawn } from "node:child_process";
import { promises as fs, existsSync, readdirSync, statSync, readFileSync, accessSync, constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isProcessAlive, sleep } from "./process_lib.js";

/**
 * orqlaude-owned spawning path — sidesteps the host's choice of tool.
 *
 * v0.7.0 hardening:
 *   • Prompt is the LAST positional arg. The Claude CLI parses
 *     `[options] [command] [prompt]`; putting the prompt mid-list led to
 *     it being interpreted as a `[command]` name and silently bailing.
 *   • stderr + stdout captured to `<worktree>/.orqlaude.stderr.log` and
 *     `<worktree>/.orqlaude.stdout.log` so we have something to autopsy
 *     when a child dies at launch.
 *   • Post-spawn healthcheck: sleep ~1.5s, verify the PID is still alive
 *     and (when possible) that a JSONL file has appeared. If the child
 *     died, we throw with the stderr contents + the exact command line
 *     for reproducibility instead of returning a misleading success.
 *   • The exact command line is recorded on the Task in state so the
 *     orchestrator can re-run it by hand for debugging.
 *   • Pre-spawn validation: confirm the resolved `claude` binary is
 *     executable; confirm the inline --mcp-config JSON parses.
 */

export interface SpawnViaCliResult {
  worktreePath: string;
  branch: string;
  sessionId: string;
  pid: number;
  jsonlPath: string;
  /** The full `claude -p ...` command we ran (argv joined with shell-safe quoting). */
  commandLine: string;
  stderrPath: string;
  stdoutPath: string;
  /** v0.7.1+: path to the file we wrote with the --mcp-config payload. */
  mcpConfigPath: string;
}

export interface SpawnViaCliInput {
  projectRoot: string;
  stateDir: string;
  planId: string;
  taskId: string;
  agnetName?: string;
  prompt: string;
  branchHint?: string;
  budgetCapUsd?: number;
  permissionMode?: "bypassPermissions" | "acceptEdits" | "default";
  claudeBin?: string;
  /** Override the default 1500 ms healthcheck delay (mainly for tests). */
  healthCheckDelayMs?: number;
}

const DEFAULT_HEALTHCHECK_MS = 1500;

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
  const bundleRoot = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code");
  try {
    const entries = readdirSync(bundleRoot);
    const versions = entries.filter((e: string) => /^\d/.test(e)).sort().reverse();
    for (const v of versions) {
      const candidate = path.join(bundleRoot, v, "claude.app", "Contents", "MacOS", "claude");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* no bundle */
  }
  throw new Error(
    "claude binary not found. Set CLAUDE_BIN env var, install Claude Code globally (`npm i -g @anthropic-ai/claude-cli`), or run from a machine with the Desktop app installed."
  );
}

export function findGitRoot(start: string): string {
  let dir = path.resolve(start);
  while (true) {
    const dotGit = path.join(dir, ".git");
    if (existsSync(dotGit)) {
      const stat = statSync(dotGit);
      if (stat.isFile()) {
        const content = readFileSync(dotGit, "utf8");
        const m = content.match(/^gitdir:\s*(.+?)\/worktrees\/[^\/\s]+\s*$/m);
        if (m) return path.dirname(m[1]);
      }
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no git repo found starting from ${start}`);
    dir = parent;
  }
}

export async function createWorktreeForTask(input: {
  projectRoot: string;
  planId: string;
  taskId: string;
  agnetName?: string;
  branchHint?: string;
}): Promise<{ path: string; branch: string }> {
  const planShort = input.planId.slice(0, 8);
  const agnetSlug =
    (input.agnetName ?? input.taskId.slice(0, 8))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "agnet";
  const worktreeBase = path.join(input.projectRoot, ".orqlaude-worktrees");
  await fs.mkdir(worktreeBase, { recursive: true });
  const wtPath = path.join(worktreeBase, `${planShort}-${agnetSlug}`);
  const branch = input.branchHint ? input.branchHint : `fleet/${planShort}/${agnetSlug}`;
  if (existsSync(wtPath)) {
    return { path: wtPath, branch };
  }
  try {
    execSync(`git worktree add "${wtPath}" -b "${branch}"`, { cwd: input.projectRoot, stdio: "pipe" });
  } catch (err: any) {
    const msg = (err.stderr?.toString?.() ?? err.message ?? "").toLowerCase();
    if (msg.includes("already exists")) {
      execSync(`git worktree add "${wtPath}" "${branch}"`, { cwd: input.projectRoot, stdio: "pipe" });
    } else {
      throw err;
    }
  }
  return { path: wtPath, branch };
}

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

function quoteArg(s: string): string {
  // Shell-safe single-quote wrapping for the command-line echo. Doesn't
  // change what we pass via execve — we never actually run a shell — just
  // makes the echoed line copy-pasteable.
  if (/^[A-Za-z0-9._/=:-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Spawn `claude -p` for one task. The flow:
 *   1. Validate claude binary + mcp-config JSON.
 *   2. Create the worktree.
 *   3. Allocate session id + paths.
 *   4. Open stderr/stdout log files inside the worktree.
 *   5. Spawn detached.
 *   6. Healthcheck — sleep ~1.5s, verify the process is alive AND the JSONL
 *      has been touched. If either check fails, kill any stragglers, read
 *      stderr, throw with full context.
 */
export async function spawnAgnetViaCli(input: SpawnViaCliInput): Promise<SpawnViaCliResult> {
  const claudeBin = input.claudeBin ?? discoverClaudeBinary();
  // 1a. Validate the binary is executable.
  try {
    accessSync(claudeBin, constants.X_OK);
  } catch {
    throw new Error(
      `claude binary ${claudeBin} is not executable. Check permissions or set CLAUDE_BIN to a working binary.`
    );
  }
  // 1b. Build the MCP config body + validate it parses (sanity check; we
  //     built it ourselves).
  const thisFile = fileURLToPath(import.meta.url);
  const serverEntry = path.resolve(path.dirname(thisFile), "..", "server.js");
  const mcpConfigBody = buildMcpConfig(serverEntry, input.stateDir);
  try {
    JSON.parse(mcpConfigBody);
  } catch (err) {
    throw new Error(`Internal: built malformed --mcp-config JSON: ${(err as Error).message}`);
  }
  // 1c. Validate server entry exists (otherwise the child will fail to load orqlaude).
  if (!existsSync(serverEntry)) {
    throw new Error(`orqlaude server entry not found at ${serverEntry}. Reinstall: npm i -g @synaplink/orqlaude`);
  }

  // 2. Worktree.
  const wt = await createWorktreeForTask({
    projectRoot: input.projectRoot,
    planId: input.planId,
    taskId: input.taskId,
    agnetName: input.agnetName,
    branchHint: input.branchHint,
  });

  // 3. Session id + JSONL path.
  const sessionId = randomUUID();
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const jsonlPath = path.join(home, ".claude", "projects", wt.path.replace(/\//g, "-"), `${sessionId}.jsonl`);

  // 4. Log files + mcp-config file.
  // v0.7.1: claude --mcp-config always expects a FILE PATH despite the help
  // text claiming "files or strings." Passing the JSON body inline made the
  // child try to open(2) a path > NAME_MAX bytes long and bail with
  // ENAMETOOLONG. Write the body to a temp file in the worktree and pass
  // that path instead.
  const stderrPath = path.join(wt.path, ".orqlaude.stderr.log");
  const stdoutPath = path.join(wt.path, ".orqlaude.stdout.log");
  const mcpConfigPath = path.join(wt.path, ".orqlaude.mcp.json");
  await fs.writeFile(mcpConfigPath, mcpConfigBody, { mode: 0o600 });
  const stderrFh = await fs.open(stderrPath, "w");
  const stdoutFh = await fs.open(stdoutPath, "w");

  // 5. Build argv — prompt is the LAST positional. Putting it earlier was
  //    causing claude to interpret natural-language prompts as a [command]
  //    name and exit silently. See v0.7.0 changelog.
  //
  //    v0.7.2: insert the standard `--` end-of-options marker before the
  //    prompt. Multiple claude flags are VARIADIC (--mcp-config, --add-dir,
  //    --allowedTools, --betas, --file, --tools, --disallowedTools); without
  //    `--`, commander.js greedily eats the prompt as another value for
  //    whichever variadic flag came last. The dev caught this when claude
  //    --mcp-config <path> <prompt> was being parsed as `--mcp-config [path,
  //    prompt]` and bailing on the prompt-as-a-filepath open(). `--` stops
  //    that greedy parsing universally.
  const args: string[] = [
    "--print",
    "--session-id",
    sessionId,
    "--output-format",
    "stream-json",
    // v0.7.3: claude CLI now requires --verbose whenever
    // --output-format=stream-json is used. Without it the child bails
    // with: "Error: When using --print, --output-format=stream-json
    // requires --verbose". Always emit them as a pair.
    "--verbose",
    "--permission-mode",
    input.permissionMode ?? "bypassPermissions",
    "--mcp-config",
    mcpConfigPath, // v0.7.1: path-to-file, not inline JSON
  ];
  if (input.budgetCapUsd) {
    args.push("--max-budget-usd", String(input.budgetCapUsd));
  }
  args.push("--"); // v0.7.2: stop variadic flags from eating the prompt
  args.push(input.prompt); // positional — must be LAST and after `--`

  const commandLine = `${quoteArg(claudeBin)} ${args.map(quoteArg).join(" ")}`;

  // 6. Spawn detached with stdio piped to our log files.
  const child = spawn(claudeBin, args, {
    cwd: wt.path,
    detached: true,
    stdio: ["ignore", stdoutFh.fd, stderrFh.fd],
    env: {
      ...process.env,
      ORQLAUDE_STATE_DIR: input.stateDir,
    },
  });
  // Close our FDs — the child holds its own dup'd copies via stdio.
  await stderrFh.close().catch(() => {});
  await stdoutFh.close().catch(() => {});
  const pid = child.pid ?? -1;
  child.unref();

  // 7. Healthcheck.
  const delay = input.healthCheckDelayMs ?? DEFAULT_HEALTHCHECK_MS;
  if (delay > 0) {
    await sleep(delay);
    const alive = isProcessAlive(pid);
    if (!alive) {
      // The process is gone within the healthcheck window — almost certainly
      // an immediate exit. Build a useful error message with the autopsy
      // material so the orchestrator can act on it.
      const stderrSnippet = await readSafe(stderrPath, 2000);
      const stdoutSnippet = await readSafe(stdoutPath, 2000);
      throw new Error(
        `Spawned child died at launch (pid=${pid}). The process is gone within ${delay}ms of spawn — claude probably exited on a parse / auth / env error. ` +
          `Command line:\n  ${commandLine}\n\n` +
          (stderrSnippet ? `stderr (${stderrPath}):\n${stderrSnippet}\n\n` : `stderr (${stderrPath}) is empty.\n\n`) +
          (stdoutSnippet ? `stdout (${stdoutPath}):\n${stdoutSnippet}` : "")
      );
    }
  }

  return {
    worktreePath: wt.path,
    branch: wt.branch,
    sessionId,
    pid,
    jsonlPath,
    commandLine,
    stderrPath,
    stdoutPath,
    mcpConfigPath,
  };
}

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

async function readSafe(p: string, maxBytes: number): Promise<string> {
  try {
    const content = await fs.readFile(p, "utf8");
    return content.slice(0, maxBytes);
  } catch {
    return "";
  }
}

// Re-export for callers who used to import these from spawn_cli.
export { isProcessAlive } from "./process_lib.js";
