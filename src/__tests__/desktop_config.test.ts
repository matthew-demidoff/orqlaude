import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  planPatch,
  buildOrqlaudeEntry,
  readDesktopConfig,
  writeDesktopConfigAtomic,
  findDesktopConfigPath,
  type DesktopConfig,
} from "../lib/desktop_config.js";

/** v0.5.5: regression tests for the desktop_config patcher. */

const STATE_DIR = "/Users/matthew/Documents/orqlaude/.orqlaude";

test("planPatch with no existing config creates one + adds orqlaude entry", () => {
  const result = planPatch(null, STATE_DIR);
  assert.equal(result.action, "create-config");
  assert.equal(result.before, null);
  assert.equal(result.after.command, "npx");
  assert.deepEqual(result.after.args, ["-y", "-p", "@synaplink/orqlaude", "orqlaude-mcp"]);
  assert.equal(result.after.env?.ORQLAUDE_STATE_DIR, STATE_DIR);
});

test("planPatch with existing config but no orqlaude key adds it without touching others", () => {
  const existing: DesktopConfig = {
    mcpServers: {
      "lm-studio": {
        command: "npx",
        args: ["-y", "@mzxrai/mcp-openai"],
        env: { OPENAI_API_KEY: "lm-studio" },
      },
    },
    preferences: { someFlag: true },
  };
  const result = planPatch(existing, STATE_DIR);
  assert.equal(result.action, "create-server");
  // Original is preserved
  assert.deepEqual(result.config.mcpServers!["lm-studio"], existing.mcpServers!["lm-studio"]);
  assert.deepEqual(result.config.preferences, { someFlag: true });
  // New entry present
  assert.equal(result.config.mcpServers!["orqlaude"].env?.ORQLAUDE_STATE_DIR, STATE_DIR);
});

test("planPatch with correct orqlaude entry already present → noop", () => {
  const existing: DesktopConfig = {
    mcpServers: { orqlaude: buildOrqlaudeEntry(STATE_DIR) },
  };
  const result = planPatch(existing, STATE_DIR);
  assert.equal(result.action, "noop");
});

test("planPatch with orqlaude entry at wrong state dir → update; preserve other env keys", () => {
  const existing: DesktopConfig = {
    mcpServers: {
      orqlaude: {
        command: "npx",
        args: ["-y", "-p", "@synaplink/orqlaude", "orqlaude-mcp"],
        env: { ORQLAUDE_STATE_DIR: "/old/path", CUSTOM_DEBUG_FLAG: "1" },
      },
    },
  };
  const result = planPatch(existing, STATE_DIR);
  assert.equal(result.action, "update-server");
  // New state dir applied
  assert.equal(result.after.env?.ORQLAUDE_STATE_DIR, STATE_DIR);
  // Custom env key preserved
  assert.equal(result.after.env?.CUSTOM_DEBUG_FLAG, "1");
});

test("planPatch preserves top-level keys we don't recognize", () => {
  const existing: DesktopConfig = {
    mcpServers: {},
    preferences: { x: 1 },
    futureField: { whatever: true },
  } as DesktopConfig;
  const result = planPatch(existing, STATE_DIR);
  assert.equal(result.action, "create-server");
  assert.deepEqual(result.config.preferences, { x: 1 });
  assert.deepEqual((result.config as DesktopConfig & { futureField: unknown }).futureField, { whatever: true });
});

test("writeDesktopConfigAtomic creates a timestamped backup when the file exists", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orqlaude-desktop-"));
  const filePath = path.join(dir, "config.json");
  await fs.writeFile(filePath, JSON.stringify({ original: true }, null, 2));
  const { backupPath } = await writeDesktopConfigAtomic(filePath, { updated: true } as DesktopConfig);
  assert.ok(backupPath, "expected a backup path");
  const backed = JSON.parse(await fs.readFile(backupPath!, "utf8"));
  assert.deepEqual(backed, { original: true });
  const updated = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(updated, { updated: true });
});

test("writeDesktopConfigAtomic creates parent dirs + no backup on fresh file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orqlaude-desktop-"));
  const filePath = path.join(dir, "nested", "deep", "config.json");
  const { backupPath } = await writeDesktopConfigAtomic(filePath, { fresh: true } as DesktopConfig);
  assert.equal(backupPath, null);
  const got = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(got, { fresh: true });
});

test("readDesktopConfig returns null for missing files; throws on malformed JSON", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orqlaude-desktop-"));
  const filePath = path.join(dir, "config.json");
  assert.equal(await readDesktopConfig(filePath), null);
  await fs.writeFile(filePath, "{ not valid json,,,");
  await assert.rejects(() => readDesktopConfig(filePath), /Failed to parse/);
});

test("findDesktopConfigPath returns a platform-appropriate path", () => {
  const p = findDesktopConfigPath();
  assert.ok(p.endsWith("claude_desktop_config.json"), `got: ${p}`);
  if (process.platform === "darwin") {
    assert.ok(p.includes("Library/Application Support/Claude"), `got: ${p}`);
  } else if (process.platform === "win32") {
    assert.ok(p.includes("Claude"), `got: ${p}`);
  } else {
    assert.ok(p.includes(".config/Claude"), `got: ${p}`);
  }
});
