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

  // ---- ask_user (v0.10.1+, BLOCKING) ---------------------------------------
  server.tool(
    "ask_user",
    "PRIMARY CLAUDE asks the user a question via Telegram and BLOCKS until the user answers, the timeout hits, or the request is cancelled. Single round-trip — no polling. v0.10.1+. The bot sends the question with Telegram's native reply-UI focused; the user can reply directly to the message, OR tap an inline-keyboard button if `options` were provided. Returns `{status: 'answered'|'timed_out'|'cancelled'|'unreachable', response, responded_at}`. Default timeout 900s (15min); cap 3600 (1h). PLAIN TEXT only — never use Markdown in your prompt; the bot has stopped using parse_mode entirely (v0.10.1) because the parser was eating special chars and silently failing sends.",
    {
      prompt: z.string().min(1).max(2000).describe("The question. PLAIN TEXT only — no Markdown. Newlines OK."),
      options: z.array(z.string().min(1).max(32)).max(8).optional().describe("Optional inline-keyboard quick-pick buttons (≤8, each ≤32 chars). User can tap one OR reply to the message with freeform text — both paths work."),
      timeout_sec: z.number().int().positive().max(3600).default(900).describe("How long to BLOCK waiting. Default 900s (15 min). Cap 3600 (1h)."),
      plan_id: z.string().optional().describe("Optional plan id to attach the question to. Omit for session-level questions (v0.9.0+ orphan path)."),
      task_id: z.string().optional(),
      poll_interval_ms: z.number().int().min(250).max(5000).default(750).describe("Internal poll cadence while blocking. Default 750ms."),
    },
    audit.wrap(
      "ask_user",
      async ({ prompt, options, timeout_sec, plan_id, task_id, poll_interval_ms }, extra) => {
        const id = randomUUID();
        const shortId = id.slice(0, 8);
        const timeoutAt = Date.now() + timeout_sec * 1000;
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
                progress: Math.min(progressCounter, Math.floor(timeout_sec / 25)),
                total: Math.floor(timeout_sec / 25),
                message: `still waiting for user answer (${Math.round((Date.now() - req.createdAt) / 1000)}s / ${timeout_sec}s)`,
              },
            });
          } catch {
            // Best-effort. If the transport doesn't support progress, swallow.
          }
        };

        const interval = Math.max(250, Math.min(5000, poll_interval_ms));
        while (Date.now() < timeoutAt) {
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
                      note: "MCP client cancelled the request. The question is still in state — poll_user_response later to retrieve any answer.",
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
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "timed_out",
                  short_id: shortId,
                  request_id: id,
                  timeout_sec,
                  note: "User didn't answer within the timeout. The question is still in state — they can still answer, and you can pick it up via poll_user_response.",
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
