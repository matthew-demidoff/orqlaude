import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { detectHallucination } from "../lib/hallucination.js";

async function tmpRepo(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "orqlaude-hallu-"));
}

test("clean session scores 0", async () => {
  const cwd = await tmpRepo();
  const real = path.join(cwd, "real.ts");
  await fs.writeFile(real, "// hi");
  const tools = [
    { name: "Read", input: { file_path: real } },
    { name: "Edit", input: { file_path: real, old_string: "hi", new_string: "hello" } },
    { name: "Bash", input: { command: "npm test" } },
    { name: "Bash", input: { command: "git commit -m 'fix'" } },
  ];
  const report = await detectHallucination(tools, cwd);
  assert.equal(report.score, 0);
  assert.equal(report.level, "clean");
});

test("references to nonexistent paths score moderate-or-higher", async () => {
  const cwd = await tmpRepo();
  const tools = [
    { name: "Read", input: { file_path: path.join(cwd, "nope-a.ts") } },
    { name: "Read", input: { file_path: path.join(cwd, "nope-b.ts") } },
    { name: "Read", input: { file_path: path.join(cwd, "nope-c.ts") } },
    { name: "Edit", input: { file_path: path.join(cwd, "nope-d.ts"), old_string: "x", new_string: "y" } },
  ];
  const report = await detectHallucination(tools, cwd);
  assert.ok(report.score >= 0.3, `expected score >= 0.3 (moderate), got ${report.score}`);
  assert.match(report.concerns[0] ?? "", /don't exist/);
});

test("edit without prior read flags concern", async () => {
  const cwd = await tmpRepo();
  const real = path.join(cwd, "real.ts");
  await fs.writeFile(real, "x");
  const tools = [{ name: "Edit", input: { file_path: real, old_string: "x", new_string: "y" } }];
  const report = await detectHallucination(tools, cwd);
  assert.ok(report.concerns.some((c) => /without first reading/.test(c)));
});

test("tight loop of identical tool calls flags concern", async () => {
  const cwd = await tmpRepo();
  const real = path.join(cwd, "real.ts");
  await fs.writeFile(real, "x");
  const sameCall = { name: "Read", input: { file_path: real } };
  const tools = [sameCall, sameCall, sameCall, sameCall, sameCall];
  const report = await detectHallucination(tools, cwd);
  assert.ok(report.concerns.some((c) => /loop/i.test(c) || /Repeated/.test(c)));
});

test("commit without tests flags concern", async () => {
  const cwd = await tmpRepo();
  const real = path.join(cwd, "real.ts");
  await fs.writeFile(real, "x");
  const tools = [
    { name: "Read", input: { file_path: real } },
    { name: "Edit", input: { file_path: real, old_string: "x", new_string: "y" } },
    { name: "Bash", input: { command: "git add -A && git commit -m 'wip'" } },
  ];
  const report = await detectHallucination(tools, cwd);
  assert.ok(report.concerns.some((c) => /without running tests/.test(c)));
});
