#!/usr/bin/env bash
# =============================================================================
# Something — one-liner installer
# =============================================================================
# Interactive setup wizard that takes a new operator from zero to a running
# workspace. It is a THIN WRAPPER around the scripts that already do the work:
#
#   bin/bootstrap-client-env.sh   — fills the per-client .env from 3 inputs
#   bin/add-redirect-uri.sh       — registers the OAuth callback (optional)
#   clients/<name>/deploy.sh      — the real deploy (SSH, Docker, health check)
#
# It does NOT re-implement any deploy logic. It only collects 4 answers,
# writes two small files, and calls the scripts above in order.
#
# Run it with:
#   curl -fsSL https://raw.githubusercontent.com/stanislawherjan1/Something/main/install.sh | bash
#
# Or, if you've already cloned the repo:
#   ./install.sh
# =============================================================================

set -uo pipefail

# --- Configuration ----------------------------------------------------------
REPO_URL="${SOMETHING_REPO_URL:-https://github.com/stanislawherjan1/Something.git}"
QUICK_START_URL="https://github.com/stanislawherjan1/Something/blob/main/docs/QUICK_START.md"

# --- Pretty output ----------------------------------------------------------
if [ -t 1 ]; then
    BOLD='\033[1m'; RED='\033[0;31m'; GREEN='\033[0;32m'
    YELLOW='\033[1;33m'; CYAN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'
else
    BOLD=''; RED=''; GREEN=''; YELLOW=''; CYAN=''; DIM=''; NC=''
fi

say()  { printf '%b\n' "$*"; }
info() { printf '%b\n' "${CYAN}$*${NC}"; }
ok()   { printf '%b\n' "${GREEN}✓ $*${NC}"; }
warn() { printf '%b\n' "${YELLOW}⚠ $*${NC}" >&2; }
err()  { printf '%b\n' "${RED}✗ $*${NC}" >&2; }
hr()   { printf '%b\n' "${DIM}────────────────────────────────────────────────────────────${NC}"; }

# When run as `curl ... | bash`, stdin is the script — read answers from the
# terminal directly so prompts still work.
if [ -t 0 ]; then TTY="/dev/stdin"; else TTY="/dev/tty"; fi
if [ ! -r "$TTY" ]; then
    err "No interactive terminal available."
    say "This installer asks a few questions, so it needs a terminal."
    say "Clone the repo and run it directly instead:"
    say "  ${BOLD}git clone $REPO_URL && cd Something && ./install.sh${NC}"
    exit 1
fi

# ask <prompt> [default]  → echoes the answer
ask() {
    local prompt="$1" default="${2:-}" reply=""
    if [ -n "$default" ]; then
        printf '%b' "${BOLD}$prompt${NC} ${DIM}[$default]${NC} " >&2
    else
        printf '%b' "${BOLD}$prompt${NC} " >&2
    fi
    IFS= read -r reply <"$TTY" || true
    [ -z "$reply" ] && reply="$default"
    printf '%s' "$reply"
}

# confirm <prompt> [default-yes]  → returns 0 for yes, 1 for no
confirm() {
    local prompt="$1" default="${2:-yes}" reply=""
    local hint="[Y/n]"; [ "$default" = "no" ] && hint="[y/N]"
    printf '%b' "${BOLD}$prompt${NC} $hint " >&2
    IFS= read -r reply <"$TTY" || true
    reply="$(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]')"
    [ -z "$reply" ] && reply="$default"
    case "$reply" in y|yes) return 0 ;; *) return 1 ;; esac
}

# =============================================================================
# Pre-flight — required tooling
# =============================================================================
say ""
say "${BOLD}Something — installer${NC}"
say "${DIM}A guided setup from an empty server to a running workspace.${NC}"
say ""

os_hint() {
    case "$(uname -s)" in
        Darwin) echo "brew install $1" ;;
        Linux)  echo "sudo apt-get install -y $1   (or your distro's package manager)" ;;
        *)      echo "install '$1' with your package manager" ;;
    esac
}

