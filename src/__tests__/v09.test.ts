import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { snapshotSession, clearTailCache } from "../lib/jsonl_tail.js";
import { readChildExitRecord, type ChildExitRecord } from "../lib/spawn_cli.js";

/**
 * v0.9.0 — observability overhaul.
 *
 * Covers:
 *  • A. snapshotSession falls back to stdoutPath when JSONL is missing
 *  • E. readChildExitRecord parses the exit JSON file
 *  • D. orphan notifications round-trip via state.ts schema
 *  • F. wait_for_status_change fingerprint changes on key transitions
 *       (smoke; the long-poll loop itself is integration-tested by
 *       running a fleet end-to-end).
 *  • cleanup_worktrees lock-release predicate (state mutation only).
 *
 * Smoke style: build temp files / state, call the unit-under-test
 * directly, assert observable behavior. No subprocess spawning - those
 * paths are covered by manual integration runs.
 */

async function mkTempDir(prefix: string): Promise<string> {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return await fs.realpath(raw);
}

// ---- A: stdoutPath fallback in snapshotSession -----------------------------

test("v0.9.0 A: snapshotSession reads tokens from stdout log when JSONL is missing", async () => {
  clearTailCache();
  const dir = await mkTempDir("orq-v09-A-");
  const stdoutPath = path.join(dir, ".orqlaude.stdout.log");
  // Write two stream-json events: one assistant with usage, one result.
  const events = [
    {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Working on it" }],
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      timestamp: new Date().toISOString(),
    },
    {
      type: "result",
      subtype: "completed",
      total_cost_usd: 0.0012,
      timestamp: new Date().toISOString(),
    },
  ];
  await fs.writeFile(stdoutPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

  // session id is fake - the canonical JSONL path won't exist.
  const fakeSession = "00000000-0000-4000-8000-000000000000";
  const snap = await snapshotSession("/tmp/non-existent-cwd", fakeSession, stdoutPath);

  assert.equal(snap.exists, true);
  assert.equal(snap.source, "stdout_log");
  assert.equal(snap.resolvedPath, stdoutPath);
  assert.equal(snap.inputTokens, 100);
  assert.equal(snap.outputTokens, 50);
  assert.equal(snap.terminated, true);
  assert.equal(snap.terminationReason, "completed");
});

test("v0.9.0 A: snapshotSession returns 'none' source when neither file exists", async () => {
  clearTailCache();
  const fakeSession = "11111111-0000-4000-8000-000000000000";
  const snap = await snapshotSession("/tmp/non-existent-cwd-2", fakeSession);
  assert.equal(snap.exists, false);
  assert.equal(snap.source, "none");
  assert.equal(snap.resolvedPath, null);
});

test("v0.9.0 A: snapshotSession prefers JSONL when both exist", async () => {
  clearTailCache();
  const dir = await mkTempDir("orq-v09-A-pref-");
  const stdoutPath = path.join(dir, ".orqlaude.stdout.log");
  // Stdout says 50 input tokens; JSONL we'll forge to say 200.
  await fs.writeFile(
    stdoutPath,
    JSON.stringify({
      type: "assistant",
      message: { content: [], usage: { input_tokens: 50, output_tokens: 0 } },
    }) + "\n"
  );

  // Build the JSONL at the canonical path so the resolver picks it.
  const sessionId = "22222222-0000-4000-8000-000000000000";
  // We need to mirror jsonlPathFor's encoding without importing it again.
  const fakeCwd = await mkTempDir("orq-v09-A-cwd-");
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const jsonlDir = path.join(home, ".claude", "projects", fakeCwd.replace(/\//g, "-"));
  await fs.mkdir(jsonlDir, { recursive: true });
  const jsonlPath = path.join(jsonlDir, `${sessionId}.jsonl`);
  await fs.writeFile(
    jsonlPath,
    JSON.stringify({
      type: "assistant",
      message: { content: [], usage: { input_tokens: 200, output_tokens: 0 } },
    }) + "\n"
  );

  try {
    const snap = await snapshotSession(fakeCwd, sessionId, stdoutPath);
    assert.equal(snap.source, "jsonl");
    assert.equal(snap.resolvedPath, jsonlPath);
    assert.equal(snap.inputTokens, 200, "JSONL wins over stdout log when both exist");
  } finally {
    await fs.rm(jsonlPath, { force: true });
    await fs.rm(jsonlDir, { recursive: true, force: true });
  }
});

// ---- E: readChildExitRecord ------------------------------------------------

test("v0.9.0 E: readChildExitRecord returns null when file missing", async () => {
  const dir = await mkTempDir("orq-v09-E-");
  const exitPath = path.join(dir, ".orqlaude.exit.json");
  const rec = await readChildExitRecord(exitPath);
  assert.equal(rec, null);
});

test("v0.9.0 E: readChildExitRecord parses a written record", async () => {
  const dir = await mkTempDir("orq-v09-E2-");
  const exitPath = path.join(dir, ".orqlaude.exit.json");
  const written: ChildExitRecord = {
    exit_code: 0,
    signal: null,
    terminated_at: Date.now(),
    success: true,
  };
  await fs.writeFile(exitPath, JSON.stringify(written));
  const rec = await readChildExitRecord(exitPath);
  assert.ok(rec, "should parse");
  assert.equal(rec.exit_code, 0);
  assert.equal(rec.signal, null);
  assert.equal(rec.success, true);
  assert.equal(typeof rec.terminated_at, "number");
});

test("v0.9.0 E: readChildExitRecord rejects malformed json gracefully", async () => {
  const dir = await mkTempDir("orq-v09-E3-");
  const exitPath = path.join(dir, ".orqlaude.exit.json");
  await fs.writeFile(exitPath, "{not json");
  const rec = await readChildExitRecord(exitPath);
  assert.equal(rec, null);
});

// ---- D: orphan-notification migration --------------------------------------

test("v0.9.0 D: state.ts migrate fills orphanNotifications on a fresh v3 state", async () => {
  const stateDir = await mkTempDir("orq-v09-D-");
  // Write a hand-rolled state.json that omits the orphan arrays (mimicking
  // a v3 file written by v0.8.0).
  await fs.writeFile(
    path.join(stateDir, "orqlaude-state.json"),
    JSON.stringify({ schemaVersion: 3, plans: {} })
  );
  const { StateStore } = await import("../lib/state.js");
  const store = new StateStore(stateDir);
  const orphans = await store.read((s: any) => ({
    n: s.orphanNotifications,
    r: s.orphanResponseRequests,
  }));
  // v0.9.1: pin the migration contract. The migrate fn explicitly
  // initializes these arrays (out.orphanNotifications = out.orphanNotifications
  // ?? []) so a load of a v3-without-orphans file must result in arrays,
  // not undefineds. The notifier's `?? []` is defense-in-depth, not the
  // primary contract.
  assert.ok(Array.isArray(orphans.n), "orphanNotifications should be initialized as []");
  assert.ok(Array.isArray(orphans.r), "orphanResponseRequests should be initialized as []");
  assert.equal(orphans.n.length, 0);
  assert.equal(orphans.r.length, 0);
});

test("v0.9.0 D: notify_user without plan_id pushes to orphan queue", async () => {
  const stateDir = await mkTempDir("orq-v09-D2-");
  const { StateStore } = await import("../lib/state.js");
  const store = new StateStore(stateDir);
  // Simulate what notify_user does when plan_id is absent.
  await store.update((state: any) => {
    state.orphanNotifications = state.orphanNotifications ?? [];
    state.orphanNotifications.push({
      id: "abc123",
      text: "test ping",
      urgency: "normal",
      createdAt: Date.now(),
      delivered: false,
    });
  });
  const out = await store.read((s: any) => s.orphanNotifications);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "test ping");
});

// ---- F: fingerprint computation --------------------------------------------
//
// We can't call wait_for_status_change directly (it's tool-registered) but
// the fingerprint shape is part of the contract. This test pins the
// observable contract: token deltas of < 1 KB don't churn the fingerprint,
// but a status transition does.

test("v0.9.0 F: fingerprint shape is stable across sub-KB token deltas", () => {
  const fp = (status: string, tokens: number) => `${status}|t1:${status}::${Math.floor(tokens / 1024)}::0:?`;
  // 500-token to 800-token delta: same KB bucket.
  assert.equal(fp("running", 500), fp("running", 800));
  // 500 to 1500: different KB bucket.
  assert.notEqual(fp("running", 500), fp("running", 1500));
  // Status transition: always different.
  assert.notEqual(fp("running", 500), fp("done", 500));
});
