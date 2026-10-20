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
# It does NOT re-implement any deploy logic. It only collects a handful of
# answers, writes two small files, and calls the scripts above in order.
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
    # ACCENT is the single brand accent (dots, prompts, links, spinner):
    # 256-color deep honey, the readable-on-light cousin of the landing's
    # --yellow #f2c14e. Swap this one value to re-skin the installer.
    YELLOW='\033[1;33m'; ACCENT='\033[38;5;178m'; DIM='\033[2m'; NC='\033[0m'
else
    BOLD=''; RED=''; GREEN=''; YELLOW=''; ACCENT=''; DIM=''; NC=''
fi

# Visual language: a calm, narrow column. Everything the user reads is
# indented two spaces; glyphs carry the color, text stays plain.
say()  { printf '%b\n' "$*"; }
info() { printf '%b\n' "  ${DIM}$*${NC}"; }
ok()   { printf '%b\n' "  ${GREEN}✓${NC} $*"; }
warn() { printf '%b\n' "  ${YELLOW}⚠${NC} $*" >&2; }
err()  { printf '%b\n' "  ${RED}✗${NC} $*" >&2; }
hr()   { say ""; }

# step <n> <title> — the shared skeleton of every step: dot progress + header
STEPS_TOTAL=6
step() {
    local n="$1" title="$2" dots="" i
    for ((i=1; i<=STEPS_TOTAL; i++)); do
        # Braces are load-bearing: macOS bash 3.2 counts a multibyte char
        # right after an unbraced $var as part of the variable name.
        if [ "$i" -le "$n" ]; then dots="${dots}${ACCENT}●${NC} "; else dots="${dots}${DIM}○${NC} "; fi
    done
    say ""; say ""
    say "  $dots ${DIM}Step $n of $STEPS_TOTAL —${NC} ${BOLD}$title${NC}"
    say ""
}

# m:ss, for phase durations
mmss() { printf '%d:%02d' "$(( $1 / 60 ))" "$(( $1 % 60 ))"; }

# When run as `curl ... | bash`, stdin is the script — read answers from the
# terminal directly so prompts still work.
if [ -t 0 ]; then TTY="/dev/stdin"; else TTY="/dev/tty"; fi
# `-r` is not enough: with no controlling terminal /dev/tty exists and passes
# the permission check, but opening it fails ("Device not configured" on
# macOS) — probe by actually opening it for read.
if ! { : <"$TTY"; } 2>/dev/null; then
    err "No interactive terminal available."
    say "  This installer asks a few questions, so it needs a terminal."
    say "  Clone the repo and run it directly instead:"
    say "    ${BOLD}git clone $REPO_URL && cd Something && ./install.sh${NC}"
    say "  An AI coding agent? Don't re-run this — follow ${BOLD}docs/AGENT_SETUP.md${NC} instead."
    exit 1
fi

# ask <prompt> [default]  → echoes the answer
ask() {
    local prompt="$1" default="${2:-}" reply=""
    if [ -n "$default" ]; then
        printf '%b' "  ${BOLD}$prompt${NC} ${DIM}[$default]${NC} ${ACCENT}›${NC} " >&2
    else
        printf '%b' "  ${BOLD}$prompt${NC} ${ACCENT}›${NC} " >&2
    fi
    IFS= read -r reply <"$TTY" || true
    [ -z "$reply" ] && reply="$default"
    printf '%s' "$reply"
}

# confirm <prompt> [default-yes]  → returns 0 for yes, 1 for no
confirm() {
    local prompt="$1" default="${2:-yes}" reply=""
    local hint="[Y/n]"; [ "$default" = "no" ] && hint="[y/N]"
    printf '%b' "  ${BOLD}$prompt${NC} ${DIM}$hint${NC} ${ACCENT}›${NC} " >&2
    IFS= read -r reply <"$TTY" || true
    reply="$(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]')"
    [ -z "$reply" ] && reply="$default"
    case "$reply" in y|yes) return 0 ;; *) return 1 ;; esac
}

