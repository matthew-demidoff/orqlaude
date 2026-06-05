import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { StateStore, type Plan, type Task } from "./state.js";
import { AuditLog, type AuditEvent } from "./audit.js";
import { MemoryStore } from "./memory.js";
import { BacklogStore } from "./backlog.js";
import { snapshotSession, type SessionSnapshot } from "./jsonl_tail.js";

/**
 * `orql web` — local HTTP dashboard for the running fleet.
 *
 * Why a web dashboard when `orql watch` exists?
 *   • `watch` is a CLI snapshot loop; it can't show drilldown without nuking
 *     the terminal. The web view scales: one row per agnet, click for full
 *     prompt + tool history + token meter + kill button.
 *   • The terminal is a precious resource. Devs babysit fleets across
 *     hours; pinning a browser tab beats burning a tmux pane.
 *   • Remote access: stand up the server on a workstation, port-forward,
 *     and the user can drive the fleet from their phone.
 *
 * Why no framework / no build step?
 *   • Single binary, single command. No node_modules bloat, no Vite config,
 *     no "did you run npm install in the right dir." The HTML/CSS/JS is
 *     served from a string constant — see DASHBOARD_HTML at the bottom.
 *   • The data model is small (one snapshot per second, ~10kB JSON for a
 *     reasonable fleet). Rendering vanilla DOM is fine.
 *
 * Transport: Server-Sent Events (SSE) for live updates. Why not WebSocket?
 *   • SSE is one-way (server → client), which is exactly the shape here.
 *     Control actions (kill, stop, pause) are POSTed; nothing the page
 *     needs to push to the server requires a duplex pipe.
 *   • SSE survives proxies and `Cache-Control: no-store` is the only
 *     header dance required. WebSocket needs `Upgrade:` handling, which
 *     is more code for no benefit at this scale.
 *   • Auto-reconnect comes for free — EventSource retries on its own.
 *
 * Security: binds to 127.0.0.1 only. There is intentionally no auth in
 * front — opening a privileged port on the public internet is the user's
 * responsibility (they can SSH-tunnel if they want remote access). A token
 * header is checked on POST actions to defeat trivial CSRF from a stray
 * browser tab.
 */

export interface WebServerOpts {
  stateDir: string;
  port: number;
  host?: string;
  /**
   * Token required on POST /api/* to defeat CSRF. Generated fresh per boot;
   * echoed to the page on initial GET / so the in-page JS picks it up.
   */
  csrfToken?: string;
  /**
   * Callback when the server wants to spawn an agnet kill. Optional —
   * if absent, the kill endpoint returns 501 (the dashboard hides the
   * button). Wired by the CLI to call into `kill_task` plumbing.
   */
  onKillTask?: (planId: string, taskId: string) => Promise<void>;
  onStopPlan?: (planId: string, reason?: string) => Promise<void>;
  onPauseAutopilot?: () => Promise<void>;
  onResumeAutopilot?: () => Promise<void>;
}

export interface DashboardPayload {
  serverVersion: string;
  ts: number;
  plans: PlanView[];
  audit: AuditEvent[];
  memory: { total: number; lastChange: number | null };
  backlog: { queued: number; running: number; done: number };
  autopilot: { paused: boolean };
  totals: { tokens: number; costUsd: number; agnetsActive: number; agnetsTotal: number };
}

export interface PlanView {
  id: string;
  shortId: string;
  status: string;
  rootTask: string;
  createdAt: number;
  budgetCapTokens: number;
  budgetMode: string;
  tokensUsed: number;
  costUsd: number;
  tasks: TaskView[];
  recentNotes: Array<{ id: string; from: string; text: string; postedAt: number; blocking: boolean }>;
}

export interface TaskView {
  id: string;
  shortId: string;
  title: string;
  agnetName?: string;
  status: string;
  tokensUsed: number;
  costUsd: number;
  startedAt?: number;
  finishedAt?: number;
  prUrl?: string;
  lastAssistantText?: string | null;
  lastToolUse?: string | null;
  worktreePath?: string;
  scope?: string[];
  stopRequested?: boolean;
}

const SSE_TICK_MS = 1000;
const SSE_HEARTBEAT_MS = 25_000;
const AUDIT_TAIL_LIMIT = 80;

/**
 * Slowloris hardening — Node.js default timeouts are friendly to long-lived
 * connections (which we want for SSE) but lax against a misbehaving client
 * that opens a socket and never finishes its headers. These mirror the
 * values from the v18+ defaults explicitly so a future Node downgrade
 * (e.g. user installs via Homebrew old-stable) still gets safe behavior.
 *
 * Notes:
 *   • requestTimeout: max age of the whole request (headers + body). 30s
 *     is fine for an admin dashboard where requests are tiny JSON blobs.
 *   • headersTimeout: max time to receive all headers. 10s.
 *   • keepAliveTimeout: how long an idle keep-alive socket lingers. 5s.
 *     SSE sockets are NOT subject to keepAliveTimeout (they have an
 *     active response in flight); only idle pooled sockets are.
 *
 * These do NOT affect SSE longevity — see the per-response keep-alive
 * pinning in serveEvents().
 */
const SERVER_TIMEOUTS = {
  requestTimeoutMs: 30_000,
  headersTimeoutMs: 10_000,
  keepAliveTimeoutMs: 5_000,
};

const MAX_CONNECTIONS = 64;

