import { promises as fs } from "node:fs";
import path from "node:path";
import type { SessionSnapshot } from "./jsonl_tail.js";

/**
 * Hallucination detection for spawned agents.
 *
 * Two cheap deterministic checks, summed into a score. Higher score = more
 * concerning. The primary Claude is told the score in `status()` and can
 * decide whether to send a STOP message or just nudge.
 *
 * Check 1 — path-existence: scan recent tool_use entries for file paths
 *   (Read/Edit/Write inputs). If many reference paths that don't exist in the
 *   worktree, the agent is editing imaginary files.
 *
 * Check 2 — tool-pattern sanity:
 *   • commits without any prior Read on the file being edited
 *   • Write of a file that already exists (often an Edit-vs-Write mistake)
 *   • repeated identical tool calls (loop)
 *   • Edit failing repeatedly with "no match" (agent is guessing at the content)
 *
 * These are deliberately conservative. False positives are acceptable; we
 * surface concerns, we don't kill agents automatically.
 *
 * NOTE: a future iteration can add a Check 3 — second-model cross-validation:
 * periodically have a Haiku read the recent activity and flag suspect turns.
 * That costs tokens though, so it's opt-in.
 */

export interface HallucinationReport {
  score: number; // 0 (clean) to 1 (very concerning)
  level: "clean" | "minor" | "moderate" | "severe";
  concerns: string[];
}

interface ToolUseEvent {
  name: string;
  input: any;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "NotebookRead"]);

/**
 * Score a session by inspecting its full set of tool_use events (extracted by
 * the caller from the JSONL). cwd is the worktree root to check paths against.
 */
export async function detectHallucination(
  toolUses: ToolUseEvent[],
  cwd: string
): Promise<HallucinationReport> {
  const concerns: string[] = [];
  let score = 0;

  // ---- Check 1: path-existence ---------------------------------------------
  const referencedPaths = new Set<string>();
  for (const tu of toolUses) {
    const p = extractPathFromToolUse(tu);
    if (p) referencedPaths.add(p);
  }

  const missing: string[] = [];
  for (const p of referencedPaths) {
    if (!path.isAbsolute(p)) continue; // skip relative; we'd need worktree context
    if (!p.startsWith(cwd) && !p.startsWith("/tmp")) continue; // outside worktree, skip
    try {
      await fs.access(p);
    } catch {
      missing.push(p);
    }
  }
  if (missing.length > 0) {
    const ratio = missing.length / Math.max(1, referencedPaths.size);
    if (ratio > 0.3 || missing.length >= 3) {
      score += 0.4;
      concerns.push(
        `Referenced ${missing.length} path(s) that don't exist in the worktree: ${missing
          .slice(0, 3)
          .join(", ")}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ""}`
      );
    } else if (missing.length > 0) {
      score += 0.1;
      concerns.push(`Minor: ${missing.length} referenced path(s) missing — could be in-flight files.`);
    }
  }

  // ---- Check 2a: edit-without-prior-read -----------------------------------
  const editedWithoutRead: string[] = [];
  const readPaths = new Set<string>();
  for (const tu of toolUses) {
    if (READ_TOOLS.has(tu.name)) {
      const p = extractPathFromToolUse(tu);
      if (p) readPaths.add(p);
    } else if (EDIT_TOOLS.has(tu.name)) {
      const p = extractPathFromToolUse(tu);
      if (p && !readPaths.has(p) && tu.name !== "Write") {
        // Write is OK without read (new file). Edit/MultiEdit needs prior read.
        editedWithoutRead.push(p);
      }
    }
  }
  if (editedWithoutRead.length > 0) {
    score += 0.15;
    concerns.push(
      `Edited ${editedWithoutRead.length} file(s) without first reading them: ${editedWithoutRead
        .slice(0, 2)
        .join(", ")}. Agent may be guessing at file contents.`
    );
  }

  // ---- Check 2b: repeated identical tool calls (tight loop) ---------------
  const seen = new Map<string, number>();
  for (const tu of toolUses) {
    const key = JSON.stringify({ n: tu.name, i: tu.input });
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const maxRepeat = Math.max(0, ...seen.values());
  if (maxRepeat >= 4) {
    score += 0.2;
    concerns.push(`Repeated the same tool call ${maxRepeat} times — agent may be looping.`);
  } else if (maxRepeat === 3) {
    score += 0.05;
    concerns.push(`Repeated the same tool call 3 times — possible loop.`);
  }

  // ---- Check 2c: commit without testing ------------------------------------
  // Heuristic: look for `git commit` in Bash tool calls without any prior Bash
  // call that includes test/check/lint.
  const bashCmds = toolUses
    .filter((tu) => tu.name === "Bash")
    .map((tu) => String(tu.input?.command ?? ""));
  const committed = bashCmds.some((c) => /\bgit\s+commit\b/.test(c));
  const tested = bashCmds.some((c) =>
    /\b(npm\s+test|pytest|cargo\s+test|tsc|lint|check|jest|vitest|mocha)\b/.test(c)
  );
  if (committed && !tested) {
    score += 0.1;
    concerns.push(`Committed without running tests/typecheck. Worth verifying before merge.`);
  }

  return {
    score: Math.min(1, score),
    level: levelFromScore(score),
    concerns,
  };
}

function levelFromScore(s: number): HallucinationReport["level"] {
  if (s >= 0.6) return "severe";
  if (s >= 0.3) return "moderate";
  if (s >= 0.1) return "minor";
  return "clean";
}

function extractPathFromToolUse(tu: ToolUseEvent): string | null {
  const i = tu.input;
  if (!i || typeof i !== "object") return null;
  return (
    (typeof i.file_path === "string" && i.file_path) ||
    (typeof i.path === "string" && i.path) ||
    (typeof i.notebook_path === "string" && i.notebook_path) ||
    null
  );
}

/**
 * Extract all tool_use events from a JSONL-derived snapshot's raw lines.
 * The snapshot module currently only keeps the *last* tool_use; for
 * hallucination detection we need the full history. This re-reads the JSONL.
 */
export async function extractToolUses(jsonlPath: string): Promise<ToolUseEvent[]> {
  try {
    const raw = await fs.readFile(jsonlPath, "utf8");
    const out: ToolUseEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let evt: any;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
        for (const block of evt.message.content) {
          if (block.type === "tool_use") {
            out.push({ name: block.name, input: block.input });
          }
        }
      }
    }
    return out;
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

// Re-export for status() consumers.
export type { SessionSnapshot };
