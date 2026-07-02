#!/usr/bin/env bash
# =============================================================================
# ensure-server.sh — converge a client VPS to the desired baseline state
# =============================================================================
# Replaces the old "remember to run scripts/harden-server.sh once after the
# first deploy" model. deploy.sh runs this on EVERY deploy; each phase is an
# idempotent check-then-fix, so a fresh server gets fully prepared and an
# already-converged server is a fast no-op (a few seconds).
#
# Phases:
#   docker        install via get.docker.com if missing
#   ufw           allow 22/80/443, deny 8080/3002, enable
#   swap          2G swapfile — --no-cache builds OOM a 4GB box without it
#   fail2ban      sshd jail: 3 attempts → 24h ban
#   autoupdates   unattended-upgrades, security-only, no auto-reboot
#   sshd          key-only auth, no passwords, idle timeout
#   login-alerts  Telegram message on every SSH login (needs bot token)
#   backup        WARN-only: checks restic is configured, never configures it
#
# Usage:
#   bin/ensure-server.sh [--env-file <path>] [--json] [--strict]
#
# Config from the environment (client wrapper sourced .env) or --env-file:
#   HETZNER_HOST (required), TELEGRAM_BOT_TOKEN + TELEGRAM_ADMIN_CHAT_ID
#   (optional — enables login-alerts), IDE_NAME (optional — backup check).
#
# Never prompts. Safe to re-run any number of times (agent/CI safe).
#
# Exit codes (stable contract):
#   0  converged (phases ok/changed; warnings allowed unless --strict)
#   1  usage / config error
#   2  a phase failed — the detail says what and how to fix; safe to re-run
#
# --json prints one JSON object:
#   {"ok":bool,"phases":[{"name":..,"status":"ok|changed|warn|fail|skipped",
#     "detail":..}]}
# "changed" = this run fixed something; "ok" = nothing to do.
#
# SAFETY: sshd password-auth is disabled only in the same session that just
# authenticated with a key (BatchMode) — we can't lock ourselves out.
# =============================================================================

set -uo pipefail

JSON=0
STRICT=0
ENV_FILE=""

while [ $# -gt 0 ]; do
    case "$1" in
        --json)     JSON=1 ;;
        --strict)   STRICT=1 ;;
        --env-file) ENV_FILE="${2:-}"; shift ;;
        -h|--help)  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "ensure-server: unknown option '$1' (see --help)" >&2; exit 1 ;;
    esac
    shift
done

if [ -n "$ENV_FILE" ]; then
    [ -f "$ENV_FILE" ] || { echo "ensure-server: env file not found: $ENV_FILE" >&2; exit 1; }
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
fi

if [ -z "${HETZNER_HOST:-}" ]; then
    echo "ensure-server: HETZNER_HOST not set (source a client .env or use --env-file)" >&2
    exit 1
fi
if ! echo "$HETZNER_HOST" | grep -qE '^[a-zA-Z0-9_-]+@[a-zA-Z0-9._-]+$'; then
    echo "ensure-server: HETZNER_HOST has invalid format (expected user@host): $HETZNER_HOST" >&2
    exit 1
fi

SSH_CTRL="/tmp/wsdeploy-%h-%p-%r.sock"
SSH_BASE_OPTS="-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new \
 -o ControlMaster=auto -o ControlPath=$SSH_CTRL -o ControlPersist=10m"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
[ -t 1 ] || { RED=''; GREEN=''; YELLOW=''; CYAN=''; NC=''; }

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n\r\t'; }

# ─── Remote converge script ──────────────────────────────────────────────────
# One SSH session does everything and reports one line per phase:
#   ::phase <name> <ok|changed|warn|fail> <detail...>
# Secrets/config go in as env vars on the command line (printf %q), the
# heredoc itself is single-quoted so nothing expands locally.
# NOTE: output goes through a temp file, not $(...), because macOS bash 3.2
# mis-parses heredocs inside double-quoted command substitutions.
TMP_OUT="$(mktemp "${TMPDIR:-/tmp}/ensure-server.XXXXXX")"
trap 'rm -f "$TMP_OUT"' EXIT
# NO -n here: the remote script arrives via stdin (heredoc). With -n, stdin
# is /dev/null, remote `bash -s` reads EOF, does NOTHING and exits 0 — a
# silent full-converge skip (caught on the first canary run, 2026-07-02).
# shellcheck disable=SC2086
ssh $SSH_BASE_OPTS "$HETZNER_HOST" \
    "_TB=$(printf '%q' "${TELEGRAM_BOT_TOKEN:-}") \
     _TC=$(printf '%q' "${TELEGRAM_ADMIN_CHAT_ID:-}") \
     _IDE=$(printf '%q' "${IDE_NAME:-}") \
     bash -s" >"$TMP_OUT" 2>&1 <<'REMOTE'
