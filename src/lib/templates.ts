/**
 * Fleet templates — reusable shapes for the most common kinds of fleet
 * orqlaude is asked to run. Each template ships:
 *   • A short id (referenced from Goals and from `apply_fleet_template`).
 *   • A human-friendly title for picker UIs.
 *   • Suggested role layout (how many Agnets, what each does).
 *   • A prompt skeleton the planner Agnet can stamp out.
 *   • Default budget + permission knobs (e.g. audit-sweep gets read-only).
 *
 * Why static and not LLM-generated? Two reasons:
 *   1. Cost. The planner Agnet would otherwise re-invent these layouts every
 *      time and burn billed tokens doing it.
 *   2. Determinism. Templates encode the user's learned preferences from
 *      memory (e.g. "always run an audit Agnet before merging migrations").
 *      Stamping a template gives consistent fleet shapes.
 *
 * Templates are exposed via the `list_fleet_templates` and
 * `apply_fleet_template` MCP tools.
 */

export interface FleetTemplate {
  id: string;
  title: string;
  description: string;
  /** Hints for the planner Agnet. */
  agentRoles: Array<{
    role: string;
    purpose: string;
    /** Default scope pattern this role typically touches. */
    scopeHint?: string[];
    /** Suggested model: `sonnet` / `opus` / `haiku`. The daemon passes
     *  --model when spawning. Default sonnet. */
    model?: "sonnet" | "opus" | "haiku";
  }>;
  /** Tokens per Agnet. Total budget = N agents * perAgnetBudget. */
  defaultPerAgnetBudget: number;
  /** Whether spawned Agnets should run with bypassPermissions vs acceptEdits. */
  permissionMode?: "bypassPermissions" | "acceptEdits";
  /** Goals matching these tags should suggest this template. */
  suggestedForTags?: string[];
  /** Auto-merge rule the daemon should apply to PRs produced by this fleet. */
  autoMerge?: AutoMergeRule;
}

export interface AutoMergeRule {
  /** Squash, merge, rebase. Default squash. */
  method?: "squash" | "merge" | "rebase";
  /** Required: CI passes. Default true. */
  requireCi?: boolean;
  /** Required: reviewer Agnet returned APPROVE (or empty BLOCKERs). */
  requireReviewerApprove?: boolean;
  /** Max additions+deletions. 0 = no cap. */
  maxLoc?: number;
  /** Reject if any migration files were added (forces human review). */
  blockOnMigrations?: boolean;
  /** Reject if any file matching these globs was touched. */
  blockOnPaths?: string[];
}

