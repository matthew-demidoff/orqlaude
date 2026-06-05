import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { WebServer } from "../lib/web_server.js";
import { StateStore, findPlan } from "../lib/state.js";
import { VERSION } from "../lib/version.js";

/**
 * `orql web [--port N] [--no-open]` — boot the local dashboard server.
 *
 * Defaults to port 7777. If that port is in use, scans up to 7799 looking
 * for a free one rather than crashing — the typical pain case is "I already
 * have a dashboard open in another tab" and we'd rather politely take the
 * next port than make the user kill processes.
 *
 * Opens the system browser automatically unless --no-open is passed (useful
 * for CI/remote where there is no browser).
 */

export interface WebCliOpts {
  stateDir: string;
  port?: number;
  open?: boolean;
  host?: string;
}

const DEFAULT_PORT = 7777;
const MAX_PORT_SCAN = 22;

export async function runWeb(opts: WebCliOpts): Promise<void> {
  process.env.ORQLAUDE_VERSION = VERSION;
  const requestedPort = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? "127.0.0.1";

  const stateStore = new StateStore(opts.stateDir);
  const pauseFile = path.join(opts.stateDir, "autopilot.paused");

  let server: WebServer | null = null;
  let lastError: Error | null = null;
  for (let p = requestedPort; p < requestedPort + MAX_PORT_SCAN; p++) {
    try {
      server = new WebServer({
        stateDir: opts.stateDir,
        port: p,
        host,
        // Wire control hooks against the live state store. These are best-
        // effort: the autopilot daemon is the actual executor of stop/kill
        // semantics; here we just flip flags it will see on its next tick.
        onPauseAutopilot: async () => {
          await fs.writeFile(pauseFile, `web_at_${Date.now()}\n`);
        },
        onResumeAutopilot: async () => {
          await fs.unlink(pauseFile).catch(() => {});
        },
        onStopPlan: async (planId, reason) => {
          await stateStore.update((s) => {
            const plan = findPlan(s, planId);
            if (plan.status === "running" || plan.status === "dispatching" || plan.status === "approved") {
              plan.status = "cancelled";
            }
            for (const t of plan.tasks) {
              if (t.spawnedSessionId && !t.stopRequested) {
                t.stopRequested = {
                  reason: reason || "stopped from web dashboard",
                  requestedAt: Date.now(),
                  kind: "soft",
                };
              }
            }
          });
        },
        onKillTask: async (planId, taskId) => {
          await stateStore.update((s) => {
            const plan = findPlan(s, planId);
            const task = plan.tasks.find((t) => t.id === taskId);
            if (!task) return;
            task.stopRequested = {
              reason: "killed from web dashboard",
              requestedAt: Date.now(),
              kind: "hard",
            };
            // If we have the child PID, fire SIGKILL directly. Best-effort.
            if (task.pid) {
              try { process.kill(task.pid, "SIGKILL"); } catch { /* already dead */ }
            }
          });
        },
      });
      const { url } = await server.start();
      lastError = null;
      process.stdout.write(
        `\norqlaude dashboard live\n  ${url}\n  state-dir: ${opts.stateDir}\n  csrf-token: ${server.csrfToken}\n\n` +
        `press ctrl-c to stop\n\n`
      );
      if (opts.open !== false) openBrowser(url);
      break;
    } catch (err: any) {
      lastError = err;
      if (err.code !== "EADDRINUSE") throw err;
      // try next port
    }
  }
  if (!server) {
    throw new Error(
      `could not bind any port in [${requestedPort}..${requestedPort + MAX_PORT_SCAN - 1}]: ${lastError?.message}`
    );
  }

  // Hold the process open until SIGINT/SIGTERM. The http server and the
  // SSE-broadcast setInterval keep the event loop alive on their own, but
  // we ALSO need runWeb itself to not resolve — otherwise the caller in
  // main() would return its exit code and Node would tear down.
  await new Promise<void>((resolve) => {
    const shutdown = async (sig: string): Promise<void> => {
      process.stdout.write(`\n[orqlaude] received ${sig}, shutting down…\n`);
      try { await server!.stop(); } catch { /* ignore */ }
      resolve();
      // Give stdout a tick to flush, then exit cleanly.
      setImmediate(() => process.exit(0));
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  });
}

/** Best-effort browser open. Doesn't await — fire-and-forget. */
function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open"; args = [url];
  } else if (platform === "win32") {
    cmd = "cmd"; args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open"; args = [url];
  }
  try {
    const proc = spawn(cmd, args, { detached: true, stdio: "ignore" });
    proc.unref();
  } catch {
    /* user can just click the printed URL */
  }
}
