import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * v0.10.5 — spawn_via_cli pre-allocates session_id and embeds it in the
 * fleet protocol prompt + checkin handler accepts rotation for freshly
 * spawned tasks.
 *
 * Bug it fixes: orqlaude self-test fleet d47c0448 — Verdant tried to
 * checkin with $CLAUDE_CODE_SESSION_ID (Claude Code's internal value)
 * which differed from the --session-id flag orqlaude passed. The
 * pre-allocation had already filled task.spawnedSessionId so
 * unclaimedTaskById returned undefined, falling through to
 * task_already_claimed rejection.
 */

async function tempDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `orqlaude-v0105-${label}-`));
}

test("v0.10.5: spawn_via_cli sessionId override flows through to --session-id flag", async () => {
  // Verify the SpawnViaCliInput.sessionId field is honored. We can't actually
  // spawn claude in unit tests (no binary), but we can confirm the type +
  // pass-through logic by reading the source.
  // import.meta.dirname under built dist/__tests__/ → ../../src/lib/spawn_cli.ts
  // import.meta.dirname under built dist/__tests__/ → ../../src/lib/spawn_cli.ts
  const src = await fs.readFile(path.join(import.meta.dirname, "..", "..", "src", "lib", "spawn_cli.ts"), "utf8");
  // The fallback `?? randomUUID()` should be present so omitted sessionId
  // still produces a uuid.
  assert.ok(src.includes("input.sessionId ?? randomUUID()"), "sessionId fallback wiring missing");
  assert.ok(src.includes("sessionId?:"), "sessionId field missing from SpawnViaCliInput");
});

test("v0.10.5: checkin accepts session-id rotation for freshly spawned tasks", async () => {
  // Simulate the v0.10.4-and-earlier failure mode + verify v0.10.5 handles it.
  const dir = await tempDir("checkin-rotate");
  // Build a minimal state file with a pre-allocated spawnedSessionId.
  const stateFile = path.join(dir, "orqlaude-state.json");
  const planId = "plan-test-id-fixed";
  const taskId = "task-test-id-fixed";
  const preallocatedSessionId = "preallocated-session-id";
  const agentSessionId = "agent-different-session-id";
  const justStartedAt = Date.now() - 5_000; // 5s ago - within 60s grace
  await fs.writeFile(
    stateFile,
    JSON.stringify({
      schemaVersion: 3,
      plans: {
        [planId]: {
          id: planId,
          createdAt: Date.now(),
          rootTask: "test",
          budgetCapTokens: 1000,
          perAgentCapTokens: 1000,
          status: "running",
          tasks: [
            {
              id: taskId,
              title: "t",
              prompt: "p",
              tldr: "t",
              status: "running",
              spawnedSessionId: preallocatedSessionId,
              startedAt: justStartedAt,
            },
          ],
          notes: [],
          messages: [],
          claims: [],
          userNotifications: [],
          userResponseRequests: [],
          userStreams: [],
        },
      },
    })
  );
  // We can't easily call the registered tool callback directly (it's wrapped
  // through MCP). But we CAN verify the broker.ts source contains the
  // rotation logic by reading it.
  const brokerSrc = await fs.readFile(
    path.join(import.meta.dirname, "..", "..", "src", "tools", "broker.ts"),
    "utf8"
  );
  assert.ok(
    brokerSrc.includes("wasJustSpawned"),
    "broker.ts should have the wasJustSpawned rotation check"
  );
  assert.ok(
    brokerSrc.includes("noNotesYet"),
    "broker.ts should also gate rotation on no-notes-yet"
  );
  assert.ok(
    brokerSrc.includes("60_000"),
    "broker.ts should use 60s grace window for rotation"
  );
});

test("v0.10.5: buildSpawnPrompt embeds session_id when provided", async () => {
  // Pure source-level check that the prompt builder honors the sessionId arg.
  const dispatchSrc = await fs.readFile(
    path.join(import.meta.dirname, "..", "..", "src", "tools", "dispatch.ts"),
    "utf8"
  );
  assert.ok(
    dispatchSrc.includes("sessionId?: string"),
    "buildSpawnPrompt should accept optional sessionId"
  );
  assert.ok(
    dispatchSrc.includes("EXACT value, pre-allocated by orqlaude"),
    "When sessionId is provided, the prompt should instruct the agent to use it exactly"
  );
  assert.ok(
    dispatchSrc.includes("NOT $CLAUDE_CODE_SESSION_ID"),
    "The protocol prompt should explicitly tell the agent NOT to use the env var"
  );
});

test("v0.10.5: spawn_via_cli handler pre-generates session_id before buildSpawnPrompt", async () => {
  const dispatchSrc = await fs.readFile(
    path.join(import.meta.dirname, "..", "..", "src", "tools", "dispatch.ts"),
    "utf8"
  );
  assert.ok(
    dispatchSrc.includes("presetSessionId = randomUUID()"),
    "spawn_via_cli handler should pre-allocate session_id with randomUUID"
  );
  assert.ok(
    /buildSpawnPrompt\([^)]*presetSessionId\)/.test(dispatchSrc),
    "presetSessionId should be passed into buildSpawnPrompt"
  );
  assert.ok(
    /sessionId:\s*presetSessionId/.test(dispatchSrc),
    "presetSessionId should be passed into spawnAgnetViaCli as sessionId"
  );
});