missing=()
for cmd in git ssh scp openssl curl; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
done
if [ ${#missing[@]} -gt 0 ]; then
    err "Missing required tools: ${missing[*]}"
    say "Install them first, then re-run this installer:"
    for m in "${missing[@]}"; do say "  ${BOLD}$(os_hint "$m")${NC}"; done
    exit 1
fi
ok "All required tools present (git, ssh, scp, openssl, curl)"

# Optional tools — used for nicer pre-checks, never required.
HAVE_DIG=0;     command -v dig    >/dev/null 2>&1 && HAVE_DIG=1
HAVE_PYTHON=0;  command -v python3>/dev/null 2>&1 && HAVE_PYTHON=1
HAVE_GCLOUD=0;  command -v gcloud >/dev/null 2>&1 && HAVE_GCLOUD=1

# =============================================================================
# Locate the repo (clone it if we're running from a pipe)
# =============================================================================
find_repo_root() {
    # Already inside the repo?
    if [ -f "ide-template/deploy.sh" ] && [ -d "clients/example-client" ]; then
        pwd; return 0
    fi
    # Next to this script (when executed as a file, not piped)?
    local src="${BASH_SOURCE[0]:-}"
    if [ -n "$src" ] && [ -f "$src" ]; then
        local d; d="$(cd "$(dirname "$src")" && pwd)"
        if [ -f "$d/ide-template/deploy.sh" ]; then echo "$d"; return 0; fi
    fi
    return 1
}

if REPO_ROOT="$(find_repo_root)"; then
    ok "Using repository at ${REPO_ROOT}"
else
    info "Repository not found here — cloning a fresh copy."
    target="Something"
    if [ -e "$target" ]; then
        target="Something-$(date +%s 2>/dev/null || echo new)"
    fi
    if ! git clone --depth 1 "$REPO_URL" "$target"; then
        err "git clone failed. Check the URL / your network and try again:"
        say "  $REPO_URL"
        exit 1
    fi
    REPO_ROOT="$(cd "$target" && pwd)"
    ok "Cloned into ${REPO_ROOT}"
fi
cd "$REPO_ROOT"

# Sanity: the scripts we wrap must exist.
for f in bin/bootstrap-client-env.sh clients/example-client/deploy.sh ide-template/deploy.sh; do
    if [ ! -f "$f" ]; then
        err "Expected file missing: $f"
        say "This doesn't look like a complete Something checkout."
        exit 1
    fi
done

# =============================================================================
# Overview — what's about to happen, and what to have ready
# =============================================================================
say ""; hr
say "${BOLD}Here's the plan${NC}"
say "I'll ask 4 short questions, then build and deploy your workspace to your"
say "server. End to end it's ~45–60 min — most of it waiting on the build and DNS."
say ""
say "${BOLD}Have these ready before continuing:${NC}"
say "  ${CYAN}1.${NC} A Linux server (e.g. Hetzner CX22, ~€4.50/mo) with your SSH key on it"
say "  ${CYAN}2.${NC} A domain with a DNS A record pointing at that server's IP"
say "  ${CYAN}3.${NC} A Google OAuth app — Client ID + Secret"
say "  ${CYAN}4.${NC} The Google email you'll sign in with"
say "  ${CYAN}5.${NC} ${DIM}(after deploy, in the wizard)${NC} a paid Claude plan (Pro/Max) for the token"
say ""
say "${DIM}New to any of this? The full step-by-step is at:${NC}"
say "${DIM}  ${QUICK_START_URL}${NC}"
say ""
say "${BOLD}Tip — you don't have to do this alone.${NC} Open this folder in an AI coding"
say "tool and ask ${BOLD}Claude Code${NC}, ${BOLD}Codex${NC}, or ${BOLD}Cursor${NC} to walk you through it: it can"
say "run each step with you, explain what's happening, fix errors as they come"
say "up, and adjust the project to what you need."
say ""
printf '%b' "${BOLD}Ready? Press Enter to begin${NC} ${DIM}(or Ctrl-C to prepare first)${NC} " >&2
IFS= read -r _ <"$TTY" || true

# =============================================================================
# Step 0/4 — Google OAuth credentials
# =============================================================================
say ""; hr
say "${BOLD}Step 0/4 — Google sign-in${NC}"
say "Something uses Google for login. You'll need a Google Cloud OAuth 2.0 app."
say "${DIM}How to create one: ${QUICK_START_URL}#google-oauth${NC}"
say ""

ADMIN_ENV="clients/admin.env"
WRITE_OAUTH=1
if [ -f "$ADMIN_ENV" ] && [ -s "$ADMIN_ENV" ]; then
    if confirm "Found existing Google credentials in $ADMIN_ENV. Use them?" yes; then
        WRITE_OAUTH=0
        ok "Reusing existing credentials."
    fi
fi

if [ "$WRITE_OAUTH" -eq 1 ]; then
    GOOGLE_CLIENT_ID=""
    while :; do
        GOOGLE_CLIENT_ID="$(ask "Google Client ID (ends in .apps.googleusercontent.com):")"
        case "$GOOGLE_CLIENT_ID" in
            *.apps.googleusercontent.com) break ;;
            "") warn "Can't be empty." ;;
            *) warn "That doesn't look right — it should end in .apps.googleusercontent.com" ;;
        esac
    done

    GOOGLE_CLIENT_SECRET=""
    while :; do
        GOOGLE_CLIENT_SECRET="$(ask "Google Client Secret (starts with GOCSPX-):")"
        case "$GOOGLE_CLIENT_SECRET" in
            GOCSPX-*) break ;;
            "") warn "Can't be empty." ;;
            *) if confirm "That doesn't start with GOCSPX- . Use it anyway?" no; then break; fi ;;
        esac
    done

    # Preserve an existing project id (set by an advanced operator) if present.
    EXISTING_PROJECT_ID=""
    if [ -f "$ADMIN_ENV" ]; then
        EXISTING_PROJECT_ID="$(grep -E '^GOOGLE_OAUTH_PROJECT_ID=' "$ADMIN_ENV" 2>/dev/null | head -1 | cut -d= -f2- || true)"
    fi

    umask 077
    {
        echo "# clients/admin.env — shared operator OAuth secrets (written by install.sh)"
        echo "GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID"
        echo "GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET"
        echo "GOOGLE_OAUTH_CLIENT_ID=$GOOGLE_CLIENT_ID"
        [ -n "$EXISTING_PROJECT_ID" ] && echo "GOOGLE_OAUTH_PROJECT_ID=$EXISTING_PROJECT_ID"
    } > "$ADMIN_ENV"
    chmod 600 "$ADMIN_ENV"
    ok "Saved credentials to $ADMIN_ENV (chmod 600)."
