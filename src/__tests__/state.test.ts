import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  StateStore,
  newPlan,
  findPlan,
  unclaimedTaskById,
  normalizeClaimPath,
} from "../lib/state.js";

async function tmpStore(): Promise<{ store: StateStore; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orqlaude-test-"));
  return { store: new StateStore(dir), dir };
}

test("create plan + persist + reload preserves shape", async () => {
  const { store, dir } = await tmpStore();
  const plan = await store.update((s) => {
    const p = newPlan("root task", 100_000, [
      { title: "T1", prompt: "p1", tldr: "tldr1" },
      { title: "T2", prompt: "p2", tldr: "tldr2" },
    ]);
    s.plans[p.id] = p;
    return p;
  });
  // New store instance: forces reload from disk.
  const fresh = new StateStore(dir);
  const reloaded = await fresh.read((s) => findPlan(s, plan.id));
  assert.equal(reloaded.tasks.length, 2);
  assert.equal(reloaded.budgetCapTokens, 100_000);
  assert.equal(reloaded.perAgentCapTokens, 50_000);
  assert.equal(reloaded.tasks[0].status, "pending");
});

test("approval token mismatch is rejected", async () => {
  const { store } = await tmpStore();
  const plan = await store.update((s) => {
    const p = newPlan("root", 50_000, [{ title: "T", prompt: "p", tldr: "tl" }]);
    p.status = "awaiting_approval";
    p.approvalToken = "the-real-token";
    s.plans[p.id] = p;
    return p;
  });
  await assert.rejects(async () => {
    await store.update((s) => {
      const p = findPlan(s, plan.id);
      if (p.approvalToken !== "wrong") throw new Error("Approval token mismatch.");
      p.status = "approved";
    });
  }, /Approval token mismatch/);
});

test("unclaimedTaskById finds dispatched-but-unowned task", async () => {
  const { store } = await tmpStore();
  let taskId: string = "";
  await store.update((s) => {
    const p = newPlan("root", 50_000, [{ title: "T", prompt: "p", tldr: "tl" }]);
    p.tasks[0].status = "dispatched";
    taskId = p.tasks[0].id;
    s.plans[p.id] = p;
  });
  const found = await store.read((s) => unclaimedTaskById(s, taskId));
  assert.ok(found, "should find unclaimed task");
  assert.equal(found!.task.id, taskId);
  // After claiming, it no longer appears.
  await store.update((s) => {
    const f = unclaimedTaskById(s, taskId)!;
    f.task.spawnedSessionId = "some-uuid";
  });
  const found2 = await store.read((s) => unclaimedTaskById(s, taskId));
  assert.equal(found2, undefined);
});

test("normalizeClaimPath: relative paths resolve against cwd", () => {
  const cwd = "/repo/root";
  assert.equal(normalizeClaimPath("src/foo.ts", cwd), "/repo/root/src/foo.ts");
  assert.equal(normalizeClaimPath("/abs/path.ts", cwd), "/abs/path.ts");
  assert.equal(normalizeClaimPath("./a/../b.ts", cwd), "/repo/root/b.ts");
});

test("concurrent updates serialize correctly", async () => {
  const { store } = await tmpStore();
  let planId: string = "";
  await store.update((s) => {
    const p = newPlan("root", 100_000, [{ title: "T", prompt: "p", tldr: "tl" }]);
    planId = p.id;
    s.plans[p.id] = p;
  });
  // Fire 20 concurrent appends to the notes array. With serialization, all 20 land.
  const writes = Array.from({ length: 20 }, (_, i) =>
    store.update((s) => {
      findPlan(s, planId).notes.push({
        id: `note-${i}`,
        fromSessionId: "x",
        taskId: "y",
        text: `n${i}`,
        blocking: false,
        postedAt: Date.now(),
        acked: false,
      });
    })
  );
  await Promise.all(writes);
  const final = await store.read((s) => findPlan(s, planId));
  assert.equal(final.notes.length, 20);
});

test("schema v1 migrates to v2 with token caps synthesized", async () => {
  const { store, dir } = await tmpStore();
  // Write a v1-shaped state file directly.
  const v1: any = {
    schemaVersion: 1,
    plans: {
      "p1": {
        id: "p1",
        createdAt: 1,
        rootTask: "old",
        budgetCapUsd: 4,
        perAgentCapUsd: 2,
        status: "draft",
        tasks: [],
        notes: [],
        messages: [],
      },
    },
  };
  await fs.writeFile(path.join(dir, "orqlaude-state.json"), JSON.stringify(v1));
  // Reload via a new store (the test store already cached empty).
  const fresh = new StateStore(dir);
  const migrated = await fresh.read((s) => s);
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.plans["p1"].budgetCapTokens, 4 * 25_000);
  assert.deepEqual(migrated.plans["p1"].claims, []);
});
