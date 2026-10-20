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
#   ./deploy.sh rollback  — put the previous image generation back (no build)
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

# `--fresh` (anywhere on the command line) rebuilds every layer (`--no-cache`):
# for a base-package refresh or a layer you suspect is stale. The default build
# reuses the layer cache, so a routine deploy rebuilds only what changed — the
# apt, browser, CLI and extension layers are shared with the running image
# instead of being stored again, which is what kept filling 38 GB hosts.
FRESH=0
ARGS=()
for a in "$@"; do
    case "$a" in
        --fresh) FRESH=1 ;;
        *) ARGS+=("$a") ;;
    esac
done
set -- ${ARGS[@]+"${ARGS[@]}"}   # bash 3.2 (macOS) + set -u: an empty array must not expand
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

# Health wait shared by a deploy (Step 5) and a rollback: poll the container
# until BOTH code-server (:8080) and workspace-api (:3001) answer, up to
# MAX_WAIT seconds. 0 = healthy, 1 = not. wsapi is started by pm2 after the
# entrypoint's permission fix-ups, so it comes up later than code-server —
# hence the longer window than the old code-server-only probe had.
MAX_WAIT=120
wait_healthy() {
    local waited=0
    while [ $waited -lt $MAX_WAIT ]; do
        sleep 5
        waited=$((waited + 5))
        if ssh "$HETZNER_HOST" "docker exec '$IDE_NAME' sh -c 'curl -sf http://localhost:8080/ > /dev/null 2>&1 && curl -sf http://127.0.0.1:3001/api/health > /dev/null 2>&1'"; then
            return 0
        fi
        echo -e "${YELLOW}  Waiting... (${waited}s / ${MAX_WAIT}s)${NC}"
    done
    return 1
}

