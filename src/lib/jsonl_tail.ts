import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Read the tail of a Claude Code session event stream and derive a status
 * snapshot.
 *
 * TWO source files are supported:
 *   1. ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 *      Written by the Desktop app for sessions it hosts.
 *   2. <worktree>/.orqlaude.stdout.log
 *      Written by `spawn_via_cli` when it pipes `claude -p
 *      --output-format stream-json` to a file inside the spawned Agnet's
 *      worktree. The event format is identical (one JSON event per line);
 *      only the storage location differs.
 *
 * The caller MAY pass `stdoutPath` as a hint. The resolver prefers the
 * Desktop JSONL when present (canonical), and falls back to the stdout log
 * when the JSONL is missing and the stdout log exists. Without the hint,
 * only the JSONL is consulted - so for `spawn_via_cli` Agnets (which never
 * produce a JSONL), the caller MUST pass the hint or status reads will
 * always be empty. See `Task.stdoutPath` in state.ts.
 *
 * v0.2.0 optimization: per-session byte-offset cache. After the first full
 * read we remember where we stopped and only parse new bytes on subsequent
 * snapshots. This matters for long-running fleets where status() is polled
 * frequently against multi-MB streams.
 *
 * v0.9.0: the cache is keyed by RESOLVED path, not session id - so if the
 * resolver picks JSONL one call and stdout-log the next (e.g. when the
 * Desktop app starts writing mid-fleet), each path gets its own cache entry
 * and we don't double-count tokens.
 *
 * The cache lives in-process; on MCP server restart it's rebuilt by re-reading
 * the file once. Cache hit reduces a `status()` call from O(filesize) to
 * O(new-bytes-only).
 */

export interface SessionSnapshot {
  exists: boolean;
  sessionId: string;
  /** Canonical Desktop-app JSONL path (whether or not the file exists). */
  jsonlPath: string;
  /**
   * Which file we actually read from. Either `jsonlPath` (Desktop app) or
   * the `<worktree>/.orqlaude.stdout.log` passed in by the caller.
   * v0.9.0: surfaces the source so the orchestrator can distinguish
   * "Agnet never produced output" from "we didn't know where to look."
   */
  source: "jsonl" | "stdout_log" | "none";
  resolvedPath: string | null;
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
  /** v0.8.0: inode + mtime of the file when we last cached. If either has
   *  changed since, the cache is invalidated and we re-read from scratch.
   *  Defeats the same-size-truncation case where the file is rewritten
   *  with content of identical length but different content. */
  inode: number;
  mtimeMs: number;
  snap: SessionSnapshot;
}

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "";

export function encodeCwdForProjects(cwd: string): string {
  return cwd.replace(/[\/]/g, "-");
}

export function jsonlPathFor(cwd: string, sessionId: string): string {
  return path.join(HOME, ".claude", "projects", encodeCwdForProjects(cwd), `${sessionId}.jsonl`);
}

const cache = new Map<string, CacheEntry>(); // keyed by RESOLVED path

function emptySnap(sessionId: string, jsonlPath: string): SessionSnapshot {
  return {
    exists: false,
    sessionId,
    jsonlPath,
    source: "none",
    resolvedPath: null,
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

/**
 * Pick which stream file to tail. Prefer the canonical Desktop JSONL when it
 * exists; otherwise fall back to the spawn_via_cli stdout log when the
 * caller has it on hand.
 */
async function resolveStreamSource(
  jsonlPath: string,
  stdoutPath: string | undefined
): Promise<{ path: string; source: "jsonl" | "stdout_log" } | null> {
  try {
    await fs.access(jsonlPath);
    return { path: jsonlPath, source: "jsonl" };
  } catch {
    /* JSONL missing - try the stdout-log hint. */
  }
  if (stdoutPath) {
    try {
      await fs.access(stdoutPath);
      return { path: stdoutPath, source: "stdout_log" };
    } catch {
      /* both gone */
    }
  }
  return null;
}

export async function snapshotSession(
  cwd: string,
  sessionId: string,
  /**
   * Optional hint pointing at the `<worktree>/.orqlaude.stdout.log` file for
   * Agnets spawned via spawn_via_cli. When provided AND the canonical
   * Desktop JSONL does not exist, the resolver tails this file instead.
   *
   * v0.9.0: required for spawn_via_cli observability - the prior versions
   * always returned an empty snapshot for CLI-spawned Agnets because the
   * JSONL is never written.
   */
  stdoutPath?: string
): Promise<SessionSnapshot> {
  const jsonlPath = jsonlPathFor(cwd, sessionId);
  const resolved = await resolveStreamSource(jsonlPath, stdoutPath);
  if (!resolved) {
    // Neither file exists - empty snapshot.
    return emptySnap(sessionId, jsonlPath);
  }

  const { path: streamPath, source } = resolved;

  let stat: { size: number; ino: number; mtimeMs: number };
  try {
    stat = await fs.stat(streamPath);
  } catch (err: any) {
    if (err.code === "ENOENT") return emptySnap(sessionId, jsonlPath);
    throw err;
  }

  let entry = cache.get(streamPath);

  // v0.8.0: invalidate on inode change (file was replaced) OR mtime regression
  // (clock rewind or replace) OR file-shrank (truncate). Catches the same-size
  // truncation case the v0.2 cache missed.
  //
  // v0.9.3: also invalidate when the cached byteOffset already covers the
  // current size AND mtime has advanced. This catches the "unlink + recreate
  // with same size" case on Linux ext4/tmpfs, where the kernel readily
  // reuses the freed inode number for the immediately-created replacement -
  // so `entry.inode !== stat.ino` doesn't fire. macOS APFS doesn't reuse
  // inodes that aggressively, which is why the v0.8.0 test passed locally
  // on Mac but failed under the Linux CI runner. Append-during-growth is
  // unaffected because byteOffset < stat.size in that case (the size grew).
  if (
    entry &&
    (entry.byteOffset > stat.size ||
      entry.inode !== stat.ino ||
      entry.mtimeMs > stat.mtimeMs ||
      (entry.byteOffset === stat.size && entry.mtimeMs !== stat.mtimeMs))
  ) {
    cache.delete(streamPath);
    entry = undefined;
  }

  if (entry && entry.byteOffset === stat.size && entry.mtimeMs === stat.mtimeMs) {
    return entry.snap; // no new data
  }

  // Read only the new bytes since last visit.
  const startOffset = entry?.byteOffset ?? 0;
  const carry = entry?.carry ?? "";
  const snap: SessionSnapshot = entry
    ? { ...entry.snap, exists: true, source, resolvedPath: streamPath }
    : { ...emptySnap(sessionId, jsonlPath), exists: true, source, resolvedPath: streamPath };

  const fh = await fs.open(streamPath, "r");
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
    cache.set(streamPath, {
      byteOffset: stat.size,
      carry: newCarry,
      inode: stat.ino,
      mtimeMs: stat.mtimeMs,
      snap,
    });
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
