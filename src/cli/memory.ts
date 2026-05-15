import { MemoryStore, type MemoryEntry, type MemoryCategory } from "../lib/memory.js";
import { style, banner } from "../lib/style.js";
import { hasJsonFlag, emitJson } from "../lib/json_out.js";
import { errorLine, successLine } from "../lib/error_ui.js";

/**
 * `orql memory` - inspect and curate the durable cross-session memory.
 *
 *   list   [--category lore|playbook|ledger|atlas] [--pinned] [--json]
 *   show   <id>
 *   forget <id>
 *   pin    <id>
 *   unpin  <id>
 *
 * `<id>` accepts either a full uuid or its 8-char prefix.
 */

const VALID_CATS = new Set<MemoryCategory>(["lore", "playbook", "ledger", "atlas"]);

export async function cmdMemory(stateDir: string, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    case "list":
      return await cmdMemoryList(stateDir, rest);
    case "show":
      return await cmdMemoryShow(stateDir, rest);
    case "forget":
      return await cmdMemoryForget(stateDir, rest);
    case "pin":
      return await cmdMemoryPinToggle(stateDir, rest, true);
    case "unpin":
      return await cmdMemoryPinToggle(stateDir, rest, false);
    default:
      process.stderr.write(errorLine(`unknown subcommand: memory ${sub}`, "try `orql memory --help`"));
      return 1;
  }
}

function printHelp(): void {
  console.log(banner());
  console.log("");
  console.log(style.bold(style.cream("orql memory")));
  console.log("");
  console.log(`  ${style.coral("orql memory list")} ${style.sand("[--category lore|playbook|ledger|atlas] [--pinned] [--json]")}`);
  console.log(`      List memory entries. Pinned first, then by recency.`);
  console.log(`  ${style.coral("orql memory show")} ${style.sand("<id>")}`);
  console.log(`      Full record for one entry (accepts short 8-char prefix).`);
  console.log(`  ${style.coral("orql memory forget")} ${style.sand("<id>")}`);
  console.log(`      Soft-delete an entry (it stops surfacing in recall).`);
  console.log(`  ${style.coral("orql memory pin")} ${style.sand("<id>")}`);
  console.log(`      Pin an entry; pinned entries always inject into spawn prompts.`);
  console.log(`  ${style.coral("orql memory unpin")} ${style.sand("<id>")}`);
  console.log(`      Remove the pin from an entry.`);
}

function parseCategory(args: string[]): MemoryCategory | undefined {
  const i = args.indexOf("--category");
  if (i === -1) return undefined;
  const raw = args[i + 1];
  if (!raw) throw new Error("--category requires a value (lore|playbook|ledger|atlas)");
  if (!VALID_CATS.has(raw as MemoryCategory)) {
    throw new Error(`unknown category: ${raw} (expected lore|playbook|ledger|atlas)`);
  }
  return raw as MemoryCategory;
}

async function cmdMemoryList(stateDir: string, args: string[]): Promise<number> {
  const isJson = hasJsonFlag(args);
  let category: MemoryCategory | undefined;
  try {
    category = parseCategory(args);
  } catch (err) {
    process.stderr.write(errorLine((err as Error).message));
    return 1;
  }
  const pinnedOnly = args.includes("--pinned");

  const store = new MemoryStore(stateDir);
  let entries = await store.list();
  if (category) entries = entries.filter((e) => e.category === category);
  if (pinnedOnly) entries = entries.filter((e) => e.pinned);
  entries.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return b.createdAt - a.createdAt;
  });

  if (isJson) {
    emitJson(entries);
    return 0;
  }

  console.log(banner());
  console.log("");
  if (entries.length === 0) {
    console.log(style.sand("(no memory entries yet)"));
    return 0;
  }
  console.log(style.bold(style.cream(`memory (${entries.length})`)));
  console.log("");
  const head = `  ${"id".padEnd(8)}  ${"pin".padEnd(3)}  ${"category".padEnd(8)}  ${"key".padEnd(20)}  ${"value".padEnd(60)}  tags`;
  console.log(style.dim(head));
  for (const e of entries) {
    const short = style.dim(e.id.slice(0, 8));
    const pin = e.pinned ? style.coral("⚑  ") : "   ";
    const cat = style.sand(e.category.padEnd(8));
    const key = style.cream(truncate(e.key, 20).padEnd(20));
    const value = truncate(e.value, 60).padEnd(60);
    const tags = (e.tags ?? []).length > 0 ? style.dim((e.tags ?? []).join(",")) : "";
    console.log(`  ${short}  ${pin} ${cat}  ${key}  ${value}  ${tags}`);
  }
  return 0;
}

