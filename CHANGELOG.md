# Changelog

## 0.12.1 — hardening pass: every bug a sharp reviewer found, fixed

Driven by two parallel code-audit passes (one focused on the web server,
one on the new CLI commands + shared JSON store) plus targeted research
on 2026-era SSE production gotchas. Twelve real issues addressed; 12 new
regression tests pin each one down so future refactors can't re-break
them.

Total test count: **236 passing** (up from 224 in v0.12.0).

### Web server (`src/lib/web_server.ts`)

  * **SSE backpressure**. `client.write()` return value is now respected;
    a slow client whose socket buffer fills is evicted immediately
    rather than allowed to balloon Node's internal queue. Combined with
    bounded per-message size, server memory under a hung browser tab is
    now strictly bounded.

  * **SSE heartbeat** (`: keepalive` every 25s on idle streams). Defeats
    proxy / load-balancer idle-kill (nginx default 60s, AWS ALB 60s,
    Cloudflare 100s). The heartbeat is per-client and only fires when
    the snapshot ticker hasn't already written to that client.

  * **SSE proxy-friendly headers**: `X-Accel-Buffering: no`,
    `Cache-Control: no-store, no-transform`, `retry: 5000`. The first two
    are nginx/Cloudflare-respected; the third hints the EventSource
    client to reconnect on a 5s window instead of the browser default.

  * **Three-way disconnect cleanup**. SSE clients are evicted on any of
    `req.close`, `res.close`, or `socket.error`. v0.12.0 only listened
    for `req.close`, which doesn't fire on abrupt RST. No more stale
    Set entries.

  * **Broadcaster idles when no clients are connected**. v0.12.0 stat-
    checked four files every second forever; v0.12.1 returns early.

  * **`server.stop()` is idempotent**. SIGINT + SIGTERM arriving back-
    to-back, or two parallel callers, won't double-close the server.

  * **Slowloris defenses**: `requestTimeout: 30s`, `headersTimeout: 10s`,
    `keepAliveTimeout: 5s`, `maxConnections: 64`. SSE responses opt out
    via `socket.setTimeout(0)` after handshake, so their longevity is
    unaffected.

  * **Constant-time CSRF compare** via `crypto.timingSafeEqual`. Overkill
    for a localhost-only server, but it removes the entire category
    from any future security discussion.

  * **Content-Security-Policy header** on the dashboard page. Even if a
    future change leaks unescaped data into the HTML, inline-script and
    eval-style XSS are blocked. `frame-ancestors 'none'` blocks
    clickjacking. Paired with `X-Content-Type-Options: nosniff` and
    `Referrer-Policy: no-referrer`.

  * **Consistent attribute escaping**. The kill-button row in v0.12.0
    used a mix of bare concat (`'data-kill-task="' + t.id + '"'`) and
    `escapeHtml()` — fine for UUIDs in practice but a stink test. Every
    attribute is now `escapeAttr()`'d uniformly.

### Web dashboard page

  * **Keyboard shortcuts**: `/` focus filter, `Esc` clear, `e` expand all
    plans, `c` collapse all, `r` force-reconnect SSE, `?` help overlay.
  * **Free-text filter** across plan ids, root tasks, agnet names, task
    titles, and statuses. Persisted nowhere (intentional — clears on
    reload).
  * **Click-to-copy plan ids**. Hover any plan id, click, copied.
    Clipboard API in a localhost page works under all major browsers.
  * **Connection-lost overlay** when SSE has been silent for >15s.
  * **Document title reflects fleet state**: `● orqlaude — 3/12 agnets`
    when something is in flight. Spot it from a backgrounded tab.
  * **localStorage in private/incognito mode no longer crashes the page.**
    Wrapped in a try/catch helper. Open-plans state degrades to in-
    memory only.
  * **Graceful SSE close on `beforeunload`/`pagehide`** so the server's
    eviction fires immediately instead of waiting for keep-alive to lapse.
  * **External PR links** get `rel="noopener noreferrer"` (no tabnabbing).

