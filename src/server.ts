#!/usr/bin/env node
import path from "node:path";
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
 * State and audit log live under <project>/.orqlaude/ by default. Override
 * with ORQLAUDE_STATE_DIR=/some/path.
 */
const stateDir = process.env.ORQLAUDE_STATE_DIR ?? path.join(process.cwd(), ".orqlaude");
const store = new StateStore(stateDir);
const audit = new AuditLog(stateDir);

const server = new McpServer({
  name: "orqlaude",
  version: "0.3.0",
});

registerPing(server);
registerPlanning(server, store, audit);
registerDispatch(server, store, audit);
registerBroker(server, store, audit);
registerLifecycle(server, store, audit);
registerReview(server, store, audit);

const transport = new StdioServerTransport();
await server.connect(transport);
