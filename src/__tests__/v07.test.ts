import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { isProcessAlive } from "../lib/process_lib.js";
import { spawnAgnetViaCli } from "../lib/spawn_cli.js";

/**
 * v0.7.0: process-liveness + spawn robustness regression tests.
 */

test("isProcessAlive: own PID is alive", () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test("isProcessAlive: PID 1 reports alive (init exists on every OS)", () => {
  // We don't OWN pid 1, but isProcessAlive should report true via EPERM
  // detection rather than returning false.
  assert.equal(isProcessAlive(1), true);
});

test("isProcessAlive: impossibly large PID is dead", () => {
  // 2^31 - 1 is past any realistic process table.
  assert.equal(isProcessAlive(2147483647), false);
});

test("isProcessAlive: 0 / negative / undefined are dead", () => {
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(undefined), false);
  assert.equal(isProcessAlive(null), false);
});

test("spawnAgnetViaCli: rejects when claude binary doesn't exist", async () => {
  // Build a minimal fake git repo so createWorktreeForTask doesn't fail
  // earlier on its own.
  const dir = await mkTempGitRepo();
  await assert.rejects(
    () =>
      spawnAgnetViaCli({
        projectRoot: dir,
        stateDir: path.join(dir, ".orqlaude"),
        planId: "deadbeef-1111-2222-3333-444444444444",
        taskId: "11111111-2222-3333-4444-555555555555",
        agnetName: "Test",
        prompt: "noop",
        claudeBin: "/nonexistent/path/to/claude",
        healthCheckDelayMs: 0,
      }),
    /not executable|ENOENT|EACCES/i
  );
});

test("spawnAgnetViaCli: when child dies at launch, throws with stderr + commandLine", async () => {
  // Use /bin/false (or `false` on PATH) — it exits immediately with code 1.
  // The healthcheck should detect the dead PID and throw with autopsy info.
  const falseBin = existsSync("/bin/false") ? "/bin/false" : "/usr/bin/false";
  if (!existsSync(falseBin)) {
    // Skip on platforms without /bin/false; the contract is otherwise
    // verified by the other tests.
    return;
  }
  const dir = await mkTempGitRepo();
  await assert.rejects(
    () =>
      spawnAgnetViaCli({
        projectRoot: dir,
        stateDir: path.join(dir, ".orqlaude"),
        planId: "deadbeef-1111-2222-3333-444444444444",
        taskId: "22222222-3333-4444-5555-666666666666",
        agnetName: "Dies",
        prompt: "this prompt should appear in the command line echo",
        claudeBin: falseBin,
        healthCheckDelayMs: 500, // short
      }),
    (err: Error) => {
      // The error message must include:
      //   • "died at launch"
      //   • the command line (so we can copy-paste to reproduce)
      //   • mention of the prompt as the last arg
      assert.match(err.message, /died at launch/i);
      assert.match(err.message, /Command line:/i);
      assert.match(err.message, /this prompt should appear in the command line echo/);
      return true;
    }
  );
  // After failure, the stderr log file should exist in the worktree.
  const worktreeBase = path.join(dir, ".orqlaude-worktrees");
  const found = await fs.readdir(worktreeBase);
  assert.ok(found.length > 0, "expected a worktree to have been created before the spawn died");
});

test("spawnAgnetViaCli: prompt is the LAST positional argv element", async () => {
  // Same /bin/false trick but assert on the exact shape of commandLine
  // captured in the thrown error.
  const falseBin = existsSync("/bin/false") ? "/bin/false" : "/usr/bin/false";
  if (!existsSync(falseBin)) return;
  const dir = await mkTempGitRepo();
  let captured: string | null = null;
  try {
    await spawnAgnetViaCli({
      projectRoot: dir,
      stateDir: path.join(dir, ".orqlaude"),
      planId: "deadbeef-aaaa-bbbb-cccc-dddddddddddd",
      taskId: "33333333-4444-5555-6666-777777777777",
      agnetName: "ArgOrder",
      prompt: "ZZZ_PROMPT_SENTINEL_ZZZ",
      claudeBin: falseBin,
      healthCheckDelayMs: 500,
    });
  } catch (err) {
    captured = (err as Error).message;
  }
  assert.ok(captured, "expected the spawn to fail and surface the command line");
  // Pull the command-line line from the error message.
  const m = captured!.match(/Command line:\n\s*(.+)/);
  assert.ok(m, "error message should contain 'Command line:'");
  const cmd = m![1];
  // The last shell token should be the quoted prompt — i.e. the prompt
  // sentinel should appear AFTER every --flag.
  const promptIdx = cmd.lastIndexOf("ZZZ_PROMPT_SENTINEL_ZZZ");
  const lastFlagIdx = Math.max(
    cmd.lastIndexOf("--session-id"),
    cmd.lastIndexOf("--output-format"),
    cmd.lastIndexOf("--permission-mode"),
    cmd.lastIndexOf("--mcp-config")
  );
  assert.ok(promptIdx > lastFlagIdx, `prompt must appear after the last flag — got cmd=\n${cmd}`);
});