export class WebServer {
  private opts: Required<Pick<WebServerOpts, "host" | "port" | "stateDir">> & WebServerOpts;
  private server: http.Server | null = null;
  private state: StateStore;
  private audit: AuditLog;
  private memory: MemoryStore;
  private backlog: BacklogStore;
  private csrf: string;
  /** Set of active SSE response streams; we broadcast snapshots to each. */
  private sseClients = new Set<http.ServerResponse>();
  /**
   * For each SSE client we remember the last successful write time, so the
   * heartbeat ticker can decide whether to emit a `:keepalive` comment, and
   * the slow-client culler can decide whether to evict.
   */
  private sseLastWrite = new WeakMap<http.ServerResponse, number>();
  private tickHandle: NodeJS.Timeout | null = null;
  private heartbeatHandle: NodeJS.Timeout | null = null;
  /**
   * Track stopped state so .stop() is safely idempotent. SIGINT+SIGTERM
   * arriving back-to-back, or two callers awaiting stop in parallel, must
   * not double-close the underlying server.
   */
  private stopped = false;

  constructor(opts: WebServerOpts) {
    this.opts = { host: "127.0.0.1", ...opts };
    this.state = new StateStore(opts.stateDir);
    this.audit = new AuditLog(opts.stateDir);
    this.memory = new MemoryStore(opts.stateDir);
    this.backlog = new BacklogStore(opts.stateDir);
    this.csrf = opts.csrfToken ?? randomUUID();
  }

  get csrfToken(): string {
    return this.csrf;
  }

