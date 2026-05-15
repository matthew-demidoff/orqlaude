import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { MemoryStore } from "../lib/memory.js";
import { BacklogStore } from "../lib/backlog.js";
import { GuardrailStore, DEFAULT_GUARDRAILS } from "../lib/guardrails.js";
import { FLEET_TEMPLATES, findTemplate, suggestTemplates } from "../lib/templates.js";
import { parseSlashCommand } from "../lib/tg_classifier.js";
import { applyRule, type PrInfo, type ReviewVerdict } from "../lib/auto_merge.js";

/**
 * v0.10.0 — autopilot daemon, memory, backlog, templates, guardrails.
 *
 * These tests cover the pure-logic surface: store IO, glob matching,
 * priority math, rule application. The daemon's tick loop and the
 * `claude -p` spawn paths are not unit-tested here because they require
 * a working claude binary in the environment.
 */

async function tempDir(label: string): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `orqlaude-v010-${label}-`));
  return base;
}

// ---- Memory --------------------------------------------------------------

test("v0.10.0: memory remember/recall round-trips", async () => {
  const dir = await tempDir("memory");
  const m = new MemoryStore(dir);
  await m.remember({ category: "lore", key: "language", value: "Russian comments in CRM templates" });
  const got = await m.recall({ category: "lore", key: "language" });
  assert.equal(got.length, 1);
  assert.equal(got[0].value, "Russian comments in CRM templates");
});

test("v0.10.0: memory supersedes older entries with same (category, key)", async () => {
  const dir = await tempDir("memory-supersede");
  const m = new MemoryStore(dir);
  await m.remember({ category: "playbook", key: "test_runner", value: "pytest" });
  await m.remember({ category: "playbook", key: "test_runner", value: "pytest -x --tb=short" });
  const got = await m.recall({ category: "playbook", key: "test_runner" });
  assert.equal(got.length, 1, "older entry should be superseded");
  assert.equal(got[0].value, "pytest -x --tb=short");
});

test("v0.10.0: memory recall by scope glob picks overlapping entries", async () => {
  const dir = await tempDir("memory-scope");
  const m = new MemoryStore(dir);
  await m.remember({
    category: "atlas",
    key: "kanban-dnd",
    value: "Kanban dnd handlers in frontend/src/components/Kanban/",
    scope: ["frontend/src/components/Kanban/**"],
  });
  await m.remember({
    category: "atlas",
    key: "deals-views",
    value: "Deal endpoints in backend/deals/views.py",
    scope: ["backend/deals/**"],
  });
  const got = await m.recall({ scope: ["frontend/src/components/Kanban/Board.tsx"] });
  // Both entries match because globMatch is permissive in either direction.
  // What we care about is that the kanban-specific one is in the results.
  assert.ok(got.some((e) => e.key === "kanban-dnd"));
});

test("v0.10.0: pinned memory entries always come first", async () => {
  const dir = await tempDir("memory-pinned");
  const m = new MemoryStore(dir);
  await m.remember({ category: "lore", key: "a", value: "older non-pinned" });
  await m.remember({ category: "lore", key: "b", value: "pinned", pinned: true });
  await m.remember({ category: "lore", key: "c", value: "newer non-pinned" });
  const got = await m.recall({});
  assert.equal(got[0].key, "b", "pinned must be first");
});

test("v0.10.0: composeContextBlock includes pinned + per-category entries", async () => {
  const dir = await tempDir("memory-compose");
  const m = new MemoryStore(dir);
  await m.remember({ category: "lore", key: "name", value: "Matthew", pinned: true });
  await m.remember({ category: "playbook", key: "i18n", value: "Russian comments" });
  const block = await m.composeContextBlock({ maxChars: 1000 });
  assert.ok(block.includes("Matthew"));
  assert.ok(block.includes("Russian"));
  assert.ok(block.toLowerCase().includes("pinned"));
});

test("v0.10.0: forget marks an entry as soft-deleted", async () => {
  const dir = await tempDir("memory-forget");
  const m = new MemoryStore(dir);
  const e = await m.remember({ category: "ledger", key: "k", value: "v" });
  const ok = await m.forget(e.id);
  assert.equal(ok, true);
  const after = await m.recall({});
  assert.equal(after.length, 0);
});

// ---- Backlog -------------------------------------------------------------

