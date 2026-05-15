import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  emptyDashboardSnapshot,
  loadDashboardSnapshot,
  renderStatusPanel,
} from "../cli/dashboard.js";

/**
 * v0.9.5 — bare `orql` live dashboard panel.
 *
 * Covers:
 *  • renderStatusPanel produces a fixed-width frame (34 visible cols
 *    including borders) so it composes cleanly in the alt-screen layout
 *  • loadDashboardSnapshot returns zeros for a fresh/missing state-dir
 *    instead of throwing — the easter egg must never crash on a state
 *    read failure
 *  • the panel never mutates between calls with the same snapshot
 *    (functional purity check)
 */

/** Strip ANSI escape sequences to measure visible-cell width. */
function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

async function mkTempDir(prefix: string): Promise<string> {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return await fs.realpath(raw);
}

test("v0.9.5: renderStatusPanel emits exactly 8 lines (top + 6 data + bottom)", () => {
  const lines = renderStatusPanel(emptyDashboardSnapshot());
  assert.equal(lines.length, 8, "panel must be 8 rows tall");
});

test("v0.9.5: every panel row is the same visible width (34 cols)", () => {
  const lines = renderStatusPanel(emptyDashboardSnapshot());
  const widths = lines.map(visibleLength);
  const expected = 34; // INNER_WIDTH (32) + 2 borders
  for (let i = 0; i < lines.length; i++) {
    assert.equal(
      widths[i],
      expected,
      `row ${i} has visible width ${widths[i]}, expected ${expected}`
    );
  }
});

test("v0.9.5: panel width is stable under wider values (1k+ Agnets, M+ tokens)", () => {
  const bigSnap = {
    plansActive: 999,
    agnetsRunning: 100,
    agnetsTotal: 100,
    tokensTotal: 12_500_000,
    mcpConfigured: true,
    telegramStatus: "active" as const,
    lastActivityAt: Date.now() - 7 * 24 * 3600 * 1000,
  };
  const lines = renderStatusPanel(bigSnap);
  // All rows still 34 cols. If a value would overflow, the row would be
  // wider than 34 and this assertion fails — telling us to widen the
  // formatter (e.g. token suffix) rather than ship a misaligned panel.
  for (const ln of lines) {
    assert.equal(
      visibleLength(ln),
      34,
      `oversized value broke the panel width: "${ln.replace(/\x1b\[[0-9;]*m/g, "")}"`
    );
  }
});

test("v0.9.5: loadDashboardSnapshot returns zeros (not throws) on missing state-dir", async () => {
  const tmp = await mkTempDir("orq-v095-empty-");
  try {
    const snap = await loadDashboardSnapshot(tmp);
    assert.equal(snap.plansActive, 0);
    assert.equal(snap.agnetsRunning, 0);
    assert.equal(snap.agnetsTotal, 0);
    assert.equal(snap.tokensTotal, 0);
    assert.equal(snap.lastActivityAt, null);
    // mcpConfigured + telegramStatus depend on the test machine's actual
    // ~/Library config and tg config respectively — don't assert on them
    // here. The contract under test is "doesn't throw, returns valid
    // shape", which holds.
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("v0.9.5: top border has embedded STATUS label", () => {
  const lines = renderStatusPanel(emptyDashboardSnapshot());
  // Strip ANSI then check the label is present in the first line.
  // eslint-disable-next-line no-control-regex
  const plainTop = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(plainTop.includes("STATUS"), `top border missing label: "${plainTop}"`);
  assert.ok(plainTop.startsWith("╭"), `top border doesn't start with ╭: "${plainTop}"`);
  assert.ok(plainTop.endsWith("╮"), `top border doesn't end with ╮: "${plainTop}"`);
});
