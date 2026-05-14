# @synaplink/orqlaude

Multi-agent orchestrator for Claude Code. One primary Claude session decomposes a complex task into N parallel sub-tasks, gets a single user approval, then dispatches N child agents (each in its own session and worktree) via the Claude Desktop app's native `mcp__ccd_session__spawn_task`. Tracks cost/tokens via JSONL tails, brokers messages between agents, detects hallucination, manages PRs, and can spawn a reviewer agent per PR at the end.

The name is **orq**hestrator + **Claude**.

> Status: **v0.3.0** — 19 tools, 11 tests passing, CI green. Token-first budgets (Max-friendly), self-registering child agents, hallucination detection, file-claim broker, audit log, resumability, auto-review pipeline, and a **Telegram bot** for fleet notifications + remote control.

## Why orqlaude exists

A single Claude agent is great at focused work but slow at multi-region refactors. You can manually spawn parallel sessions via `spawn_task`, but you lose budget oversight, cross-agent coordination, and a single place to see "what's the fleet doing right now?"

orqlaude is the thin layer that adds those things. It never spawns processes itself — the Desktop app's `spawn_task` does that — but it owns the *plan*, the *budget*, the *broker*, and the *aggregation*.

## How it fits together

```
                          ┌──────────────────────┐
                          │   PRIMARY CLAUDE     │
                          └─────────┬────────────┘
   ┌─── orqlaude.create_plan ──────►│
   │   orqlaude.request_approval ──►│  (relays via AskUserQuestion)
   │   orqlaude.confirm        ────►│
   │   orqlaude.next_task      ────►│
   │   ccd_session.spawn_task  ────►├─── chip ─► ┌──────────┐
   │                                │            │ child #1 │ ─► auto-registers via checkin
   │                                │            │ session  │
   │   orqlaude.next_task      ────►│            └────┬─────┘
   │   ccd_session.spawn_task  ────►├─── chip ─►      │
   │                                │            ┌────▼─────┐
   │                                │            │ child #2 │
   │   orqlaude.status         ────►│ ◄────── claim_files, post_note
   │   orqlaude.poll_notes     ────►│ ◄────── PR url via post_note
   │   orqlaude.send_message   ────►│
   │   orqlaude.collect        ────►│
   │   orqlaude.review_prs     ────►├─── chip ─► reviewer #1
   │                                ├─── chip ─► reviewer #2
   └────────────────────────────────┘
```

## Install

```sh
npm install -g @synaplink/orqlaude   # CLI + MCP server
```

In your project, add to `.mcp.json` (or copy `.mcp.json.template`):

```json
{
  "mcpServers": {
    "orqlaude": {
      "command": "npx",
      "args": ["-y", "@synaplink/orqlaude"]
    }
  }
}
```

Restart your Claude Code session. The `mcp__orqlaude__*` tools will appear.

## Tool reference

### Planning (primary Claude)

| Tool | Purpose |
|---|---|
| `create_plan(root_task, tasks[], budget_cap_tokens?, model_for_estimate?, effort_multiplier?)` | Register a fleet. Returns `plan_id`. Budget is in TOKENS (Max-plan friendly); USD is informational. |
| `estimate(plan_id, model?, effort_multiplier?)` | Recompute cost/duration estimates. |
| `request_approval(plan_id)` | Returns `approval_token` and a prebuilt `ask_user_question` payload. Surfaces your daily token usage from the Desktop app's `buddy-tokens.json`. |
| `confirm(plan_id, approval_token)` | Lock the plan after user approves. |

### Dispatch (primary Claude)

| Tool | Purpose |
|---|---|
| `next_task(plan_id)` | Pull the next pending task. Returned `prompt` embeds `plan_id` + `task_id` and instructs the agent to self-register via `checkin` on its first turn. |
| `status(plan_id)` | Per-agent live snapshot: cost, tokens, last activity, current tool, terminated yes/no, **hallucination report**. Auto-cancels and STOPs all agents if total tokens exceed the cap. |
| `collect(plan_id)` | Aggregated PR URLs, summaries, costs, exit reasons. |
| `review_prs(plan_id, auto_approve?, budget_cap_tokens?)` | Spawn a reviewer agent against each PR produced by `plan_id`. Creates a new "review plan" auto-approved by default. |
| `register_spawn(plan_id, task_id, session_id)` | Manual fallback if a child fails to self-register. Rarely needed. |

