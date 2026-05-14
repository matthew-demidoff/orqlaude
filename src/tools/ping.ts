import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveStateDir } from "../lib/state_dir.js";

export function registerPing(server: McpServer): void {
  server.tool(
    "ping",
    "Health check — returns pong with server version, cwd, and the resolved state directory. Use this once after installing orqlaude to confirm the MCP wiring works and to verify state is going where you expect.",
    {
      echo: z.string().optional().describe("Optional string echoed back in the response"),
    },
    async ({ echo }) => {
      const stateRes = resolveStateDir();
      // Build the warnings array so orchestrators can bail early on bad config.
      const warnings: string[] = [...stateRes.warnings];
      const realCwd = process.cwd();
      if (realCwd === "/" || realCwd === "/private") {
        warnings.push(`cwd=${realCwd}: MCP host launched orqlaude from filesystem root. Calls that mutate state will still work (home fallback) but consider setting ORQLAUDE_STATE_DIR.`);
      }
      const payload = {
        ok: warnings.length === 0,
        server: "orqlaude",
        version: "0.5.0",
        cwd: realCwd,
        cwd_source: stateRes.cwdSource,
        state_dir: stateRes.path,
        state_dir_source: stateRes.source,
        warnings,
        node: process.version,
        pid: process.pid,
        echo: echo ?? null,
        time: new Date().toISOString(),
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    }
  );
}