### `orql cost`

  * **`--days` capped at 365** with a friendly note when truncated.
    Defends against `--days 10000` allocating a bucket per day.
  * **Ambiguous `--plan <prefix>` now errors** with a list of matching
    plan ids instead of silently picking the first match.
  * **Defensive `formatCost`**: NaN / negative / Infinity render as `$0`
    instead of `$NaN`.
  * **Sparkline NaN/Infinity guard**: non-finite values coerced to 0
    before `Math.max`, so `sparkline([NaN, 5, 3])` no longer renders
    every glyph as the lowest band.

### `orql goal`

  * **`cmdCancel` errors gracefully** instead of crashing with a stack
    trace when the goal is already done/cancelled.
  * **`parseDeadline` actually validates dates**: `2026-02-30`, `2026-13-15`,
    `2026-04-31` are all rejected. Round-trip through `Date` and
    compare back to the input string — only an exact match passes.
  * **Relative deadlines**: `+7d`, `+2w`. Capped at +3650 days (10 years).
  * **Non-TTY stdin fails fast** with a hint to use `--yes`, instead of
    hanging forever waiting for input that will never come.

### `JsonStore` (memory + backlog shared base)

  * **Size-based cache fingerprint** in addition to mtime. Many
    filesystems (HFS+, ext4 on older kernels, FAT32) have second-level
    mtime granularity; two writes inside the same second wouldn't
    invalidate a peer's cache. JSON files almost never have the exact
    same size twice in a row, so size+mtime together catch the race.

  * **Post-create lock token verification**. After winning the
    `open(O_EXCL)` race, we re-read the lock file and confirm it
    carries OUR token before proceeding. Defends against pathological
    filesystems (NFS, some Docker volume drivers) where O_EXCL
    semantics are best-effort.

  * **`LOCK_TIMEOUT_MS` bumped from 5s to 15s.** The original was
    triggering false positives during legitimate busy autopilot ticks
    that needed >5s under the lock. Real deadlocks still surface, just
    later.

### Plumbing + tests

  * 12 new tests in `v0121_hardening.test.ts` covering: stop()
    idempotence, CSRF surface, CSP header, SSE proxy headers, idle
    broadcaster guard, JsonStore size-fingerprint, concurrent
    multi-instance writes, sparkline NaN coercion, parseDeadline
    accepting `+Nd` / rejecting out-of-range / rejecting malformed,
    BacklogStore double-cancel propagation.

  * `parseDeadline` exported for unit-test coverage.

## 0.12.0 — `orql web` dashboard, `orql cost` analytics, `orql goal new` wizard

Three new headline commands. Each is end-to-end usable today: shipped with
tests, integrated into help output, and exercised against a live state
directory before the release commit.

### `orql web` — live HTML fleet dashboard

`orql watch` is great when one fleet is in flight, but it owns the terminal
and can't show drilldown. `orql web` boots a local HTTP server (default
`http://127.0.0.1:7777`) that renders every plan + every Agnet + a live
audit feed in a single dark-themed page.

Highlights:

  * **Live updates via SSE.** A `setInterval` on the server polls the state
    file once a second and broadcasts a fresh snapshot to every connected
    page. EventSource handles reconnection for free.
  * **Diff rendering.** The page keeps DOM nodes for plans it has already
    drawn — your scroll position and which plans you've expanded are
    preserved across snapshots (persisted in `localStorage`).
  * **Inline controls.** Stop a plan, kill a hung Agnet, pause autopilot —
    all without leaving the page. POSTs are CSRF-protected with a token
    minted at boot.
  * **Zero build step, zero deps.** The full HTML/CSS/JS lives in a single
    string in `web_server.ts`. No `node_modules` bloat, no `npm install`
    in the dashboard dir, no Vite. Renders fine on any modern browser.
  * **Port autoscan.** If 7777 is taken (another `orql web` is already
    open), we silently scan up to 7799 instead of failing.
  * **Security.** Binds to 127.0.0.1 only. POST endpoints require the
    matching `x-orql-csrf` header; the token is echoed into the page on
    initial GET. Remote access is the user's responsibility (SSH tunnel).

Try it: `orql web` — opens your default browser automatically.

### `orql cost` — spend analytics with terminal sparklines