export const FLEET_TEMPLATES: FleetTemplate[] = [
  {
    id: "backend-feature",
    title: "Backend feature (Django/DRF)",
    description: "Model + migration + serializer + viewset + URL + admin + tests, one Agnet end-to-end. Includes a reviewer Agnet.",
    agentRoles: [
      { role: "implementer", purpose: "Build the feature end-to-end: model, migration, serializer, viewset, URLs, admin, tests.", model: "sonnet" },
      { role: "reviewer", purpose: "Static review of the implementer's PR. Catches migration collisions, missing tests, security issues.", model: "sonnet" },
    ],
    defaultPerAgnetBudget: 220_000,
    permissionMode: "bypassPermissions",
    suggestedForTags: ["backend", "django", "drf", "model"],
    autoMerge: { method: "squash", requireCi: true, requireReviewerApprove: true, maxLoc: 1500, blockOnMigrations: false },
  },
  {
    id: "frontend-feature",
    title: "Frontend feature (React/AntD)",
    description: "Component(s) + state + hooks + i18n + tests. One implementer + reviewer.",
    agentRoles: [
      { role: "implementer", purpose: "Build the UI: components, hooks, i18n strings, light unit tests if applicable.", model: "sonnet" },
      { role: "reviewer", purpose: "Review for AntD theming consistency, dark-mode coverage, i18n completeness, accessibility.", model: "sonnet" },
    ],
    defaultPerAgnetBudget: 200_000,
    permissionMode: "bypassPermissions",
    suggestedForTags: ["frontend", "react", "ui", "ant-design"],
    autoMerge: { method: "squash", requireCi: true, requireReviewerApprove: true, maxLoc: 1500 },
  },
  {
    id: "migration-only",
    title: "Migration / schema change",
    description: "One Agnet writes the migration + the dependent model/serializer/admin patches; one reviewer focuses on backwards-compat and data preservation.",
    agentRoles: [
      { role: "migrator", purpose: "Write the migration safely. Backfill data if needed. Update dependent code in the same PR.", model: "sonnet" },
      { role: "reviewer", purpose: "Review for: data loss risk, downtime during deploy, backwards-compat with old clients, migration ordering.", model: "opus" },
    ],
    defaultPerAgnetBudget: 180_000,
    permissionMode: "bypassPermissions",
    suggestedForTags: ["migration", "schema", "db"],
    // Migrations always need human eyes.
    autoMerge: { requireCi: true, requireReviewerApprove: true, blockOnMigrations: true },
  },
  {
    id: "audit-sweep",
    title: "Audit sweep (read-only)",
    description: "Multiple Agnets spread across the codebase looking for a class of issue (e.g. missing audit-log calls, em-dashes, dead code). Read-only — produces a findings report, not a PR.",
    agentRoles: [
      { role: "auditor-1", purpose: "Audit assigned scope for the pattern. No edits.", model: "haiku" },
      { role: "auditor-2", purpose: "Audit assigned scope for the pattern. No edits.", model: "haiku" },
      { role: "synthesizer", purpose: "Consume per-auditor findings via notes, produce a single deduped report.", model: "sonnet" },
    ],
    defaultPerAgnetBudget: 120_000,
    permissionMode: "acceptEdits",
    suggestedForTags: ["audit", "review", "lint", "sweep"],
  },
  {
    id: "dep-upgrade",
    title: "Dependency upgrade",
    description: "One Agnet upgrades a dep (e.g. Django 5.2 → 5.3), patches breaking changes, runs the suite. Reviewer Agnet on top.",
    agentRoles: [
      { role: "upgrader", purpose: "Bump the dep version, follow the upgrade guide, patch breaking changes, get tests green.", model: "sonnet" },
      { role: "reviewer", purpose: "Confirm we didn't smuggle in unrelated changes; check for new deprecation warnings to track.", model: "sonnet" },
    ],
    defaultPerAgnetBudget: 250_000,
    permissionMode: "bypassPermissions",
    suggestedForTags: ["upgrade", "deps", "dependency"],
    autoMerge: { method: "squash", requireCi: true, requireReviewerApprove: true, maxLoc: 3000 },
  },
  {
    id: "i18n-pass",
    title: "i18n pass",
    description: "Add or update locale strings across the app. Audit-then-implement.",
    agentRoles: [
      { role: "auditor", purpose: "Find untranslated strings, missing keys, locale mismatches. Produce a punch list.", model: "haiku" },
      { role: "translator", purpose: "Add missing keys + translations. Update locale files. Light component edits if needed.", model: "sonnet" },
    ],
    defaultPerAgnetBudget: 150_000,
    permissionMode: "bypassPermissions",
    suggestedForTags: ["i18n", "translation", "locale"],
    autoMerge: { method: "squash", requireCi: true, requireReviewerApprove: false, maxLoc: 2000 },
  },
  {
    id: "test-coverage-fill",
    title: "Test coverage fill",
    description: "Multiple Agnets add tests to under-covered modules in parallel. No production code changes.",
    agentRoles: [
      { role: "tester-1", purpose: "Add unit + integration tests for assigned module. Run the suite. No production code changes.", model: "sonnet" },
      { role: "tester-2", purpose: "Add unit + integration tests for assigned module. Run the suite. No production code changes.", model: "sonnet" },
    ],
    defaultPerAgnetBudget: 180_000,
    permissionMode: "bypassPermissions",
    suggestedForTags: ["tests", "coverage"],
    autoMerge: { method: "squash", requireCi: true, requireReviewerApprove: false, maxLoc: 5000, blockOnPaths: ["**/views.py", "**/models.py", "frontend/src/**/*.tsx"] },
  },
  {
    id: "bug-hunt",
    title: "Bug hunt + fix",
    description: "Bug reproducer Agnet first, then fixer Agnet picks up the repro and fixes. Sequential, not parallel.",
    agentRoles: [
      { role: "reproducer", purpose: "Reproduce the bug; write a failing test that captures it.", model: "sonnet" },
      { role: "fixer", purpose: "Read the failing test; implement the fix; confirm test now passes; check for related issues.", model: "sonnet" },
    ],
    defaultPerAgnetBudget: 200_000,
    permissionMode: "bypassPermissions",
    suggestedForTags: ["bug", "fix", "regression"],
    autoMerge: { method: "squash", requireCi: true, requireReviewerApprove: false, maxLoc: 500 },
  },
];

export function findTemplate(id: string): FleetTemplate | undefined {
  return FLEET_TEMPLATES.find((t) => t.id === id);
}

export function suggestTemplates(tags: string[]): FleetTemplate[] {
  if (tags.length === 0) return [];
  const tagSet = new Set(tags.map((t) => t.toLowerCase()));
  return FLEET_TEMPLATES.filter((t) => (t.suggestedForTags ?? []).some((sg) => tagSet.has(sg.toLowerCase())));
}
