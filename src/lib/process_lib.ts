/**
 * Tiny process-tracking helpers used by spawn_via_cli + status().
 *
 * Centralized so the "is this child still alive" check has one source of
 * truth and stays consistent across both code paths.
 */

export function isProcessAlive(pid: number | undefined | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    // Signal 0 doesn't actually send a signal — just checks permission /
    // existence. Throws ESRCH if the PID is gone, EPERM if it exists but
    // we don't own it (in which case it IS alive). Treat both correctly.
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err?.code === "EPERM") return true; // alive, just not ours
    return false;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
