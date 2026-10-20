#!/usr/bin/env bash
# =============================================================================
# collect-secrets.sh — gather operator secrets into clients/admin.env
# =============================================================================
# The one place secrets enter a checkout. Run by the PERSON in their own
# terminal — an AI coding agent must never ask for these values in chat and
# never reads them: it verifies progress with --check, which prints set/missing
# per field and no values (see docs/AGENT_SETUP.md).
#
# Interactive mode (no flags): prompts for the shared Google OAuth credentials
# (docs/NEW_CLIENT.md §A1) and the optional Google Cloud project id (used only
# by bin/add-redirect-uri.sh; a stored one is kept when skipped), validates
# their shape, and writes clients/admin.env atomically (umask 077, chmod 600).
# This is install.sh's step 0, extracted so both paths share one
# implementation — install.sh delegates here.
#
# Usage:
#   bin/collect-secrets.sh            interactive collect (needs a terminal)
#   bin/collect-secrets.sh --check    report which fields are set; never prompts
#
# Exit codes (stable contract — agents rely on these):
#   0  secrets saved, kept, or --check found the required fields set
#   1  usage error, or no terminal to prompt on
#   2  --check: a required field is missing — have the person run
#      ./bin/collect-secrets.sh in their own terminal, then re-check
# =============================================================================

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_ENV="$REPO_ROOT/clients/admin.env"

# field present with a non-empty value?
has_field() { grep -qE "^$1=..*" "$ADMIN_ENV" 2>/dev/null; }

# --- --check: TTY-free, prints no values ------------------------------------
if [ "${1:-}" = "--check" ]; then
    status=0
    for f in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
        if has_field "$f"; then echo "$f: set"; else echo "$f: missing"; status=2; fi
    done
    if has_field GOOGLE_OAUTH_PROJECT_ID; then
        echo "GOOGLE_OAUTH_PROJECT_ID: set"
    else
        echo "GOOGLE_OAUTH_PROJECT_ID: missing (optional — only bin/add-redirect-uri.sh needs it)"
    fi
    exit "$status"
elif [ -n "${1:-}" ]; then
    echo "usage: bin/collect-secrets.sh [--check]" >&2
    exit 1
fi

# --- Pretty output (matches install.sh) --------------------------------------
if [ -t 1 ]; then
    BOLD='\033[1m'; RED='\033[0;31m'; GREEN='\033[0;32m'
    # Same accent as install.sh (the landing's honey #f2c14e, 256-color
    # approximation) — swap both together when re-skinning.
    YELLOW='\033[1;33m'; ACCENT='\033[38;5;178m'; DIM='\033[2m'; NC='\033[0m'
else
    BOLD=''; RED=''; GREEN=''; YELLOW=''; ACCENT=''; DIM=''; NC=''
fi
# Visual language matches install.sh: two-space indent, glyphs carry the color.
say()  { printf '%b\n' "$*"; }
ok()   { printf '%b\n' "  ${GREEN}✓${NC} $*"; }
warn() { printf '%b\n' "  ${YELLOW}⚠${NC} $*" >&2; }
err()  { printf '%b\n' "  ${RED}✗${NC} $*" >&2; }

# Prompts read from the terminal directly, so being called from a piped
# install.sh still works. No terminal at all (an agent's shell) → refuse:
# secrets are typed by a person, never passed through a chat or an agent.
tty_fail() {
    err "No interactive terminal available."
    say "  Secrets are typed by a person, never pasted into a chat or an agent's shell."
    say "  Open your own terminal and run:  ${BOLD}./bin/collect-secrets.sh${NC}"
    exit 1
}

if [ -t 0 ]; then TTY="/dev/stdin"; else TTY="/dev/tty"; fi
# `-r` is not enough: with no controlling terminal /dev/tty exists and passes
# the permission check, but opening it fails ("Device not configured" on
# macOS) — probe by actually opening it for read.
{ : <"$TTY"; } 2>/dev/null || tty_fail

