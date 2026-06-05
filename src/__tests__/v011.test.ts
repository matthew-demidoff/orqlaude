import { test } from "node:test";
import assert from "node:assert";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { JsonStore } from "../lib/json_store.js";
import { MemoryStore } from "../lib/memory.js";
import { BacklogStore } from "../lib/backlog.js";

/**
 * v0.11.0 polish pass — coverage for the new shared JSON store + the
 * lock/mtime behaviour the memory + backlog stores inherited from it.
 */

async function tmpdir(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `orq-test-${label}-`));
  return dir;
}

test("v0.11: JsonStore round-trips through update + read", async () => {
  const dir = await tmpdir("jsonstore");
  const store = new JsonStore<{ schemaVersion: 1; rows: string[] }>({
    filePath: path.join(dir, "f.json"),
    empty: { schemaVersion: 1, rows: [] },
  });
  await store.update((s) => {
    s.rows.push("first");
  });
  await store.update((s) => {
    s.rows.push("second");
  });
  const out = await store.read((s) => s.rows.slice());
  assert.deepStrictEqual(out, ["first", "second"]);
});

test("v0.11: JsonStore invalidates cache when another writer touches the file", async () => {
  const dir = await tmpdir("jsonstore-mtime");
  const filePath = path.join(dir, "f.json");
  const a = new JsonStore<{ schemaVersion: 1; rows: string[] }>({
    filePath,
    empty: { schemaVersion: 1, rows: [] },
  });
  const b = new JsonStore<{ schemaVersion: 1; rows: string[] }>({
    filePath,
    empty: { schemaVersion: 1, rows: [] },
  });
  await a.update((s) => {
    s.rows.push("from-a");
  });
  // b primes its cache.
  const first = await b.read((s) => s.rows.slice());
  assert.deepStrictEqual(first, ["from-a"]);
  // ensure mtime advances even on fast filesystems
  await new Promise((r) => setTimeout(r, 20));
  // a writes again, simulating cross-process. b must re-read from disk.
  await a.update((s) => {
    s.rows.push("from-a-2");
  });
  const second = await b.read((s) => s.rows.slice());
  assert.deepStrictEqual(second, ["from-a", "from-a-2"]);
});

test("v0.11: JsonStore tolerates a malformed file by warning + falling back to empty", async () => {
  const dir = await tmpdir("jsonstore-corrupt");
  const filePath = path.join(dir, "f.json");
  await fs.writeFile(filePath, "{not json", "utf8");
  const store = new JsonStore<{ schemaVersion: 1; rows: string[] }>({
    filePath,
    empty: { schemaVersion: 1, rows: [] },
  });
  const out = await store.read((s) => s.rows.slice());
  assert.deepStrictEqual(out, []);
  // Next write should succeed against the fresh empty state.
  await store.update((s) => {
    s.rows.push("recovered");
  });
  const after = await store.read((s) => s.rows.slice());
  assert.deepStrictEqual(after, ["recovered"]);
});

test("v0.11: MemoryStore.remember is durable + supersedes on (category,key) collision", async () => {
  const dir = await tmpdir("memory");
  const mem = new MemoryStore(dir);
  const a = await mem.remember({ category: "lore", key: "k", value: "first" });
  const b = await mem.remember({ category: "lore", key: "k", value: "second" });
  const list = await mem.list();
  assert.strictEqual(list.length, 1, "only the live entry is returned");
  assert.strictEqual(list[0]!.id, b.id);
  // The superseded entry stays on disk so audit history isn't lost.
  const raw = JSON.parse(await fs.readFile(path.join(dir, "memory.json"), "utf8"));
  assert.strictEqual(raw.entries.length, 2);
  const aOnDisk = raw.entries.find((e: any) => e.id === a.id);
  assert.strictEqual(aOnDisk.supersededBy, b.id);
});

