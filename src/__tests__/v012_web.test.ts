import { test } from "node:test";
import assert from "node:assert";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { WebServer } from "../lib/web_server.js";
import { StateStore, newPlan } from "../lib/state.js";
import { MemoryStore } from "../lib/memory.js";
import { BacklogStore } from "../lib/backlog.js";

/**
 * v0.12.0 — `orql web` dashboard server. Covers the JSON surface, SSE
 * event stream, CSRF defence, and control-hook plumbing. We do NOT test
 * the HTML page itself (DOM rendering is exercised by hand) — the value
 * is in keeping the data shape and security model honest.
 */

async function tmpdir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `orq-web-${label}-`));
}

async function fetchJson(url: string, init: http.RequestOptions & { body?: string } = {}): Promise<{ status: number; body: any }> {
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
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: any = text;
          try { body = JSON.parse(text); } catch { /* keep raw */ }
          resolve({ status: res.statusCode ?? 0, body });
        });
      }
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

test("v0.12: WebServer /api/snapshot returns a valid payload shape on a fresh dir", async () => {
  const dir = await tmpdir("snap");
  const server = new WebServer({ stateDir: dir, port: 0 });
  const { url } = await server.start();
  try {
    const res = await fetchJson(url + "api/snapshot");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.body.ts, "number");
    assert.deepStrictEqual(res.body.plans, []);
    assert.deepStrictEqual(res.body.totals, { tokens: 0, costUsd: 0, agnetsActive: 0, agnetsTotal: 0 });
    assert.ok(res.body.memory && res.body.backlog && res.body.autopilot);
  } finally {
    await server.stop();
  }
});

test("v0.12: WebServer /api/snapshot reflects state + memory + backlog writes", async () => {
  const dir = await tmpdir("snap-data");
  const state = new StateStore(dir);
  const memory = new MemoryStore(dir);
  const backlog = new BacklogStore(dir);

  await state.update((s) => {
    const plan = newPlan("test plan", 100_000, [
      { title: "first task", prompt: "do the thing", tldr: "thing" },
    ]);
    plan.tasks[0]!.tokensUsed = 1234;
    plan.tasks[0]!.costUsd = 0.05;
    s.plans[plan.id] = plan;
  });
  await memory.remember({ category: "lore", key: "k1", value: "v1" });
  await backlog.enqueue({ title: "test goal", priority: 50, source: "test" });

  const server = new WebServer({ stateDir: dir, port: 0 });
  const { url } = await server.start();
  try {
    const res = await fetchJson(url + "api/snapshot");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.plans.length, 1);
    assert.strictEqual(res.body.plans[0].tasks.length, 1);
    assert.strictEqual(res.body.totals.tokens, 1234);
    assert.strictEqual(res.body.memory.total, 1);
    assert.strictEqual(res.body.backlog.queued, 1);
  } finally {
    await server.stop();
  }
});

test("v0.12: WebServer POST without CSRF token is rejected", async () => {
  const dir = await tmpdir("csrf");
  const server = new WebServer({
    stateDir: dir,
    port: 0,
    onPauseAutopilot: async () => {},
  });
  const { url } = await server.start();
  try {
    const res = await fetchJson(url + "api/autopilot/pause", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error, "csrf");
  } finally {
    await server.stop();
  }
});

test("v0.12: WebServer POST with valid CSRF invokes the control hook", async () => {
  const dir = await tmpdir("csrf-ok");
  let paused = false;
  const server = new WebServer({
    stateDir: dir,
    port: 0,
    onPauseAutopilot: async () => { paused = true; },
  });
  const { url } = await server.start();
  try {
    const res = await fetchJson(url + "api/autopilot/pause", {
      method: "POST",
      headers: { "content-type": "application/json", "x-orql-csrf": server.csrfToken },
      body: "{}",
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(paused, true);
  } finally {
    await server.stop();
  }
});

test("v0.12: WebServer returns 501 when a control hook is not wired", async () => {
  const dir = await tmpdir("unwired");
  const server = new WebServer({ stateDir: dir, port: 0 });
  const { url } = await server.start();
  try {
    const res = await fetchJson(url + "api/plan/abc/stop", {
      method: "POST",
      headers: { "content-type": "application/json", "x-orql-csrf": server.csrfToken },
      body: "{}",
    });
    assert.strictEqual(res.status, 501);
  } finally {
    await server.stop();
  }
});

test("v0.12: WebServer / serves a self-contained HTML page with the CSRF token embedded", async () => {
  const dir = await tmpdir("html");
  const server = new WebServer({ stateDir: dir, port: 0 });
  const { url } = await server.start();
  try {
    const res = await fetchJson(url);
    assert.strictEqual(res.status, 200);
    const body = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
    assert.match(body, /<!doctype html>/i);
    assert.match(body, /orqlaude/);
    // CSRF token must be injected — placeholder must be gone.
    assert.ok(!body.includes("__CSRF_TOKEN__"));
    assert.ok(body.includes(server.csrfToken));
  } finally {
    await server.stop();
  }
});

test("v0.12: WebServer /api/audit clamps `limit` to the safe range", async () => {
  const dir = await tmpdir("audit-clamp");
  const server = new WebServer({ stateDir: dir, port: 0 });
  const { url } = await server.start();
  try {
    // Negative & absurd values both clamp safely; should still return {events: []}.
    const r1 = await fetchJson(url + "api/audit?limit=-9");
    const r2 = await fetchJson(url + "api/audit?limit=99999");
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r2.status, 200);
    assert.deepStrictEqual(r1.body.events, []);
    assert.deepStrictEqual(r2.body.events, []);
  } finally {
    await server.stop();
  }
});

test("v0.12: WebServer SSE stream emits a snapshot event on connect", async () => {
  const dir = await tmpdir("sse");
  const server = new WebServer({ stateDir: dir, port: 0 });
  const { url } = await server.start();
  try {
    const parsed = new URL(url + "api/events");
    const received: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, headers: { accept: "text/event-stream" } },
        (res) => {
          assert.strictEqual(res.statusCode, 200);
          assert.match(res.headers["content-type"] ?? "", /text\/event-stream/);
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            received.push(chunk);
            // Wait until we see both a hello and a snapshot frame.
            const joined = received.join("");
            if (joined.includes("event: snapshot") && joined.includes("event: hello")) {
              req.destroy();
              resolve();
            }
          });
          res.on("error", reject);
        }
      );
      req.on("error", reject);
      // Safety net.
      setTimeout(() => { req.destroy(); reject(new Error("SSE timeout")); }, 3000);
    });
    const joined = received.join("");
    assert.match(joined, /event: snapshot/);
    assert.match(joined, /data: \{/);
  } finally {
    await server.stop();
  }
});

test("v0.12: WebServer healthz responds ok", async () => {
  const dir = await tmpdir("hz");
  const server = new WebServer({ stateDir: dir, port: 0 });
  const { url } = await server.start();
  try {
    const res = await fetchJson(url + "healthz");
    assert.strictEqual(res.status, 200);
  } finally {
    await server.stop();
  }
});
