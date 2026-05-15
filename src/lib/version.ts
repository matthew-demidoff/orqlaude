/**
 * Single source of truth for the orqlaude runtime version string.
 *
 * Bumping a release: update this constant AND `package.json` together.
 * Everything else reads from here (the MCP server's ping payload, the
 * /ping tool's response, the CLI banner, fleet_summary).
 *
 * Why not read from package.json at runtime? Two reasons:
 *   1. Bundled ESM doesn't have a stable path-to-package.json at runtime
 *      across npx / global / linked installs. resolve() works but each
 *      caller would duplicate the boilerplate.
 *   2. A compile-time string is one less file open + parse per cold start.
 *
 * The trade-off is the bump now touches two files. The build script
 * `npm run release` (or a pre-publish hook) can be wired to keep them in
 * sync automatically; for now they're updated by hand.
 */
export const VERSION = "0.10.3";