async function resolveEntry(store: MemoryStore, id: string): Promise<MemoryEntry | undefined> {
  if (!id) return undefined;
  const all = await store.list();
  const exact = all.find((e) => e.id === id);
  if (exact) return exact;
  const matches = all.filter((e) => e.id.startsWith(id));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`ambiguous id prefix '${id}' matches ${matches.length} entries`);
  }
  return undefined;
}

async function cmdMemoryShow(stateDir: string, args: string[]): Promise<number> {
  const isJson = hasJsonFlag(args);
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    process.stderr.write(errorLine("usage: orql memory show <id>"));
    return 2;
  }
  const store = new MemoryStore(stateDir);
  let entry: MemoryEntry | undefined;
  try {
    entry = await resolveEntry(store, id);
  } catch (err) {
    process.stderr.write(errorLine((err as Error).message));
    return 1;
  }
  if (!entry) {
    process.stderr.write(errorLine(`memory entry not found: ${id}`, "try `orql memory list` to see entries"));
    return 1;
  }
  if (isJson) {
    emitJson(entry);
    return 0;
  }
  console.log(banner());
  console.log("");
  console.log(style.bold(style.cream(`memory ${entry.id.slice(0, 8)}`)));
  console.log(`  ${style.sand("id:")}         ${style.dim(entry.id)}`);
  console.log(`  ${style.sand("category:")}   ${style.cream(entry.category)}`);
  console.log(`  ${style.sand("key:")}        ${style.cream(entry.key)}`);
  console.log(`  ${style.sand("value:")}      ${entry.value}`);
  if (entry.rationale) console.log(`  ${style.sand("rationale:")}  ${entry.rationale}`);
  if (entry.scope && entry.scope.length > 0) console.log(`  ${style.sand("scope:")}      ${entry.scope.join(", ")}`);
  if (entry.tags && entry.tags.length > 0) console.log(`  ${style.sand("tags:")}       ${entry.tags.join(", ")}`);
  if (entry.bornFrom) console.log(`  ${style.sand("born_from:")}  ${JSON.stringify(entry.bornFrom)}`);
  console.log(`  ${style.sand("pinned:")}     ${entry.pinned ? style.coral("yes") : style.dim("no")}`);
  console.log(`  ${style.sand("created:")}    ${style.dim(new Date(entry.createdAt).toISOString())}`);
  return 0;
}

async function cmdMemoryForget(stateDir: string, args: string[]): Promise<number> {
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    process.stderr.write(errorLine("usage: orql memory forget <id>"));
    return 2;
  }
  const store = new MemoryStore(stateDir);
  let entry: MemoryEntry | undefined;
  try {
    entry = await resolveEntry(store, id);
  } catch (err) {
    process.stderr.write(errorLine((err as Error).message));
    return 1;
  }
  if (!entry) {
    process.stderr.write(errorLine(`memory entry not found: ${id}`));
    return 1;
  }
  const ok = await store.forget(entry.id);
  if (!ok) {
    process.stderr.write(errorLine(`could not forget ${entry.id.slice(0, 8)} (already gone?)`));
    return 1;
  }
  process.stdout.write(successLine(`forgot ${entry.id.slice(0, 8)} (${entry.category}/${entry.key})`));
  return 0;
}

async function cmdMemoryPinToggle(stateDir: string, args: string[], pinned: boolean): Promise<number> {
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    process.stderr.write(errorLine(`usage: orql memory ${pinned ? "pin" : "unpin"} <id>`));
    return 2;
  }
  const store = new MemoryStore(stateDir);
  let entry: MemoryEntry | undefined;
  try {
    entry = await resolveEntry(store, id);
  } catch (err) {
    process.stderr.write(errorLine((err as Error).message));
    return 1;
  }
  if (!entry) {
    process.stderr.write(errorLine(`memory entry not found: ${id}`));
    return 1;
  }
  if (!!entry.pinned === pinned) {
    process.stdout.write(successLine(`${entry.id.slice(0, 8)} already ${pinned ? "pinned" : "unpinned"}`));
    return 0;
  }
  // No direct toggle API; supersede with a new entry that flips the flag.
  // remember() finds prior entries with the same (category, key) and marks
  // them superseded, so the new pinned/unpinned state is what recall sees.
  const next = await store.remember({
    category: entry.category,
    key: entry.key,
    value: entry.value,
    rationale: entry.rationale,
    scope: entry.scope,
    tags: entry.tags,
    bornFrom: entry.bornFrom,
    pinned,
  });
  process.stdout.write(
    successLine(`${pinned ? "pinned" : "unpinned"} ${next.id.slice(0, 8)} (${next.category}/${next.key})`),
  );
  return 0;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
