import { promises as fs, watch, existsSync } from "node:fs";
import path from "node:path";
import { style } from "../lib/style.js";
import { AuditLog, type AuditEvent } from "../lib/audit.js";

/**
 * `orql tail` — live stream of audit log events.
 *
 * Prints existing events on start, then watches the file for appends and
 * renders new lines as they land. Colored by status (ok/err) + tool.
 */

export async function tailAudit(stateDir: string, planFilter?: string): Promise<number> {
  const auditPath = path.join(stateDir, "audit.jsonl");
  if (!existsSync(auditPath)) {
    process.stdout.write(style.sand("(no audit log yet; run an orqlaude tool first)\n"));
    return 0;
  }

  // Print existing tail (last 30 events).
  const audit = new AuditLog(stateDir);
  const existing = await audit.tail(30);
  for (const e of existing) {
    if (planFilter && e.planId && !e.planId.startsWith(planFilter)) continue;
    process.stdout.write(formatEvent(e));
  }

  // Watch for appends.
  let lastSize = (await fs.stat(auditPath)).size;
  process.stdout.write(style.dim(`\n(watching ${auditPath} — Ctrl-C to exit)\n`));
  const watcher = watch(auditPath, async () => {
    try {
      const stat = await fs.stat(auditPath);
      if (stat.size <= lastSize) return;
      const fh = await fs.open(auditPath, "r");
      try {
        const buf = Buffer.alloc(stat.size - lastSize);
        await fh.read({ buffer: buf, position: lastSize });
        const text = buf.toString("utf8");
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line) as AuditEvent;
            if (planFilter && evt.planId && !evt.planId.startsWith(planFilter)) continue;
            process.stdout.write(formatEvent(evt));
          } catch {
            /* malformed line; skip */
          }
        }
      } finally {
        await fh.close();
      }
      lastSize = stat.size;
    } catch {
      /* file rotated or transient error; recover next tick */
    }
  });

  return new Promise<number>((resolve) => {
    process.on("SIGINT", () => {
      watcher.close();
      process.stdout.write(style.dim("\n  goodbye.\n"));
      resolve(0);
    });
  });
}

function formatEvent(e: AuditEvent): string {
  const ts = style.dim(new Date(e.ts).toISOString().slice(11, 19));
  const status = e.ok ? style.coral("  ok") : style.crimson("ERR ");
  const tool = style.cream(e.tool.padEnd(22));
  const dur = style.dim(`${e.durationMs.toString().padStart(4)}ms`);
  const ids = e.planId
    ? style.sand(` plan=${e.planId.slice(0, 8)}`)
    : e.sessionId
    ? style.sand(` sess=${e.sessionId.slice(0, 8)}`)
    : "";
  const detail = e.resultSummary ? truncate(e.resultSummary, 80) : e.error ?? "";
  return `${ts}  ${status}  ${tool} ${dur}${ids}  ${detail}\n`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
