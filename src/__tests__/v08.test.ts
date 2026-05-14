import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { StateStore } from "../lib/state.js";
import { snapshotSession, clearTailCache, jsonlPathFor, encodeCwdForProjects } from "../lib/jsonl_tail.js";
import { sanitizeChildEnv, createWorktreeForTask } from "../lib/spawn_cli.js";

/**
 * v0.8.0 — robustness audit fixes.
 */

async function mkTempGitRepo(): Promise<string> {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), "orqlaude-v08-"));
  const real = await fs.realpath(raw);
  execSync("git init -q", { cwd: real });
  execSync("git config user.email t@e", { cwd: real });
  execSync("git config user.name t", { cwd: real });
  await fs.writeFile(path.join(real, "README.md"), "test\n");
  execSync("git add . && git commit -q -m init", { cwd: real });
  return real;
}

// ---- bug 1 + 2: StateStore lock ownership ----------------------------------

test("v0.8.0 bug 2: a process whose lock was stolen does NOT delete the replacement", async () => {
  // Simulate: process A acquires the lock, but then the file is overwritten
  // by process B (as would happen if A's PID was reaped as stale). A's
  // release should NOT delete B's lock.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orqlaude-lock-"));
  const lockPath = path.join(dir, "lock");
  const store = new StateStore(dir);
  // Drive a real update to acquire+release the lock so we exercise the path.
  // We'll race-overwrite the lock file in the middle.
  const racePromise = store.update(async (s) => {
    s.plans["sentinel"] = {
      id: "sentinel",
      createdAt: 1,
      rootTask: "x",
      budgetCapTokens: 1,
      perAgentCapTokens: 1,
      status: "draft",
      tasks: [],
      notes: [],
      messages: [],
      claims: [],
      userNotifications: [],
      userResponseRequests: [],
      userStreams: [],
    } as any;
    // While we're holding the lock, simulate another process replacing it.
    await fs.writeFile(lockPath, "99999\nother-token\n0\n", { mode: 0o600 });
  });
  await racePromise;
  // The "other-token" file should STILL exist — our release should not have
  // touched it because the token didn't match.
  const contents = await fs.readFile(lockPath, "utf8").catch(() => "(gone)");
  assert.match(contents, /other-token/, `expected lock to still contain other-token, got: ${contents}`);
});

test("v0.8.0 bug 2: normal release deletes the lock when we still own it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orqlaude-lock-"));
  const lockPath = path.join(dir, "lock");
  const store = new StateStore(dir);
  await store.update(() => {
    /* no-op mutator */
  });
  assert.equal(await exists(lockPath), false, "expected lock file to be cleaned up after successful update");
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

// ---- bug 3: jsonl_tail cache invalidation on inode/mtime ------------------

test("v0.8.0 bug 3: jsonl cache invalidates on same-size file replacement", async () => {
  clearTailCache();
  // Build a fake JSONL location matching jsonlPathFor()'s shape.
  const sessionId = "00000000-0000-0000-0000-000000000111";
  const fakeProject = "/tmp/orqlaude-v08-jsonl-cache-test";
  const expectedPath = jsonlPathFor(fakeProject, sessionId);
  // Build the parent dir explicitly.
  await fs.mkdir(path.dirname(expectedPath), { recursive: true });
  // Write version 1. Use 5-char subtypes so v1 and v2 are exactly the same
  // byte length, defeating the v0.2 "byteOffset==size" early-return path.
  const v1Line = JSON.stringify({ type: "result", subtype: "alpha" }) + "\n";
  await fs.writeFile(expectedPath, v1Line);
  const snap1 = await snapshotSession(fakeProject, sessionId);
  assert.equal(snap1.terminationReason, "alpha");

  // Replace with same-length but different content.
  const v2Line = JSON.stringify({ type: "result", subtype: "omega" }) + "\n";
  assert.equal(v2Line.length, v1Line.length, "test setup: v1 and v2 must be the same length");
  // Wait a beat to ensure mtime advances by at least 1ms.
  await new Promise((r) => setTimeout(r, 25));
  await fs.unlink(expectedPath); // forces a new inode
  await fs.writeFile(expectedPath, v2Line);

  const snap2 = await snapshotSession(fakeProject, sessionId);
  assert.equal(snap2.terminationReason, "omega", "cache should have invalidated on inode change");

  await fs.rm(path.dirname(expectedPath), { recursive: true, force: true });
});

