import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { snapshotSession, evictTailCacheEntry, clearTailCache } from "../lib/jsonl_tail.js";

/**
 * v0.10.9 — pre-spawn worktree hygiene + finer-grained fingerprint.
 *
 * Surfaced during the Email Hub polish + fix-up fleets, where
 * `wait_for_status_change` repeatedly returned `still_pending` for
 * agents that were genuinely making progress, and `snapshotSession`
 * sometimes returned the prior agent's tokens for a newly-spawned
 * agent's first few snapshots.
 *
 *   - Eviction helper: a public API to invalidate a single cache entry
 *     by stream path, used by `spawn_via_cli` before truncating the
 *     worktree's stdout.log.
 *   - Pre-spawn unlink: in addition to `.orqlaude.exit.json` (v0.10.7),
 *     also unlink `.orqlaude.stdout.log` and `.orqlaude.stderr.log` so
 *     the new agent gets a fresh inode (improves the v0.8.0
 *     `entry.inode !== stat.ino` invalidation hit rate).
 *   - Fingerprint bucket: change from `billed_tokens / 1024` to / 256
 *     so the long-poll wakes ~4x more often during the slow-burn phase
 *     of an agent's lifecycle.
 */

async function tempDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `orqlaude-v0109-${label}-`));
}

// Minimal JSONL event helpers — match the shape `applyEvent` parses.
function event(usage: { in?: number; out?: number; cacheRead?: number }): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      usage: {
        input_tokens: usage.in ?? 0,
        output_tokens: usage.out ?? 0,
        cache_read_input_tokens: usage.cacheRead ?? 0,
      },
    },
  });
}

test("v0.10.9: evictTailCacheEntry drops a single entry without clearing siblings", async () => {
  // Cross-check that two paths cached in the same process are independent
  // and a targeted eviction only touches one.
  const dir = await tempDir("evict-single");
  const cwd = "/fake-cwd";
  clearTailCache(); // start clean
  const pathA = path.join(dir, "agent-a.log");
  const pathB = path.join(dir, "agent-b.log");
  await fs.writeFile(pathA, event({ in: 100, out: 50 }) + "\n");
  await fs.writeFile(pathB, event({ in: 200, out: 75 }) + "\n");
  // Populate cache for both (note: snapshotSession uses session_id only
  // to build the canonical JSONL path; passing stdoutPath as a hint
  // makes it tail those files instead).
  const snapA1 = await snapshotSession(cwd, "session-a-id", pathA);
  const snapB1 = await snapshotSession(cwd, "session-b-id", pathB);
  assert.equal(snapA1.billedTokens, 150);
  assert.equal(snapB1.billedTokens, 275);

  // Evict ONLY pathA.
  evictTailCacheEntry(pathA);

  // Rewrite pathA with brand-new data; if the eviction worked, the
  // next snapshot should reload from disk and reflect the new tokens.
  await fs.writeFile(pathA, event({ in: 999, out: 1 }) + "\n");
  // Defensive mtime nudge so the resolver's stat picks up the change
  // even on filesystems with coarse mtime resolution.
  await new Promise((r) => setTimeout(r, 50));
  const snapA2 = await snapshotSession(cwd, "session-a-id", pathA);
  assert.equal(snapA2.billedTokens, 1000, "pathA cache was evicted, snapshot should reload");

  // pathB's cache was NOT evicted. Even if we rewrite pathB on disk,
  // the next snapshot may still use the cached entry until inode/mtime
  // invalidation kicks in. We just confirm the value isn't accidentally
  // contaminated from pathA.
  const snapB2 = await snapshotSession(cwd, "session-b-id", pathB);
  assert.notEqual(snapB2.billedTokens, 1000, "pathB must not have been touched by pathA's eviction");
});