set -u
export DEBIAN_FRONTEND=noninteractive
APT_UPDATED=0
apt_install() {  # install packages, running apt-get update once, lazily
    if [ "$APT_UPDATED" -eq 0 ]; then apt-get update -qq >/dev/null 2>&1; APT_UPDATED=1; fi
    apt-get install -y -qq "$@" >/dev/null 2>&1
}

# --- docker ---
if command -v docker >/dev/null 2>&1; then
    echo "::phase docker ok $(docker --version 2>/dev/null | head -c 60)"
else
    if curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 && command -v docker >/dev/null 2>&1; then
        echo "::phase docker changed installed $(docker --version 2>/dev/null | head -c 60)"
    else
        echo "::phase docker fail install failed — run manually: curl -fsSL https://get.docker.com | sh"
    fi
fi

# --- ufw ---
if ! command -v ufw >/dev/null 2>&1; then
    apt_install ufw || true
fi
if command -v ufw >/dev/null 2>&1; then
    UFW_STATUS="$(ufw status 2>/dev/null)"
    if echo "$UFW_STATUS" | grep -q "Status: active" \
       && echo "$UFW_STATUS" | grep -q "80/tcp" \
       && echo "$UFW_STATUS" | grep -q "443/tcp" \
       && echo "$UFW_STATUS" | grep -q "22/tcp"; then
        echo "::phase ufw ok active, 22/80/443 allowed"
    else
        ufw allow 22/tcp >/dev/null 2>&1
        ufw allow 80/tcp >/dev/null 2>&1
        ufw allow 443/tcp >/dev/null 2>&1
        ufw deny 8080 >/dev/null 2>&1
        ufw deny 3002 >/dev/null 2>&1
        if ufw --force enable >/dev/null 2>&1; then
            echo "::phase ufw changed enabled with 22/80/443 allow, 8080/3002 deny"
        else
            echo "::phase ufw fail could not enable ufw — check 'ufw status' on the server"
        fi
    fi
else
    echo "::phase ufw fail ufw not installable — configure the firewall manually"
fi

# --- swap (2G — --no-cache builds OOM a 4GB box while the stack runs) ---
if swapon --show --noheadings 2>/dev/null | grep -q .; then
    echo "::phase swap ok $(swapon --show=NAME,SIZE --noheadings 2>/dev/null | head -1 | tr -s ' ')"
else
    if [ ! -f /swapfile ]; then
        fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
        chmod 600 /swapfile
        mkswap /swapfile >/dev/null 2>&1
    fi
    if swapon /swapfile 2>/dev/null; then
        grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
        echo "::phase swap changed 2G swapfile created and enabled"
    else
        echo "::phase swap fail could not enable /swapfile — builds may OOM; check 'swapon /swapfile' manually"
    fi
fi

# --- fail2ban ---
F2B_JAIL='[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5
backend  = systemd

[sshd]
enabled  = true
port     = ssh
maxretry = 3
bantime  = 86400'
if ! command -v fail2ban-client >/dev/null 2>&1; then
    apt_install fail2ban || true
fi
if command -v fail2ban-client >/dev/null 2>&1; then
    if [ -f /etc/fail2ban/jail.local ] && printf '%s\n' "$F2B_JAIL" | cmp -s - /etc/fail2ban/jail.local \
       && systemctl is-active fail2ban >/dev/null 2>&1; then
        echo "::phase fail2ban ok sshd jail active (3 attempts → 24h ban)"
    else
        printf '%s\n' "$F2B_JAIL" > /etc/fail2ban/jail.local
        systemctl enable fail2ban >/dev/null 2>&1
        if systemctl restart fail2ban >/dev/null 2>&1; then
            echo "::phase fail2ban changed installed + sshd jail active"
        else
            echo "::phase fail2ban fail service won't start — check 'journalctl -u fail2ban'"
        fi
    fi
else
    echo "::phase fail2ban fail package install failed — apt-get install fail2ban manually"
fi

# --- autoupdates (security-only, no auto-reboot) ---
AU_50='Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
};
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::MinimalSteps "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";'
AU_20='APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";'
if ! dpkg -s unattended-upgrades >/dev/null 2>&1; then
    apt_install unattended-upgrades apt-listchanges || true
fi
if dpkg -s unattended-upgrades >/dev/null 2>&1; then
    if printf '%s\n' "$AU_50" | cmp -s - /etc/apt/apt.conf.d/50unattended-upgrades 2>/dev/null \
       && printf '%s\n' "$AU_20" | cmp -s - /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null; then
        echo "::phase autoupdates ok security patches automatic"
    else
        printf '%s\n' "$AU_50" > /etc/apt/apt.conf.d/50unattended-upgrades
        printf '%s\n' "$AU_20" > /etc/apt/apt.conf.d/20auto-upgrades
        systemctl enable unattended-upgrades >/dev/null 2>&1
        systemctl restart unattended-upgrades >/dev/null 2>&1
        echo "::phase autoupdates changed security-only unattended upgrades enabled"
    fi
