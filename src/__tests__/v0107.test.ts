import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * v0.10.7 — re-spawn hygiene.
 *
 * Bugs surfaced during the Verdant re-spawn in self-test fleet d47c0448:
 *
 *   1. `.orqlaude.exit.json` from a prior agent stayed on disk and made
 *      `snapshot()` report the new agent as already terminated.
 *   2. `task.stopRequested` set by kill_task survived re-spawn, so the
 *      new agent's first checkin received a stale HARD STOP and bailed.
 *
 * Both fixed via source-level surgery. These tests verify the surgery is
 * present (the actual spawn path needs an integration test with claude).
 */

test("v0.10.7: spawn_cli unlinks stale .orqlaude.exit.json before spawn", async () => {
  const src = await fs.readFile(
    path.join(import.meta.dirname, "..", "..", "src", "lib", "spawn_cli.ts"),
    "utf8"
  );
  assert.ok(
    src.includes("exitJsonPathPre"),
    "spawn_cli should pre-unlink the exit json with a named variable"
  );
  assert.ok(
    /fs\.unlink\(exitJsonPathPre\)/.test(src),
    "spawn_cli should actually attempt to unlink the prior exit json"
  );
  assert.ok(
    src.indexOf("exitJsonPathPre") < src.indexOf("spawn(claudeBin"),
    "the pre-unlink must happen BEFORE the new process is spawned"
  );
});

test("v0.10.7: spawn_via_cli handler clears task.stopRequested on re-spawn", async () => {
  const src = await fs.readFile(
    path.join(import.meta.dirname, "..", "..", "src", "tools", "dispatch.ts"),
    "utf8"
  );
  assert.ok(
    src.includes("task.stopRequested = undefined"),
    "spawn_via_cli should reset stopRequested when claiming a previously-killed task"
  );
  assert.ok(
    src.includes("task.finishedAt = undefined"),
    "spawn_via_cli should also clear finishedAt so status() doesn't think the new run is terminated"
  );
  assert.ok(
    src.includes("task.exitReason = undefined"),
    "spawn_via_cli should also clear exitReason from the prior run"
  );
});

test("v0.10.7: clears happen AFTER setting new spawnedSessionId / pid", async () => {
  const src = await fs.readFile(
    path.join(import.meta.dirname, "..", "..", "src", "tools", "dispatch.ts"),
    "utf8"
  );
  const idxSpawnedId = src.indexOf("task.spawnedSessionId = spawn.sessionId");
  const idxStopClear = src.indexOf("task.stopRequested = undefined");
  assert.ok(idxSpawnedId > 0 && idxStopClear > 0, "both lines must be present");
  assert.ok(
    idxStopClear > idxSpawnedId,
    "clearing stopRequested must come AFTER setting the new spawnedSessionId to avoid losing the new claim if a concurrent reader sees the intermediate state"
  );
});