ask() {
    local prompt="$1" reply=""
    printf '%b' "  ${BOLD}$prompt${NC} ${ACCENT}›${NC} " >&2
    IFS= read -r reply <"$TTY" || tty_fail   # EOF/lost terminal: abort, don't loop
    printf '%s' "$reply"
}

confirm() {
    local prompt="$1" default="${2:-yes}" reply=""
    local hint="[Y/n]"; [ "$default" = "no" ] && hint="[y/N]"
    printf '%b' "  ${BOLD}$prompt${NC} ${DIM}$hint${NC} ${ACCENT}›${NC} " >&2
    IFS= read -r reply <"$TTY" || tty_fail
    reply="$(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]')"
    [ -z "$reply" ] && reply="$default"
    case "$reply" in y|yes) return 0 ;; *) return 1 ;; esac
}

# --- Collect ------------------------------------------------------------------
# Offer to keep only a COMPLETE set — a hand-edited file missing the secret
# would otherwise sail through and fail much later, at the OAuth verify.
if has_field GOOGLE_CLIENT_ID && has_field GOOGLE_CLIENT_SECRET; then
    if confirm "Found existing Google credentials in clients/admin.env. Keep them?" yes; then
        ok "Keeping the existing credentials."
        exit 0
    fi
fi

say ""
say "  Paste the Google OAuth app's credentials. ${DIM}(How to create the app:${NC}"
say "  ${DIM}docs/NEW_CLIENT.md §A1, or docs/QUICK_START.md §4.)${NC}"
say ""

GOOGLE_CLIENT_ID=""
while :; do
    # ask runs in a subshell — its tty_fail only exits that subshell, so
    # catch the status here too or a dead terminal loops forever.
    GOOGLE_CLIENT_ID="$(ask "Google Client ID (ends in .apps.googleusercontent.com)")" || tty_fail
    case "$GOOGLE_CLIENT_ID" in
        *.apps.googleusercontent.com) break ;;
        "") warn "Can't be empty." ;;
        *) warn "That doesn't look right — it should end in .apps.googleusercontent.com" ;;
    esac
done

GOOGLE_CLIENT_SECRET=""
while :; do
    GOOGLE_CLIENT_SECRET="$(ask "Google Client Secret (starts with GOCSPX-)")" || tty_fail
    case "$GOOGLE_CLIENT_SECRET" in
        GOCSPX-*) break ;;
        "") warn "Can't be empty." ;;
        *) if confirm "That doesn't start with GOCSPX- . Use it anyway?" no; then break; fi ;;
    esac
done

# Optional: only bin/add-redirect-uri.sh (the gcloud automation) needs it.
PROJECT_ID="$(ask "Google Cloud project ID (optional — Enter to skip)")" || tty_fail

# Keep an already-stored project id when the person skips the prompt.
if [ -z "$PROJECT_ID" ] && [ -f "$ADMIN_ENV" ]; then
    PROJECT_ID="$(grep -E '^GOOGLE_OAUTH_PROJECT_ID=' "$ADMIN_ENV" 2>/dev/null | head -1 | cut -d= -f2- || true)"
fi

# Atomic write: tmp in the same directory, then rename — a Ctrl-C mid-write
# never leaves a half-written admin.env behind.
umask 077
TMP="$(mktemp "$ADMIN_ENV.XXXXXX")" || { err "Could not create a temp file next to $ADMIN_ENV"; exit 1; }
{
    echo "# clients/admin.env — shared operator OAuth secrets (written by collect-secrets.sh)"
    echo "GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID"
    echo "GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET"
    echo "GOOGLE_OAUTH_CLIENT_ID=$GOOGLE_CLIENT_ID"
    [ -n "$PROJECT_ID" ] && echo "GOOGLE_OAUTH_PROJECT_ID=$PROJECT_ID"
} > "$TMP"
chmod 600 "$TMP"
mv "$TMP" "$ADMIN_ENV"
ok "Saved credentials to clients/admin.env (chmod 600)."