# =============================================================================
# Pre-flight — required tooling
# =============================================================================
say ""
say "  ${ACCENT}${BOLD}Something${NC}"
say "  ${DIM}Your AI coworker, on your own server.${NC}"
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
    say "  Install them first, then re-run this installer:"
    for m in "${missing[@]}"; do say "    ${BOLD}$(os_hint "$m")${NC}"; done
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
say ""
say "  ${BOLD}Here's the plan${NC}"
say ""
say "  Six short steps, then the build. End to end it's usually 45–60 minutes,"
say "  most of it waiting — and it's always safe to re-run this installer: it"
say "  picks up where it left off."
say ""
say "  Along the way you'll need:"
say "    ${ACCENT}·${NC} a Linux server ${DIM}(e.g. Hetzner CX22, ~€4.50/mo)${NC}"
say "    ${ACCENT}·${NC} a domain, for your workspace's web address"
say "    ${ACCENT}·${NC} a Google account ${DIM}(your team signs in with Google)${NC}"
say "    ${ACCENT}·${NC} a paid Claude plan ${DIM}(Pro or Max — used at the very end)${NC}"
say ""
say "  ${DIM}New to any of this? Full step-by-step guide:${NC}"
say "  ${ACCENT}${QUICK_START_URL}${NC}"
say ""
say "  ${DIM}Tip: an AI coding tool (Claude Code, Codex, Cursor) can run this whole${NC}"
say "  ${DIM}setup with you — open this folder there and ask it to install Something.${NC}"
say ""
printf '%b' "  ${BOLD}Ready? Press Enter to begin${NC} ${DIM}(or Ctrl-C to prepare first)${NC} " >&2
IFS= read -r _ <"$TTY" || true

# =============================================================================
# Step 1/6 — Google sign-in
# =============================================================================
step 1 "Google sign-in"
say "  Your team will sign in with Google, so Google has to know this app."
say "  It's the fiddliest part, all in the browser (~5 min) — and then it's"
say "  done forever:"
say ""
say "    ${ACCENT}1.${NC} Create a project     ${ACCENT}https://console.cloud.google.com/projectcreate${NC}"
say "    ${ACCENT}2.${NC} Consent screen       ${ACCENT}https://console.cloud.google.com/auth/branding${NC}"
say "       ${DIM}App name + your email; audience: External — or Internal, if your${NC}"
say "       ${DIM}whole team is on one Google Workspace domain (then skip step 3).${NC}"
say "    ${ACCENT}3.${NC} ${YELLOW}Publish the app${NC}      ${DIM}Audience page → 'Publish app' → In production.${NC}"
say "       ${DIM}Left in 'Testing', sign-in later fails with 'access blocked'.${NC}"
say "       ${DIM}No review is needed for basic email/profile scopes.${NC}"
say "    ${ACCENT}4.${NC} Create the client    ${ACCENT}https://console.cloud.google.com/auth/clients/create${NC}"
say "       ${DIM}Type: Web application. Leave redirect URIs empty for now —${NC}"
say "       ${DIM}I'll hand you the exact URI later and verify it before deploying.${NC}"
say ""
say "  ${DIM}Click-by-click guide:${NC} ${ACCENT}${QUICK_START_URL}#4-google-oauth-setup${NC}"
say ""

ADMIN_ENV="clients/admin.env"
# The prompts live in bin/collect-secrets.sh — shared with the agent-driven
# path (docs/AGENT_SETUP.md), so secrets have exactly one implementation.
if ! bin/collect-secrets.sh; then
    err "Couldn't save the Google credentials — fix the issue above and re-run."
    exit 1
fi

# =============================================================================
# Step 2/6 — Your server
# =============================================================================
step 2 "Your server"
say "  Where your workspace will live. Copy the IP address straight from your"
say "  provider's panel."
say "  ${DIM}example: 203.0.113.4 — or user@host, if you created a non-root user${NC}"
say ""

