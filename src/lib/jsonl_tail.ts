import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Read the tail of a Claude Code session JSONL and derive a status snapshot.
 *
 * Session files live at:
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 *
 * Each line is a JSON event. We care about:
 *   - the latest assistant message (current activity)
 *   - the latest tool_use (what's it doing right now)
 *   - cumulative cost (sum of `usage.cost_usd` or final `total_cost_usd` if present)
 *   - terminal events (success/error) — surfaced via top-level result rows
 *
 * The JSONL grows monotonically; we never seek backwards. For now we re-read
 * the file each time; if that becomes a perf issue we'll cache offsets.
 */

export interface SessionSnapshot {
  exists: boolean;
  sessionId: string;
  jsonlPath: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  lastEventType: string | null;
  lastActivityAt: number | null;
  lastAssistantText: string | null;
  lastToolUse: { name: string; input: unknown } | null;
  terminated: boolean;
  terminationReason: string | null;
}

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "";

/** Encode a CWD the same way Claude Code does for the projects directory name. */
export function encodeCwdForProjects(cwd: string): string {
  return cwd.replace(/[\/]/g, "-");
}

export function jsonlPathFor(cwd: string, sessionId: string): string {
  return path.join(HOME, ".claude", "projects", encodeCwdForProjects(cwd), `${sessionId}.jsonl`);
}

export async function snapshotSession(cwd: string, sessionId: string): Promise<SessionSnapshot> {
  const jsonlPath = jsonlPathFor(cwd, sessionId);
  const empty: SessionSnapshot = {
    exists: false,
    sessionId,
    jsonlPath,
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    lastEventType: null,
    lastActivityAt: null,
    lastAssistantText: null,
    lastToolUse: null,
    terminated: false,
    terminationReason: null,
  };

  let raw: string;
  try {
    raw = await fs.readFile(jsonlPath, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") return empty;
    throw err;
  }
  if (!raw.trim()) return empty;

  const snap: SessionSnapshot = { ...empty, exists: true };
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    snap.lastEventType = evt.type ?? snap.lastEventType;
    const ts = typeof evt.timestamp === "string" ? Date.parse(evt.timestamp) : undefined;
    if (ts && !Number.isNaN(ts)) snap.lastActivityAt = ts;

    // Cumulative usage. Stream-json emits `usage` chunks per assistant message.
    const usage = evt.message?.usage ?? evt.usage;
    if (usage) {
      if (typeof usage.input_tokens === "number") snap.inputTokens += usage.input_tokens;
      if (typeof usage.output_tokens === "number") snap.outputTokens += usage.output_tokens;
    }
    if (typeof evt.total_cost_usd === "number") {
      snap.totalCostUsd = evt.total_cost_usd; // result rows carry the running total
    } else if (typeof evt.cost_usd === "number") {
      snap.totalCostUsd += evt.cost_usd;
    }

    // Latest assistant text + tool use.
    if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
      for (const block of evt.message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          snap.lastAssistantText = block.text.slice(0, 500);
        } else if (block.type === "tool_use") {
          snap.lastToolUse = { name: block.name, input: block.input };
        }
      }
    }

    // Termination signals.
    if (evt.type === "result") {
      snap.terminated = true;
      snap.terminationReason = evt.subtype ?? evt.terminal_reason ?? "completed";
    }
  }
  return snap;
}
