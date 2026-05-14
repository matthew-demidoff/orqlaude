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
      const payload = {
        ok: true,
        server: "orqlaude",
        version: "0.3.2",
        cwd: process.cwd(),
        state_dir: stateRes.path,
        state_dir_source: stateRes.source,
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
