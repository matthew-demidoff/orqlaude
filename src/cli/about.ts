import { style } from "../lib/style.js";

/**
 * `orql about` — the easter egg. Print a small stylized "what is this"
 * blurb in the brand palette. Just because.
 */

export function showAbout(version: string): number {
  const lines = [
    "",
    `  ${style.coral("◆")} ${style.bold(style.coral("orqlaude"))}`,
    "",
    `  ${style.sand("one Claude session decomposes a task,")}`,
    `  ${style.sand("approves a budget,")}`,
    `  ${style.sand("dispatches a fleet of")} ${style.coral("Agnets")} ${style.sand("—")}`,
    `  ${style.sand("each in its own worktree, named, tracked,")}`,
    `  ${style.sand("brokered, budgeted, watchable.")}`,
    "",
    `  ${style.dim(`v${version} · MIT · @synaplink/orqlaude`)}`,
    "",
    `  ${style.cream("\"More agents working on a task in parallel is just")}`,
    `  ${style.cream("a faster way of reaching")} ${style.coral("the same insight")}.${style.cream("\"")}`,
    `  ${style.dim("— Claude (probably)")}`,
    "",
  ];
  process.stdout.write(lines.join("\n"));
  return 0;
}