else
    echo "::phase autoupdates fail unattended-upgrades install failed"
fi

# --- sshd (key-only; safe: this session just authenticated with a key) ---
SSHD_CONFIG="/etc/ssh/sshd_config"
SSHD_CHANGED=0
apply_setting() {
    local key="$1" value="$2" tkey current
    # Effective-value check via sshd -T (lowercased keys) — only rewrite when
    # the daemon's actual behavior differs, not merely the config text.
    # OpenSSH ≥8.7 renamed ChallengeResponseAuthentication in -T output.
    tkey="$(echo "$key" | tr 'A-Z' 'a-z')"
    [ "$tkey" = "challengeresponseauthentication" ] && tkey="kbdinteractiveauthentication"
    current="$(sshd -T 2>/dev/null | awk -v k="$tkey" '$1==k {print $2; exit}')"
    # sshd -T prints the legacy synonym for prohibit-password.
    [ "$current" = "without-password" ] && current="prohibit-password"
    if [ "$current" = "$(echo "$value" | tr 'A-Z' 'a-z')" ]; then return 0; fi
    # First modification this run → keep a restore point.
    [ "$SSHD_CHANGED" -eq 0 ] && cp -a "$SSHD_CONFIG" "${SSHD_CONFIG}.ensure-bak"
    if grep -qE "^\s*#?\s*${key}\s" "$SSHD_CONFIG"; then
        sed -i "s/^\s*#\?\s*${key}\s.*/${key} ${value}/" "$SSHD_CONFIG"
    else
        echo "${key} ${value}" >> "$SSHD_CONFIG"
    fi
    SSHD_CHANGED=1
}
apply_setting "PasswordAuthentication"          "no"
apply_setting "PermitRootLogin"                 "prohibit-password"
apply_setting "ChallengeResponseAuthentication" "no"
apply_setting "UsePAM"                          "yes"
apply_setting "ClientAliveInterval"             "120"
apply_setting "ClientAliveCountMax"             "5"
if [ "$SSHD_CHANGED" -eq 1 ]; then
    if ! sshd -t 2>/dev/null; then
        # Invalid result must never stay on disk (a reboot would lock us out).
        cp -a "${SSHD_CONFIG}.ensure-bak" "$SSHD_CONFIG"
        echo "::phase sshd fail new config failed sshd -t — previous sshd_config restored, nothing applied"
    # Debian/Ubuntu name the unit ssh.service, RHEL-likes sshd.service — try
    # both. reload-or-restart re-reads config without dropping live sessions.
    elif systemctl reload-or-restart ssh >/dev/null 2>&1 \
      || systemctl reload-or-restart sshd >/dev/null 2>&1; then
        rm -f "${SSHD_CONFIG}.ensure-bak"
        echo "::phase sshd changed key-only auth enforced, idle timeout set"
    else
        echo "::phase sshd fail config written and valid but ssh service reload failed — run 'systemctl reload ssh' on the server"
    fi
else
    echo "::phase sshd ok key-only auth already enforced"
fi

# --- login-alerts (Telegram on every SSH login; optional) ---
if [ -n "$_TB" ] && [ -n "$_TC" ]; then
    NOTIFY=/usr/local/bin/ssh-login-notify.sh
    HOSTLABEL="$(hostname)"
    DESIRED="#!/bin/bash