  async start(): Promise<{ url: string }> {
    this.server = http.createServer((req, res) => this.handle(req, res));

    // Slowloris hardening. See SERVER_TIMEOUTS for rationale.
    this.server.requestTimeout = SERVER_TIMEOUTS.requestTimeoutMs;
    this.server.headersTimeout = SERVER_TIMEOUTS.headersTimeoutMs;
    this.server.keepAliveTimeout = SERVER_TIMEOUTS.keepAliveTimeoutMs;
    // Soft cap on concurrent sockets. A local dev tool with >64 SSE clients
    // is almost certainly stuck-tab cleanup, not legitimate use.
    this.server.maxConnections = MAX_CONNECTIONS;

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.opts.port, this.opts.host, () => resolve());
    });
    // Snapshot broadcaster — only runs when at least one client is connected
    // (otherwise it pointlessly stat-checks four files every second).
    this.tickHandle = setInterval(() => {
      if (this.sseClients.size === 0) return;
      this.broadcast().catch(() => { /* swallow; per-client errors logged */ });
    }, SSE_TICK_MS);
    // Heartbeat — emit a comment line on streams that have been idle for
    // SSE_HEARTBEAT_MS. This defeats proxy idle-kill (nginx default 60s)
    // even when the snapshot payload happens to be byte-identical to the
    // last one (no event = no traffic).
    this.heartbeatHandle = setInterval(() => this.heartbeat(), 5_000);

    const addr = this.server!.address();
    const port = typeof addr === "object" && addr ? addr.port : this.opts.port;
    return { url: `http://${this.opts.host}:${port}/` };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.tickHandle) clearInterval(this.tickHandle);
    if (this.heartbeatHandle) clearInterval(this.heartbeatHandle);
    this.tickHandle = null;
    this.heartbeatHandle = null;
    for (const client of this.sseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    this.sseClients.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  /** Emit `: keepalive` on every SSE stream that hasn't seen a write in the
   *  heartbeat window. Costs ~12 bytes per client; defeats proxy idle-kill. */
  private heartbeat(): void {
    const now = Date.now();
    for (const client of this.sseClients) {
      const last = this.sseLastWrite.get(client) ?? 0;
      if (now - last < SSE_HEARTBEAT_MS) continue;
      const ok = this.safeWrite(client, ": keepalive\n\n");
      if (!ok) this.evictClient(client);
    }
  }

  /**
   * Write to an SSE client with backpressure awareness. If the socket
   * buffer fills (write returns false), we DON'T queue more data — we
   * mark the client as slow and drop on the next pass. This bounds memory
   * even if a client is hung on a stalled TCP connection.
   *
   * Returns true if the write was accepted; false if the client should be
   * evicted (write returned false, or the underlying socket is destroyed).
   */
  private safeWrite(client: http.ServerResponse, payload: string): boolean {
    if (client.writableEnded || client.destroyed) return false;
    try {
      const ok = client.write(payload);
      this.sseLastWrite.set(client, Date.now());
      return ok;
    } catch {
      return false;
    }
  }

  private evictClient(client: http.ServerResponse): void {
    this.sseClients.delete(client);
    try { client.end(); } catch { /* socket already dead */ }
  }

  /**
   * Constant-time CSRF comparison. `timingSafeEqual` requires same-length
   * buffers, so length-mismatch is its own early-out (and constant-time
   * within length checks — the attacker's signal is only "wrong length",
   * not which byte mismatched).
   */
  private csrfMatches(provided: string): boolean {
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(this.csrf, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** Build a single dashboard payload from current disk state. */
  async snapshot(): Promise<DashboardPayload> {
    const [plansArr, auditEvents, memList, backlogList, autopilotPaused] = await Promise.all([
      this.state.read((s) => Object.values(s.plans).slice()).catch(() => [] as Plan[]),
      this.audit.tail(AUDIT_TAIL_LIMIT).catch(() => [] as AuditEvent[]),
      this.memory.list().catch(() => []),
      this.backlog.list().catch(() => []),
      this.isAutopilotPaused(),
    ]);

    const plans: PlanView[] = await Promise.all(
      plansArr
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((p) => this.planView(p))
    );

    let tokens = 0;
    let cost = 0;
    let agnetsActive = 0;
    let agnetsTotal = 0;
    for (const p of plans) {
      tokens += p.tokensUsed;
      cost += p.costUsd;
      for (const t of p.tasks) {
        agnetsTotal++;
        if (t.status === "dispatched" || t.status === "running") agnetsActive++;
      }
    }

    const lastMemChange = memList.length === 0 ? null : Math.max(...memList.map((e) => e.createdAt));

    return {
      serverVersion: process.env.ORQLAUDE_VERSION ?? "dev",
      ts: Date.now(),
      plans,
      audit: auditEvents.slice(-AUDIT_TAIL_LIMIT).reverse(),
      memory: { total: memList.length, lastChange: lastMemChange },
      backlog: {
        queued: backlogList.filter((g) => g.status === "queued").length,
        running: backlogList.filter((g) => g.status === "running" || g.status === "planning").length,
        done: backlogList.filter((g) => g.status === "done").length,
      },
      autopilot: { paused: autopilotPaused },
      totals: { tokens, costUsd: cost, agnetsActive, agnetsTotal },
    };
  }

  private async planView(plan: Plan): Promise<PlanView> {
    const tasks = await Promise.all(plan.tasks.map((t) => this.taskView(t)));
    const tokensUsed = tasks.reduce((s, t) => s + t.tokensUsed, 0);
    const costUsd = tasks.reduce((s, t) => s + t.costUsd, 0);
    return {
      id: plan.id,
      shortId: plan.id.slice(0, 8),
      status: plan.status,
      rootTask: plan.rootTask,
      createdAt: plan.createdAt,
      budgetCapTokens: plan.budgetCapTokens,
      budgetMode: plan.budgetMode ?? "billed",
      tokensUsed,
      costUsd,
      tasks,
      recentNotes: plan.notes
        .slice(-8)
        .reverse()
        .map((n) => ({
          id: n.id,
          from: n.fromSessionId.slice(0, 8),
          text: n.text.slice(0, 280),
          postedAt: n.postedAt,
          blocking: n.blocking,
        })),
    };
  }

  private async taskView(t: Task): Promise<TaskView> {
    let snap: SessionSnapshot | null = null;
    if (t.spawnedSessionId) {
      try {
        // The Desktop-JSONL resolver needs the cwd the agent ran in. Best
        // candidate: the worktree path (where the spawned process lives);
        // fall back to the parent project dir if no worktree.
        const cwd = t.worktreePath ?? process.cwd();
        snap = await snapshotSession(cwd, t.spawnedSessionId, t.stdoutPath);
      } catch {
        /* leave snap null */
      }
    }
    const lastAssistantText = snap?.lastAssistantText
      ? snap.lastAssistantText.slice(-400)
      : null;
    const lastToolUse = snap?.lastToolUse
      ? `${snap.lastToolUse.name}${describeToolInput(snap.lastToolUse.input)}`
      : null;
    return {
      id: t.id,
      shortId: t.id.slice(0, 8),
      title: t.title,
      agnetName: t.agnetName,
      status: t.status,
      tokensUsed: snap?.billedTokens ?? t.tokensUsed ?? 0,
      costUsd: snap?.totalCostUsd ?? t.costUsd ?? 0,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      prUrl: t.prUrl,
      lastAssistantText,
      lastToolUse,
      worktreePath: t.worktreePath,
      scope: t.scope,
      stopRequested: !!t.stopRequested,
    };
  }

  private async isAutopilotPaused(): Promise<boolean> {
    try {
      await fs.stat(path.join(this.opts.stateDir, "autopilot.paused"));
      return true;
    } catch {
      return false;
    }
  }

  private async broadcast(): Promise<void> {
    if (this.sseClients.size === 0) return;
    let payload: string;
    try {
      const snap = await this.snapshot();
      payload = `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`;
    } catch (err) {
      payload = `event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`;
    }
    // Iterate over a snapshot of the set so evictClient() during iteration
    // doesn't perturb the loop. Slow clients are evicted in the same pass.
    for (const client of [...this.sseClients]) {
      const ok = this.safeWrite(client, payload);
      if (!ok) this.evictClient(client);
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/") return this.serveDashboardHtml(res);
      if (req.method === "GET" && url.pathname === "/api/snapshot") return this.serveSnapshot(res);
      if (req.method === "GET" && url.pathname === "/api/events") return this.serveEvents(req, res);
      if (req.method === "GET" && url.pathname === "/api/audit") return this.serveAudit(res, url);
      if (req.method === "GET" && url.pathname === "/api/memory") return this.serveMemory(res);
      if (req.method === "GET" && url.pathname === "/api/backlog") return this.serveBacklog(res);
      if (req.method === "POST" && url.pathname.startsWith("/api/")) return this.servePost(req, res, url);
      if (req.method === "GET" && url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private serveDashboardHtml(res: http.ServerResponse): void {
    const html = DASHBOARD_HTML.replace("__CSRF_TOKEN__", this.csrf);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // Defense-in-depth: even if a future change accidentally interpolates
      // user data into the page unescaped, the CSP forbids inline + remote
      // script execution from anything but our own origin. We do use
      // inline <style> and <script>, so 'unsafe-inline' is unavoidable
      // here — but eval and remote loads are blocked, which catches the
      // most common XSS payloads.
      "content-security-policy":
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; " +
        "connect-src 'self'; " +
        "frame-ancestors 'none'; " +
        "base-uri 'self';",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(html);
  }

  private async serveSnapshot(res: http.ServerResponse): Promise<void> {
    const snap = await this.snapshot();
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(snap));
  }

  private serveEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      // nginx-specific: disable response buffering so events flush immediately.
      // Harmless if not behind nginx; respected by Cloudflare's nginx tier too.
      "x-accel-buffering": "no",
      connection: "keep-alive",
      // Pin the connection open for an hour — long enough that the per-route
      // keepAliveTimeout (idle pool timeout) is irrelevant. The page will
      // reconnect on its own anyway.
      "keep-alive": "timeout=3600",
    });
    // Some Node versions install a default socket timeout (~2 min); SSE
    // streams are intentionally long-lived. Disable per-socket timeout.
    res.socket?.setTimeout(0);
    res.socket?.setKeepAlive(true);
    // Suggest a 5s reconnect window to the EventSource client. This is a
    // hint; the browser may use exponential backoff on repeated failures.
    res.write("retry: 5000\n\n");
    res.write("event: hello\ndata: {}\n\n");
    this.sseLastWrite.set(res, Date.now());
    this.sseClients.add(res);
    // Send an immediate snapshot so the page populates without waiting a full
    // second for the next broadcast tick.
    this.snapshot()
      .then((snap) => {
        if (this.sseClients.has(res)) {
          const ok = this.safeWrite(res, `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
          if (!ok) this.evictClient(res);
        }
      })
      .catch(() => { /* initial snapshot best-effort */ });
    // Three signals a client is gone: request 'close' (graceful), response
    // 'close' (socket teardown), and socket 'error' (RST/timeout). All three
    // route to the same eviction so the Set never accumulates stale entries
    // under any disconnect path.
    const cleanup = (): void => this.evictClient(res);
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.socket?.once("error", cleanup);
  }

  private async serveAudit(res: http.ServerResponse, url: URL): Promise<void> {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 500);
    const events = await this.audit.tail(limit);
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ events: events.reverse() }));
  }

  private async serveMemory(res: http.ServerResponse): Promise<void> {
    const list = await this.memory.list();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ entries: list }));
  }

  private async serveBacklog(res: http.ServerResponse): Promise<void> {
    const list = await this.backlog.list();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ goals: list }));
  }

  private async servePost(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    // CSRF: header must match the token we minted at boot and echoed to /.
    // Timing-safe comparison is overkill for a localhost-only server, but
    // it's a one-liner with `crypto.timingSafeEqual` and removes the
    // category from the security argument entirely.
    const provided = req.headers["x-orql-csrf"];
    if (typeof provided !== "string" || !this.csrfMatches(provided)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "csrf" }));
      return;
    }

    const body = await readJsonBody(req).catch(() => ({}));

    if (url.pathname === "/api/autopilot/pause") {
      if (!this.opts.onPauseAutopilot) return notImplemented(res);
      await this.opts.onPauseAutopilot();
      return ok(res);
    }
    if (url.pathname === "/api/autopilot/resume") {
      if (!this.opts.onResumeAutopilot) return notImplemented(res);
      await this.opts.onResumeAutopilot();
      return ok(res);
    }
    const planStop = url.pathname.match(/^\/api\/plan\/([^/]+)\/stop$/);
    if (planStop) {
      if (!this.opts.onStopPlan) return notImplemented(res);
      await this.opts.onStopPlan(planStop[1]!, (body as any).reason);
      return ok(res);
    }
    const taskKill = url.pathname.match(/^\/api\/plan\/([^/]+)\/task\/([^/]+)\/kill$/);
    if (taskKill) {
      if (!this.opts.onKillTask) return notImplemented(res);
      await this.opts.onKillTask(taskKill[1]!, taskKill[2]!);
      return ok(res);
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no such endpoint" }));
  }
}

function ok(res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

function notImplemented(res: http.ServerResponse): void {
  res.writeHead(501, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "control handler not wired in this build" }));
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 256 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function describeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  for (const k of ["file_path", "path", "command", "url", "pattern", "query"]) {
    if (typeof obj[k] === "string") return `(${truncate(obj[k] as string, 60)})`;
  }
  return "";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// ---------------------------------------------------------------------------
// The dashboard HTML. Single string so the binary is self-contained — no
// asset directory to ship. Dark theme, no external deps, vanilla JS.
// ---------------------------------------------------------------------------

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>orqlaude — fleet dashboard</title>
<style>
  :root {
    --bg: #0d0e10;
    --bg-elev: #15171b;
    --bg-elev-2: #1d2027;
    --border: #2a2e36;
    --fg: #e6e7e9;
    --fg-dim: #8b909a;
    --fg-faint: #555a64;
    --coral: #ff7a6b;
    --sand: #e8c69a;
    --green: #6acb9f;
    --amber: #f0b955;
    --red: #ff5d57;
    --blue: #71a1ff;
    --mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
  header {
    position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; gap: 16px;
    padding: 12px 20px; border-bottom: 1px solid var(--border);
    background: rgba(13,14,16,0.92); backdrop-filter: blur(10px);
  }
  header .brand { font-weight: 600; letter-spacing: 0.5px; }
  header .brand .dot { color: var(--coral); }
  header .stats { display: flex; gap: 18px; flex: 1; flex-wrap: wrap; }
  header .stat { display: flex; flex-direction: column; }
  header .stat .label { color: var(--fg-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; }
  header .stat .value { font-family: var(--mono); font-size: 15px; }
  header .stat .value.warn { color: var(--amber); }
  header .stat .value.bad { color: var(--red); }
  header .stat .value.good { color: var(--green); }
  header .conn { font-family: var(--mono); font-size: 12px; color: var(--fg-dim); }
  header .conn.live::before { content: '●'; color: var(--green); margin-right: 6px; animation: pulse 2s infinite; }
  header .conn.stale::before { content: '●'; color: var(--amber); margin-right: 6px; }
  header .conn.down::before { content: '●'; color: var(--red); margin-right: 6px; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  header .filter { background: var(--bg-elev-2); border: 1px solid var(--border); color: var(--fg); padding: 4px 10px; border-radius: 4px; font-family: var(--mono); font-size: 12px; width: 160px; outline: none; }
  header .filter:focus { border-color: var(--coral); }
  header kbd { font-family: var(--mono); font-size: 10px; padding: 1px 5px; border-radius: 3px; background: var(--bg-elev-2); border: 1px solid var(--border); color: var(--fg-dim); }

  main { display: grid; grid-template-columns: minmax(0,1fr) 380px; gap: 16px; padding: 16px 20px; }
  @media (max-width: 1000px) { main { grid-template-columns: 1fr; } }
  section.card { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  section.card > h2 { margin: 0; padding: 10px 14px; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--fg-dim); border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
  section.card > h2 .count { font-family: var(--mono); color: var(--fg); }

  .plans { display: flex; flex-direction: column; gap: 12px; }
  .plan { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px; }
  .plan-head { padding: 12px 14px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid var(--border); cursor: pointer; }
  .plan-head:hover { background: var(--bg-elev-2); }
  .plan-head .badge { font-family: var(--mono); font-size: 11px; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--border); color: var(--fg-dim); }
  .plan-head .badge.running { color: var(--coral); border-color: var(--coral); }
  .plan-head .badge.done { color: var(--green); border-color: var(--green); }
  .plan-head .badge.failed, .plan-head .badge.cancelled, .plan-head .badge.cancelled_overbudget { color: var(--red); border-color: var(--red); }
  .plan-head .title { flex: 1; font-weight: 500; }
  .plan-head .id { font-family: var(--mono); font-size: 11px; color: var(--fg-faint); }
  .plan-head .meter { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; min-width: 180px; }
  .plan-head .meter .nums { font-family: var(--mono); font-size: 11px; color: var(--fg-dim); }
  .plan-head .meter .bar { width: 180px; height: 4px; background: var(--bg-elev-2); border-radius: 2px; overflow: hidden; }
  .plan-head .meter .bar > span { display: block; height: 100%; background: linear-gradient(90deg, var(--green), var(--coral)); transition: width 0.4s ease; }
  .plan-head .meter .bar > span.over { background: var(--red); }
  .plan-actions { display: flex; gap: 6px; }
  .plan-actions button { background: transparent; border: 1px solid var(--border); color: var(--fg-dim); padding: 4px 10px; border-radius: 4px; font-size: 12px; cursor: pointer; }
  .plan-actions button:hover { color: var(--red); border-color: var(--red); }

  .tasks { display: none; padding: 8px; gap: 6px; flex-direction: column; }
  .plan.open .tasks { display: flex; }
  .task { padding: 10px 12px; background: var(--bg-elev-2); border-radius: 6px; border: 1px solid transparent; }
  .task.active { border-color: var(--coral); }
  .task-head { display: flex; align-items: center; gap: 10px; }
  .task-head .name { font-weight: 500; }
  .task-head .agnet { color: var(--sand); font-family: var(--mono); font-size: 11px; }
  .task-head .badge { font-family: var(--mono); font-size: 10px; padding: 1px 6px; border-radius: 3px; background: var(--bg); color: var(--fg-dim); border: 1px solid var(--border); }
  .task-head .badge.running { color: var(--coral); border-color: var(--coral); }
  .task-head .badge.done { color: var(--green); border-color: var(--green); }
  .task-head .badge.failed, .task-head .badge.cancelled, .task-head .badge.died_at_launch { color: var(--red); border-color: var(--red); }
  .task-head .spacer { flex: 1; }
  .task-head .tokens { font-family: var(--mono); font-size: 11px; color: var(--fg-dim); }
  .task-head .cost { font-family: var(--mono); font-size: 11px; color: var(--sand); }
  .task-head button { background: transparent; border: 1px solid var(--border); color: var(--fg-faint); padding: 2px 8px; border-radius: 3px; font-size: 11px; cursor: pointer; }
  .task-head button:hover { color: var(--red); border-color: var(--red); }
  .task .last { margin-top: 6px; font-family: var(--mono); font-size: 11px; color: var(--fg-dim); white-space: pre-wrap; word-break: break-word; max-height: 80px; overflow: hidden; position: relative; }
  .task .last::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 18px; background: linear-gradient(to bottom, transparent, var(--bg-elev-2)); }
  .task .meta { margin-top: 6px; display: flex; gap: 12px; font-size: 11px; color: var(--fg-faint); font-family: var(--mono); }
  .task .pr a { color: var(--blue); text-decoration: none; }

  .activity { max-height: 70vh; overflow-y: auto; }
  .activity ul { list-style: none; margin: 0; padding: 0; }
  .activity li { padding: 8px 14px; border-bottom: 1px solid var(--border); font-size: 12px; }
  .activity li:last-child { border-bottom: 0; }
  .activity li .when { font-family: var(--mono); color: var(--fg-faint); font-size: 10px; }
  .activity li .tool { color: var(--sand); font-family: var(--mono); font-size: 11px; }
  .activity li .summary { color: var(--fg-dim); margin-top: 2px; }
  .activity li.err .tool { color: var(--red); }

  .empty { padding: 28px 16px; text-align: center; color: var(--fg-faint); font-size: 12px; }
  .empty .icon { font-size: 24px; opacity: 0.5; }
  .empty .cta { display: inline-block; margin-top: 10px; padding: 6px 12px; background: var(--bg-elev-2); border: 1px solid var(--border); border-radius: 4px; color: var(--sand); font-family: var(--mono); font-size: 11px; }

  .help-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.65); backdrop-filter: blur(4px); display: none; align-items: center; justify-content: center; z-index: 100; }
  .help-overlay.show { display: flex; }
  .help-panel { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px; padding: 24px 32px; min-width: 360px; max-width: 520px; }
  .help-panel h3 { margin: 0 0 14px 0; color: var(--coral); font-size: 13px; text-transform: uppercase; letter-spacing: 1px; }
  .help-panel table { width: 100%; border-collapse: collapse; }
  .help-panel td { padding: 5px 0; font-size: 13px; color: var(--fg); }
  .help-panel td:first-child { width: 110px; }

  .copy-id { cursor: pointer; transition: color 0.15s; }
  .copy-id:hover { color: var(--coral); }

  .conn-down-overlay { position: fixed; top: 56px; left: 50%; transform: translateX(-50%); background: var(--bg-elev-2); border: 1px solid var(--amber); padding: 8px 16px; border-radius: 6px; font-size: 12px; color: var(--amber); display: none; z-index: 50; }
  .conn-down-overlay.show { display: block; }

  .toast { position: fixed; bottom: 16px; right: 16px; background: var(--bg-elev-2); border: 1px solid var(--border); border-left-width: 3px; padding: 8px 14px; border-radius: 4px; font-size: 12px; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
  .toast.show { opacity: 1; }
  .toast.ok { border-left-color: var(--green); }
  .toast.err { border-left-color: var(--red); }
</style>
</head>
<body>
<header>
  <div class="brand"><span class="dot">●</span> orqlaude</div>
  <div class="stats">
    <div class="stat"><div class="label">Plans</div><div class="value" id="stat-plans">—</div></div>
    <div class="stat"><div class="label">Agnets</div><div class="value" id="stat-agnets">—</div></div>
    <div class="stat"><div class="label">Tokens</div><div class="value" id="stat-tokens">—</div></div>
    <div class="stat"><div class="label">Cost</div><div class="value" id="stat-cost">—</div></div>
    <div class="stat"><div class="label">Backlog</div><div class="value" id="stat-backlog">—</div></div>
    <div class="stat"><div class="label">Memory</div><div class="value" id="stat-memory">—</div></div>
  </div>
  <input class="filter" id="filter" type="search" placeholder="filter…  /" autocomplete="off" spellcheck="false" />
  <div class="conn down" id="conn">connecting…</div>
  <kbd>?</kbd>
</header>
<div class="conn-down-overlay" id="conn-down-overlay">⚠ live updates paused — server unreachable. retrying…</div>
<main>
  <div class="plans" id="plans">
    <div class="empty"><div class="icon">⊙</div><div>waiting for first snapshot…</div></div>
  </div>
  <section class="card activity">
    <h2>Activity <span class="count" id="audit-count">0</span></h2>
    <ul id="audit"></ul>
  </section>
</main>
<div class="toast" id="toast"></div>

<div class="help-overlay" id="help">
  <div class="help-panel">
    <h3>Keyboard shortcuts</h3>
    <table>
      <tr><td><kbd>/</kbd></td><td>focus filter</td></tr>
      <tr><td><kbd>esc</kbd></td><td>clear filter / close this panel</td></tr>
      <tr><td><kbd>e</kbd></td><td>expand all plans</td></tr>
      <tr><td><kbd>c</kbd></td><td>collapse all plans</td></tr>
      <tr><td><kbd>r</kbd></td><td>force reconnect</td></tr>
      <tr><td><kbd>?</kbd></td><td>toggle this help</td></tr>
    </table>
    <p style="margin-top:14px;color:var(--fg-dim);font-size:12px">Click a plan-id to copy it to your clipboard.</p>
  </div>
</div>

<script>
(function () {
  const CSRF = '__CSRF_TOKEN__';
  const $ = (id) => document.getElementById(id);

  // Safe localStorage — private/incognito modes throw on access.
  const safeStore = {
    get(key, fallback) {
      try { const v = window.localStorage.getItem(key); return v == null ? fallback : v; }
      catch { return fallback; }
    },
    set(key, val) {
      try { window.localStorage.setItem(key, val); } catch { /* private mode */ }
    },
  };

  let openPlans;
  try { openPlans = new Set(JSON.parse(safeStore.get('orql.openPlans', '[]'))); }
  catch { openPlans = new Set(); }

  let lastSeen = 0;
  let filterText = '';
  let lastSnapshot = null;
  let es = null;

  const fmtTokens = (n) => {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (n/1000).toFixed(1) + 'k';
    return (n/1_000_000).toFixed(2) + 'M';
  };
  const fmtCost = (n) => '$' + n.toFixed(n < 1 ? 3 : 2);
  const fmtAgo = (ts) => {
    const d = Date.now() - ts;
    if (d < 1000) return 'just now';
    if (d < 60_000) return Math.floor(d/1000) + 's ago';
    if (d < 3_600_000) return Math.floor(d/60_000) + 'm ago';
    if (d < 86_400_000) return Math.floor(d/3_600_000) + 'h ago';
    return Math.floor(d/86_400_000) + 'd ago';
  };

  function toast(msg, kind) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show ' + (kind || '');
    clearTimeout(toast._h);
    toast._h = setTimeout(() => { t.className = 'toast'; }, 2200);
  }

  async function post(url, body) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-orql-csrf': CSRF },
        body: JSON.stringify(body || {}),
      });
      if (!r.ok) {
        const text = await r.text();
        toast('Action failed: ' + text.slice(0, 80), 'err');
        return null;
      }
      toast('OK', 'ok');
      return await r.json();
    } catch (err) {
      toast('Network error', 'err');
      return null;
    }
  }

  function renderStats(d) {
    $('stat-plans').textContent = String(d.plans.length);
    const ag = d.totals.agnetsActive + ' / ' + d.totals.agnetsTotal;
    const agnetsEl = $('stat-agnets');
    agnetsEl.textContent = ag;
    agnetsEl.className = 'value ' + (d.totals.agnetsActive > 0 ? 'good' : '');
    $('stat-tokens').textContent = fmtTokens(d.totals.tokens);
    $('stat-cost').textContent = fmtCost(d.totals.costUsd);
    $('stat-backlog').textContent = d.backlog.queued + ' / ' + (d.backlog.queued + d.backlog.running + d.backlog.done);
    $('stat-memory').textContent = String(d.memory.total);
  }

  // Free-text filter. Matches against plan + task titles, agnet names,
  // statuses, and the short id. Case-insensitive.
  function planMatches(p, q) {
    if (!q) return true;
    const hay = (
      p.shortId + ' ' + (p.rootTask || '') + ' ' + p.status + ' ' +
      p.tasks.map(t => (t.title || '') + ' ' + (t.agnetName || '') + ' ' + t.status + ' ' + t.shortId).join(' ')
    ).toLowerCase();
    return hay.includes(q);
  }

  function renderPlans(plans) {
    const root = $('plans');
    const q = filterText.trim().toLowerCase();
    const visible = q ? plans.filter(p => planMatches(p, q)) : plans;
    if (!plans.length) {
      root.innerHTML = '<div class="empty"><div class="icon">∅</div><div>no plans yet</div>' +
        '<div style="margin-top:6px">spawn a fleet from your editor, or:</div>' +
        '<a class="cta">orql goal new audit-sweep</a></div>';
      return;
    }
    if (!visible.length) {
      root.innerHTML = '<div class="empty"><div class="icon">⌕</div><div>no plans match "' + escapeHtml(filterText) + '"</div></div>';
      return;
    }
    // diff-render — keep DOM nodes for already-rendered plans so the user's
    // scroll position and expand state don't reset every tick.
    const existing = new Map();
    for (const node of root.querySelectorAll('.plan')) existing.set(node.dataset.planId, node);
    const out = document.createDocumentFragment();
    for (const p of visible) {
      const node = existing.get(p.id) || document.createElement('div');
      node.className = 'plan' + (openPlans.has(p.id) ? ' open' : '');
      node.dataset.planId = p.id;
      const pct = p.budgetCapTokens > 0 ? Math.min(100, (p.tokensUsed / p.budgetCapTokens) * 100) : 0;
      const over = pct > 95;
      node.innerHTML = \`
        <div class="plan-head">
          <span class="badge \${escapeHtml(p.status)}">\${escapeHtml(p.status)}</span>
          <span class="title">\${escapeHtml(p.rootTask || '(no description)')}</span>
          <span class="id copy-id" title="click to copy" data-copy="\${escapeAttr(p.id)}">\${escapeHtml(p.shortId)}</span>
          <div class="meter">
            <div class="nums">\${fmtTokens(p.tokensUsed)} / \${fmtTokens(p.budgetCapTokens)} · \${fmtCost(p.costUsd)}</div>
            <div class="bar"><span class="\${over ? 'over' : ''}" style="width: \${pct.toFixed(1)}%"></span></div>
          </div>
          <div class="plan-actions"><button data-stop="\${escapeAttr(p.id)}">stop</button></div>
        </div>
        <div class="tasks">\${p.tasks.map((t) => taskHtml(t, p.id)).join('')}</div>
      \`;
      out.appendChild(node);
    }
    root.replaceChildren(out);
  }

  function taskHtml(t, planId) {
    const isActive = t.status === 'running' || t.status === 'dispatched';
    const safeLast = escapeHtml(t.lastAssistantText || t.lastToolUse || '(no recent output)');
    const killBtn = isActive
      ? '<button data-kill-task="' + escapeAttr(t.id) + '" data-kill-plan="' + escapeAttr(planId) + '">kill</button>'
      : '';
    return \`
      <div class="task \${isActive ? 'active' : ''}" data-task-id="\${escapeAttr(t.id)}">
        <div class="task-head">
          <span class="agnet">\${escapeHtml(t.agnetName || t.shortId)}</span>
          <span class="badge \${escapeHtml(t.status)}">\${escapeHtml(t.status)}</span>
          <span class="name">\${escapeHtml(t.title)}</span>
          <span class="spacer"></span>
          <span class="tokens">\${fmtTokens(t.tokensUsed)} tok</span>
          <span class="cost">\${fmtCost(t.costUsd)}</span>
          \${killBtn}
        </div>
        <div class="last">\${safeLast}</div>
        <div class="meta">
          \${t.worktreePath ? '<span>📁 ' + escapeHtml(t.worktreePath.split('/').slice(-2).join('/')) + '</span>' : ''}
          \${t.prUrl ? '<span class="pr">🔗 <a href="' + escapeAttr(t.prUrl) + '" target="_blank" rel="noopener noreferrer">PR</a></span>' : ''}
          \${t.stopRequested ? '<span style="color:var(--amber)">⚠ stop requested</span>' : ''}
        </div>
      </div>
    \`;
  }

  function renderAudit(events) {
    const ul = $('audit');
    $('audit-count').textContent = String(events.length);
    ul.innerHTML = events.slice(0, 60).map((e) => \`
      <li class="\${e.ok ? '' : 'err'}">
        <div><span class="tool">\${escapeHtml(e.tool)}</span> <span class="when">\${fmtAgo(e.ts)}</span></div>
        <div class="summary">\${escapeHtml(e.resultSummary || e.error || '')}</div>
      </li>
    \`).join('');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  document.addEventListener('click', async (ev) => {
    const head = ev.target.closest('.plan-head');
    const planEl = ev.target.closest('.plan');

    // Copy plan-id to clipboard.
    const copyEl = ev.target.closest('[data-copy]');
    if (copyEl) {
      ev.stopPropagation();
      const text = copyEl.dataset.copy;
      try {
        await navigator.clipboard.writeText(text);
        toast('copied: ' + text.slice(0, 8) + '…', 'ok');
      } catch {
        toast('clipboard blocked', 'err');
      }
      return;
    }

    // Plan-head click (excluding buttons + copy-id) toggles expand.
    if (head && !ev.target.closest('button') && !ev.target.closest('[data-copy]')) {
      const id = planEl.dataset.planId;
      if (openPlans.has(id)) openPlans.delete(id); else openPlans.add(id);
      safeStore.set('orql.openPlans', JSON.stringify([...openPlans]));
      planEl.classList.toggle('open');
      return;
    }
    const stopId = ev.target.dataset && ev.target.dataset.stop;
    if (stopId) {
      if (!confirm('Stop plan ' + stopId.slice(0,8) + '? Agnets will be asked to commit and exit.')) return;
      await post('/api/plan/' + stopId + '/stop', { reason: 'user via web' });
      return;
    }
    const killTask = ev.target.dataset && ev.target.dataset.killTask;
    if (killTask) {
      const pl = ev.target.dataset.killPlan || (planEl && planEl.dataset.planId);
      if (!pl) return;
      if (!confirm('Kill task ' + killTask.slice(0,8) + '? This is a hard SIGKILL.')) return;
      await post('/api/plan/' + pl + '/task/' + killTask + '/kill', {});
      return;
    }
  });

  // Keyboard shortcuts. Disabled when typing in an input (so '/' in the
  // filter doesn't trigger anything weird).
  document.addEventListener('keydown', (ev) => {
    const inInput = ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA');
    if (ev.key === '?' && !inInput) { toggleHelp(); ev.preventDefault(); return; }
    if (ev.key === 'Escape') {
      if ($('help').classList.contains('show')) { toggleHelp(false); return; }
      if (inInput) { ev.target.blur(); $('filter').value = ''; filterText = ''; renderIfHaveData(); return; }
    }
    if (inInput) return;
    if (ev.key === '/') { $('filter').focus(); ev.preventDefault(); return; }
    if (ev.key === 'e') {
      if (!lastSnapshot) return;
      for (const p of lastSnapshot.plans) openPlans.add(p.id);
      safeStore.set('orql.openPlans', JSON.stringify([...openPlans]));
      renderIfHaveData();
      return;
    }
    if (ev.key === 'c') {
      openPlans.clear();
      safeStore.set('orql.openPlans', '[]');
      renderIfHaveData();
      return;
    }
    if (ev.key === 'r') {
      if (es) { es.close(); es = null; }
      setConn('down');
      connect();
      toast('reconnecting…', 'ok');
      return;
    }
  });

  function toggleHelp(forceState) {
    const el = $('help');
    const next = forceState !== undefined ? forceState : !el.classList.contains('show');
    el.classList.toggle('show', next);
  }

  // Filter input wiring with input-debouncing built into requestAnimationFrame.
  $('filter').addEventListener('input', (ev) => {
    filterText = ev.target.value || '';
    renderIfHaveData();
  });
  // Click outside help panel to dismiss.
  $('help').addEventListener('click', (ev) => { if (ev.target.id === 'help') toggleHelp(false); });

  function renderIfHaveData() {
    if (!lastSnapshot) return;
    for (const p of lastSnapshot.plans) for (const t of p.tasks) t._planId = p.id;
    renderPlans(lastSnapshot.plans);
  }

  function setConn(state) {
    const c = $('conn');
    c.className = 'conn ' + state;
    c.textContent = state === 'live' ? 'live' : state === 'stale' ? 'reconnecting…' : 'offline';
    $('conn-down-overlay').classList.toggle('show', state === 'down');
  }

  function applySnapshot(d) {
    lastSeen = Date.now();
    lastSnapshot = d;
    setConn('live');
    renderStats(d);
    // pass plan-id down to task buttons for kill flow
    for (const p of d.plans) for (const t of p.tasks) t._planId = p.id;
    renderPlans(d.plans);
    renderAudit(d.audit);
    // Reflect plan count in document title so the user can tell from a
    // backgrounded tab whether anything is in flight.
    document.title = (d.totals.agnetsActive > 0 ? '● ' : '') +
      'orqlaude — ' + d.totals.agnetsActive + '/' + d.totals.agnetsTotal + ' agnets';
  }

  function connect() {
    es = new EventSource('/api/events');
    es.addEventListener('snapshot', (ev) => {
      try { applySnapshot(JSON.parse(ev.data)); } catch (err) { console.error(err); }
    });
    es.addEventListener('hello', () => setConn('live'));
    // EventSource auto-reconnects on its own; we just reflect the state.
    es.onerror = () => setConn(lastSeen ? 'stale' : 'down');
  }

  // freshness watchdog — if SSE goes dark for >5s, mark stale; >15s, mark down.
  setInterval(() => {
    if (!lastSeen) return;
    const age = Date.now() - lastSeen;
    if (age > 15000) setConn('down');
    else if (age > 5000) setConn('stale');
  }, 1500);

  // Close the SSE connection cleanly when the user closes the tab — this
  // lets the server fire its 'close' eviction immediately rather than
  // waiting for a keep-alive timeout. Best-effort; some browsers fire
  // pagehide instead of beforeunload (mobile Safari).
  ['beforeunload', 'pagehide'].forEach((ev) => {
    window.addEventListener(ev, () => { if (es) try { es.close(); } catch {} });
  });

  connect();
})();
</script>
</body>
</html>
`;
