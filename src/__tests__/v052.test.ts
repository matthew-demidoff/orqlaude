import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { StateStore, newPlan, findPlan } from "../lib/state.js";

/** v0.5.2: orphan detection on dispatched-but-unregistered Agnets. */

async function tmpStore(): Promise<{ store: StateStore; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orqlaude-v052-"));
  return { store: new StateStore(dir), dir };
}

test("orphan: task dispatched > 60s ago with no spawnedSessionId is detectable", async () => {
  const { store } = await tmpStore();
  let planId = "";
  await store.update((s) => {
    const p = newPlan("root", 100_000, [
      { title: "T1", prompt: "p", tldr: "tl" },
      { title: "T2", prompt: "p", tldr: "tl" },
    ]);
    p.tasks[0].status = "dispatched";
    p.tasks[0].startedAt = Date.now() - 120_000; // 2 min ago
    // Task 1 has no spawnedSessionId — orphan.
    p.tasks[1].status = "dispatched";
    p.tasks[1].startedAt = Date.now() - 30_000; // 30s ago, NOT orphan yet
    p.tasks[1].spawnedSessionId = "registered";
    planId = p.id;
    s.plans[p.id] = p;
  });
  const plan = await store.read((s) => findPlan(s, planId));
  const ORPHAN_MS = 60_000;
  const orphans = plan.tasks.filter(
    (t) =>
      t.status === "dispatched" &&
      !t.spawnedSessionId &&
      t.startedAt &&
      Date.now() - t.startedAt > ORPHAN_MS
  );
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].title, "T1");
});

test("orphan: dispatched < 60s ago is NOT yet an orphan", async () => {
  const { store } = await tmpStore();
  await store.update((s) => {
    const p = newPlan("root", 100_000, [{ title: "T", prompt: "p", tldr: "tl" }]);
    p.tasks[0].status = "dispatched";
    p.tasks[0].startedAt = Date.now() - 10_000; // 10s ago
    s.plans[p.id] = p;
  });
  const plan = await store.read((s) => Object.values(s.plans)[0]);
  const orphans = plan.tasks.filter(
    (t) =>
      t.status === "dispatched" &&
      !t.spawnedSessionId &&
      t.startedAt &&
      Date.now() - t.startedAt > 60_000
  );
  assert.equal(orphans.length, 0);
});
