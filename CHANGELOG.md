# Changelog

## 0.10.1 — plain-text Telegram, blocking `ask_user`, reply-to-message answers

User-driven fix for three real problems with v0.10.0's Telegram surface:

### The three bugs

1. **Markdown parser was eating sends.** Telegram's MarkdownV1 parser is fussy
   about specials inside code-spans, around hyphens, in URLs, etc. When a
   notifier-built message tripped it, Telegram returned `400 Bad Request:
   can't parse entities` and the message NEVER ARRIVED. The user reported
   `delivered: false` on a request that should have been delivered — the
   notifier had tried to send, gotten a 400, and surfaced nothing actionable.

2. **`request_user_response` + `poll_user_response` was a polling sandwich.**
   Primary Claude had to call request, then poll on a wakeup-loop, then act
   on the eventual answer. Long latency, cache misses every 5 min, and
   awkward primary-Claude logic.

3. **Inline-keyboard callbacks felt fragile.** When a user did tap a button,
   if anything was off (parseMode, callback routing, store contention) the
   answer didn't propagate and there was no easy fallback.

### Changes

- **NO MARKDOWN anywhere in Telegram sends.** Every `sendMessage` and
  `editMessageText` now goes out as plain text. `escapeMd` remains exported
  as a no-op for back-compat with anything that imports it. Visual richness
  was never worth the silent-fail tax.

- **New `ask_user` MCP tool (BLOCKING).** Single MCP call that:
  1. Writes the request,
  2. Sanity-checks Telegram reachability up front (returns immediately if
     unreachable rather than blocking on a closed channel),
  3. Block-polls state.json every 750ms,
  4. Returns the answer (or `timed_out` / `cancelled`) synchronously.
  Default timeout 900s (15min); cap 3600s (1h). No more wakeup loops.

- **Reply-to-message is the PRIMARY answer path.** Notifier sends each
  question with Telegram's `force_reply` enabled, which focuses the chat
  input pre-targeted at the question. The user just types — their reply
  carries `reply_to_message.message_id` which `commands.ts` matches back to
  the `UserResponseRequest` via the `(telegramMessageId, telegramChatId)`
  tuple. Inline keyboards still work when `options` are provided. Legacy
  `/respond <short_id> <text>` also still works.

- **Reply-to dispatch is BEFORE slash dispatch.** A reply to a question
  with body `/respond xxx` (someone confused) gets routed to the question,
  not parsed as a malformed command.

- **All-paths `delivered` flag is set on send success only.** This was
  already true but easier to verify now that nothing fails on parser
  errors.

- **5 new tests** covering: `escapeMd` no-op, orphan request creation,
  reply-to-message routing by `(message_id, chat_id)` tuple, response
  write-back, cancelled short-circuit.

134 tests total, all green.

### Migration notes

- `request_user_response` and `poll_user_response` are still exported — old
  primary-Claude code that uses them keeps working. New code should prefer
  `ask_user` for any in-loop question.
- `escapeMd` is now `(s) => s`. If you imported it from `telegram/notifier`,
  no change needed; if you relied on its escape behavior elsewhere, you're
  fine because nothing sends Markdown anymore.
- No state migration. Existing pending requests get the new reply-to
  routing automatically because the notifier already persisted
  `telegramMessageId` and `telegramChatId`.

## 0.10.0 — autopilot daemon, memory, auto-PR-review, retry, Telegram free-form, backlog scheduler

The biggest single release since v0.5. Adds a persistent orchestrator
daemon that runs in the background, picks goals off a durable backlog,
auto-reviews and merges PRs by configurable rule, retries failed Agnets
intelligently, and listens for free-form Telegram messages — all
**Plan-billed** (no Anthropic API key required). Every "thinking" turn
uses `claude -p` with cache reads, which are free on the Claude Max plan,
so a full day of the daemon ticking burns a tiny fraction of the quota.

### The autopilot daemon (`orql autopilot`)

