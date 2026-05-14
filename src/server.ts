#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StateStore } from "./lib/state.js";
import { AuditLog } from "./lib/audit.js";
import { registerPing } from "./tools/ping.js";
import { registerPlanning } from "./tools/planning.js";
import { registerDispatch } from "./tools/dispatch.js";
import { registerBroker } from "./tools/broker.js";
import { registerLifecycle } from "./tools/lifecycle.js";
import { registerReview } from "./tools/review.js";

/**
 * orqlaude — multi-agent orchestrator for Claude Code.
 *
 * State and audit log live under <project>/.orqlaude/ by default.
 *
 * Worktree-aware resolution (v0.3.1+): if cwd is a git worktree (i.e. `.git`
 * is a regular file pointing at `<main>/.git/worktrees/<name>`), the state
 * dir resolves to `<main>/.orqlaude`. That lets spawned worktree-children
 * share state with the parent project — critical for the broker.
 *
 * Override via env var ORQLAUDE_STATE_DIR.
 */
function resolveStateDir(): string {
  if (process.env.ORQLAUDE_STATE_DIR) return process.env.ORQLAUDE_STATE_DIR;
  const cwd = process.cwd();
  try {
    const dotGit = path.join(cwd, ".git");
    const stat = fs.statSync(dotGit);
    if (stat.isFile()) {
      const content = fs.readFileSync(dotGit, "utf8");
      // Format: "gitdir: /path/to/main/.git/worktrees/<name>"
      const m = content.match(/^gitdir:\s*(.+?)\/worktrees\/[^\/\s]+\s*$/m);
      if (m) {
        const mainGitDir = m[1];           // /path/to/main/.git
        const mainCheckout = path.dirname(mainGitDir); // /path/to/main
        return path.join(mainCheckout, ".orqlaude");
      }
    }
  } catch {
    /* no .git or not a worktree — fall through */
  }
  return path.join(cwd, ".orqlaude");
}

const stateDir = resolveStateDir();
const store = new StateStore(stateDir);
const audit = new AuditLog(stateDir);

const server = new McpServer({
  name: "orqlaude",
  version: "0.3.1",
});

registerPing(server);
registerPlanning(server, store, audit);
registerDispatch(server, store, audit);
registerBroker(server, store, audit);
registerLifecycle(server, store, audit);
registerReview(server, store, audit);

const transport = new StdioServerTransport();
await server.connect(transport);