HETZNER_HOST=""
while :; do
    raw="$(ask "Server IP")"
    raw="$(printf '%s' "$raw" | tr -d '[:space:]')"   # tolerate stray spaces
    if printf '%s' "$raw" | grep -qE '^[a-zA-Z0-9_-]+@[a-zA-Z0-9._-]+$'; then
        HETZNER_HOST="$raw"                    # already user@host
        break
    elif printf '%s' "$raw" | grep -qE '^[a-zA-Z0-9._-]+$'; then
        HETZNER_HOST="root@$raw"               # bare IP/host → default to root
        break
    fi
    warn "Paste just the IP (e.g. 203.0.113.4), or user@host for a custom user."
done
SERVER_HOST="${HETZNER_HOST#*@}"
SERVER_USER="${HETZNER_HOST%@*}"

# NOTE: every ssh below uses -n (stdin from /dev/null). Without it, when this
# script is run via `curl ... | bash`, ssh would read and consume the rest of
# the piped script from stdin, ending the installer early.
ssh_works() {
    ssh -n -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new \
        "$HETZNER_HOST" 'echo ok' >/dev/null 2>&1
}

info "Checking SSH connectivity to $HETZNER_HOST ..."
if ssh_works; then
    ok "Connected to the server over SSH."
    SSH_OK=1
else
    SSH_OK=0
    warn "Couldn't connect to $HETZNER_HOST over SSH yet."
    say  "  Let's fix it — pick what matches your server:"
    say  "    ${ACCENT}1${NC}  I have the server's root password ${DIM}(your provider emailed it)${NC} — set it up for me"
    say  "    ${ACCENT}2${NC}  It uses an SSH key with a custom name — point me at the key file"
    say  "    ${ACCENT}3${NC}  Skip — I'll sort SSH out myself"
    say  ""
    choice="$(ask "Choose 1, 2, or 3" "1")"
    case "$choice" in
        2)
            keypath="$(ask "Path to the SSH private key for this server")"
            keypath="${keypath/#\~/$HOME}"
            if [ -n "$keypath" ] && [ -f "$keypath" ] && ssh -n -i "$keypath" -o BatchMode=yes \
                   -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "$HETZNER_HOST" 'echo ok' >/dev/null 2>&1; then
                ok "That key works."
                # Persist it for this host so plain ssh/scp (installer + deploy.sh) use it.
                mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
                if ! grep -qiE "^[[:space:]]*Host[[:space:]]+$SERVER_HOST([[:space:]]|\$)" "$HOME/.ssh/config" 2>/dev/null; then
                    printf '\nHost %s\n    User %s\n    IdentityFile %s\n    IdentitiesOnly yes\n' \
                        "$SERVER_HOST" "$SERVER_USER" "$keypath" >> "$HOME/.ssh/config"
                    chmod 600 "$HOME/.ssh/config"
                    ok "Wired it into ~/.ssh/config — the deploy will use it automatically."
                fi
                ssh_works && SSH_OK=1
            else
                warn "Couldn't connect with that key."
            fi
            ;;
        1)
            if [ ! -f "$HOME/.ssh/id_ed25519" ]; then
                info "No SSH key found — generating ~/.ssh/id_ed25519 ..."
                mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
                ssh-keygen -t ed25519 -N "" -f "$HOME/.ssh/id_ed25519" >/dev/null 2>&1 && ok "Key created."
            fi
            say "  Installing your public key on the server."
            say "  ${BOLD}Enter the server's root password when prompted${NC} ${DIM}(Hetzner emails it${NC}"
            say "  ${DIM}when you create a server without an SSH key).${NC}"
            if command -v ssh-copy-id >/dev/null 2>&1; then
                ssh-copy-id -i "$HOME/.ssh/id_ed25519.pub" -o StrictHostKeyChecking=accept-new "$HETZNER_HOST" </dev/null || true
            else
                ssh -o StrictHostKeyChecking=accept-new "$HETZNER_HOST" \
                    'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys' \
                    < "$HOME/.ssh/id_ed25519.pub" || true
            fi
            ssh_works && { SSH_OK=1; ok "SSH key installed — connected."; }
            ;;
        *) : ;;
    esac
    if [ "$SSH_OK" -ne 1 ]; then
        warn "SSH still isn't working. Fix it manually, then re-run the installer:"
        say  "    ${DIM}·${NC} Install your key:  ${BOLD}ssh-copy-id $HETZNER_HOST${NC}"
        say  "    ${DIM}·${NC} Custom key name?  add to ~/.ssh/config:  Host $SERVER_HOST / IdentityFile ~/.ssh/<key> / IdentitiesOnly yes"
        say  "    ${DIM}·${NC} Re-test:  ${BOLD}ssh $HETZNER_HOST 'echo ok'${NC}"
        confirm "Continue anyway? (the deploy will fail later if SSH can't connect)" no \
            || { say "  Stopped. Fix SSH and re-run the installer."; exit 1; }
    fi