### Broker

| Tool | Caller | Purpose |
|---|---|---|
| `checkin(session_id, task_id?)` | child agent | **First call**: pass `task_id` to self-register. Subsequent calls: pull queued messages, see STOP signals, ack state of blocking notes. |
| `post_note(session_id, text, blocking?, pr_url?)` | child agent | Share findings or report a PR URL. `blocking: true` pauses until acked. |
| `claim_files(session_id, paths[], reason?)` | child agent | Register intent to edit specific files. Conflicting claims by other agents surface to the caller. |
| `release_files(session_id, paths[])` | child agent | Release claims after finishing. |
| `poll_notes(plan_id, since_ts?, mark_acked?)` | primary Claude | Read agent notes; ack blocking ones to unblock posters. |
| `send_message(plan_id, to_session_id, text, from_task_id?, kind?)` | primary Claude | Queue a directed message. `kind: "stop"` triggers child commit-and-exit. |

### Lifecycle

| Tool | Purpose |
|---|---|
| `kill_task(plan_id, task_id, reason)` | Queue STOP broker message; returns session_id ready for `archive_session`. Use for hallucinating/looping agents. |
| `resume_plan(plan_id)` | Pick up an in-flight plan after a Desktop-app restart or new session. Refreshes per-task status from JSONL, returns a "do this next" hint. |
| `list_plans(include_collected?)` | All plans known to orqlaude in this project, active first. |

### Health

| Tool | Purpose |
|---|---|
| `ping(echo?)` | Returns version, cwd, node, pid. |

## End-to-end walkthrough

User says: *"Refactor the auth system — magic-link login, update the docs, add tests."* You judge it as parallelizable.

1. `orqlaude.create_plan` with 3 subtasks (auth-core, docs, tests), `budget_cap_tokens: 600000`.
2. `orqlaude.request_approval` → returns `approval_token` and a prebuilt question payload showing your remaining daily quota.
3. You call `AskUserQuestion` with that payload. User picks "Approve and spawn".
4. `orqlaude.confirm`.
5. Loop three times:
   - `orqlaude.next_task` → returns a task with the wrapped prompt
   - `mcp__ccd_session__spawn_task` with the title/prompt/tldr → user clicks the chip
   - The spawned agent calls `orqlaude.checkin(session_id, task_id)` on first turn → self-registers
6. Periodically: `orqlaude.status` (shows hallucination scores) + `orqlaude.poll_notes`. Forward cross-cutting info via `send_message`. If an agent goes off the rails, `kill_task`.
7. Agents call `orqlaude.post_note(..., pr_url=...)` when their PR is open.
8. `orqlaude.collect` → three PR URLs and summaries.
9. **NEW**: `orqlaude.review_prs(plan_id)` → spawns three reviewer agents, one per PR. Each reviews, runs tests, posts findings. You aggregate the second-round notes.

## State

State lives in `<project>/.orqlaude/`:

- `orqlaude-state.json` — plans, tasks, notes, messages, claims. Atomic write via temp+rename.
- `audit.jsonl` — append-only log of every tool call: `{ ts, tool, args (redacted), ok, durationMs, plan/session ids, summary }`. Inspect with `orqlaude history` or `tail -f .orqlaude/audit.jsonl | jq`.

Both human-readable. Both `.gitignore`d.

## Hallucination detection

`status()` runs two deterministic checks per agent:

1. **Path-existence**: every `file_path` referenced in `Read/Edit/Write/Grep` tool calls is checked against the worktree. >30% missing or ≥3 missing = `moderate`/`severe` flag.
2. **Tool-pattern sanity**:
   - Edit on a file that wasn't read first
   - Same tool call repeated ≥3 times (loop)
   - `git commit` without any prior `npm test`/`tsc`/`pytest`/etc.

