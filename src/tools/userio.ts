import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { StateStore, findPlan, findUserResponseRequest, findUserStream } from "../lib/state.js";
import { probeTelegramStatus } from "../lib/telegram_status.js";
import { resolveStateDir } from "../lib/state_dir.js";
import { sleep } from "../lib/process_lib.js";
import type { AuditLog } from "../lib/audit.js";

/**
 * Broker-to-user tools (v0.4+).
 *
 * The other broker tools (send_message / post_note) only connect primary
 * Claude to spawned children. These three close the gap to the user:
 *
 *   notify_user           one-way push (Telegram), no response expected
 *   request_user_response push + await; user taps a button or replies
 *   poll_user_response    primary Claude polls for the answer
 *
 * Implementation: writes to plan.userNotifications / plan.userResponseRequests.
 * The Telegram notifier (separate process, `orqlaude tg start`) detects new
 * entries on its 5-second tick and pushes them. The bot listens for callback_query
 * updates and writes the response back into state.
 */

const URGENCY = z.enum(["low", "normal", "high"]);

export function registerUserIo(server: McpServer, store: StateStore, audit: AuditLog): void {
  // ---- notify_user ----------------------------------------------------------
  server.tool(
    "notify_user",
    "PRIMARY CLAUDE → USER (Telegram). One-way push of an arbitrary message to the user's whitelisted Telegram chats. The notifier picks it up on its next 5-second tick. v0.9.0: `plan_id` is now optional - omit it for session-startup pings or any standalone notification not tied to a fleet. Use for mid-fleet status updates the user might want to know about ('reviewer agent flagged 3 BLOCKERs', 'agent 2 finished early', 'budget at 80%'). Doesn't await a response - pair with request_user_response if you need one.",
    {
      plan_id: z.string().optional().describe("Optional plan id this notification belongs to. Omit for standalone session-level pings; v0.9.0+."),
      text: z.string().min(1).max(2000).describe("The message text. Will be Markdown-escaped before send. Keep concise."),
      urgency: URGENCY.default("normal").describe("Affects emoji prefix in the Telegram message. low → 💬, normal → 📢, high → 🚨."),
      task_id: z.string().optional().describe("Optional: attribute the notification to a specific task in the plan."),
    },
    audit.wrap(
      "notify_user",
      async ({ plan_id, text, urgency, task_id }) => {
        const result = await store.update((state) => {
          const note = {
            id: randomUUID(),
            taskId: task_id,
            text,
            urgency,
            createdAt: Date.now(),
            delivered: false,
          };
          if (plan_id) {
            const plan = findPlan(state, plan_id);
            plan.userNotifications.push(note);
          } else {
            state.orphanNotifications = state.orphanNotifications ?? [];
            state.orphanNotifications.push(note);
          }
          return {
            plan_id: plan_id ?? null,
            notification_id: note.id,
            scope: plan_id ? "plan" : "orphan",
          };
        });
        // v0.5.3+: probe Telegram status so the orchestrator knows whether
        // the notification will actually be delivered.
        const tg = await probeTelegramStatus(resolveStateDir().path);
        const willDeliver = tg.status === "active";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ...(result as object),
                  queued: true,
                  telegram_status: tg.status,
                  will_deliver: willDeliver,
                  delivery_note: willDeliver
                    ? "Notifier is active. Message should arrive within ~5s."
                    : `Telegram is ${tg.status}. ${tg.notes.join(" ")} If you need this message to reach the user, use AskUserQuestion as the in-chat fallback.`,
                },
                null,
                2
              ),
            },
          ],
        };
      },
      ({ plan_id }) => ({ planId: plan_id ?? "(orphan)" })
    )
  );

  // ---- ask_user (v0.10.4: bounded-block) -----------------------------------
  server.tool(
    "ask_user",
    "PRIMARY CLAUDE asks the user a question via Telegram and BLOCKS up to 45s waiting for the answer. v0.10.4: bounded block — MCP clients have a default 60s per-request timeout and won't extend it on progress notifications unless they explicitly set `resetTimeoutOnProgress: true` (Claude Desktop / Claude Code don't), so we cap internal blocking at 45s. If the user answers in that window → status:'answered'. If they don't → status:'still_pending' with a `short_id` — caller should immediately invoke `wait_for_user_response(short_id)` to keep waiting (each call extends another ≤45s). Inline keyboards still work; reply-to-message is still the primary path. PLAIN TEXT only — no Markdown.",
    {
      prompt: z.string().min(1).max(2000).describe("The question. PLAIN TEXT only — no Markdown. Newlines OK."),
      options: z.array(z.string().min(1).max(32)).max(8).optional().describe("Optional inline-keyboard quick-pick buttons (≤8, each ≤32 chars). User can tap one OR reply to the message — both work."),
      total_timeout_sec: z.number().int().positive().max(3600).default(900).describe("Overall question lifetime (when the request expires in state). Default 900s. After this the question becomes invisible to wait_for_user_response. Cap 3600s."),
      initial_block_sec: z.number().int().min(1).max(45).default(45).describe("How long ask_user itself blocks. Capped at 45s to stay under typical MCP-client timeouts. If the user hasn't answered in this window, returns status='still_pending' and caller should invoke wait_for_user_response(short_id)."),
      plan_id: z.string().optional().describe("Optional plan id to attach the question to. Omit for session-level questions (v0.9.0+ orphan path)."),
      task_id: z.string().optional(),
      poll_interval_ms: z.number().int().min(250).max(5000).default(750).describe("Internal poll cadence while blocking. Default 750ms."),
    },
    audit.wrap(
      "ask_user",
      async ({ prompt, options, total_timeout_sec, initial_block_sec, plan_id, task_id, poll_interval_ms }, extra) => {
        const id = randomUUID();
        const shortId = id.slice(0, 8);
        const timeoutAt = Date.now() + total_timeout_sec * 1000;
        const blockUntil = Date.now() + Math.min(initial_block_sec, 45) * 1000;
        const req = {
          id,
          shortId,
          taskId: task_id,
          prompt,
          options,
          createdAt: Date.now(),
          timeoutAt,
          delivered: false,
        };
        await store.update((state) => {
          if (plan_id) {
            const plan = findPlan(state, plan_id);
            plan.userResponseRequests.push(req);
          } else {
            state.orphanResponseRequests = state.orphanResponseRequests ?? [];
            state.orphanResponseRequests.push(req);
          }
        });
        const tg = await probeTelegramStatus(resolveStateDir().path);
        if (tg.status !== "active") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "unreachable",
                    short_id: shortId,
                    request_id: id,
                    telegram_status: tg.status,
                    note: `Telegram is ${tg.status}; not blocking. ${tg.notes.join(" ")} The question was still queued — use poll_user_response later if Telegram comes back, or fall back to AskUserQuestion.`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // v0.10.2: MCP host has a per-request timeout (often 60s). Send
        // `notifications/progress` every ~25s so the client resets its
        // timeout window — keeps the blocking call alive for the full
        // timeout_sec without the client cutting us off. The progressToken
        // is taken from the request meta; if the client didn't request
        // progress, we still send it (no-op, no harm). We also watch the
        // abort signal — if the client gives up anyway, bail cleanly.
        const e = extra as
          | {
              sendNotification?: (n: { method: string; params: Record<string, unknown> }) => Promise<void>;
              signal?: AbortSignal;
              _meta?: { progressToken?: string | number };
            }
          | undefined;
        const progressToken = e?._meta?.progressToken;
        const sendNotification = e?.sendNotification;
        const signal = e?.signal;
        const PROGRESS_INTERVAL_MS = 25_000;
        let lastProgressAt = Date.now();
        let progressCounter = 0;
        const tryProgress = async (): Promise<void> => {
          if (!sendNotification || progressToken === undefined) return;
          const now = Date.now();
          if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
          lastProgressAt = now;
          progressCounter += 1;
          try {
            await sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: Math.min(progressCounter, Math.floor(total_timeout_sec / 25)),
                total: Math.floor(total_timeout_sec / 25),
                message: `still waiting for user answer (${Math.round((Date.now() - req.createdAt) / 1000)}s / ${total_timeout_sec}s)`,
              },
            });
          } catch {
            // Best-effort. If the transport doesn't support progress, swallow.
          }
        };

        const interval = Math.max(250, Math.min(5000, poll_interval_ms));
        // Block up to MIN(initial_block_sec, total_timeout_sec). The cap at
        // 45s keeps us under typical MCP host timeouts.
        const stopAt = Math.min(blockUntil, timeoutAt);
        while (Date.now() < stopAt) {
          if (signal?.aborted) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      status: "client_aborted",
                      short_id: shortId,
                      request_id: id,
                      blocked_for_ms: Date.now() - req.createdAt,
                      note: "MCP client cancelled the request. The question is still in state — use wait_for_user_response or poll_user_response to retrieve any answer.",
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
          await sleep(interval);
          await tryProgress();
          const result = await store.read((state) => {
            const found = findUserResponseRequest(state, id);
            if (!found) return null;
            const { req: r } = found;
            if (r.cancelled) return { kind: "cancelled" as const };
            if (r.response !== undefined) {
              return {
                kind: "answered" as const,
                response: r.response,
                responded_at: r.respondedAt,
                delivered: r.delivered,
              };
            }
            return null;
          });
          if (result?.kind === "answered") {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      status: "answered",
                      short_id: shortId,
                      request_id: id,
                      response: result.response,
                      responded_at: result.responded_at,
                      blocked_for_ms: Date.now() - req.createdAt,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
          if (result?.kind === "cancelled") {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      status: "cancelled",
                      short_id: shortId,
                      request_id: id,
                      blocked_for_ms: Date.now() - req.createdAt,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        }
        // Differentiate "internal block ended, but the question is still
        // alive" vs "total_timeout_sec elapsed, question is dead".
        const stillAlive = Date.now() < timeoutAt;
        if (stillAlive) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "still_pending",
                    short_id: shortId,
                    request_id: id,
                    blocked_for_ms: Date.now() - req.createdAt,
                    remaining_sec: Math.max(0, Math.round((timeoutAt - Date.now()) / 1000)),
                    next_step: `User hasn't answered yet. Call wait_for_user_response('${shortId}') to block another ≤45s. Repeat until status flips to 'answered' or 'timed_out'.`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "timed_out",
                  short_id: shortId,
                  request_id: id,
                  total_timeout_sec,
                  note: "User didn't answer within the total timeout. The question record stays in state for audit but is no longer answerable.",
                },
                null,
                2
              ),
            },
          ],
        };
      },
      ({ plan_id }) => ({ planId: plan_id ?? "(ask_user)" })
    )
  );

  // ---- wait_for_user_response (v0.10.4+) -----------------------------------
  // Companion to ask_user — call this repeatedly when ask_user returned
  // status='still_pending'. Each call blocks up to max_wait_sec (≤45s) before
  // returning. Designed to stay under the MCP host timeout.
  server.tool(
    "wait_for_user_response",
    "Block waiting for a previously-issued question. v0.10.4+. Companion to ask_user — when ask_user returns status='still_pending', call this with the same short_id to keep waiting. Blocks up to `max_wait_sec` (capped at 45s to stay under MCP host timeout). Returns status='answered'|'still_pending'|'timed_out'|'cancelled'|'unknown'. Loop while status='still_pending'.",
    {
      short_id: z.string().describe("The short_id or full UUID from ask_user."),
      max_wait_sec: z.number().int().min(1).max(45).default(45).describe("Max block duration. Capped at 45s."),
      poll_interval_ms: z.number().int().min(250).max(5000).default(750),
    },
    audit.wrap(
      "wait_for_user_response",
      async ({ short_id, max_wait_sec, poll_interval_ms }, extra) => {
        const interval = Math.max(250, Math.min(5000, poll_interval_ms));
        const stopAt = Date.now() + Math.min(max_wait_sec, 45) * 1000;
        const startedAt = Date.now();
        const e = extra as { signal?: AbortSignal } | undefined;
        const signal = e?.signal;
        while (Date.now() < stopAt) {
          if (signal?.aborted) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    { status: "client_aborted", short_id, blocked_for_ms: Date.now() - startedAt },
                    null,
                    2
                  ),
                },
              ],
            };
          }
          await sleep(interval);
          const result = await store.read((state) => {
            const found = findUserResponseRequest(state, short_id);
            if (!found) return { kind: "unknown" as const };
            const { req: r } = found;
            if (r.cancelled) return { kind: "cancelled" as const };
            if (r.response !== undefined) {
              return {
                kind: "answered" as const,
                response: r.response,
                respondedAt: r.respondedAt,
                fullId: r.id,
              };
            }
            if (Date.now() > r.timeoutAt) {
              return { kind: "timed_out" as const, fullId: r.id };
            }
            return null;
          });
          if (!result) continue;
          if (result.kind === "answered") {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      status: "answered",
                      short_id,
                      request_id: result.fullId,
                      response: result.response,
                      responded_at: result.respondedAt,
                      blocked_for_ms: Date.now() - startedAt,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
          if (result.kind === "cancelled") {
            return {
              content: [{ type: "text", text: JSON.stringify({ status: "cancelled", short_id }, null, 2) }],
            };
          }
          if (result.kind === "timed_out") {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      status: "timed_out",
                      short_id,
                      request_id: result.fullId,
                      note: "Question's total_timeout_sec lifetime expired.",
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
          if (result.kind === "unknown") {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    { status: "unknown", short_id, note: "No request with that id/short_id." },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "still_pending",
                  short_id,
                  blocked_for_ms: Date.now() - startedAt,
                  next_step: `User hasn't answered yet. Call wait_for_user_response('${short_id}') again to block another ≤45s.`,
                },
                null,
                2
              ),
            },
          ],
        };
      },
      () => ({})
    )
  );

  // ---- request_user_response (legacy, non-blocking; kept for back-compat) --
  server.tool(
    "request_user_response",
    "PRIMARY CLAUDE asks the user a question via Telegram and awaits the response. If `options` is provided, the message has inline-keyboard buttons; otherwise the user is told to reply with `/respond <short_id> <text>`. Returns a `request_id` — poll it via `poll_user_response`. Times out after `timeout_sec` (default 600s = 10 min); if no response, status returns `timed_out`.",
    {
      plan_id: z.string(),
      prompt: z.string().min(1).max(2000).describe("The question to ask the user."),
      options: z.array(z.string().min(1).max(32)).max(8).optional().describe("Optional list of button labels (≤8, each ≤32 chars). If provided, Telegram shows an inline keyboard. If omitted, freeform reply expected."),
      timeout_sec: z.number().int().positive().max(3600).default(600).describe("Max seconds to wait. After this, poll returns `timed_out`. Default 600 (10 min); cap 3600 (1h)."),
      task_id: z.string().optional(),
    },
    audit.wrap(
      "request_user_response",
      async ({ plan_id, prompt, options, timeout_sec, task_id }) => {
        const result = await store.update((state) => {
          const plan = findPlan(state, plan_id);
          const id = randomUUID();
          const shortId = id.slice(0, 8);
          const req = {
            id,
            shortId,
            taskId: task_id,
            prompt,
            options,
            createdAt: Date.now(),
            timeoutAt: Date.now() + timeout_sec * 1000,
            delivered: false,
          };
          plan.userResponseRequests.push(req);
          return {
            plan_id,
            request_id: id,
            short_id: shortId,
            timeout_at: req.timeoutAt,
            has_options: Boolean(options && options.length > 0),
          };
        });
        const tg = await probeTelegramStatus(resolveStateDir().path);
        const reachable = tg.status === "active";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ...(result as object),
                  telegram_status: tg.status,
                  reachable,
                  next_step: reachable
                    ? "Poll `poll_user_response(request_id)` periodically. It returns status=`pending` until the user answers (or timeout)."
                    : `Telegram is ${tg.status}. The user cannot respond via Telegram right now. Either ${tg.notes[0] ?? "ensure the bot is running"}, OR fall back to AskUserQuestion for the in-chat surface.`,
                },
                null,
                2
              ),
            },
          ],
        };
      },
      ({ plan_id }) => ({ planId: plan_id })
    )
  );

  // ---- stream_to_user_start -------------------------------------------------
  server.tool(
    "stream_to_user_start",
    "PRIMARY CLAUDE → USER (Telegram), streaming. Open a streaming message: Telegram sends an initial message, and subsequent stream_to_user_append calls EDIT that same message to add content. The user sees a single message that grows in place — the Telegram equivalent of a streamed assistant reply. Returns a stream_id. Call stream_to_user_end when finished (the message gets a ✓ marker). Telegram rate-limits edits to ~1/1.5s; the notifier coalesces appends.",
    {
      plan_id: z.string(),
      title: z.string().min(1).max(120).describe("Bold header shown at the top of the message. E.g. 'Agnet Verdant — reviewing PR #42' or 'Fleet summary'."),
      initial_content: z.string().default("").describe("Optional starting content for the message body."),
      task_id: z.string().optional(),
    },
    audit.wrap(
      "stream_to_user_start",
      async ({ plan_id, title, initial_content, task_id }) => {
        const result = await store.update((state) => {
          const plan = findPlan(state, plan_id);
          const id = randomUUID();
          const shortId = id.slice(0, 8);
          plan.userStreams.push({
            id,
            shortId,
            taskId: task_id,
            title,
            content: initial_content,
            status: "active",
            createdAt: Date.now(),
          });
          return {
            plan_id,
            stream_id: id,
            short_id: shortId,
            next_step:
              "Call stream_to_user_append(stream_id, chunk_text) with each new chunk. Call stream_to_user_end(stream_id) when finished.",
          };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      ({ plan_id }) => ({ planId: plan_id })
    )
  );

  // ---- stream_to_user_append ------------------------------------------------
  server.tool(
    "stream_to_user_append",
    "Append a chunk to a streaming message previously opened with stream_to_user_start. The notifier will edit the corresponding Telegram message on its next tick (subject to a ~1.5s rate-limit coalesce). Returns the current full length for sanity-check; if content exceeds Telegram's 4096-char limit, further appends will be silently truncated until you start a new stream.",
    {
      stream_id: z.string().describe("Either the full UUID or the 8-char short_id."),
      chunk: z.string().min(1).max(4000).describe("The text to append. Plain text recommended; Markdown is allowed but escape special chars yourself."),
    },
    audit.wrap(
      "stream_to_user_append",
      async ({ stream_id, chunk }) => {
        const result = await store.update((state) => {
          const found = findUserStream(state, stream_id);
          if (!found) return { ok: false, note: "stream not found" };
          const { stream } = found;
          if (stream.status === "ended") return { ok: false, note: "stream already ended" };
          // Cap total content at Telegram's 4096-char limit (minus headroom
          // for the title + completion marker).
          const MAX = 3800;
          const room = Math.max(0, MAX - stream.content.length);
          stream.content += chunk.slice(0, room);
          return {
            ok: true,
            stream_id: stream.id,
            current_length: stream.content.length,
            truncated: chunk.length > room,
          };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      ({ stream_id }) => ({})
    )
  );

  // ---- stream_to_user_end ---------------------------------------------------
  server.tool(
    "stream_to_user_end",
    "Mark a streaming message complete. The notifier will do a final edit appending a ✓ marker to the Telegram message. No-op if the stream is already ended.",
    {
      stream_id: z.string(),
      final_chunk: z.string().optional().describe("Optional last bit of content to append before finalizing."),
    },
    audit.wrap(
      "stream_to_user_end",
      async ({ stream_id, final_chunk }) => {
        const result = await store.update((state) => {
          const found = findUserStream(state, stream_id);
          if (!found) return { ok: false, note: "stream not found" };
          const { stream } = found;
          if (stream.status === "ended") return { ok: true, note: "already ended" };
          if (final_chunk) {
            const MAX = 3800;
            const room = Math.max(0, MAX - stream.content.length);
            stream.content += final_chunk.slice(0, room);
          }
          stream.status = "ended";
          stream.endedAt = Date.now();
          return { ok: true, stream_id: stream.id };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      ({ stream_id }) => ({})
    )
  );

  // ---- poll_user_response ---------------------------------------------------
  server.tool(
    "poll_user_response",
    "Poll a previously-issued `request_user_response`. Returns `status: pending | answered | timed_out | cancelled` and the `response` text when answered. Safe to call repeatedly; no side effects.",
    {
      request_id: z.string().describe("Either the full UUID or the 8-char short_id returned by request_user_response."),
    },
    audit.wrap(
      "poll_user_response",
      async ({ request_id }) => {
        const result = await store.read((state) => {
          const found = findUserResponseRequest(state, request_id);
          if (!found) {
            return { request_id, status: "unknown", note: "No request with that id or short_id." };
          }
          const { req } = found;
          if (req.cancelled) return { request_id: req.id, status: "cancelled" };
          if (req.response !== undefined) {
            return {
              request_id: req.id,
              status: "answered",
              response: req.response,
              responded_at: req.respondedAt,
            };
          }
          if (Date.now() > req.timeoutAt) {
            return { request_id: req.id, status: "timed_out", timeout_at: req.timeoutAt };
          }
          return {
            request_id: req.id,
            status: "pending",
            delivered: req.delivered,
            timeout_at: req.timeoutAt,
            remaining_sec: Math.max(0, Math.round((req.timeoutAt - Date.now()) / 1000)),
          };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    )
  );
}