`orql autopilot start` runs a long-lived Node process that ticks every
10 seconds and:

1. **Reconciles state** — for every spawned Agnet, refreshes from JSONL,
   PID, and exit-record; promotes `died_at_launch` / `done` / `failed`.
2. **Recovers from failures** — classifies each failure via a Plan-billed
   `claude -p` turn (haiku-cheap), then either retries with backoff,
   spawns a debugger Agnet, or escalates to the user via Telegram.
3. **Auto-reviews PRs** — fetches the diff, runs a reviewer turn,
   applies the fleet template's auto-merge rule, and either
   `gh pr merge --squash --auto` or posts a review comment.
4. **Picks the next goal** — when the fleet is idle and autopilot is
   unpaused, pulls the highest-priority unblocked goal from the
   backlog and prompts the user via Telegram.
5. **Watches the budget** — yellow / orange / red thresholds with
   automatic pause at orange+.

Plan-billing note: orqlaude **never** talks to the Anthropic API. Every
intelligent decision the daemon makes is a `claude -p` invocation, which
on the Max plan is billed exactly the way an interactive Claude Code
session is — and cache reads are free, so the cost of repeatedly reading
"is this PR mergeable?" is approximately zero output tokens worth of
quota each.

CLI surface: `orql autopilot start|stop|status|pause|resume`.

### Memory module — durable, spirit-themed categories

A `memory.json` file at `<state_dir>/memory.json` holds four kinds of
durable facts (separate from the plan-bound state file so it survives
plan lifecycles):

- **lore** — facts about the user. Pinned, slow churn, surfaced into
  every spawned Agnet prompt. _Example: "Russian comments in CRM
  templates", "no auto-deploy on Fridays."_
- **playbook** — code conventions. Surfaced when a fleet's scope
  overlaps with the entry's path-glob. _Example: "Migrations live in
  `<app>/migrations/`", "use AntD ConfigProvider for dark mode."_
- **ledger** — past decisions + their rationale. Append-only; surfaced
  when a similar decision recurs. _Example: "Sonnet over Opus for
  transcription — latency mattered more than depth."_
- **atlas** — project map. Auto-updated by the post-PR review with one
  entry per touched file mapping path → purpose.

New MCP tools: `remember`, `recall`, `forget`, `compose_memory_context`.
Older entries with the same `(category, key)` are soft-superseded — kept
for history but invisible to read paths.

### Backlog scheduler

A `backlog.json` file holds `Goal` records — durable task descriptions
with `priority` (0-100), optional `deadlineAt` (boosts effective
priority as the deadline approaches), and `dependsOn` (block until
parents are done).

The daemon picks the highest-priority unblocked goal when idle and
proposes it via Telegram. Primary Claude can also use this mid-session
to capture "things to do next" without immediately spawning a fleet.

New MCP tools: `enqueue_goal`, `list_goals`, `update_goal`,
`pick_next_goal`.

### Fleet templates

Eight named patterns ship out of the box, each with default Agnet
layout, suggested model per role (sonnet/opus/haiku), default budget,
and an `AutoMergeRule` the daemon applies:

| id | description |
|---|---|
| `backend-feature` | Django/DRF: model + migration + serializer + viewset + admin + tests |
| `frontend-feature` | React/AntD: components + hooks + i18n + tests |
| `migration-only` | Schema change with backwards-compat reviewer (opus) — `block_on_migrations:true` |
| `audit-sweep` | Multiple haiku auditors + sonnet synthesizer (read-only) |
| `dep-upgrade` | Dep version bump + breaking-change patches + reviewer |
| `i18n-pass` | Audit then translator pass |
| `test-coverage-fill` | Parallel testers; blocks on prod-code touches |
| `bug-hunt` | Reproducer Agnet → fixer Agnet (sequential) |

New MCP tools: `list_fleet_templates`, `suggest_fleet_template`,
`apply_fleet_template`.

### Auto-PR-review + auto-merge