fi

# =============================================================================
# Step 1/4 — Server address
# =============================================================================
say ""; hr
say "${BOLD}Step 1/4 — Your server${NC}"
say "Your workspace runs on a Linux server. Paste its address from your provider."
say "${DIM}Example: root@203.0.113.4${NC}"
say ""

HETZNER_HOST=""
while :; do
    HETZNER_HOST="$(ask "Server address (user@host):")"
    if printf '%s' "$HETZNER_HOST" | grep -qE '^[a-zA-Z0-9_-]+@[a-zA-Z0-9._-]+$'; then
        break
    fi
    warn "Expected the form user@host, e.g. root@203.0.113.4"
done
SERVER_HOST="${HETZNER_HOST#*@}"
SERVER_USER="${HETZNER_HOST%@*}"

ssh_works() {
    ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new \
        "$HETZNER_HOST" 'echo ok' >/dev/null 2>&1
}

info "Checking SSH connectivity to $HETZNER_HOST ..."
if ssh_works; then
    ok "Connected to the server over SSH."
    SSH_OK=1
else
    SSH_OK=0
    warn "Couldn't connect to $HETZNER_HOST with your default SSH setup."
    say  "  The server may be reachable but using a key that plain 'ssh' doesn't"
    say  "  try automatically — e.g. one you generated just for this server, with"
    say  "  a non-default name. If so, point me at it and I'll wire it up."
    say  ""
    keypath="$(ask "Path to the SSH private key for this server (blank to skip):")"
    if [ -n "$keypath" ]; then
        keypath="${keypath/#\~/$HOME}"
        if [ -f "$keypath" ] && ssh -i "$keypath" -o BatchMode=yes -o ConnectTimeout=10 \
               -o StrictHostKeyChecking=accept-new "$HETZNER_HOST" 'echo ok' >/dev/null 2>&1; then
            ok "That key works."
            # Persist it for this host so plain ssh/scp (installer + deploy.sh) use
            # it automatically — without this, the deploy's scp would fail later.
            mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
            if ! grep -qiE "^[[:space:]]*Host[[:space:]]+$SERVER_HOST([[:space:]]|\$)" "$HOME/.ssh/config" 2>/dev/null; then
                printf '\nHost %s\n    User %s\n    IdentityFile %s\n    IdentitiesOnly yes\n' \
                    "$SERVER_HOST" "$SERVER_USER" "$keypath" >> "$HOME/.ssh/config"
                chmod 600 "$HOME/.ssh/config"
                ok "Wired it into ~/.ssh/config so the deploy uses it automatically."
            else
                warn "~/.ssh/config already has a Host entry for $SERVER_HOST — leaving it."
            fi
            ssh_works && { SSH_OK=1; ok "SSH now works without -i."; }
        else
            warn "Couldn't connect with that key either."
        fi
    fi
    if [ "$SSH_OK" -ne 1 ]; then
        warn "SSH still isn't working. Two common fixes:"
        say  "  • Put your public key on the server:  ${BOLD}ssh-copy-id $HETZNER_HOST${NC}"
        say  "  • If your key has a custom name, add it to ~/.ssh/config:"
        say  "        Host $SERVER_HOST"
        say  "            IdentityFile ~/.ssh/<your-key>"
        say  "            IdentitiesOnly yes"
        say  "  Then re-test:  ${BOLD}ssh $HETZNER_HOST 'echo ok'${NC}"
        confirm "Continue anyway? (the deploy will fail later if SSH can't connect)" no \
            || { say "Stopped. Fix SSH and re-run the installer."; exit 1; }
    fi
