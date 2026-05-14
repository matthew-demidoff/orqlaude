import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Read the tail of a Claude Code session JSONL and derive a status snapshot.
 *
 * Session files live at:
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 *
 * v0.2.0 optimization: per-session byte-offset cache. After the first full
 * read we remember where we stopped and only parse new bytes on subsequent
 * snapshots. This matters for long-running fleets where status() is polled
 * frequently against multi-MB JSONLs.
 *
 * The cache lives in-process; on MCP server restart it's rebuilt by re-reading
 * the file once. Cache hit reduces a `status()` call from O(filesize) to
 * O(new-bytes-only).
 */

export interface SessionSnapshot {
  exists: boolean;
  sessionId: string;
  jsonlPath: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalEffectiveTokens: number;
  lastEventType: string | null;
  lastActivityAt: number | null;
  lastAssistantText: string | null;
  lastToolUse: { name: string; input: unknown } | null;
  terminated: boolean;
  terminationReason: string | null;
}

interface CacheEntry {
  byteOffset: number;
  carry: string;          // partial last line not yet terminated by \n
  snap: SessionSnapshot;
}

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "";

export function encodeCwdForProjects(cwd: string): string {
  return cwd.replace(/[\/]/g, "-");
}

export function jsonlPathFor(cwd: string, sessionId: string): string {
  return path.join(HOME, ".claude", "projects", encodeCwdForProjects(cwd), `${sessionId}.jsonl`);
}

const cache = new Map<string, CacheEntry>(); // keyed by jsonlPath

function emptySnap(sessionId: string, jsonlPath: string): SessionSnapshot {
  return {
    exists: false,
    sessionId,
    jsonlPath,
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalEffectiveTokens: 0,
    lastEventType: null,
    lastActivityAt: null,
    lastAssistantText: null,
    lastToolUse: null,
    terminated: false,
    terminationReason: null,
  };
}

export async function snapshotSession(cwd: string, sessionId: string): Promise<SessionSnapshot> {
  const jsonlPath = jsonlPathFor(cwd, sessionId);

  let stat: { size: number };
  try {
    stat = await fs.stat(jsonlPath);
  } catch (err: any) {
    if (err.code === "ENOENT") return emptySnap(sessionId, jsonlPath);
    throw err;
  }

  let entry = cache.get(jsonlPath);

  // If the file shrank or rotated, reset.
  if (entry && entry.byteOffset > stat.size) {
    cache.delete(jsonlPath);
    entry = undefined;
  }

  if (entry && entry.byteOffset === stat.size) {
    return entry.snap; // no new data
  }

  // Read only the new bytes since last visit.
  const startOffset = entry?.byteOffset ?? 0;
  const carry = entry?.carry ?? "";
  const snap: SessionSnapshot = entry ? { ...entry.snap, exists: true } : { ...emptySnap(sessionId, jsonlPath), exists: true };

  const fh = await fs.open(jsonlPath, "r");
  try {
    const buf = Buffer.alloc(stat.size - startOffset);
    if (buf.byteLength > 0) {
      await fh.read({ buffer: buf, position: startOffset });
    }
    const text = carry + buf.toString("utf8");
    const lines = text.split("\n");
    // Last element may be a partial line.
    const newCarry = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let evt: any;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      applyEvent(snap, evt);
    }
    cache.set(jsonlPath, { byteOffset: stat.size, carry: newCarry, snap });
  } finally {
    await fh.close();
  }
  return snap;
}

function applyEvent(snap: SessionSnapshot, evt: any): void {
  snap.lastEventType = evt.type ?? snap.lastEventType;
  const ts = typeof evt.timestamp === "string" ? Date.parse(evt.timestamp) : undefined;
  if (ts && !Number.isNaN(ts)) snap.lastActivityAt = ts;

  const usage = evt.message?.usage ?? evt.usage;
  if (usage) {
    if (typeof usage.input_tokens === "number") snap.inputTokens += usage.input_tokens;
    if (typeof usage.output_tokens === "number") snap.outputTokens += usage.output_tokens;
    if (typeof usage.cache_read_input_tokens === "number") snap.cacheReadTokens += usage.cache_read_input_tokens;
    if (typeof usage.cache_creation_input_tokens === "number") snap.cacheCreationTokens += usage.cache_creation_input_tokens;
  }
  snap.totalEffectiveTokens =
    snap.inputTokens + snap.outputTokens + snap.cacheReadTokens + snap.cacheCreationTokens;

  if (typeof evt.total_cost_usd === "number") {
    snap.totalCostUsd = evt.total_cost_usd; // running total from result rows
  } else if (typeof evt.cost_usd === "number") {
    snap.totalCostUsd += evt.cost_usd;
  }

  if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
    for (const block of evt.message.content) {
      if (block.type === "text" && typeof block.text === "string") {
        snap.lastAssistantText = block.text.slice(0, 500);
      } else if (block.type === "tool_use") {
        snap.lastToolUse = { name: block.name, input: block.input };
      }
    }
  }

  if (evt.type === "result") {
    snap.terminated = true;
    snap.terminationReason = evt.subtype ?? evt.terminal_reason ?? "completed";
  }
}

/** For tests / forced refresh. */
export function clearTailCache(): void {
  cache.clear();
}
