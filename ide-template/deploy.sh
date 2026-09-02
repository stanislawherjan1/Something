#!/bin/bash
set -e

# ============================================================================
# Zero-Downtime Deployment Script
# ============================================================================
# Parametric — all target config comes from .env:
#   HETZNER_HOST   e.g. root@203.0.113.10
#   REMOTE_PATH    e.g. /root/example-ide
#   IDE_NAME       e.g. example-ide  (Docker container name for health check)
#   BOT_NAME       e.g. bot          (for Telegram notification message)
#
# Usage:
#   ./deploy.sh           — deploy all services
#   ./deploy.sh frontend  — deploy frontend only
#   ./deploy.sh auth      — deploy auth-service only
#   ./deploy.sh code-server — deploy IDE container only
# ============================================================================

# Keep SSH/SCP connections alive during slow transfers (prevents timeout on
# Hetzner). ControlMaster + ControlPersist: open ONE persistent SSH connection
# and multiplex every scp/ssh through it. Without this, the deploy opens 30+
# fresh TCP handshakes and on flaky networks (or against sshd MaxStartups
# limits) starts timing out partway through. The socket lives in /tmp scoped
# to host:port:user, so concurrent deploys for different clients don't collide.
SSH_CTRL="/tmp/wsdeploy-%h-%p-%r.sock"
SSH_OPTS="-o ServerAliveInterval=15 -o ServerAliveCountMax=6 -o StrictHostKeyChecking=accept-new -o ControlMaster=auto -o ControlPath=$SSH_CTRL -o ControlPersist=10m"
alias ssh="ssh $SSH_OPTS"
alias scp="scp $SSH_OPTS"
shopt -s expand_aliases

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# --- Load .env (skip if vars already injected by a fork wrapper) ---
if [ -z "$HETZNER_HOST" ]; then
    if [ ! -f .env ]; then
        echo -e "${RED}ERROR: .env not found and HETZNER_HOST not set.${NC}"
        echo -e "${RED}Run from repo root, or use your fork's deploy.sh wrapper.${NC}"
        exit 1
    fi
    set -a; source .env; set +a
fi

# --- Admin shared env — secrets shared across all clients ---
# Holds GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET for the one shared OAuth app
# the admin maintains for every client. Per-client .env shouldn't carry
# these any more — onboarding a new client = adding their callback URI to
# the shared OAuth app + dropping their primary email into IDE_ALLOWED_EMAILS.
# Variables already set in the per-client .env take precedence (legacy
# clients that haven't migrated yet keep working unchanged).
#
# Default location: <repo>/clients/admin.env (ignored by git via clients/.gitignore).
# Override with WORKSPACE_ADMIN_ENV if you want it elsewhere (e.g. $HOME for
# multi-machine sync via a private dotfiles repo).
THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADMIN_ENV="${WORKSPACE_ADMIN_ENV:-$THIS_DIR/../clients/admin.env}"
if [ -f "$ADMIN_ENV" ] && [ -s "$ADMIN_ENV" ]; then
    # Snapshot per-client values that should win over admin.env (per-client
    # .env was already sourced by the wrapper). We re-export them after the
    # admin.env source so admin.env never overrides what the client picked.
    _CLIENT_GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"
    _CLIENT_GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-}"
    set -a
    # shellcheck disable=SC1090
    . "$ADMIN_ENV"
    set +a
    [ -n "$_CLIENT_GOOGLE_CLIENT_ID" ]     && export GOOGLE_CLIENT_ID="$_CLIENT_GOOGLE_CLIENT_ID"
    [ -n "$_CLIENT_GOOGLE_CLIENT_SECRET" ] && export GOOGLE_CLIENT_SECRET="$_CLIENT_GOOGLE_CLIENT_SECRET"
    unset _CLIENT_GOOGLE_CLIENT_ID _CLIENT_GOOGLE_CLIENT_SECRET
fi

# --- Validate required deploy vars ---
if [ -z "$HETZNER_HOST" ] || [ "$HETZNER_HOST" = "root@YOUR_SERVER_IP" ]; then
    echo -e "${RED}ERROR: HETZNER_HOST not set in .env${NC}"
    exit 1
fi
# SECURITY: Validate HETZNER_HOST format to prevent SSH injection (user@host only, no extra chars).
if ! echo "$HETZNER_HOST" | grep -qE '^[a-zA-Z0-9_-]+@[a-zA-Z0-9._-]+$'; then
    echo -e "${RED}ERROR: HETZNER_HOST has invalid format (expected user@host): $HETZNER_HOST${NC}"
    exit 1
fi
if [ -z "$REMOTE_PATH" ]; then
    echo -e "${RED}ERROR: REMOTE_PATH not set in .env${NC}"
    exit 1
fi
# SECURITY: Validate REMOTE_PATH to prevent injection via special chars.
if ! echo "$REMOTE_PATH" | grep -qE '^/[a-zA-Z0-9/._-]+$'; then
    echo -e "${RED}ERROR: REMOTE_PATH contains invalid characters: $REMOTE_PATH${NC}"
    exit 1
fi
IDE_NAME="${IDE_NAME:-$(basename "$REMOTE_PATH")}"
BOT_DISPLAY="$(echo "${BOT_NAME:-bot}" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"

DEPLOY_TARGET="${1:-all}"

# Non-fatal problems accumulate here instead of scrolling past as one-line
# warnings; a deploy that "succeeded" with a broken OAuth forward or a stale
# Caddy config is NOT a success — we finish all steps, then fail loudly.
DEPLOY_ERRORS=()

echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║    ${IDE_NAME} — Zero-Downtime Deployment${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${CYAN}Target:    $HETZNER_HOST${NC}"
echo -e "${CYAN}Remote:    $REMOTE_PATH${NC}"
echo -e "${CYAN}Container: $IDE_NAME${NC}"
echo -e "${CYAN}Bot:       ${BOT_NAME:-none}${NC}"
echo ""

# ─── Step 0: Preflight + server converge ─────────────────────────────────────
# Preflight fails fast (<10s) on anything that would otherwise kill the deploy
# minutes into the build: SSH auth, DNS→IP mismatch (TLS provisioning), full
# remote disk, dirty working tree (deploys ship the working tree). Exit 2 =
# fix the reported issue and re-run; always safe to retry.
# Converge then brings the server to baseline (docker, ufw, swap, fail2ban,
# auto security patches, key-only sshd, login alerts) — idempotent, a no-op
# on an already-converged host. This replaces the old "remember to run
# scripts/harden-server.sh once" step, so fresh AND existing clients get the
# baseline (e.g. build swap) on every deploy.
# Escape hatches: SKIP_PREFLIGHT=1 / SKIP_ENSURE=1 (debugging only).
if [ "${SKIP_PREFLIGHT:-0}" != "1" ]; then
    echo -e "${GREEN}[0/5] Preflight checks...${NC}"
    "$THIS_DIR/../bin/preflight.sh" || exit 2
    echo ""
fi
if [ "${SKIP_ENSURE:-0}" != "1" ]; then
    echo -e "${GREEN}[0b/5] Converging server baseline...${NC}"
    "$THIS_DIR/../bin/ensure-server.sh" || exit 2
    echo ""
fi

# ─── Forward shared OAuth from admin.env to remote .env ─────────────────────
# admin.env is sourced *locally* above, but `docker compose up` runs on the
# remote host and only sees `${REMOTE_PATH}/.env`. Without this hop, the
# auth-service container starts with empty GOOGLE_CLIENT_ID/SECRET and exits
# with "must be set" → 502 at /auth/google. Forward only when the local env
# has values (i.e. operator is using the shared OAuth model).
if [ -n "$GOOGLE_CLIENT_ID" ] && [ -n "$GOOGLE_CLIENT_SECRET" ]; then
    # Pass values via ssh's env-style invocation so quoting is bash-safe even
    # if the secret happens to contain shell metacharacters. Locally we just
    # interpolate into a single command line; remote bash sees them as the
    # variables _GCID / _GCS and writes them out verbatim.
    if ssh "$HETZNER_HOST" \
        "_GCID=$(printf '%q' "$GOOGLE_CLIENT_ID") _GCS=$(printf '%q' "$GOOGLE_CLIENT_SECRET") REMOTE_PATH=$(printf '%q' "$REMOTE_PATH") bash -s" <<'REMOTE_FORWARD'
set -e
f="$REMOTE_PATH/.env"
if [ -f "$f" ]; then
    sed -i.bak '/^GOOGLE_CLIENT_ID=/d; /^GOOGLE_CLIENT_SECRET=/d' "$f"
    rm -f "${f}.bak"
else
    mkdir -p "$REMOTE_PATH"
    : > "$f"
fi
printf 'GOOGLE_CLIENT_ID=%s\nGOOGLE_CLIENT_SECRET=%s\n' "$_GCID" "$_GCS" >> "$f"
chmod 600 "$f"
REMOTE_FORWARD
    then
        echo -e "${CYAN}  Forwarded shared OAuth from clients/admin.env → $REMOTE_PATH/.env${NC}"
    else
        echo -e "${RED}  WARNING: couldn't push admin.env OAuth to remote .env${NC}"
        DEPLOY_ERRORS+=("OAuth forward failed — auth-service may boot with empty GOOGLE_CLIENT_ID (502 at /auth/google)")
    fi
fi

# ─── Step 1: Upload files ────────────────────────────────────────────────────
# Capture the source revision HERE, before the first scp — this is the code that
# actually gets uploaded. The manifest used to read HEAD at the END instead, and
# a build takes ~15 minutes, so any commit made while the deploy ran was stamped
# into the manifest without its code ever having been sent. That is worse than a
# cosmetic slip: verify-drift.sh compares exactly this field, so the tool meant
# to detect drift would report a torn deploy as being in sync. Observed live on
# 2026-09-01 — the manifest claimed a commit four ahead of what shipped.
UPLOAD_COMMIT="$(git -C "$THIS_DIR/.." rev-parse HEAD 2>/dev/null || echo unknown)"
UPLOAD_REF="$(git -C "$THIS_DIR/.." rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
UPLOAD_DIRTY=false
git -C "$THIS_DIR/.." diff --quiet HEAD 2>/dev/null || UPLOAD_DIRTY=true

echo -e "${GREEN}[1/5] Uploading files...${NC}"

scp Dockerfile               "$HETZNER_HOST:$REMOTE_PATH/" || exit 1
scp Dockerfile.egress-proxy  "$HETZNER_HOST:$REMOTE_PATH/" || exit 1
scp docker-compose.yml       "$HETZNER_HOST:$REMOTE_PATH/" || exit 1
scp entrypoint.sh            "$HETZNER_HOST:$REMOTE_PATH/" || exit 1
scp global-claude.md         "$HETZNER_HOST:$REMOTE_PATH/" || exit 1

# Egress proxy — Node HTTP CONNECT proxy in its own container.
# See ide-template/Dockerfile.egress-proxy + ide-template/scripts/...

# ─── Mirrored trees ──────────────────────────────────────────────────────────
# `scp -r` only ADDS. A file deleted from the source tree therefore lingers in
# the remote build context for ever, and `COPY <dir>` bakes the stale copy into
# the next image — so a deletion never actually reaches a deployed client. This
# bit the skill tree once (a rename shipped BOTH folders) and was fixed there
# only; the same hole was still open for hooks, scripts, bootstrap and the
# workspace-api source, where it kept four retired modules and a retired hook
# alive in the image after they were removed from the repo.
#
# Wipe-then-upload, so the remote context is a MIRROR of the source, not an
# accumulation of every version ever deployed.
mirror_dir() {
    local local_dir="$1" remote_dir="$2"
    ssh "$HETZNER_HOST" "rm -rf '$remote_dir' && mkdir -p '$remote_dir'" || exit 1
    scp -r "$local_dir/." "$HETZNER_HOST:$remote_dir/" || exit 1
}

# Note: source lives in repo-root scripts/ alongside the host-side
# install-egress.sh; the Dockerfile.egress-proxy copies it into the
# image. We scp it to a path the Dockerfile build context will see
# (REMOTE_PATH/scripts/).
mirror_dir scripts "$REMOTE_PATH/scripts"
# Dropped in AFTER the mirror: this one comes from the repo root, not from
# ide-template/scripts, so mirroring would otherwise delete it.
scp ../scripts/egress-proxy.js "$HETZNER_HOST:$REMOTE_PATH/scripts/" || exit 1

# ─── Plugin marketplace pre-clone (build-time embed) ─────────────────────────
# Dockerfile LAYER 2b.5 COPYs the telegram plugin source from
# plugins-src/ in the build context. We clone the marketplace HERE
# (on the deploy host, where shell network works) instead of inside
# the Docker build (where buildkit's network terminates github CDN
# fetches with TCP RST on some Hetzner hosts — caught 2026-05-12).
# Pin the marketplace commit so identical builds produce identical
# images; bump manually when you want to refresh the telegram plugin.
echo -e "${CYAN}  Cloning plugin marketplace into build context...${NC}"
# Pinned to HTTP/1.1 and retried. git 2.43 (via libcurl) intermittently fails
# its HTTP/2 negotiation with github.com and receives a truncated ref listing;
# it surfaces that as "expected flush after ref listing" preceded by a request
# for credentials on a PUBLIC repo, which reads like an auth problem and is not
# one. Diagnosed by elimination on the box: curl fetched the very same
# info/refs endpoint over HTTP/2 with a 200 and a valid listing, protocol.version=1
# made no difference, and `-c http.version=HTTP/1.1` cloned reliably.
# GIT_TERMINAL_PROMPT=0 keeps a genuine auth failure fast instead of blocking on
# a username prompt nobody can answer over ssh. This is step one of a
# ~15-minute deploy, so a blip here must not cost the whole run.
ssh "$HETZNER_HOST" "
    set -e
    cd '$REMOTE_PATH'
    for attempt in 1 2 3; do
        rm -rf plugins-src
        if GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 clone --depth 1 -q \
              https://github.com/anthropics/claude-plugins-official.git plugins-src; then
            rm -rf plugins-src/.git
            exit 0
        fi
        echo \"  plugin marketplace clone failed (attempt \$attempt/3) — retrying\" >&2
        sleep \$((attempt * 3))
    done
    echo '  plugin marketplace clone failed after 3 attempts' >&2
    exit 1
" || exit 1

# Setuid wrappers (Phase-2/3 broker + uid isolation) — Dockerfile compiles
# them in-image into /usr/local/bin/{wsapi,mcp,bot}-runner with mode 4755
# root-owned.
ssh "$HETZNER_HOST" "mkdir -p '$REMOTE_PATH/setuid-wrappers'"
scp setuid-wrappers/wsapi-runner.c   "$HETZNER_HOST:$REMOTE_PATH/setuid-wrappers/" || exit 1
scp setuid-wrappers/mcp-runner.c     "$HETZNER_HOST:$REMOTE_PATH/setuid-wrappers/" || exit 1
scp setuid-wrappers/bot-runner.c     "$HETZNER_HOST:$REMOTE_PATH/setuid-wrappers/" || exit 1
scp setuid-wrappers/monitor-runner.c "$HETZNER_HOST:$REMOTE_PATH/setuid-wrappers/" || exit 1
scp setuid-wrappers/README.md        "$HETZNER_HOST:$REMOTE_PATH/setuid-wrappers/" || exit 1

# Default skills (always installed) + optional skills (installed when
# matching integration activates).
# Clean-rebuild both skill trees so DELETED skills (e.g. renames like
# 2026-05-29's _security/ → security/) actually disappear from the
# build context. Otherwise scp -r just additively overlays — the old
# folder lingers, Docker COPY ships both into the image, and the bot
# sees two duplicate skills at runtime.
mirror_dir skills/default "$REMOTE_PATH/skills/default"
if [ -d skills/optional ]; then
    mirror_dir skills/optional "$REMOTE_PATH/skills/optional"
else
    ssh "$HETZNER_HOST" "rm -rf '$REMOTE_PATH/skills/optional' && mkdir -p '$REMOTE_PATH/skills/optional'" || exit 1
fi

# First-run bootstrap templates (folder structure + system reminders + Tasks/Pending)
mirror_dir bootstrap "$REMOTE_PATH/bootstrap"

# CC hooks (PostToolUse / Stop / etc — wired in via ~/.claude/settings.json,
# template at bootstrap/claude-settings.json). Sources in ide-template/hooks/.
mirror_dir hooks "$REMOTE_PATH/hooks"

# Helper scripts (Bundle 6: frontmatter stamping, etc).

scp Caddyfile              "$HETZNER_HOST:$REMOTE_PATH/" 2>/dev/null || true
scp inject.js overrides.css mobile.js "$HETZNER_HOST:$REMOTE_PATH/" || exit 1
scp settings.json "$HETZNER_HOST:$REMOTE_PATH/" || exit 1
ssh "$HETZNER_HOST" "mkdir -p '$REMOTE_PATH/extensions'"
scp -r extensions/branding "$HETZNER_HOST:$REMOTE_PATH/extensions/" || exit 1

# Bot scripts
ssh "$HETZNER_HOST" "mkdir -p '$REMOTE_PATH/bot'"
scp bot/bot.sh                "$HETZNER_HOST:$REMOTE_PATH/bot/" || exit 1
scp bot/bot-notify.sh         "$HETZNER_HOST:$REMOTE_PATH/bot/" || exit 1
scp bot/web-notify.sh         "$HETZNER_HOST:$REMOTE_PATH/bot/" || exit 1
scp bot/mcp-auth-helper.sh    "$HETZNER_HOST:$REMOTE_PATH/bot/" || exit 1
scp bot/bot-relay.sh          "$HETZNER_HOST:$REMOTE_PATH/bot/" || exit 1
scp bot/tmux-inject.sh        "$HETZNER_HOST:$REMOTE_PATH/bot/" || exit 1
scp bot/reminder-monitor.sh   "$HETZNER_HOST:$REMOTE_PATH/bot/" || exit 1
scp bot/recent-snapshot-monitor.sh "$HETZNER_HOST:$REMOTE_PATH/bot/" || exit 1
scp bot/browser-watchdog.sh   "$HETZNER_HOST:$REMOTE_PATH/bot/" || exit 1
scp bot/ecosystem.config.js   "$HETZNER_HOST:$REMOTE_PATH/bot/" || exit 1

# MCP servers
ssh "$HETZNER_HOST" "mkdir -p '$REMOTE_PATH/apps/shopify-mcp' '$REMOTE_PATH/apps/meta-mcp' '$REMOTE_PATH/apps/seedream-mcp' '$REMOTE_PATH/apps/google-ads-mcp' '$REMOTE_PATH/apps/reminder-mcp' '$REMOTE_PATH/apps/tasks-mcp' '$REMOTE_PATH/apps/pdf-mcp' '$REMOTE_PATH/apps/nano-banana-mcp' '$REMOTE_PATH/apps/signwell-mcp' '$REMOTE_PATH/apps/workspace-api-mcp'"
scp apps/shopify-mcp/index.js       "$HETZNER_HOST:$REMOTE_PATH/apps/shopify-mcp/"     || exit 1
scp apps/shopify-mcp/package.json   "$HETZNER_HOST:$REMOTE_PATH/apps/shopify-mcp/"     || exit 1
scp apps/meta-mcp/index.js          "$HETZNER_HOST:$REMOTE_PATH/apps/meta-mcp/"        || exit 1
scp apps/meta-mcp/package.json      "$HETZNER_HOST:$REMOTE_PATH/apps/meta-mcp/"        || exit 1
scp apps/google-ads-mcp/index.js    "$HETZNER_HOST:$REMOTE_PATH/apps/google-ads-mcp/"  || exit 1
scp apps/google-ads-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/google-ads-mcp/" || exit 1
scp apps/seedream-mcp/index.js       "$HETZNER_HOST:$REMOTE_PATH/apps/seedream-mcp/"     || exit 1
scp apps/seedream-mcp/package.json   "$HETZNER_HOST:$REMOTE_PATH/apps/seedream-mcp/"     || exit 1
ssh "$HETZNER_HOST" "mkdir -p '$REMOTE_PATH/apps/nano-banana-mcp'"
scp apps/nano-banana-mcp/index.js    "$HETZNER_HOST:$REMOTE_PATH/apps/nano-banana-mcp/"  || exit 1
scp apps/nano-banana-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/nano-banana-mcp/" || exit 1
scp apps/reminder-mcp/index.js       "$HETZNER_HOST:$REMOTE_PATH/apps/reminder-mcp/"     || exit 1
scp apps/reminder-mcp/recur.cjs      "$HETZNER_HOST:$REMOTE_PATH/apps/reminder-mcp/"     || exit 1
scp apps/reminder-mcp/package.json   "$HETZNER_HOST:$REMOTE_PATH/apps/reminder-mcp/"     || exit 1
scp apps/tasks-mcp/index.js          "$HETZNER_HOST:$REMOTE_PATH/apps/tasks-mcp/"        || exit 1
scp apps/tasks-mcp/package.json      "$HETZNER_HOST:$REMOTE_PATH/apps/tasks-mcp/"        || exit 1
# pdf-mcp — markdown→PDF (weasyprint). index.js speaks MCP + shells to render.py;
# house.css is the shared stylesheet. All four files are needed on the remote
# build context for the Dockerfile's `COPY apps/pdf-mcp`.
scp apps/pdf-mcp/index.js            "$HETZNER_HOST:$REMOTE_PATH/apps/pdf-mcp/"          || exit 1
scp apps/pdf-mcp/package.json        "$HETZNER_HOST:$REMOTE_PATH/apps/pdf-mcp/"          || exit 1
scp apps/pdf-mcp/render.py           "$HETZNER_HOST:$REMOTE_PATH/apps/pdf-mcp/"          || exit 1
scp apps/pdf-mcp/house.css           "$HETZNER_HOST:$REMOTE_PATH/apps/pdf-mcp/"          || exit 1
scp apps/workspace-api-mcp/index.js     "$HETZNER_HOST:$REMOTE_PATH/apps/workspace-api-mcp/" || exit 1
scp apps/workspace-api-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/workspace-api-mcp/" || exit 1
ssh "$HETZNER_HOST" "mkdir -p '$REMOTE_PATH/apps/miniapp-mcp'"
scp apps/miniapp-mcp/index.js        "$HETZNER_HOST:$REMOTE_PATH/apps/miniapp-mcp/"        || exit 1
scp apps/miniapp-mcp/package.json    "$HETZNER_HOST:$REMOTE_PATH/apps/miniapp-mcp/"        || exit 1
ssh "$HETZNER_HOST" "mkdir -p '$REMOTE_PATH/apps/web-channel-mcp'"
scp apps/web-channel-mcp/index.js       "$HETZNER_HOST:$REMOTE_PATH/apps/web-channel-mcp/"   || exit 1
scp apps/web-channel-mcp/package.json   "$HETZNER_HOST:$REMOTE_PATH/apps/web-channel-mcp/"   || exit 1
ssh "$HETZNER_HOST" "mkdir -p '$REMOTE_PATH/apps/email-mcp'"
scp apps/email-mcp/index.js     "$HETZNER_HOST:$REMOTE_PATH/apps/email-mcp/" || exit 1
scp apps/email-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/email-mcp/" || exit 1

# GitHub MCP — thin node wrapper around the official github/github-mcp-server
# Go binary. The Go binary itself is downloaded inside the Docker build (curl
# from GH releases, pinned to GITHUB_MCP_VERSION); we only ship the wrapper
# sources here.
ssh "$HETZNER_HOST" "mkdir -p '$REMOTE_PATH/apps/github-mcp'"
scp apps/github-mcp/index.js     "$HETZNER_HOST:$REMOTE_PATH/apps/github-mcp/" || exit 1
scp apps/github-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/github-mcp/" || exit 1

# Grok MCP — xAI Grok via OpenAI-compatible API. Single API key, ships
# alongside the other MCPs. Activated per-client through the workspace
# Integrations dashboard, not via env at deploy time.
ssh "$HETZNER_HOST" "mkdir -p '$REMOTE_PATH/apps/grok-mcp'"
scp apps/grok-mcp/index.js     "$HETZNER_HOST:$REMOTE_PATH/apps/grok-mcp/" || exit 1
scp apps/grok-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/grok-mcp/" || exit 1

# OpenAI MCP — ask_gpt for second-opinion / cross-check. Activated per-client
# through the Integrations dashboard (OPENAI_API_KEY).
ssh "$HETZNER_HOST" "mkdir -p '$REMOTE_PATH/apps/openai-mcp'"
scp apps/openai-mcp/index.js     "$HETZNER_HOST:$REMOTE_PATH/apps/openai-mcp/" || exit 1
scp apps/openai-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/openai-mcp/" || exit 1

# Docs Comments MCP (Playwright range-anchored Google Docs comments) — tracked,
# shipped to every client like any other MCP. (Reply/resolve/delete live in
# gdocs-mcp over the Drive API; this MCP only does the anchored add.)
ssh "$HETZNER_HOST" "mkdir -p '$REMOTE_PATH/apps/docs-comments-mcp'"
scp apps/docs-comments-mcp/index.js      "$HETZNER_HOST:$REMOTE_PATH/apps/docs-comments-mcp/" || exit 1
scp apps/docs-comments-mcp/package.json  "$HETZNER_HOST:$REMOTE_PATH/apps/docs-comments-mcp/" || exit 1
scp apps/docs-comments-mcp/keepalive.mjs "$HETZNER_HOST:$REMOTE_PATH/apps/docs-comments-mcp/" || exit 1

# Generic operator-only catalog-fragment mechanism. No integration uses it
# today (docs-comments is now in the main catalog), but the hook stays for any
# future per-operator-machine integration: present locally → ships → wsapi
# merges at startup; absent → no-op.
if [ -f workspace-api/integrations.catalog.local.json ]; then
    scp workspace-api/integrations.catalog.local.json \
        "$HETZNER_HOST:$REMOTE_PATH/workspace-api/integrations.catalog.local.json" || exit 1
    echo "  catalog.local.json staged — adds private integration card(s)"
fi

# Gemini MCP (chat) — ask_gemini for second-opinion / long-context reads.
# Separate from nano-banana (image). Shares GEMINI_API_KEY with that integration.
ssh "$HETZNER_HOST" "mkdir -p '$REMOTE_PATH/apps/gemini-chat-mcp'"
scp apps/gemini-chat-mcp/index.js     "$HETZNER_HOST:$REMOTE_PATH/apps/gemini-chat-mcp/" || exit 1
scp apps/gemini-chat-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/gemini-chat-mcp/" || exit 1

scp apps/signwell-mcp/index.js     "$HETZNER_HOST:$REMOTE_PATH/apps/signwell-mcp/" || exit 1
scp apps/signwell-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/signwell-mcp/" || exit 1

# Trello MCP — board/card read + comment/label/move via REST API. Activated
# per-client through the Integrations dashboard.
ssh "$HETZNER_HOST" "mkdir -p '$REMOTE_PATH/apps/trello-mcp'"
scp apps/trello-mcp/index.js     "$HETZNER_HOST:$REMOTE_PATH/apps/trello-mcp/" || exit 1
scp apps/trello-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/trello-mcp/" || exit 1

# Google Docs MCP — Docs + Drive REST via OAuth refresh token. Per-user OAuth
# credentials (client_id, secret, refresh_token) stored in the encrypted
# integrations store.
ssh "$HETZNER_HOST" "mkdir -p '$REMOTE_PATH/apps/gdocs-mcp'"
scp apps/gdocs-mcp/index.js     "$HETZNER_HOST:$REMOTE_PATH/apps/gdocs-mcp/" || exit 1
scp apps/gdocs-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/gdocs-mcp/" || exit 1

# X (Twitter) MCP — read-only X data via twitterapi.io (no X dev approval,
# no user account exposure — just an API key from twitterapi.io).
ssh "$HETZNER_HOST" "mkdir -p '$REMOTE_PATH/apps/x-mcp'"
scp apps/x-mcp/index.js     "$HETZNER_HOST:$REMOTE_PATH/apps/x-mcp/" || exit 1
scp apps/x-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/x-mcp/" || exit 1

# Substack MCP — read public posts / authors / Notes without auth; optional
# session cookie unlocks publishing, Notes posting, comments, restacks.
ssh "$HETZNER_HOST" "mkdir -p '$REMOTE_PATH/apps/substack-mcp'"
scp apps/substack-mcp/index.js     "$HETZNER_HOST:$REMOTE_PATH/apps/substack-mcp/" || exit 1
scp apps/substack-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/substack-mcp/" || exit 1

# Shared helpers imported via `../_shared/<file>.js` at spawn time by every
# brokered MCP (Google Workspace, email, etc.). Recursive scp — historically
# this was a hand-maintained list of explicit files, and adding a new file
# (e.g. wrap-untrusted.js for untrusted-content spotlight delimiters) meant
# the file lived in the repo + Dockerfile picked it up locally, but the
# build context on the remote was missing it and the image came out
# broken. Recursive copy is future-proof: any file dropped into _shared/
# gets shipped without touching this script.
#
# package.json drives `npm install` in the Dockerfile's _shared layer —
# installs undici for broker-client.js's global ProxyAgent (HTTPS_PROXY
# routing for Node fetch). Every brokered MCP imports broker-client.js,
# so one npm install in _shared/ covers all of them.
#
# Must land before any MCP that imports from _shared so Docker's COPY for
# those MCPs sees a complete _shared/ dir on the remote build context.
ssh "$HETZNER_HOST" "mkdir -p '$REMOTE_PATH/apps/_shared'"
mirror_dir apps/_shared "$REMOTE_PATH/apps/_shared"

# Google Workspace bundle — six new MCPs (gdocs already deployed above)
# spawned from a single integration record. Reuses gdocs OAuth env vars.
for svc in gsheets gcalendar gdrive gslides gtasks; do
  ssh "$HETZNER_HOST" "mkdir -p '$REMOTE_PATH/apps/${svc}-mcp'"
  scp "apps/${svc}-mcp/index.js"     "$HETZNER_HOST:$REMOTE_PATH/apps/${svc}-mcp/" || exit 1
  scp "apps/${svc}-mcp/package.json" "$HETZNER_HOST:$REMOTE_PATH/apps/${svc}-mcp/" || exit 1
done

# Integrations key — generated once per client, mode 0600 root-owned, used by
# workspace-api to encrypt/decrypt user-supplied API keys. Lives outside .env
# so backups can exclude it; PROJECT_DIR never sees it.
ssh "$HETZNER_HOST" "
  set -e
  mkdir -p '/srv/${IDE_NAME}/secrets'
  chmod 700 '/srv/${IDE_NAME}/secrets'
  if [ ! -s '/srv/${IDE_NAME}/secrets/integrations.key' ]; then
    openssl rand -hex 32 > '/srv/${IDE_NAME}/secrets/integrations.key'
    echo '[deploy] generated INTEGRATIONS_KEY at /srv/${IDE_NAME}/secrets/integrations.key'
  fi
  # Owned by uid 1001 (the container's wsapi user, post-Phase-2 broker
  # split) so ONLY workspace-api can read the master key. coder (1000)
  # and mcp (1002) are blocked by file mode + ownership. Mode 0400 (read
  # only by owner) — the key is read-only at runtime; nothing should
  # ever modify it in-place. Directory above is 700 root-owned so
  # non-container processes on the host still can't reach this file.
  # Run unconditionally so old keys generated before Phase 2 get
  # re-owned without manual intervention.
  chown 1001:1001 '/srv/${IDE_NAME}/secrets/integrations.key'
  chmod 400       '/srv/${IDE_NAME}/secrets/integrations.key'
  # Writable directory for UI-managed integration files (email accounts.json,
  # GA4 service-account JSON). Owned by uid 1000 (the container's coder user)
  # so workspace-api running inside the container can write to it.
  mkdir -p '/srv/${IDE_NAME}/integrations-data'
  chown -R 1000:1000 '/srv/${IDE_NAME}/integrations-data' 2>/dev/null || true
  chmod 700 '/srv/${IDE_NAME}/integrations-data'
  # Egress allow-list dir — workspace-api writes allowed-hosts.txt here on
  # every integration activate/deactivate. The egress-proxy sidecar mounts
  # this same host dir read-only and watches the file (see scripts/egress-proxy.js).
  # Owned by uid 1001 (wsapi, post-Phase-2 broker split — workspace-api at 1001
  # needs write access). Mode 0755 since egress-proxy reads as a non-root user
  # inside its own container and the file's own mode (0644 from egress.js) is
  # what matters.
  mkdir -p '/srv/${IDE_NAME}/egress'
  chown 1001:1001 '/srv/${IDE_NAME}/egress' 2>/dev/null || true
  chmod 755 '/srv/${IDE_NAME}/egress'
"

# Ensure /home/coder/.email exists on the server — bind-mount target for the
# email-mcp accounts.json. Without this, docker compose up errors on missing
# host path. Per-client deploy.sh wrappers upload the actual accounts.json.
ssh "$HETZNER_HOST" "mkdir -p /home/coder/.email"

# workspace-api — top-level service (not a plugin), spawns `claude -p` for
# the web chat panel. PM2 starts it; nginx proxies /api/* → :3001.
# Module layout: index.js + lib/{config,files,sessions,claude,watcher}.js
# + routes/{health,chat,files}.js. Recursive scp picks up the whole tree.
ssh "$HETZNER_HOST" "mkdir -p '$REMOTE_PATH/workspace-api/lib/integrations' '$REMOTE_PATH/workspace-api/routes' '$REMOTE_PATH/workspace-api/assets'"
scp workspace-api/index.js                 "$HETZNER_HOST:$REMOTE_PATH/workspace-api/" || exit 1
scp workspace-api/package.json             "$HETZNER_HOST:$REMOTE_PATH/workspace-api/" || exit 1
scp workspace-api/integrations.catalog.json "$HETZNER_HOST:$REMOTE_PATH/workspace-api/" || exit 1
# scp -r on lib/. picks up the integrations/ subdir transitively.
mirror_dir workspace-api/lib    "$REMOTE_PATH/workspace-api/lib"
mirror_dir workspace-api/routes "$REMOTE_PATH/workspace-api/routes"
# assets/ ships WORKSPACE.md (UI reference for Claude) + avatar presets.
mirror_dir workspace-api/assets "$REMOTE_PATH/workspace-api/assets"

# Upload full frontend source (needed for Docker build on remote).
# Wipe per-client image patterns from the remote public/ first — `scp -r`
# only adds/overwrites, it never removes stale files. Without this, a client
# whose overrides shrank (e.g. dropped a logo.png) inherits the old logo
# from a previous deploy. Generic shared assets stay (workspace-logo.svg,
# favicon.svg, avatars/, integrations/) — they're re-uploaded right below.
ssh "$HETZNER_HOST" "mkdir -p '$REMOTE_PATH/frontend/src' '$REMOTE_PATH/frontend/public'
    rm -f '$REMOTE_PATH/frontend/public/'{bot,logo,icon,favicon}.{png,jpg,jpeg} 2>/dev/null
    rm -f '$REMOTE_PATH/frontend/public/.DS_Store' 2>/dev/null"
scp frontend/Dockerfile.frontend  "$HETZNER_HOST:$REMOTE_PATH/frontend/" || exit 1
scp frontend/nginx.conf           "$HETZNER_HOST:$REMOTE_PATH/frontend/" || exit 1
scp frontend/package.json         "$HETZNER_HOST:$REMOTE_PATH/frontend/" || exit 1
scp frontend/package-lock.json    "$HETZNER_HOST:$REMOTE_PATH/frontend/" || exit 1
scp frontend/index.html           "$HETZNER_HOST:$REMOTE_PATH/frontend/" || exit 1
scp frontend/vite.config.js       "$HETZNER_HOST:$REMOTE_PATH/frontend/" || exit 1
mirror_dir frontend/src "$REMOTE_PATH/frontend/src"
scp -r frontend/public/.          "$HETZNER_HOST:$REMOTE_PATH/frontend/public/" || exit 1

if [ "$DEPLOY_TARGET" = "all" ] || [ "$DEPLOY_TARGET" = "auth" ]; then
    ssh "$HETZNER_HOST" "mkdir -p '$REMOTE_PATH/auth-service'"
    scp auth-service/Dockerfile   "$HETZNER_HOST:$REMOTE_PATH/auth-service/" || exit 1
    scp auth-service/index.js     "$HETZNER_HOST:$REMOTE_PATH/auth-service/" || exit 1
    scp auth-service/whitelist.js "$HETZNER_HOST:$REMOTE_PATH/auth-service/" || exit 1
    scp auth-service/package.json "$HETZNER_HOST:$REMOTE_PATH/auth-service/" || exit 1
fi

echo -e "${GREEN}Files uploaded${NC}"
echo ""

# ─── Step 2: Notify Telegram ─────────────────────────────────────────────────
echo -e "${GREEN}[2/5] Notifying Telegram...${NC}"

if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_ADMIN_CHAT_ID" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d chat_id="$TELEGRAM_ADMIN_CHAT_ID" \
        -d text="🔄 *${BOT_DISPLAY}* | Deploying update... Brief interruption expected." \
        -d parse_mode="Markdown" > /dev/null 2>&1
    echo -e "${GREEN}Telegram notified${NC}"
else
    echo -e "${YELLOW}Telegram notification skipped (TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID not set)${NC}"
fi
echo ""

# ─── Step 3: Build (old containers still running) ───────────────────────────
echo -e "${GREEN}[3/5] Building images (containers still running)...${NC}"

case "$DEPLOY_TARGET" in
    all)          BUILD_TARGETS="auth-service code-server frontend egress-proxy" ;;
    code-server)  BUILD_TARGETS="code-server egress-proxy" ;;
    auth)         BUILD_TARGETS="auth-service" ;;
    frontend)     BUILD_TARGETS="frontend" ;;
    egress-proxy) BUILD_TARGETS="egress-proxy" ;;
    *)            BUILD_TARGETS="$DEPLOY_TARGET" ;;