fi

# =============================================================================
# Step 2/4 — Domain
# =============================================================================
say ""; hr
say "${BOLD}Step 2/4 — Your domain${NC}"
say "The web address for your workspace. Its DNS A record must point to the"
say "server IP above."
say "${DIM}Example: workspace.mycompany.com${NC}"
say ""

FRONTEND_DOMAIN=""
while :; do
    raw="$(ask "Domain:")"
    # Strip a pasted scheme and any trailing slash/path.
    raw="$(printf '%s' "$raw" | sed -E 's#^https?://##; s#/.*$##')"
    if printf '%s' "$raw" | grep -qE '^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,253})$' \
       && printf '%s' "$raw" | grep -q '\.'; then
        FRONTEND_DOMAIN="$raw"
        break
    fi
    warn "Expected a bare domain like workspace.mycompany.com (no https://, no path)."
done

# DNS pre-check — warn on mismatch, never abort. Only meaningful when the
# server address is an IP we can compare against.
if [ "$HAVE_DIG" -eq 1 ] && printf '%s' "$SERVER_HOST" | grep -qE '^[0-9]+(\.[0-9]+){3}$'; then
    info "Checking DNS for $FRONTEND_DOMAIN ..."
    resolved="$(dig +short A "$FRONTEND_DOMAIN" 2>/dev/null | grep -E '^[0-9]+(\.[0-9]+){3}$' | head -1 || true)"
    if [ -z "$resolved" ]; then
        warn "$FRONTEND_DOMAIN doesn't resolve yet."
        say  "  Add a DNS A record: ${BOLD}$FRONTEND_DOMAIN → $SERVER_HOST${NC}, then wait a minute."
        say  "  TLS provisioning fails if DNS isn't live at deploy time."
    elif [ "$resolved" != "$SERVER_HOST" ]; then
        warn "$FRONTEND_DOMAIN points to $resolved, not your server ($SERVER_HOST)."
        say  "  Update the A record to ${BOLD}$SERVER_HOST${NC} or the cert won't issue."
    else
        ok "DNS for $FRONTEND_DOMAIN points to $SERVER_HOST."
    fi
else
    say "${DIM}(Skipping DNS pre-check — install 'dig' or use an IP server address to enable it.)${NC}"
fi

# =============================================================================
# Step 3/4 — Admin email
# =============================================================================
say ""; hr
say "${BOLD}Step 3/4 — Admin email${NC}"
say "The Google account you'll use to sign in. You can add more team members"
say "later from the workspace."
say ""

