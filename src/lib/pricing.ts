/**
 * Per-model pricing as of model release.
 * Numbers are USD per 1M tokens. Update when Anthropic publishes new pricing.
 *
 * `estimateAgentCost` is intentionally rough — it assumes a single agent burns
 * roughly `baselineInputTokens` of system prompt + small per-turn user/tool
 * input and produces `baselineOutputTokens` of output across the run. Refine
 * by observing real runs and tuning the baselines.
 */

export interface Pricing {
  inputPer1M: number;
  outputPer1M: number;
  cacheWritePer1M: number;
  cacheReadPer1M: number;
}

export const MODEL_PRICING: Record<string, Pricing> = {
  // Defaults; conservative for estimation.
  "claude-opus-4-7": { inputPer1M: 15, outputPer1M: 75, cacheWritePer1M: 18.75, cacheReadPer1M: 1.5 },
  "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15, cacheWritePer1M: 3.75, cacheReadPer1M: 0.3 },
  "claude-haiku-4-5": { inputPer1M: 1, outputPer1M: 5, cacheWritePer1M: 1.25, cacheReadPer1M: 0.1 },
  // Fallback for unrecognized models.
  default: { inputPer1M: 3, outputPer1M: 15, cacheWritePer1M: 3.75, cacheReadPer1M: 0.3 },
};

function pricingFor(model: string): Pricing {
  // Strip date suffix (e.g. "-20251001") and any [1m] context-window suffix.
  const stripped = model.replace(/-\d{8}.*$/, "").replace(/\[[^\]]+\]$/, "");
  return MODEL_PRICING[stripped] ?? MODEL_PRICING[model] ?? MODEL_PRICING.default;
}

/**
 * Rough cost estimate for one agent running a sub-task.
 *
 * Defaults assume a moderate task (~10 turns of reading/editing). Tune via the
 * `effortMultiplier` argument: 0.5 for trivial, 1.0 for moderate, 2.0+ for
 * heavy refactors. This estimate is a budgeting safety net, not a forecast.
 */
export function estimateAgentCost(model: string, effortMultiplier = 1): number {
  const p = pricingFor(model);
  // Baselines tuned to match an empirical haiku run we observed: ~30k cache-creation tokens, ~10 input, ~45 output → $0.038.
  // Scale by multiplier and adjust output baseline upward for real work.
  const cacheCreate = 30_000 * effortMultiplier;
  const input = 1_000 * effortMultiplier;
  const cacheRead = 50_000 * effortMultiplier; // most input tokens are cached after first turn
  const output = 4_000 * effortMultiplier;
  return (
    (cacheCreate * p.cacheWritePer1M) / 1_000_000 +
    (input * p.inputPer1M) / 1_000_000 +
    (cacheRead * p.cacheReadPer1M) / 1_000_000 +
    (output * p.outputPer1M) / 1_000_000
  );
}
