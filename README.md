# orqlaude

Multi-agent orchestrator for Claude Code. Lets one primary Claude session decompose a complex task into N parallel sub-tasks, get a budget approval from the user once, spawn N child agents (each in its own session and worktree), broker messages between them, and aggregate the resulting PRs.

The name is a portmanteau of **orq**hestrator + **Claude**.

> Status: **v0.1.0** — first working version. State store, planning flow, dispatch flow, and broker are all in place. The actual session spawning uses the Claude Desktop app's native `mcp__ccd_session__spawn_task` (one chip-click per agent), which means each spawned agent is a real Code-section session with normal sidebar, history, and resumability.

## How it fits together

```
                          ┌──────────────────────┐
                          │   PRIMARY CLAUDE     │
                          │  (this session)      │
                          └─────────┬────────────┘
                                    │
   ┌─── orqlaude.create_plan ──────►│
   │   orqlaude.request_approval ──►│  (relays via AskUserQuestion)
   │   orqlaude.confirm        ────►│
   │   orqlaude.next_task      ────►│
   │   ccd_session.spawn_task  ────►├─── chip ───► ┌──────────┐
   │   orqlaude.register_spawn ────►│              │ child #1 │
   │                                │              │ session  │
   │   orqlaude.next_task      ────►│              └────┬─────┘
   │   ccd_session.spawn_task  ────►├─── chip ───►      │
   │   orqlaude.register_spawn ────►│              ┌────▼─────┐
   │                                │              │ child #2 │
   │   orqlaude.status         ────►│              │ session  │
   │   orqlaude.poll_notes     ────►│              └────┬─────┘
   │   orqlaude.send_message   ────►│                   │
   │   orqlaude.collect        ────►│        post_note  │
   │                                │◄──────────────────┘
   └────────────────────────────────┘
```

orqlaude itself never spawns processes. It maintains a JSON ledger of plans, tasks, notes, and queued messages. The primary Claude is the dispatcher; the Desktop app's `ccd_session__spawn_task` is the spawner; spawned agents call back into orqlaude (loaded as an MCP in their worktree) for broker messaging.

## Quick start

```sh
# One-time: build the MCP server
cd /path/to/orqlaude
npm install
npm run build
```

The repo's `.mcp.json` already wires orqlaude into Claude Code at `node /Users/matthew/Documents/orqlaude/dist/server.js`. Reopen any session in this folder and you'll see the `mcp__orqlaude__*` tools.

If you want orqlaude available in other projects too, copy the `mcpServers` entry from `.mcp.json` into that project's `.mcp.json`, or add it globally via `claude mcp add`.

## Tool reference

### Planning flow (primary Claude)

| Tool | What it does |
|---|---|
| `create_plan(root_task, tasks[], budget_cap_usd?, effort_multiplier?)` | Register a fleet. `tasks` is your decomposition — each entry has `title` (≤60 chars, chip label), `prompt` (full self-contained instructions), `tldr` (tooltip), optional `scope` and `branchHint`. Returns `plan_id`. |
| `estimate(plan_id, model?, effort_multiplier?)` | Recompute cost/duration estimate. |
| `request_approval(plan_id)` | Returns an `approval_token` + a prebuilt `ask_user_question` payload. Show it to the user via `AskUserQuestion`. |
| `confirm(plan_id, approval_token)` | Lock the plan after user approves. |

### Dispatch flow (primary Claude)

| Tool | What it does |
|---|---|
| `next_task(plan_id)` | Pull the next pending task. The returned `prompt` is wrapped with broker scaffolding (instructions to post PR URL, periodic check-ins). Feed it directly into `mcp__ccd_session__spawn_task`. |
| `register_spawn(plan_id, task_id, session_id)` | After the user clicks the chip, look up the new session id (via `mcp__ccd_session_mgmt__list_sessions`) and tell orqlaude. |
| `status(plan_id)` | Live snapshot: per-agent cost, last activity, current tool, terminated yes/no. Reads each spawned session's JSONL tail. |
| `collect(plan_id)` | Final aggregation: PR URLs, summaries, total cost, exit reasons. |

### Broker

