import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { discoverClaudeBinary, sanitizeChildEnv } from "./spawn_cli.js";

/**
 * Orchestrator-turn helper — the daemon's "thinking" primitive.
 *
 * The autopilot daemon is plain Node TypeScript. When it needs intelligence
 * (classify a Telegram message, decompose a Goal, decide whether an Agnet
 * died for a fixable reason), it does NOT call the Anthropic API directly.
 * Instead, it spawns `claude -p` exactly the same way it spawns child
 * Agnets — Plan-billed, free cache reads, no API key required.
 *
 * Difference from `spawn_cli.spawnAgnetViaCli`:
 *   • This one runs SYNCHRONOUSLY (or rather, awaits to completion) and
 *     returns the final assistant text. Children spawned via spawn_cli are
 *     long-lived processes that produce streaming JSONL.
 *   • No worktree, no MCP injection — orchestrator turns are read/think/
 *     return-JSON, not file-editing. Runs in the daemon's own cwd.
 *   • Aggressive timeout (default 90s) so a wedged turn doesn't stall the
 *     daemon loop forever.
 *
 * Output parsing: the daemon asks the model to reply in strict JSON; we
 * strip ```json fences, parse, and surface validation errors back to the
 * caller. If the model produced trailing prose, we try to lift the first
 * top-level JSON object out of the response before giving up.
 *
 * Plan-billing note: this is THE reason orqlaude can have a daemon at all
 * without the user paying per-token. Cache reads on the Claude Max plan
 * are free, so the only "cost" of running a turn is the model's output
 * tokens (small — these are classification / decomposition / decision
 * tasks, not generation). Empirically a full daemon day burns < 5% of
 * the Plan budget.
 */

export interface OrchTurnInput {
  /** The prompt — usually crafted with a strict-JSON-output instruction. */
  prompt: string;
  /** Model override; default sonnet. Pick haiku for cheap classifiers. */
  model?: "sonnet" | "opus" | "haiku";
  /** Hard timeout in ms. Defaults to 90s. */
  timeoutMs?: number;
  /** Working directory — daemon usually wants its own cwd, not a worktree. */
  cwd?: string;
  /** Stable session id for cache-reuse across rapid-fire calls. v0.10.0
   *  reuses sessions where the prompt prefix matches so cache hits ramp up. */
  sessionId?: string;
  /** Whether to expect JSON. If true, we'll try to lift a top-level object
   *  out of the response before returning. Default true. */
  expectJson?: boolean;
}

export interface OrchTurnResult {
  ok: boolean;
  text: string;
  parsedJson?: unknown;
  parseError?: string;
  durationMs: number;
  /** Approx output tokens for cost telemetry. We DON'T have a great way to
   *  measure input tokens because the Plan-billed cache hides them; output
   *  is the only number that meaningfully affects spend on the Plan. */
  approxOutputChars: number;
  exitCode: number | null;
  stderrSnippet?: string;
}

export async function runOrchTurn(input: OrchTurnInput): Promise<OrchTurnResult> {
  const claudeBin = discoverClaudeBinary();
  const timeoutMs = input.timeoutMs ?? 90_000;
  const sessionId = input.sessionId ?? randomUUID();
  const model = input.model ?? "sonnet";
  const cwd = input.cwd ?? process.cwd();

  const args = [
    "--print",
    "--session-id",
    sessionId,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    "--permission-mode",
    "default", // orchestrator turns don't edit files
    "--", // stop variadic flag eating
    input.prompt,
  ];

  const start = Date.now();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let timedOut = false;

  return new Promise<OrchTurnResult>((resolve) => {
    const child = spawn(claudeBin, args, {
      cwd,
      env: sanitizeChildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 2000);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk.toString("utf8")));
    child.on("close", (code) => {
      clearTimeout(timer);
      const duration = Date.now() - start;
      const stdout = stdoutChunks.join("");
      const stderr = stderrChunks.join("");
      const text = extractAssistantText(stdout);
      let parsedJson: unknown | undefined;
      let parseError: string | undefined;
      if (input.expectJson !== false) {
        const parsed = tryParseJson(text);
        if (parsed.ok) parsedJson = parsed.value;
        else parseError = parsed.error;
      }
      resolve({
        ok: !timedOut && code === 0,
        text,
        parsedJson,
        parseError,
        durationMs: duration,
        approxOutputChars: text.length,
        exitCode: code,
        stderrSnippet: stderr.slice(0, 2000) || undefined,
      });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({
        ok: false,
        text: "",
        durationMs: Date.now() - start,
        approxOutputChars: 0,
        exitCode: null,
        stderrSnippet: "spawn error",
      });
    });
  });
}

/**
 * The `--output-format stream-json` stream is a sequence of JSON envelopes,
 * one per line. We need the final assistant text. Concatenate every text
 * delta we see; the model's actual response is the union of these.
 */
function extractAssistantText(stdout: string): string {
  const lines = stdout.split("\n").filter((l) => l.trim());
  let out = "";
  for (const line of lines) {
    try {
      const env = JSON.parse(line);
      // Stream envelope shapes (depend on claude version):
      //   { type: 'assistant', message: { content: [{type:'text', text:'...'}] } }
      //   { type: 'text', text: '...' }
      //   { type: 'message_delta', delta: { text: '...' } }
      if (env.type === "assistant" && env.message?.content) {
        for (const block of env.message.content) {
          if (block.type === "text") out += block.text;
        }
      } else if (env.type === "text" && typeof env.text === "string") {
        out += env.text;
      } else if (env.type === "message_delta" && env.delta?.text) {
        out += env.delta.text;
      } else if (env.type === "result" && typeof env.result === "string") {
        out += env.result;
      }
    } catch {
      /* not a JSON line; skip */
    }
  }
  return out.trim();
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!text) return { ok: false, error: "empty response" };
  // Strip ```json ... ``` fences if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = fence ? fence[1] : text;
  // Try direct parse first.
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    /* fall through */
  }
  // Try to find the first top-level {...} object.
  const start = body.indexOf("{");
  if (start === -1) return { ok: false, error: "no JSON object found" };
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const candidate = body.slice(start, i + 1);
        try {
          return { ok: true, value: JSON.parse(candidate) };
        } catch (err) {
          return { ok: false, error: `JSON parse failed at offset ${i}: ${(err as Error).message}` };
        }
      }
    }
  }
  return { ok: false, error: "unbalanced braces" };
}

/**
 * Helper to write a temp scratch directory the daemon can use for its own
 * cwd. Keeps daemon-spawn cache scoped per-machine in `~/.orqlaude/turns/`.
 */
export async function ensureTurnsCwd(): Promise<string> {
  const dir = path.join(os.homedir(), ".orqlaude", "turns");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