test("v0.7.1: --mcp-config is a PATH (written to worktree), not inline JSON", async () => {
  const falseBin = existsSync("/bin/false") ? "/bin/false" : "/usr/bin/false";
  if (!existsSync(falseBin)) return;
  const dir = await mkTempGitRepo();
  let captured: string | null = null;
  try {
    await spawnAgnetViaCli({
      projectRoot: dir,
      stateDir: path.join(dir, ".orqlaude"),
      planId: "feedface-aaaa-bbbb-cccc-dddddddddddd",
      taskId: "44444444-5555-6666-7777-888888888888",
      agnetName: "McpPath",
      prompt: "P",
      claudeBin: falseBin,
      healthCheckDelayMs: 500,
    });
  } catch (err) {
    captured = (err as Error).message;
  }
  assert.ok(captured, "expected the spawn to fail and surface the command line");
  // The arg passed to --mcp-config should look like a path, not a JSON body.
  const cmd = captured!.match(/Command line:\n\s*(.+)/)![1];
  const m = cmd.match(/--mcp-config\s+(\S+)/);
  assert.ok(m, "expected --mcp-config <arg> in the command line");
  const mcpArg = m![1].replace(/^'|'$/g, ""); // strip quotes if present
  assert.ok(!mcpArg.startsWith("{"), `--mcp-config arg should NOT be inline JSON (got: ${mcpArg.slice(0, 50)}...)`);
  assert.ok(mcpArg.endsWith(".orqlaude.mcp.json"), `--mcp-config arg should be the .orqlaude.mcp.json path (got: ${mcpArg})`);
  // The file should exist and contain valid JSON with the expected shape.
  const body = await fs.readFile(mcpArg, "utf8");
  const parsed = JSON.parse(body);
  assert.ok(parsed.mcpServers?.orqlaude?.command, "the written config should have mcpServers.orqlaude.command");
  assert.ok(parsed.mcpServers.orqlaude.args?.length >= 1, "should have args[]");
});

test("v0.7.3: --verbose is paired with --output-format=stream-json", async () => {
  const falseBin = existsSync("/bin/false") ? "/bin/false" : "/usr/bin/false";
  if (!existsSync(falseBin)) return;
  const dir = await mkTempGitRepo();
  let captured: string | null = null;
  try {
    await spawnAgnetViaCli({
      projectRoot: dir,
      stateDir: path.join(dir, ".orqlaude"),
      planId: "8badf00d-aaaa-bbbb-cccc-dddddddddddd",
      taskId: "66666666-7777-8888-9999-aaaaaaaaaaaa",
      agnetName: "Verbose",
      prompt: "P",
      claudeBin: falseBin,
      healthCheckDelayMs: 500,
    });
  } catch (err) {
    captured = (err as Error).message;
  }
  assert.ok(captured, "expected the spawn to fail and surface the command line");
  const cmd = captured!.match(/Command line:\n\s*(.+)/)![1];
  // The claude CLI requires --verbose whenever --output-format=stream-json
  // is used (otherwise it bails with a pairing error).
  assert.match(cmd, /--verbose/, `expected --verbose in the command line; got:\n${cmd}`);
  assert.match(cmd, /--output-format\s+stream-json/, `expected --output-format stream-json; got:\n${cmd}`);
});

test("v0.7.2: `--` separator appears between the last flag and the prompt", async () => {
  // claude has multiple variadic flags (--mcp-config, --add-dir,
  // --allowedTools, --betas, --file, --tools, --disallowedTools). Without
  // an explicit end-of-options marker, the parser greedily eats the prompt
  // as another value for whichever variadic flag came last.
  const falseBin = existsSync("/bin/false") ? "/bin/false" : "/usr/bin/false";
  if (!existsSync(falseBin)) return;
  const dir = await mkTempGitRepo();
  let captured: string | null = null;
  try {
    await spawnAgnetViaCli({
      projectRoot: dir,
      stateDir: path.join(dir, ".orqlaude"),
      planId: "cafef00d-aaaa-bbbb-cccc-dddddddddddd",
      taskId: "55555555-6666-7777-8888-999999999999",
      agnetName: "DashDash",
      prompt: "QQQ_PROMPT_QQQ",
      claudeBin: falseBin,
      healthCheckDelayMs: 500,
    });
  } catch (err) {
    captured = (err as Error).message;
  }
  assert.ok(captured, "expected the spawn to fail and surface the command line");
  const cmd = captured!.match(/Command line:\n\s*(.+)/)![1];
  // `--` should appear, AND it should appear AFTER --mcp-config <path>
  // (i.e. after the last variadic flag), AND before the prompt sentinel.
  const dashDashIdx = cmd.indexOf(" -- ");
  const promptIdx = cmd.indexOf("QQQ_PROMPT_QQQ");
  const mcpFlagIdx = cmd.indexOf("--mcp-config");
  assert.ok(dashDashIdx > 0, `expected \` -- \` in command line; got:\n${cmd}`);
  assert.ok(dashDashIdx > mcpFlagIdx, `\` -- \` must come after --mcp-config`);
  assert.ok(promptIdx > dashDashIdx, `prompt must come after \` -- \``);
});

async function mkTempGitRepo(): Promise<string> {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), "orqlaude-v07-"));
  const real = await fs.realpath(raw);
  execSync("git init -q", { cwd: real });
  execSync("git config user.email t@e", { cwd: real });
  execSync("git config user.name t", { cwd: real });
  // Need at least one commit so `git worktree add -b ...` succeeds.
  await fs.writeFile(path.join(real, "README.md"), "test\n");
  execSync("git add . && git commit -q -m init", { cwd: real });
  return real;
}