[ \"\$PAM_TYPE\" != \"open_session\" ] && exit 0
BOT_TOKEN=\"$_TB\"
CHAT_ID=\"$_TC\"
HOSTNAME=\"$HOSTLABEL\"
MSG=\"🔐 SSH LOGIN
Host: \${HOSTNAME}
User: \$PAM_USER
From: \$PAM_RHOST
Time: \$(date '+%Y-%m-%d %H:%M:%S %Z')\"
curl -s -X POST \"https://api.telegram.org/bot\${BOT_TOKEN}/sendMessage\" \\
  --data-urlencode \"chat_id=\${CHAT_ID}\" \\
  --data-urlencode \"text=\${MSG}\" \\
  > /dev/null 2>&1 &"
    if [ -f "$NOTIFY" ] && printf '%s\n' "$DESIRED" | cmp -s - "$NOTIFY" \
       && grep -q "ssh-login-notify" /etc/pam.d/sshd 2>/dev/null; then
        echo "::phase login-alerts ok Telegram alert wired into PAM"
    else
        printf '%s\n' "$DESIRED" > "$NOTIFY"
        chmod 700 "$NOTIFY"
        if ! grep -q "ssh-login-notify" /etc/pam.d/sshd 2>/dev/null; then
            echo "session optional pam_exec.so $NOTIFY" >> /etc/pam.d/sshd
        fi
        echo "::phase login-alerts changed Telegram alert on every SSH login"
    fi
else
    echo "::phase login-alerts warn skipped — set TELEGRAM_BOT_TOKEN + TELEGRAM_ADMIN_CHAT_ID in .env to enable"
fi

# --- backup (check only — configuring restic needs operator secrets) ---
RESTIC_ENV="${RESTIC_ENV_FILE:-/root/.workspace-admin/restic.env}"
if [ -f "$RESTIC_ENV" ] && { crontab -l 2>/dev/null | grep -q restic-backup || ls /etc/cron.d/ 2>/dev/null | grep -q restic; }; then
    echo "::phase backup ok restic configured + scheduled"
else
    echo "::phase backup warn restic backups not configured on this host — see ide-template/scripts/restic-backup.sh (data on this VPS is otherwise unrecoverable)"
fi
REMOTE
SSH_RC=$?
REMOTE_OUT="$(cat "$TMP_OUT")"

if [ $SSH_RC -ne 0 ] && ! printf '%s\n' "$REMOTE_OUT" | grep -q '^::phase '; then
    if [ "$JSON" -eq 1 ]; then
        printf '{"ok":false,"phases":[{"name":"ssh","status":"fail","detail":"%s"}]}\n' \
            "$(json_escape "cannot reach $HETZNER_HOST: $REMOTE_OUT")"
    else
        printf "${RED}ensure-server: cannot reach %s over SSH${NC}\n%s\n" "$HETZNER_HOST" "$REMOTE_OUT" >&2
    fi
    exit 2
fi

# ─── Parse + report ──────────────────────────────────────────────────────────
NAMES=(); STATUSES=(); DETAILS=()
HAS_FAIL=0; HAS_WARN=0
while IFS= read -r line; do
    case "$line" in
        ::phase\ *)
            rest="${line#::phase }"
            name="${rest%% *}"; rest="${rest#* }"
            status="${rest%% *}"; detail="${rest#* }"
            [ "$detail" = "$status" ] && detail=""
            NAMES+=("$name"); STATUSES+=("$status"); DETAILS+=("$detail")
            case "$status" in
                fail) HAS_FAIL=1 ;;
                warn) HAS_WARN=1 ;;
            esac
            ;;
    esac
done <<< "$REMOTE_OUT"

# Zero phases parsed = the remote script never ran (transport problem) —
# NEVER report that as success.
if [ ${#NAMES[@]} -eq 0 ]; then
    if [ "$JSON" -eq 1 ]; then
        printf '{"ok":false,"phases":[{"name":"transport","status":"fail","detail":"%s"}]}\n' \
            "$(json_escape "remote script produced no phase output (ssh rc=$SSH_RC): $(printf '%s' "$REMOTE_OUT" | head -c 300)")"
    else
        printf "${RED}ensure-server: remote script produced no phase output (ssh rc=%s) — converge did NOT run.${NC}\n" "$SSH_RC" >&2
        printf '%s\n' "$REMOTE_OUT" | head -5 >&2
    fi
    exit 2
fi

OK=1
[ "$HAS_FAIL" -eq 1 ] && OK=0
[ "$STRICT" -eq 1 ] && [ "$HAS_WARN" -eq 1 ] && OK=0

if [ "$JSON" -eq 1 ]; then
    out='{"ok":'
    [ "$OK" -eq 1 ] && out+='true' || out+='false'
    out+=',"phases":['
    for i in "${!NAMES[@]}"; do
        [ "$i" -gt 0 ] && out+=','
        out+="{\"name\":\"${NAMES[$i]}\",\"status\":\"${STATUSES[$i]}\",\"detail\":\"$(json_escape "${DETAILS[$i]}")\"}"
    done
    out+=']}'
    printf '%s\n' "$out"
else
    for i in "${!NAMES[@]}"; do
        case "${STATUSES[$i]}" in
            ok)      printf "${GREEN}  ✓ %-12s${NC} %s\n" "${NAMES[$i]}" "${DETAILS[$i]}" ;;
            changed) printf "${CYAN}  + %-12s${NC} %s\n" "${NAMES[$i]}" "${DETAILS[$i]}" ;;
            warn)    printf "${YELLOW}  ⚠ %-12s${NC} %s\n" "${NAMES[$i]}" "${DETAILS[$i]}" ;;
            fail)    printf "${RED}  ✗ %-12s${NC} %s\n" "${NAMES[$i]}" "${DETAILS[$i]}" ;;
        esac
    done
    echo ""
    if [ "$OK" -eq 1 ]; then
        printf "${GREEN}Server converged${NC}\n"
    else
        printf "${RED}Server converge FAILED — fix the ✗ phases above and re-run (idempotent).${NC}\n"
    fi
fi

[ "$OK" -eq 1 ] && exit 0 || exit 2
