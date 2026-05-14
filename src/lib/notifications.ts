import { spawn } from "node:child_process";

/**
 * Native desktop notifications. macOS-only for now (via osascript).
 *
 * Used by:
 *   • The Telegram notifier (in the bot process) when localNotifications is
 *     enabled in preferences. Each Telegram message also fires a local
 *     osascript notification so the user gets a Mac banner even without
 *     opening Telegram.
 *   • `orql notify test` — sanity check the wiring.
 *
 * Fire-and-forget; never throws.
 */

export function localNotification(title: string, body: string, subtitle?: string): void {
  if (process.platform !== "darwin") return;
  // Escape double-quotes for AppleScript string literals.
  const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
  const parts = [
    `display notification "${escape(body)}"`,
    `with title "${escape(title)}"`,
  ];
  if (subtitle) parts.push(`subtitle "${escape(subtitle)}"`);
  const script = parts.join(" ");
  try {
    const proc = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
    proc.unref();
  } catch {
    // Silently swallow — notifications are best-effort.
  }
}

export function isNotificationsAvailable(): boolean {
  return process.platform === "darwin";
}