Each agent gets a `hallucination_score` (0–1) and `concerns: string[]`. The aggregated `hallucination_alerts` list surfaces to the primary Claude so it can `send_message` a nudge or `kill_task`. False positives are acceptable here — we surface concerns, we don't auto-kill.

A future v0.3 can add a Check 3: periodic Haiku cross-validation of recent activity (costs tokens, opt-in).

## CLI

```sh
orqlaude list                   # every plan in this project
orqlaude status <plan_id>       # refreshed status of one plan
orqlaude show <plan_id>         # raw plan JSON
orqlaude history --limit 50     # tail audit log
orqlaude help
```

Read-only. For active orchestration, use the MCP from inside Claude Code.

## Repo layout

```
orqlaude/
├── package.json                # @synaplink/orqlaude
├── tsconfig.json
├── .mcp.json                   # local dev wiring
├── .mcp.json.template          # production wiring (npx-based)
├── .github/workflows/ci.yml    # typecheck + build + test
├── src/
│   ├── server.ts               # MCP stdio entry
│   ├── cli.ts                  # `orqlaude` CLI binary
│   ├── lib/
│   │   ├── state.ts            # JSON-backed ledger, schema v2
│   │   ├── budgeting.ts        # token-first budget, daily quota reader
│   │   ├── pricing.ts          # USD pricing table (informational)
│   │   ├── hallucination.ts    # deterministic detectors
│   │   ├── jsonl_tail.ts       # cached byte-offset session tail
│   │   └── audit.ts            # append-only audit log
│   ├── tools/
│   │   ├── ping.ts
│   │   ├── planning.ts         # create_plan, estimate, request_approval, confirm
│   │   ├── dispatch.ts         # next_task, register_spawn, status, collect
│   │   ├── broker.ts           # checkin, post_note, claim_files, release_files, poll_notes, send_message
│   │   ├── lifecycle.ts        # kill_task, resume_plan, list_plans
│   │   └── review.ts           # review_prs
│   └── __tests__/
│       ├── state.test.ts
│       └── hallucination.test.ts
└── dist/                       # tsc output (published to npm)
```

## Telegram bot

orqlaude can notify you on Telegram when fleet events happen and accept commands from your phone.

```sh
# One-time setup (creates ~/.orqlaude/telegram.json, mode 600)
orqlaude tg setup
# (paste your bot token from @BotFather)

# Message your bot /start in Telegram to learn your user id, then:
orqlaude tg whitelist <your_user_id> --owner --label "you"

# Run the bot (foreground; daemonize with launchctl / systemd / nohup as you prefer)
cd /path/to/your/project
orqlaude tg start
```

**Notifications pushed to you:**
- 📋 New plan created
- ✅ Plan approved (spawn imminent)
- ✓ Task done (with PR URL)
- ❌ Task failed / 🛑 cancelled
- 📝 New agent note (with severity from `post_note`)
- 💸 Auto-cancel on budget overrun
- 🎉 Fleet collected

**Commands you can send (whitelisted users only):**
- `/plans` — active plans
- `/status <plan_id>` — refreshed task list with token usage
- `/show <plan_id>` — raw plan JSON
- `/notes <plan_id>` — recent agent notes
- `/kill <plan_id> <task_id> <reason>` — STOP a runaway agent
- `/whitelist <user_id> [label]` (owner-only) — add another user
- `/help` / `/whoami`

The bot uses raw `fetch` against Telegram's Bot API — zero extra deps. State is shared with the MCP via the same `StateStore`, so commands take effect on the next status() / checkin().

## Known gaps (v0.3 → v0.4 roadmap)

- **Cost-learning estimates** — current baselines are tuned to a single Haiku probe. Future: write per-task realized costs to history and use moving averages.
- **N chips = N clicks** — Anthropic's `spawn_task` is per-click by design. Worth filing as feedback. Until then, batch-spawn isn't possible through that API.
- **Second-model hallucination check** — periodic Haiku cross-validation of recent activity, opt-in.
- **Multi-project Telegram bot** — currently the bot watches a single project. Multi-project watching is a small extension to the config schema.
- **Inline approve buttons in Telegram** — `/approve <plan_id>` and inline keyboards so you can confirm fleets from your phone.

## License

MIT.
