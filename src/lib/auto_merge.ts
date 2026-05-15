import { execSync, spawnSync } from "node:child_process";
import type { AutoMergeRule } from "./templates.js";
import { runOrchTurn } from "./orch_turn.js";

/**
 * Auto-PR-review + auto-merge engine.
 *
 * The autopilot daemon runs this after a fleet's PR is open. It:
 *
 *   1. Pulls PR metadata via `gh pr view`.
 *   2. Pulls the PR diff.
 *   3. Runs a reviewer turn via runOrchTurn — a strict-JSON review that
 *      returns { verdict: APPROVE|REQUEST_CHANGES|BLOCKER, blockers: [...],
 *      suggestions: [...] }.
 *   4. Applies the template's AutoMergeRule:
 *        • requireReviewerApprove: blocker-free verdict required
 *        • requireCi: `gh pr checks` shows green
 *        • maxLoc: PR additions+deletions under the cap
 *        • blockOnMigrations: no migrations/ files added
 *        • blockOnPaths: no files matching the glob list touched
 *   5. If all rules pass, `gh pr merge --squash --auto`. Otherwise, posts
 *      the review as a PR comment via `gh pr comment` and leaves the merge
 *      decision to the human.
 *
 * Plan-billing: the reviewer turn uses runOrchTurn (Plan-billed, free cache
 * reads). Even on a 2000-line PR the output is < 800 chars of JSON so the
 * billed cost is trivial.
 */

export interface PrInfo {
  number: number;
  url: string;
  state: string;
  title: string;
  author: string;
  headBranch: string;
  baseBranch: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: Array<{ path: string; additions: number; deletions: number }>;
  checksStatus: "pending" | "success" | "failure" | "unknown";
  mergeable: boolean | null;
}

export interface ReviewVerdict {
  verdict: "APPROVE" | "REQUEST_CHANGES" | "BLOCKER";
  blockers: string[];
  suggestions: string[];
  summary: string;
}

export interface AutoMergeDecision {
  pr: PrInfo;
  review: ReviewVerdict;
  rule: AutoMergeRule;
  ruleViolations: string[];
  action: "merged" | "blocked" | "commented" | "skipped";
  notes: string[];
}

