#!/bin/bash
set -e

# Fork wrapper — loads this client's .env, applies logo overrides, then
# delegates to ide-template's deploy.sh for all actual deploy logic.

FORK_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE_DIR="$(cd "$FORK_DIR/../../ide-template" && pwd)"
REPO_ROOT="$(cd "$FORK_DIR/../.." && pwd)"

# Bootstrap missing fields in .env (operator only fills HETZNER_HOST,
# FRONTEND_DOMAIN, IDE_ALLOWED_EMAILS — rest is derived/generated).
"$REPO_ROOT/bin/bootstrap-client-env.sh" "$FORK_DIR/.env"

# Load client .env into environment (now complete after bootstrap)
set -a; source "$FORK_DIR/.env"; set +a

# Reset template public/ to git state, then apply client overrides
# This prevents files from a previous client's deploy from leaking in
rm -f "$TEMPLATE_DIR/frontend/public/"{bot,logo,icon,favicon}.{png,jpg,jpeg,svg}
cp "$TEMPLATE_DIR/frontend/public/workspace-logo.svg" "$TEMPLATE_DIR/frontend/public/favicon.svg"
if [ -d "$FORK_DIR/overrides/public" ]; then
    cp -r "$FORK_DIR/overrides/public/." "$TEMPLATE_DIR/frontend/public/"
fi


SSH_OPTS="-o ServerAliveInterval=15 -o ServerAliveCountMax=6 -o StrictHostKeyChecking=accept-new"

# Upload the newest .env configuration to the server
ssh $SSH_OPTS "$HETZNER_HOST" "mkdir -p $REMOTE_PATH" 2>/dev/null || true
scp $SSH_OPTS "$FORK_DIR/.env" "$HETZNER_HOST:$REMOTE_PATH/.env" || exit 1

# Run the shared deploy logic
cd "$TEMPLATE_DIR"
exec ./deploy.sh "$@"
