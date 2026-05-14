import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { StateStore, newPlan, findPlan, findUserResponseRequest } from "../lib/state.js";

/**
 * Regression tests for the v0.4 user-IO state additions.
 */

async function tmpStore(): Promise<{ store: StateStore; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orqlaude-userio-"));
  return { store: new StateStore(dir), dir };
}

test("v2→v3 migration synthesizes empty userNotifications + userResponseRequests", async () => {
  const { dir } = await tmpStore();
  const v2: any = {
    schemaVersion: 2,
    plans: {
      "p1": {
        id: "p1",
        createdAt: 1,
        rootTask: "x",
        budgetCapTokens: 100_000,
        perAgentCapTokens: 50_000,
        status: "draft",
        tasks: [],
        notes: [],
        messages: [],
        claims: [],
        // Missing the v0.4 fields
      },
    },
  };
  await fs.writeFile(path.join(dir, "orqlaude-state.json"), JSON.stringify(v2));
  const fresh = new StateStore(dir);
  const out = await fresh.read((s) => s.plans["p1"]);
  assert.deepEqual(out.userNotifications, []);
  assert.deepEqual(out.userResponseRequests, []);
});

test("newPlan initializes user-IO arrays empty", async () => {
  const { store } = await tmpStore();
  const plan = await store.update((s) => {
    const p = newPlan("root", 100_000, [{ title: "T", prompt: "p", tldr: "tl" }]);
    s.plans[p.id] = p;
    return p;
  });
  assert.deepEqual(plan.userNotifications, []);
  assert.deepEqual(plan.userResponseRequests, []);
});

test("findUserResponseRequest finds by full id and short id", async () => {
  const { store } = await tmpStore();
  await store.update((s) => {
    const p = newPlan("root", 100_000, [{ title: "T", prompt: "p", tldr: "tl" }]);
    p.userResponseRequests.push({
      id: "abcdef12-3456-7890-abcd-ef1234567890",
      shortId: "abcdef12",
      prompt: "test",
      createdAt: Date.now(),
      timeoutAt: Date.now() + 60_000,
      delivered: false,
    });
    s.plans[p.id] = p;
  });
  const r1 = await store.read((s) => findUserResponseRequest(s, "abcdef12-3456-7890-abcd-ef1234567890"));
  assert.ok(r1, "full id lookup");
  const r2 = await store.read((s) => findUserResponseRequest(s, "abcdef12"));
  assert.ok(r2, "short id lookup");
  assert.equal(r1!.req.id, r2!.req.id);
});

test("response request lifecycle: pending → answered", async () => {
  const { store } = await tmpStore();
  let planId = "";
  let requestId = "";
  await store.update((s) => {
    const p = newPlan("root", 100_000, [{ title: "T", prompt: "p", tldr: "tl" }]);
    planId = p.id;
    requestId = "11111111-2222-3333-4444-555555555555";
    p.userResponseRequests.push({
      id: requestId,
      shortId: "11111111",
      prompt: "are we good?",
      options: ["yes", "no"],
      createdAt: Date.now(),
      timeoutAt: Date.now() + 60_000,
      delivered: false,
    });
    s.plans[p.id] = p;
  });
  // Pending
  let req = await store.read((s) => findUserResponseRequest(s, "11111111")!.req);
  assert.equal(req.response, undefined);
  // Simulate the bot writing the answer
  await store.update((s) => {
    const found = findUserResponseRequest(s, "11111111")!;
    found.req.response = "yes";
    found.req.respondedAt = Date.now();
  });
  req = await store.read((s) => findUserResponseRequest(s, "11111111")!.req);
  assert.equal(req.response, "yes");
});