// ---- bug 4: createWorktreeForTask resists shell-injecting branchHint ------

test("v0.8.0 bug 4: branchHint with shell-special chars doesn't escape the spawn", async () => {
  const repo = await mkTempGitRepo();
  // A branchHint that would have shelled out under execSync-with-template.
  const malicious = `foo"; touch /tmp/orqlaude-pwned-${Date.now()} ; echo "x`;
  const sentinel = `/tmp/orqlaude-pwned-${Date.now()}`;
  await createWorktreeForTask({
    projectRoot: repo,
    planId: "deadbeef-aaaa-bbbb-cccc-dddddddddddd",
    taskId: "11111111-2222-3333-4444-555555555555",
    agnetName: "InjTest",
    branchHint: malicious,
  });
  // The sentinel should NOT have been created by a shell side-effect. We
  // can't predict the exact /tmp/orqlaude-pwned-<ts> path, but if any
  // matching sentinel got created, that'd be the injection working.
  const tmpEntries = await fs.readdir("/tmp").catch(() => [] as string[]);
  const matched = tmpEntries.filter((n) => n.startsWith("orqlaude-pwned-"));
  assert.equal(matched.length, 0, `unexpected shell side-effect: ${matched.join(", ")}`);
});

test("v0.8.0 bug 4: branchHint with git-invalid chars is sanitized to a safe name", async () => {
  const repo = await mkTempGitRepo();
  const result = await createWorktreeForTask({
    projectRoot: repo,
    planId: "deadbeef-aaaa-bbbb-cccc-dddddddddddd",
    taskId: "22222222-3333-4444-5555-666666666666",
    agnetName: "Sanitize",
    branchHint: "feature spaces and *stars*",
  });
  // No spaces or stars should survive.
  assert.doesNotMatch(result.branch, /[\s*]/);
});

// ---- bug 5: sanitizeChildEnv strips host pollution -------------------------

test("v0.8.0 bug 5: sanitizeChildEnv strips CLAUDE_CODE_* and empty Anthropic auth", () => {
  const savedEnv = { ...process.env };
  try {
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "claude-desktop";
    process.env.CLAUDE_AGENT_SDK_VERSION = "0.2.138";
    process.env.CLAUDECODE = "1";
    process.env.ANTHROPIC_API_KEY = ""; // empty placeholder from host
    process.env.PATH = "/usr/bin";
    process.env.HOME = "/Users/test";
    process.env.LANG = "en_US.UTF-8";
    const env = sanitizeChildEnv({ ORQLAUDE_STATE_DIR: "/tmp/x" });
    // Stripped:
    assert.equal(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, undefined);
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
    assert.equal(env.CLAUDE_AGENT_SDK_VERSION, undefined);
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined, "empty ANTHROPIC_API_KEY should be stripped");
    // Kept:
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/Users/test");
    assert.equal(env.LANG, "en_US.UTF-8");
    // Override applied:
    assert.equal(env.ORQLAUDE_STATE_DIR, "/tmp/x");
  } finally {
    process.env = savedEnv;
  }
});

test("v0.8.0 bug 5: sanitizeChildEnv preserves non-empty ANTHROPIC_API_KEY", () => {
  const savedEnv = { ...process.env };
  try {
    process.env.ANTHROPIC_API_KEY = "sk-ant-real-key";
    const env = sanitizeChildEnv();
    assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-real-key");
  } finally {
    process.env = savedEnv;
  }
});