Reads `orqlaude-state.json` and attributes per-task token + cost burn to
a calendar day. Default view: last 14 days. Outputs:

  * Window totals + all-time totals + projected monthly spend (extrapolated
    from a trailing-7-day average — early warning when burn drifts).
  * Two ASCII sparklines (daily cost + daily tokens) using
    `▁▂▃▄▅▆▇█` blocks. Recent days highlighted in coral, older in sand.
  * Per-day table with weekend rows dimmed.
  * Top 5 plans by cost in the window.

`orql cost --plan <id>` drills into one plan: per-Agnet rows sorted by
cost, with status / duration / PR link.

`--json` emits the same data as a structured object — pipe it into
whatever spreadsheet / dashboard you already have.

### `orql goal new <template>` — quickstart wizard

`orql backlog add` always worked but required you to remember the JSON
shape of a `Goal`. The wizard takes a fleet template id (`audit-sweep`,
`test-coverage-fill`, `dep-upgrade`, `bug-hunt`, …), walks you through
the missing pieces interactively (title, priority, scope, tags,
deadline), and enqueues the goal so the autopilot daemon picks it up on
its next idle tick.

  * `--yes` accepts every default — script-friendly.
  * `orql goal templates` lists every bundled template with descriptions.
  * `orql goal list` / `show` / `cancel` are aliases for the most common
    backlog operations, but tab-grouped by status (running first,
    cancelled last) so the eye lands on what matters.

### Plumbing

  * New module `src/lib/web_server.ts` (~500 LOC). HTTP server, SSE, CSRF.
  * New modules `src/cli/web.ts`, `src/cli/cost.ts`, `src/cli/goal.ts`.
  * `cli.ts` routes for `web` / `dashboard` / `cost` / `goal` (typo
    suggester now knows about them).
  * Help text gets a `★` glyph next to the headline commands.
  * 19 new tests in `v012_web.test.ts` + `v012_cost_goal.test.ts`. Total
    test count: **224 passing** (up from 205 in v0.11).

### Notes for v0.12.x

The web dashboard's `stop plan` hook flips `stopRequested` on each task
in state.json — in-flight CLI agents notice the flag on their next status
poll and wind down on their own (commit, push, exit). The `kill task`
hook additionally sends `SIGKILL` directly to the recorded child PID,
so it works even when the autopilot daemon is asleep.

The browser-open code uses `open` (macOS), `xdg-open` (Linux), and
`cmd /c start` (Windows). On Linux distros without `xdg-utils` the
browser open is silently a no-op — the user just clicks the URL printed
to stdout.

## 0.11.0 — polish pass: cross-process safety for memory + backlog

This release closes a class of silent data loss + cleans up a handful of
sharp edges that accumulated through the v0.10.x series. No new public
tools; the focus is making what's already there bulletproof.

### Bug 1: `MemoryStore` and `BacklogStore` lacked cross-process locking

`StateStore` got cross-process file locks + mtime-based cache
invalidation in v0.3.1 / v0.10.8. `MemoryStore` and `BacklogStore` —
which are written by all three of (MCP server, CLI, autopilot daemon) —
never received the same treatment. Symptom: a `orql backlog add` issued
while the autopilot daemon was mid-tick could be overwritten by the
daemon's next `persist()` call (last-writer-wins on stale in-memory
cache); a `mcp__orqlaude__remember` issued from a fleet agent could be
invisible to the CLI's `orql memory list` until the daemon happened to
reload.

**Fix**: extracted a shared `JsonStore<T>` (`src/lib/json_store.ts`)
that mirrors `StateStore`'s discipline — sidecar `.lock` file with
PID-based stale reclaim, UUID-token ownership verification on release,
and per-read mtime stat-check. `MemoryStore` and `BacklogStore` both
now route through it. Existing call sites are unchanged.

### Bug 2: `dispatch.ts` minted overbudget stop-message IDs from `Math.random`

`enforceBudget()` queued one `kind: "stop"` message per running task
when the fleet went overbudget. Each got an id from a hand-rolled
`Math.random + Date.now` helper instead of `crypto.randomUUID`. Two
overbudget snapshots within the same millisecond could collide on id;
the helper's comment also lied about why it existed (claimed `crypto`
wasn't imported — it was).

