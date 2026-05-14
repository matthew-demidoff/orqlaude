import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { style } from "./style.js";
import { StateStore } from "./state.js";

/**
 * Interactive plan picker for commands like `orql status` / `orql show`
 * called without a plan id. Renders a numbered list, the user types a
 * number, we return the plan id.
 */

export async function pickPlanId(stateDir: string, includeCollected = false): Promise<string | null> {
  const store = new StateStore(stateDir);
  const plans = await store.read((s) =>
    Object.values(s.plans)
      .filter((p) => includeCollected || p.status !== "collected")
      .sort((a, b) => b.createdAt - a.createdAt)
  );
  if (plans.length === 0) {
    process.stdout.write(style.sand("No plans yet in this project.\n"));
    return null;
  }
  if (plans.length === 1) {
    // Single-choice; auto-select with a hint.
    process.stdout.write(style.dim(`(auto-selected the only plan: ${plans[0].id.slice(0, 8)})\n`));
    return plans[0].id;
  }
  process.stdout.write("\n" + style.bold(style.cream("Pick a plan:")) + "\n");
  plans.forEach((p, i) => {
    const done = p.tasks.filter((t) => t.status === "done").length;
    const tag = `${style.coral(String(i + 1).padStart(2))}.`;
    const id = style.dim(p.id.slice(0, 8));
    const status = style.sand(p.status.padEnd(14));
    const progress = `${done}/${p.tasks.length}`;
    process.stdout.write(`  ${tag} ${id}  ${status}  ${progress}  ${truncate(p.rootTask, 50)}\n`);
  });
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ans = (await rl.question(`\n  ${style.coral("?")} number (or q to cancel): `)).trim();
  rl.close();
  if (!ans || ans.toLowerCase() === "q") return null;
  const n = parseInt(ans, 10);
  if (!Number.isFinite(n) || n < 1 || n > plans.length) {
    process.stderr.write(style.crimson(`✗ "${ans}" isn't a valid choice\n`));
    return null;
  }
  return plans[n - 1].id;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
