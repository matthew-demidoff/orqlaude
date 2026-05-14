import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathsEquivalent } from "../lib/state_dir.js";

/** v0.5.6: pathsEquivalent should not be fooled by case or symlinks. */

test("pathsEquivalent: identical strings", () => {
  assert.equal(pathsEquivalent("/a/b/c", "/a/b/c"), true);
});

test("pathsEquivalent: normalized but identical", () => {
  assert.equal(pathsEquivalent("/a/b/c", "/a/b/./c"), true);
  assert.equal(pathsEquivalent("/a/b/c", "/a/b/d/../c"), true);
});

test("pathsEquivalent: same dir via symlink (when target exists)", async () => {
  if (process.platform === "win32") return; // skip on win
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orqlaude-paths-"));
  const real = path.join(dir, "real");
  await fs.mkdir(real);
  const link = path.join(dir, "link");
  await fs.symlink(real, link);
  assert.equal(pathsEquivalent(real, link), true);
});

test("pathsEquivalent: case-insensitive on macOS/Windows for paths that exist", async () => {
  if (process.platform !== "darwin" && process.platform !== "win32") return;
  // Real-world case: user's PWD has lowercase 'documents' but the dir on
  // disk is 'Documents'. Both refer to the same inode on case-insensitive
  // filesystems.
  const home = os.homedir();
  if (path.basename(home) === "") return;
  // Simple check: if a known path exists with one case, the other case
  // should resolve equivalent.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orqlaude-case-"));
  const real = path.join(dir, "Mixed");
  await fs.mkdir(real);
  const swapped = path.join(dir, "mixed");
  // The case-insensitive fast path: even if one variant doesn't exist
  // as a distinct dir, normalizing + lowercasing should match.
  assert.equal(pathsEquivalent(real, swapped), true);
});

test("pathsEquivalent: not fooled into matching genuinely different paths", () => {
  assert.equal(pathsEquivalent("/a/b/c", "/a/b/d"), false);
  assert.equal(pathsEquivalent("/foo", "/bar"), false);
});

test("pathsEquivalent: paths whose leaves don't yet exist still compare", () => {
  const home = os.homedir();
  // Same parent (exists), different leaf — should differ.
  assert.equal(
    pathsEquivalent(path.join(home, "nope-a-xyz"), path.join(home, "nope-b-xyz")),
    false
  );
  // Same leaf, same parent — should match even though the leaf doesn't exist.
  assert.equal(
    pathsEquivalent(path.join(home, "nope-xyz", ".orqlaude"), path.join(home, "nope-xyz", ".orqlaude")),
    true
  );
});
