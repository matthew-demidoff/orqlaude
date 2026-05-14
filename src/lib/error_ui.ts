import { style } from "./style.js";

/**
 * Friendly error / status renderers. Every CLI error should pair a one-line
 * "what's wrong" with a one-line "try this." That separates orqlaude from a
 * tool that just dumps a stack trace.
 *
 * Convention: result strings are returned (not console.logged) so callers
 * decide where to write — stdout for status, stderr for errors.
 */

export function errorLine(msg: string, suggestion?: string): string {
  const line = style.crimson(`✗ ${msg}`);
  if (!suggestion) return line + "\n";
  return line + "\n" + style.coral(`  → ${suggestion}`) + "\n";
}

export function successLine(msg: string): string {
  return style.bold(style.coral(`✓ ${msg}`)) + "\n";
}

export function warnLine(msg: string, suggestion?: string): string {
  const line = style.crimson(`⚠ ${msg}`);
  if (!suggestion) return line + "\n";
  return line + "\n" + style.coral(`  → ${suggestion}`) + "\n";
}

export function infoLine(msg: string): string {
  return style.cream(`ℹ ${msg}`) + "\n";
}

export function tipLine(msg: string): string {
  return style.coral(`  → ${msg}`) + "\n";
}

/**
 * Wrap an error from anywhere (state-store, fs, network) into a friendly
 * orqlaude error message + suggestion when we recognize a pattern.
 */
export function formatError(err: unknown): { message: string; suggestion?: string } {
  if (!(err instanceof Error)) return { message: String(err) };
  const m = err.message;
  if (m.includes("EACCES") || m.includes("EPERM")) {
    return {
      message: m,
      suggestion: "permission denied — check ORQLAUDE_STATE_DIR in your .mcp.json env block points at a writable path (try `orql setup`)",
    };
  }
  if (m.includes("ENOENT")) {
    return {
      message: m,
      suggestion: "missing path — verify the project root, or re-run `orql setup` to wire orqlaude correctly",
    };
  }
  if (m.toLowerCase().includes("plan not found")) {
    return { message: m, suggestion: "try `orql list` to see active plans" };
  }
  if (m.toLowerCase().includes("approval token")) {
    return { message: m, suggestion: "request_approval again to mint a fresh token" };
  }
  return { message: m };
}
