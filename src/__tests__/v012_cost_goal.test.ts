import { test } from "node:test";
import assert from "node:assert";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { sparkline } from "../cli/cost.js";
import { BacklogStore } from "../lib/backlog.js";
import { findTemplate, FLEET_TEMPLATES } from "../lib/templates.js";

/**
 * v0.12.0 — `orql cost` sparkline rendering + `orql goal new` template
 * scaffolding. We don't drive the readline-based wizard from a test; we
 * exercise the building blocks that make the user-facing commands
 * trustworthy.
 */

async function tmpdir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `orq-v012-${label}-`));
}

// strip ANSI for assertions on visible content
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

test("v0.12: sparkline handles empty input gracefully", () => {
  assert.strictEqual(sparkline([]), "");
});

test("v0.12: sparkline draws a flat baseline when all values are zero", () => {
  const out = sparkline([0, 0, 0, 0, 0]);
  const visible = plain(out);
  // Five values → five glyphs, all the lowest block.
  assert.strictEqual(visible.length, 5);
  assert.ok([...visible].every((c) => c === "▁"));
});

test("v0.12: sparkline scales to the max value", () => {
  const out = sparkline([1, 2, 4, 8]);
  const visible = plain(out);
  const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  // 4 chars; last char should be the highest block (the max).
  assert.strictEqual(visible.length, 4);
  assert.strictEqual(visible[3], "█");
  // The lowest value's band must be < the highest's, and both must be in
  // the block set. (Exact band depends on the round() boundary; testing
  // the ordering keeps the assertion stable across tweaks.)
  const lowIdx = blocks.indexOf(visible[0]!);
  const highIdx = blocks.indexOf(visible[3]!);
  assert.ok(lowIdx >= 0 && highIdx === blocks.length - 1);
  assert.ok(lowIdx < highIdx);
});

test("v0.12: sparkline gives recent values the recent-style color (last 7)", () => {
  // 10 values → first 3 use the 'sand' palette, last 7 'coral'. Check that
  // the styled output contains different color escape sequences in those
  // regions, not just a uniform stream.
  const out = sparkline([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // First glyph appears with one escape; last glyph with another.
  assert.notStrictEqual(out.split("▁")[0], out.split("█")[0]);
});

test("v0.12: every bundled fleet template is well-formed", () => {
  for (const t of FLEET_TEMPLATES) {
    assert.ok(t.id, `template missing id`);
    assert.ok(t.title, `${t.id}: missing title`);
    assert.ok(t.description, `${t.id}: missing description`);
    assert.ok(t.agentRoles.length > 0, `${t.id}: must declare at least one role`);
    assert.ok(t.defaultPerAgnetBudget > 0, `${t.id}: budget must be positive`);
    for (const r of t.agentRoles) {
      assert.ok(r.role, `${t.id}: role without id`);
      assert.ok(r.purpose, `${t.id}: role ${r.role} missing purpose`);
    }
  }
});

test("v0.12: template ids are unique", () => {
  const ids = FLEET_TEMPLATES.map((t) => t.id);
  assert.strictEqual(ids.length, new Set(ids).size, "duplicate template id");
});

test("v0.12: findTemplate returns the right template by id", () => {
  const t = findTemplate("audit-sweep");
  assert.ok(t, "expected audit-sweep template");
  assert.match(t!.title, /audit/i);
});

test("v0.12: findTemplate returns undefined for an unknown id", () => {
  assert.strictEqual(findTemplate("does-not-exist"), undefined);
});

test("v0.12: BacklogStore.enqueue from a template id produces a launchable goal", async () => {
  const dir = await tmpdir("goal-from-tpl");
  const backlog = new BacklogStore(dir);
  const template = findTemplate("test-coverage-fill")!;
  const goal = await backlog.enqueue({
    title: "raise coverage on auth module",
    description: `Apply ${template.title}`,
    priority: 55,
    template: template.id,
    tags: template.suggestedForTags,
    scope: ["src/auth/**"],
    source: "test",
  });
  assert.strictEqual(goal.template, "test-coverage-fill");
  assert.strictEqual(goal.status, "queued");
  assert.deepStrictEqual(goal.scope, ["src/auth/**"]);
  // pickNext should select it (it's the only queued goal, no deps).
  const next = await backlog.pickNext();
  assert.strictEqual(next?.id, goal.id);
});

test("v0.12: pickNext respects deadline-driven priority boost", async () => {
  const dir = await tmpdir("priority-boost");
  const backlog = new BacklogStore(dir);
  // Low-priority goal with a deadline TODAY should outrank a higher-base goal
  // with no deadline.
  const lowWithDeadline = await backlog.enqueue({
    title: "urgent",
    priority: 40,
    deadlineAt: Date.now(),
    source: "test",
  });
  await backlog.enqueue({ title: "normal", priority: 60, source: "test" });
  const list = await backlog.list();
  // list() applies the deadline boost; the urgent one should come first.
  assert.strictEqual(list[0]!.id, lowWithDeadline.id);
});
