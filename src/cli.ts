#!/usr/bin/env node
import path from "node:path";
import { promises as fs } from "node:fs";
import { StateStore, type Plan } from "./lib/state.js";
import { AuditLog } from "./lib/audit.js";
import { snapshotSession } from "./lib/jsonl_tail.js";

/**
 * orqlaude CLI — read-only inspection of state and audit log.
 *
 * Active orchestration happens through the MCP server (loaded by Claude Code).
 * This CLI is for the human: "what plans are in flight?", "what did agent X
 * do?", "show me the audit log."
 *
 * Subcommands:
 *   orqlaude list                   — every plan in this project
 *   orqlaude status <plan_id>       — refreshed status of one plan
 *   orqlaude show <plan_id>         — full plan details (tasks, notes, claims)
 *   orqlaude history [--limit N]    — tail audit log
 *   orqlaude tg <subcommand>        — Telegram bot management (see `orqlaude tg help`)
 */

const STATE_DIR = process.env.ORQLAUDE_STATE_DIR ?? path.join(process.cwd(), ".orqlaude");

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      printHelp();
      return 0;
    case "list":
      return await cmdList();
    case "status":
      return await cmdStatus(rest[0]);
    case "show":
      return await cmdShow(rest[0]);
    case "history":
      return await cmdHistory(parseLimit(rest));
    case "tg":
      // Telegram subcommand is added in Phase 3; for now, advise.
      console.log("Telegram support not yet shipped in this build. Coming in Phase 3.");
      return 0;
    default:
      console.error(`Unknown subcommand: ${cmd}`);
      printHelp();
      return 1;
  }
}

function printHelp(): void {
  console.log(`orqlaude — multi-agent orchestrator for Claude Code (CLI)

Usage:
  orqlaude list                   List every plan in this project
  orqlaude status <plan_id>       Refreshed status of one plan
  orqlaude show <plan_id>         Full plan details
  orqlaude history [--limit N]    Tail the audit log (default 30)
  orqlaude help                   This help

State dir: ${STATE_DIR}
(Override with ORQLAUDE_STATE_DIR.)`);
}

async function cmdList(): Promise<number> {
  const store = new StateStore(STATE_DIR);
  const plans = await store.read((s) => Object.values(s.plans).sort((a, b) => b.createdAt - a.createdAt));
  if (plans.length === 0) {
    console.log("No plans yet in this project.");
    return 0;
  }
  for (const p of plans) {
    const done = p.tasks.filter((t) => t.status === "done").length;
    const running = p.tasks.filter((t) => t.status === "running" || t.status === "dispatched").length;
    console.log(`${p.id}  ${p.status.padEnd(20)}  ${done}/${p.tasks.length} done${running ? `, ${running} running` : ""}  — ${truncate(p.rootTask, 60)}`);
  }
  return 0;
}

async function cmdStatus(planId: string | undefined): Promise<number> {
  if (!planId) {
    console.error("usage: orqlaude status <plan_id>");
    return 2;
  }
  const store = new StateStore(STATE_DIR);
  let plan: Plan;
  try {
    plan = await store.read((s) => {
      const p = s.plans[planId];
      if (!p) throw new Error(`Plan not found: ${planId}`);
      return p;
    });
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  console.log(`Plan ${plan.id}`);
  console.log(`  status:     ${plan.status}`);
  console.log(`  root_task:  ${plan.rootTask}`);
  console.log(`  budget:     ${plan.budgetCapTokens.toLocaleString()} tokens (${Math.round(plan.budgetCapTokens / 1000)}k)`);
  console.log(`  created:    ${new Date(plan.createdAt).toISOString()}`);
  if (plan.approvedAt) console.log(`  approved:   ${new Date(plan.approvedAt).toISOString()}`);
  console.log(`  tasks:`);
  let totalTokens = 0;
  for (const t of plan.tasks) {
    let extra = "";
    if (t.spawnedSessionId) {
      const snap = await snapshotSession(process.cwd(), t.spawnedSessionId);
      totalTokens += snap.totalEffectiveTokens;
      extra = `  ${snap.totalEffectiveTokens.toLocaleString()}t  ${snap.terminated ? "✓" : snap.lastToolUse?.name ?? snap.lastEventType ?? ""}`;
    }
    console.log(`    [${t.status.padEnd(10)}] ${t.title.padEnd(50)}${extra}`);
    if (t.prUrl) console.log(`        PR: ${t.prUrl}`);
  }
  console.log(`  used:       ${totalTokens.toLocaleString()} tokens`);
  if (plan.notes.length > 0) console.log(`  notes:      ${plan.notes.length}`);
  if (plan.claims.length > 0) console.log(`  claims:     ${plan.claims.length}`);
  return 0;
}

async function cmdShow(planId: string | undefined): Promise<number> {
  if (!planId) {
    console.error("usage: orqlaude show <plan_id>");
    return 2;
  }
  const store = new StateStore(STATE_DIR);
  try {
    const plan = await store.read((s) => {
      const p = s.plans[planId];
      if (!p) throw new Error(`Plan not found: ${planId}`);
      return p;
    });
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

async function cmdHistory(limit: number): Promise<number> {
  const audit = new AuditLog(STATE_DIR);
  const events = await audit.tail(limit);
  if (events.length === 0) {
    console.log("(no audit events yet)");
    return 0;
  }
  for (const e of events) {
    const ts = new Date(e.ts).toISOString().slice(11, 19);
    const ok = e.ok ? "  ok" : "ERR ";
    const id = e.planId ? ` plan=${e.planId.slice(0, 8)}` : e.sessionId ? ` sess=${e.sessionId.slice(0, 8)}` : "";
    console.log(`${ts}  ${ok}  ${e.tool.padEnd(18)} ${e.durationMs.toString().padStart(4)}ms${id}  ${e.resultSummary ? truncate(e.resultSummary, 80) : e.error ?? ""}`);
  }
  return 0;
}

function parseLimit(args: string[]): number {
  const idx = args.indexOf("--limit");
  if (idx === -1 || !args[idx + 1]) return 30;
  const n = parseInt(args[idx + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
