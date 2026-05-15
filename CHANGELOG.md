# Changelog

## 0.9.2 — billed-vs-cached token accounting + budget enforcement on long-poll

Fixes the budget-cap UX for users on the Claude Plan, and closes a real
defect where `wait_for_status_change` skipped the overbudget kill (only
`status()` was wired to it).

### The Claude-Plan accounting problem

The `usage` block in stream-json events has four counters: `input_tokens`,
`output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`.
On the Claude Plan, **cache reads are free** - they don't count against
your plan limit. Through the Anthropic API, cache reads cost ~10% of fresh
input tokens.

Earlier versions summed all four into a single `totalEffectiveTokens` and
treated the sum as "the budget." A typical Agnet turn cache-reads
50-100 KB (system prompt + tool defs + protocol footer), so 20 turns easily
shows 1-2M `totalEffectiveTokens` while only ~50 KB is actually Plan-relevant.
Result: fleets were getting auto-cancelled in 4-5 minutes for hitting an
imaginary budget.

### Changes

- **`SessionSnapshot` now exposes three rollups:**
  - `billedTokens` = `input + output` (what the Plan / API actually charges)
  - `cachedTokens` = `cache_read + cache_creation` (~free on the Plan)
  - `totalEffectiveTokens` = sum (kept for back-compat with v0.8/v0.9 callers)
- **`Plan.budgetMode: "billed" | "total"`** - new field, default `"billed"`.
  Cap applies to billed only on the Plan (default), or to the sum on the
  API (opt-in via `create_plan({ budget_mode: "total" })`).
- **`enforceBudget(store, plan_id, agents)`** - new shared helper at module
  scope in `tools/dispatch.ts`. Picks the right bucket per `plan.budgetMode`,
  flips the plan to `cancelled_overbudget` + queues STOP messages, and is
  idempotent (concurrent callers race-safe via re-check inside the lock).
- **`wait_for_status_change` calls `enforceBudget` on every poll.** Before
  this, an orchestrator using only the long-poll never tripped the kill -
  budget enforcement was status()-only. Fix matches the prior round's
  guidance to prefer wait_for_status_change over status() for polling.
- **`status()` response gains a `tokens` object:**
  ```json
  "tokens": {
    "billed": 187432,
    "cached": 1614900,
    "total": 1802332,
    "budget_mode": "billed",
    "budget_relevant": 187432,
    "budget_pct": 62
  }
  ```
  `total_tokens_used` retained as a legacy field (sum of all buckets);
  `budget_remaining_tokens` now reflects the mode-relevant bucket.
- **Per-agent payload** in `status()` and `wait_for_status_change` gains
  `billed_tokens` and `cached_tokens` alongside the legacy `tokens_used`.
- **`fleet_summary` totals** add `grand_billed_tokens` and
  `grand_cached_tokens`. `budget_pct` per plan is now mode-relevant.
- **Long-poll fingerprint** runs the KB bucket off `billed_tokens` instead
  of `totalEffectiveTokens`. Cache-read churn no longer trips the
  fingerprint every 2s; the long-poll fires only when cost-relevant
  progress happens.
- **`create_plan({ budget_mode })`** new optional arg with `"billed"`
  default. The response includes `budget_mode` so the orchestrator can
  confirm.

### Migration

- State schema stays v3, additive. Plans without `budgetMode` are treated
  as `"billed"`. Existing on-disk state loads unchanged.
- The legacy `tokens_used` field still exists; new orchestrators should
  read `tokens.billed` / `tokens.budget_relevant` for Plan-cost decisions.

### Tests

- `src/__tests__/v092.test.ts` - 5 new tests pinning the bucket maths +
  the cache-inflation invariant. **93/93 total tests pass.**

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