ADMIN_EMAIL=""
while :; do
    ADMIN_EMAIL="$(ask "Your Google email:")"
    if printf '%s' "$ADMIN_EMAIL" | grep -qE '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'; then
        break
    fi
    warn "That doesn't look like an email address."
done

# =============================================================================
# Step 4/4 — Deploy
# =============================================================================
say ""; hr
say "${BOLD}Step 4/4 — Deploy${NC}"
say ""

# Folder name = sanitized domain. The folder name becomes IDE_NAME /
# REMOTE_PATH (bootstrap-client-env.sh derives them), so keep it docker-safe.
CLIENT_NAME="$(printf '%s' "$FRONTEND_DOMAIN" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9]/-/g; s/-\+/-/g; s/^-//; s/-$//')"
[ -n "$CLIENT_NAME" ] || CLIENT_NAME="workspace"
CLIENT_DIR="clients/$CLIENT_NAME"

say "Configuration:"
say "  ${DIM}Server:${NC}  $HETZNER_HOST"
say "  ${DIM}Domain:${NC}  $FRONTEND_DOMAIN"
say "  ${DIM}Admin:${NC}   $ADMIN_EMAIL"
say "  ${DIM}Folder:${NC}  $CLIENT_DIR"
say ""
confirm "Create this workspace and deploy now?" yes || { say "Stopped. Nothing was deployed."; exit 0; }

# --- Create the client directory from the template -------------------------
if [ -d "$CLIENT_DIR" ]; then
    warn "$CLIENT_DIR already exists."
    confirm "Reuse it (keep existing files, refresh the 3 inputs)?" yes \
        || { say "Stopped. Remove or rename $CLIENT_DIR and re-run."; exit 1; }
else
    cp -r clients/example-client "$CLIENT_DIR"
    ok "Created $CLIENT_DIR from the template."
fi

