import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { StateStore, planForSession, findPlan } from "../lib/state.js";

/**
 * Broker tools: cross-agent communication, mediated by the primary Claude.
 *
 *   Child agents call:
 *     - `checkin`     → pull queued messages targeted at them, ack notes they posted
 *     - `post_note`   → share findings with the primary Claude (and indirectly siblings)
 *
 *   Primary Claude calls:
 *     - `poll_notes`     → read all notes posted since last poll
 *     - `send_message`   → queue a directed message for delivery on a child's next checkin
 *
 * The model is pull-based: messages and acks arrive on the child's next
 * `checkin`. Children should call checkin periodically (every few turns).
 * Blocking notes pause the poster until an ack arrives.
 */

export function registerBroker(server: McpServer, store: StateStore): void {
  // ---- checkin (child → orqlaude) ------------------------------------------
  server.tool(
    "checkin",
    "Called BY A SPAWNED AGENT to pull queued messages from the primary Claude and ack any blocking notes you posted. Returns a list of messages (possibly empty) and whether your blocking notes have been acked. Call this every few turns, especially after posting a blocking note.",
    {
      session_id: z.string().describe("Your own session id (you can read it from your environment via $CLAUDE_CODE_SESSION_ID, or you were told it when spawned)."),
    },
    async ({ session_id }) => {
      const result = await store.update((state) => {
        const found = planForSession(state, session_id);
        if (!found) {
          return {
            registered: false,
            note: "This session is not registered with orqlaude. The primary Claude likely hasn't called register_spawn yet. Try again in a moment.",
            messages: [],
            blocking_notes_acked: [],
          };
        }
        const { plan, task } = found;
        // Pull undelivered messages.
        const pending = plan.messages.filter((m) => m.toSessionId === session_id && !m.delivered);
        for (const m of pending) {
          m.delivered = true;
          m.deliveredAt = Date.now();
        }
        // Report ack state of this agent's blocking notes.
        const myBlockingNotes = plan.notes.filter((n) => n.fromSessionId === session_id && n.blocking);
        return {
          registered: true,
          plan_id: plan.id,
          task_id: task.id,
          messages: pending.map((m) => ({
            id: m.id,
            text: m.text,
            from_task: m.fromTaskId ?? null,
            queued_at: m.queuedAt,
          })),
          blocking_notes_acked: myBlockingNotes.map((n) => ({ id: n.id, acked: n.acked })),
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ---- post_note (child → orqlaude) ----------------------------------------
  server.tool(
    "post_note",
    "Called BY A SPAWNED AGENT to share a finding or signal the PR URL on completion. Set `blocking: true` only if you must pause until the primary Claude acks. Use sparingly. If posting a PR URL, set `pr_url` so orqlaude attaches it to your task.",
    {
      session_id: z.string().describe("Your session id."),
      text: z.string().min(1).describe("The note. Keep concise. Example: 'Found that UserSchema.email is now nullable; agents touching auth should be aware.'"),
      blocking: z.boolean().default(false).describe("If true, you should pause and call `checkin` until you see this note in `blocking_notes_acked` with acked=true."),
      pr_url: z.string().url().optional().describe("If posting your completion, include the PR URL here so orqlaude.collect picks it up."),
    },
    async ({ session_id, text, blocking, pr_url }) => {
      const result = await store.update((state) => {
        const found = planForSession(state, session_id);
        if (!found) {
          return { posted: false, note: "Session not registered with orqlaude." };
        }
        const { plan, task } = found;
        const note = {
          id: randomUUID(),
          fromSessionId: session_id,
          taskId: task.id,
          text,
          blocking,
          postedAt: Date.now(),
          acked: false,
        };
        plan.notes.push(note);
        if (pr_url) {
          task.prUrl = pr_url;
        }
        return {
          posted: true,
          note_id: note.id,
          blocking,
          guidance: blocking
            ? "Now call `checkin` periodically until your note appears in blocking_notes_acked with acked=true."
            : "Note delivered to broker queue. Continue your work.",
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ---- poll_notes (primary Claude → orqlaude) ------------------------------
  server.tool(
    "poll_notes",
    "Called BY PRIMARY CLAUDE to read all notes posted by fleet agents. Returns notes since the last poll (or all if first call). Set `mark_acked: true` to ack blocking notes — that unblocks the posting agent on its next checkin.",
    {
      plan_id: z.string(),
      since_ts: z.number().optional().describe("Optional ms-epoch cutoff. If omitted, returns all unacked notes plus any not-yet-seen ones."),
      mark_acked: z.array(z.string()).optional().describe("Note ids to mark as acked (unblocks blocking posters)."),
    },
    async ({ plan_id, since_ts, mark_acked }) => {
      const result = await store.update((state) => {
        const plan = findPlan(state, plan_id);
        if (mark_acked && mark_acked.length > 0) {
          for (const noteId of mark_acked) {
            const n = plan.notes.find((x) => x.id === noteId);
            if (n) n.acked = true;
          }
        }
        const cutoff = since_ts ?? 0;
        const notes = plan.notes
          .filter((n) => n.postedAt >= cutoff)
          .map((n) => ({
            id: n.id,
            from_task_id: n.taskId,
            from_session_id: n.fromSessionId,
            text: n.text,
            blocking: n.blocking,
            acked: n.acked,
            posted_at: n.postedAt,
          }));
        return { plan_id, notes };
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ---- send_message (primary Claude → child) -------------------------------
  server.tool(
    "send_message",
    "Called BY PRIMARY CLAUDE to queue a directed message for a child agent. Delivered on the child's next `checkin`. Use this for cross-cutting heads-up like 'agent B changed the auth schema; here's the new signature'.",
    {
      plan_id: z.string(),
      to_session_id: z.string().describe("Target child session id."),
      text: z.string().min(1),
      from_task_id: z.string().optional().describe("Optional: which sibling this message is about (for attribution)."),
    },
    async ({ plan_id, to_session_id, text, from_task_id }) => {
      const result = await store.update((state) => {
        const plan = findPlan(state, plan_id);
        const msg = {
          id: randomUUID(),
          toSessionId: to_session_id,
          fromTaskId: from_task_id,
          text,
          queuedAt: Date.now(),
          delivered: false,
        };
        plan.messages.push(msg);
        return { plan_id, message_id: msg.id, queued: true };
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
