/**
 * Agnet — the orqlaude term for a spawned worker (a portmanteau-cousin of
 * "agent", matching the orqlaude / Claude naming aesthetic).
 *
 * Each task in a plan gets a stable, human-friendly Agnet name like
 * "Agnet Zenith" or "Agnet Verdant". The name is:
 *   • deterministic per task_id (so the same task always gets the same
 *     name across MCP restarts);
 *   • unique within a plan (we linear-probe to avoid collisions);
 *   • picked from a curated list of ~32 single-word designations chosen for
 *     readability in chat surfaces.
 *
 * Names are stored on the Task at create_plan time and surfaced in:
 *   • CLI output (`orqlaude status` / `list`)
 *   • Telegram notifications (notifier prefixes events with "Agnet Zenith")
 *   • Tool responses (so primary Claude can refer to them by name in chat)
 */

import { createHash } from "node:crypto";

/** Curated single-word designations. Add freely; just don't shorten this list
 *  below 8 or so or collision avoidance starts to bite. */
const NAMES = [
  "Aegis",
  "Argent",
  "Azure",
  "Cipher",
  "Cobalt",
  "Crimson",
  "Drift",
  "Ember",
  "Glyph",
  "Halcyon",
  "Helix",
  "Indigo",
  "Juno",
  "Kestrel",
  "Lumen",
  "Onyx",
  "Pyrite",
  "Quartz",
  "Quill",
  "Raven",
  "Sable",
  "Sage",
  "Solstice",
  "Spire",
  "Tempest",
  "Umbral",
  "Velvet",
  "Verdant",
  "Vortex",
  "Wraith",
  "Yarrow",
  "Zenith",
  "Zephyr",
];

/** Stable per-id name selection. Salt with a small constant so two callers
 *  with the same id but different salts could disambiguate (not used today
 *  but reserved for review-fleet → parent-fleet name distinction). */
function hashIndex(seed: string, mod: number, salt = ""): number {
  const h = createHash("sha256").update(`${salt}:${seed}`).digest();
  return h.readUInt32BE(0) % mod;
}

/**
 * Pick an Agnet name for a task, avoiding any name in `taken`. If all 32
 * names are taken (huge fleet), append a numeric suffix.
 */
export function pickAgnetName(taskId: string, taken: Set<string>): string {
  for (let salt = 0; salt < NAMES.length; salt++) {
    const candidate = NAMES[hashIndex(taskId, NAMES.length, String(salt))];
    if (!taken.has(candidate)) return candidate;
  }
  // Pathological collision: append index.
  let i = 2;
  while (true) {
    const candidate = `${NAMES[hashIndex(taskId, NAMES.length, `n${i}`)]}-${i}`;
    if (!taken.has(candidate)) return candidate;
    i++;
  }
}

/** Format an Agnet for user-facing display: "Agnet Zenith". */
export function agnetLabel(name: string | undefined): string {
  if (!name) return "Agnet";
  return `Agnet ${name}`;
}

/** Two-letter monogram for compact CLI rendering: "Agnet Zenith" → "Ze". */
export function agnetMonogram(name: string | undefined): string {
  if (!name) return "??";
  return name.slice(0, 2);
}