**Fix**: deleted the helper, replaced both call sites with `randomUUID`
(already imported at the top of the file).

### Bug 3: `effort_multiplier` had no upper bound

`create_plan` and `estimate` accepted any positive number for
`effort_multiplier`. A typoed `100` produced a `(2-character) ⋅ 100 = 400
minutes` duration estimate and a budget that no real Plan account would
honor.

**Fix**: capped at `10` (a 10x multiplier already implies ~40-minute
Agnets; anything bigger should be split into a separate plan).

### Bug 4: `autopilot.ts` shadowed `pauseFile` with a local function

The top-of-`runAutopilot` `const pauseFile = path.join(...)` and the
nested `function pauseFile() { ... }` defined inside `tick()` worked by
accident — JS hoisting made the function visible inside `tick`, hiding
the string. Renamed the nested function to `resolvePauseFile()` so a
reader can tell which is which without thinking about scope rules.

Also removed an unused `import os from "node:os"` from the same file.

### Bug 5: `orql <typo>` told you "unknown subcommand" with no hint

Now it suggests the nearest known subcommand within Levenshtein distance
≤ 2 (`orql lst` → "did you mean `orql list`?") and always points at
`orql help` as the fallback.

### Bug 6: `audit.tail()` silently dropped malformed JSONL lines

A partially-written audit line (writer killed mid-`appendFile`) was
swallowed without trace. Now the tail emits a one-line stderr warning
naming the file and count of dropped lines — the good events are still
returned, the user just knows the window shrank.

### Bug 7: `.orqlaude-worktrees/` wasn't in `.gitignore`

`spawn_via_cli` creates worktrees under `<project>/.orqlaude-worktrees/`;
the gitignore only listed `.orqlaude/`, so the worktree directory
showed up in `git status` on the orqlaude repo itself when dogfooding.

### Coverage

Ten new tests in `src/__tests__/v011.test.ts` exercise the shared
JsonStore (round-trip, cross-process mtime invalidation, corrupt-file
fallback) plus the memory + backlog stores against the same scenarios.
All 205 tests pass.

## 0.10.9 — pre-spawn worktree hygiene + finer-grained fingerprint

Three small fixes for issues that surfaced during the Email Hub polish
+ fix-up fleets, where the orchestrator repeatedly couldn't trust the
snapshot's view of agent state and the long-poll missed real progress.

### Bug 1: stale `.orqlaude.stdout.log` / `.orqlaude.stderr.log` survive worktree recreate

v0.10.7 added `fs.unlink(.orqlaude.exit.json)` before each spawn so the
snapshot's `terminated: !!exitRecord` fast-path wouldn't read a prior
agent's exit record. The same problem applies to the stdout/stderr
logs: when a worktree is removed + recreated for a re-spawn (or a new
agent in a similarly-named worktree), the prior stdout.log content can
hang around long enough for one or two `snapshotSession` calls to
return the OLD agent's tokens / lastAssistantText / terminated flag.

**Fix**: pre-spawn unlink covers all three files now. Same loop as
the exit.json fix:

```ts
for (const stalePath of [exitJsonPathPre, stdoutPath, stderrPath]) {
  try { await fs.unlink(stalePath); } catch { /* normal */ }
}
```

Then `fs.open(path, "w")` for stdout/stderr creates fresh inodes,
which maximizes the chance v0.8.0's `entry.inode !== stat.ino` check
fires immediately on the next snapshot.

### Bug 2: snapshot cache survives across spawns on the same worktree path

The module-level `cache: Map<string, CacheEntry>` in `jsonl_tail.ts`
is keyed by stream path. If two consecutive spawns share a worktree
path (re-spawn, or a near-collision in plan_short / agnet_slug), the
SECOND spawn can see the FIRST's cached `snap` for one or two ticks
before the inode/mtime/size invalidation catches up. Symptom: the new
agent's `tokens_used` reads as the old agent's final count.

**Fix**: new `evictTailCacheEntry(streamPath)` export on `jsonl_tail.ts`.
`spawn_via_cli` calls it for the new agent's stdoutPath after the
unlink loop, BEFORE the new agent starts writing. No-op when nothing
is cached. Defense-in-depth.

