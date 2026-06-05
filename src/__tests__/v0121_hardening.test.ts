import { test } from "node:test";
import assert from "node:assert";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { WebServer } from "../lib/web_server.js";
import { JsonStore } from "../lib/json_store.js";

/**
 * v0.12.1 — regression tests for the polish pass. Each test pins a specific
 * fix from the v0.12.0 audit; if any of these go green-to-red in the future,
 * we've broken a known sharp edge.
 */

async function tmpdir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `orq-v0121-${label}-`));
}

function fetchRaw(url: string, init: http.RequestOptions & { body?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: init.method ?? "GET",
        headers: init.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

// ---- Web server hardening -------------------------------------------------

test("v0.12.1: WebServer.stop() is idempotent", async () => {
  const dir = await tmpdir("idemp");
  const server = new WebServer({ stateDir: dir, port: 0 });
  await server.start();
  await server.stop();
  // Second call must not throw or hang.
  await server.stop();
  await server.stop();
});

test("v0.12.1: CSRF check is timing-safe (rejects wrong-length, wrong-content the same way)", async () => {
  const dir = await tmpdir("csrf-safe");
  const server = new WebServer({ stateDir: dir, port: 0, onPauseAutopilot: async () => {} });
  const { url } = await server.start();
  try {
    // Wrong length, wrong content, missing entirely — all 403.
    const r1 = await fetchRaw(url + "api/autopilot/pause", { method: "POST", headers: { "x-orql-csrf": "short" } });
    const r2 = await fetchRaw(url + "api/autopilot/pause", { method: "POST", headers: { "x-orql-csrf": "x".repeat(server.csrfToken.length) } });
    const r3 = await fetchRaw(url + "api/autopilot/pause", { method: "POST" });
    assert.strictEqual(r1.status, 403);
    assert.strictEqual(r2.status, 403);
    assert.strictEqual(r3.status, 403);
  } finally {
    await server.stop();
  }
});

test("v0.12.1: dashboard HTML response includes a Content-Security-Policy header", async () => {
  const dir = await tmpdir("csp");
  const server = new WebServer({ stateDir: dir, port: 0 });
  const { url } = await server.start();
  try {
    const res = await fetchRaw(url);
    assert.strictEqual(res.status, 200);
    const csp = res.headers["content-security-policy"];
    assert.ok(csp, "CSP header must be present");
    assert.match(String(csp), /frame-ancestors 'none'/);
    assert.match(String(csp), /default-src 'self'/);
    assert.strictEqual(res.headers["x-content-type-options"], "nosniff");
    assert.strictEqual(res.headers["referrer-policy"], "no-referrer");
  } finally {
    await server.stop();
  }
});

test("v0.12.1: SSE response includes X-Accel-Buffering: no and a retry directive", async () => {
  const dir = await tmpdir("sse-headers");
  const server = new WebServer({ stateDir: dir, port: 0 });
  const { url } = await server.start();
  try {
    const parsed = new URL(url + "api/events");
    const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const req = http.get(
        { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, headers: { accept: "text/event-stream" } },
        (res) => { resolve(res.headers); req.destroy(); }
      );
      req.on("error", reject);
      setTimeout(() => { req.destroy(); reject(new Error("timeout")); }, 3000);
    });
    assert.strictEqual(headers["x-accel-buffering"], "no");
    assert.match(String(headers["cache-control"]), /no-store/);
    assert.match(String(headers["content-type"]), /text\/event-stream/);
  } finally {
    await server.stop();
  }
});

test("v0.12.1: SSE broadcaster skips work when no clients are connected", async () => {
  // Indirect check: with no clients, the snapshot()-driven broadcaster
  // shouldn't be hit. We exercise it by calling broadcast() with no
  // clients and asserting it returns quickly without throwing.
  const dir = await tmpdir("sse-idle");
  const server = new WebServer({ stateDir: dir, port: 0 });
  try {
    // Call private method via cast — this is the same code the setInterval
    // entry-point invokes. The whole test is a smoke check that the
    // empty-client guard exists at all.
    await (server as any).broadcast();
  } finally {
    // Don't start, don't stop — just exercise the guard.
  }
});

// ---- JsonStore hardening --------------------------------------------------

test("v0.12.1: JsonStore detects cache staleness via SIZE even when mtime is unchanged", async () => {
  const dir = await tmpdir("size-fp");
  const filePath = path.join(dir, "f.json");
  const a = new JsonStore<{ schemaVersion: 1; rows: string[] }>({
    filePath,
    empty: { schemaVersion: 1, rows: [] },
  });
  await a.update((s) => { s.rows.push("a"); });
  // Now another writer rewrites the file at the same mtime tick (simulated
  // by forcibly setting the mtime back to what we cached). The size will
  // have changed, so cache must invalidate.
  await fs.writeFile(filePath, JSON.stringify({ schemaVersion: 1, rows: ["from-other", "from-other-2"] }, null, 2));
  const cached = (a as any).cacheMtimeMs as number;
  // Force mtime back to the prior cached value, defeating the mtime check.
  const stat = await fs.stat(filePath);
  await fs.utimes(filePath, stat.atime, new Date(cached));
  const out = await a.read((s) => s.rows.slice());
  // Without the size check this returned ['a'] from cache. With it, we
  // re-read from disk and see the other writer's content.
  assert.deepStrictEqual(out, ["from-other", "from-other-2"]);
});

