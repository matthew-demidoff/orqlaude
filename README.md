# @synaplink/orqlaude

Multi-agent orchestrator for Claude Code. One primary Claude session decomposes a complex task into N parallel **Agnets** (orqlaude's name for spawned workers), gets a single user approval, then dispatches each Agnet (in its own session and worktree) via the Claude Desktop app's native `mcp__ccd_session__spawn_task`. Tracks cost/tokens via JSONL tails, brokers messages between Agnets, detects hallucination, manages PRs, streams updates to your Telegram, and can spawn a reviewer Agnet per PR at the end.

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

Then wire it into Claude Desktop's MCP config in one command:

```sh
cd /path/to/your/project
orql setup
```

`orql setup` **patches** Claude Desktop's `claude_desktop_config.json` in place — adds an `orqlaude` MCP server entry pointed at this project's state dir, and **preserves every other server you have configured** (lm-studio, etc.) plus the entire `preferences` block. Writes a timestamped `.bak` before changing anything. Re-runs are idempotent — if the entry is already correct, it reports `already correct; nothing to do` and exits without touching the file.

Flags:
- `--state-dir <path>` override the default (which walks up from cwd for a `.git`)
- `--config-path <path>` override Claude Desktop's config path
- `--yes` skip prompts

Fully quit and relaunch Claude Desktop after running. The `mcp__orqlaude__*` tools will then appear in your sessions.

If you'd rather edit the config yourself, the entry should look like:

```json
{
  "mcpServers": {
    "orqlaude": {
      "command": "npx",
      "args": ["-y", "-p", "@synaplink/orqlaude", "orqlaude-mcp"],
      "env": {
        "ORQLAUDE_STATE_DIR": "/absolute/path/to/your/project/.orqlaude"
      }
    }
  }
}
```

The `ORQLAUDE_STATE_DIR` env var is important — it pins state to a specific path so the MCP server (running with `cwd=/` on some hosts) and the Telegram bot (running in your project) share the same state file.

## Spawning Agnets: which tool to use

orqlaude itself doesn't spawn processes — it returns prompts and lets the orchestrator pick a spawn tool. Use them in this priority order:

| Priority | Tool | Isolation | Visibility | When to use |
|---|---|---|---|---|
| **1** | `mcp__ccd_session__spawn_task` | git worktree per Agnet | Claude Desktop Code sidebar | **Default.** Worktree-isolated, sandbox-clean, the Agnet shows up as its own session you can switch into. |
| 2 | Host's `Agent` tool (Claude Code built-in) | none — shares your cwd | tool-use only, not a separate session | Faster, no chip-click. **Loses worktree isolation** — Agnets may race on shared files. `claim_files` from the broker is your only collision signal. |
| 3 | Shell out `claude -p --worktree …` | explicit `--worktree` flag | JSONL on disk — not in sidebar until Desktop restart | Headless / cron / non-Desktop hosts. |

`next_task` returns a `spawn_strategies[]` array with ready-to-call args for each option, so the orchestrator can pick deliberately. **Picking by habit is the most common way to bypass orqlaude's isolation guarantees** — check the returned strategies and make a conscious choice.

### Orphan detection

If an Agnet is dispatched but doesn't call `mcp__orqlaude__checkin` within 60 s, `status()` flags it in `orphan_alerts[]`. Common cause: the orchestrator used a non-`ccd_session__spawn_task` path and the Agnet skipped (or never reached) the protocol footer that tells it to register.

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

### Broker-to-user (v0.4+, expanded in v0.5)

These let primary Claude push messages to and pull answers from the **user** (via Telegram if configured, with a `/respond` text fallback).

| Tool | Purpose |
|---|---|
| `notify_user(plan_id, text, urgency?, task_id?)` | One-way push to user's Telegram. urgency = `low`/`normal`/`high` (affects emoji). Returns immediately. |
| `request_user_response(plan_id, prompt, options?[], timeout_sec?, task_id?)` | Ask the user a question. With `options`, Telegram shows inline-keyboard buttons; without, user replies via `/respond <short_id> <text>`. Returns `request_id` + `short_id`. Defaults to a 10-minute timeout. |
| `poll_user_response(request_id)` | Returns `status: pending\|answered\|timed_out\|cancelled` + `response` once available. Safe to poll repeatedly. |
| `stream_to_user_start(plan_id, title, initial_content?, task_id?)` | **v0.5+** Open a streaming Telegram message. Returns `stream_id`. |
| `stream_to_user_append(stream_id, chunk)` | **v0.5+** Append a chunk; notifier edits the Telegram message in place (throttled ~1 edit/1.5s). |
| `stream_to_user_end(stream_id, final_chunk?)` | **v0.5+** Finalize the stream — adds a `✓` marker to the message. |

Without a running `orqlaude tg start`, `notify_user` queues silently, `request_user_response` will always `timed_out`, and streaming tools accumulate content in state but no message lands on Telegram. Fall back to `AskUserQuestion` if Telegram is unavailable.

#### Streaming transport

orqlaude streams by opening a single Telegram message with `sendMessage`, then calling `editMessageText` on each append. The final `stream_to_user_end` does one more edit appending a `✓` marker.

(v0.5.1 briefly used `sendMessageDraft` for animated, ephemeral previews — reverted in v0.5.4 after that endpoint proved unreliable in the standard Bot API.)

Limits to know:
- A Telegram message tops out at 4096 chars. orqlaude caps stream content at 3800 to leave room for the title + completion marker; further appends are silently truncated.
- Edits are rate-limited (~1/sec per message); orqlaude throttles to 1.5 s between edits per stream.
- If you need to stream more than 4 kb of output, start a new stream when you're approaching the cap.

### Health

| Tool | Purpose |
|---|---|
| `ping(echo?)` | Returns version, cwd, state_dir, state_dir_source, warnings[], node, pid. First call after install to verify wiring + state-dir resolution. |

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

orqlaude resolves its state directory at startup using this order (first match wins):

1. **`ORQLAUDE_STATE_DIR`** env var — explicit override.
2. **Git worktree**: if `<cwd>/.git` is a file pointing at `<main>/.git/worktrees/<n>`, use `<main>/.orqlaude` so spawn_task'd children share state with the parent fleet.
3. **Project root**: if cwd is writable and contains `.git/`, `package.json`, `pyproject.toml`, `Cargo.toml`, or `go.mod`, use `<cwd>/.orqlaude`.
4. **Home fallback** (covers MCP hosts that launch with `cwd=/`): `~/.orqlaude/projects/<basename>-<sha256hash>/`. orqlaude writes a one-line note to stderr when this kicks in.

Check what got resolved: `orqlaude where`, or call `mcp__orqlaude__ping` (returns `state_dir` and `state_dir_source`).

Files inside the dir:
- `orqlaude-state.json` — plans, tasks, notes, messages, claims. Atomic-write via temp+rename.
- `audit.jsonl` — append-only log of every tool call. Inspect with `orqlaude history` or `tail -f .orqlaude/audit.jsonl | jq`.
- `lock` — sidecar file lock used by `update()` for cross-process serialization.

`<project>/.orqlaude/` is `.gitignore`d.

## Hallucination detection

When you call `status(plan_id)`, every agent's snapshot includes a `hallucination` object with `score` (0–1), `level` (`clean`/`minor`/`moderate`/`severe`), and `concerns: string[]`. The aggregated `hallucination_alerts` array surfaces only agents at `moderate` or above so an orchestrator can react quickly.

**What gets flagged:**

1. **Path-existence** — every `file_path` arg in `Read`/`Edit`/`Write`/`Grep`/`Glob`/`MultiEdit`/`NotebookEdit`/`NotebookRead` is checked against the worktree. >30% missing or ≥3 missing = moderate/severe. Catches "agent is editing a file it imagined."
2. **Tool-pattern sanity**:
   - **Edit-without-prior-Read**: agent edits a file it never read → it's guessing at the content.
   - **Tight loop**: same tool call (name+args) ≥3× → likely stuck.
   - **Commit-without-tests**: `git commit` without a prior test/lint Bash call → commit may be broken.

**How to react** in your orchestrator code:

| level | suggested response |
|---|---|
| `clean` | Nothing. |
| `minor` | Note but continue. |
| `moderate` | `send_message` to the agent with a nudge ("re-read X.ts before editing"), or `request_stop` if the work is salvageable. |
| `severe` | `kill_task` and consider re-spawning with a clearer prompt. |

False positives are acceptable here — we surface concerns, we don't auto-kill. A v0.4 addition is opt-in second-model cross-validation (a cheap Haiku reading the agent's recent turns and rating "is this lost?").

