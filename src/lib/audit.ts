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
   */
  wrap<TArgs extends Record<string, unknown>, TResult>(
    toolName: string,
    handler: (args: TArgs) => Promise<TResult>,
    extractIds?: (args: TArgs, result?: TResult) => { planId?: string; sessionId?: string }
  ): (args: TArgs) => Promise<TResult> {
    return async (args: TArgs) => {
      const started = Date.now();
      try {
        const result = await handler(args);
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
      return lines
        .slice(-limit)
        .map((l) => {
          try {
            return JSON.parse(l) as AuditEvent;
          } catch {
            return null;
          }
        })
        .filter((e): e is AuditEvent => e !== null);
    } catch (err: any) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
  }
}

function summarize(result: unknown): string {
  // MCP tool results are typically { content: [{ type: "text", text: "..." }] }.
  // Extract the first text and truncate.
  try {
    const r = result as any;
    const text = r?.content?.[0]?.text;
    if (typeof text === "string") return text.slice(0, 200);
    return JSON.stringify(result).slice(0, 200);
  } catch {
    return String(result).slice(0, 200);
  }
}

function redactSecrets(args: unknown): unknown {
  // Approval tokens are single-use, but we still don't want them sitting in
  // the audit log forever.
  if (args && typeof args === "object") {
    const clone: Record<string, unknown> = { ...(args as Record<string, unknown>) };
    if ("approval_token" in clone) clone.approval_token = "<redacted>";
    return clone;
  }
  return args;
}