### Bug 3: fingerprint bucket too coarse for the early/mid lifecycle

`wait_for_status_change` bucketed `billed_tokens / 1024`. For an agent
climbing slowly through the 1k-4k billed range (read-heavy work,
Russian comments, careful test writing), the bucket stays at 1 or 2
for minutes, so the long-poll returns `changed: false` every 45s
despite real progress.

**Fix**: bucket is `/256` now — same units (256 tokens are a roughly
meaningful chunk of work) but 4x finer granularity. Cache-read churn
still filtered because we bucket on `billed`, not `total`. The
long-poll wakes ~4x more often during slow burns; once per ~256
billed tokens.

### Tests

6 new tests in `v0109.test.ts`:
- `evictTailCacheEntry` drops a single entry without affecting siblings
- Source-level: spawn_cli unlinks all three files in a single loop
- Source-level: spawn_cli imports + calls `evictTailCacheEntry`
- Source-level: dispatch.ts uses `/256` not `/1024`
- Math check: /256 trips ~4x more buckets than /1024 over a 0→4096 climb
- Integration: snapshot reload after eviction reflects fresh content

1 updated test in `v0107.test.ts` to match the new loop pattern.

**195 total, all green.**

### Migration notes

No state migration. The cache eviction is purely in-process and
backward-compatible (it's a no-op if nothing is cached at the path).
The fingerprint bucket change is a behavior tweak — old fingerprints
won't match new ones after upgrade, but `wait_for_status_change`'s
"first call returns immediately with current state + fresh fingerprint"
contract means the orchestrator just resynchronizes naturally on its
first post-upgrade poll.

## 0.10.8 — cross-process staleness fix (StateStore.read())

### The bug user caught

User tapped a button in Telegram. Bot UI confirmed "✓ Answer recorded
(b96fb626): A. per-deal + websocket". State.json on disk had the
response. But MCP server's `wait_for_user_response` loop returned
`still_pending` over and over for 7+ minutes.

User: *"the orql still does not know how to detect if Ive answered
because when I do on telegram it does not tell him that therefore you
are not informed and stuck in an infinite loop, we need to find our
solution to this"*

Right diagnosis. `StateStore.read()` in v0.10.7 and earlier:

```ts
const state = this.cache ?? (await this.loadFresh());
return reader(state);
```

Once the cache was populated (any prior read or update), `read()`
returned the cached state forever. `update()` always reloaded from
disk (good — picks up cross-process writes before mutating). But
`read()` had no invalidation path. The Telegram bot (separate process)
wrote responses to state.json; our cache stayed stale forever.

This explains why `wait_for_status_change` "worked" earlier — it polls
fleet state which OUR process mutates (no cross-process write
involved). But ask_user → bot → response was a true cross-process
write that read() couldn't see.

### Fix

Stat-check on every read. If the file's mtime moved since we last
cached, reload from disk.

```ts
private async cacheIsStale(): Promise<boolean> {
  if (!this.cache || this.cacheMtimeMs === null) return true;
  try {
    const stat = await fs.stat(this.filePath);
    return stat.mtimeMs !== this.cacheMtimeMs;
  } catch (err) {
    return err.code === "ENOENT";
  }
}
```

`persist()` also refreshes `cacheMtimeMs` after its own write, so OUR
writes don't trip a needless reload on the next read.

Single `fs.stat` per read (~1ms). Worth the cost.

### Tests

4 new tests in `v0108.test.ts`:
- Cross-process write becomes visible on the very next read()
- Own writes don't trigger needless reloads
- Empty state (no file) reads as EMPTY_STATE
- Tight bot-write + read race sees the new value

**147 total, all green.**

### Migration

No state migration. Existing state files load cleanly. Cache
invalidation kicks in immediately after upgrade.

## 0.10.7 — re-spawn hygiene (stale exit-record + lingering stopRequested)

### Two bugs surfaced by the Verdant re-spawn in self-test fleet d47c0448

The v0.10.5 session-id fix worked perfectly: Verdant's checkin matched
the pre-allocated session_id, registered cleanly. But then it
**immediately exited** because the prior `kill_task` (which released
the spawn lock per v0.9.0) left `task.stopRequested = {kind: "hard"}`
on the task. The new agent's first checkin received the stale STOP and
bailed correctly per protocol.

Separately, the snapshot reported the new spawn as already terminated
because the **prior `.orqlaude.exit.json` was still on disk** in the
shared worktree — `terminated: !!exitRecord` evaluates to true even
though the PID is alive.

### Fix 1: `spawn_via_cli` clears `task.stopRequested` on re-spawn

In `dispatch.ts`, after setting the new `spawnedSessionId` / `pid` /
`status: "running"`, also reset:
```ts
task.stopRequested = undefined;
task.finishedAt = undefined;
task.exitReason = undefined;
```

Order matters: clear AFTER setting the new spawnedSessionId so a
concurrent reader never sees an intermediate state where the slot is
both "no-longer-stopped" and "still-claimed-by-old-session".

### Fix 2: `spawn_cli.ts` unlinks `.orqlaude.exit.json` before spawn

In `spawnAgnetViaCli`, before the `spawn(claudeBin, args)` call,
best-effort `fs.unlink(exitJsonPathPre)`. Normal first-spawn case has
no prior record so the unlink ENOENT-no-ops. Re-spawn case wipes the
stale fast-path entry so `snapshot()` correctly reports the new agent
as running.

### Tests

3 new tests in `v0107.test.ts` (source-level: the actual spawn path
needs an integration test with `claude`). 143 total green.

### Migration

No state migration. Existing in-flight plans continue to work; new
spawns get the cleaner re-spawn hygiene automatically.

## 0.10.6 — `wait_for_status_change` capped at 45s so the loop pattern actually works

### The bug

`wait_for_status_change` (v0.9.0+) is THE primitive for event-driven
fleet monitoring — it long-polls and returns the moment any task
transitions, opens a PR, or hits the budget. The orchestrator was
supposed to use this instead of `ScheduleWakeup` + `status()` polling.

But: default `timeout_sec: 60`, cap `600`. Same MCP client `-32001`
timeout problem we hit with `ask_user` in v0.10.1/0.10.4 — the client
gives up at 60s without `resetTimeoutOnProgress: true` (which Claude
Desktop / Claude Code don't set). So a default invocation either
returns just before the client kills it (lucky) or errors out (more
likely). Either way the loop pattern is broken.

### The fix

Cap `timeout_sec` at **45s** (default 45, max 45). Same bound the v0.10.4
`ask_user` fix landed on. The tool's existing return shape already
supports the loop pattern (`changed: false, timed_out: true` →
caller re-invokes with the same `fingerprint`). Internally it polls
every 2s, so wake latency is ~2s after the actual event regardless of
which iteration of the loop we're in.

### How to use it

```ts
let result = wait_for_status_change(plan_id);  // first call, no fingerprint
while (!allTerminal(result)) {
  result = wait_for_status_change(plan_id, since_fingerprint: result.fingerprint);
  // returns within ~2s of any task transition, OR after 45s with unchanged state
}
```

Each call ≤45s, safely under MCP client timeout. Wake within ~2s of the
event itself. No ScheduleWakeup needed for fleet monitoring ever again.

### Migration

Callers that explicitly passed `timeout_sec > 45` now get capped at 45.
Their existing loop already re-invokes on `timed_out: true`, so no
behavior change beyond shorter round-trips.

## 0.10.5 — spawn_via_cli session-id reconciliation

### The bug exposed by the orqlaude self-test fleet d47c0448

Verdant (one of three Agnets in the fleet) bailed cleanly after 9 turns
having produced no PR. Investigation showed:

1. `spawn_via_cli` generated `session_id = 046dd37b` and passed it via
   `--session-id` to claude. It also wrote that id into
   `task.spawnedSessionId` BEFORE the agent started.
2. The agent's $CLAUDE_CODE_SESSION_ID env var (set by Claude Code itself)
   was `D0D521BB` — a DIFFERENT value.
3. The protocol-prompt footer told the agent to checkin with the env var.
4. `checkin` did `planForSession(state, "D0D521BB")` → undefined; tried
   `unclaimedTaskById(taskId)` → undefined because spawnedSessionId was
   already pre-allocated; fell through to `task_already_claimed` rejection.
5. Verdant correctly stopped to avoid duplicate work.

### Two-layer fix

**Fix 1 — Embed the pre-allocated session_id in the prompt.**
`buildSpawnPrompt` now takes an optional `sessionId` arg. When provided,
the protocol footer says `session_id: <uuid> (EXACT value, pre-allocated
by orqlaude — use this, NOT $CLAUDE_CODE_SESSION_ID)`. The
`spawn_via_cli` tool handler in `dispatch.ts` pre-generates the
session_id with `randomUUID()`, embeds it in the prompt, AND passes it
to `spawnAgnetViaCli` so the `--session-id` flag matches. Three places,
one value.

`SpawnViaCliInput` gained an optional `sessionId` field; the function
uses it if provided, falls back to `randomUUID()` otherwise (back-compat).

**Fix 2 — Defense-in-depth: checkin accepts session-id rotation for
fresh tasks.** If an agent shows up with `session_id = X` but the task
already has `spawnedSessionId = Y`, AND the task was spawned within the
last 60s, AND no notes have been posted for the task yet, accept the
rotation (update `spawnedSessionId = X`). This handles the case where
the prompt instruction was misread or the agent's first checkin happens
faster than expected. Once the agent has done real work (posted notes,
committed, etc.), a different session_id reverts to a hard conflict.

Both fixes are needed: fix 1 prevents the conflict in the happy case,
fix 2 covers stragglers + unknown future MCP host quirks.

### Tests

4 new tests in `v0105.test.ts` (source-level verification — the actual
spawn requires a real claude binary). 140 total, all green.

### Migration notes

No state migration. Old fleets in state (with the v0.10.4-and-earlier
session_id mismatch) continue to work because the bug only manifested
during the initial checkin. Existing running tasks proceed normally.

## 0.10.4 — bounded-block `ask_user` + `wait_for_user_response` companion

### Why v0.10.2's progress notifications didn't fix it

Found in the MCP TypeScript SDK source:

```js
if (timeoutInfo && responseHandler && timeoutInfo.resetTimeoutOnProgress) {
    this._resetTimeout(messageId);
}
```

The MCP client only resets its per-request timeout on `notifications/progress`
**if `resetTimeoutOnProgress: true` was passed when the request was made**.
Claude Desktop and Claude Code don't set this flag by default. So my v0.10.2
progress notifications were arriving at the client and being ignored for
timeout purposes. There's no way to force this from the server side.

Default `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000` (60s). Hard ceiling.

### The structural fix

Stop trying to outlast the host timeout. Instead:

- **`ask_user` blocks at most 45s** (the new `initial_block_sec`, capped at
  45). The question's overall lifetime is now `total_timeout_sec` (default
  900s) — that's how long the question stays answerable in state. The
  internal block is decoupled from the lifetime.
- If the user answers within 45s → `status: "answered"`.
- If they don't → `status: "still_pending"` with `short_id` and
  `remaining_sec`. **Caller must invoke `wait_for_user_response(short_id)`
  to keep waiting.**
- If `total_timeout_sec` passed → `status: "timed_out"`.

**New `wait_for_user_response(short_id, max_wait_sec=45)` tool** — block
another ≤45s polling state. Designed to be called in a loop:

```
result = ask_user(prompt, options, total_timeout_sec=1800)
while result.status === "still_pending":
    result = wait_for_user_response(result.short_id)
# now result.status is "answered" / "timed_out" / "cancelled"
```

Each MCP call is safely under the 60s host timeout. If the user is fast
(< 45s), one round-trip. If they take 5 minutes, ~7 round-trips. Each is
a single MCP call, no ScheduleWakeup-and-come-back-in-20-minutes pattern.

### Backwards compatibility

The arg rename `timeout_sec` → `total_timeout_sec` + `initial_block_sec`
is a breaking change for direct ask_user callers from v0.10.1-0.10.3. The
old default of 900s now means "the question stays answerable for 900s"
but ask_user itself returns within 45s. Primary Claude must adopt the new
loop pattern. Documented in the tool description.

Progress-notification code retained as best-effort — if a future MCP host
does enable `resetTimeoutOnProgress`, we already send them.

### Tests

All 136 v0.10.3 tests still green. The split architecture is hard to
unit-test (requires a real MCP transport for timeouts); integration test
plan: call ask_user, wait 30s without answering, confirm status="still_pending",
call wait_for_user_response, answer in Telegram during the wait, confirm
status="answered" returns within the second call.

## 0.10.3 — `findUserResponseRequest` now searches orphan requests too

The hidden bug that made `ask_user` *seem* broken even though everything
on the Telegram side was working.

### The bug

`ask_user` (and `request_user_response`) without a `plan_id` create a
request in `state.orphanResponseRequests` — the plan-less queue
introduced in v0.9.0 for session-level questions.

The user replies to the question in Telegram. `commands.ts`'s reply-to-
message handler correctly searches BOTH arrays (plan-attached + orphan),
finds the request, writes the response, and the bot confirms.

So far so good. BUT `findUserResponseRequest` in `state.ts` only
searched `plan.userResponseRequests`. That function is used by:

- `poll_user_response` — to read the answer
- `ask_user`'s own blocking poll loop — to detect "we have an answer"
- `commands.ts` `/respond` and `handleCallbackQuery` fallback paths

All four called the discovery function which had a blind spot, so the
answer was invisible from the MCP-server side even though it was sitting
in state. User reports: "I did answer; you didn't get it."

### The fix

Single-function change in `state.ts`: `findUserResponseRequest` now also
walks `state.orphanResponseRequests`, with plans taking precedence
(plan-attached match wins if there's a collision on shortId — vanishingly
unlikely with UUIDs but tested anyway). The return type changes from
`{plan, req}` to `{plan?, req}` because orphan requests have no parent.

All five existing callers destructure `{req}` only — none read `plan` —
so making it optional is non-breaking. Type-check confirms.

### Tests

2 new tests in `v0101.test.ts`:
1. `findUserResponseRequest` finds an orphan request by full id AND
   short id; returned `plan` is `undefined`.
2. Plan-attached requests take precedence over orphan in the unlikely
   shortId collision case; returned `plan` is present.

136 total, all green.

## 0.10.2 — MCP progress notifications keep `ask_user` alive past client timeout

### The bug v0.10.1 didn't catch

v0.10.1 introduced `ask_user` as a blocking MCP tool that holds the call
open for up to 15 minutes. Tested locally it worked great — but on the
first real call from Claude Desktop / Claude Code, MCP errored after ~60s
with `-32001 Request timed out`.

That's the MCP CLIENT's per-request timeout, not the server's. The MCP
spec lets clients abandon a request if no progress arrives within a
client-configured window. For long-running tools the server has to send
`notifications/progress` messages keyed to the request's `progressToken`
— each one resets the client's timeout window. Without progress, the
client kills the request before the server gets a chance to return.

### The fix

- **`audit.wrap` forwards the `extra` arg.** MCP SDK passes a second
  arg to tool handlers — `RequestHandlerExtra` — with `sendNotification`,
  `signal: AbortSignal`, `requestId`, and `_meta.progressToken`. The
  audit wrapper now passes this through. Single-arg handlers (the vast
  majority) keep working unchanged because the extra arg is optional.

- **`ask_user` sends progress every 25s.** Inside the block-poll loop
  we now check whether we've passed the 25s threshold since the last
  progress notification, and if so call `extra.sendNotification({
  method: "notifications/progress", params: { progressToken, progress,
  total, message } })`. Each one resets the MCP client's timeout window
  — 15min blocking now works.

- **`ask_user` watches `extra.signal.aborted`.** If the client gives
  up anyway (user cancel, transport close), we bail with
  `status: "client_aborted"` and surface the request_id so a later
  `poll_user_response` can pick up any answer that arrived in the
  meantime.

- **Backwards compatible.** Every other tool's handler is unchanged —
  they accept just `(args)`, ignoring the new optional `extra`. The
  type signature on `wrap` is `(args, extra?) => ...` so old call sites
  still type-check.

### Tests

All 134 v0.10.1 tests still green. The progress-notification path is
hard to unit-test without a real MCP transport, so it's covered by
integration: making a 90s `ask_user` call from a live Claude Desktop
session no longer times out.

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
