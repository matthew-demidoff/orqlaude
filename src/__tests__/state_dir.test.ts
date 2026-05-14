import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveStateDir } from "../lib/state_dir.js";

// On macOS, os.tmpdir() returns a path under /var/folders/... but that's a
// symlink; process.cwd() canonicalizes to /private/var/folders/.... Realpath
// the temp paths up-front so assertions compare like-with-like.
async function mkdtempReal(prefix: string): Promise<string> {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return fs.realpath(raw);
}

/**
 * Regression tests for the state-dir resolver added in v0.3.2 after the
 * `cwd=/` bug report.
 */

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_STATE_DIR_ENV = process.env.ORQLAUDE_STATE_DIR;

function clearEnv() {
  delete process.env.ORQLAUDE_STATE_DIR;
}

function restoreEnv() {
  if (ORIGINAL_STATE_DIR_ENV) process.env.ORQLAUDE_STATE_DIR = ORIGINAL_STATE_DIR_ENV;
  else delete process.env.ORQLAUDE_STATE_DIR;
}

test("ORQLAUDE_STATE_DIR env var wins over everything", () => {
  process.env.ORQLAUDE_STATE_DIR = "/some/explicit/path";
  const r = resolveStateDir();
  assert.equal(r.path, "/some/explicit/path");
  assert.equal(r.source, "env");
  restoreEnv();
});

test("cwd=/ → falls back to ~/.orqlaude/projects/<hash>", async () => {
  clearEnv();
  process.chdir("/");
  try {
    const r = resolveStateDir();
    assert.equal(r.source, "home-fallback", `got source=${r.source}, path=${r.path}`);
    assert.ok(r.path.startsWith(path.join(os.homedir(), ".orqlaude", "projects")), `unexpected path: ${r.path}`);
    assert.ok(/-[a-f0-9]{12}$/.test(r.path), `expected 12-char hash suffix: ${r.path}`);
  } finally {
    process.chdir(ORIGINAL_CWD);
  }
});

test("cwd in /tmp/some-empty-dir → home fallback", async () => {
  clearEnv();
  const empty = await mkdtempReal("orqlaude-nonproject-");
  process.chdir(empty);
  try {
    const r = resolveStateDir();
    assert.equal(r.source, "home-fallback", `non-project dir should fall back, got: ${JSON.stringify(r)}`);
  } finally {
    process.chdir(ORIGINAL_CWD);
  }
});

test("cwd with package.json → uses <cwd>/.orqlaude", async () => {
  clearEnv();
  const proj = await mkdtempReal("orqlaude-proj-");
  await fs.writeFile(path.join(proj, "package.json"), "{}");
  process.chdir(proj);
  try {
    const r = resolveStateDir();
    assert.equal(r.source, "project-root", `should detect project, got: ${JSON.stringify(r)}`);
    assert.equal(r.path, path.join(proj, ".orqlaude"));
  } finally {
    process.chdir(ORIGINAL_CWD);
  }
});

test("cwd with .git directory → uses <cwd>/.orqlaude (project-root, not worktree)", async () => {
  clearEnv();
  const proj = await mkdtempReal("orqlaude-git-");
  await fs.mkdir(path.join(proj, ".git"));
  process.chdir(proj);
  try {
    const r = resolveStateDir();
    assert.equal(r.source, "project-root");
    assert.equal(r.path, path.join(proj, ".orqlaude"));
  } finally {
    process.chdir(ORIGINAL_CWD);
  }
});

test("cwd in a git worktree (.git is a file) → resolves to parent checkout's .orqlaude", async () => {
  clearEnv();
  // Build a fake worktree layout
  const main = await mkdtempReal("orqlaude-main-");
  await fs.mkdir(path.join(main, ".git"));
  await fs.mkdir(path.join(main, ".git", "worktrees"));
  await fs.mkdir(path.join(main, ".git", "worktrees", "wt1"));
  const worktree = await mkdtempReal("orqlaude-wt-");
  await fs.writeFile(
    path.join(worktree, ".git"),
    `gitdir: ${path.join(main, ".git", "worktrees", "wt1")}\n`
  );
  process.chdir(worktree);
  try {
    const r = resolveStateDir();
    assert.equal(r.source, "worktree", `worktree resolution failed: ${JSON.stringify(r)}`);
    assert.equal(r.path, path.join(main, ".orqlaude"));
  } finally {
    process.chdir(ORIGINAL_CWD);
  }
});

test("home-fallback path is deterministic across calls for the same cwd", async () => {
  clearEnv();
  const empty = await mkdtempReal("orqlaude-stable-");
  process.chdir(empty);
  try {
    const r1 = resolveStateDir();
    const r2 = resolveStateDir();
    assert.equal(r1.path, r2.path);
    assert.equal(r1.source, "home-fallback");
  } finally {
    process.chdir(ORIGINAL_CWD);
  }
});
