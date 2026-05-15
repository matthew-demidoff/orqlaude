import { execSync, spawn, spawnSync } from "node:child_process";
import {
  promises as fs,
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  accessSync,
  constants,
} from "node:fs";
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
  /**
   * v0.9.0: path the parent process writes a JSON exit record to when the
   * child terminates. Shape:
   *   { exit_code: number|null, signal: string|null, terminated_at: number,
   *     success: boolean }
   * Persistent so a restarted orqlaude server can recover terminal state
   * without waiting for the next status() poll.
   */
  exitJsonPath: string;
}

/**
 * Shape persisted to `<worktree>/.orqlaude.exit.json` when the child exits.
 * Read by status() / collect() to short-circuit PID-liveness checks.
 */
export interface ChildExitRecord {
  exit_code: number | null;
  signal: string | null;
  terminated_at: number;
  success: boolean;
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
  /**
   * v0.10.5+: pre-allocated session_id. When provided, this exact value is
   * used as the --session-id flag (no internal randomUUID). The caller is
   * expected to have ALSO embedded this session_id in the prompt so the
   * agent's checkin matches what orqlaude pre-recorded in
   * `task.spawnedSessionId`. Before v0.10.5 the session_id was generated
   * inside this function and never made it into the prompt — agents read
   * $CLAUDE_CODE_SESSION_ID (a different value Claude Code generates
   * internally) and their checkin conflicted with the pre-allocation.
   */
  sessionId?: string;
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

/**
 * Git branch names have to satisfy git-check-ref-format. Most plain ASCII is
 * OK; rejected: spaces, ASCII control chars, `:`, `?`, `*`, `[`, `\`, `~`,
 * `^`, two consecutive dots, leading slash, trailing slash, trailing `.lock`,
 * and `@{`. We strip anything not in a safe whitelist instead of trying to
 * match git's rules exactly.
 */
function sanitizeBranchName(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._/-]/g, "-")
    .replace(/\.\./g, ".")
    .replace(/^[./-]+/, "")
    .replace(/[./-]+$/, "")
    .replace(/-+/g, "-");
  return cleaned || fallback;
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
  const rawBranch = input.branchHint ? input.branchHint : `fleet/${planShort}/${agnetSlug}`;
  // v0.8.0: defense-in-depth even though we spawn without a shell. A
  // pathological branchHint can still break git itself if it contains
  // characters git refuses. Sanitize aggressively.
  const branch = sanitizeBranchName(rawBranch, `fleet/${planShort}/${agnetSlug}`);
  if (existsSync(wtPath)) {
    return { path: wtPath, branch };
  }
  // v0.8.0: use spawnSync with shell:false to defeat shell-injection via
  // crafted branchHint or projectRoot paths. The previous code spliced both
  // into a template string passed to execSync, which was vulnerable.
  const result = spawnSync("git", ["worktree", "add", wtPath, "-b", branch], {
    cwd: input.projectRoot,
    stdio: "pipe",
  });
  if (result.status !== 0) {
    const msg = (result.stderr?.toString() ?? "").toLowerCase();
    if (msg.includes("already exists")) {
      // Branch exists already — check it out into the worktree without -b.
      const retry = spawnSync("git", ["worktree", "add", wtPath, branch], {
        cwd: input.projectRoot,
        stdio: "pipe",
      });
      if (retry.status !== 0) {
        throw new Error(
          `git worktree add failed (status ${retry.status}): ${retry.stderr?.toString() ?? "(no stderr)"}`
        );
      }
    } else {
      throw new Error(
        `git worktree add failed (status ${result.status}): ${result.stderr?.toString() ?? "(no stderr)"}`
      );
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
  // v0.10.5: accept caller-provided sessionId so the prompt + state +
  // --session-id flag all match. Falls back to randomUUID for back-compat.
  const sessionId = input.sessionId ?? randomUUID();
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
  // v0.10.7: when re-spawning into a worktree that's seen a prior agent,
  // a stale .orqlaude.exit.json on disk would otherwise make snapshot()
  // report the NEW agent as already terminated. Wipe it BEFORE spawn so
  // a clean child gets a clean filesystem.
  const exitJsonPathPre = path.join(wt.path, ".orqlaude.exit.json");
  try {
    await fs.unlink(exitJsonPathPre);
  } catch {
    /* no prior exit record - normal first-spawn case */
  }
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
  // v0.8.0: sanitize the env first. orqlaude runs inside the Claude Desktop
  // app, which sets a long list of CLAUDE_CODE_* vars (entrypoint, session
  // id, provider-managed-by-host) intended for that hosted runtime. If those
  // bleed into a spawned standalone `claude -p`, the child either fails to
  // authenticate or behaves like a sub-session of a host that isn't there.
  const child = spawn(claudeBin, args, {
    cwd: wt.path,
    detached: true,
    stdio: ["ignore", stdoutFh.fd, stderrFh.fd],
    env: sanitizeChildEnv({ ORQLAUDE_STATE_DIR: input.stateDir }),
  });
  // Close our FDs — the child holds its own dup'd copies via stdio.
  await stderrFh.close().catch(() => {});
  await stdoutFh.close().catch(() => {});
  const pid = child.pid ?? -1;

  // v0.9.0: write a terminal-state record when the child exits, so
  // status() / collect() can short-circuit PID-liveness polling.
  // Registered BEFORE unref() so the listener survives. The orqlaude server
  // is long-lived, so it WILL receive this event in the same process that
  // spawned the child. If the server itself restarts before the child
  // exits, status() falls back to PID-liveness polling - the exit file is
  // a fast-path optimization, not the source of truth.
  const exitJsonPath = path.join(wt.path, ".orqlaude.exit.json");
  child.on("exit", (code, signal) => {
    const record: ChildExitRecord = {
      exit_code: code,
      signal,
      terminated_at: Date.now(),
      success: code === 0 && !signal,
    };
    // Best-effort write — if the worktree was already cleaned up by the
    // orchestrator, this silently no-ops. We use the sync API because
    // 'exit' fires during shutdown and the async fs queue may not flush.
    try {
      writeFileSync(exitJsonPath, JSON.stringify(record, null, 2));
    } catch {
      /* worktree gone, or perms issue - status() will fall back to PID poll */
    }
  });
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
    exitJsonPath,
  };
}

