#!/usr/bin/env bash
# Local dev — workspace-api on :3001 against a throwaway PROJECT_DIR.
#
# Run from repo root:
#   ./scripts/dev-local.sh
#
# Then in another terminal:
#   cd ide-template/frontend
#   DEV_LOCAL=1 npm run dev
#   # open http://localhost:3000/app/
#
# The frontend Vite proxy (DEV_LOCAL=1 enables this) forges an
# `X-IDE-User: dev@local` header on every /api/* request so workspace-api's
# header-trust mode accepts the actor. Override the actor email with
# DEV_ACTOR=foo@bar.com if you want to test team/admin gates.
#
# What you get:
#   - workspace-api responds to /api/chat, /api/chat/sessions/*, /api/files/*,
#     /api/branding, /api/integrations, etc.
#   - /api/chat tries to spawn `claude -p`. If CLAUDE_BIN isn't on PATH or
#     OAuth token is missing, the SSE stream emits an `error` event the UI
#     surfaces in red. UI navigation / sessions CRUD / sidebar still work.
#   - Session jsonl files land in /tmp/ide-dev-workspace/.team/users/default/chats/

set -euo pipefail

DEV_ROOT="${DEV_ROOT:-/tmp/ide-dev-workspace}"
mkdir -p "$DEV_ROOT/.team/users/default/chats"
mkdir -p "$DEV_ROOT/memory/cards"
mkdir -p "$DEV_ROOT/.chat"

if [ ! -f "$DEV_ROOT/.team/users/default/chats/_index.json" ]; then
  cat > "$DEV_ROOT/.team/users/default/chats/_index.json" <<'EOF'
{ "version": 1, "sessions": [] }
EOF
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WSAPI_DIR="$REPO_ROOT/ide-template/workspace-api"

if [ ! -d "$WSAPI_DIR/node_modules" ]; then
  echo "[dev-local] installing workspace-api node_modules…"
  (cd "$WSAPI_DIR" && npm install)
fi

export PROJECT_DIR="$DEV_ROOT"
export PORT=3001
export WORKSPACE_API_PORT=3001
export CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || echo claude)}"
# Unset SESSION_SECRET so workspace-api falls back to header-trust mode.
# NODE_ENV must NOT be 'production' (auth.js refuses to boot without secret).
unset SESSION_SECRET
export NODE_ENV=development

# Misc workspace-api-required env that has sane defaults in prod but is
# missing in a bare local run. Set the minimum needed to not crash at boot.
export INTEGRATIONS_KEY="${INTEGRATIONS_KEY:-$(openssl rand -hex 32 2>/dev/null || echo "0000000000000000000000000000000000000000000000000000000000000000")}"
export BOT_NAME="${BOT_NAME:-devbot}"
export BOT_DISPLAY_NAME="${BOT_DISPLAY_NAME:-Devbot}"
export IDE_NAME="${IDE_NAME:-dev-ide}"

echo "[dev-local] PROJECT_DIR=$PROJECT_DIR"
echo "[dev-local] PORT=$PORT"
echo "[dev-local] CLAUDE_BIN=$CLAUDE_BIN (turns may fail if not actually installed)"
echo "[dev-local] header-trust mode (SESSION_SECRET unset). Frontend must run with DEV_LOCAL=1."
echo
echo "[dev-local] starting workspace-api on :3001…"
echo

cd "$WSAPI_DIR"
exec node --watch index.js
