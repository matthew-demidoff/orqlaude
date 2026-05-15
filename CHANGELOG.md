# Changelog

## 0.9.1 — review follow-ups

Three follow-ups + three nits from the v0.9.0 review (#22).

### Changed

- **`spawn_cli.ts`** — the `child.on('exit')` handler now uses the
  top-level `writeFileSync` import instead of an inline `require("node:fs")`.
  Cosmetic; ESM-clean.
- **`wait_for_status_change` fingerprint** — switched from pipe-and-colon
  string-joining to `JSON.stringify(parts)`. Hash-safer if a task_id, PR
  URL, or any other component ever contains a delimiter character. Also
  added `stop_kind` per-agent so `kill_task` / `request_stop` transitions
  wake the long-poll without waiting for the child to actually terminate.
- **`fleet_summary`** — parallelized the per-task `snapshotSession` reads
  inside each plan's rollup via `Promise.all`. First post-restart call is
  noticeably faster on large fleets; cache makes subsequent calls cheap
  regardless.

### Internal

- **`src/lib/version.ts`** — single source of truth for the runtime
  version string. Imported by `server.ts`, `cli.ts`, `tools/ping.ts`,
  `tools/dispatch.ts` (for `fleet_summary`). `package.json` stays
  canonical for npm; on release bump both. Closes the "five places to
  update" footgun the reviewer flagged.

### Tests

- Strengthened the v0.9.0 D migration test from "undefined OR array" to
  pinning the contract: `Array.isArray(orphans.n) && length === 0`. The
  weak form was passing regardless of whether the migration actually ran.

## 0.9.0 — observability overhaul

Closes the gap between "the Agnet is doing work" and "orqlaude knows the Agnet
is doing work." The previous version's `status()` was effectively blind to
every Agnet spawned via `spawn_via_cli` because it polled the wrong file. This
release also kills the orchestrator's wakeup-every-90s polling loop by
introducing a long-poll endpoint.

### Added

- **`wait_for_status_change(plan_id, since_fingerprint?, timeout_sec=60)`** —
  long-poll endpoint. Blocks up to `timeout_sec` and returns the moment any
  task transitions state, opens a PR, dies, or burns 1+ KB of fresh tokens.
  Replaces the orchestrator's `ScheduleWakeup` + `status()` polling loop with
  a single call. The orchestrator threads the returned `fingerprint` into the
  next call's `since_fingerprint` to detect "what changed since I last looked."
- **`fleet_summary()`** — single-call dashboard. Server health + Telegram
  status + per-plan rollup (task-status counts, PRs, tokens, budget %) +
  cross-plan totals. Use at session start to discover in-flight fleets;
  replaces ping + status + list_plans round-trips.
- **`ChildExitRecord` + `<worktree>/.orqlaude.exit.json`** — `spawn_via_cli`
  now registers a `child.on('exit')` handler before `unref()`, writing a
  terminal-state record to disk. `status()` reads it as a fast path and
  doesn't have to wait for the PID-liveness poll cycle.
- `Task.exitJsonPath` field (state schema, additive).
- `State.orphanNotifications` / `State.orphanResponseRequests` (state schema,
  additive backfill).
- `SessionSnapshot.source` (`"jsonl" | "stdout_log" | "none"`) and
  `SessionSnapshot.resolvedPath` — surfaces which stream file was tailed.

### Changed

- **`snapshotSession()`** now accepts an optional `stdoutPath` argument and
  falls back to it when the canonical Desktop JSONL is missing. This is the
  fix for the 11-min "tokens_used: 0" status blackout we hit with
  spawn_via_cli Agnets. The Desktop JSONL is still preferred when both
  files exist.
- **`status()` per-task payload** gained `stream_source` (which file we read
  from), `stdout_path` (mirror), and `exit_record` (parsed terminal-state).
- **`died_at_launch` detection** now uses "PID dead AND no events were
  parsed" instead of "PID dead AND JSONL doesn't exist." The previous
  predicate broke after we started creating the stdout log file at spawn
  time (the file exists but is empty when the child exits before writing).
- **`kill_task`** releases the spawn lock when the Agnet is already dead
  (PID gone OR exit record present), so the orchestrator can re-spawn the
  same task_id without creating a fresh plan. Live Agnets still get the
  STOP message + 30s wait.
- **`cleanup_worktrees`** releases the spawn lock on every task whose
  worktree was removed. Status flips back to `pending` so `spawn_via_cli`
  can re-fire cleanly. Surfaces `released_task_ids` in the response.
- **`notify_user`** — `plan_id` is now optional. Plan-less notifications
  land in `State.orphanNotifications` and are drained by the same notifier
  tick. Use for session-startup pings or any standalone message not tied
  to a fleet.
- **`probeTelegramStatus`** now resolves `CONFIG_PATH` at call time, not at
  module load. Lets tests override `HOME` per-test without import-cache
  pollution.

### Fixed

- Pre-existing test `v0.5.3: telegram_status returns 'unconfigured' when no
  config file exists` was failing on the install if the user had a real
  Telegram config at `~/.orqlaude/telegram.json`. Fixed by the call-time
  config path resolution above.

### Migration notes

- Schema is still v3. The new fields (`exitJsonPath`, `orphanNotifications`,
  `orphanResponseRequests`) are backfilled with sensible defaults on load.
- No CLI changes; all additions are MCP tool surface.

## 0.8.0 — robustness audit

(See git history for the prior round.)
