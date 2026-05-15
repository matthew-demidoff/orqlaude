import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { StateStore } from "../lib/state.js";

/**
 * v0.10.8 — cross-process staleness fix.
 *
 * The bug: StateStore.read() trusted its in-memory cache forever after the
 * first load. When another process (the Telegram bot, the autopilot daemon,
 * a CLI invocation) wrote to state.json, our cache never refreshed, so
 * wait_for_user_response polled stale state forever even though the bot
 * had already recorded the user's answer.
 *
 * Symptom (from CRM Email Hub fleet planning session):
 *   - User taps button in Telegram
 *   - Bot UI shows "✓ Answer recorded (b96fb626)"
 *   - state.json on disk has response: "A. per-deal + websocket"
 *   - But MCP server's wait_for_user_response loop returns still_pending forever
 *
 * Fix: stat the file on every read(); if mtime moved, reload.
 */

async function tempDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `orqlaude-v0108-${label}-`));
}

test("v0.10.8: read() picks up cross-process writes to state.json", async () => {
  const dir = await tempDir("xprocess-read");
  const store = new StateStore(dir);
  // Seed via our store's update path so cache is populated.
  await store.update((state) => {
    state.orphanResponseRequests = state.orphanResponseRequests ?? [];
    state.orphanResponseRequests.push({
      id: "xp-test-id-aaaaaaaa",
      shortId: "xp-test-",
      prompt: "hello",
      createdAt: Date.now(),
      timeoutAt: Date.now() + 60_000,
      delivered: false,
    });
  });
  // Confirm we see what we just wrote.
  const before = await store.read((s) => (s.orphanResponseRequests ?? []).find((r) => r.shortId === "xp-test-"));
  assert.equal(before?.response, undefined);

  // Simulate another process modifying state.json directly.
  // We need mtime to differ; mtime resolution is typically nanosecond on
  // modern macOS/Linux, but to be defensive we add a small delay so the
  // write definitely produces a fresh mtime.
  await new Promise((r) => setTimeout(r, 50));
  const filePath = path.join(dir, "orqlaude-state.json");
  const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
  for (const r of raw.orphanResponseRequests ?? []) {
    if (r.shortId === "xp-test-") {
      r.response = "from another process";
      r.respondedAt = Date.now();
    }
  }
  await fs.writeFile(filePath, JSON.stringify(raw, null, 2));

  // v0.10.7 and earlier: read() would return the stale cached version
  // (response: undefined). v0.10.8: stat detects the mtime change, reloads.
  const after = await store.read((s) => (s.orphanResponseRequests ?? []).find((r) => r.shortId === "xp-test-"));
  assert.equal(after?.response, "from another process", "cross-process write should be visible to read()");
});

test("v0.10.8: persist() refreshes mtime so own writes don't trigger needless reload", async () => {
  const dir = await tempDir("own-write-mtime");
  const store = new StateStore(dir);
  let loadCount = 0;
  // We can't intercept loadFresh directly, but we can verify the round-trip
  // succeeds without erroring. The real telemetry is "no needless work".
  await store.update((state) => {
    state.orphanResponseRequests = state.orphanResponseRequests ?? [];
    state.orphanResponseRequests.push({
      id: "own-write-id-bbbbbbbb",
      shortId: "own-w-",
      prompt: "p",
      createdAt: Date.now(),
      timeoutAt: Date.now() + 60_000,
      delivered: false,
    });
    loadCount++;
  });
  // Several reads in a row should NOT trip reload (mtime hasn't changed).
  for (let i = 0; i < 5; i++) {
    const r = await store.read((s) => (s.orphanResponseRequests ?? []).length);
    assert.equal(r, 1);
  }
  // After we update again, the new write should be visible immediately.
  await store.update((state) => {
    state.orphanResponseRequests!.push({
      id: "own-write-id-cccccccc",
      shortId: "own-w2",
      prompt: "p2",
      createdAt: Date.now(),
      timeoutAt: Date.now() + 60_000,
      delivered: false,
    });
  });
  const len = await store.read((s) => (s.orphanResponseRequests ?? []).length);
  assert.equal(len, 2);
});

test("v0.10.8: empty state (no file) reads as fresh EMPTY_STATE", async () => {
  const dir = await tempDir("empty-state");
  const store = new StateStore(dir);
  // No file exists yet. Read should return empty state, not throw.
  const plans = await store.read((s) => Object.keys(s.plans).length);
  assert.equal(plans, 0);
});

test("v0.10.8: rapid bot-write + read sees the new value within one read", async () => {
  // Tight simulation of the wait_for_user_response loop scenario.
  const dir = await tempDir("tight-race");
  const store = new StateStore(dir);
  await store.update((state) => {
    state.orphanResponseRequests = state.orphanResponseRequests ?? [];
    state.orphanResponseRequests.push({
      id: "tight-race-id-dddddddd",
      shortId: "tight-",
      prompt: "p",
      createdAt: Date.now(),
      timeoutAt: Date.now() + 60_000,
      delivered: false,
    });
  });
  // Loop simulation: 3 reads observing no change, then a "bot write", then a 4th read.
  for (let i = 0; i < 3; i++) {
    const r = await store.read((s) => (s.orphanResponseRequests ?? []).find((x) => x.shortId === "tight-"));
    assert.equal(r?.response, undefined);
  }
  // mtime resolution defensive delay.
  await new Promise((r) => setTimeout(r, 50));
  const filePath = path.join(dir, "orqlaude-state.json");
  const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
  for (const r of raw.orphanResponseRequests ?? []) {
    if (r.shortId === "tight-") {
      r.response = "tapped a button";
      r.respondedAt = Date.now();
    }
  }
  await fs.writeFile(filePath, JSON.stringify(raw, null, 2));
  const found = await store.read((s) => (s.orphanResponseRequests ?? []).find((x) => x.shortId === "tight-"));
  assert.equal(found?.response, "tapped a button", "the very next read after the bot writes should see the new response");
});
