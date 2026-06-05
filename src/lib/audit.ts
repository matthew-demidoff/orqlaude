import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Append-only audit log. Every MCP tool invocation writes one line.
 *
 * Format: JSONL — each line is { ts, tool, args, result_summary, ok, error?, plan_id? }
 *
 * Why append-only and not part of the state file: the state file is small and
 * frequently rewritten (atomic temp+rename); folding audit events into it
 * would churn it constantly. The audit log is unbounded and naturally
 * line-oriented, so JSONL append is the right primitive.
 *
 * Inspect with: `tail -f .orqlaude/audit.jsonl | jq`
 */

export interface AuditEvent {
  ts: number;
  tool: string;
  args: unknown;
  ok: boolean;
  durationMs: number;
  resultSummary?: string;
  error?: string;
  planId?: string;
  sessionId?: string;
}

export class AuditLog {
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "audit.jsonl");
  }

  async append(evt: AuditEvent): Promise<void> {
    // Serialize writes to avoid interleaving from concurrent tool calls.
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.appendFile(this.filePath, JSON.stringify(evt) + "\n");
      } catch (err) {
        // Best-effort: never fail a tool call because audit logging failed.
        // The error message goes to stderr where MCP debug surfaces it.
        process.stderr.write(`[orqlaude audit] write failed: ${(err as Error).message}\n`);
      }
    });
    return this.writeQueue;
  }

  /**
   * Wrap a tool handler so every invocation is audited. Captures duration,
   * success/failure, and a short summary of the result.
   *
   * v0.10.2+: the wrapped handler may optionally accept a second `extra`
   * argument (the MCP SDK's RequestHandlerExtra: abort signal,
   * sendNotification, requestId, etc.). This is needed by long-running
   * tools like `ask_user` that send periodic progress notifications to
   * reset the MCP client's per-request timeout. The wrap forwards `extra`
   * through transparently. Older single-arg handlers (the vast majority)
   * remain compatible because their handler simply ignores the second arg.
   */
  wrap<TArgs extends Record<string, unknown>, TResult>(
    toolName: string,
    handler: (args: TArgs, extra?: unknown) => Promise<TResult>,
    extractIds?: (args: TArgs, result?: TResult) => { planId?: string; sessionId?: string }
  ): (args: TArgs, extra?: unknown) => Promise<TResult> {
    return async (args: TArgs, extra?: unknown) => {
      const started = Date.now();
      try {
        const result = await handler(args, extra);
        const ids = extractIds?.(args, result) ?? {};
        await this.append({
          ts: started,
          tool: toolName,
          args: redactSecrets(args),
          ok: true,
          durationMs: Date.now() - started,
          resultSummary: summarize(result),
          ...ids,
        });
        return result;
      } catch (err) {
        const ids = extractIds?.(args) ?? {};
        await this.append({
          ts: started,
          tool: toolName,
          args: redactSecrets(args),
          ok: false,
          durationMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
          ...ids,
        });
        throw err;
      }
    };
  }

  async tail(limit = 50): Promise<AuditEvent[]> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim());
      const sliced = lines.slice(-limit);
      let dropped = 0;
      const out: AuditEvent[] = [];
      for (const l of sliced) {
        try {
          out.push(JSON.parse(l) as AuditEvent);
        } catch {
          dropped += 1;
        }
      }
      if (dropped > 0) {
        // Surface partial corruption rather than silently shrinking the
        // window. Common cause: a writer was killed mid-line. The good
        // events are still returned; the user just gets a heads-up.
        process.stderr.write(
          `[orqlaude audit] dropped ${dropped} malformed line(s) from ${path.basename(this.filePath)}\n`
        );
      }
      return out;
    } catch (err: any) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
  }
}

// Sensitive field names — redacted in BOTH args and result text.
const SECRET_FIELDS = new Set([
  "approval_token",
  "botToken",
  "bot_token",
  "token",
  "apiKey",
  "api_key",
  "password",
  "secret",
]);

function summarize(result: unknown): string {
  // MCP tool results are typically { content: [{ type: "text", text: "..." }] }.
  // Extract the first text, scrub known secret fields, then truncate.
  try {
    const r = result as any;
    const text = r?.content?.[0]?.text;
    const raw = typeof text === "string" ? text : JSON.stringify(result);
    return scrubSecretsInText(raw).slice(0, 200);
  } catch {
    return String(result).slice(0, 200);
  }
}

/**
 * Strip values of known secret fields out of a JSON-like text blob. We can't
 * rely on a proper parse (the text may already be truncated), so we operate on
 * the textual representation with regex. This is best-effort defense in depth
 * — the canonical fix is to never put secrets in the user-facing content.text.
 */
function scrubSecretsInText(s: string): string {
  let out = s;
  for (const k of SECRET_FIELDS) {
    // JSON-shaped: "key": "value"  →  "key": "<redacted>"
    out = out.replace(new RegExp(`("${k}"\\s*:\\s*)"[^"]*"`, "g"), `$1"<redacted>"`);
    // YAML-ish (rare in our outputs but cheap to include): key: value
    out = out.replace(new RegExp(`(\\b${k}\\s*[:=]\\s*)\\S+`, "g"), `$1<redacted>`);
  }
  return out;
}

function redactSecrets(args: unknown): unknown {
  // Deep redaction: walk nested objects/arrays. Mutates a shallow copy.
  return walk(args);
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk);
  if (value && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      clone[k] = SECRET_FIELDS.has(k) ? "<redacted>" : walk(v);
    }
    return clone;
  }
  return value;
}
