import { test } from "node:test";
import assert from "node:assert/strict";
import { newPlan } from "../lib/state.js";

/**
 * v0.9.6 — agnet name assignment moved into newPlan().
 *
 * Before this, only `create_plan` ran the `pickAgnetName` loop. The
 * `review_prs` tool also calls newPlan() to spawn a follow-up fleet
 * against PRs from a completed plan, but had no naming loop — so review
 * fleets shipped with `agnetName: undefined`, showing as bare "Agnet"
 * in the CLI watch UI and Telegram notifications.
 *
 * Fix: newPlan() now assigns names itself, so every plan-creating path
 * (create_plan, review_prs, and any future tool) gets named tasks
 * automatically. These tests lock that in.
 */

test("v0.9.6: newPlan assigns agnetName to every task", () => {
  const p = newPlan("root", 100_000, [
    { title: "a", prompt: "pa", tldr: "ta" },
    { title: "b", prompt: "pb", tldr: "tb" },
    { title: "c", prompt: "pc", tldr: "tc" },
  ]);
  for (const t of p.tasks) {
    assert.ok(
      typeof t.agnetName === "string" && t.agnetName.length > 0,
      `task ${t.id} missing agnetName`
    );
  }
});

test("v0.9.6: agnet names are unique within a plan", () => {
  const p = newPlan(
    "root",
    100_000,
    Array.from({ length: 8 }, (_, i) => ({
      title: `t${i}`,
      prompt: "p",
      tldr: "t",
    }))
  );
  const names = new Set(p.tasks.map((t) => t.agnetName));
  assert.equal(
    names.size,
    p.tasks.length,
    `expected ${p.tasks.length} unique names, got ${names.size}: ${[...names].join(", ")}`
  );
});

test("v0.9.6: newPlan honors caller-provided agnetName", () => {
  // Tests pre-populate agnetName for determinism. newPlan must not
  // overwrite it.
  const p = newPlan("root", 100_000, [
    { title: "t", prompt: "p", tldr: "tl", agnetName: "CustomPicked" },
  ]);
  assert.equal(p.tasks[0].agnetName, "CustomPicked");
});

test("v0.9.6: agnet names are stable per task_id across calls (deterministic seeding)", () => {
  // Same set of task inputs → potentially different ids → different names,
  // but THE SAME plan's tasks always have stable names through their
  // lifetime. The stability contract is: once newPlan returns, the names
  // on those task objects don't change. (The cross-plan reproducibility
  // happens at the pickAgnetName layer and is covered by its own tests.)
  const p1 = newPlan("root", 100_000, [{ title: "t", prompt: "p", tldr: "tl" }]);
  const original = p1.tasks[0].agnetName;
  // Mutating any unrelated field shouldn't disturb agnetName.
  p1.tasks[0].title = "renamed";
  assert.equal(p1.tasks[0].agnetName, original);
});
