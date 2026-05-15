import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { StateStore } from "../lib/state.js";
import { escapeMd } from "../telegram/notifier.js";

/**
 * v0.10.1 — Telegram plain-text + reply-to-message + blocking ask_user.
 *
 * The full blocking-poll lifecycle is tested in a separate integration test
 * (requires running notifier + bot). These unit tests cover:
 *   • escapeMd is a no-op (we ship plain text now)
 *   • orphanResponseRequests is the right home for plan-less ask_user calls
 *   • reply-to-message routing logic: finding a request by telegramMessageId
 */

async function tempDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `orqlaude-v0101-${label}-`));
}

test("v0.10.1: escapeMd is a no-op (plain text shipping)", () => {
  assert.equal(escapeMd("*bold* _ital_ `code` [link]"), "*bold* _ital_ `code` [link]");
  assert.equal(escapeMd("plain"), "plain");
  assert.equal(escapeMd(""), "");
});

test("v0.10.1: ask_user creates an orphanResponseRequest when plan_id omitted", async () => {
  const dir = await tempDir("orphan");
  const store = new StateStore(dir);
  const id = "ask-user-test-id-12345678";
  await store.update((state) => {
    state.orphanResponseRequests = state.orphanResponseRequests ?? [];
    state.orphanResponseRequests.push({
      id,
      shortId: id.slice(0, 8),
      prompt: "test",
      createdAt: Date.now(),
      timeoutAt: Date.now() + 60_000,
      delivered: false,
    });
  });
  const found = await store.read((s) => (s.orphanResponseRequests ?? []).find((r) => r.id === id));
  assert.ok(found);
  assert.equal(found!.prompt, "test");
});

test("v0.10.1: reply-to-message routes by telegramMessageId + chatId tuple", async () => {
  const dir = await tempDir("reply-to");
  const store = new StateStore(dir);
  // Two requests sent to two different chats, same message_id by coincidence
  // (Telegram message_ids are per-chat, not global).
  await store.update((state) => {
    state.orphanResponseRequests = state.orphanResponseRequests ?? [];
    state.orphanResponseRequests.push({
      id: "req-a",
      shortId: "req-a",
      prompt: "A",
      createdAt: Date.now(),
      timeoutAt: Date.now() + 60_000,
      delivered: true,
      telegramMessageId: 42,
      telegramChatId: 111,
    });
    state.orphanResponseRequests.push({
      id: "req-b",
      shortId: "req-b",
      prompt: "B",
      createdAt: Date.now(),
      timeoutAt: Date.now() + 60_000,
      delivered: true,
      telegramMessageId: 42, // same message_id ...
      telegramChatId: 222, // ... but different chat
    });
  });
  // Mimic the routing logic in tryHandleReplyToQuestion: match BOTH msgId AND chatId.
  const matchA = await store.read((s) =>
    (s.orphanResponseRequests ?? []).find(
      (r) => r.telegramMessageId === 42 && r.telegramChatId === 111
    )
  );
  const matchB = await store.read((s) =>
    (s.orphanResponseRequests ?? []).find(
      (r) => r.telegramMessageId === 42 && r.telegramChatId === 222
    )
  );
  assert.equal(matchA?.id, "req-a");
  assert.equal(matchB?.id, "req-b");
});

test("v0.10.1: writing a response sets responded_at and persists", async () => {
  const dir = await tempDir("response");
  const store = new StateStore(dir);
  const id = "ask-write-test";
  await store.update((state) => {
    state.orphanResponseRequests = state.orphanResponseRequests ?? [];
    state.orphanResponseRequests.push({
      id,
      shortId: id.slice(0, 8),
      prompt: "x",
      createdAt: Date.now(),
      timeoutAt: Date.now() + 60_000,
      delivered: false,
    });
  });
  await store.update((state) => {
    const req = (state.orphanResponseRequests ?? []).find((r) => r.id === id);
    if (req) {
      req.response = "the answer";
      req.respondedAt = Date.now();
    }
  });
  const after = await store.read((s) => (s.orphanResponseRequests ?? []).find((r) => r.id === id));
  assert.equal(after?.response, "the answer");
  assert.ok(after?.respondedAt && after.respondedAt > 0);
});

test("v0.10.1: cancelled requests short-circuit before answering", async () => {
  const dir = await tempDir("cancelled");
  const store = new StateStore(dir);
  const id = "ask-cancel-test";
  await store.update((state) => {
    state.orphanResponseRequests = state.orphanResponseRequests ?? [];
    state.orphanResponseRequests.push({
      id,
      shortId: id.slice(0, 8),
      prompt: "x",
      createdAt: Date.now(),
      timeoutAt: Date.now() + 60_000,
      delivered: false,
      cancelled: true,
    });
  });
  // Mimic the ask_user poll loop's check.
  const result = await store.read((state) => {
    const req = (state.orphanResponseRequests ?? []).find((r) => r.id === id);
    if (!req) return null;
    if (req.cancelled) return { kind: "cancelled" as const };
    if (req.response !== undefined) return { kind: "answered" as const, response: req.response };
    return null;
  });
  assert.deepEqual(result, { kind: "cancelled" });
});
