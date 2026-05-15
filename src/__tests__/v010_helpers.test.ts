import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { tryParseJson, extractAssistantText } from "../lib/orch_turn.js";
import { classifyFailure, countRetries, readTail, DEFAULT_RETRY, type RetryConfig } from "../lib/retry.js";
import { applyRule, type PrInfo, type ReviewVerdict } from "../lib/auto_merge.js";
import { parseSlashCommand } from "../lib/tg_classifier.js";
import type { Task, TaskStatus } from "../lib/state.js";

/**
 * v0.10.x helper coverage - JSON extraction, retry classifier fast paths,
 * auto-merge edge cases, slash-command parser corners. Sibling to v010.test.ts;
 * these focus on internal helpers and edge cases the higher-level tests skip.
 */

async function tempDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `orqlaude-v010h-${label}-`));
}

// ---- orch_turn.tryParseJson ---------------------------------------------

test("v0.10.x: tryParseJson parses plain JSON object", () => {
  const r = tryParseJson('{"a":1,"b":"two"}');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { a: 1, b: "two" });
});

test("v0.10.x: tryParseJson strips ```json ... ``` fences", () => {
  const r = tryParseJson('```json\n{"action":"retry"}\n```');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { action: "retry" });
});

test("v0.10.x: tryParseJson strips bare ``` ... ``` fences", () => {
  const r = tryParseJson('```\n{"x":42}\n```');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { x: 42 });
});

test("v0.10.x: tryParseJson lifts the first {...} out of surrounding prose", () => {
  const text = 'Sure, here is the JSON you asked for:\n{"verdict":"APPROVE","blockers":[]}\nLet me know if you need more.';
  const r = tryParseJson(text);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { verdict: "APPROVE", blockers: [] });
});

test("v0.10.x: tryParseJson handles nested objects (depth tracking)", () => {
  const text = 'reasoning... {"outer":{"inner":{"k":1}},"arr":[1,2,3]} trailing prose';
  const r = tryParseJson(text);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { outer: { inner: { k: 1 } }, arr: [1, 2, 3] });
});

test("v0.10.x: tryParseJson returns ok:false with error for empty input", () => {
  const r = tryParseJson("");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /empty/i);
});

test("v0.10.x: tryParseJson returns ok:false when no '{' present", () => {
  const r = tryParseJson("just some prose, no JSON to be found here");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /no JSON object/i);
});

test("v0.10.x: tryParseJson reports parse failure with offset for malformed object", () => {
  const r = tryParseJson('{"a": 1, "b": ,}');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /JSON parse failed|offset/i);
});

test("v0.10.x: tryParseJson reports unbalanced braces", () => {
  const r = tryParseJson('{"a": 1');
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.error.length > 0);
});

// ---- orch_turn.extractAssistantText -------------------------------------

test("v0.10.x: extractAssistantText concatenates assistant.message.content text blocks", () => {
  const env = { type: "assistant", message: { content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] } };
  const out = extractAssistantText(JSON.stringify(env));
  assert.equal(out, "hello world");
});

test("v0.10.x: extractAssistantText handles {type:'text', text:'...'} envelope", () => {
  const out = extractAssistantText(JSON.stringify({ type: "text", text: "plain text envelope" }));
  assert.equal(out, "plain text envelope");
});

test("v0.10.x: extractAssistantText handles {type:'message_delta', delta:{text:'...'}} envelope", () => {
  const lines = [
    JSON.stringify({ type: "message_delta", delta: { text: "part one " } }),
    JSON.stringify({ type: "message_delta", delta: { text: "part two" } }),
  ].join("\n");
  assert.equal(extractAssistantText(lines), "part one part two");
});

test("v0.10.x: extractAssistantText handles {type:'result', result:'...'} envelope", () => {
  const out = extractAssistantText(JSON.stringify({ type: "result", result: "final answer" }));
  assert.equal(out, "final answer");
});

test("v0.10.x: extractAssistantText skips lines that aren't valid JSON", () => {
  const stdout = [
    "not json at all",
    JSON.stringify({ type: "text", text: "ok" }),
    "{not valid json either",
  ].join("\n");
  assert.equal(extractAssistantText(stdout), "ok");
});

test("v0.10.x: extractAssistantText returns empty string for blank stdout", () => {
  assert.equal(extractAssistantText(""), "");
  assert.equal(extractAssistantText("   \n\n  "), "");
});

test("v0.10.x: extractAssistantText ignores envelope shapes it doesn't recognize", () => {
  const stdout = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "tool_use", name: "x" }),
    JSON.stringify({ type: "text", text: "kept" }),
  ].join("\n");
  assert.equal(extractAssistantText(stdout), "kept");
});

test("v0.10.x: extractAssistantText concatenates a mixed stream", () => {
  const stdout = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "A" }] } }),
    JSON.stringify({ type: "text", text: "B" }),
    JSON.stringify({ type: "message_delta", delta: { text: "C" } }),
    JSON.stringify({ type: "result", result: "D" }),
  ].join("\n");
  assert.equal(extractAssistantText(stdout), "ABCD");
});