# ─── Rollback: previous image generation back, no upload, no build ──────────
# Step 3 tags every image it is about to rebuild as <image>:previous (and
# keeps a copy of the manifest beside it), so a deploy that ships a broken
# image can be undone in the time it takes compose to recreate the
# containers, instead of another 15-minute build while the client sits at
# 502. Compose recreates a container whose image changed, so re-tagging
# previous→current and `up -d --no-build` is the whole operation.
# The pm2 crashloop watch (Step 5b) is skipped: a rollback restores an image
# that already passed it.
if [ "$DEPLOY_TARGET" = "rollback" ]; then
    echo -e "${GREEN}[1/2] Restoring the previous image generation...${NC}"
    ssh "$HETZNER_HOST" "
        set -e
        cd '$REMOTE_PATH'
        n=0
        for img in \$(docker compose config --images); do
            name=\"\${img%%:*}\"
            docker image inspect \"\$name:previous\" >/dev/null 2>&1 || continue
            docker tag \"\$name:previous\" \"\$img\"
            echo \"  \$img <- \$name:previous\"
            n=\$((n+1))
        done
        if [ \"\$n\" -eq 0 ]; then
            echo '  no :previous image on this host — nothing to roll back to' >&2
            exit 1
        fi
        [ -f .deploy-manifest.previous.json ] && mv -f .deploy-manifest.previous.json .deploy-manifest.json
        # Same pre-step as Step 4: an old wsapi node holding :3001 would put
        # the restored container into an EADDRINUSE crashloop.
        docker exec '${IDE_NAME}' bash -c 'pkill -9 -f /opt/ide/workspace-api/index.js; pkill -9 -f wsapi-runner' 2>/dev/null || true
        docker compose up -d --no-build --remove-orphans
    " || exit 1
    echo ""
    echo -e "${GREEN}[2/2] Waiting for health check...${NC}"
    if wait_healthy; then
        echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
        echo -e "${GREEN}║  Rollback complete. ${BOT_DISPLAY} is healthy on the previous image.${NC}"
        echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
        TG_TEXT="↩️ *${BOT_DISPLAY}* | Rolled back to the previous image. All systems healthy."
        TG_RC=0
    else
        echo -e "${RED}╔════════════════════════════════════════════════════════════╗${NC}"
        echo -e "${RED}║  Rollback FAILED — health check did not pass within ${MAX_WAIT}s.${NC}"
        echo -e "${RED}╚════════════════════════════════════════════════════════════╝${NC}"
        echo -e "${YELLOW}  Debug: ssh $HETZNER_HOST \"docker logs $IDE_NAME --tail=30\"${NC}"
        TG_TEXT="❌ *${BOT_DISPLAY}* | Rollback FAILED: health check did not pass. Check logs."
        TG_RC=1
    fi
    if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_ADMIN_CHAT_ID" ]; then
        curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
            -d chat_id="$TELEGRAM_ADMIN_CHAT_ID" -d text="$TG_TEXT" -d parse_mode="Markdown" > /dev/null 2>&1
    fi
    exit $TG_RC
fi

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

# ─── One stream instead of a hundred scp calls ──────────────────────────────
# Everything below is QUEUED and sent as one compressed tar over one ssh
# session at the end of this step (flush_upload). scp opened a connection per
# call and spent a round trip per file: 668 small files over a 270 ms link took
# 16 minutes (measured 2026-10-14); the same tree as one stream takes seconds.
# The queue keeps the old list's meaning: `ship` = scp (a required file that is
# missing still stops the deploy), `mirror` = the remote dir is replaced, not
# overlaid (a file deleted here is deleted there), `wipe` = replace a remote dir
# whose files are shipped one by one. Directories are created by the extraction.
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wsdeploy-stage.XXXXXX")"
MIRROR_RM=()
trap 'rm -rf "$STAGE_DIR"' EXIT
_stage_rel() {   # "$HETZNER_HOST:$REMOTE_PATH/apps/x-mcp/" → apps/x-mcp
    local r="${1#*:}"; r="${r#$REMOTE_PATH}"; r="${r#/}"; r="${r%/}"; printf '%s' "$r"
}
ship() {         # ship [-r] <local>... <$HETZNER_HOST:$REMOTE_PATH/dir/>
    local recursive=0
    [ "$1" = "-r" ] && { recursive=1; shift; }
    local n=$(( $# - 1 )) dest rel src
    eval "dest=\${$#}"
    rel="$(_stage_rel "$dest")"
    mkdir -p "$STAGE_DIR/$rel"
    for src in "${@:1:$n}"; do
        if [ "$recursive" = 1 ]; then
            [ -e "$src" ] || { echo "  missing: $src" >&2; return 1; }
            cp -R "$src" "$STAGE_DIR/$rel/" || return 1      # dir/. = contents, dir = the dir
        else
            [ -f "$src" ] || { echo "  missing: $src" >&2; return 1; }
            cp "$src" "$STAGE_DIR/$rel/" || return 1
        fi
    done
}
mirror() {       # mirror <local_dir> <$REMOTE_PATH/dir>
    local rel="${2#$REMOTE_PATH}"; rel="${rel#/}"; rel="${rel%/}"
    [ -n "$rel" ] || { echo "  mirror: refusing the root" >&2; exit 1; }
    MIRROR_RM+=("$rel")
    mkdir -p "$STAGE_DIR/$rel"
    cp -R "$1/." "$STAGE_DIR/$rel/" || exit 1
}
wipe() {         # wipe <dir>  (relative to REMOTE_PATH)
    [ -n "$1" ] || exit 1
    MIRROR_RM+=("$1")
    mkdir -p "$STAGE_DIR/$1"
}
flush_upload() {
    local rm_cmd="true" d
    for d in ${MIRROR_RM[@]+"${MIRROR_RM[@]}"}; do rm_cmd="$rm_cmd && rm -rf '$REMOTE_PATH/$d'"; done
    local files; files=$(find "$STAGE_DIR" -type f | wc -l | tr -d ' ')
    echo -e "${CYAN}  Sending $files files as one stream...${NC}"
    # No macOS resource forks or xattrs in the stream (bsdtar and GNU tar both take --no-xattrs).
    (cd "$STAGE_DIR" && COPYFILE_DISABLE=1 tar --no-xattrs -czf - .) \
        | ssh "$HETZNER_HOST" "set -e; mkdir -p '$REMOTE_PATH'; $rm_cmd; tar --no-same-owner --no-overwrite-dir -C '$REMOTE_PATH' -xzf -"
    local rc=("${PIPESTATUS[@]}")
    [ "${rc[0]}" = 0 ] && [ "${rc[1]}" = 0 ] || { echo -e "${RED}  upload failed (tar ${rc[0]}, remote ${rc[1]})${NC}" >&2; exit 1; }
    rm -rf "$STAGE_DIR"; mkdir -p "$STAGE_DIR"; MIRROR_RM=()
}


ship Dockerfile               "$HETZNER_HOST:$REMOTE_PATH/" || exit 1
ship Dockerfile.egress-proxy  "$HETZNER_HOST:$REMOTE_PATH/" || exit 1
ship docker-compose.yml       "$HETZNER_HOST:$REMOTE_PATH/" || exit 1
ship entrypoint.sh            "$HETZNER_HOST:$REMOTE_PATH/" || exit 1
ship global-claude.md         "$HETZNER_HOST:$REMOTE_PATH/" || exit 1

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

# Note: source lives in repo-root scripts/ alongside the host-side
# install-egress.sh; the Dockerfile.egress-proxy copies it into the
# image. We scp it to a path the Dockerfile build context will see
# (REMOTE_PATH/scripts/).
mirror scripts "$REMOTE_PATH/scripts"
# Dropped in AFTER the mirror: this one comes from the repo root, not from
# ide-template/scripts, so mirroring would otherwise delete it.
ship ../scripts/egress-proxy.js "$HETZNER_HOST:$REMOTE_PATH/scripts/" || exit 1

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
# The whole directory: a wrapper added later (priv-tree.c was) must not be
# left behind by a list kept here.
ship setuid-wrappers/*.c setuid-wrappers/*.h setuid-wrappers/README.md "$HETZNER_HOST:$REMOTE_PATH/setuid-wrappers/" || exit 1

# Default skills (always installed) + optional skills (installed when
# matching integration activates).
# Clean-rebuild both skill trees so DELETED skills (e.g. renames like
# 2026-05-29's _security/ → security/) actually disappear from the
# build context. Otherwise scp -r just additively overlays — the old
# folder lingers, Docker COPY ships both into the image, and the bot
# sees two duplicate skills at runtime.
mirror skills/default "$REMOTE_PATH/skills/default"
if [ -d skills/optional ]; then
    mirror skills/optional "$REMOTE_PATH/skills/optional"
else
    wipe skills/optional
fi

# First-run bootstrap templates (folder structure + system reminders + Tasks/Pending)
mirror bootstrap "$REMOTE_PATH/bootstrap"

# CC hooks (PostToolUse / Stop / etc — wired in via ~/.claude/settings.json,
# template at bootstrap/claude-settings.json). Sources in ide-template/hooks/.
mirror hooks "$REMOTE_PATH/hooks"

# Helper scripts (Bundle 6: frontmatter stamping, etc).

ship Caddyfile              "$HETZNER_HOST:$REMOTE_PATH/" 2>/dev/null || true
ship inject.js overrides.css mobile.js "$HETZNER_HOST:$REMOTE_PATH/" || exit 1
ship settings.json "$HETZNER_HOST:$REMOTE_PATH/" || exit 1
ship -r extensions/branding "$HETZNER_HOST:$REMOTE_PATH/extensions/" || exit 1

# Bot scripts
ship bot/bot.sh                "$HETZNER_HOST:$REMOTE_PATH/bot/" || exit 1
ship bot/bot-notify.sh         "$HETZNER_HOST:$REMOTE_PATH/bot/" || exit 1
ship bot/web-notify.sh         "$HETZNER_HOST:$REMOTE_PATH/bot/" || exit 1
ship bot/mcp-auth-helper.sh    "$HETZNER_HOST:$REMOTE_PATH/bot/" || exit 1
ship bot/bot-relay.sh          "$HETZNER_HOST:$REMOTE_PATH/bot/" || exit 1
ship bot/tmux-inject.sh        "$HETZNER_HOST:$REMOTE_PATH/bot/" || exit 1
ship bot/reminder-monitor.sh   "$HETZNER_HOST:$REMOTE_PATH/bot/" || exit 1
ship bot/recent-snapshot-monitor.sh "$HETZNER_HOST:$REMOTE_PATH/bot/" || exit 1
ship bot/browser-watchdog.sh   "$HETZNER_HOST:$REMOTE_PATH/bot/" || exit 1
ship bot/ecosystem.config.js   "$HETZNER_HOST:$REMOTE_PATH/bot/" || exit 1

# MCP servers
ship apps/shopify-mcp/index.js       "$HETZNER_HOST:$REMOTE_PATH/apps/shopify-mcp/"     || exit 1
ship apps/shopify-mcp/package.json   "$HETZNER_HOST:$REMOTE_PATH/apps/shopify-mcp/"     || exit 1
ship apps/vercel-mcp/index.js        "$HETZNER_HOST:$REMOTE_PATH/apps/vercel-mcp/"      || exit 1
ship apps/vercel-mcp/package.json    "$HETZNER_HOST:$REMOTE_PATH/apps/vercel-mcp/"      || exit 1
ship apps/meta-mcp/index.js          "$HETZNER_HOST:$REMOTE_PATH/apps/meta-mcp/"        || exit 1
ship apps/meta-mcp/package.json      "$HETZNER_HOST:$REMOTE_PATH/apps/meta-mcp/"        || exit 1
ship apps/google-ads-mcp/index.js    "$HETZNER_HOST:$REMOTE_PATH/apps/google-ads-mcp/"  || exit 1
ship apps/google-ads-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/google-ads-mcp/" || exit 1
ship apps/seedream-mcp/index.js       "$HETZNER_HOST:$REMOTE_PATH/apps/seedream-mcp/"     || exit 1
ship apps/seedream-mcp/package.json   "$HETZNER_HOST:$REMOTE_PATH/apps/seedream-mcp/"     || exit 1
ship apps/nano-banana-mcp/index.js    "$HETZNER_HOST:$REMOTE_PATH/apps/nano-banana-mcp/"  || exit 1
ship apps/nano-banana-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/nano-banana-mcp/" || exit 1
ship apps/reminder-mcp/index.js       "$HETZNER_HOST:$REMOTE_PATH/apps/reminder-mcp/"     || exit 1
ship apps/reminder-mcp/recur.cjs      "$HETZNER_HOST:$REMOTE_PATH/apps/reminder-mcp/"     || exit 1
ship apps/reminder-mcp/package.json   "$HETZNER_HOST:$REMOTE_PATH/apps/reminder-mcp/"     || exit 1
# pdf-mcp — markdown→PDF (weasyprint). index.js speaks MCP + shells to render.py;
# house.css is the shared stylesheet. All four files are needed on the remote
# build context for the Dockerfile's `COPY apps/pdf-mcp`.
ship apps/pdf-mcp/index.js            "$HETZNER_HOST:$REMOTE_PATH/apps/pdf-mcp/"          || exit 1
ship apps/pdf-mcp/package.json        "$HETZNER_HOST:$REMOTE_PATH/apps/pdf-mcp/"          || exit 1
ship apps/pdf-mcp/render.py           "$HETZNER_HOST:$REMOTE_PATH/apps/pdf-mcp/"          || exit 1
ship apps/pdf-mcp/house.css           "$HETZNER_HOST:$REMOTE_PATH/apps/pdf-mcp/"          || exit 1
ship apps/playwright-mcp/index.js     "$HETZNER_HOST:$REMOTE_PATH/apps/playwright-mcp/"   || exit 1
ship apps/playwright-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/playwright-mcp/"   || exit 1
ship apps/remote-mcp/index.js         "$HETZNER_HOST:$REMOTE_PATH/apps/remote-mcp/"       || exit 1
ship apps/remote-mcp/package.json     "$HETZNER_HOST:$REMOTE_PATH/apps/remote-mcp/"       || exit 1
ship apps/workspace-api-mcp/index.js     "$HETZNER_HOST:$REMOTE_PATH/apps/workspace-api-mcp/" || exit 1
ship apps/workspace-api-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/workspace-api-mcp/" || exit 1
# Memory v4 embedder worker (forked by workspace-api; lib/embedder-client.js).
# Three files, never a local node_modules (the image installs from the lock).
wipe apps/embedder
ship apps/embedder/worker.mjs apps/embedder/package.json apps/embedder/package-lock.json "$HETZNER_HOST:$REMOTE_PATH/apps/embedder/" || exit 1

# ─── Memory v4 embedder model (build-time embed) ─────────────────────────────
# multilingual-e5-small, int8 ONNX, pinned by revision and checked by sha256 —
# fetched HERE on the deploy host (the Docker build's network is not trusted to
# reach a CDN, see the plugin clone above) and kept between deploys, so it is
# downloaded once per server. Nothing is downloaded at run time. A failed fetch
# does not fail the deploy: memory search then runs on BM25 alone (degraded,
# measured 0.75 vs 0.80) and this says so loudly. The directory always exists
# (models/.keep), so the Dockerfile COPY never breaks.
EMBEDDER_MODEL_REV=761b726dd34fb83930e26aab4e9ac3899aa1fa78
ship models/.keep "$HETZNER_HOST:$REMOTE_PATH/models/" || exit 1
if ! ssh "$HETZNER_HOST" "
    set -e
    d='$REMOTE_PATH/models/Xenova/multilingual-e5-small'
    mkdir -p \"\$d/onnx\"
    fetch() {
        f=\"\$1\"; sum=\"\$2\"
        if [ -f \"\$d/\$f\" ] && echo \"\$sum  \$d/\$f\" | sha256sum -c - >/dev/null 2>&1; then return 0; fi
        curl -fsSL --retry 3 -o \"\$d/\$f.part\" \"https://huggingface.co/Xenova/multilingual-e5-small/resolve/$EMBEDDER_MODEL_REV/\$f\"
        echo \"\$sum  \$d/\$f.part\" | sha256sum -c - >/dev/null
        mv \"\$d/\$f.part\" \"\$d/\$f\"
    }
    fetch config.json               cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1
    fetch tokenizer.json            0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39
    fetch tokenizer_config.json     a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b
    fetch onnx/model_quantized.onnx f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193
"; then
    echo -e "${YELLOW}  ⚠ Embedder model fetch failed — memory v4 search will run on BM25 alone until the next deploy.${NC}"
fi
ship apps/miniapp-mcp/index.js        "$HETZNER_HOST:$REMOTE_PATH/apps/miniapp-mcp/"        || exit 1
ship apps/miniapp-mcp/package.json    "$HETZNER_HOST:$REMOTE_PATH/apps/miniapp-mcp/"        || exit 1
ship apps/web-channel-mcp/index.js       "$HETZNER_HOST:$REMOTE_PATH/apps/web-channel-mcp/"   || exit 1
ship apps/web-channel-mcp/package.json   "$HETZNER_HOST:$REMOTE_PATH/apps/web-channel-mcp/"   || exit 1
ship apps/email-mcp/index.js     "$HETZNER_HOST:$REMOTE_PATH/apps/email-mcp/" || exit 1
ship apps/email-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/email-mcp/" || exit 1

# GitHub MCP — thin node wrapper around the official github/github-mcp-server
# Go binary. The Go binary itself is downloaded inside the Docker build (curl
# from GH releases, pinned to GITHUB_MCP_VERSION); we only ship the wrapper
# sources here.
ship apps/github-mcp/index.js     "$HETZNER_HOST:$REMOTE_PATH/apps/github-mcp/" || exit 1
ship apps/github-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/github-mcp/" || exit 1

# Grok MCP — xAI Grok via OpenAI-compatible API. Single API key, ships
# alongside the other MCPs. Activated per-client through the workspace
# Integrations dashboard, not via env at deploy time.
ship apps/grok-mcp/index.js     "$HETZNER_HOST:$REMOTE_PATH/apps/grok-mcp/" || exit 1
ship apps/grok-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/grok-mcp/" || exit 1

# OpenAI MCP — ask_gpt for second-opinion / cross-check. Activated per-client
# through the Integrations dashboard (OPENAI_API_KEY).
ship apps/openai-mcp/index.js     "$HETZNER_HOST:$REMOTE_PATH/apps/openai-mcp/" || exit 1
ship apps/openai-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/openai-mcp/" || exit 1

# Docs Comments MCP (Playwright range-anchored Google Docs comments) — tracked,
# shipped to every client like any other MCP. (Reply/resolve/delete live in
# gdocs-mcp over the Drive API; this MCP only does the anchored add.)
ship apps/docs-comments-mcp/index.js      "$HETZNER_HOST:$REMOTE_PATH/apps/docs-comments-mcp/" || exit 1
ship apps/docs-comments-mcp/package.json  "$HETZNER_HOST:$REMOTE_PATH/apps/docs-comments-mcp/" || exit 1
ship apps/docs-comments-mcp/keepalive.mjs "$HETZNER_HOST:$REMOTE_PATH/apps/docs-comments-mcp/" || exit 1

# Generic operator-only catalog-fragment mechanism. No integration uses it
# today (docs-comments is now in the main catalog), but the hook stays for any
# future per-operator-machine integration: present locally → ships → wsapi
# merges at startup; absent → no-op.
if [ -f workspace-api/integrations.catalog.local.json ]; then
    ship workspace-api/integrations.catalog.local.json \
        "$HETZNER_HOST:$REMOTE_PATH/workspace-api/" || exit 1
    echo "  catalog.local.json staged — adds private integration card(s)"
fi
# Same hook for the routines marketplace (lib/routines-catalog.js merges it).
if [ -f workspace-api/routines.catalog.local.json ]; then
    ship workspace-api/routines.catalog.local.json \
        "$HETZNER_HOST:$REMOTE_PATH/workspace-api/" || exit 1
    echo "  routines.catalog.local.json staged — adds private marketplace routine(s)"
fi

# Gemini MCP (chat) — ask_gemini for second-opinion / long-context reads.
# Separate from nano-banana (image). Shares GEMINI_API_KEY with that integration.
ship apps/gemini-chat-mcp/index.js     "$HETZNER_HOST:$REMOTE_PATH/apps/gemini-chat-mcp/" || exit 1
ship apps/gemini-chat-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/gemini-chat-mcp/" || exit 1

ship apps/signwell-mcp/index.js     "$HETZNER_HOST:$REMOTE_PATH/apps/signwell-mcp/" || exit 1
ship apps/signwell-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/signwell-mcp/" || exit 1

# Trello MCP — board/card read + comment/label/move via REST API. Activated
# per-client through the Integrations dashboard.
ship apps/trello-mcp/index.js     "$HETZNER_HOST:$REMOTE_PATH/apps/trello-mcp/" || exit 1
ship apps/trello-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/trello-mcp/" || exit 1

# Google Docs MCP — Docs + Drive REST via OAuth refresh token. Per-user OAuth
# credentials (client_id, secret, refresh_token) stored in the encrypted
# integrations store.
ship apps/gdocs-mcp/index.js     "$HETZNER_HOST:$REMOTE_PATH/apps/gdocs-mcp/" || exit 1
ship apps/gdocs-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/gdocs-mcp/" || exit 1

# X (Twitter) MCP — read-only X data via twitterapi.io (no X dev approval,
# no user account exposure — just an API key from twitterapi.io).
ship apps/x-mcp/index.js     "$HETZNER_HOST:$REMOTE_PATH/apps/x-mcp/" || exit 1
ship apps/x-mcp/package.json "$HETZNER_HOST:$REMOTE_PATH/apps/x-mcp/" || exit 1

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
mirror apps/_shared "$REMOTE_PATH/apps/_shared"

# Google Workspace bundle — six new MCPs (gdocs already deployed above)
# spawned from a single integration record. Reuses gdocs OAuth env vars.
for svc in gsheets gcalendar gdrive gslides gtasks; do
  ship "apps/${svc}-mcp/index.js"     "$HETZNER_HOST:$REMOTE_PATH/apps/${svc}-mcp/" || exit 1
  ship "apps/${svc}-mcp/package.json" "$HETZNER_HOST:$REMOTE_PATH/apps/${svc}-mcp/" || exit 1
done

# Lockfiles: every app that has one next to its package.json gets it shipped,
# so the build installs the versions that were tested rather than whatever
# resolves on build day. Runs after every apps/ directory above exists on
# the remote; an app without a lockfile is simply skipped.
for lock in apps/*/package-lock.json; do
  [ -f "$lock" ] || continue
  ship "$lock" "$HETZNER_HOST:$REMOTE_PATH/$(dirname "$lock")/" || exit 1
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
ship workspace-api/index.js                 "$HETZNER_HOST:$REMOTE_PATH/workspace-api/" || exit 1
ship workspace-api/package.json             "$HETZNER_HOST:$REMOTE_PATH/workspace-api/" || exit 1
ship workspace-api/package-lock.json        "$HETZNER_HOST:$REMOTE_PATH/workspace-api/" || exit 1
ship workspace-api/integrations.catalog.json "$HETZNER_HOST:$REMOTE_PATH/workspace-api/" || exit 1
ship workspace-api/routines.catalog.json   "$HETZNER_HOST:$REMOTE_PATH/workspace-api/" || exit 1
# scp -r on lib/. picks up the integrations/ subdir transitively.
mirror workspace-api/lib    "$REMOTE_PATH/workspace-api/lib"
mirror workspace-api/routes "$REMOTE_PATH/workspace-api/routes"
# assets/ ships WORKSPACE.md (UI reference for Claude) + avatar presets.
mirror workspace-api/assets "$REMOTE_PATH/workspace-api/assets"
# Versioned data migrations (lib/migrate.js loads ../migrations) and the
# operator's CLI (bin/migrate.mjs). Without them the image boots with no
# migrations at all — silently: nothing applies, nothing is offered.
mirror workspace-api/migrations "$REMOTE_PATH/workspace-api/migrations"
mirror workspace-api/bin        "$REMOTE_PATH/workspace-api/bin"

# Upload full frontend source (needed for Docker build on remote).
# Wipe per-client image patterns from the remote public/ first — `scp -r`
# only adds/overwrites, it never removes stale files. Without this, a client
# whose overrides shrank (e.g. dropped a logo.png) inherits the old logo
# from a previous deploy. Generic shared assets stay (workspace-logo.svg,
# favicon.svg, avatars/, integrations/) — they're re-uploaded right below.
ship frontend/Dockerfile.frontend  "$HETZNER_HOST:$REMOTE_PATH/frontend/" || exit 1
ship frontend/nginx.conf           "$HETZNER_HOST:$REMOTE_PATH/frontend/" || exit 1
ship frontend/package.json         "$HETZNER_HOST:$REMOTE_PATH/frontend/" || exit 1
ship frontend/package-lock.json    "$HETZNER_HOST:$REMOTE_PATH/frontend/" || exit 1
ship frontend/index.html           "$HETZNER_HOST:$REMOTE_PATH/frontend/" || exit 1
ship frontend/vite.config.js       "$HETZNER_HOST:$REMOTE_PATH/frontend/" || exit 1
mirror frontend/src "$REMOTE_PATH/frontend/src"
# A mirror: old branding images and stray .DS_Store files from earlier deploys
# used to linger here (and were baked into the frontend image).
mirror frontend/public "$REMOTE_PATH/frontend/public"

if [ "$DEPLOY_TARGET" = "all" ] || [ "$DEPLOY_TARGET" = "auth" ]; then
    ship auth-service/Dockerfile   "$HETZNER_HOST:$REMOTE_PATH/auth-service/" || exit 1
    ship auth-service/index.js     "$HETZNER_HOST:$REMOTE_PATH/auth-service/" || exit 1
    ship auth-service/whitelist.js "$HETZNER_HOST:$REMOTE_PATH/auth-service/" || exit 1
    ship auth-service/package.json "$HETZNER_HOST:$REMOTE_PATH/auth-service/" || exit 1
    if [ -f auth-service/package-lock.json ]; then
        ship auth-service/package-lock.json "$HETZNER_HOST:$REMOTE_PATH/auth-service/" || exit 1
    fi
fi

echo -e "${GREEN}Files uploaded${NC}"
echo ""

flush_upload

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

# Keep the generation we are about to replace as <image>:previous, with the
# manifest that describes it, so `./deploy.sh rollback` has something to put
# back. A tag is what keeps an image out of `image prune` below — the old
# "24h reprieve" only ever protected images younger than a day, and the
# previous generation almost never is. One generation is kept: the tag moves
# on the next deploy and the one before it becomes dangling again.
ssh "$HETZNER_HOST" "
    set -e
    cd '$REMOTE_PATH'
    for img in \$(docker compose config --images $BUILD_TARGETS); do
        docker image inspect \"\$img\" >/dev/null 2>&1 || continue
        docker tag \"\$img\" \"\${img%%:*}:previous\"
    done
    cp -f .deploy-manifest.json .deploy-manifest.previous.json 2>/dev/null || true
" || echo -e "${YELLOW}  could not tag the current images as :previous — rollback will not be available for this deploy${NC}"
# Room for the build. Measured on a 38 GB host (2026-10-14): a full rebuild
# (--fresh) holds, at its peak, the running image, a build cache the size of
# the image and the new image compressed AND unpacked — about four times the
# image's compressed size; a cached build adds only the layers that changed.
# A stale build cache or an unused image generation is the difference between
# a build that lands and one that dies at "no space left on device" after
# forty minutes. So: measure, free what is unused if short, and stop before
# the build when it still would not fit.
ssh "$HETZNER_HOST" bash -s -- "$IDE_NAME" "$FRESH" <<'REMOTE' || exit 1
IMAGE="$1-code-server:latest"
size=$(docker image inspect --format '{{.Size}}' "$IMAGE" 2>/dev/null || echo 3000000000)
if [ "$2" = 1 ]; then need_kb=$(( 4 * size / 1024 + 3 * 1024 * 1024 )); else need_kb=$(( size / 1024 + 3 * 1024 * 1024 )); fi
free_kb=$(df -k / | awk 'NR==2 {print $4}')
if [ "$free_kb" -lt "$need_kb" ]; then
    echo "  disk: $((free_kb / 1024 / 1024)) GB free, about $((need_kb / 1024 / 1024)) GB needed - freeing what is unused"
    docker builder prune -af >/dev/null 2>&1 || true
    docker image prune -f >/dev/null 2>&1 || true
    free_kb=$(df -k / | awk 'NR==2 {print $4}')
fi
if [ "$free_kb" -lt "$need_kb" ]; then
    # Still short: the previous generation goes (a 38 GB host cannot hold
    # three generations of a large image). Rollback is then not available for
    # this deploy, which the deploy says below.
    echo "  disk: dropping the :previous image generation to make room (no rollback for this deploy)"
    for img in $(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep ':previous$'); do docker rmi "$img" >/dev/null 2>&1 || true; done
    docker image prune -f >/dev/null 2>&1 || true
    free_kb=$(df -k / | awk 'NR==2 {print $4}')
fi
if [ "$free_kb" -lt "$need_kb" ]; then
    echo "  disk: still $((free_kb / 1024 / 1024)) GB free - not enough for the build. Free space on the host (docker system df; old images, journal) and run the deploy again." >&2
    exit 1
fi
echo "  disk: $((free_kb / 1024 / 1024)) GB free for the build"
REMOTE
NO_CACHE=""; [ "$FRESH" = 1 ] && NO_CACHE="--no-cache" && echo -e "${CYAN}  --fresh: every layer is rebuilt${NC}"
ssh "$HETZNER_HOST" "cd '$REMOTE_PATH' && docker compose build $NO_CACHE $BUILD_TARGETS" || exit 1
# Prune AFTER the build, not before: pruning first leaves this build's own
# dangling layers on disk until the NEXT deploy — on a 38G VPS that's the
# difference between a stable ~x% floor and creeping toward disk-full.
# (Running containers/images in use are never pruned; neither is anything
# still carrying a tag — which is what keeps <image>:previous.)
#
# Images get a 24h reprieve, build cache does not. `docker system prune -f`
# used to take the previous generation of images with it, seconds after the new
# one was built — so when a deploy shipped a config that crash-looped the
# frontend (2026-09-24), there was nothing to roll back TO and the only way out
# was another full deploy while the client sat at 502. The build cache, which
# is what actually creeps toward disk-full, is still pruned on sight.
echo -e "${CYAN}  Pruning unused Docker layers to free disk space...${NC}"
# The build cache this build just used stays (it is what makes the next build
# short and small); only cache nobody has touched for ten days goes.
ssh "$HETZNER_HOST" "docker container prune -f; docker image prune -f --filter 'until=24h'; docker builder prune -f --filter 'until=240h'" || true
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

HEALTHY=false
wait_healthy && HEALTHY=true

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
    # Restart count for the bot process, parsed LOCALLY. The previous version
    # embedded `python3 -c "…"` inside `bash -c "…"` inside a double-quoted ssh
    # argument; the inner quotes closed early, the command produced nothing, and
    # every deploy reported "verifier glitched" — so the one check that would
    # catch a crashlooping bot has never actually run. Only single quotes cross
    # the wire now.
    pm2_restarts() {
        ssh "$HETZNER_HOST" "docker exec -u coder '$IDE_NAME' bash -c 'export PM2_HOME=/home/coder/.pm2; pm2 jlist 2>/dev/null'" 2>/dev/null \
          | python3 -c "import sys,json
try: d = json.load(sys.stdin)
except Exception: sys.exit(0)
p = next((x for x in d if x.get('name') == '$BOT_NAME'), None)
print(p['pm2_env']['restart_time'] if p else 'missing')" 2>/dev/null || true
    }
    # `|| echo ""` so a transient ssh failure (broken ControlPath under post-deploy
    # load, e.g. heavy --no-cache build aftermath) doesn't trip `set -e` and kill
    # the whole script before we've decided whether the bot is healthy. We treat
    # an empty value as "verifier glitched" below, not as a bot failure.
    # T0 is sampled right after the container swap, when pm2 may not be up yet —
    # that returned an empty baseline and the whole check degraded into a
    # warning. Wait for the process to appear (bounded), THEN start the window;
    # a bot that never appears is a real failure and falls through as 'missing'.
    RESTART_T0=""
    for _ in $(seq 1 12); do
        RESTART_T0=$(pm2_restarts)
        [[ "$RESTART_T0" =~ ^[0-9]+$ ]] && break
        sleep 5
    done
    sleep 60
    RESTART_T1=$(pm2_restarts)

    BOT_STABLE=true
    if [ "$RESTART_T0" = "missing" ] || [ "$RESTART_T1" = "missing" ]; then
        # A fresh install has no Claude token yet: the bot is deliberately
        # deferred (the entrypoint's token-watcher cold-starts it once the
        # person pastes the token in the browser wizard). That is a good
        # deploy, not a crashloop — but take this exit ONLY when credentials
        # are provably absent; a glitched probe falls through to the loud
        # failure below, keeping the 2026-05-30 crashloop guard intact.
        HAS_CREDS=$(ssh "$HETZNER_HOST" "docker exec '$IDE_NAME' bash -c 'test -s /home/bot/.claude/.credentials.json -o -s /home/coder/.claude/.credentials.json && echo yes || echo no'" 2>/dev/null || echo unknown)
        if [ "$HAS_CREDS" = "no" ]; then
            echo -e "${GREEN}  ${BOT_NAME} is waiting for its Claude token — expected on a fresh install.${NC}"
            echo -e "${GREEN}  Paste the token in the wizard at https://${FRONTEND_DOMAIN}/app/ and the bot starts by itself.${NC}"
        else
            echo -e "${YELLOW}  WARNING: ${BOT_NAME} not registered in pm2 — bot did not start.${NC}"
            BOT_STABLE=false
        fi
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
    # A container that never answered within the window is a failed deploy,
    # not a slow one: this branch used to exit 0, so install.sh went on to
    # print "Your workspace is ready" and update.sh moved to the next client
    # while the stack sat at 502. No manifest is stamped (nothing was
    # verified), and the exit code says what happened.
    echo -e "${RED}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║  Deploy FAILED — health check did not pass within ${MAX_WAIT}s.${NC}"
    echo -e "${RED}║  The container is up but is not answering.${NC}"
    echo -e "${RED}║  Previous image kept on the host:  ./deploy.sh rollback${NC}"
    echo -e "${RED}╚════════════════════════════════════════════════════════════╝${NC}"
    echo -e "${YELLOW}  Debug: ssh $HETZNER_HOST \"docker logs $IDE_NAME --tail=30\"${NC}"
    for e in "${DEPLOY_ERRORS[@]}"; do
        echo -e "${YELLOW}   - also: $e${NC}"
    done
    if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_ADMIN_CHAT_ID" ]; then
        TARGET_LABEL="${DEPLOY_TARGET:-all}"
        curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
            -d chat_id="$TELEGRAM_ADMIN_CHAT_ID" \
            -d text="❌ *${BOT_DISPLAY}* | Deploy FAILED (${TARGET_LABEL}): health check did not pass. Check logs." \
            -d parse_mode="Markdown" > /dev/null 2>&1
    fi
    echo -e "${CYAN}Logs: ssh $HETZNER_HOST \"docker logs $IDE_NAME --tail=50 -f\"${NC}"
    exit 1
fi

echo ""
echo -e "${CYAN}Logs: ssh $HETZNER_HOST \"docker logs $IDE_NAME --tail=50 -f\"${NC}"
