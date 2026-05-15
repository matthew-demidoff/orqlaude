import { runOrchTurn } from "./orch_turn.js";

/**
 * Telegram message classifier.
 *
 * v0.9 only listened for `/respond <short_id> <text>` — every other message
 * from the user was ignored. v0.10 makes the bot listen to EVERYTHING and
 * classify the intent so the daemon can route appropriately.
 *
 * Five intents:
 *   • new_task     — "let's build X next" / "we should also do Y"
 *                    → enqueue_goal
 *   • followup     — "actually make it green not blue" / "no, more like THIS"
 *                    → either post_note to a relevant in-flight task, OR
 *                      enqueue_goal if no fleet is currently in scope
 *   • kill         — "stop the analytics fleet" / "cancel" / "scrap it"
 *                    → request_stop or kill_task on matched plan
 *   • status       — "how's it going" / "any progress" / "pulse"
 *                    → fleet_summary → notify_user
 *   • chitchat     — pleasantries, off-topic, debugging the bot
 *                    → ack or ignore
 *
 * Plan-billed. The classifier turn is short (~150 output tokens) so it's
 * essentially free.
 */

export type TgIntent = "new_task" | "followup" | "kill" | "status" | "chitchat";

export interface TgClassifyInput {
  /** The user's message text. */
  text: string;
  /** Brief context — what's in flight, what's in the backlog. */
  context: {
    activePlans: Array<{ planId: string; rootTask: string; tasksRunning: number }>;
    backlogTopGoals: Array<{ shortId: string; title: string }>;
  };
}

export interface TgClassifyResult {
  intent: TgIntent;
  /** When intent=new_task: extracted title/priority. */
  newTask?: { title: string; description?: string; priority?: number };
  /** When intent=followup or kill: which plan_id we think this targets, if any. */
  targetPlanId?: string;
  /** When intent=followup: the note text to post. */
  noteText?: string;
  /** When intent=kill: hard vs soft. */
  killKind?: "hard" | "soft";
  /** Confidence 0-1. Below 0.6, daemon asks the user to confirm before acting. */
  confidence: number;
  rationale?: string;
}

export async function classifyTgMessage(input: TgClassifyInput): Promise<TgClassifyResult> {
  const ctxLines: string[] = [];
  if (input.context.activePlans.length === 0) {
    ctxLines.push("Active plans: (none)");
  } else {
    ctxLines.push("Active plans:");
    for (const p of input.context.activePlans) {
      ctxLines.push(`  - ${p.planId.slice(0, 8)} "${p.rootTask}" — ${p.tasksRunning} task(s) running`);
    }
  }
  if (input.context.backlogTopGoals.length === 0) {
    ctxLines.push("Backlog top goals: (empty)");
  } else {
    ctxLines.push("Backlog top goals:");
    for (const g of input.context.backlogTopGoals) {
      ctxLines.push(`  - ${g.shortId} "${g.title}"`);
    }
  }

  const prompt = `You are the routing classifier for an orchestrator's chat interface. The user sent a Telegram message. Decide what they want.

Context:
${ctxLines.join("\n")}

User message:
"""
${input.text}
"""

Output STRICT JSON, no prose:
{
  "intent": "new_task" | "followup" | "kill" | "status" | "chitchat",
  "confidence": number,            // 0..1
  "rationale": string,             // one short sentence
  "new_task": {                    // only when intent=new_task
    "title": string,               // <=150 chars
    "description": string,         // optional
    "priority": number             // 0..100, default 50
  },
  "target_plan_id": string,        // only for followup/kill; the 8-char plan-id prefix from context
  "note_text": string,             // only for followup — what to relay to the agent
  "kill_kind": "hard" | "soft"     // only for kill
}

Heuristics:
  • Short pleasantries ("ok", "thanks") → chitchat.
  • "stop / cancel / scrap" → kill (default soft unless they say "now" or "immediately" → hard).
  • "how's it going / status / pulse" → status.
  • "actually X / no, do Y instead / wait, change Z" → followup, target the most-recent active plan.
  • Anything that implies a new thing to build → new_task.

Begin JSON now.`;
  const result = await runOrchTurn({ prompt, model: "sonnet", timeoutMs: 60_000, expectJson: true });
  if (!result.ok || !result.parsedJson) {
    return { intent: "chitchat", confidence: 0.0, rationale: `classifier failed: ${result.parseError ?? "non-zero exit"}` };
  }
  const v = result.parsedJson as Partial<TgClassifyResult> & { new_task?: any; target_plan_id?: string; kill_kind?: any; note_text?: string };
  return {
    intent: (v.intent ?? "chitchat") as TgIntent,
    confidence: typeof v.confidence === "number" ? v.confidence : 0.5,
    rationale: v.rationale,
    newTask: v.new_task ? { title: v.new_task.title, description: v.new_task.description, priority: v.new_task.priority } : undefined,
    targetPlanId: v.target_plan_id,
    noteText: v.note_text,
    killKind: v.kill_kind as "hard" | "soft" | undefined,
  };
}

/**
 * Parse Telegram slash commands. Returns null if the message is not a slash
 * command — caller should fall through to classifyTgMessage.
 *
 * Supported slash commands (v0.10.0+):
 *   /now      — show what's actively running
 *   /queue    — show backlog
 *   /pause    — pause the autopilot daemon (it stops picking new goals)
 *   /resume   — unpause
 *   /morning  — daily digest (PRs merged yesterday, failures, what's next)
 *   /pulse    — same as /now but compact
 *   /budget   — show today's spend vs caps
 *   /respond  — legacy v0.4+ command for inline-keyboard responses
 */
export type TgSlashCommand =
  | { cmd: "now" }
  | { cmd: "queue" }
  | { cmd: "pause" }
  | { cmd: "resume" }
  | { cmd: "morning" }
  | { cmd: "pulse" }
  | { cmd: "budget" }
  | { cmd: "respond"; shortId: string; text: string };

export function parseSlashCommand(text: string): TgSlashCommand | null {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const [headRaw, ...rest] = t.split(/\s+/);
  const head = headRaw.toLowerCase().replace(/@.*$/, ""); // strip /now@orqlaudebot
  switch (head) {
    case "/now":
      return { cmd: "now" };
    case "/queue":
      return { cmd: "queue" };
    case "/pause":
      return { cmd: "pause" };
    case "/resume":
      return { cmd: "resume" };
    case "/morning":
      return { cmd: "morning" };
    case "/pulse":
      return { cmd: "pulse" };
    case "/budget":
      return { cmd: "budget" };
    case "/respond":
      if (rest.length < 2) return null;
      return { cmd: "respond", shortId: rest[0], text: rest.slice(1).join(" ") };
    default:
      return null;
  }
}