// ---- retry.classifyFailure (fast path) ----------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  const base: Task = {
    id: "task-id",
    title: "T",
    prompt: "p",
    tldr: "t",
    status: "died_at_launch" as TaskStatus,
  };
  return { ...base, ...overrides };
}

test("v0.10.x: classifyFailure fast-path retries when died_at_launch + retries < cap", async () => {
  const task = makeTask({ status: "died_at_launch", summary: "[retry 0/2]" });
  const decision = await classifyFailure(task, "", "", DEFAULT_RETRY);
  assert.equal(decision.action, "retry");
  assert.equal(decision.retryAfterMs, DEFAULT_RETRY.retryBackoffMs);
  assert.match(decision.reason, /1\/2/);
});

test("v0.10.x: classifyFailure fast-path retries on first failure (no [retry] marker)", async () => {
  const task = makeTask({ status: "died_at_launch" });
  const decision = await classifyFailure(task, "", "", DEFAULT_RETRY);
  assert.equal(decision.action, "retry");
});

test("v0.10.x: classifyFailure escalates when died_at_launch + retries >= cap", async () => {
  const task = makeTask({ status: "died_at_launch", summary: "[retry 2/2]" });
  const decision = await classifyFailure(task, "", "", DEFAULT_RETRY);
  assert.equal(decision.action, "escalate");
  assert.match(decision.reason, /Exhausted/i);
});

test("v0.10.x: classifyFailure treats failed-without-startedAt as launch death", async () => {
  const task = makeTask({ status: "failed", startedAt: undefined });
  const decision = await classifyFailure(task, "", "", DEFAULT_RETRY);
  assert.equal(decision.action, "retry");
});

test("v0.10.x: classifyFailure respects custom maxDiedAtLaunchRetries cap", async () => {
  const cfg: RetryConfig = { ...DEFAULT_RETRY, maxDiedAtLaunchRetries: 1 };
  const taskUnder = makeTask({ status: "died_at_launch", summary: "[retry 0/1]" });
  const taskOver = makeTask({ status: "died_at_launch", summary: "[retry 1/1]" });
  assert.equal((await classifyFailure(taskUnder, "", "", cfg)).action, "retry");
  assert.equal((await classifyFailure(taskOver, "", "", cfg)).action, "escalate");
});

// ---- retry.countRetries -------------------------------------------------

test("v0.10.x: countRetries reads N from '[retry N/M]' summary marker", () => {
  assert.equal(countRetries(makeTask({ summary: "[retry 0/2]" })), 0);
  assert.equal(countRetries(makeTask({ summary: "did things [retry 3/5] more text" })), 3);
});

test("v0.10.x: countRetries returns 0 when no marker present", () => {
  assert.equal(countRetries(makeTask({ summary: undefined })), 0);
  assert.equal(countRetries(makeTask({ summary: "no marker here" })), 0);
});

// ---- retry.readTail -----------------------------------------------------

test("v0.10.x: readTail returns empty string for undefined path", async () => {
  assert.equal(await readTail(undefined, 1024), "");
});

test("v0.10.x: readTail returns empty string for missing file", async () => {
  const dir = await tempDir("readtail-missing");
  const out = await readTail(path.join(dir, "does-not-exist.log"), 1024);
  assert.equal(out, "");
});

test("v0.10.x: readTail returns last N bytes of an existing file", async () => {
  const dir = await tempDir("readtail-ok");
  const file = path.join(dir, "log.txt");
  await fs.writeFile(file, "0123456789ABCDEF"); // 16 bytes
  assert.equal(await readTail(file, 4), "CDEF");
  assert.equal(await readTail(file, 100), "0123456789ABCDEF"); // larger than file
});

// ---- auto_merge.applyRule edge cases ------------------------------------

function makePr(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 1,
    url: "https://github.com/x/y/pull/1",
    state: "OPEN",
    title: "t",
    author: "a",
    headBranch: "h",
    baseBranch: "b",
    additions: 10,
    deletions: 5,
    changedFiles: 1,
    files: [{ path: "src/foo.ts", additions: 10, deletions: 5 }],
    checksStatus: "success",
    mergeable: true,
    ...overrides,
  };
}

function makeReview(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return { verdict: "APPROVE", blockers: [], suggestions: [], summary: "ok", ...overrides };
}

test("v0.10.x: applyRule with all-undefined rule still enforces defaults (CI + reviewer)", () => {
  // Defaults: requireReviewerApprove !== false → enforced. requireCi !== false → enforced.
  // A green PR with APPROVE should still pass.
  const d = applyRule(makePr(), makeReview(), {});
  assert.equal(d.ok, true);
  assert.equal(d.violations.length, 0);
});

test("v0.10.x: applyRule requireCi:false ignores CI status failure", () => {
  const d = applyRule(makePr({ checksStatus: "failure" }), makeReview(), { requireCi: false });
  assert.equal(d.ok, true, "no CI requirement -> CI failure must not block");
});