fi

# =============================================================================
# Step 3/6 — Your domain
# =============================================================================
step 3 "Your domain"
say "  The web address of your workspace — the one you'll open every day. In"
say "  your domain provider's panel, point a DNS ${BOLD}A record${NC} at ${BOLD}$SERVER_HOST${NC}."
say "  ${DIM}example: workspace.mycompany.com — on Cloudflare: proxy OFF ('DNS only')${NC}"
say ""

FRONTEND_DOMAIN=""
while :; do
    raw="$(ask "Domain")"
    # Strip a pasted scheme and any trailing slash/path.
    raw="$(printf '%s' "$raw" | sed -E 's#^https?://##; s#/.*$##')"
    if printf '%s' "$raw" | grep -qE '^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,253})$' \
       && printf '%s' "$raw" | grep -q '\.'; then
        FRONTEND_DOMAIN="$raw"
        break
    fi
    warn "Expected a bare domain like workspace.mycompany.com (no https://, no path)."
done

# DNS pre-check — like the OAuth check, this is a fix-and-recheck LOOP, not a
# warn-and-continue: TLS provisioning hard-fails at deploy time if the record
# isn't live, so waiting 60s here beats failing 10 minutes in. Only meaningful
# when the server address is an IP we can compare against.
if [ "$HAVE_DIG" -eq 1 ] && printf '%s' "$SERVER_HOST" | grep -qE '^[0-9]+(\.[0-9]+){3}$'; then
    while :; do
        info "Checking DNS for $FRONTEND_DOMAIN ..."
        resolved="$(dig +short A "$FRONTEND_DOMAIN" 2>/dev/null | grep -E '^[0-9]+(\.[0-9]+){3}$' | head -1 || true)"
        if [ "$resolved" = "$SERVER_HOST" ]; then
            ok "DNS for $FRONTEND_DOMAIN points to $SERVER_HOST."
            break
        fi
        if [ -z "$resolved" ]; then
            warn "$FRONTEND_DOMAIN doesn't resolve yet."
            say  "    In your domain provider's DNS panel, add an A record:"
            say  "      ${BOLD}$FRONTEND_DOMAIN → $SERVER_HOST${NC}"
            say  "    ${DIM}(Cloudflare: proxy OFF / 'DNS only'. Propagation is usually <1 min.)${NC}"
        else
            warn "$FRONTEND_DOMAIN points to $resolved, not your server ($SERVER_HOST)."
            say  "    Update the A record to ${BOLD}$SERVER_HOST${NC} — the secure-connection"
            say  "    certificate can't be issued otherwise."
        fi
        if ! confirm "Record added/fixed? Press Enter to re-check (or 'n' to continue anyway)" yes; then
            warn "Continuing with unverified DNS — the deploy's preflight will re-check and stop if it's still wrong."
            break
        fi
    done