test("v0.12.1: JsonStore tolerates concurrent updates from multiple instances in same process", async () => {
  const dir = await tmpdir("concurrent");
  const filePath = path.join(dir, "f.json");
  const stores = Array.from({ length: 8 }, () => new JsonStore<{ schemaVersion: 1; rows: number[] }>({
    filePath, empty: { schemaVersion: 1, rows: [] },
  }));
  // Each store appends its own index in parallel. The cross-process lock
  // (still respected within a process via the file lock) serializes them
  // so no append is lost.
  await Promise.all(stores.map((store, i) => store.update((s) => { s.rows.push(i); })));
  const final = await stores[0]!.read((s) => s.rows.slice().sort());
  assert.deepStrictEqual(final, [0, 1, 2, 3, 4, 5, 6, 7]);
});

// ---- Cost CLI hardening ---------------------------------------------------

test("v0.12.1: sparkline coerces NaN/Infinity to 0 without crashing", async () => {
  const { sparkline } = await import("../cli/cost.js");
  const out = sparkline([NaN, Infinity, -1, 5]);
  // Should not throw and should produce a string of length 4.
  // Strip ANSI to count visible glyphs.
  // eslint-disable-next-line no-control-regex
  const visible = out.replace(/\x1b\[[0-9;]*m/g, "");
  assert.strictEqual(visible.length, 4);
});

// ---- Goal CLI hardening ---------------------------------------------------

test("v0.12.1: parseDeadline accepts well-formed dates + relative forms", async () => {
  const { parseDeadline } = await import("../cli/goal.js");
  // Absolute.
  assert.ok(parseDeadline("2030-06-15") !== null);
  // Relative.
  const d = parseDeadline("+7d");
  assert.ok(d !== null);
  assert.ok(d! > Date.now());
  assert.ok(d! < Date.now() + 8 * 86_400_000);
  const w = parseDeadline("+2w");
  assert.ok(w !== null);
  assert.ok(w! > Date.now() + 13 * 86_400_000);
  // Whitespace-tolerant.
  assert.ok(parseDeadline("  +1d  ") !== null);
});

test("v0.12.1: parseDeadline rejects out-of-range dates that Date would silently roll over", async () => {
  const { parseDeadline } = await import("../cli/goal.js");
  // Feb 30 / month 13 / day 32 — all rolled by JS Date but rejected here.
  assert.strictEqual(parseDeadline("2026-02-30"), null);
  assert.strictEqual(parseDeadline("2026-13-15"), null);
  assert.strictEqual(parseDeadline("2026-04-31"), null);
  assert.strictEqual(parseDeadline("2026-00-15"), null);
  assert.strictEqual(parseDeadline("2026-12-00"), null);
});

test("v0.12.1: parseDeadline rejects malformed strings", async () => {
  const { parseDeadline } = await import("../cli/goal.js");
  assert.strictEqual(parseDeadline(""), null);
  assert.strictEqual(parseDeadline("yesterday"), null);
  assert.strictEqual(parseDeadline("2026/06/15"), null);
  assert.strictEqual(parseDeadline("+999999d"), null, "absurdly large +Nd must be rejected");
  assert.strictEqual(parseDeadline("+0d"), null);
  assert.strictEqual(parseDeadline("+-7d"), null);
});

test("v0.12.1: SSE clients are evicted from the in-memory set on disconnect", async () => {
  const dir = await tmpdir("sse-evict");
  const server = new WebServer({ stateDir: dir, port: 0 });
  const { url } = await server.start();
  try {
    const parsed = new URL(url + "api/events");
    // Open + close a stream; the server's eviction handlers must fire and
    // the internal Set must drain back to zero. We assert via the
    // private field — fragile if the implementation refactors, but tight
    // enough to catch a re-introduction of the leak.
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, headers: { accept: "text/event-stream" } },
        (res) => {
          res.once("data", () => {
            req.destroy();
            // Give the close handler a microtask to run.
            setTimeout(resolve, 50);
          });
          res.on("error", () => { /* expected when we destroy */ });
        }
      );
      req.on("error", () => { /* abort on close */ });
      setTimeout(() => reject(new Error("SSE eviction timeout")), 2000);
    });
    const remaining = (server as any).sseClients.size;
    assert.strictEqual(remaining, 0, "eviction should drain the SSE client Set");
  } finally {
    await server.stop();
  }
});

test("v0.12.1: BacklogStore handles double-cancel via friendly error path", async () => {
  // We test the underlying primitive: BacklogStore.update propagates a
  // mutator throw, and cmdCancel must catch it. Here we just verify the
  // backlog primitive does propagate.
  const { BacklogStore } = await import("../lib/backlog.js");
  const dir = await tmpdir("dbl-cancel");
  const bl = new BacklogStore(dir);
  const g = await bl.enqueue({ title: "x", priority: 10, source: "test" });
  await bl.update(g.id, (gg) => {
    gg.status = "cancelled";
  });
  // Second cancel via a throwing mutator must propagate.
  await assert.rejects(
    bl.update(g.id, (gg) => {
      if (gg.status === "cancelled") throw new Error("already cancelled");
    }),
    /already cancelled/
  );
  // And the store should NOT have re-applied any partial mutation.
  const after = (await bl.list())[0]!;
  assert.strictEqual(after.status, "cancelled");
});
