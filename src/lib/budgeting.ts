import { promises as fs } from "node:fs";
import path from "node:path";
import { MODEL_PRICING, estimateAgentCost } from "./pricing.js";

/**
 * Token-based budgeting (Max x20 friendly).
 *
 * Max-plan users care about their daily/weekly token bucket, not USD. The
 * Claude Desktop app already tracks daily usage in:
 *   ~/Library/Application Support/Claude/buddy-tokens.json
 *
 * We read that file to surface remaining quota, and we let the user set a
 * per-fleet token cap. USD remains tracked (and shown informationally) because
 * it's a useful sanity check for runaway agents and because not every user is
 * on Max — but token caps are the primary enforcement mechanism.
 */

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "";
const BUDDY_TOKENS_PATH = path.join(
  HOME,
  "Library",
  "Application Support",
  "Claude",
  "buddy-tokens.json"
);

export interface DailyTokenUsage {
  date: string; // YYYY-MM-DD
  tokens: number;
}

/**
 * Read the Desktop app's daily token tally. Returns null if file missing
 * (e.g. user isn't on the Desktop app). Safe to call repeatedly; the file is
 * small and disk-resident.
 */
export async function readDailyTokenUsage(): Promise<DailyTokenUsage | null> {
  try {
    const raw = await fs.readFile(BUDDY_TOKENS_PATH, "utf8");
    const parsed = JSON.parse(raw) as { "tokens-today"?: DailyTokenUsage };
    return parsed["tokens-today"] ?? null;
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Rough token estimate per agent for a sub-task. Mirrors estimateAgentCost
 * but in tokens so it composes with a token-based cap.
 *
 * Baselines tuned to one Haiku probe (~30k cache-creation + ~50k cache-read
 * over the run + ~4k output ≈ 84k effective tokens). Tune as we collect more.
 */
export function estimateAgentTokens(effortMultiplier = 1): {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  totalEffective: number;
} {
  const e = effortMultiplier;
  const cacheCreate = Math.round(30_000 * e);
  const input = Math.round(1_000 * e);
  const cacheRead = Math.round(50_000 * e);
  const output = Math.round(4_000 * e);
  // "totalEffective" approximates buddy-bucket consumption; the Desktop app's
  // accounting collapses everything into one counter so we sum without
  // weighting.
  return {
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreate,
    outputTokens: output,
    totalEffective: input + cacheRead + cacheCreate + output,
  };
}

/** Convenience: compute USD cost AND token estimate together. */
export function estimateAgent(model: string, effortMultiplier = 1) {
  return {
    tokens: estimateAgentTokens(effortMultiplier),
    costUsd: estimateAgentCost(model, effortMultiplier),
  };
}

export { MODEL_PRICING };
