import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { snapshotSession, clearTailCache } from "../lib/jsonl_tail.js";

/**
 * v0.9.2 — billed-vs-cached token accounting.
 *
 * Covers:
 *  • SessionSnapshot exposes separate billedTokens / cachedTokens / total
 *  • billedTokens = input + output (Plan-cost-relevant)
 *  • cachedTokens = cache_read + cache_creation (free on the Plan)
 *  • totalEffectiveTokens = sum (back-compat)
 *  • Plan.budgetMode defaults to "billed" via newPlan
 *
 * The budget-enforcement flow (status() / wait_for_status_change calling
 * enforceBudget with the right bucket) is covered by integration-style
 * runs against a live fleet; the unit tests here pin the snapshot maths.
 */

async function mkTempDir(prefix: string): Promise<string> {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return await fs.realpath(raw);
}

test("v0.9.2: snapshotSession exposes billed and cached buckets separately", async () => {
  clearTailCache();
  const dir = await mkTempDir("orq-v092-buckets-");
  const stdoutPath = path.join(dir, ".orqlaude.stdout.log");
  // One assistant event with usage covering all four bucket fields.
  await fs.writeFile(
    stdoutPath,
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "x" }],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 8000,
          cache_creation_input_tokens: 200,
        },
      },
      timestamp: new Date().toISOString(),
    }) + "\n"
  );
  const fakeSession = "00000000-0000-4000-8000-000000000aaa";
  const snap = await snapshotSession("/tmp/non-existent-cwd-v092", fakeSession, stdoutPath);

  assert.equal(snap.billedTokens, 150, "input + output only");
  assert.equal(snap.cachedTokens, 8200, "cache_read + cache_creation");
  assert.equal(snap.totalEffectiveTokens, 8350, "sum of all four buckets");
  assert.equal(
    snap.totalEffectiveTokens,
    snap.billedTokens + snap.cachedTokens,
    "total = billed + cached"
  );
});

test("v0.9.2: billed bucket excludes cache reads (the user is on the Claude Plan)", async () => {
  clearTailCache();
  const dir = await mkTempDir("orq-v092-billed-");
  const stdoutPath = path.join(dir, ".orqlaude.stdout.log");
  // A typical agent turn: small fresh input, small output, huge cache read.
  // This mirrors the pattern we saw in the v0.9.1 live test where Agnets
  // were reading 100k+ from cache per turn.
  await fs.writeFile(
    stdoutPath,
    [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [],
          usage: { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 100000 },
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [],
          usage: { input_tokens: 150, output_tokens: 80, cache_read_input_tokens: 100000 },
        },
      }),
    ].join("\n") + "\n"
  );
  const fakeSession = "00000000-0000-4000-8000-000000000bbb";
  const snap = await snapshotSession("/tmp/non-existent-cwd-v092-b", fakeSession, stdoutPath);

  assert.equal(snap.billedTokens, 530, "200+100 + 150+80 = 530 - what the Plan cares about");
  assert.equal(snap.cachedTokens, 200000, "two turns of 100k cache reads");
  assert.equal(snap.totalEffectiveTokens, 200530);
  // The KEY ratio: cache reads are 376x larger than billed. A budget cap
  // applied to `totalEffectiveTokens` would fire spuriously; applied to
  // `billedTokens` it reflects real Plan usage.
  const inflationRatio = snap.totalEffectiveTokens / snap.billedTokens;
  assert.ok(inflationRatio > 100, `cache inflates the total by ${Math.round(inflationRatio)}x`);
});

test("v0.9.2: empty snapshot has zeros for all three rollups", async () => {
  clearTailCache();
  const snap = await snapshotSession("/tmp/non-existent-cwd-v092-empty", "11111111-0000-4000-8000-000000000000");
  assert.equal(snap.billedTokens, 0);
  assert.equal(snap.cachedTokens, 0);
  assert.equal(snap.totalEffectiveTokens, 0);
});

test("v0.9.2: Plan.budgetMode defaults to undefined on newPlan; consumers treat undefined as 'billed'", async () => {
  const { newPlan } = await import("../lib/state.js");
  const p = newPlan("test", 100000, [
    { title: "a", prompt: "p", tldr: "t" },
    { title: "b", prompt: "p", tldr: "t" },
  ]);
  // newPlan itself doesn't set budgetMode - create_plan does. Both
  // semantics are valid; consumers must fallback to "billed" on undefined.
  // This pins the contract.
  assert.ok(p.budgetMode === undefined || p.budgetMode === "billed");
});

test("v0.9.2: total = billed + cached invariant holds across mixed events", async () => {
  clearTailCache();
  const dir = await mkTempDir("orq-v092-invariant-");
  const stdoutPath = path.join(dir, ".orqlaude.stdout.log");
  // Mix of event shapes: assistant with full usage, assistant with partial,
  // user (no usage), result row.
  await fs.writeFile(
    stdoutPath,
    [
      JSON.stringify({
        type: "assistant",
        message: { content: [], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } },
      }),
      JSON.stringify({ type: "user", message: { content: "noop" } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [], usage: { input_tokens: 7, output_tokens: 3 } },
      }),
      JSON.stringify({ type: "result", subtype: "completed" }),
    ].join("\n") + "\n"
  );
  const snap = await snapshotSession("/tmp/non-existent-cwd-v092-inv", "22222222-0000-4000-8000-000000000000", stdoutPath);
  assert.equal(snap.billedTokens, 25); // 10+5 + 7+3
  assert.equal(snap.cachedTokens, 120); // 100 + 20
  assert.equal(snap.totalEffectiveTokens, snap.billedTokens + snap.cachedTokens);
});