## CLI

Two binaries are installed: `orqlaude` and the short alias `orql`. Use whichever feels right. All commands work the same.

### Live (v0.6+)

```sh
orql watch <plan_id>            # live-updating dashboard (1Hz, Ctrl-C to exit)
orql tail [plan_id]             # tail -f the audit log; filter by plan if given
orql open <plan_id>             # open every PR from a plan in your browser
orql doctor                     # end-to-end health check
orql about                      # the easter egg
```

### Local desktop notifications (macOS)

```sh
orql notify on                  # enable; the Telegram bot will also fire osascript banners
orql notify off                 # disable
orql notify test                # send a test notification
orql notify status              # is it on?
```

### Read-only inspection (`--json` on every one)



```sh
orql                            # banner + active-plan summary
orql list                       # every plan in this project
orql status [plan_id]           # if omitted, picker prompts
orql show [plan_id]             # raw plan JSON
orql history --limit 50         # tail audit log
orql where                      # show resolved state dir
orql help
```

Every read command supports `--json` to emit machine-readable output for scripting.

Read-only. For active orchestration, use the MCP from inside Claude Code.

### Branding & colors (v0.5+)

CLI output uses the Anthropic palette via ANSI truecolor:

| Color | Hex | Purpose |
|---|---|---|
| Claude Coral | `#DA7756` | Headings, brand accents, running tasks, Agnet names |
| Cream | `#F5F4EE` | Secondary emphasis, token counts |
| Crimson | `#BB5944` | Errors, failed/cancelled tasks |
| Charcoal | `#2A2926` | Body text (terminal default usually) |
| Sand | `#B9B6AB` | Captions, separators, hints |