test("v0.10.0: backlog enqueue + pickNext picks highest priority", async () => {
  const dir = await tempDir("backlog");
  const b = new BacklogStore(dir);
  await b.enqueue({ title: "low", priority: 20, source: "user" });
  await b.enqueue({ title: "high", priority: 80, source: "user" });
  await b.enqueue({ title: "mid", priority: 50, source: "user" });
  const picked = await b.pickNext();
  assert.equal(picked?.title, "high");
});

test("v0.10.0: backlog respects dependency chain", async () => {
  const dir = await tempDir("backlog-deps");
  const b = new BacklogStore(dir);
  const a = await b.enqueue({ title: "A", priority: 50, source: "user" });
  await b.enqueue({ title: "B (depends on A)", priority: 90, source: "user", dependsOn: [a.id] });
  // B is higher priority but depends on A, so A goes first.
  let picked = await b.pickNext();
  assert.equal(picked?.title, "A");
  // Mark A done; now B is unblocked.
  await b.update(a.id, (g) => {
    g.status = "done";
  });
  picked = await b.pickNext();
  assert.equal(picked?.title, "B (depends on A)");
});

test("v0.10.0: backlog deadline boost raises effective priority", async () => {
  const dir = await tempDir("backlog-deadline");
  const b = new BacklogStore(dir);
  const tomorrow = Date.now() + 86_400_000; // 1 day out → ~+26 boost
  await b.enqueue({ title: "no-deadline-high", priority: 60, source: "user" });
  await b.enqueue({ title: "deadline-mid", priority: 50, deadlineAt: tomorrow, source: "user" });
  const picked = await b.pickNext();
  // deadline-mid effective priority should be 50 + ~26 = 76 > 60.
  assert.equal(picked?.title, "deadline-mid");
});

// ---- Templates -----------------------------------------------------------

test("v0.10.0: fleet templates have unique ids", () => {
  const ids = FLEET_TEMPLATES.map((t) => t.id);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length);
});

test("v0.10.0: every fleet template has at least one role", () => {
  for (const t of FLEET_TEMPLATES) {
    assert.ok(t.agentRoles.length >= 1, `template ${t.id} has no roles`);
  }
});

test("v0.10.0: suggestTemplates ranks by tag overlap", () => {
  const matches = suggestTemplates(["migration", "schema"]);
  assert.ok(matches.length >= 1);
  assert.equal(matches[0].id, "migration-only");
});

test("v0.10.0: findTemplate returns undefined for unknown id", () => {
  assert.equal(findTemplate("does-not-exist"), undefined);
});

// ---- Guardrails ----------------------------------------------------------

test("v0.10.0: guardrails snapshot computes window+day pcts", async () => {
  const dir = await tempDir("guardrails");
  const g = new GuardrailStore(dir);
  await g.record({ ts: Date.now(), billed: 500_000, cached: 1_000_000, source: "t" });
  const snap = await g.snapshot(DEFAULT_GUARDRAILS);
  assert.equal(snap.windowBilled, 500_000);
  assert.ok(snap.windowPct < 0.1);
  assert.equal(snap.level, "green");
});

test("v0.10.0: guardrails escalate to red at 95% window", async () => {
  const dir = await tempDir("guardrails-red");
  const g = new GuardrailStore(dir);
  // 95% of 8M = 7.6M.
  await g.record({ ts: Date.now(), billed: 7_600_000, cached: 0, source: "t" });
  const snap = await g.snapshot(DEFAULT_GUARDRAILS);
  assert.equal(snap.level, "red");
});

test("v0.10.0: guardrails trim events older than 48h", async () => {
  const dir = await tempDir("guardrails-trim");
  const g = new GuardrailStore(dir);
  const oldTs = Date.now() - 50 * 60 * 60 * 1000; // 50h ago
  await g.record({ ts: oldTs, billed: 999_999, cached: 0, source: "ancient" });
  await g.record({ ts: Date.now(), billed: 100_000, cached: 0, source: "now" });
  const win = await g.windowBilled(DEFAULT_GUARDRAILS.windowMs);
  assert.equal(win, 100_000, "old event should have been trimmed");
});

// ---- Telegram classifier (parser only) -----------------------------------