# --- Write the 3 operator inputs into .env ---------------------------------
# bootstrap-client-env.sh derives/generates everything else from these.
ENV_FILE="$CLIENT_DIR/.env"
umask 077
{
    echo "# Written by install.sh — the 3 operator inputs."
    echo "# bootstrap-client-env.sh auto-fills the rest on deploy."
    echo "HETZNER_HOST=$HETZNER_HOST"
    echo "FRONTEND_DOMAIN=$FRONTEND_DOMAIN"
    echo "IDE_ALLOWED_EMAILS=$ADMIN_EMAIL"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
ok "Wrote $ENV_FILE."

# --- Fill the rest of the .env (idempotent) --------------------------------
info "Filling in derived configuration ..."
if ! bin/bootstrap-client-env.sh "$ENV_FILE"; then
    err "Could not complete the configuration (bootstrap-client-env.sh failed)."
    say "Check the errors above, then re-run this installer."
    exit 1
fi

# --- Register the OAuth redirect URI (best effort) -------------------------
# add-redirect-uri.sh needs gcloud + GOOGLE_OAUTH_PROJECT_ID. Most operators
# add the callback URL by hand in the Google console instead (the Quick Start
# walks through it), so a missing prerequisite here is a note, not a failure.
say ""
ADMIN_PROJECT_ID=""
[ -f "$ADMIN_ENV" ] && ADMIN_PROJECT_ID="$(grep -E '^GOOGLE_OAUTH_PROJECT_ID=' "$ADMIN_ENV" 2>/dev/null | head -1 | cut -d= -f2- || true)"
if [ "$HAVE_GCLOUD" -eq 1 ] && [ -n "$ADMIN_PROJECT_ID" ] && [ "$HAVE_PYTHON" -eq 1 ]; then
    info "Registering OAuth redirect URI for $FRONTEND_DOMAIN ..."
    if bin/add-redirect-uri.sh "$FRONTEND_DOMAIN"; then
        ok "Redirect URI registered."
    else
        warn "Couldn't register the redirect URI automatically."
        say  "  Add it by hand in the Google console:"
        say  "    Authorized redirect URI → ${BOLD}https://$FRONTEND_DOMAIN/auth/callback${NC}"
    fi
else
    say  "${RED}${BOLD}ACTION REQUIRED — add this redirect URI before you log in:${NC}"
    say  "    ${BOLD}https://$FRONTEND_DOMAIN/auth/callback${NC}"
    say  "  Without it, the first Google sign-in fails with ${BOLD}redirect_uri_mismatch${NC}."
    say  "  Where: ${CYAN}https://console.cloud.google.com${NC} → APIs & Services →"
    say  "         Credentials → your OAuth client → Authorized redirect URIs → ADD URI."
    say  "  ${DIM}Step-by-step: ${QUICK_START_URL}#google-oauth${NC}"
fi

# --- Ensure Docker is present on the server ---------------------------------
# deploy.sh runs `docker compose` on the server but doesn't install Docker.
if [ "${SSH_OK:-0}" -eq 1 ]; then
    if ssh -o BatchMode=yes -o ConnectTimeout=10 "$HETZNER_HOST" 'command -v docker >/dev/null 2>&1'; then
        ok "Docker is installed on the server."
    else
        warn "Docker isn't installed on the server yet."
        if confirm "Install Docker + firewall rules on $SERVER_HOST now?" yes; then
            info "Installing Docker (this can take a minute) ..."
            if ssh -o BatchMode=yes "$HETZNER_HOST" 'curl -fsSL https://get.docker.com | sh'; then
                ssh -o BatchMode=yes "$HETZNER_HOST" \
                    'ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw deny 8080 && ufw deny 3002 && ufw --force enable' \
                    >/dev/null 2>&1 || warn "Docker installed, but firewall (ufw) setup was skipped/failed — review it manually."
                ok "Docker installed on the server."
            else
                err "Docker install failed on the server."
                say "  Install it manually, then re-run:"
                say "    ${BOLD}ssh $HETZNER_HOST 'curl -fsSL https://get.docker.com | sh'${NC}"
                exit 1
            fi
        else
            warn "Continuing without installing Docker — the deploy will fail if it's missing."
        fi
    fi
fi

# --- Deploy ----------------------------------------------------------------
say ""; hr
info "Deploying — building on the server and swapping in the new containers."
say "${DIM}This usually takes a few minutes on the first run.${NC}"
say ""

"./$CLIENT_DIR/deploy.sh"
DEPLOY_RC=$?

if [ "$DEPLOY_RC" -ne 0 ]; then
    say ""; hr
    err "Deploy did not finish cleanly (exit code $DEPLOY_RC)."
    say ""
    say "${BOLD}Common causes:${NC}"
    say "  ${YELLOW}•${NC} SSH/permission denied → ${BOLD}ssh-copy-id $HETZNER_HOST${NC}, then test ${BOLD}ssh $HETZNER_HOST 'echo ok'${NC}"
    say "  ${YELLOW}•${NC} Docker missing on server → ${BOLD}ssh $HETZNER_HOST 'curl -fsSL https://get.docker.com | sh'${NC}"
    say "  ${YELLOW}•${NC} 'address already in use' / port conflict → another stack owns 80/443. Use a fresh server (one workspace per server)."
    say "  ${YELLOW}•${NC} TLS/cert errors → DNS for $FRONTEND_DOMAIN must point to $SERVER_HOST before deploy."
    say ""
    say "The deploy is idempotent — fix the issue and re-run:"
    say "  ${BOLD}./$CLIENT_DIR/deploy.sh${NC}"
    say "More help: ${QUICK_START_URL}#troubleshooting"
    exit "$DEPLOY_RC"
fi

# =============================================================================
# Success
# =============================================================================
say ""
say "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
say "${GREEN}║              Your workspace is ready. 🎉                    ║${NC}"
say "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
say ""
say "  ${BOLD}Open:${NC}  ${CYAN}https://$FRONTEND_DOMAIN${NC}"
say ""
say "  ${BOLD}Next steps${NC}"
say "    1. Sign in with ${BOLD}$ADMIN_EMAIL${NC} (Google)."
say "    2. Complete the first-login wizard (name, logo, personality)."
say "    3. Paste a Claude token when asked — generate it with:"
say "         ${DIM}npm install -g @anthropic-ai/claude-code && claude setup-token${NC}"
say "    4. Open ${BOLD}Integrations${NC} to add your Telegram bot token and tools."
say ""
say "  ${DIM}Full walkthrough: ${QUICK_START_URL}${NC}"
say ""
