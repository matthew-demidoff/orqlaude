import { StateStore, type Task } from "../lib/state.js";
import { probeTelegramStatus, type TgStatus } from "../lib/telegram_status.js";
import { findDesktopConfigPath, readDesktopConfig } from "../lib/desktop_config.js";
import { style } from "../lib/style.js";

/**
 * Live state snapshot for the bare `orql` dashboard panel.
 *
 * Aggregates StateStore + Telegram + Claude Desktop config into a single
 * struct that the easter-egg paintFrame() can render in O(1). Loading
 * this snapshot does file I/O (state read, telegram probe, desktop
 * config read), so the easter egg refreshes it on a 2s setInterval
 * rather than recomputing on every animation tick.
 *
 * If the state-dir read fails (fresh install, bad permissions), we
 * return a zeroed snapshot so the panel still draws — it just shows
 * "0 / 0" and "missing" indicators instead of crashing the easter egg.
 */

export interface DashboardSnapshot {
  plansActive: number;
  agnetsRunning: number;
  agnetsTotal: number;
  tokensTotal: number;
  mcpConfigured: boolean;
  telegramStatus: TgStatus;
  lastActivityAt: number | null;
}

const ACTIVE_PLAN_STATUSES = new Set([
  "draft",
  "estimating",
  "awaiting_approval",
  "approved",
  "dispatching",
  "running",
]);

const RUNNING_TASK_STATUSES = new Set(["dispatched", "running"]);

export function emptyDashboardSnapshot(): DashboardSnapshot {
  return {
    plansActive: 0,
    agnetsRunning: 0,
    agnetsTotal: 0,
    tokensTotal: 0,
    mcpConfigured: false,
    telegramStatus: "unconfigured",
    lastActivityAt: null,
  };
}

export async function loadDashboardSnapshot(stateDir: string): Promise<DashboardSnapshot> {
  let plansArr: Array<{ status: string; tasks: Task[] }> = [];
  try {
    const store = new StateStore(stateDir);
    plansArr = await store.read((s) => Object.values(s.plans));
  } catch {
    /* state read failed - return zeros for everything below */
  }

  const activePlans = plansArr.filter((p) => ACTIVE_PLAN_STATUSES.has(p.status));
  const allTasks: Task[] = plansArr.flatMap((p) => p.tasks);
  const runningTasks = allTasks.filter((t) => RUNNING_TASK_STATUSES.has(t.status));
  const tokensTotal = allTasks.reduce((sum, t) => sum + (t.tokensUsed ?? 0), 0);

  let mcpConfigured = false;
  try {
    const cfgPath = findDesktopConfigPath();
    const cfg = await readDesktopConfig(cfgPath);
    mcpConfigured = !!cfg?.mcpServers?.orqlaude;
  } catch {
    /* leave false */
  }

  let telegramStatus: TgStatus = "unconfigured";
  try {
    const tg = await probeTelegramStatus(stateDir);
    telegramStatus = tg.status;
  } catch {
    /* leave unconfigured */
  }

  let lastActivityAt: number | null = null;
  for (const t of allTasks) {
    if (t.finishedAt && (lastActivityAt === null || t.finishedAt > lastActivityAt)) {
      lastActivityAt = t.finishedAt;
    }
    if (t.startedAt && (lastActivityAt === null || t.startedAt > lastActivityAt)) {
      lastActivityAt = t.startedAt;
    }
  }

  return {
    plansActive: activePlans.length,
    agnetsRunning: runningTasks.length,
    agnetsTotal: allTasks.length,
    tokensTotal,
    mcpConfigured,
    telegramStatus,
    lastActivityAt,
  };
}

// ---- panel renderer -------------------------------------------------------
//
// The panel is fixed-width so it composes cleanly with the rest of the
// alt-screen frame in easter_egg.ts. Each row's middle padding is computed
// from the plain (un-styled) value width — we can't measure the styled
// string because it contains ANSI escapes that don't take visible cells.

const INNER_WIDTH = 32; // total visible columns between the │ │ borders