| Tool | Caller | What it does |
|---|---|---|
| `checkin(session_id)` | child agent | Pull queued messages, see which of your blocking notes have been acked. |
| `post_note(session_id, text, blocking?, pr_url?)` | child agent | Share a finding with the fleet. Set `pr_url` on completion. |
| `poll_notes(plan_id, since_ts?, mark_acked?)` | primary Claude | Read all notes; optionally ack blocking ones. |
| `send_message(plan_id, to_session_id, text, from_task_id?)` | primary Claude | Queue a directed message for a child. Delivered on its next `checkin`. |

### Health

| Tool | What it does |
|---|---|
| `ping(echo?)` | Returns version, cwd, node version, pid. Use once after install. |

## End-to-end walkthrough

Imagine the user says: *"Refactor the auth system — move from password-based to magic-link login, update the docs, and add new tests."* You judge this as parallelizable across three regions.

1. You call `orqlaude.create_plan` with three subtasks (auth-core changes, docs, tests).
2. You call `orqlaude.request_approval`, which returns an `approval_token` and a ready-made `ask_user_question` payload.
3. You call `AskUserQuestion` with that payload. User picks "Approve and spawn".
4. You call `orqlaude.confirm` with the token.
5. Loop three times:
   - `orqlaude.next_task` → returns a task with wrapped prompt
   - `mcp__ccd_session__spawn_task` with that title/prompt/tldr → chip appears
   - User clicks the chip → new session created
   - You call `mcp__ccd_session_mgmt__list_sessions` to find the new session id (matches by title)
   - `orqlaude.register_spawn` to tell orqlaude
6. Periodically: `orqlaude.status` and `orqlaude.poll_notes` to see what's happening. Forward cross-cutting info via `orqlaude.send_message`.
7. When all agents are done, `orqlaude.collect` returns the three PR URLs and a summary you can present to the user.

## State

State lives in `<project>/.orqlaude/orqlaude-state.json` (overridable via `ORQLAUDE_STATE_DIR`). Atomic-write via temp+rename. The file is human-readable and inspectable. It's `.gitignore`d.

## Pricing assumptions

`src/lib/pricing.ts` has a per-model pricing table and a `estimateAgentCost` baseline. The baselines (~30k cache-creation, ~4k output, etc.) are tuned to a real Haiku run we observed (~$0.038). Tweak with `effort_multiplier` per plan; refine the baselines as we collect more real-run data.

## Limits and known gaps

- **No automatic session-id discovery yet.** After `spawn_task`, primary Claude has to call `list_sessions` to find the new session id and pass it to `register_spawn`. A future iteration will try to embed a "report-in" hook in the spawned prompt so the agent registers itself via `checkin` on first turn.
- **Child agents need orqlaude as an MCP** to use broker tools. The `.mcp.json` in the project root works if the spawned worktree includes it (committing this file ensures that).
- **N chips means N clicks.** Anthropic's `spawn_task` is intentionally a per-click confirmation. Aggregate batch-spawn isn't yet possible through that API.
- **No kill/cancel tool yet.** Cancellation requires using `mcp__ccd_session_mgmt__archive_session` directly.
- **Per-agent budget caps aren't enforced at the agent level** because chip-spawned sessions don't accept `--max-budget-usd`. orqlaude tracks costs after the fact and surfaces overages, but doesn't automatically kill.

## Repo layout

```
orqlaude/
├── package.json
├── tsconfig.json
├── .mcp.json                  # auto-loads orqlaude in this project
├── src/
│   ├── server.ts              # MCP stdio entry
│   ├── lib/
│   │   ├── state.ts           # JSON-backed ledger
│   │   ├── pricing.ts         # model pricing + cost estimator
│   │   └── jsonl_tail.ts      # snapshot a session's JSONL for status
│   └── tools/
│       ├── ping.ts
│       ├── planning.ts        # create_plan, estimate, request_approval, confirm
│       ├── dispatch.ts        # next_task, register_spawn, status, collect
│       └── broker.ts          # checkin, post_note, poll_notes, send_message
└── dist/                      # tsc output
```

## License

TBD.
