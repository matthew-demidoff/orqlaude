import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Cost & rate guardrails for the autopilot daemon.
 *
 * On the Claude Max plan, "cost" isn't $/token — it's quota burned per
 * 5-hour window. The Plan refreshes every 5h with a fresh quota. We model
 * this as a rolling counter:
 *
 *   • Track billed (input + output) tokens spent in the current 5h window.
 *   • Track total fleet tokens (incl. cache reads) for telemetry only —
 *     doesn't affect the cap because cache reads are free on the Plan.
 *
 * Three thresholds:
 *
 *   • "yellow"  60% of window-cap — daemon posts a notify_user warning
 *                                    ("hourly burn high, slowing down")
 *   • "orange"  80% of window-cap — daemon switches to one-fleet-at-a-time,
 *                                    refuses to start new fleets without
 *                                    user approval via request_user_response
 *   • "red"     95% of window-cap — daemon pauses entirely, sends a
 *                                    high-urgency Telegram, awaits user
 *                                    "/resume"
 *
 * The window-cap is configurable per user (some Plans have higher quotas).
 * Defaults are conservative for a Max-x20 plan.
 */

export interface GuardrailConfig {
  /** Cap on billed tokens per 5-hour Plan window. Default 8M. */
  windowCapBilledTokens: number;
  /** Window duration (ms). Default 5 hours. */
  windowMs: number;
  /** Yellow / orange / red thresholds (0-1). */
  yellow: number;
  orange: number;
  red: number;
  /** Per-day soft cap; if hit, daemon refuses to spawn anything new until
   *  next morning regardless of window state. Default 30M billed. */
  perDaySoftCap: number;
}

export const DEFAULT_GUARDRAILS: GuardrailConfig = {
  windowCapBilledTokens: 8_000_000,
  windowMs: 5 * 60 * 60 * 1000,
  yellow: 0.6,
  orange: 0.8,
  red: 0.95,
  perDaySoftCap: 30_000_000,
};

export interface GuardrailEvent {
  ts: number;
  billed: number;
  cached: number;
  planId?: string;
  taskId?: string;
  source: string;
}

export interface GuardrailLedger {
  schemaVersion: 1;
  events: GuardrailEvent[];
}

const EMPTY: GuardrailLedger = { schemaVersion: 1, events: [] };

export class GuardrailStore {
  private filePath: string;
  private cache: GuardrailLedger | null = null;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "guardrails.json");
  }

  private async load(): Promise<GuardrailLedger> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as GuardrailLedger;
      this.cache = parsed.schemaVersion === 1 ? parsed : EMPTY;
    } catch (err: any) {
      if (err.code === "ENOENT") this.cache = structuredClone(EMPTY);
      else throw err;
    }
    return this.cache!;
  }

  async record(event: GuardrailEvent): Promise<void> {
    const file = await this.load();
    file.events.push(event);
    // Trim — we only need ~48h of history for daily-cap + window-cap calcs.
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    file.events = file.events.filter((e) => e.ts >= cutoff);
    await this.persist(file);
  }

  /** Sum billed tokens in the last `windowMs`. */
  async windowBilled(windowMs: number): Promise<number> {
    const file = await this.load();
    const cutoff = Date.now() - windowMs;
    return file.events.filter((e) => e.ts >= cutoff).reduce((sum, e) => sum + e.billed, 0);
  }

  /** Sum billed tokens since local midnight. */
  async dayBilled(): Promise<number> {
    const file = await this.load();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = today.getTime();
    return file.events.filter((e) => e.ts >= start).reduce((sum, e) => sum + e.billed, 0);
  }

  async snapshot(cfg: GuardrailConfig): Promise<{
    windowBilled: number;
    windowCap: number;
    windowPct: number;
    dayBilled: number;
    dayCap: number;
    dayPct: number;
    level: "green" | "yellow" | "orange" | "red";
  }> {
    const win = await this.windowBilled(cfg.windowMs);
    const day = await this.dayBilled();
    const winPct = win / cfg.windowCapBilledTokens;
    const dayPct = day / cfg.perDaySoftCap;
    const level: "green" | "yellow" | "orange" | "red" =
      winPct >= cfg.red || dayPct >= 1.0
        ? "red"
        : winPct >= cfg.orange || dayPct >= 0.8
        ? "orange"
        : winPct >= cfg.yellow || dayPct >= 0.6
        ? "yellow"
        : "green";
    return {
      windowBilled: win,
      windowCap: cfg.windowCapBilledTokens,
      windowPct: winPct,
      dayBilled: day,
      dayCap: cfg.perDaySoftCap,
      dayPct,
      level,
    };
  }

  private async persist(file: GuardrailLedger): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
    this.cache = file;
  }
}