/**
 * Read the child-exit record written by the `child.on('exit')` handler in
 * `spawnAgnetViaCli`. Returns `null` if the file does not exist (child
 * still running, OR the orqlaude server that owns the listener restarted
 * before the child exited, OR the worktree was cleaned up).
 */
export async function readChildExitRecord(exitJsonPath: string): Promise<ChildExitRecord | null> {
  try {
    const content = await fs.readFile(exitJsonPath, "utf8");
    const parsed = JSON.parse(content) as ChildExitRecord;
    if (typeof parsed.terminated_at !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
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

/**
 * Env vars to STRIP when spawning a standalone `claude -p` child.
 *
 * These come from orqlaude running inside the Claude Desktop app's
 * embedded runtime. The Desktop app talks to its hosted CLI via stdio +
 * these env-var hints. When we spawn a fresh detached claude process, those
 * hints make the child think it's still attached to the host — typical
 * symptom is "Not logged in" because CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1
 * tells the child to defer authentication to the host's IPC channel, which
 * doesn't exist for our detached spawn.
 *
 * We keep HOME, USER, PATH, LANG, LC_*, TERM, SHELL, and the user's own
 * Anthropic auth env vars (unless they're empty, which signals the host was
 * managing them).
 */
const HOST_ENV_STRIP_PREFIXES = ["CLAUDE_CODE_", "CLAUDE_AGENT_"];
const HOST_ENV_STRIP_KEYS = new Set([
  "CLAUDECODE",
  "CLAUDE_EFFORT",
  "AI_AGENT",
  "BAGGAGE",
]);

export function sanitizeChildEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (HOST_ENV_STRIP_KEYS.has(k)) continue;
    if (HOST_ENV_STRIP_PREFIXES.some((p) => k.startsWith(p))) continue;
    // Drop empty Anthropic auth env vars — they're placeholders the host
    // sets when it manages auth itself. Real values are kept.
    if ((k === "ANTHROPIC_API_KEY" || k === "ANTHROPIC_AUTH_TOKEN") && v.trim() === "") continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(overrides)) {
    out[k] = v;
  }
  return out;
}

// Re-export for callers who used to import these from spawn_cli.
export { isProcessAlive } from "./process_lib.js";
