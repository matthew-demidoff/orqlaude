import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  StateStore,
  planForSession,
  findPlan,
  unclaimedTaskById,
  normalizeClaimPath,
} from "../lib/state.js";
import type { AuditLog } from "../lib/audit.js";

/**
 * Broker tools.
 *
 * v0.2.0:
 *  • `checkin` accepts an optional `task_id`. If the session is not yet
 *    registered AND task_id matches a dispatched-but-unclaimed task, the
 *    session self-registers. This removes the manual register_spawn step.
 *  • New `claim_files` and `release_files` tools for cross-agent file
 *    ownership. Conflicting claims are returned to the caller (and surfaced
 *    to the primary Claude through the next status() call).
 */

export function registerBroker(server: McpServer, store: StateStore, audit: AuditLog): void {
  // ---- checkin (child → orqlaude) ------------------------------------------
  server.tool(
    "checkin",
    "Called BY A SPAWNED AGENT. Two purposes: (1) on your FIRST turn, pass your own session_id AND task_id (from the prompt) to self-register. (2) on subsequent turns, pass only session_id to pull queued messages and check ack status. Returns messages (possibly empty), STOP signal status, and ack state of any blocking notes you posted.",
    {
      session_id: z.string().describe("Your own session id. Read from $CLAUDE_CODE_SESSION_ID or the prompt."),
      task_id: z.string().optional().describe("Pass this ONCE on your first checkin to self-register against your task. The prompt you received contains it as `task_id: ...`."),
    },
    audit.wrap(
      "checkin",
      async ({ session_id, task_id }) => {
        const result = await store.update((state) => {
          // Already-registered session?
          let found = planForSession(state, session_id);
          let selfRegistered = false;
          // v0.5.3+: conflict detection. If the caller's session is already
          // bound to a task BUT they passed a different task_id from their
          // prompt, surface that as a hard error — silently mis-binding wastes
          // the work because collect() will attribute it to the wrong task.
          if (found && task_id && found.task.id !== task_id) {
            return {
              registered: true,
              conflict: {
                kind: "session_task_mismatch",
                prompt_task_id: task_id,
                registered_task_id: found.task.id,
                registered_task_title: found.task.title,
                explanation:
                  "Your session is bound to a different task than the task_id in your prompt. Likely cause: the orchestrator generated your prompt from a stale next_task call, OR two Agnets accidentally received the same prompt. orqlaude is sticking with your session's existing registration — flag this to the orchestrator immediately via post_note.",
              },
              plan_id: found.plan.id,
              task_id: found.task.id,
              task_title: found.task.title,
              messages: [],
              stop_signal: null,
              blocking_notes_acked: [],
              guidance:
                "STOP your current work and post_note the conflict to the orchestrator. Don't proceed — your output will be attributed to the wrong task in collect().",
            };
          }
          // First-turn self-registration path.
          if (!found && task_id) {
            const target = unclaimedTaskById(state, task_id);
            if (target) {
              target.task.spawnedSessionId = session_id;
              target.task.status = "running";
              found = target;
              selfRegistered = true;
            } else {
              // v0.5.3+: surface why we couldn't claim — is the task already
              // owned by someone else, or doesn't exist at all?
              const anyMatch = Object.values(state.plans)
                .flatMap((p) => p.tasks)
                .find((t) => t.id === task_id);
              if (anyMatch && anyMatch.spawnedSessionId) {
                // v0.10.5+: defense-in-depth for session-id rotation.
                // spawn_via_cli pre-allocates a session_id and writes it
                // into task.spawnedSessionId BEFORE the agent starts. If
                // the agent's checkin arrives with a different session_id
                // AND the task has no recorded activity yet (no
                // last_activity_at, no notes, no commit), treat this as
                // "the spawned process resolved its session_id differently
                // than orqlaude pre-allocated" and accept the rotation.
                // The window is narrow: once the agent has done any work,
                // a different session_id IS a genuine conflict.
                //
                // We detect "fresh task" by checking startedAt minus a 60s
                // grace window AND no posted notes from this task.
                const wasJustSpawned =
                  anyMatch.startedAt !== undefined && Date.now() - anyMatch.startedAt < 60_000;
                const noNotesYet = !Object.values(state.plans)
                  .flatMap((p) => p.notes)
                  .some((n) => n.taskId === task_id);
                if (wasJustSpawned && noNotesYet) {
                  // Rotate the spawnedSessionId to what the agent reports.
                  // This is safe because the task_id is a UUID known only
                  // to the legitimately-spawned agent (orqlaude writes it
                  // into the prompt + .orqlaude.mcp.json which only the
                  // child process can read).
                  anyMatch.spawnedSessionId = session_id;
                  // Walk plans to set `found` properly.
                  for (const p of Object.values(state.plans)) {
                    if (p.tasks.some((t) => t.id === task_id)) {
                      found = { plan: p, task: anyMatch };
                      break;
                    }
                  }
                  selfRegistered = true;
                } else {
                  return {
                    registered: false,
                    conflict: {
                      kind: "task_already_claimed",
                      task_id,
                      claimed_by_session: anyMatch.spawnedSessionId,
                      task_title: anyMatch.title,
                      explanation: `Task ${task_id} is already claimed by session ${anyMatch.spawnedSessionId}. Your prompt's task_id is stale or duplicated — flag it to the orchestrator.`,
                    },
                    messages: [],
                    stop_signal: null,
                    blocking_notes_acked: [],
                    guidance: "STOP and post_note to the orchestrator. Don't do work that won't be tracked.",
                  };
                }
              }
            }
          }
          if (!found) {
            return {
              registered: false,
              note: task_id
                ? "task_id provided but no matching unclaimed task. Either the plan moved on or the id was never registered (e.g. orchestrator forgot to call next_task)."
                : "This session is not registered. On your first checkin, pass your task_id too (it's in the prompt under 'task_id:').",
              messages: [],
              stop_signal: null,
              blocking_notes_acked: [],
            };
          }
          const { plan, task } = found;
          // Deliver queued messages, partitioning by kind.
          const pending = plan.messages.filter((m) => m.toSessionId === session_id && !m.delivered);
          let hardStop: { reason: string; at: number } | null = null;
          let softStop: { reason: string; at: number } | null = null;
          for (const m of pending) {
            m.delivered = true;
            m.deliveredAt = Date.now();
            if (m.kind === "stop") hardStop = { reason: m.text, at: m.queuedAt };
            else if (m.kind === "soft_stop") softStop = { reason: m.text, at: m.queuedAt };
          }
          // Task-level flag is the source of truth if no message yet picked up.
          if (!hardStop && !softStop && task.stopRequested) {
            const where = { reason: task.stopRequested.reason, at: task.stopRequested.requestedAt };
            if (task.stopRequested.kind === "soft") softStop = where;
            else hardStop = where;
          }
          const myBlocking = plan.notes.filter((n) => n.fromSessionId === session_id && n.blocking);
          return {
            registered: true,
            self_registered: selfRegistered,
            plan_id: plan.id,
            task_id: task.id,
            task_title: task.title,
            messages: pending
              .filter((m) => m.kind !== "stop" && m.kind !== "soft_stop")
              .map((m) => ({ id: m.id, text: m.text, from_task: m.fromTaskId ?? null, queued_at: m.queuedAt })),
            stop_signal: hardStop,        // legacy field; was the only one in v0.3.x
            hard_stop: hardStop,
            soft_stop: softStop,
            blocking_notes_acked: myBlocking.map((n) => ({ id: n.id, acked: n.acked })),
            guidance: hardStop
              ? "HARD STOP received — commit what you have and exit immediately."
              : softStop
              ? "Soft stop received — finish your current operation, commit, push, open PR, then exit."
              : selfRegistered
              ? "Registered with the orchestrator. Now do your task."
              : "Carry on.",
          };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      ({ session_id }) => ({ sessionId: session_id })
    )
  );

  // ---- post_note (child → orqlaude) ----------------------------------------
  server.tool(
    "post_note",
    "Called BY A SPAWNED AGENT to share a finding or report a PR URL. Set `blocking: true` only when you must pause until the primary Claude acks. Setting `pr_url` attaches it to your task for `collect`.",
    {
      session_id: z.string(),
      text: z.string().min(1),
      blocking: z.boolean().default(false),
      pr_url: z.string().url().optional(),
    },
    audit.wrap(
      "post_note",
      async ({ session_id, text, blocking, pr_url }) => {
        const result = await store.update((state) => {
          const found = planForSession(state, session_id);
          if (!found) return { posted: false, note: "Session not registered. Run checkin with task_id first." };
          const { plan, task } = found;
          const note = {
            id: randomUUID(),
            fromSessionId: session_id,
            taskId: task.id,
            text,
            blocking,
            postedAt: Date.now(),
            acked: false,
            prUrl: pr_url,
          };
          plan.notes.push(note);
          if (pr_url) task.prUrl = pr_url;
          return {
            posted: true,
            note_id: note.id,
            blocking,
            guidance: blocking
              ? "Now call `checkin` periodically until your note appears in blocking_notes_acked with acked=true."
              : "Note queued. Continue.",
          };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      ({ session_id }) => ({ sessionId: session_id })
    )
  );

  // ---- claim_files (child → orqlaude) --------------------------------------
  server.tool(
    "claim_files",
    "Called BY A SPAWNED AGENT to register intent to edit specific files. Returns existing conflicting claims by other sessions; the caller decides whether to coordinate (via post_note) or proceed anyway. Paths can be absolute or relative; relative paths are resolved against the orqlaude server's cwd (the project root).",
    {
      session_id: z.string(),
      paths: z.array(z.string().min(1)).min(1),
      reason: z.string().optional().describe("Optional human-readable reason for the claim, surfaced to other agents."),
    },
    audit.wrap(
      "claim_files",
      async ({ session_id, paths, reason }) => {
        const result = await store.update((state) => {
          const found = planForSession(state, session_id);
          if (!found) return { claimed: [], conflicts: [], note: "Session not registered." };
          const { plan, task } = found;
          const cwd = process.cwd();
          const conflicts: Array<{ path: string; claimedBy: string; taskId: string; reason?: string }> = [];
          const claimed: string[] = [];
          for (const raw of paths) {
            const normalized = normalizeClaimPath(raw, cwd);
            const existing = plan.claims.find((c) => c.path === normalized && c.claimedBy !== session_id);
            if (existing) {
              conflicts.push({
                path: normalized,
                claimedBy: existing.claimedBy,
                taskId: existing.taskId,
                reason: existing.reason,
              });
              continue;
            }
            const already = plan.claims.find((c) => c.path === normalized && c.claimedBy === session_id);
            if (!already) {
              plan.claims.push({
                path: normalized,
                claimedBy: session_id,
                taskId: task.id,
                reason,
                claimedAt: Date.now(),
              });
            }
            claimed.push(normalized);
          }
          return {
            claimed,
            conflicts,
            guidance: conflicts.length > 0
              ? "Conflicts found. Consider post_note(blocking=true) to coordinate, or release_files if you don't actually need these paths."
              : "Claims registered. Other agents will see them.",
          };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      ({ session_id }) => ({ sessionId: session_id })
    )
  );

  // ---- release_files (child → orqlaude) ------------------------------------
  server.tool(
    "release_files",
    "Called BY A SPAWNED AGENT to release file claims after finishing edits (or if you decide not to touch them).",
    {
      session_id: z.string(),
      paths: z.array(z.string().min(1)).min(1),
    },
    audit.wrap(
      "release_files",
      async ({ session_id, paths }) => {
        const result = await store.update((state) => {
          const found = planForSession(state, session_id);
          if (!found) return { released: 0, note: "Session not registered." };
          const { plan } = found;
          const cwd = process.cwd();
          const normalized = new Set(paths.map((p) => normalizeClaimPath(p, cwd)));
          const before = plan.claims.length;
          plan.claims = plan.claims.filter((c) => !(c.claimedBy === session_id && normalized.has(c.path)));
          return { released: before - plan.claims.length };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      ({ session_id }) => ({ sessionId: session_id })
    )
  );

  // ---- poll_notes (primary Claude → orqlaude) ------------------------------
  server.tool(
    "poll_notes",
    "Called BY PRIMARY CLAUDE to read notes posted by fleet agents. Returns notes since `since_ts` (or all). Pass `mark_acked` to ack blocking notes — that unblocks the posting agent on its next checkin.",
    {
      plan_id: z.string(),
      since_ts: z.number().optional(),
      mark_acked: z.array(z.string()).optional(),
    },
    audit.wrap(
      "poll_notes",
      async ({ plan_id, since_ts, mark_acked }) => {
        const result = await store.update((state) => {
          const plan = findPlan(state, plan_id);
          if (mark_acked) {
            for (const id of mark_acked) {
              const n = plan.notes.find((x) => x.id === id);
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
              pr_url: n.prUrl ?? null,
            }));
          return { plan_id, notes };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      ({ plan_id }) => ({ planId: plan_id })
    )
  );

  // ---- send_message (primary Claude → child) -------------------------------
  server.tool(
    "send_message",
    "Called BY PRIMARY CLAUDE to queue a directed message for a child agent. Delivered on its next checkin. Set `kind: 'stop'` to signal that the agent should commit-and-exit.",
    {
      plan_id: z.string(),
      to_session_id: z.string(),
      text: z.string().min(1),
      from_task_id: z.string().optional(),
      kind: z.enum(["directed", "stop"]).default("directed"),
    },
    audit.wrap(
      "send_message",
      async ({ plan_id, to_session_id, text, from_task_id, kind }) => {
        const result = await store.update((state) => {
          const plan = findPlan(state, plan_id);
          plan.messages.push({
            id: randomUUID(),
            toSessionId: to_session_id,
            fromTaskId: from_task_id,
            text,
            queuedAt: Date.now(),
            delivered: false,
            kind,
          });
          if (kind === "stop") {
            const task = plan.tasks.find((t) => t.spawnedSessionId === to_session_id);
            if (task) task.stopRequested = { reason: text, requestedAt: Date.now(), kind: "hard" };
          }
          return { plan_id, queued: true, kind };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
      ({ plan_id }) => ({ planId: plan_id })
    )
  );
}