Colors disable automatically when stdout isn't a TTY, when `NO_COLOR` is set ([no-color.org](https://no-color.org/)), or when `TERM=dumb`. Force-enable with `FORCE_COLOR=1`.

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
- `/respond <short_id> <text>` — answer a `request_user_response` question (v0.4+)
- Tap inline-keyboard buttons on any `request_user_response` with options (v0.4+)
- `/whitelist <user_id> [label]` (owner-only) — add another user
- `/help` / `/whoami`

The bot uses raw `fetch` against Telegram's Bot API — zero extra deps. State is shared with the MCP via the same `StateStore`, so commands take effect on the next status() / checkin().

## Known gaps (v0.3 → v0.4 roadmap)

- **Cost-learning estimates** — current baselines are tuned to a single Haiku probe. Future: write per-task realized costs to history and use moving averages.
- **N chips = N clicks** — Anthropic's `spawn_task` is per-click by design. Worth filing as feedback. Until then, batch-spawn isn't possible through that API.
- **Second-model hallucination check** — periodic Haiku cross-validation of recent activity, opt-in.
- **Multi-project Telegram bot** — currently the bot watches a single project. Multi-project watching is a small extension to the config schema.
- **Inline approve buttons in Telegram** — `/approve <plan_id>` and inline keyboards so you can confirm fleets from your phone.

## Troubleshooting

**Symptom: `ENOENT: no such file or directory, mkdir '/.orqlaude'` on `create_plan`.**
Your MCP host launched orqlaude with `cwd=/`. v0.3.2+ auto-falls back to `~/.orqlaude/projects/...` but the explicit fix is to set `ORQLAUDE_STATE_DIR` in your `.mcp.json` env block (see `.mcp.json.template`). Verify with `mcp__orqlaude__ping` — it now returns `warnings` and `state_dir_source`.

**Symptom: `spawn_via_cli` returned a PID but `status()` shows `died_at_launch` shortly after, with a stderr_excerpt + command_line.**
This is the v0.7.0 hardening doing its job. The child `claude -p` process exited within the 1.5s healthcheck window. Read `stderr_excerpt` (or open `stderr_path` directly) for the cause. Common ones:
1. `claude` isn't authenticated on this user account (`claude auth status` to check; `claude auth login --claudeai` to fix).
2. The `--mcp-config` JSON references a server entry that doesn't exist (rare; orqlaude validates this pre-spawn).
3. The user's environment lacks something `claude` needs (HOME, locale).
Copy the `command_line` field and paste it into a shell to reproduce by hand.

**Symptom: spawn_task chip appeared, agent ran, but `status()` shows the task as `dispatched` forever.**
The child agent isn't calling `checkin` on its first turn — its prompt didn't get the orqlaude protocol block, or `mcp__orqlaude__checkin` isn't available in the spawned session. Manual unblock: `register_spawn(plan_id, task_id, session_id)` where session_id is the child's session UUID (find via `mcp__ccd_session_mgmt__list_sessions`). For the proper fix, make sure orqlaude is in the spawned worktree's `.mcp.json` (commit `.mcp.json` to the repo so worktrees inherit it).

**Symptom: agents in worktrees can't see the parent fleet's plan.**
v0.3.1+ resolves `<cwd>/.git` files (worktree pointers) back to the parent checkout's `.orqlaude`. If a child still can't find its plan, run `orqlaude where` inside the worktree — `source` should be `worktree`. If it's `home-fallback`, the worktree pointer is malformed or `.git` isn't where the resolver expected.

**Symptom: Telegram bot stops sending notifications.**
Check `/tmp/orqlaude-tg.log` (if you used the launchd plist) or wherever the bot is logging. The most likely cause is a Markdown parse error from an unescaped `_`/`*`/`` ` ``/`[` in a task title or note. v0.3.1+ escapes these but anything user-supplied that bypasses our path (e.g. content posted manually via `post_note` to a stale older bot) can still hit it.

## License

MIT.