test("v0.11: MemoryStore can be observed across two store instances (cross-process simulation)", async () => {
  const dir = await tmpdir("memory-cross");
  const a = new MemoryStore(dir);
  const b = new MemoryStore(dir);
  await a.remember({ category: "playbook", key: "x", value: "from-a" });
  // b had never read; first list must surface the entry, not cached emptiness.
  const fromB = await b.list();
  assert.strictEqual(fromB.length, 1);
  assert.strictEqual(fromB[0]!.value, "from-a");
  // mtime advance, then add from b — a must see it.
  await new Promise((r) => setTimeout(r, 20));
  await b.remember({ category: "playbook", key: "y", value: "from-b" });
  const fromA = await a.list();
  const keys = fromA.map((e) => e.key).sort();
  assert.deepStrictEqual(keys, ["x", "y"]);
});

test("v0.11: BacklogStore enqueue + pickNext respects priority + dependency order", async () => {
  const dir = await tmpdir("backlog");
  const bl = new BacklogStore(dir);
  const low = await bl.enqueue({ title: "low", priority: 10, source: "test" });
  const high = await bl.enqueue({ title: "high", priority: 90, source: "test", dependsOn: [low.id] });
  // high is blocked → pickNext returns low first.
  let next = await bl.pickNext();
  assert.strictEqual(next?.id, low.id);
  // Mark low done; now high becomes pickable.
  await bl.update(low.id, (g) => {
    g.status = "done";
  });
  next = await bl.pickNext();
  assert.strictEqual(next?.id, high.id);
});

test("v0.11: BacklogStore cross-process visibility", async () => {
  const dir = await tmpdir("backlog-cross");
  const writer = new BacklogStore(dir);
  const reader = new BacklogStore(dir);
  await writer.enqueue({ title: "first", priority: 50, source: "test" });
  let all = await reader.list();
  assert.strictEqual(all.length, 1);
  await new Promise((r) => setTimeout(r, 20));
  await writer.enqueue({ title: "second", priority: 60, source: "test" });
  all = await reader.list();
  assert.deepStrictEqual(
    all.map((g) => g.title),
    ["second", "first"],
    "list is priority-sorted and reader saw the fresh write"
  );
});

test("v0.11: BacklogStore tolerates a malformed file without crashing", async () => {
  const dir = await tmpdir("backlog-corrupt");
  await fs.writeFile(path.join(dir, "backlog.json"), "{half-written", "utf8");
  const bl = new BacklogStore(dir);
  // Should not throw.
  const empty = await bl.list();
  assert.deepStrictEqual(empty, []);
  await bl.enqueue({ title: "recovered", priority: 10, source: "test" });
  const after = await bl.list();
  assert.strictEqual(after.length, 1);
  assert.strictEqual(after[0]!.title, "recovered");
});

test("v0.11: BacklogStore.update returns undefined for unknown id rather than throwing", async () => {
  const dir = await tmpdir("backlog-noid");
  const bl = new BacklogStore(dir);
  const out = await bl.update("nope-no-such-id", (g) => {
    g.status = "done";
  });
  assert.strictEqual(out, undefined);
});

test("v0.11: MemoryStore.rememberBatch supersedes prior keys atomically", async () => {
  const dir = await tmpdir("memory-batch");
  const mem = new MemoryStore(dir);
  await mem.remember({ category: "atlas", key: "a", value: "v1" });
  await mem.remember({ category: "atlas", key: "b", value: "v1" });
  const batch = await mem.rememberBatch([
    { category: "atlas", key: "a", value: "v2" },
    { category: "atlas", key: "c", value: "v1" },
  ]);
  assert.strictEqual(batch.length, 2);
  const live = await mem.list();
  const map = new Map(live.map((e) => [e.key, e.value]));
  assert.strictEqual(map.get("a"), "v2", "batch supersedes prior `a`");
  assert.strictEqual(map.get("b"), "v1", "batch left `b` alone");
  assert.strictEqual(map.get("c"), "v1", "batch added `c`");
});