test("v0.10.0: parseSlashCommand recognizes /now /queue /pause /resume", () => {
  assert.deepEqual(parseSlashCommand("/now"), { cmd: "now" });
  assert.deepEqual(parseSlashCommand("/queue"), { cmd: "queue" });
  assert.deepEqual(parseSlashCommand("/pause"), { cmd: "pause" });
  assert.deepEqual(parseSlashCommand("/resume"), { cmd: "resume" });
  assert.deepEqual(parseSlashCommand("/morning"), { cmd: "morning" });
  assert.deepEqual(parseSlashCommand("/pulse"), { cmd: "pulse" });
  assert.deepEqual(parseSlashCommand("/budget"), { cmd: "budget" });
});

test("v0.10.0: parseSlashCommand /respond preserves shortId + text", () => {
  const got = parseSlashCommand("/respond ab12cd34 yes, do it");
  assert.deepEqual(got, { cmd: "respond", shortId: "ab12cd34", text: "yes, do it" });
});

test("v0.10.0: parseSlashCommand handles bot-mention suffix", () => {
  // Telegram appends @botname in group chats.
  assert.deepEqual(parseSlashCommand("/now@orqlaudebot"), { cmd: "now" });
});

test("v0.10.0: parseSlashCommand returns null for non-slash", () => {
  assert.equal(parseSlashCommand("hello"), null);
  assert.equal(parseSlashCommand(""), null);
});

// ---- Auto-merge rule engine ----------------------------------------------

function makePr(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 1,
    url: "https://github.com/x/y/pull/1",
    state: "OPEN",
    title: "t",
    author: "a",
    headBranch: "h",
    baseBranch: "b",
    additions: 100,
    deletions: 50,
    changedFiles: 5,
    files: [{ path: "src/foo.ts", additions: 100, deletions: 50 }],
    checksStatus: "success",
    mergeable: true,
    ...overrides,
  };
}

function makeReview(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    verdict: "APPROVE",
    blockers: [],
    suggestions: [],
    summary: "ok",
    ...overrides,
  };
}

test("v0.10.0: applyRule accepts a green PR with APPROVE", () => {
  const pr = makePr();
  const review = makeReview();
  const d = applyRule(pr, review, { method: "squash", requireCi: true, requireReviewerApprove: true, maxLoc: 1500 });
  assert.equal(d.ok, true);
  assert.equal(d.violations.length, 0);
});

test("v0.10.0: applyRule rejects on BLOCKER verdict", () => {
  const pr = makePr();
  const review = makeReview({ verdict: "BLOCKER", blockers: ["data loss risk"] });
  const d = applyRule(pr, review, { requireReviewerApprove: true });
  assert.equal(d.ok, false);
  assert.ok(d.violations.some((v) => v.toLowerCase().includes("blocker")));
});

test("v0.10.0: applyRule rejects on failing CI", () => {
  const pr = makePr({ checksStatus: "failure" });
  const d = applyRule(pr, makeReview(), { requireCi: true });
  assert.equal(d.ok, false);
});

test("v0.10.0: applyRule rejects when maxLoc exceeded", () => {
  const pr = makePr({ additions: 2000, deletions: 100 });
  const d = applyRule(pr, makeReview(), { maxLoc: 1500 });
  assert.equal(d.ok, false);
});

test("v0.10.0: applyRule blockOnMigrations stops migration-touching PRs", () => {
  const pr = makePr({
    files: [
      { path: "backend/deals/migrations/0042_foo.py", additions: 50, deletions: 0 },
      { path: "backend/deals/views.py", additions: 10, deletions: 0 },
    ],
  });
  const d = applyRule(pr, makeReview(), { blockOnMigrations: true });
  assert.equal(d.ok, false);
  assert.ok(d.violations.some((v) => v.includes("migration")));
});

test("v0.10.0: applyRule blockOnPaths rejects matching files", () => {
  const pr = makePr({
    files: [{ path: "backend/settings.py", additions: 10, deletions: 0 }],
  });
  const d = applyRule(pr, makeReview(), { blockOnPaths: ["**/settings.py"] });
  assert.equal(d.ok, false);
  assert.ok(d.violations.some((v) => v.includes("settings.py")));
});

test("v0.10.0: applyRule rejects conflicting (mergeable=false) PRs", () => {
  const pr = makePr({ mergeable: false });
  const d = applyRule(pr, makeReview(), {});
  assert.equal(d.ok, false);
  assert.ok(d.violations.some((v) => v.toLowerCase().includes("conflict")));
});
