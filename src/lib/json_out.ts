/**
 * `--json` mode helper.
 *
 * When `--json` is present on any read command, orqlaude prints pure JSON
 * to stdout (no banner, no colors, no decoration) — suitable for piping
 * into `jq` or scripts.
 */

export function hasJsonFlag(args: string[]): boolean {
  return args.includes("--json");
}

export function emitJson(payload: unknown): void {
  // Disable colors for child fs/style helpers running while we serialize.
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}
