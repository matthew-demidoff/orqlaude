import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { style, banner } from "../lib/style.js";
import { discoverClaudeBinary } from "../lib/spawn_cli.js";
import { resolveStateDir } from "../lib/state_dir.js";
import { probeTelegramStatus } from "../lib/telegram_status.js";
import { findDesktopConfigPath, readDesktopConfig } from "../lib/desktop_config.js";

/**
 * `orql doctor` — health check across the orqlaude stack.
 *
 * Each check returns one of three states:
 *   ✓ ok      (coral)
 *   ⚠ warn    (cream — works but with caveats)
 *   ✗ fail    (crimson — needs attention)
 *
 * Designed for the "first 30 seconds of installing orqlaude" moment.
 * If everything's green, you're wired correctly.
 */

interface CheckResult {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
}

export async function runDoctor(currentVersion: string): Promise<number> {
  console.log(banner());
  console.log("");
  console.log(style.bold(style.cream("doctor")));
  console.log("");

  const checks: CheckResult[] = [];

  // 1. Node version
  const nodeVer = process.version.replace(/^v/, "");
  const major = parseInt(nodeVer.split(".")[0], 10);
  checks.push({
    name: "Node.js >= 22",
    status: major >= 22 ? "ok" : "fail",
    detail: `Node ${nodeVer}`,
    fix: major < 22 ? "Install Node 22+ (brew install node@22)" : undefined,
  });

  // 2. claude binary
  try {
    const claudeBin = discoverClaudeBinary();
    let claudeVer = "(version probe failed)";
    try {
      claudeVer = execSync(`"${claudeBin}" --version`, { encoding: "utf8", timeout: 3000 }).trim();
    } catch {
      /* ignore */
    }
    checks.push({ name: "claude binary", status: "ok", detail: `${claudeBin} (${claudeVer})` });
  } catch (err) {
    checks.push({
      name: "claude binary",
      status: "fail",
      detail: (err as Error).message,
      fix: "Install Claude Code, or set CLAUDE_BIN env var to its path. spawn_via_cli won't work without this.",
    });
  }

  // 3. gh CLI
  try {
    const ghVer = execSync("gh --version", { encoding: "utf8", timeout: 3000 }).split("\n")[0];
    let authed = false;
    try {
      execSync("gh auth status", { encoding: "utf8", timeout: 3000, stdio: "pipe" });
      authed = true;
    } catch {
      authed = false;
    }
    checks.push({
      name: "gh CLI + auth",
      status: authed ? "ok" : "warn",
      detail: authed ? ghVer : `${ghVer} (not authenticated)`,
      fix: authed ? undefined : "Run `gh auth login` so Agnets can open PRs.",
    });
  } catch {
    checks.push({
      name: "gh CLI + auth",
      status: "warn",
      detail: "gh not installed",
      fix: "brew install gh; gh auth login. Agnets can still run without it, but PRs won't auto-open.",
    });
  }

  // 4. Resolved state dir
  const stateRes = resolveStateDir();
  const stateOk = stateRes.source === "env" || stateRes.source === "project-root" || stateRes.source === "worktree";
  checks.push({
    name: "state dir",
    status: stateOk ? "ok" : "warn",
    detail: `${stateRes.path} (source: ${stateRes.source})`,
    fix: stateOk
      ? undefined
      : `Run \`orql setup\` from your project to pin state via ORQLAUDE_STATE_DIR in the Desktop MCP config.`,
  });

  // 5. Claude Desktop MCP config
  const cfgPath = findDesktopConfigPath();
  if (existsSync(cfgPath)) {
    try {
      const cfg = await readDesktopConfig(cfgPath);
      const entry = cfg?.mcpServers?.orqlaude;
      if (!entry) {
        checks.push({
          name: "Desktop MCP config",
          status: "fail",
          detail: `${cfgPath} exists, but no orqlaude entry`,
          fix: "Run `orql setup` in your project to add the entry.",
        });
      } else if (!entry.env?.ORQLAUDE_STATE_DIR) {
        checks.push({
          name: "Desktop MCP config",
          status: "warn",
          detail: "orqlaude entry present but has no ORQLAUDE_STATE_DIR env",
          fix: "Run `orql setup` to pin a state dir; without it, MCP cwd=/ can split state.",
        });
      } else {
        checks.push({
          name: "Desktop MCP config",
          status: "ok",
          detail: `ORQLAUDE_STATE_DIR → ${entry.env.ORQLAUDE_STATE_DIR}`,
        });
      }
    } catch (err) {
      checks.push({
        name: "Desktop MCP config",
        status: "fail",
        detail: (err as Error).message,
      });
    }
  } else {
    checks.push({
      name: "Desktop MCP config",
      status: "warn",
      detail: `${cfgPath} does not exist`,
      fix: "Run `orql setup` to create it.",
    });
  }

  // 6. Telegram
  const tg = await probeTelegramStatus(stateRes.path);
  let tgStatus: "ok" | "warn" | "fail" = "ok";
  if (tg.status === "unconfigured") tgStatus = "warn";
  else if (tg.status === "stale" || tg.status === "configured" || tg.status === "started") tgStatus = "warn";
  checks.push({
    name: "Telegram bot",
    status: tgStatus,
    detail: `${tg.status} (token: ${tg.hasToken ? "set" : "missing"}, whitelist: ${tg.whitelistSize})`,
    fix:
      tg.status === "unconfigured"
        ? "`orql tg setup` to wire a bot — optional but recommended."
        : tg.status === "stale" || tg.status === "configured" || tg.status === "started"
        ? "Run `orql tg start` from your project to bring the bot online."
        : undefined,
  });

  // 7. orqlaude self-test (MCP server startup)
  try {
    const serverPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "server.js");
    if (existsSync(serverPath)) {
      checks.push({ name: "orqlaude MCP server", status: "ok", detail: `${serverPath}` });
    } else {
      checks.push({
        name: "orqlaude MCP server",
        status: "fail",
        detail: `Missing ${serverPath}`,
        fix: "Reinstall: npm i -g @synaplink/orqlaude@latest",
      });
    }
  } catch (err) {
    checks.push({ name: "orqlaude MCP server", status: "warn", detail: (err as Error).message });
  }

  // Render
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) {
    counts[c.status]++;
    const glyph =
      c.status === "ok"
        ? style.coral("✓")
        : c.status === "warn"
        ? style.crimson("⚠")
        : style.crimson("✗");
    console.log(`  ${glyph} ${style.bold(c.name.padEnd(26))} ${c.detail}`);
    if (c.fix) console.log(`     ${style.coral("→")} ${style.sand(c.fix)}`);
  }
  console.log("");
  const summary = `${style.coral(`${counts.ok} ok`)} · ${style.crimson(`${counts.warn} warn`)} · ${style.crimson(`${counts.fail} fail`)}`;
  console.log(`  ${summary}  ${style.dim(`(orqlaude ${currentVersion})`)}`);

  return counts.fail > 0 ? 1 : 0;
}
