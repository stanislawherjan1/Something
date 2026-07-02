#!/bin/bash
# =============================================================================
# DEPRECATED — server hardening now runs automatically on every deploy.
# =============================================================================
# The one-time hardening this script used to do (fail2ban, key-only sshd,
# unattended security upgrades, swap, SSH login alerts) moved into
# bin/ensure-server.sh, which deploy.sh runs as step [0b/5] on EVERY deploy —
# idempotently, so there is no "remember to harden" step any more.
#
# This wrapper stays for muscle memory / old runbooks. It accepts the same
# arguments as before and simply delegates:
#   harden-server.sh [root@SERVER_IP] [BOT_TOKEN] [CHAT_ID]
# or, run from a client directory, it reads .env like it always did.
# =============================================================================

set -e

echo "NOTE: harden-server.sh is deprecated — deploy.sh now converges the" >&2
echo "      server on every deploy (bin/ensure-server.sh). Delegating..." >&2
echo "" >&2

# Positional args override .env, matching the old interface.
[ -n "${1:-}" ] && export HETZNER_HOST="$1"
[ -n "${2:-}" ] && export TELEGRAM_BOT_TOKEN="$2"
[ -n "${3:-}" ] && export TELEGRAM_ADMIN_CHAT_ID="$3"

if [ -z "${HETZNER_HOST:-}" ] && [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$REPO_ROOT/bin/ensure-server.sh"
