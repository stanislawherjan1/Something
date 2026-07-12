#!/bin/bash
# headersHelper for remote (type:"http") MCP servers — Claude Code runs this
# at connect time (and re-runs it once on a mid-session 401/403) and expects
# a JSON object of HTTP headers on stdout.
#
# All it does is ask workspace-api for a currently-valid access token for the
# given integration id; the refresh dance lives server-side in
# lib/integrations/oauth.js. wsapi returns the exact header map we need
# ({"Authorization": "Bearer …"}), so the body passes through untouched.
#
# On any failure we print nothing and exit non-zero: Claude Code then treats
# the helper as failed and the server as unavailable for this turn — the next
# turn retries fresh. Printing an empty/invalid map would poison the server's
# cached auth state instead (observed on 2.1.207: a bad token at first
# connect flips the server to "needs OAuth" until restart), so silence is
# deliberately the safer failure mode.
#
# Usage (written by runtime.js syncMcpServers into the mcpServers entry):
#   /opt/ide/mcp-auth-helper.sh <integration-id>

set -euo pipefail

ID="${1:?usage: mcp-auth-helper.sh <integration-id>}"
WSAPI_PORT="${WSAPI_PORT:-3001}"

BODY=$(curl -sf -m 20 "http://127.0.0.1:${WSAPI_PORT}/api/internal/mcp-token/${ID}")

# Belt-and-braces: only forward something that looks like a JSON object —
# never let an HTML error page reach Claude Code's header parser.
case "$BODY" in
  {*) printf '%s\n' "$BODY" ;;
  *)  exit 1 ;;
esac
