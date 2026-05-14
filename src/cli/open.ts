import { execSync } from "node:child_process";
import { StateStore } from "../lib/state.js";
import { style } from "../lib/style.js";

/**
 * `orql open <plan_id>` — open every PR URL the fleet produced in the
 * default browser, plus print worktree paths for tasks that don't yet
 * have PRs.
 */

export async function openPlan(stateDir: string, planId: string): Promise<number> {
  const store = new StateStore(stateDir);
  let plan;
  try {
    plan = await store.read((s) => {
      const p = s.plans[planId] ?? Object.values(s.plans).find((x) => x.id.startsWith(planId));
      if (!p) throw new Error(`Plan not found: ${planId}`);
      return p;
    });
  } catch (err) {
    process.stderr.write(style.crimson(`✗ ${(err as Error).message}\n`));
    return 1;
  }

  const withPr = plan.tasks.filter((t) => t.prUrl);
  const withoutPr = plan.tasks.filter((t) => !t.prUrl);

  if (withPr.length === 0 && withoutPr.length === 0) {
    process.stdout.write(style.sand("Plan has no tasks.\n"));
    return 0;
  }

  if (withPr.length > 0) {
    process.stdout.write(`${style.bold(style.cream("Opening"))} ${withPr.length} PR(s) in your default browser:\n`);
    for (const t of withPr) {
      process.stdout.write(`  ${style.coral("→")} ${t.prUrl}  ${style.dim(`(${t.agnetName ? "Agnet " + t.agnetName : t.title})`)}\n`);
      openUrl(t.prUrl!);
    }
  }
  if (withoutPr.length > 0) {
    process.stdout.write("\n" + style.sand("Tasks without PRs yet:") + "\n");
    for (const t of withoutPr) {
      const agnet = t.agnetName ? "Agnet " + t.agnetName : "Agnet";
      process.stdout.write(`  ${style.sand("·")} ${agnet}  ${style.dim(t.title)}\n`);
      if (t.worktreePath) process.stdout.write(`     ${style.sand("worktree:")} ${t.worktreePath}\n`);
    }
  }
  return 0;
}

function openUrl(url: string): void {
  try {
    const cmd =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    execSync(`${cmd} "${url}"`, { stdio: "ignore" });
  } catch {
    /* swallow */
  }
}
