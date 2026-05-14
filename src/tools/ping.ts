import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPing(server: McpServer): void {
  server.tool(
    "ping",
    "Health check — returns pong with server version and the cwd it was launched in. Use this once after installing orqlaude to confirm the MCP wiring works.",
    {
      echo: z.string().optional().describe("Optional string echoed back in the response"),
    },
    async ({ echo }) => {
      const payload = {
        ok: true,
        server: "orqlaude",
        version: "0.3.1",
        cwd: process.cwd(),
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
