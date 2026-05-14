import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { StateStore, findPlan, findUserResponseRequest, findUserStream } from "../lib/state.js";
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
    "PRIMARY CLAUDE → USER (Telegram). One-way push of an arbitrary message to the user's whitelisted Telegram chats. The notifier picks it up on its next 5-second tick. Use for mid-fleet status updates the user might want to know about (e.g. 'reviewer agent flagged 3 BLOCKERs', 'agent 2 finished early', 'budget at 80%'). Doesn't await a response — pair with request_user_response if you need one.",
    {
      plan_id: z.string().describe("Plan id this notification belongs to (for filtering / context)."),
      text: z.string().min(1).max(2000).describe("The message text. Will be Markdown-escaped before send. Keep concise."),
      urgency: URGENCY.default("normal").describe("Affects emoji prefix in the Telegram message. low → 💬, normal → 📢, high → 🚨."),
      task_id: z.string().optional().describe("Optional: attribute the notification to a specific task in the plan."),
    },
    audit.wrap(
      "notify_user",
      async ({ plan_id, text, urgency, task_id }) => {
        const result = await store.update((state) => {
          const plan = findPlan(state, plan_id);
          const note = {
            id: randomUUID(),
            taskId: task_id,
            text,
            urgency,
            createdAt: Date.now(),
            delivered: false,
          };
          plan.userNotifications.push(note);
          return {
            plan_id,
            notification_id: note.id,
            queued: true,
            delivered_via_telegram: "pending — depends on `orqlaude tg start` running with at least one whitelisted user.",
          };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      ({ plan_id }) => ({ planId: plan_id })
    )
  );

  // ---- request_user_response -----------------------------------------------
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
            next_step:
              "Poll `poll_user_response(request_id)` periodically. It returns status=`pending` until the user answers (or timeout). If no Telegram bot is running, the user can't respond — fall back to AskUserQuestion.",
          };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
