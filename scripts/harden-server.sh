#!/bin/bash
# =============================================================================
# Server Hardening Script
# Run once per Hetzner server after initial deploy.
#
# What it does:
#   1. Verifies SSH key auth works before touching anything
#   2. Installs + configures fail2ban (auto-bans brute force)
#   3. Sets up SSH login notifications via Telegram
#   4. Disables SSH password authentication (keys only)
#
# Usage (from client directory):
#   cd clients/example-ide
#   ../../scripts/harden-server.sh
#
# Or with explicit args:
#   ../../scripts/harden-server.sh root@203.0.113.10 7841234567:AAFxxx 123456789
# =============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# --- Load config ---
HETZNER_HOST="${1:-}"
BOT_TOKEN="${2:-}"
CHAT_ID="${3:-}"

if [ -z "$HETZNER_HOST" ] && [ -f .env ]; then
    set -a; source .env; set +a
    HETZNER_HOST="${HETZNER_HOST:-}"
    BOT_TOKEN="${BOT_TOKEN:-$TELEGRAM_BOT_TOKEN}"
    CHAT_ID="${CHAT_ID:-$TELEGRAM_ADMIN_CHAT_ID}"
fi

if [ -z "$HETZNER_HOST" ]; then
    echo -e "${RED}ERROR: HETZNER_HOST not set. Run from a client directory or pass as argument.${NC}"
    echo "Usage: $0 [root@SERVER_IP] [BOT_TOKEN] [CHAT_ID]"
    exit 1
fi

echo -e "${GREEN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Server Hardening — ${HETZNER_HOST}${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════╝${NC}"
echo ""

# --- Step 1: Verify SSH key works BEFORE disabling passwords ---
echo -e "${CYAN}[1/4] Verifying SSH key authentication...${NC}"

if ! ssh -o PasswordAuthentication=no \
        -o BatchMode=yes \
        -o ConnectTimeout=10 \
        "$HETZNER_HOST" "echo ok" > /dev/null 2>&1; then
    echo -e "${RED}ERROR: SSH key authentication failed.${NC}"
    echo -e "${RED}Your key is not configured on this server.${NC}"
    echo ""
    echo "Fix: copy your key to the server first:"
    echo "  ssh-copy-id $HETZNER_HOST"
    echo ""
    echo -e "${RED}Aborting — passwords NOT disabled. Server unchanged.${NC}"
    exit 1
fi

echo -e "${GREEN}SSH key auth works. Safe to proceed.${NC}"
echo ""

# --- Step 2: Install fail2ban + automatic security updates ---
echo -e "${CYAN}[2/4] Installing fail2ban + unattended-upgrades...${NC}"

ssh "$HETZNER_HOST" bash << 'REMOTE'
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq fail2ban unattended-upgrades apt-listchanges

# fail2ban config
cat > /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5
backend  = systemd

[sshd]
enabled  = true
port     = ssh
maxretry = 3
bantime  = 86400
EOF

systemctl enable fail2ban
systemctl restart fail2ban
echo "[harden] fail2ban installed and running"
fail2ban-client status sshd 2>/dev/null || true

# Automatic security patches — security updates only, not all upgrades
cat > /etc/apt/apt.conf.d/50unattended-upgrades << 'EOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
};
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::MinimalSteps "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
EOF

cat > /etc/apt/apt.conf.d/20auto-upgrades << 'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

systemctl enable unattended-upgrades
systemctl restart unattended-upgrades
echo "[harden] Automatic security patches enabled"
REMOTE

echo -e "${GREEN}fail2ban configured (3 attempts → 24h ban)${NC}"
echo -e "${GREEN}Automatic security patches enabled (security-only, no auto-reboot)${NC}"
echo ""

# --- Step 3: SSH login Telegram notifications ---
echo -e "${CYAN}[3/4] Setting up SSH login notifications...${NC}"

if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ]; then
    echo -e "${YELLOW}SKIPPED: TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID not set.${NC}"
    echo "Set them in .env or pass as arguments to enable login alerts."
else
    HOSTNAME=$(ssh "$HETZNER_HOST" hostname)

    ssh "$HETZNER_HOST" bash << REMOTE