function row(label: string, valuePlain: string, valueStyled: string): string {
  // Layout: "│ " + label + " "*padCount + valueStyled + " │"
  // Visible width inside the pipes = INNER_WIDTH. The leading/trailing space
  // inside the pipes accounts for 2; subtract label + plain-value widths to
  // find the middle padding.
  const padCount = Math.max(INNER_WIDTH - 2 - label.length - valuePlain.length, 1);
  return (
    style.dim("│ ") +
    style.sand(label) +
    " ".repeat(padCount) +
    valueStyled +
    style.dim(" │")
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

interface ValuePair {
  plain: string;
  styled: string;
}

function formatLastActivity(ms: number | null): ValuePair {
  if (ms === null) return { plain: "—", styled: style.dim("—") };
  const delta = Date.now() - ms;
  if (delta < 60_000) {
    const s = "just now";
    return { plain: s, styled: style.coral(s) };
  }
  if (delta < 3600_000) {
    const s = `${Math.floor(delta / 60_000)} min ago`;
    return { plain: s, styled: style.sand(s) };
  }
  if (delta < 86_400_000) {
    const s = `${Math.floor(delta / 3_600_000)} hr ago`;
    return { plain: s, styled: style.dim(s) };
  }
  const d = Math.floor(delta / 86_400_000);
  const s = `${d} day${d > 1 ? "s" : ""} ago`;
  return { plain: s, styled: style.dim(s) };
}

function statusGlyphPair(active: boolean, activeLabel: string, idleLabel: string): ValuePair {
  if (active) {
    return {
      plain: `◆ ${activeLabel}`,
      styled: `${style.coral("◆")} ${style.sand(activeLabel)}`,
    };
  }
  return {
    plain: `· ${idleLabel}`,
    styled: style.dim(`· ${idleLabel}`),
  };
}

function telegramPair(status: TgStatus): ValuePair {
  switch (status) {
    case "active":
      return { plain: "◆ active", styled: `${style.coral("◆")} ${style.sand("active")}` };
    case "started":
      return { plain: "◆ started", styled: `${style.coral("◆")} ${style.sand("started")}` };
    case "configured":
      return { plain: "◆ idle", styled: `${style.coral("◆")} ${style.sand("idle")}` };
    case "stale":
      return { plain: "· stale", styled: style.dim("· stale") };
    case "unconfigured":
    default:
      return { plain: "· not set", styled: style.dim("· not set") };
  }
}

/**
 * Render the STATUS panel as an array of pre-styled lines (one per row).
 * The caller is responsible for positioning each line at the correct
 * terminal row — see paintFrame() in easter_egg.ts.
 *
 * Panel is exactly `INNER_WIDTH + 2` visible columns wide.
 */
export function renderStatusPanel(snap: DashboardSnapshot): string[] {
  const plansPlain = String(snap.plansActive);
  const plansStyled =
    snap.plansActive > 0 ? style.coral(plansPlain) : style.dim(plansPlain);

  const agnetsPlain = `${snap.agnetsRunning} / ${snap.agnetsTotal}`;
  const agnetsStyled =
    snap.agnetsRunning > 0 ? style.coral(agnetsPlain) : style.dim(agnetsPlain);

  const tokensPlain = formatTokens(snap.tokensTotal);
  const tokensStyled =
    snap.tokensTotal > 0 ? style.sand(tokensPlain) : style.dim(tokensPlain);

  const mcp = statusGlyphPair(snap.mcpConfigured, "ready", "missing");
  const tg = telegramPair(snap.telegramStatus);
  const la = formatLastActivity(snap.lastActivityAt);

  // Top border with embedded label. Visible width inside borders is
  // INNER_WIDTH (32) chars. The "─" + label + "─"*N pattern below must sum
  // to that. Label is " STATUS " (8 chars) so we draw 1 + 8 + 23 = 32.
  const TOP_LABEL = " STATUS ";
  const topRight = "─".repeat(INNER_WIDTH - 1 - TOP_LABEL.length);
  const top = style.dim("╭─") + style.coral(TOP_LABEL) + style.dim(topRight + "╮");
  const bottom = style.dim("╰" + "─".repeat(INNER_WIDTH) + "╯");

  return [
    top,
    row("Plans active", plansPlain, plansStyled),
    row("Agnets running", agnetsPlain, agnetsStyled),
    row("Tokens", tokensPlain, tokensStyled),
    row("MCP server", mcp.plain, mcp.styled),
    row("Telegram bot", tg.plain, tg.styled),
    row("Last activity", la.plain, la.styled),
    bottom,
  ];
}

/** Total row count of the rendered panel (top + 6 data rows + bottom = 8). */
export const STATUS_PANEL_ROWS = 8;