test("v0.10.x: applyRule requireReviewerApprove:false ignores BLOCKER verdict", () => {
  const d = applyRule(
    makePr(),
    makeReview({ verdict: "BLOCKER", blockers: ["x"] }),
    { requireReviewerApprove: false }
  );
  assert.equal(d.ok, true);
});

test("v0.10.x: applyRule treats maxLoc=0 as 'no cap' (does not block)", () => {
  const d = applyRule(makePr({ additions: 9999, deletions: 9999 }), makeReview(), { maxLoc: 0 });
  assert.equal(d.ok, true, "maxLoc=0 should mean no LoC cap");
  assert.ok(!d.violations.some((v) => v.includes("exceeds cap")));
});

test("v0.10.x: applyRule maxLoc undefined also means no cap", () => {
  const d = applyRule(makePr({ additions: 9999, deletions: 9999 }), makeReview(), {});
  assert.ok(!d.violations.some((v) => v.includes("exceeds cap")));
});

test("v0.10.x: applyRule blockOnPaths stops at the first matching glob (no accumulation)", () => {
  const pr = makePr({
    files: [
      { path: "backend/settings.py", additions: 1, deletions: 0 },
      { path: ".github/workflows/ci.yml", additions: 1, deletions: 0 },
      { path: "infra/terraform/main.tf", additions: 1, deletions: 0 },
    ],
  });
  const d = applyRule(pr, makeReview(), {
    blockOnPaths: ["**/settings.py", "**/ci.yml", "infra/**"],
  });
  assert.equal(d.ok, false);
  // Only the first matching glob's violation should be recorded; the loop
  // breaks after the first hit.
  const blockHits = d.violations.filter((v) => v.startsWith("block_on_paths:"));
  assert.equal(blockHits.length, 1, "blockOnPaths must short-circuit on first hit");
  assert.match(blockHits[0], /settings\.py/);
});

test("v0.10.x: applyRule blockOnMigrations only counts migrations with additions > 0", () => {
  // Removing a migration file (additions:0) is allowed; only newly-added
  // migrations trip the rule.
  const pr = makePr({
    files: [{ path: "backend/deals/migrations/0042_old.py", additions: 0, deletions: 30 }],
  });
  const d = applyRule(pr, makeReview(), { blockOnMigrations: true });
  assert.ok(!d.violations.some((v) => v.includes("migration")), "deletion-only migration shouldn't block");
});

test("v0.10.x: applyRule reports REQUEST_CHANGES verdict separately from BLOCKER", () => {
  const d = applyRule(
    makePr(),
    makeReview({ verdict: "REQUEST_CHANGES", suggestions: ["rename foo"] }),
    { requireReviewerApprove: true }
  );
  assert.equal(d.ok, false);
  assert.ok(d.violations.some((v) => v.includes("REQUEST_CHANGES")));
});

// ---- tg_classifier.parseSlashCommand corners ----------------------------

test("v0.10.x: parseSlashCommand tolerates leading + trailing whitespace", () => {
  assert.deepEqual(parseSlashCommand("  /now  "), { cmd: "now" });
  assert.deepEqual(parseSlashCommand("\t/queue\n"), { cmd: "queue" });
});

test("v0.10.x: parseSlashCommand is case-insensitive on the command head", () => {
  assert.deepEqual(parseSlashCommand("/NOW"), { cmd: "now" });
  assert.deepEqual(parseSlashCommand("/Pause"), { cmd: "pause" });
  assert.deepEqual(parseSlashCommand("/MORNING"), { cmd: "morning" });
});

test("v0.10.x: parseSlashCommand returns null for unknown slash commands", () => {
  assert.equal(parseSlashCommand("/foo"), null);
  assert.equal(parseSlashCommand("/help"), null);
  assert.equal(parseSlashCommand("/respondx ab12 hi"), null);
});

test("v0.10.x: parseSlashCommand /respond requires both shortId and text", () => {
  assert.equal(parseSlashCommand("/respond"), null);
  assert.equal(parseSlashCommand("/respond ab12cd34"), null, "shortId without text");
});

test("v0.10.x: parseSlashCommand /respond preserves dashed shortId", () => {
  const got = parseSlashCommand("/respond ab12-cd34-ef56 yes do it");
  assert.deepEqual(got, { cmd: "respond", shortId: "ab12-cd34-ef56", text: "yes do it" });
});

test("v0.10.x: parseSlashCommand /respond joins multi-word text with single spaces", () => {
  const got = parseSlashCommand("/respond xyz the   quick brown    fox");
  assert.deepEqual(got, { cmd: "respond", shortId: "xyz", text: "the quick brown fox" });
});

test("v0.10.x: parseSlashCommand strips @botname suffix even with mixed case", () => {
  assert.deepEqual(parseSlashCommand("/Now@OrqlaudeBot"), { cmd: "now" });
  assert.deepEqual(parseSlashCommand("/budget@somebot extra args"), { cmd: "budget" });
});
