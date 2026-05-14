import { readPreferences, updatePreferences } from "./preferences.js";
import { style } from "./style.js";

/**
 * Background update probe. Once per 24 h, fetch
 * `https://registry.npmjs.org/@synaplink/orqlaude/latest` and compare to the
 * installed version. If a newer version is available, print a one-line
 * notice. Non-blocking, never throws — failures are silent.
 *
 * The check runs in parallel with whatever command the user invoked, so it
 * doesn't slow anything down.
 */

const PACKAGE = "@synaplink/orqlaude";
const URL = `https://registry.npmjs.org/${PACKAGE}/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function maybeCheckForUpdate(currentVersion: string): Promise<void> {
  try {
    const prefs = await readPreferences();
    const lastAt = prefs.lastUpdateCheckAt ?? 0;
    if (Date.now() - lastAt < CHECK_INTERVAL_MS) {
      // Within window: use cached value if newer.
      maybePrintAvailable(prefs.lastKnownLatestVersion, currentVersion);
      return;
    }
    // Stale: fetch.
    const latest = await fetchLatestVersion();
    await updatePreferences((p) => {
      p.lastUpdateCheckAt = Date.now();
      if (latest) p.lastKnownLatestVersion = latest;
    });
    maybePrintAvailable(latest, currentVersion);
  } catch {
    // Silent — never block a user's command on the update check.
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(URL, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return body.version ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function maybePrintAvailable(latest: string | null | undefined, current: string): void {
  if (!latest || latest === current) return;
  if (compareSemver(latest, current) <= 0) return;
  process.stdout.write(
    "\n" +
      style.dim(
        `↑ ${PACKAGE} ${latest} available (you have ${current}). Run: ` +
          style.coral("npm i -g @synaplink/orqlaude@latest")
      ) +
      "\n"
  );
}

/** -1 if a<b, 0 if equal, 1 if a>b. Naive semver — fine for our use. */
function compareSemver(a: string, b: string): number {
  const sa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const sb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const x = sa[i] ?? 0;
    const y = sb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}
