#!/usr/bin/env bash
# orq-rpc.sh — one-shot RPC against orqlaude's MCP server via stdio.
#
# Usage:
#   scripts/orq-rpc.sh <tool_name> [<args_file_or_json>]
#
# If the second arg is a path to an existing file, read JSON from it.
# Otherwise treat it as inline JSON. Empty defaults to {}.
#
# State persists on disk; each call is a fresh stdio session.

set -euo pipefail

TOOL_NAME="${1:?usage: $0 <tool> [args_file_or_json]}"
ARG2="${2:-}"

if [ -z "$ARG2" ]; then
  ARGS_JSON="{}"
elif [ -f "$ARG2" ]; then
  ARGS_JSON="$(cat "$ARG2")"
else
  ARGS_JSON="$ARG2"
fi

# JSON-RPC framing requires each message on a single line. If the args JSON
# contains literal newlines (e.g. inside string fields), compactify with node.
ARGS_JSON="$(node -e "
const fs = require('fs');
let raw = fs.readFileSync(0, 'utf8');
process.stdout.write(JSON.stringify(JSON.parse(raw)));
" <<< "$ARGS_JSON")"

cd "$(dirname "$0")/.."

# Build the JSON-RPC sequence in a temp file so stdin is one clean piece.
SEQ=$(mktemp)
trap 'rm -f "$SEQ"' EXIT

{
  printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"orq-rpc","version":"0"}}}\n'
  printf '{"jsonrpc":"2.0","method":"notifications/initialized"}\n'
  printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"%s","arguments":' "$TOOL_NAME"
  printf '%s' "$ARGS_JSON"
  printf '}}\n'
} > "$SEQ"

# Run with a small wait for response after final write.
( cat "$SEQ"; sleep 0.6 ) | node dist/server.js 2>/dev/null | node -e "
let buf = '';
process.stdin.on('data', d => buf += d);
process.stdin.on('end', () => {
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m.id === 2 && m.result?.content) {
        process.stdout.write(m.result.content[0].text);
        process.exit(m.result.isError ? 2 : 0);
      } else if (m.id === 2 && m.error) {
        process.stderr.write('RPC error: ' + JSON.stringify(m.error) + '\n');
        process.exit(3);
      }
    } catch {}
  }
  process.stderr.write('no response (raw output below)\n---\n' + buf.slice(0, 2000) + '\n---\n');
  process.exit(4);
});
"