esac

ssh "$HETZNER_HOST" "cd '$REMOTE_PATH' && docker compose build --no-cache $BUILD_TARGETS" || exit 1
# Prune AFTER the build, not before: pruning first leaves this build's own
# dangling layers on disk until the NEXT deploy — on a 38G VPS that's the
# difference between a stable ~x% floor and creeping toward disk-full.
# (Running containers/images in use are never pruned.)
echo -e "${CYAN}  Pruning unused Docker layers to free disk space...${NC}"
ssh "$HETZNER_HOST" "docker system prune -f" || true
echo -e "${GREEN}Images built${NC}"
echo ""

# ─── Step 3.5: Cleanup legacy host-side egress + stage proxy ────────────────
# Egress is now enforced by the egress-proxy sidecar + bot-net
# `internal: true` (see scripts/egress-proxy.js, docker-compose.yml,
# ide-template/Dockerfile.egress-proxy). The pre-2026-05-11 host-side
# enforcement (systemd timer + ipset + iptables DOCKER-USER rules) is
# redundant and references container bridges that no longer exist
# after the network restructure, so leave-in-place would just produce
# noise in journalctl.
#
# Cleanup is best-effort + idempotent: each step's failure (e.g. the
# unit wasn't installed on this host, or ipset doesn't exist) is OK.
echo -e "${GREEN}[3.5/5] Cleaning up legacy host-side egress (replaced by egress-proxy sidecar)...${NC}"
ssh "$HETZNER_HOST" "
    systemctl stop    egress-allowlist@${IDE_NAME}.timer   2>/dev/null || true
    systemctl disable egress-allowlist@${IDE_NAME}.timer   2>/dev/null || true
    systemctl stop    egress-allowlist@${IDE_NAME}.service 2>/dev/null || true
    systemctl disable egress-allowlist@${IDE_NAME}.service 2>/dev/null || true
    # Remove any DOCKER-USER iptables rules tagged with our IDE name —
    # these were inserted by the old install-egress.sh and reference
    # the previous bridge interface (which docker compose replaces on
    # network restructure). iptables-save | sed | sh works because
    # the rules contain a stable comment we can grep for.
    iptables-save 2>/dev/null | grep -- '--comment \"ide-egress-${IDE_NAME}' | sed 's/^-A/iptables -D/' | sh 2>/dev/null || true
    # Old ipset (hash:ip) — destroy unconditionally. If absent the
    # command is a no-op error which we swallow.
    ipset destroy egress-${IDE_NAME} 2>/dev/null || true