test("v0.10.9: source-level check - spawn_cli unlinks stdout.log + stderr.log + exit.json before spawn", async () => {
  const src = await fs.readFile(
    path.join(import.meta.dirname, "..", "..", "src", "lib", "spawn_cli.ts"),
    "utf8"
  );
  // The unlink loop should reference all three filenames.
  assert.ok(
    src.includes(".orqlaude.exit.json"),
    "spawn_cli should reference .orqlaude.exit.json in the pre-spawn cleanup"
  );
  assert.ok(
    src.includes(".orqlaude.stdout.log") && src.includes(".orqlaude.stderr.log"),
    "spawn_cli should unlink stdout + stderr logs in pre-spawn cleanup"
  );
  // The loop pattern: `for (const stalePath of [...])`
  assert.ok(
    /for\s*\(\s*const\s+\w+\s+of\s+\[\s*exitJsonPathPre\s*,\s*stdoutPath\s*,\s*stderrPath\s*\]/.test(src),
    "all three paths should be unlinked in a single loop before fs.open(write)"
  );
});

test("v0.10.9: source-level check - spawn_cli calls evictTailCacheEntry for stdoutPath", async () => {
  const src = await fs.readFile(
    path.join(import.meta.dirname, "..", "..", "src", "lib", "spawn_cli.ts"),
    "utf8"
  );
  assert.ok(
    src.includes("evictTailCacheEntry(stdoutPath)"),
    "spawn_cli should explicitly evict the snapshot cache for stdoutPath before the new agent starts writing"
  );
  // Import is wired.
  assert.ok(
    /import\s*\{\s*evictTailCacheEntry\s*\}\s*from\s*["']\.\/jsonl_tail/.test(src),
    "spawn_cli imports evictTailCacheEntry from jsonl_tail"
  );
});

test("v0.10.9: source-level check - fingerprint bucket is /256 not /1024", async () => {
  const src = await fs.readFile(
    path.join(import.meta.dirname, "..", "..", "src", "tools", "dispatch.ts"),
    "utf8"
  );
  assert.ok(
    /billed_tokens\s*\/\s*256/.test(src),
    "fingerprint should use /256 in v0.10.9"
  );
  assert.ok(
    !/billed_tokens\s*\/\s*1024/.test(src),
    "the prior /1024 form should be gone (only one such expression in the file)"
  );
});

test("v0.10.9: fingerprint /256 wakes ~4x more often than /1024 over a slow climb", () => {
  // Simulate an agent climbing from 0 to 4096 billed in 16 increments
  // of 256 each. /1024 trips 4 buckets, /256 trips 16 buckets. The
  // long-poll wakes once per bucket change in the worst case, so 4x more
  // wakes = ~4x better responsiveness during slow burns.
  const climb = Array.from({ length: 17 }, (_, i) => i * 256); // 0, 256, ..., 4096
  const buckets1024 = new Set(climb.map((n) => Math.floor(n / 1024)));
  const buckets256 = new Set(climb.map((n) => Math.floor(n / 256)));
  assert.equal(buckets1024.size, 5, "5 distinct kb buckets at /1024 (0,1,2,3,4)");
  assert.equal(buckets256.size, 17, "17 distinct buckets at /256 (one per step)");
  // The ratio is what matters for the wake-rate improvement.
  assert.ok(buckets256.size >= buckets1024.size * 3, "at least 3x more wakes on slow burns");
});

test("v0.10.9: snapshot reload after eviction reflects fresh tokens (integration with the resolver)", async () => {
  // Realistic round-trip: write log, snapshot, evict, rewrite, re-snapshot,
  // confirm the resolver picked up the new content rather than returning
  // a cached snap from the prior entry.
  const dir = await tempDir("evict-roundtrip");
  const logPath = path.join(dir, ".orqlaude.stdout.log");
  await fs.writeFile(logPath, event({ in: 50, out: 50 }) + "\n");
  clearTailCache();
  const first = await snapshotSession("/cwd", "session-x", logPath);
  assert.equal(first.billedTokens, 100);
  // Eviction is the critical pre-condition for the v0.10.9 spawn flow.
  evictTailCacheEntry(logPath);
  await fs.writeFile(logPath, event({ in: 700, out: 300 }) + "\n");
  await new Promise((r) => setTimeout(r, 50));
  const second = await snapshotSession("/cwd", "session-x", logPath);
  assert.equal(second.billedTokens, 1000, "post-eviction snapshot should reflect the brand-new content");
});