set -e

cat > /usr/local/bin/ssh-login-notify.sh << 'EOF'
#!/bin/bash
[ "\$PAM_TYPE" != "open_session" ] && exit 0
BOT_TOKEN="${BOT_TOKEN}"
CHAT_ID="${CHAT_ID}"
HOSTNAME="${HOSTNAME}"
MSG="🔐 SSH LOGIN
Host: \${HOSTNAME}
User: \$PAM_USER
From: \$PAM_RHOST
Time: \$(date '+%Y-%m-%d %H:%M:%S %Z')"
curl -s -X POST "https://api.telegram.org/bot\${BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=\${CHAT_ID}" \
  --data-urlencode "text=\${MSG}" \
  > /dev/null 2>&1 &
EOF

chmod 700 /usr/local/bin/ssh-login-notify.sh

# Add to PAM if not already there
if ! grep -q "ssh-login-notify" /etc/pam.d/sshd; then
    echo "session optional pam_exec.so /usr/local/bin/ssh-login-notify.sh" \
        >> /etc/pam.d/sshd
fi

echo "[harden] SSH login notifications configured"
REMOTE

    echo -e "${GREEN}Telegram alerts active — you'll get a message on every SSH login${NC}"

    # Send test notification
    echo -e "${CYAN}Sending test notification...${NC}"
    TEST_MSG="✅ SSH hardening complete on ${HOSTNAME}. Login alerts are active."
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        --data-urlencode "chat_id=${CHAT_ID}" \
        --data-urlencode "text=${TEST_MSG}" > /dev/null 2>&1
    echo -e "${GREEN}Test notification sent to Telegram${NC}"
fi

echo ""

# --- Step 4: Disable password authentication ---
echo -e "${CYAN}[4/4] Disabling SSH password authentication (keys only)...${NC}"

ssh "$HETZNER_HOST" bash << 'REMOTE'
set -e

SSHD_CONFIG="/etc/ssh/sshd_config"

# Apply settings — overwrite existing lines or append
apply_setting() {
    local key="$1"
    local value="$2"
    if grep -qE "^\s*#?\s*${key}\s" "$SSHD_CONFIG"; then
        sed -i "s/^\s*#\?\s*${key}\s.*/${key} ${value}/" "$SSHD_CONFIG"
    else
        echo "${key} ${value}" >> "$SSHD_CONFIG"
    fi
}

apply_setting "PasswordAuthentication"         "no"
apply_setting "PermitRootLogin"               "prohibit-password"
apply_setting "ChallengeResponseAuthentication" "no"
apply_setting "UsePAM"                        "yes"
# Close idle SSH sessions after 10 minutes of inactivity
apply_setting "ClientAliveInterval"           "120"
apply_setting "ClientAliveCountMax"           "5"

# Validate config before restarting
sshd -t
systemctl restart sshd

echo "[harden] SSH password authentication disabled"
REMOTE

echo -e "${GREEN}Password auth disabled. Only SSH keys accepted.${NC}"
echo ""

# --- Done ---
echo -e "${GREEN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Hardening complete!                           ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${CYAN}What was applied:${NC}"
echo "  ✅ fail2ban — 3 failed attempts = 24h ban"
echo "  ✅ SSH keys only — password login disabled"
echo "  ✅ Automatic security patches (unattended-upgrades, security-only)"
echo "  ✅ SSH idle timeout — session closes after ~10 min of inactivity"
if [ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ]; then
    echo "  ✅ Telegram alert on every SSH login"
else
    echo "  ⚠️  Telegram alerts skipped (no token/chat_id)"
fi
echo ""
echo -e "${YELLOW}What this does NOT protect against:${NC}"
echo "  ⚠️  Stolen SSH private key — keep your laptop secure"
echo "      (Telegram alert will fire, but attacker is already in)"
echo ""
echo -e "${CYAN}Check fail2ban status anytime:${NC}"
echo "  ssh $HETZNER_HOST 'fail2ban-client status sshd'"
echo ""
echo -e "${CYAN}Check banned IPs:${NC}"
echo "  ssh $HETZNER_HOST 'fail2ban-client get sshd banip'"