export async function fetchPrInfo(prUrl: string, cwd: string): Promise<PrInfo> {
  const json = execSync(
    `gh pr view ${shellQuote(prUrl)} --json number,url,state,title,author,headRefName,baseRefName,additions,deletions,changedFiles,files,statusCheckRollup,mergeable`,
    { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
  );
  const raw = JSON.parse(json);
  const checks = (raw.statusCheckRollup ?? []) as Array<{ state?: string; conclusion?: string; status?: string }>;
  let status: PrInfo["checksStatus"] = "unknown";
  if (checks.length > 0) {
    const concs = checks.map((c) => (c.conclusion ?? c.state ?? c.status ?? "").toUpperCase());
    if (concs.every((c) => c === "SUCCESS" || c === "NEUTRAL" || c === "SKIPPED")) status = "success";
    else if (concs.some((c) => c === "FAILURE" || c === "ERROR" || c === "CANCELLED")) status = "failure";
    else status = "pending";
  }
  return {
    number: raw.number,
    url: raw.url,
    state: raw.state,
    title: raw.title,
    author: raw.author?.login ?? "(unknown)",
    headBranch: raw.headRefName,
    baseBranch: raw.baseRefName,
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changedFiles ?? 0,
    files: (raw.files ?? []).map((f: any) => ({
      path: f.path,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
    })),
    checksStatus: status,
    mergeable: raw.mergeable === "MERGEABLE" ? true : raw.mergeable === "CONFLICTING" ? false : null,
  };
}

export async function fetchPrDiff(prUrl: string, cwd: string): Promise<string> {
  const out = execSync(`gh pr diff ${shellQuote(prUrl)}`, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return out;
}

/**
 * Run a strict-JSON reviewer turn via `claude -p`. Output schema:
 *   { verdict, blockers: [], suggestions: [], summary }
 */
export async function runReviewerTurn(pr: PrInfo, diff: string, cwd: string): Promise<ReviewVerdict> {
  // Trim the diff if it's huge — reviewer turn is happy with ~120k chars.
  const trimmedDiff = diff.length > 120_000 ? diff.slice(0, 120_000) + "\n\n... (diff truncated)\n" : diff;
  const prompt = `You are an experienced senior engineer reviewing a pull request. Output STRICT JSON, no prose, no markdown fences.

PR metadata:
  title: ${pr.title}
  author: ${pr.author}
  base → head: ${pr.baseBranch} ← ${pr.headBranch}
  size: +${pr.additions} -${pr.deletions} across ${pr.changedFiles} files

Files touched:
${pr.files.map((f) => `  ${f.path} (+${f.additions} -${f.deletions})`).join("\n")}

Diff (may be truncated):
${trimmedDiff}

Output JSON exactly matching this schema:
{
  "verdict": "APPROVE" | "REQUEST_CHANGES" | "BLOCKER",
  "blockers": [string],
  "suggestions": [string],
  "summary": string
}

Rules:
  • "BLOCKER" if there are any of: data-loss risk, security vulnerability, broken migration, public API break, missing critical test.
  • "REQUEST_CHANGES" for fixable issues (style, missing edge-case test, naming, dead code).
  • "APPROVE" if shippable as-is.
  • Keep blockers and suggestions short (one sentence each). 0-5 items each.
  • Summary is 1-2 sentences.

Begin JSON now.`;
  const result = await runOrchTurn({
    prompt,
    model: "sonnet",
    timeoutMs: 120_000,
    cwd,
    expectJson: true,
  });
  if (!result.ok || !result.parsedJson) {
    return {
      verdict: "REQUEST_CHANGES",
      blockers: [],
      suggestions: [`Reviewer turn failed: ${result.parseError ?? "non-zero exit"}. Falling back to human review.`],
      summary: "Auto-review did not complete cleanly; please review manually.",
    };
  }
  const v = result.parsedJson as Partial<ReviewVerdict>;
  return {
    verdict: (v.verdict ?? "REQUEST_CHANGES") as ReviewVerdict["verdict"],
    blockers: Array.isArray(v.blockers) ? v.blockers : [],
    suggestions: Array.isArray(v.suggestions) ? v.suggestions : [],
    summary: typeof v.summary === "string" ? v.summary : "",
  };
}

/**
 * Apply an AutoMergeRule to a fetched PR + review. Returns a decision —
 * caller is responsible for actually invoking `gh pr merge` etc.
 */
export function applyRule(pr: PrInfo, review: ReviewVerdict, rule: AutoMergeRule): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  if (rule.requireReviewerApprove !== false) {
    if (review.verdict === "BLOCKER") violations.push(`reviewer verdict BLOCKER (${review.blockers.length} blocker(s))`);
    if (review.verdict === "REQUEST_CHANGES") violations.push(`reviewer verdict REQUEST_CHANGES (${review.suggestions.length} suggestion(s))`);
  }
  if (rule.requireCi !== false) {
    if (pr.checksStatus !== "success") violations.push(`CI status ${pr.checksStatus}, not success`);
  }
  if (rule.maxLoc && rule.maxLoc > 0 && pr.additions + pr.deletions > rule.maxLoc) {
    violations.push(`PR size ${pr.additions + pr.deletions} exceeds cap ${rule.maxLoc}`);
  }
  if (rule.blockOnMigrations) {
    const migs = pr.files.filter((f) => /\/migrations\//.test(f.path) && f.additions > 0);
    if (migs.length > 0) violations.push(`block_on_migrations: ${migs.length} migration file(s) added`);
  }
  if (rule.blockOnPaths && rule.blockOnPaths.length > 0) {
    for (const g of rule.blockOnPaths) {
      const hit = pr.files.find((f) => globMatch(g, f.path));
      if (hit) {
        violations.push(`block_on_paths: ${hit.path} matches ${g}`);
        break;
      }
    }
  }
  if (pr.mergeable === false) {
    violations.push("PR has merge conflicts; needs rebase");
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Post the review as a PR comment via `gh pr comment`. Marks the comment
 * with a stable signature so subsequent reviews can be idempotent (we don't
 * keep posting the same review on each tick).
 */
export async function postReviewComment(prUrl: string, review: ReviewVerdict, cwd: string): Promise<void> {
  const body = renderReviewComment(review);
  spawnSync("gh", ["pr", "comment", prUrl, "--body", body], {
    cwd,
    stdio: "pipe",
  });
}

/**
 * Squash-merge a PR via `gh pr merge --squash --auto`. The `--auto` flag
 * defers merge until checks pass, so this is safe even if CI is still
 * pending.
 */
export async function squashMerge(prUrl: string, cwd: string, method: "squash" | "merge" | "rebase" = "squash"): Promise<boolean> {
  const flag = method === "merge" ? "--merge" : method === "rebase" ? "--rebase" : "--squash";
  const res = spawnSync("gh", ["pr", "merge", prUrl, flag, "--auto", "--delete-branch"], {
    cwd,
    stdio: "pipe",
  });
  return res.status === 0;
}

function renderReviewComment(review: ReviewVerdict): string {
  const lines: string[] = [];
  lines.push(`### 🤖 orqlaude auto-review`);
  lines.push("");
  lines.push(`**Verdict:** \`${review.verdict}\``);
  lines.push("");
  if (review.summary) {
    lines.push(review.summary);
    lines.push("");
  }
  if (review.blockers.length > 0) {
    lines.push("**Blockers:**");
    for (const b of review.blockers) lines.push(`- ⚠️ ${b}`);
    lines.push("");
  }
  if (review.suggestions.length > 0) {
    lines.push("**Suggestions:**");
    for (const s of review.suggestions) lines.push(`- ${s}`);
    lines.push("");
  }
  lines.push("_Posted by `orql autopilot`. Reply with \`@orqlaude resolve\` to dismiss._");
  return lines.join("\n");
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9._/:?=&-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function globMatch(pattern: string, candidate: string): boolean {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const re = "^" + esc.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$";
  try {
    return new RegExp(re).test(candidate);
  } catch {
    return false;
  }
}