" || echo -e "${YELLOW}  cleanup ssh returned non-zero (some units may not have existed; that's fine)${NC}"
echo -e "${GREEN}  Legacy egress removed; new enforcement is in egress-proxy container${NC}"
echo ""

# ─── Step 4: Swap containers ────────────────────────────────────────────────
echo -e "${GREEN}[4/5] Swapping containers (minimal downtime)...${NC}"

# Pre-step: kill any wsapi `node` process holding port 3001 before the
# new container starts. wsapi-runner is a setuid wrapper that exec's
# /usr/bin/node /opt/ide/workspace-api/index.js — PM2 starts the
# wrapper, the wrapper replaces itself with node (so the node PID is
# what PM2 ends up tracking), but in practice we keep seeing the old
# node survive across `pm2 restart` and hold :3001 until manually
# killed. Without this preemptive kill, the new wsapi image starts in
# a crashloop ("EADDRINUSE 3001"), needing a manual operator touch.
# Caught on a 2026-05-12 deploy — 124 PM2 restart attempts
# before someone SSH'd in.
#
# Best-effort: silently swallow failures (container doesn't exist
# yet, pkill found nothing, etc.). pre-compose-up timing is what
# matters; old node MUST be dead before the new container tries to
# bind 3001.
ssh "$HETZNER_HOST" "
    docker exec '${IDE_NAME}' bash -c 'pkill -9 -f /opt/ide/workspace-api/index.js; pkill -9 -f wsapi-runner' 2>/dev/null || true
" 2>/dev/null || true

# `--remove-orphans` cleans up any leftover containers that used to be
# in docker-compose.yml but no longer are (e.g. a legacy email-bridge).
# Without it `docker compose up` refuses to recreate the
# project's `_default` network when an orphan still has an endpoint on
# it — caught 2026-05-12: hours of debugging chasing a
# "network has active endpoints" error that was email-bridge from a
# config the operator deleted months ago.
#
# If the first up still fails (rare — usually means containers ended
# up disconnected from the project network during a previous partial
# failure), retry with `down + up` for a clean slate. `down` does NOT
# remove named volumes (data preserved), only stops + removes
# containers + networks.
if ! ssh "$HETZNER_HOST" "cd '$REMOTE_PATH' && docker compose up -d --remove-orphans"; then
    echo -e "${YELLOW}  compose up failed — retrying with down+up for a clean slate${NC}"
    ssh "$HETZNER_HOST" "cd '$REMOTE_PATH' && docker compose down --remove-orphans 2>/dev/null; docker compose up -d --remove-orphans" || exit 1
fi
echo -e "${GREEN}Containers swapped${NC}"
echo ""

# ─── Step 4.5: Reload Caddy (Caddyfile-only changes don't trigger restart) ──
# `docker compose up -d` only restarts containers whose IMAGE changed. Caddy
# uses a stock `caddy:latest` image and just bind-mounts the Caddyfile, so
# Caddyfile edits don't propagate via compose alone — the Caddy process keeps
# running on its old config until it's explicitly reloaded.
#
# Caught on a re-audit 2026-05-09: Caddyfile had Content-Security-Policy
# committed but Caddy was running on a 3-week-old config without it. Hot
# reload is no-downtime; if it fails (Caddyfile parse error etc.) the old
# config keeps serving — Caddy doesn't drop traffic.
if ssh "$HETZNER_HOST" "docker exec '${IDE_NAME}-caddy' caddy reload --config /etc/caddy/Caddyfile" \
    > /dev/null 2>&1; then
    echo -e "${GREEN}  Caddy reloaded (picked up Caddyfile changes)${NC}"
else
    echo -e "${YELLOW}  WARN: Caddy reload failed — old config still serving. Check 'docker logs ${IDE_NAME}-caddy'${NC}"
    DEPLOY_ERRORS+=("Caddy reload failed — Caddyfile changes (headers/TLS/routes) are NOT live")
fi
echo ""

# ─── Step 5: Health check ───────────────────────────────────────────────────
echo -e "${GREEN}[5/5] Waiting for health check...${NC}"

MAX_WAIT=60
WAITED=0
HEALTHY=false

while [ $WAITED -lt $MAX_WAIT ]; do
    sleep 5
    WAITED=$((WAITED + 5))
    # Verify code-server is up (port 8080)
    if ssh "$HETZNER_HOST" "docker exec '$IDE_NAME' curl -sf http://localhost:8080/ > /dev/null 2>&1"; then
        HEALTHY=true
        break
    fi
    echo -e "${YELLOW}  Waiting... (${WAITED}s / ${MAX_WAIT}s)${NC}"
done

echo ""
if [ "$HEALTHY" = true ]; then
    # ─── Step 5b: Bot crashloop detection ─────────────────────────────────────
    # Container being healthy says nothing about the bot process inside —
    # bot.sh can crashloop silently for hours while /api/health stays 200.
    # Caught 2026-05-30: previous deploy returned "<bot> is healthy"
    # while pm2 <bot> had 231 restart_time entries due to broken credentials.
    # Operator only noticed when bot stopped replying.
    #
    # Watch pm2 <bot> restart_time for 60s. If it climbs by >2 in that window,
    # bot is crashlooping — fail the deploy loudly so the operator sees it.
    echo -e "${GREEN}[5b/5] Verifying bot pm2 process stability (60s)...${NC}"
    PM2_CMD="export PM2_HOME=/home/coder/.pm2; pm2 jlist 2>/dev/null | python3 -c \"import sys,json; d=json.load(sys.stdin); p=next((x for x in d if x.get('name')=='${BOT_NAME}'), None); print(p['pm2_env']['restart_time'] if p else 'missing')\" 2>/dev/null"
    # `|| echo ""` so a transient ssh failure (broken ControlPath under post-deploy
    # load, e.g. heavy --no-cache build aftermath) doesn't trip `set -e` and kill
    # the whole script before we've decided whether the bot is healthy. We treat
    # an empty value as "verifier glitched" below, not as a bot failure.
    RESTART_T0=$(ssh "$HETZNER_HOST" "docker exec -u coder '$IDE_NAME' bash -c \"$PM2_CMD\"" 2>/dev/null || echo "")
    sleep 60
    RESTART_T1=$(ssh "$HETZNER_HOST" "docker exec -u coder '$IDE_NAME' bash -c \"$PM2_CMD\"" 2>/dev/null || echo "")

    BOT_STABLE=true
    if [ "$RESTART_T0" = "missing" ] || [ "$RESTART_T1" = "missing" ]; then
        echo -e "${YELLOW}  WARNING: ${BOT_NAME} not registered in pm2 — bot did not start.${NC}"
        BOT_STABLE=false
    elif [[ "$RESTART_T0" =~ ^[0-9]+$ ]] && [[ "$RESTART_T1" =~ ^[0-9]+$ ]]; then
        RESTART_DELTA=$((RESTART_T1 - RESTART_T0))
        if [ "$RESTART_DELTA" -gt 2 ]; then
            echo -e "${YELLOW}  CRASHLOOP DETECTED: ${BOT_NAME} restarted ${RESTART_DELTA} times in 60s.${NC}"
            BOT_STABLE=false
        else
            echo -e "${GREEN}  ${BOT_NAME} stable (${RESTART_DELTA} restarts in 60s — within tolerance).${NC}"
        fi
    else
        # Verifier glitch path: ssh failed, docker exec errored, or pm2 returned
        # garbage. Don't fail the deploy — the container is up and /api/health
        # already passed in step 5. Just warn so the operator can sanity-check.
        echo -e "${YELLOW}  WARNING: pm2 verifier glitched (T0='${RESTART_T0}' T1='${RESTART_T1}'). Not failing the deploy — container is healthy. Run a manual pm2 list to confirm.${NC}"
    fi

    if [ "$BOT_STABLE" = false ]; then
        echo -e "${YELLOW}╔════════════════════════════════════════════════════════════╗${NC}"
        echo -e "${YELLOW}║  Deploy COMPLETED BUT BOT IS UNHEALTHY${NC}"
        echo -e "${YELLOW}║  Container is up + workspace-api responds, but the bot${NC}"
        echo -e "${YELLOW}║  process is crashlooping. Likely causes:${NC}"
        echo -e "${YELLOW}║   - missing/invalid Claude credentials (paste token in wizard)${NC}"
        echo -e "${YELLOW}║   - PostToolUse hook crashes (check /opt/ide/hooks/*.sh)${NC}"
        echo -e "${YELLOW}║   - settings.json malformed (jq ~/.claude/settings.json)${NC}"
        echo -e "${YELLOW}╚════════════════════════════════════════════════════════════╝${NC}"
        echo -e "${YELLOW}  Debug: ssh $HETZNER_HOST \"docker exec -u coder $IDE_NAME bash -c 'export PM2_HOME=/home/coder/.pm2; pm2 list; tail -30 /home/coder/.${BOT_NAME}/${BOT_NAME}-out.log'\"${NC}"
        if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_ADMIN_CHAT_ID" ]; then
            TARGET_LABEL="${DEPLOY_TARGET:-all}"
            curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
                -d chat_id="$TELEGRAM_ADMIN_CHAT_ID" \
                -d text="⚠️ *${BOT_DISPLAY}* | Deploy complete BUT ${BOT_NAME} crashlooping (${TARGET_LABEL}). Check pm2 logs." \
                -d parse_mode="Markdown" > /dev/null 2>&1
        fi
        exit 1
    fi

    # ── Version manifest ──────────────────────────────────────────────────
    # Stamped ONLY on a fully verified deploy (health + bot stability).
    # scripts/verify-drift.sh reads this from every client to answer "which
    # client runs which commit" without SSH-archaeology.
    # Stamp what was UPLOADED (captured before step 1), never the current HEAD.
    GIT_COMMIT="$UPLOAD_COMMIT"
    GIT_REF="$UPLOAD_REF"
    GIT_DIRTY=$UPLOAD_DIRTY
    # If the working tree moved while the build ran, the image is a snapshot of
    # whatever the scp loop happened to read — possibly a mix. Say so loudly:
    # a silent mismatch here is how a torn build passes for a good one.
    NOW_COMMIT="$(git -C "$THIS_DIR/.." rev-parse HEAD 2>/dev/null || echo unknown)"
    if [ "$NOW_COMMIT" != "$UPLOAD_COMMIT" ]; then
        echo -e "${RED}  WARNING: the working tree moved during this deploy (${UPLOAD_COMMIT:0:7} → ${NOW_COMMIT:0:7}).${NC}"
        echo -e "${RED}  The image may contain a MIX of both. Manifest records what upload started from;${NC}"
        echo -e "${RED}  re-deploy from a quiet tree before trusting it.${NC}"
        DEPLOY_ERRORS+=("working tree changed mid-deploy (${UPLOAD_COMMIT:0:7} → ${NOW_COMMIT:0:7}) — image may be torn")
    fi
    if ssh "$HETZNER_HOST" "cat > '$REMOTE_PATH/.deploy-manifest.json'" <<MANIFEST
{
  "ide_name": "$IDE_NAME",
  "git_commit": "$GIT_COMMIT",
  "git_ref": "$GIT_REF",
  "git_dirty": $GIT_DIRTY,
  "deploy_target": "$DEPLOY_TARGET",
  "deployed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
MANIFEST
    then
        echo -e "${CYAN}  Version manifest stamped (${GIT_COMMIT:0:7}, dirty=$GIT_DIRTY)${NC}"
    else
        DEPLOY_ERRORS+=("could not write .deploy-manifest.json — verify-drift.sh will report no-manifest")
    fi

    # ── Error gate ────────────────────────────────────────────────────────
    # Everything ran to completion, but "completed" ≠ "succeeded" if any
    # step degraded along the way.
    if [ ${#DEPLOY_ERRORS[@]} -gt 0 ]; then
        echo -e "${YELLOW}╔════════════════════════════════════════════════════════════╗${NC}"
        echo -e "${YELLOW}║  Deploy COMPLETED WITH ERRORS — container is up, but:${NC}"
        for e in "${DEPLOY_ERRORS[@]}"; do
            echo -e "${YELLOW}║   - $e${NC}"
        done
        echo -e "${YELLOW}╚════════════════════════════════════════════════════════════╝${NC}"
        if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_ADMIN_CHAT_ID" ]; then
            curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
                -d chat_id="$TELEGRAM_ADMIN_CHAT_ID" \
                -d text="⚠️ *${BOT_DISPLAY}* | Deploy completed WITH ${#DEPLOY_ERRORS[@]} error(s) — check the deploy log." \
                -d parse_mode="Markdown" > /dev/null 2>&1
        fi
        exit 1
    fi

    echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║  Deploy successful! ${BOT_DISPLAY} is healthy.${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
    if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_ADMIN_CHAT_ID" ]; then
        TARGET_LABEL="${DEPLOY_TARGET:-all}"
        curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
            -d chat_id="$TELEGRAM_ADMIN_CHAT_ID" \
            -d text="✅ *${BOT_DISPLAY}* | Deploy complete (${TARGET_LABEL}). All systems healthy." \
            -d parse_mode="Markdown" > /dev/null 2>&1
    fi
else
    echo -e "${YELLOW}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${YELLOW}║  Deploy complete, but health check not yet passing.       ║${NC}"
    echo -e "${YELLOW}║  Normal if Claude needs time to start (~60s).             ║${NC}"
    echo -e "${YELLOW}╚════════════════════════════════════════════════════════════╝${NC}"
    echo -e "${YELLOW}  Debug: ssh $HETZNER_HOST \"docker logs $IDE_NAME --tail=30\"${NC}"
    if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_ADMIN_CHAT_ID" ]; then
        TARGET_LABEL="${DEPLOY_TARGET:-all}"
        curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
            -d chat_id="$TELEGRAM_ADMIN_CHAT_ID" \
            -d text="⚠️ *${BOT_DISPLAY}* | Deploy complete (${TARGET_LABEL}), but health check not yet passing. Check logs." \
            -d parse_mode="Markdown" > /dev/null 2>&1
    fi
fi

echo ""
echo -e "${CYAN}Logs: ssh $HETZNER_HOST \"docker logs $IDE_NAME --tail=50 -f\"${NC}"
