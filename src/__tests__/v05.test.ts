import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pickAgnetName, agnetLabel, agnetMonogram } from "../lib/agnet.js";
import { StateStore, newPlan, findUserStream } from "../lib/state.js";

/**
 * Regression tests for v0.5 (Agnet naming + streaming state).
 */

async function tmpStore(): Promise<{ store: StateStore; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orqlaude-v05-"));
  return { store: new StateStore(dir), dir };
}

test("pickAgnetName is deterministic for the same task_id", () => {
  const taken = new Set<string>();
  const n1 = pickAgnetName("abc-123", taken);
  const n2 = pickAgnetName("abc-123", new Set());
  assert.equal(n1, n2);
});

test("pickAgnetName returns distinct names within a plan", () => {
  const taken = new Set<string>();
  for (let i = 0; i < 10; i++) {
    const id = `task-${i}-${Math.random()}`;
    const name = pickAgnetName(id, taken);
    assert.ok(!taken.has(name), `should not return already-taken name; got ${name}`);
    taken.add(name);
  }
});

test("agnetLabel formats with prefix; agnetMonogram returns 2-char", () => {
  assert.equal(agnetLabel("Zenith"), "Agnet Zenith");
  assert.equal(agnetLabel(undefined), "Agnet");
  assert.equal(agnetMonogram("Zenith"), "Ze");
  assert.equal(agnetMonogram(undefined), "??");
});

test("style helpers are passthrough when colors disabled", async () => {
  // We can't easily toggle ENABLED inside style.ts post-import, but we can
  // assert the public contract: every helper returns a string that includes
  // the original text. (Color codes wrap; raw text is preserved.)
  const { style } = await import("../lib/style.js");
  assert.ok(style.coral("hello").includes("hello"));
  assert.ok(style.cream("hi").includes("hi"));
  assert.ok(style.crimson("err").includes("err"));
  assert.ok(style.dim("aside").includes("aside"));
});

test("findUserStream finds by full id and short id", async () => {
  const { store } = await tmpStore();
  await store.update((s) => {
    const p = newPlan("root", 100_000, [{ title: "T", prompt: "p", tldr: "tl" }]);
    p.userStreams.push({
      id: "aaaabbbb-cccc-dddd-eeee-ffffffffffff",
      shortId: "aaaabbbb",
      title: "Test stream",
      content: "hello",
      status: "active",
      createdAt: Date.now(),
    });
    s.plans[p.id] = p;
  });
  const r1 = await store.read((s) => findUserStream(s, "aaaabbbb-cccc-dddd-eeee-ffffffffffff"));
  assert.ok(r1);
  const r2 = await store.read((s) => findUserStream(s, "aaaabbbb"));
  assert.ok(r2);
  assert.equal(r1!.stream.id, r2!.stream.id);
});

test("v0.5 schema: newPlan initializes userStreams empty", async () => {
  const { store } = await tmpStore();
  const plan = await store.update((s) => {
    const p = newPlan("root", 100_000, [{ title: "T", prompt: "p", tldr: "tl" }]);
    s.plans[p.id] = p;
    return p;
  });
  assert.deepEqual(plan.userStreams, []);
});

test("TelegramApi has the expected post-v0.5.4 surface", async () => {
  // v0.5.4 removed sendMessageDraft after sendMessage proved unreliable in
  // the standard Bot API. Confirm it's no longer exported.
  const { TelegramApi } = await import("../telegram/api.js");
  const api = new TelegramApi("test:token");
  assert.equal(typeof (api as unknown as { sendMessage: unknown }).sendMessage, "function");
  assert.equal(typeof (api as unknown as { editMessageText: unknown }).editMessageText, "function");
  assert.equal((api as unknown as { sendMessageDraft?: unknown }).sendMessageDraft, undefined);
});
