import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveStateDir } from "../lib/state_dir.js";
import { probeTelegramStatus } from "../lib/telegram_status.js";

export function registerPing(server: McpServer): void {
  server.tool(
    "ping",
    "Health check — returns version, cwd, resolved state directory, AND Telegram bot status (configured/active/stale). Use this once after installing orqlaude, and consult it before relying on Telegram-bound tools (notify_user / request_user_response).",
    {
      echo: z.string().optional().describe("Optional string echoed back in the response"),
    },
    async ({ echo }) => {
      const stateRes = resolveStateDir();
      const tg = await probeTelegramStatus(stateRes.path);
      // Build the warnings array so orchestrators can bail early on bad config.
      const warnings: string[] = [...stateRes.warnings];
      const realCwd = process.cwd();
      if (realCwd === "/" || realCwd === "/private") {
        warnings.push(`cwd=${realCwd}: MCP host launched orqlaude from filesystem root. Calls that mutate state will still work (home fallback) but consider setting ORQLAUDE_STATE_DIR.`);
      }
      // Surface telegram status as a top-level field so orchestrators
      // can decide whether to use Telegram-bound tools.
      if (tg.status !== "active" && tg.status !== "configured") {
        warnings.push(`Telegram: ${tg.status}. ${tg.notes.join(" ")}`);
      }
      const payload = {
        ok: warnings.length === 0,
        server: "orqlaude",
        version: "0.6.1",
        cwd: realCwd,
        cwd_source: stateRes.cwdSource,
        state_dir: stateRes.path,
        state_dir_source: stateRes.source,
        warnings,
        telegram: {
          status: tg.status,
          has_token: tg.hasToken,
          whitelist_size: tg.whitelistSize,
          notifier_last_tick_ms_ago: tg.notifierLastTickMsAgo,
          notes: tg.notes,
        },
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