For every fleet that uses a template with an `AutoMergeRule`, the
daemon fetches the PR via `gh pr view`, runs a reviewer turn that
returns strict JSON (`{verdict, blockers, suggestions, summary}`),
and applies the rule:

- `requireReviewerApprove` — verdict must be APPROVE
- `requireCi` — `gh pr checks` must be all-green
- `maxLoc` — additions + deletions under cap (default 1500-3000 per
  template)
- `blockOnMigrations` — refuses PRs that add migration files
- `blockOnPaths` — refuses PRs touching specific globs (e.g.
  `**/settings.py`, `**/views.py` for the test-coverage-fill template)

If everything passes: `gh pr merge --squash --auto --delete-branch`.
Otherwise: `gh pr comment` with the review verdict + blockers. Each
review writes a `ledger` memory entry so the next fleet inherits the
rationale.

### Retry logic — died_at_launch + failed-after-work-started

Two failure modes get distinct handling:

- **died_at_launch** (PID gone within ~1.5s of spawn): auto-retry up
  to 2 times with 30s backoff. After exhausted, escalate via Telegram.
- **failed-after-work-started**: classify via a Plan-billed turn. The
  classifier decides between `retry` (flaky), `spawn_debugger` (need
  investigation), `escalate` (user attention), or `give_up`. Debugger
  Agnets read the worktree + logs + JSONL and write a ledger memory
  entry capturing "X failed because Y; next time do Z."

### Telegram free-form input + slash commands

v0.9 only listened for `/respond <short_id> <text>`. v0.10 makes the
bot listen to **every** message and classify intent via a Plan-billed
turn:

- `new_task` → enqueue_goal
- `followup` → post_note to the most-recent active plan, or enqueue
- `kill` → request_stop / kill_task on matched plan
- `status` → fleet_summary → notify_user
- `chitchat` → ack or ignore

Below a 0.6 confidence threshold, the daemon asks the user to confirm
before acting (`AskUserQuestion`-style).

New slash commands: `/now`, `/queue`, `/pause`, `/resume`, `/morning`,
`/pulse`, `/budget` (in addition to the existing `/respond`).

### Cost guardrails

A `guardrails.json` rolling ledger tracks billed tokens per 5-hour
window and per local day:

- **green** (< 60% window): full speed
- **yellow** (≥ 60%): notify user, slow down
- **orange** (≥ 80%): refuse to start new fleets, force pause
- **red** (≥ 95%): halt entirely, await user `/resume` after next 5h
  reset

Day soft-cap (default 30M billed) applies independently.

### Orchestrator-turn helper

New `lib/orch_turn.ts` exposes `runOrchTurn()` — the daemon's thinking
primitive. Spawns `claude -p` synchronously, parses the strict-JSON
response (handles ` ```json` fences and prose-wrapped JSON), enforces
timeout. This is THE reason the daemon can exist without an API key —
every "intelligent" decision in the daemon (failure classifier,
Telegram intent classifier, PR reviewer) goes through this one
function.

### Files

- `src/lib/memory.ts` + `src/tools/memory.ts`
- `src/lib/backlog.ts` + `src/tools/backlog.ts`
- `src/lib/templates.ts` + `src/tools/templates.ts`
- `src/lib/orch_turn.ts`
- `src/lib/auto_merge.ts`
- `src/lib/retry.ts`
- `src/lib/tg_classifier.ts`
- `src/lib/guardrails.ts`
- `src/cli/autopilot.ts`
- `src/__tests__/v010.test.ts` — 27 new tests, 129 total green

### Migration notes

- `<state_dir>/memory.json`, `<state_dir>/backlog.json`, and
  `<state_dir>/guardrails.json` are created on first write. No
  migration of existing state files required.
- The MCP `server.ts` now registers three additional tool modules.
  Existing tool names are unchanged.
- `orql autopilot` is opt-in — nothing runs in the background unless
  the user starts the daemon explicitly.

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
