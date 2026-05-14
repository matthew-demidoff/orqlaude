import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { StateStore, newPlan, findPlan, planForSession, unclaimedTaskById } from "../lib/state.js";

/**
 * v0.5.3: regression tests for checkin conflict detection. We test the
 * underlying state lookup primitives rather than the MCP tool itself —
 * the conflict-detection branches in broker.ts use exactly these helpers.
 */

async function tmpStore(): Promise<StateStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orqlaude-v053-"));
  return new StateStore(dir);
}

test("v0.5.3: session bound to task A cannot be retargeted by passing task B's id", async () => {
  const store = await tmpStore();
  let planId = "";
  let taskAId = "";
  let taskBId = "";
  await store.update((s) => {
    const p = newPlan("root", 100_000, [
      { title: "A", prompt: "a", tldr: "a" },
      { title: "B", prompt: "b", tldr: "b" },
    ]);
    p.tasks[0].status = "dispatched";
    p.tasks[0].spawnedSessionId = "session-X";
    p.tasks[1].status = "dispatched";
    planId = p.id;
    taskAId = p.tasks[0].id;
    taskBId = p.tasks[1].id;
    s.plans[p.id] = p;
  });
  // Caller session X is already bound to task A. If they pass task_id=B,
  // planForSession should return A — not silently switch them to B.
  const result = await store.read((state) => {
    const found = planForSession(state, "session-X");
    return found ? { taskId: found.task.id, title: found.task.title } : null;
  });
  assert.ok(result, "session should be found");
  assert.equal(result!.taskId, taskAId);
  assert.notEqual(result!.taskId, taskBId);
});

test("v0.5.3: task already claimed by another session cannot be re-claimed via task_id", async () => {
  const store = await tmpStore();
  let taskId = "";
  await store.update((s) => {
    const p = newPlan("root", 100_000, [{ title: "T", prompt: "p", tldr: "tl" }]);
    p.tasks[0].status = "running";
    p.tasks[0].spawnedSessionId = "first-session";
    taskId = p.tasks[0].id;
    s.plans[p.id] = p;
  });
  // A different session calls checkin with that task_id.
  // unclaimedTaskById should return undefined because the task IS claimed.
  const target = await store.read((state) => unclaimedTaskById(state, taskId));
  assert.equal(target, undefined);
});

test("v0.5.3: spawn_cli util discovers git root via .git directory", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orqlaude-git-root-"));
  await fs.mkdir(path.join(dir, ".git"));
  await fs.mkdir(path.join(dir, "nested", "deeper"), { recursive: true });
  const { findGitRoot } = await import("../lib/spawn_cli.js");
  const real = await fs.realpath(dir);
  assert.equal(findGitRoot(path.join(real, "nested", "deeper")), real);
});

test("v0.5.3: telegram_status returns 'unconfigured' when no config file exists", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "orqlaude-tg-status-"));
  const { probeTelegramStatus } = await import("../lib/telegram_status.js");
  // Override HOME so it can't find a real config.
  const realHome = process.env.HOME;
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "orqlaude-fakehome-"));
  process.env.HOME = fakeHome;
  try {
    const status = await probeTelegramStatus(stateDir);
    // We can't be certain the user has no real config — but the path under
    // a freshly-minted fake HOME doesn't exist, so status should be
    // unconfigured.
    assert.equal(status.status, "unconfigured");
    assert.equal(status.hasToken, false);
  } finally {
    if (realHome) process.env.HOME = realHome;
    else delete process.env.HOME;
  }
});