else
    say "  ${DIM}(Skipping DNS pre-check — install 'dig' or use an IP server address to enable it.)${NC}"
fi

# =============================================================================
# Step 4/6 — About you
# =============================================================================
step 4 "About you"
say "  The Google account you'll sign in with. Teammates can be added later,"
say "  from inside the workspace."
say ""

ADMIN_EMAIL=""
while :; do
    ADMIN_EMAIL="$(ask "Your Google email")"
    if printf '%s' "$ADMIN_EMAIL" | grep -qE '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'; then
        break
    fi
    warn "That doesn't look like an email address."
done

# Timezone: detected silently from this machine (/etc/localtime is a
# zoneinfo symlink on macOS and most Linux distros; fallback UTC). Daily
# rituals freeze the hour they're created with, so a close guess beats UTC —
# but it's not worth a question: it shows on the Review card and can be
# changed anytime in the workspace Settings.
IDE_TIMEZONE="$(readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||')"
case "$IDE_TIMEZONE" in */*) : ;; *) IDE_TIMEZONE="UTC" ;; esac

# =============================================================================
# Step 5/6 — Review
# =============================================================================
step 5 "Review"

# Folder name = sanitized domain. The folder name becomes IDE_NAME /
# REMOTE_PATH (bootstrap-client-env.sh derives them), so keep it docker-safe.
CLIENT_NAME="$(printf '%s' "$FRONTEND_DOMAIN" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9]/-/g; s/-\+/-/g; s/^-//; s/-$//')"
[ -n "$CLIENT_NAME" ] || CLIENT_NAME="workspace"
CLIENT_DIR="clients/$CLIENT_NAME"

say "  Everything your workspace will be created with:"
say ""
say "    ${DIM}Server${NC}    $HETZNER_HOST"
say "    ${DIM}Address${NC}   ${ACCENT}https://$FRONTEND_DOMAIN${NC}"
say "    ${DIM}Admin${NC}     $ADMIN_EMAIL"
say "    ${DIM}Timezone${NC}  $IDE_TIMEZONE ${DIM}(from this computer — change anytime in Settings)${NC}"
say "    ${DIM}Folder${NC}    $CLIENT_DIR"
say ""
confirm "Create this workspace and deploy now?" yes || { say "  Stopped. Nothing was deployed."; exit 0; }

# --- Create the client directory from the template -------------------------
if [ -d "$CLIENT_DIR" ]; then
    warn "$CLIENT_DIR already exists."
    confirm "Reuse it (keep existing files, refresh the 3 inputs)?" yes \
        || { say "Stopped. Remove or rename $CLIENT_DIR and re-run."; exit 1; }
else
    cp -r clients/example-client "$CLIENT_DIR"
    ok "Created $CLIENT_DIR from the template."
fi

# --- Write the operator inputs into .env ------------------------------------
# bootstrap-client-env.sh derives/generates everything else from these.
ENV_FILE="$CLIENT_DIR/.env"
umask 077
{
    echo "# Written by install.sh — the operator inputs."
    echo "# bootstrap-client-env.sh auto-fills the rest on deploy."
    echo "HETZNER_HOST=$HETZNER_HOST"
    echo "FRONTEND_DOMAIN=$FRONTEND_DOMAIN"
    echo "IDE_ALLOWED_EMAILS=$ADMIN_EMAIL"
    echo "IDE_TIMEZONE=$IDE_TIMEZONE"
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

# --- Register + VERIFY the OAuth redirect URI -------------------------------
# Registration: automatic when gcloud + project id are available, manual (in
# the browser, guided) otherwise. Verification: an unauthenticated probe of
# Google's authorize endpoint — the response body distinguishes "URI not
# registered" (redirect_uri_mismatch) from "bad client id" from "all good",
# so the user finds out NOW, not at their first sign-in after deploy.
say ""
CALLBACK_URI="https://$FRONTEND_DOMAIN/auth/callback"
CID="$(grep -E '^GOOGLE_CLIENT_ID=' "$ADMIN_ENV" 2>/dev/null | head -1 | cut -d= -f2- || true)"

# → 0 registered · 1 uri-not-registered · 2 bad client id · 3 inconclusive
verify_oauth_redirect() {
    local body
    body="$(curl -sSL --max-time 8 "https://accounts.google.com/o/oauth2/v2/auth?client_id=${CID}&redirect_uri=https%3A%2F%2F${FRONTEND_DOMAIN}%2Fauth%2Fcallback&response_type=code&scope=openid%20email" 2>/dev/null || true)"
    [ -z "$body" ] && return 3
    printf '%s' "$body" | grep -q "redirect_uri_mismatch" && return 1
    printf '%s' "$body" | grep -qi "invalid_client\|OAuth client was not found" && return 2
    return 0
}

ADMIN_PROJECT_ID=""
[ -f "$ADMIN_ENV" ] && ADMIN_PROJECT_ID="$(grep -E '^GOOGLE_OAUTH_PROJECT_ID=' "$ADMIN_ENV" 2>/dev/null | head -1 | cut -d= -f2- || true)"
if [ "$HAVE_GCLOUD" -eq 1 ] && [ -n "$ADMIN_PROJECT_ID" ] && [ "$HAVE_PYTHON" -eq 1 ]; then
    info "Registering OAuth redirect URI for $FRONTEND_DOMAIN ..."
    bin/add-redirect-uri.sh "$FRONTEND_DOMAIN" >/dev/null 2>&1 || true
fi

while :; do
    info "Verifying the OAuth setup with Google ..."
    verify_oauth_redirect; RC=$?
    case "$RC" in
        0)  ok "Google confirms: client valid, $CALLBACK_URI registered."
            break ;;
        1)  warn "The redirect URI isn't registered yet."
            say  "    In the Google console, open your OAuth client:"
            say  "      ${BOLD}https://console.cloud.google.com/auth/clients${NC}"
            say  "    Under ${BOLD}Authorized redirect URIs → Add URI${NC}, paste exactly:"
            say  "      ${BOLD}$CALLBACK_URI${NC}"
            say  "    ${DIM}(no trailing slash) → Save. Google needs a few seconds to apply it.${NC}"
            if confirm "Done? Press Enter to re-check (or 'n' to continue without verifying)" yes; then
                continue
            else
                warn "Continuing unverified — first sign-in will fail with redirect_uri_mismatch until the URI is added."
                break
            fi ;;
        2)  warn "Google rejected the Client ID from $ADMIN_ENV."
            say  "    Compare it against ${BOLD}https://console.cloud.google.com/auth/clients${NC}"
            say  "    and fix $ADMIN_ENV, then re-check."
            if confirm "Fixed? Press Enter to re-check (or 'n' to continue anyway)" yes; then
                CID="$(grep -E '^GOOGLE_CLIENT_ID=' "$ADMIN_ENV" 2>/dev/null | head -1 | cut -d= -f2- || true)"
                continue
            else
                break
            fi ;;
        *)  warn "Couldn't reach Google to verify (network?). Continuing — deploy preflight re-checks this."
            break ;;
    esac
done

# --- Ensure Docker is present on the server ---------------------------------
# deploy.sh runs `docker compose` on the server but doesn't install Docker.
if [ "${SSH_OK:-0}" -eq 1 ]; then
    if ssh -n -o BatchMode=yes -o ConnectTimeout=10 "$HETZNER_HOST" 'command -v docker >/dev/null 2>&1'; then
        ok "Docker is installed on the server."
    else
        warn "Docker isn't installed on the server yet."
        if confirm "Install Docker + firewall rules on $SERVER_HOST now?" yes; then
            info "Installing Docker (this can take a minute) ..."
            if ssh -n -o BatchMode=yes "$HETZNER_HOST" 'curl -fsSL https://get.docker.com | sh'; then
                ssh -n -o BatchMode=yes "$HETZNER_HOST" \
                    'ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw deny 8080 && ufw deny 3002 && ufw --force enable' \
                    >/dev/null 2>&1 || warn "Docker installed, but firewall (ufw) setup was skipped/failed — review it manually."
                ok "Docker installed on the server."
            else
                err "Docker install failed on the server."
                say "    Install it manually, then re-run:"
                say "      ${BOLD}ssh $HETZNER_HOST 'curl -fsSL https://get.docker.com | sh'${NC}"
                exit 1
            fi
        else
            warn "Continuing without installing Docker — the deploy will fail if it's missing."
        fi
    fi
fi

# =============================================================================
# Step 6/6 — Deploy
# =============================================================================
# deploy.sh's full output goes to a log file — REDIRECTED, never piped, so its
# exit code survives (the exit code is the signal). On a terminal we render
# deploy.sh's own [k/5] phase markers as a calm live checklist; without one we
# print each phase once as it starts.
PHASE_NAMES=("Preflight checks" "Server baseline (firewall, swap, security)" "Uploading the code" "Building the workspace" "Swapping in the new version" "Health check")
PHASE_MARKS=("[0/5]" "[0b/5]" "[1/5]" "[3/5]" "[4/5]" "[5/5]")
SPIN=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')

run_deploy() {
    local log="$1" pid rc i j cur=-1 frame=0 start elapsed dur
    local t=(0 0 0 0 0 0)   # seconds (since start) each phase was first seen
    : > "$log"
    # </dev/null so deploy.sh's own ssh/scp calls don't read this (possibly
    # piped) script's stdin.
    "./$CLIENT_DIR/deploy.sh" </dev/null >"$log" 2>&1 &
    pid=$!
    start=$SECONDS

    if [ ! -t 1 ]; then
        # No terminal to repaint on: print each phase once as it starts.
        while kill -0 "$pid" 2>/dev/null; do
            while [ $((cur + 1)) -lt 6 ] && grep -qF -- "${PHASE_MARKS[cur+1]}" "$log"; do
                cur=$((cur + 1))
                say "  → ${PHASE_NAMES[cur]} ..."
            done
            sleep 2
        done
        wait "$pid"
        return $?
    fi

    for ((i=0; i<6; i++)); do printf '  %b○  %s%b\n' "$DIM" "${PHASE_NAMES[i]}" "$NC"; done
    while kill -0 "$pid" 2>/dev/null; do
        elapsed=$((SECONDS - start))
        for ((i=5; i>cur; i--)); do
            if grep -qF -- "${PHASE_MARKS[i]}" "$log"; then
                for ((j=cur+1; j<=i; j++)); do t[j]=$elapsed; done
                cur=$i
                break
            fi
        done
        printf '\033[6A'
        for ((i=0; i<6; i++)); do
            printf '\033[2K'
            if [ "$i" -lt "$cur" ]; then
                dur=$(( ${t[i+1]} - ${t[i]} )); [ "$dur" -lt 0 ] && dur=0
                printf '  %b✓%b  %s  %b%s%b\n' "$GREEN" "$NC" "${PHASE_NAMES[i]}" "$DIM" "$(mmss "$dur")" "$NC"
            elif [ "$i" -eq "$cur" ]; then
                dur=$(( elapsed - ${t[i]} )); [ "$dur" -lt 0 ] && dur=0
                printf '  %b%s%b  %s  %b%s%b\n' "$ACCENT" "${SPIN[frame % 10]}" "$NC" "${PHASE_NAMES[i]}" "$DIM" "$(mmss "$dur")" "$NC"
            else
                printf '  %b○  %s%b\n' "$DIM" "${PHASE_NAMES[i]}" "$NC"
            fi
        done
        frame=$((frame + 1))
        sleep 1
    done
    wait "$pid"; rc=$?
    elapsed=$((SECONDS - start))

    # Final repaint: everything green on success; a red mark where it stopped.
    printf '\033[6A'
    for ((i=0; i<6; i++)); do
        printf '\033[2K'
        if [ "$rc" -eq 0 ] || [ "$i" -lt "$cur" ]; then
            if [ "$i" -lt 5 ] && [ "${t[i+1]}" -gt 0 ]; then dur=$(( ${t[i+1]} - ${t[i]} )); else dur=$(( elapsed - ${t[i]} )); fi
            [ "$dur" -lt 0 ] && dur=0
            printf '  %b✓%b  %s  %b%s%b\n' "$GREEN" "$NC" "${PHASE_NAMES[i]}" "$DIM" "$(mmss "$dur")" "$NC"
        elif [ "$i" -eq "$cur" ] || { [ "$cur" -lt 0 ] && [ "$i" -eq 0 ]; }; then
            printf '  %b✗%b  %s\n' "$RED" "$NC" "${PHASE_NAMES[i]}"
        else
            printf '  %b○  %s%b\n' "$DIM" "${PHASE_NAMES[i]}" "$NC"
        fi
    done
    return "$rc"
}

step 6 "Deploy"
say "  Building your workspace on the server — the long part, usually 10–30"
say "  minutes. You can leave it running."
say "  ${DIM}Full build log: $CLIENT_DIR/deploy.log${NC}"
say ""

DEPLOY_LOG="$CLIENT_DIR/deploy.log"
run_deploy "$DEPLOY_LOG"
DEPLOY_RC=$?

if [ "$DEPLOY_RC" -ne 0 ]; then
    say ""
    err "The deploy stopped early (exit code $DEPLOY_RC)."
    say ""
    say "  ${DIM}Last lines of the build log ($DEPLOY_LOG):${NC}"
    tail -n 20 "$DEPLOY_LOG" 2>/dev/null | sed 's/^/    /'
    say ""
    say "  ${BOLD}Common causes:${NC}"
    say "    ${DIM}·${NC} SSH/permission denied → ${BOLD}ssh-copy-id $HETZNER_HOST${NC}, then test ${BOLD}ssh $HETZNER_HOST 'echo ok'${NC}"
    say "    ${DIM}·${NC} Docker missing on server → ${BOLD}ssh $HETZNER_HOST 'curl -fsSL https://get.docker.com | sh'${NC}"
    say "    ${DIM}·${NC} 'address already in use' → another stack owns 80/443; use a fresh server (one workspace per server)."
    say "    ${DIM}·${NC} TLS/cert errors → DNS for $FRONTEND_DOMAIN must point to $SERVER_HOST before deploy."
    say ""
    say "  Nothing is half-done. Fix the cause and re-run this installer — it"
    say "  picks up where it left off ${DIM}(or run ./$CLIENT_DIR/deploy.sh directly)${NC}."
    say "  ${DIM}More help: ${QUICK_START_URL}#troubleshooting${NC}"
    exit "$DEPLOY_RC"
fi

# =============================================================================
# Success
# =============================================================================
say ""; say ""
say "  ${GREEN}✓${NC} ${BOLD}Your workspace is ready.${NC}"
say ""
say "      ${BOLD}Open${NC}  ${ACCENT}https://$FRONTEND_DOMAIN${NC}"
say ""
say "      1. Sign in with ${BOLD}$ADMIN_EMAIL${NC} (Google)."
say "      2. A short setup follows — name your coworker, describe your company."
say "      3. It asks for a Claude token. Generate one on this computer with"
say "         ${DIM}npm install -g @anthropic-ai/claude-code && claude setup-token${NC}"
say "         and paste it into the setup."
say "      4. Then connect your tools from ${BOLD}Integrations${NC} in the sidebar."
say ""
say "  ${DIM}Full walkthrough: ${QUICK_START_URL}${NC}"
say "  ${DIM}To update later:  cd \"$REPO_ROOT\" && ./update.sh${NC}"
say ""
