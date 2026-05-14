#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StateStore } from "./lib/state.js";
import { AuditLog } from "./lib/audit.js";
import { resolveAndEnsureStateDir } from "./lib/state_dir.js";
import { registerPing } from "./tools/ping.js";
import { registerPlanning } from "./tools/planning.js";
import { registerDispatch } from "./tools/dispatch.js";
import { registerBroker } from "./tools/broker.js";
import { registerLifecycle } from "./tools/lifecycle.js";
import { registerReview } from "./tools/review.js";
import { registerUserIo } from "./tools/userio.js";

/**
 * orqlaude — multi-agent orchestrator for Claude Code.
 *
 * State dir is resolved robustly: env var > git-worktree > project-root cwd >
 * `~/.orqlaude/projects/<hash>` as a last-resort home fallback (covers
 * MCP hosts that launch with cwd=/). See lib/state_dir.ts for full logic.
 */
const { path: stateDir } = await resolveAndEnsureStateDir();
const store = new StateStore(stateDir);
const audit = new AuditLog(stateDir);

const server = new McpServer({
  name: "orqlaude",
  version: "0.7.2",
});

registerPing(server);
registerPlanning(server, store, audit);
registerDispatch(server, store, audit);
registerBroker(server, store, audit);
registerLifecycle(server, store, audit);
registerReview(server, store, audit);
registerUserIo(server, store, audit);

const transport = new StdioServerTransport();
await server.connect(transport);
