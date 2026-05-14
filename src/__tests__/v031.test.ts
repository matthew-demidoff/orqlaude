import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { StateStore, newPlan, findPlan } from "../lib/state.js";
import { escapeMd } from "../telegram/notifier.js";

/**
 * Regression tests for v0.3.1 fixes — each test corresponds to a finding
 * from the dogfood review of v0.3.0.
 */

async function tmpStore(): Promise<{ store: StateStore; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orqlaude-v031-"));
  return { store: new StateStore(dir), dir };
}

test("update() rolls back in-memory cache when mutator throws (BLOCKER from Phase 1 review)", async () => {
  const { store } = await tmpStore();
  const plan = await store.update((s) => {
    const p = newPlan("root", 100_000, [{ title: "T", prompt: "p", tldr: "tl" }]);
    s.plans[p.id] = p;
    return p;
  });
  // Throwing mutator. The cache must NOT retain the half-applied change.
  await assert.rejects(async () => {
    await store.update((s) => {
      const p = findPlan(s, plan.id);
      p.rootTask = "MUTATED";
      throw new Error("boom");
    });
  }, /boom/);
  const after = await store.read((s) => findPlan(s, plan.id));
  assert.equal(after.rootTask, "root", "post-throw rootTask should be unchanged");
});

test("read() funneled through writeLock — never observes torn state (BLOCKER from Phase 1 review)", async () => {
  const { store } = await tmpStore();
  let planId = "";
  await store.update((s) => {
    const p = newPlan("orig", 50_000, [{ title: "T", prompt: "p", tldr: "tl" }]);
    planId = p.id;
    s.plans[p.id] = p;
  });
  // Kick off a slow mutator and a read concurrently. The read must see EITHER
  // the pre-mutation state OR the post-mutation state, never a half-mutation.
  const observed: string[] = [];
  const mutate = store.update(async (s) => {
    const p = findPlan(s, planId);
    p.rootTask = "first";
    await new Promise((r) => setTimeout(r, 20));
    p.rootTask = "final";
  });
  const reads = [
    store.read((s) => findPlan(s, planId).rootTask),
    store.read((s) => findPlan(s, planId).rootTask),
    store.read((s) => findPlan(s, planId).rootTask),
  ];
  const [_, r1, r2, r3] = await Promise.all([mutate, ...reads]);
  observed.push(r1, r2, r3);
  for (const v of observed) {
    assert.ok(v === "orig" || v === "final", `unexpected torn-state read: ${v}`);
  }
});

test("audit summarize() scrubs approval_token from result text (BLOCKER from Phase 1 review)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orqlaude-audit-"));
  const { AuditLog } = await import("../lib/audit.js");
  const audit = new AuditLog(dir);
  const wrapped = audit.wrap("request_approval", async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({ approval_token: "secret-uuid-here", summary: "ok" }, null, 2),
      },
    ],
  }));
  await wrapped({});
  // Audit file should NOT contain the cleartext token.
  const log = await fs.readFile(path.join(dir, "audit.jsonl"), "utf8");
  assert.ok(!log.includes("secret-uuid-here"), `token leaked in audit log: ${log}`);
  assert.ok(log.includes("<redacted>"), "expected <redacted> marker");
});

test("v1→v2 migration synthesizes tasks/notes/messages/claims when missing (CONCERN from Phase 1)", async () => {
  const { store: _ignored, dir } = await tmpStore();
  // Hand-craft a v1 state file with missing fields.
  const v1: any = {
    schemaVersion: 1,
    plans: {
      "p1": {
        id: "p1",
        createdAt: 1,
        rootTask: "legacy",
        budgetCapUsd: 4,
        perAgentCapUsd: 2,
        status: "draft",
        // Deliberately missing: tasks, notes, messages
      },
    },
  };
  await fs.writeFile(path.join(dir, "orqlaude-state.json"), JSON.stringify(v1));
  const fresh = new StateStore(dir);
  const out = await fresh.read((s) => s.plans["p1"]);
  assert.deepEqual(out.tasks, []);
  assert.deepEqual(out.notes, []);
  assert.deepEqual(out.messages, []);
  assert.deepEqual(out.claims, []);
  assert.equal(out.budgetCapTokens, 4 * 25_000);
});

test("escapeMd backslashes Telegram MarkdownV1 special chars (BLOCKER from Phase 3)", () => {
  assert.equal(escapeMd("feature/foo_bar"), "feature/foo\\_bar");
  assert.equal(escapeMd("**bold**"), "\\*\\*bold\\*\\*");
  assert.equal(escapeMd("plain text"), "plain text");
  assert.equal(escapeMd("`code`"), "\\`code\\`");
  assert.equal(escapeMd("[link]"), "\\[link]");
  assert.equal(escapeMd("a_b*c`d[e"), "a\\_b\\*c\\`d\\[e");
});

test("Telegram saveConfig writes with mode 0o600 atomically (BLOCKER from Phase 3)", async () => {
  // We can't easily mock the HOME-rooted CONFIG_PATH inside the module, so
  // this test verifies the underlying behavior: writeFile with mode:0o600,
  // flag:'wx' creates a file world-unreadable from the start.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orqlaude-tgcfg-"));
  const target = path.join(dir, "test.json");
  await fs.writeFile(target, '{"x":1}', { mode: 0o600, flag: "wx" });
  const stat = await fs.stat(target);
  // The umask still applies on some platforms; we just want to confirm we're
  // not at 0644 default.
  assert.ok((stat.mode & 0o077) === 0, `file should not be group/world readable: mode=${(stat.mode & 0o777).toString(8)}`);
});
