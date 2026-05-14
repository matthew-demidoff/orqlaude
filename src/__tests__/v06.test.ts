import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

/** v0.6.0 regression tests covering the polish-pack modules. */

test("preferences: read/write/update round-trip", async () => {
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "orqlaude-prefs-"));
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    // Re-import so PREFS_PATH picks up the new HOME. The module caches the
    // path at import time, so this technique only works in a fresh worker —
    // we accept that and validate the shape rather than the path.
    const { readPreferences, updatePreferences } = await import(
      `../lib/preferences.js?cache=${Date.now()}`
    );
    let prefs = await readPreferences();
    assert.deepEqual(prefs, {});
    await updatePreferences((p: Record<string, unknown>) => {
      p.welcomedAt = 1234;
      p.localNotifications = true;
    });
    prefs = await readPreferences();
    assert.equal(prefs.welcomedAt, 1234);
    assert.equal(prefs.localNotifications, true);
  } finally {
    if (realHome) process.env.HOME = realHome;
    else delete process.env.HOME;
  }
});

test("error_ui: formatError attaches suggestions for known patterns", async () => {
  const { formatError } = await import("../lib/error_ui.js");
  assert.match(formatError(new Error("Plan not found: abc")).suggestion!, /orql list/);
  assert.match(formatError(new Error("EACCES: write failed")).suggestion!, /ORQLAUDE_STATE_DIR/);
  assert.match(formatError(new Error("ENOENT: nope")).suggestion!, /missing path|orql setup/);
  // Unknown messages get no suggestion (returns undefined).
  assert.equal(formatError(new Error("something obscure")).suggestion, undefined);
});

test("json_out: hasJsonFlag detects --json anywhere in args", async () => {
  const { hasJsonFlag } = await import("../lib/json_out.js");
  assert.equal(hasJsonFlag([]), false);
  assert.equal(hasJsonFlag(["foo"]), false);
  assert.equal(hasJsonFlag(["--json"]), true);
  assert.equal(hasJsonFlag(["foo", "--json", "bar"]), true);
});

test("notifications: isNotificationsAvailable matches platform", async () => {
  const { isNotificationsAvailable } = await import("../lib/notifications.js");
  assert.equal(isNotificationsAvailable(), process.platform === "darwin");
});

test("error_ui: errorLine includes ✗ glyph and optional suggestion", async () => {
  const { errorLine } = await import("../lib/error_ui.js");
  const noSuggestion = errorLine("bad");
  // String includes "bad" and the glyph "✗"
  assert.ok(noSuggestion.includes("✗"));
  assert.ok(noSuggestion.includes("bad"));
  const withSuggestion = errorLine("bad", "try foo");
  assert.ok(withSuggestion.includes("try foo"));
  assert.ok(withSuggestion.includes("→"));
});
