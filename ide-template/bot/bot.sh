#!/bin/bash
# Simplified Claude Code Bot Script + TTY Support
# Runs Claude in tmux to provide a PTY, avoiding the 'Trust this folder' hang.

set -e

BOT_NAME="${BOT_NAME:-bot}"
PROJECT_DIR="/home/coder/project"
# Phase-3 (H4 closure): bot's home is /home/bot (uid 1003), NOT /home/coder.
# The Claude OAuth token + integrations.env live under /home/bot/ with
# group=botshare so coder uid 1000 cannot read them. This script is
# invoked via /usr/local/bin/bot-runner which sets HOME=/home/bot and
# drops to uid 1003 before exec'ing here.
BOT_HOME="${HOME:-/home/bot}"
PER_BOT_DIR="${BOT_HOME}/.${BOT_NAME}"
CLAUDE_CONFIG_DIR="${BOT_HOME}/.claude"
NOTIFY_SCRIPT="/home/coder/bot-notify.sh"
SESSION="${BOT_NAME}"

# Source UI-managed integration credentials BEFORE we read $TELEGRAM_BOT_TOKEN
# below. workspace-api writes this file (mode 0640 group=botshare) when the
# user activates Telegram via the Integrations dashboard. If the file isn't
# there we fall through to the legacy env vars set by docker-compose / .env.
INTEGRATIONS_ENV="${PER_BOT_DIR}/integrations.env"
if [ -f "$INTEGRATIONS_ENV" ]; then
    set -a; . "$INTEGRATIONS_ENV"; set +a
fi

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }
notify() { if [ -x "$NOTIFY_SCRIPT" ]; then "$NOTIFY_SCRIPT" "$1" 2>/dev/null; fi; }

# 1. Bot config setup. After Phase-3, the credential file is written
#    directly into ${CLAUDE_CONFIG_DIR}/.credentials.json by workspace-api;
#    we don't have to copy it from /home/coder anymore.
mkdir -p "$PER_BOT_DIR" "$CLAUDE_CONFIG_DIR"

# Restart-signal file. wsapi (uid 1001, group=botshare) writes (touches
# mtime); a background watcher started below polls and kills tmux when it
# changes, which makes the monitor loop at the end of this script exit and
# PM2 cycle the bot. Replaces the Telegram-`/restart` signal which only
# worked when the running bot had valid TG creds matching the message
# (so it broke on fresh activations, token rotations, and any setup-token
# change before TG was configured). Same `botshare` group model as
# integrations.env — already proven, no new privilege boundary.
RESTART_SIGNAL_FILE="${PER_BOT_DIR}/restart-signal"
touch "$RESTART_SIGNAL_FILE" 2>/dev/null || true
chmod 660 "$RESTART_SIGNAL_FILE" 2>/dev/null || true
chgrp botshare "$RESTART_SIGNAL_FILE" 2>/dev/null || true
RESTART_SIGNAL_BASELINE=$(stat -c %Y "$RESTART_SIGNAL_FILE" 2>/dev/null || echo 0)

# Telegram conversation log dir. The plugin (after bot.sh Patch 4 lands)
# appends every inbound + outbound message here. workspace-api's
# recent-snapshot-monitor reads it to build memory/RECENT_TELEGRAM.md.
# Setgid+botshare so the log file inherits group=botshare on creation,
# letting wsapi (also in botshare) read what bot wrote.
TELEGRAM_LOG_DIR="$BOT_HOME/.telegram"
if [ ! -d "$TELEGRAM_LOG_DIR" ]; then
    mkdir -p "$TELEGRAM_LOG_DIR"
    chgrp botshare "$TELEGRAM_LOG_DIR" 2>/dev/null || true
    chmod 2770    "$TELEGRAM_LOG_DIR" 2>/dev/null || true  # setgid → files inherit group
fi

# /home/coder/.claude/ still holds the IDE's claude config (skills,
# settings.json, plugins, marketplaces). bot reads from there for those
# non-secret pieces, then overlays them under /home/bot/.claude/. We
# copy WITHOUT overwriting the .credentials.json that workspace-api
# already wrote (wsapi-hydrated, group=botshare).
if [ -d "/home/coder/.claude" ]; then
    log "Overlaying /home/coder/.claude/ → $CLAUDE_CONFIG_DIR (skipping .credentials.json + sessions)"
    chmod -R u+w "$CLAUDE_CONFIG_DIR" 2>/dev/null || true
    # Use `tar | tar` to preserve dir structure with intermediate path
    # creation (the previous cpio -p approach was missing -d, so files
    # like plugins/marketplaces/... silently dropped because cpio refused
    # to create the intermediate `plugins/` dir, leaving the bot without
    # marketplace metadata → `claude plugins install` fails → crashloop.)
    # tar's --exclude handles credentials.json + sessions cleanly.
    if (cd /home/coder/.claude && \
        tar --exclude=./.credentials.json \
            --exclude=./.credentials.json.migrated.bak \
            --exclude=./sessions \
            --exclude=./plugins/installed_plugins.json \
            --exclude=./plugins/known_marketplaces.json \
            --warning=no-file-changed \
            --warning=no-file-removed \
            -cf - . 2>/dev/null) | \
       (cd "$CLAUDE_CONFIG_DIR" && tar -xf - --no-same-owner 2>/dev/null); then
        log "Overlay copy succeeded"
    else
        log "WARN: overlay copy partial — bot may be missing skills/plugins/marketplaces"
    fi
    # installed_plugins.json + known_marketplaces.json are deliberately
    # excluded from the overlay above — entrypoint.sh root-block wrote
    # them with /home/bot paths, and the /home/coder copies would have
    # /home/coder paths that confuse claude's plugin engine ("corrupted
    # installLocation"). Caught during 2026-05-11 incident: overlay
    # silently regressed plugin paths at every restart.
fi
# Top-level .claude.json (hasCompletedOnboarding flag etc., NO secrets)
# — copy from coder if we don't have one yet.
if [ -f "/home/coder/.claude.json" ] && [ ! -f "$BOT_HOME/.claude.json" ]; then
    log "Seeding .claude.json from /home/coder/.claude.json"
    cp -p "/home/coder/.claude.json" "$BOT_HOME/.claude.json" 2>/dev/null || true
fi

if [ ! -f "$CLAUDE_CONFIG_DIR/.credentials.json" ]; then
    log "ERROR: $CLAUDE_CONFIG_DIR/.credentials.json missing. workspace-api should have hydrated it from the encrypted store. Check setup wizard."
    notify "Cannot start — Claude credentials missing."
    exit 1
fi

# 2. Provision Telegram Token (always overwrite to ensure env updates apply)
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
    mkdir -p "$CLAUDE_CONFIG_DIR/channels/telegram"
    echo "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN" > "$CLAUDE_CONFIG_DIR/channels/telegram/.env"
    # Mode 0640 + group=botshare so wsapi (also in botshare) can read it for
    # /api/bot/restart. Owner stays bot uid — only wsapi gains read.
    chmod 640 "$CLAUDE_CONFIG_DIR/channels/telegram/.env"
    chgrp botshare "$CLAUDE_CONFIG_DIR/channels/telegram/.env" 2>/dev/null || true

    # IDs must be JSON strings, not numbers. Admin is auto-added to allowFrom
    # so the operator who configured the bot doesn't have to go through the
    # `/telegram:access pair <code>` skill flow on first DM — that flow is a
    # prompt-injection guard for inviting *others*, not for the operator.
    ALL_IDS="${TELEGRAM_ADMIN_CHAT_ID:-},${TELEGRAM_ALLOWED_IDS:-}"
    IDS_JSON=$(echo "$ALL_IDS" | tr ',' '\n' | grep -v '^$' | awk '!seen[$0]++' \
               | sed 's/^/"/;s/$/"/' | paste -sd ',' -)
    # Seed access.json's groups{} from the GROUP registry (.team-config.json), so
    # the plugin's outbound gate (assertAllowedChat → access.groups) lets the
    # operator brain REPLY into a group the bot is in, from a DM. Patch 4f still
    # diverts inbound group messages to the watcher; this only opens the OUTBOUND
    # path for already-registered groups. Re-seeded on every bot start (a group
    # add/remove triggers a restart via syncTelegramGroups).
    GROUPS_JSON=$(python3 -c "
import json, sys
try:
    cfg = json.load(open('${PROJECT_DIR}/.team-config.json'))
    g = cfg.get('groups', {}) or {}
    out = {gid: {'requireMention': bool(v.get('requireMention', False)), 'allowFrom': []}
           for gid, v in g.items() if isinstance(v, dict)}
    sys.stdout.write(json.dumps(out))
except Exception:
    sys.stdout.write('{}')
" 2>/dev/null)
    [ -z "$GROUPS_JSON" ] && GROUPS_JSON='{}'
    # dmPolicy "allowlist", NOT the plugin default "pairing": access is managed
    # from the workspace UI (team roster → TELEGRAM_ALLOWED_IDS → allowFrom), so
    # the pairing prompt ("run /telegram:access pair …" — an operator-side Claude
    # Code command) would only ever reach STRANGERS and roster members whose id
    # isn't linked yet; both should get silence, not instructions they can't use.
    cat > "$CLAUDE_CONFIG_DIR/channels/telegram/access.json" <<EOF
{
  "dmPolicy": "allowlist",
  "allowFrom": [${IDS_JSON}],
  "groups": ${GROUPS_JSON},
  "pending": {}
}
EOF
fi

# 3. Environment Setup
export HOME="$BOT_HOME"
export PATH="/home/coder/.bun/bin:/home/coder/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# 4. Start Claude in tmux (provides PTY)
log "Cleaning up old sessions..."
pkill -f "bun server.ts" 2>/dev/null || true
tmux -L "$SESSION" kill-server 2>/dev/null || true
sleep 1

# 4b. Enable Telegram plugin (metadata flag).
#
# We do NOT call `claude plugins install` here. The plugin source +
# marketplace metadata are baked into the image at build time
# (Dockerfile LAYER 2b.5 clones anthropics/claude-plugins-official
# into /opt/ide/plugins-src and bun-installs deps), then
# entrypoint.sh root-block materializes them into
# /home/bot/.claude/plugins/{cache,marketplaces}/ with installed_plugins.json
# pointing at /home/bot paths. `enable` is a metadata flip with no
# network access — keeps github.com OUT of the runtime egress
# allow-list, and avoids the "Plugin not found in marketplace" error
# that caused 2026-05-11 to silently break Telegram for hours.
# Self-heal: if the Telegram plugin tree is missing (e.g. operator deleted
# /home/bot/.claude/plugins/... by hand during debugging, or a partial
# download left server.ts absent), restore it from the image's read-only
# staging at /opt/ide/plugins-src. entrypoint.sh's root-block does this on
# container start, but a `pm2 restart bot` after manual surgery won't
# re-run it — and the bot would silently come up without a working plugin.
# Caught 2026-05-22 during the Reviewer rollout.
PLUGIN_SRC="/opt/ide/plugins-src/external_plugins/telegram"
PLUGIN_MARKETPLACES_DST="$BOT_HOME/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram"
PLUGIN_CACHE_DST_BASE="$BOT_HOME/.claude/plugins/cache/claude-plugins-official/telegram"
if [ -f "$PLUGIN_SRC/server.ts" ]; then
    if [ ! -f "$PLUGIN_MARKETPLACES_DST/server.ts" ]; then
        log "Telegram plugin missing in marketplaces/ — restoring from $PLUGIN_SRC"
        mkdir -p "$PLUGIN_MARKETPLACES_DST"
        cp -r "$PLUGIN_SRC/." "$PLUGIN_MARKETPLACES_DST/"
    fi
    # Cache dir is versioned (e.g. .../0.0.6/server.ts) — pick the most
    # recent existing version dir, or fall back to copying into one named
    # after package.json's version if no version dir exists yet.
    CACHE_VERSION_DIR=$(ls -td "$PLUGIN_CACHE_DST_BASE"/*/ 2>/dev/null | head -1 | sed 's:/$::')
    if [ -z "$CACHE_VERSION_DIR" ]; then
        PLUGIN_VER=$(grep -oE '"version"[^"]*"[^"]+"' "$PLUGIN_SRC/package.json" 2>/dev/null \
                     | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
        [ -z "$PLUGIN_VER" ] && PLUGIN_VER=0.0.6
        CACHE_VERSION_DIR="$PLUGIN_CACHE_DST_BASE/$PLUGIN_VER"
        mkdir -p "$CACHE_VERSION_DIR"
    fi
    if [ ! -f "$CACHE_VERSION_DIR/server.ts" ]; then
        log "Telegram plugin missing in cache/ — restoring server.ts to $CACHE_VERSION_DIR"
        cp "$PLUGIN_SRC/server.ts" "$CACHE_VERSION_DIR/server.ts"
    fi
fi

log "Enabling Telegram plugin..."
HOME="$BOT_HOME" claude plugins enable telegram@claude-plugins-official 2>/dev/null || true
pkill -f "bun server.ts" 2>/dev/null || true

# ── Settings.json merge from bootstrap (source of truth for hooks) ─────
# `claude plugins enable` (above) + `--dangerously-skip-permissions`
# (in tmux below) regenerate $BOT_HOME/.claude/settings.json down to a
# 120-byte stub containing only {enabledPlugins,
# skipDangerousModePermissionPrompt} — they wipe the hooks block +
# autoMemoryEnabled:false. Without restoring these, on the Telegram side
# both Stop hooks (verify-denials + verify-telegram-reply) NEVER fire,
# and CC's native auto-memory may run alongside project memory/.
# Caught 2026-06-04 on canary: web side (wsapi reading /home/coder/.claude/
# settings.json) had the hooks; bot side was the asymmetry.
#
# Source = /opt/ide/bootstrap/claude-settings.json (world-readable, baked
# into the image). Earlier iteration tried to read from /home/coder/.claude/
# settings.json — that file is mode 0600 owned by coder, bot user could not
# read it and jq failed silently with permission denied. Bootstrap path is
# both the original source-of-truth AND readable by the bot user.
#
# Order: existing bot stub first (preserves CC-managed keys like
# enabledPlugins), template second (template keys win on overlap).
merge_bot_settings() {
    local label="$1"
    [ -f /opt/ide/bootstrap/claude-settings.json ] || return 1
    command -v jq >/dev/null 2>&1 || return 1
    local TMP
    TMP=$(mktemp 2>/dev/null) || return 1
    local base="$BOT_HOME/.claude/settings.json"
    [ -f "$base" ] || base=/opt/ide/bootstrap/claude-settings.json
    if jq -s '.[0] * .[1]' "$base" /opt/ide/bootstrap/claude-settings.json > "$TMP" 2>/dev/null; then
        mv "$TMP" "$BOT_HOME/.claude/settings.json"
        chmod 644 "$BOT_HOME/.claude/settings.json" 2>/dev/null
        log "Bot settings.json merged from bootstrap ($label) — $(wc -c < "$BOT_HOME/.claude/settings.json") bytes"
        return 0
    fi
    rm -f "$TMP"
    log "WARN: settings.json merge failed ($label) — bot may have inactive hooks"
    return 1
}

merge_bot_settings "post-plugins-enable"

# Patch Telegram plugin to:
#  (1) auto-approve permission requests instead of forwarding to user
#      (the plugin's permission-relay feature sends every tool call as an
#      Allow/Deny Telegram message even when --dangerously-skip-permissions
#      is set — that flag only skips terminal blocking).
#  (2) delete HTTPS_PROXY / HTTP_PROXY from process.env at startup so bun's
#      fetch goes direct over the transparent iptables/redsocks chain
#      rather than through an explicit CONNECT proxy. bun's fetch has a
#      reproducible bug with streaming multipart bodies (e.g. sendPhoto
#      with grammy InputFile(path)) through an explicit HTTPS_PROXY: the
#      socket closes mid-handshake with "The socket connection was closed
#      unexpectedly". Caught 2026-05-13 — sendMessage worked
#      (small JSON body), sendPhoto/sendDocument failed every time.
#      Removing the proxy env from this plugin's bun process forces the
#      direct-dial path, which iptables OUTPUT REDIRECT then routes to
#      redsocks → egress-proxy CONNECT with the original IP. The proxy
#      filter and threat model are identical; only the wire encoding
#      between bun and the proxy changes (direct TCP to redsocks at
#      127.0.0.1:12345 vs explicit CONNECT to egress-proxy:3129).
#
# Plugin is actually executed from `plugins/marketplaces/.../telegram/`
# (claude's plugin engine loads source there directly). The
# `plugins/cache/.../telegram/<version>/` tree is the install record, not
# the runtime path — patching only cache/ leaves the live server.ts
# untouched. Patch both for belt-and-braces: marketplaces/ is the one
# that actually runs, cache/ is the one entrypoint.sh seeds fresh from
# image and is what bot.sh used to target historically.
PLUGIN_PATHS=$(
    {
        ls -t "$BOT_HOME/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram/server.ts" 2>/dev/null
        ls -t "$BOT_HOME/.claude/plugins/cache/claude-plugins-official/telegram"/*/server.ts 2>/dev/null
    } | awk '!seen[$0]++'
)
if [ -n "$PLUGIN_PATHS" ]; then
    for PLUGIN_SERVER in $PLUGIN_PATHS; do
        log "Patching Telegram plugin at: $PLUGIN_SERVER"
        # Disable set -e — pattern-not-found must not crash the bot
        set +e
        python3 - "$PLUGIN_SERVER" <<'PYEOF'
import sys, re

path = sys.argv[1]
with open(path, encoding='utf-8') as f:
    content = f.read()

changed = False

# ── Patch 1: auto-approve permission_request ──────────────────────────
# Already patched — the notification handler no longer calls pendingPermissions.set
# (pendingPermissions declaration and .get still exist in the button callback handler)
if 'pendingPermissions.set' in content or "behavior: 'allow'" not in content:
    pattern = r'(async \(\{ params \}\) => \{)\n    const \{ request_id, tool_name, description, input_preview \} = params\n.*?pendingPermissions\.set.*?for \(const chat_id.*?\}\n  \},'
    replacement = r'\1\n    const { request_id } = params\n    void mcp.notification({\n      method: "notifications/claude/channel/permission",\n      params: { request_id, behavior: "allow" },\n    })\n  },'
    new_content, n = re.subn(pattern, replacement, content, flags=re.DOTALL)
    if n > 0:
        content = new_content
        changed = True
        print('[bot] permission auto-approve: patched')
    else:
        print('[bot] WARNING: permission auto-approve pattern not found')
else:
    print('[bot] permission auto-approve: already patched')

# ── Patch 2: strip HTTPS_PROXY/HTTP_PROXY at process start ─────────────
# Bun's fetch dispatcher is initialised at first-fetch time from env. The
# plugin process inherits HTTPS_PROXY/HTTP_PROXY from the container, and
# with explicit CONNECT proxy bun has a reproducible socket-close bug on
# small multipart bodies. Stripping the env forces bun onto the
# transparent iptables/redsocks chain, where small uploads succeed.
# (Large uploads still hit Patch 3's grammy bypass — see below.)
marker = '// CC-BOT-PATCH: strip proxy env for bun fetch multipart bug'
if marker not in content:
    inject = (
        marker + '\n'
        "delete (process.env as any).HTTPS_PROXY;\n"
        "delete (process.env as any).HTTP_PROXY;\n"
        "delete (process.env as any).https_proxy;\n"
        "delete (process.env as any).http_proxy;\n"
        '\n'
    )
    # Insert right after the last `import` line so we run before any
    # network code in the plugin executes.
    lines = content.split('\n')
    last_import = -1
    for i, line in enumerate(lines):
        if line.startswith('import ') or line.startswith('export ') and ' from ' in line:
            last_import = i
    if last_import >= 0:
        lines.insert(last_import + 1, inject)
        content = '\n'.join(lines)
        changed = True
        print('[bot] proxy-strip: patched')
    else:
        print('[bot] WARNING: proxy-strip could not find import block')
else:
    print('[bot] proxy-strip: already patched')

# ── Patch 3: bypass grammy for sendPhoto/sendDocument ──────────────────
# grammy's bot.api.sendPhoto / sendDocument with InputFile (path OR buffer)
# hangs for 60s and returns "socket closed unexpectedly" on bun 1.3.14
# for ANY body larger than ~few KB, with or without HTTPS_PROXY in env.
# grammy uses internals (likely Node-style streams + Transfer-Encoding:
# chunked) that interact badly with bun's fetch implementation. Verified
# empirically 2026-05-14:
#   - curl multipart 230KB direct dial → 200 OK in 257ms
#   - bun native fetch + FormData + Blob 230KB → 200 OK in 235ms
#   - grammy + InputFile(path) 230KB → 60s timeout, socket-closed
#   - grammy + InputFile(Buffer) 230KB → 60s timeout, socket-closed
# So the bug is grammy↔bun specifically; we use bun's native fetch directly.
#
# Replace the in-loop send so:
#   bot.api.sendPhoto(chat_id, new InputFile(f), opts)
# becomes a direct multipart POST to api.telegram.org. Same wire request
# Telegram would have received from grammy, just constructed natively.
photo_marker = '// CC-BOT-PATCH: bypass grammy for file uploads'
if photo_marker not in content:
    old_block = '''          if (PHOTO_EXTS.has(ext)) {
            const sent = await bot.api.sendPhoto(chat_id, input, opts)
            sentIds.push(sent.message_id)
          } else {
            const sent = await bot.api.sendDocument(chat_id, input, opts)
            sentIds.push(sent.message_id)
          }'''
    new_block = '''          // ''' + photo_marker + '''
          {
            const isPhoto = PHOTO_EXTS.has(ext)
            const method = isPhoto ? 'sendPhoto' : 'sendDocument'
            const fileKey = isPhoto ? 'photo' : 'document'
            const buf = readFileSync(f)
            const fname = f.split('/').pop() || 'upload'
            const fd = new FormData()
            fd.set('chat_id', String(chat_id))
            if (opts?.reply_parameters) {
              fd.set('reply_parameters', JSON.stringify(opts.reply_parameters))
            }
            fd.set(fileKey, new Blob([buf]), fname)
            const url = `https://api.telegram.org/bot${TOKEN}/${method}`
            const resp = await fetch(url, { method: 'POST', body: fd })
            const data = await resp.json() as { ok: boolean; result?: any; description?: string; error_code?: number }
            if (!data.ok) {
              throw new Error(`Telegram ${method} failed (${data.error_code}): ${data.description}`)
            }
            sentIds.push(data.result.message_id)
          }'''
    if old_block in content:
        content = content.replace(old_block, new_block)
        changed = True
        print('[bot] grammy-bypass: patched')
    else:
        print('[bot] WARNING: grammy-bypass pattern not found')
else:
    print('[bot] grammy-bypass: already patched')

# ── Patch 4: telegram conversation logging ─────────────────────────────
# Append every inbound + outbound message to /home/bot/.telegram/
# conversation.jsonl so workspace-api's recent-snapshot-monitor can build
# a rolling tail into memory/RECENT_TELEGRAM.md. Without this hook there
# is no persisted transcript of Telegram conversations on disk — the
# bot's tmux Claude session holds context in-process only, lost on every
# restart.
#
# Injection strategy: single block after the last `import` line (same
# anchor as Patch 2 proxy-strip). The block defines an `appendTelegramLog`
# helper + registers a grammy middleware (inbound) + a grammy API
# transformer (outbound). One regex match = minimum fragility.
tg_log_marker = '// CC-BOT-PATCH: telegram conversation log'
if tg_log_marker not in content:
    inject = (
        tg_log_marker + '\n'
        "import { appendFileSync as _appendLog, mkdirSync as _mkdirLog, chmodSync as _chmodLog } from 'node:fs';\n"
        "import { dirname as _dirnameLog } from 'node:path';\n"
        "const TELEGRAM_LOG_PATH = process.env.TELEGRAM_LOG_PATH || '/home/bot/.telegram/conversation.jsonl';\n"
        "let _tgLogDirReady = false;\n"
        "function appendTelegramLog(entry: any) {\n"
        "  try {\n"
        "    if (!_tgLogDirReady) {\n"
        "      _mkdirLog(_dirnameLog(TELEGRAM_LOG_PATH), { recursive: true, mode: 0o770 });\n"
        "      _tgLogDirReady = true;\n"
        "    }\n"
        "    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\\n';\n"
        "    _appendLog(TELEGRAM_LOG_PATH, line);\n"
        "    // 0660 group=botshare so workspace-api (in botshare) can read; chmod\n"
        "    // is best-effort — first-write wins, subsequent appends inherit mode.\n"
        "    try { _chmodLog(TELEGRAM_LOG_PATH, 0o660); } catch (_) { /* ignore */ }\n"
        "  } catch (_) { /* swallow — logging must never crash the plugin */ }\n"
        "}\n"
        '\n'
    )
    lines = content.split('\n')
    last_import = -1
    for i, line in enumerate(lines):
        if line.startswith('import ') or line.startswith('export ') and ' from ' in line:
            last_import = i
    if last_import >= 0:
        lines.insert(last_import + 1, inject)
        content = '\n'.join(lines)
        changed = True
        print('[bot] telegram-log helper: patched')
    else:
        print('[bot] WARNING: telegram-log helper could not find import block')
else:
    print('[bot] telegram-log helper: already patched')

# ── Patch 4 (continued): inbound middleware ───────────────────────────
# Register grammy middleware that fires on every inbound message,
# regardless of type (text / photo / document / voice / etc.). The
# existing bot.on('message:text'), bot.on('message:photo') handlers
# still run downstream — this is a pre-handler that captures the raw
# inbound before any gate logic. Even drops are logged so we can audit
# rejected pairing attempts. Logged BEFORE `bot.start()` to ensure it
# attaches before the first event loop tick.
# NOTE: a prior version of this script tried to remove a "broken v1" of the
# inbound patch on every restart via a non-greedy regex
# r'\n?// // CC-BOT-PATCH: telegram inbound middleware\n.*?\}\);\n'.
# That regex matched the INNER `});` of `appendTelegramLog({...});` instead
# of the OUTER `});` of `bot.use(...)`, stripping only part of the block on
# each restart and leaving residual `} catch ... await next(); });` after
# the marker. The marker-removal then made the `if marker not in content`
# guard below pass → re-injection. Result: every restart accreted one more
# orphan `} catch ... await next(); });` block until bun's TS parser
# refused the file ("Unexpected }" near line 136). Caught 2026-05-23 when
# the Telegram plugin stopped starting after the operator nuked the
# plugin tree manually and the patcher ran multiple times on fresh files.
#
# The "v1" of this patch this code was trying to clean up is long gone from
# any image we deploy now (2026-05-04 era). The clean fix is to drop the
# remove logic entirely and rely on the marker-substring guard below for
# idempotency. If a future patch needs to be updated, mint a new marker
# version (v2, v3, ...) and add a strip-and-reapply block scoped tightly
# to its own marker — like the `restart command v3` patch further down.
tg_inbound_marker = '// CC-BOT-PATCH: telegram inbound middleware'
if tg_inbound_marker not in content:
    # Anchor: right after `const bot = new Bot(TOKEN)` — middleware MUST
    # register BEFORE all bot.on() handlers, otherwise grammy's handlers
    # consume the update without calling next() and downstream middleware
    # never fires. (First version anchored on `await bot.start(` near
    # end of file and silently caught nothing — outbound transformer
    # works there because it hooks the API layer, not the event chain.)
    inbound_inject = (
        '\n// ' + tg_inbound_marker + '\n'
        'bot.use(async (ctx, next) => {\n'
        '  try {\n'
        '    const m = ctx.message;\n'
        '    const text = m?.text ?? m?.caption ?? null;\n'
        '    let kind: string = "text";\n'
        '    if (m?.photo) kind = "photo";\n'
        '    else if (m?.document) kind = "document";\n'
        '    else if (m?.voice) kind = "voice";\n'
        '    else if (m?.audio) kind = "audio";\n'
        '    else if (!m?.text) kind = "other";\n'
        '    appendTelegramLog({\n'
        '      direction: "inbound",\n'
        '      chat_id: ctx.chat?.id != null ? String(ctx.chat.id) : null,\n'
        '      message_id: m?.message_id ?? null,\n'
        '      user: ctx.from?.username || ctx.from?.first_name || (ctx.from?.id != null ? String(ctx.from.id) : null),\n'
        '      kind,\n'
        '      text,\n'
        '    });\n'
        '  } catch (_) { /* swallow */ }\n'
        '  await next();\n'
        '});\n'
    )
    # Anchor: the line that constructs the bot. Inject immediately after.
    pattern = re.compile(r'(^const bot = new Bot\([^)]*\))', re.MULTILINE)
    # lambda, NOT string concat: an inject containing "\s" etc. would be parsed
    # as a (broken) backreference template and crash the whole patcher — caught
    # live 2026-07-11 (re.PatternError killed every patch after this point).
    new_content, n = pattern.subn(lambda m: m.group(1) + inbound_inject, content, count=1)
    if n > 0:
        content = new_content
        changed = True
        print('[bot] telegram-log inbound: patched')
    else:
        print('[bot] WARNING: telegram-log inbound pattern (const bot = new Bot) not found')
else:
    print('[bot] telegram-log inbound: already patched')

# ── Patch 4e: inbound RELAY ROUTING (separate bot.use, own marker) ─────
# POSTs every inbound DM to wsapi /internal/telegram-inbound so a teammate's
# Telegram reply threads back into the right web relay conversation. Captures
# reply_to_message?.message_id (the logger above does NOT) for deterministic
# threading. If wsapi reports the message was a relay reply (routed:true) we
# suppress the identity-blind brain's own reply (return WITHOUT next()) so a
# non-admin teammate doesn't get a confusing direct bot answer —
# routeTelegramInbound skips the admin, so the operator's own brain path is
# untouched (routed stays false for them). Awaited but capped at 1.5s and fully
# swallowed: a hung or absent wsapi never blocks message handling. Registered as
# its OWN bot.use (the existing logger block is left intact) and guarded by its
# own marker for idempotency.
tg_relay_marker = '// CC-BOT-PATCH: telegram inbound relay routing'
if tg_relay_marker not in content:
    relay_inject = (
        '\n// ' + tg_relay_marker + '\n'
        'bot.use(async (ctx, next) => {\n'
        '  let routed = false;\n'
        '  try {\n'
        '    const rm = ctx.message;\n'
        '    const rtext = rm?.text ?? rm?.caption ?? null;\n'
        '    if (rtext) {\n'
        '      const payload = JSON.stringify({\n'
        '        chat_id: ctx.chat?.id != null ? String(ctx.chat.id) : null,\n'
        '        text: rtext,\n'
        '        message_id: rm?.message_id ?? null,\n'
        '        reply_to_message_id: rm?.reply_to_message?.message_id ?? null,\n'
        '      });\n'
        '      const r: any = await Promise.race([\n'
        '        fetch("http://127.0.0.1:3001/api/internal/telegram-inbound", {\n'
        '          method: "POST", headers: { "Content-Type": "application/json" }, body: payload,\n'
        '        }).then((res) => res.json()).catch(() => ({})),\n'
        '        new Promise((res) => setTimeout(() => res({}), 1500)),\n'
        '      ]);\n'
        '      routed = !!(r && r.routed);\n'
        '    }\n'
        '  } catch (_) { /* swallow */ }\n'
        '  if (routed) return;   // relay reply handled deterministically — do not let the brain also answer\n'
        '  await next();\n'
        '});\n'
    )
    pattern = re.compile(r'(^const bot = new Bot\([^)]*\))', re.MULTILINE)
    new_content, n = pattern.subn(lambda m: m.group(1) + relay_inject, content, count=1)   # lambda: see inbound note
    if n > 0:
        content = new_content
        changed = True
        print('[bot] telegram inbound relay routing: patched')
    else:
        print('[bot] WARNING: telegram relay-routing pattern (const bot = new Bot) not found')
else:
    print('[bot] telegram inbound relay routing: already patched')

# ── Patch 4f: GROUP message diversion (separate bot.use, own marker) ───
# Group mode (docs/future-plans/TELEGRAM_GROUP_MODE.md). Diverts EVERY
# group/supergroup message to wsapi /internal/group-message (the ambient
# relevance watcher) and returns WITHOUT next() — so the operator brain, the
# logger (Patch 4) and the relay (Patch 4e) NEVER see group traffic. DMs are
# untouched (await next()). Applied AFTER Patch 4e so its block lands closest to
# the `const bot = new Bot` anchor and therefore registers FIRST in grammy
# middleware order (group is swallowed before 4e POSTs a negative chat_id to
# telegram-inbound). As the very first bot.use it runs before the plugin's own
# access gate, so the allow-list lives in wsapi (.team-config.json), not
# access.json — and Telegram still only DELIVERS non-mention group messages when
# BotFather privacy mode is OFF (runbook). Awaited but capped at 1.5s, swallowed.
# Strip-and-reapply (v3 convention — see the restart-command patch below): wipe any
# previously-injected group block so a BODY change (here: forwarding photo_file_id for
# group images) actually takes effect even on a PERSISTED /home/bot plugin where the
# marker is already present. Without this, an "already patched" cache pins the OLD
# text-only body forever (caught 2026-06-24: deployed the image fix but the bot kept
# replying "nothing attached"). Anchored on the marker + the unique trailing comment —
# NOT brace-counting, because the bot.use(...) block nests too deep for that.
group_existing_pattern = re.compile(
    r'\n?// CC-BOT-PATCH: telegram group message diversion\n.*?// group traffic handled by the watcher[^\n]*\n\}\);\n',
    re.DOTALL,
)
if group_existing_pattern.search(content):
    content = group_existing_pattern.sub('', content)
    changed = True
    print('[bot] telegram group diversion: stripped stale block (reapplying current body)')
tg_group_marker = '// CC-BOT-PATCH: telegram group message diversion'
if tg_group_marker not in content:
    group_inject = (
        '\n// ' + tg_group_marker + '\n'
        'bot.use(async (ctx, next) => {\n'
        '  const ctype = ctx.chat?.type;\n'
        '  if (ctype !== "group" && ctype !== "supergroup") { await next(); return; }\n'
        '  // my_chat_member (the bot being added to / removed from the group) must\n'
        '  // pass through to the auto-register handler (Patch 4h). This block is\n'
        '  // stripped + re-injected at the anchor on every reapply, so it can end up\n'
        '  // ABOVE 4h in middleware order — swallowing here would eat the join event\n'
        '  // and the group would never self-register.\n'
        '  if (ctx.myChatMember) { await next(); return; }\n'
        '  try {\n'
        '    const gm = ctx.message;\n'
        '    const gtext = gm?.text ?? gm?.caption ?? null;\n'
        '    let photoFileId = null;\n'
        '    try {\n'
        '      const ph = gm?.photo;\n'
        '      if (Array.isArray(ph) && ph.length) photoFileId = ph[ph.length - 1].file_id;\n'
        '      else if (gm?.document && typeof gm.document.mime_type === "string" && gm.document.mime_type.indexOf("image/") === 0) photoFileId = gm.document.file_id;\n'
        '    } catch (_) { /* no photo on this message */ }\n'
        '    // Non-image attachments — mirror the DM AttachmentMeta shape (kind/\n'
        '    // file_id/size/mime/name) so the watcher can log, classify and (for\n'
        '    // documents) hand the file to the group brain. GIF "animations" also\n'
        '    // carry .document, so the document branch covers them.\n'
        '    let attachment = null;\n'
        '    try {\n'
        '      const att = (k, f, extra) => (f && f.file_id ? { kind: k, file_id: f.file_id, size: f.file_size ?? null, ...extra } : null);\n'
        '      if (gm?.document && !photoFileId) attachment = att("document", gm.document, { mime: gm.document.mime_type ?? null, name: gm.document.file_name ?? null });\n'
        '      else if (gm?.voice) attachment = att("voice", gm.voice, { mime: gm.voice.mime_type ?? null });\n'
        '      else if (gm?.audio) attachment = att("audio", gm.audio, { mime: gm.audio.mime_type ?? null, name: gm.audio.file_name ?? gm.audio.title ?? null });\n'
        '      else if (gm?.video_note) attachment = att("video_note", gm.video_note, {});\n'
        '      else if (gm?.video) attachment = att("video", gm.video, { mime: gm.video.mime_type ?? null, name: gm.video.file_name ?? null });\n'
        '      else if (gm?.sticker) attachment = att("sticker", gm.sticker, { emoji: gm.sticker.emoji ?? null });\n'
        '    } catch (_) { /* attachment scan best-effort */ }\n'
        '    if (gtext || photoFileId || attachment) {\n'
        '      const meId = ctx.me?.id;\n'
        '      const meName = ctx.me?.username ? ("@" + ctx.me.username) : null;\n'
        '      let mentioned = false;\n'
        '      try {\n'
        '        const ents = gm?.entities ?? [];\n'
        '        for (const e of ents) {\n'
        '          if (e.type === "text_mention" && e.user?.id === meId) { mentioned = true; break; }\n'
        '          if (e.type === "mention" && meName && gtext.substr(e.offset, e.length) === meName) { mentioned = true; break; }\n'
        '        }\n'
        '      } catch (_) { /* entity scan best-effort */ }\n'
        '      const replyToBot = gm?.reply_to_message?.from?.id != null && gm.reply_to_message.from.id === meId;\n'
        '      const payload = JSON.stringify({\n'
        '        chat_id: ctx.chat?.id != null ? String(ctx.chat.id) : null,\n'
        '        chat_title: ctx.chat?.title ?? null,\n'
        '        message_id: gm?.message_id ?? null,\n'
        '        text: gtext,\n'
        '        photo_file_id: photoFileId,\n'
        '        attachment: attachment,\n'
        '        from_id: ctx.from?.id != null ? String(ctx.from.id) : null,\n'
        '        from_username: ctx.from?.username ?? null,\n'
        '        from_name: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || null,\n'
        '        reply_to_message_id: gm?.reply_to_message?.message_id ?? null,\n'
        '        is_mention: mentioned,\n'
        '        is_reply_to_bot: replyToBot,\n'
        '      });\n'
        '      await Promise.race([\n'
        '        fetch("http://127.0.0.1:3001/api/internal/group-message", {\n'
        '          method: "POST", headers: { "Content-Type": "application/json" }, body: payload,\n'
        '        }).catch(() => {}),\n'
        '        new Promise((res) => setTimeout(res, 1500)),\n'
        '      ]);\n'
        '    }\n'
        '  } catch (_) { /* swallow */ }\n'
        '  return;   // group traffic handled by the watcher — never reaches the operator brain\n'
        '});\n'
    )
    pattern = re.compile(r'(^const bot = new Bot\([^)]*\))', re.MULTILINE)
    new_content, n = pattern.subn(lambda m: m.group(1) + group_inject, content, count=1)   # lambda: see inbound note
    if n > 0:
        content = new_content
        changed = True
        print('[bot] telegram group diversion: patched')
    else:
        print('[bot] WARNING: telegram group-diversion pattern (const bot = new Bot) not found')
else:
    print('[bot] telegram group diversion: already patched')

# ── Patch 4h: auto-register a group on my_chat_member ──────────────────
# When the bot is ADDED to a group, POST {chat_id,title,creator_id,added_by_id}
# to wsapi /internal/group-joined, which auto-registers it IF the creator/adder is
# a team-roster member (the trust gate). grammy auto-derives allowed_updates from
# registered handlers, so adding bot.on('my_chat_member') is enough to receive it.
tg_join_marker = '// CC-BOT-PATCH: group auto-register'
if tg_join_marker not in content:
    join_inject = (
        '\n// ' + tg_join_marker + '\n'
        'bot.on("my_chat_member", async (ctx) => {\n'
        '  try {\n'
        '    const chat = ctx.chat;\n'
        '    if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;\n'
        '    const ns = ctx.myChatMember?.new_chat_member?.status;\n'
        '    if (ns !== "member" && ns !== "administrator") return;\n'
        '    let creatorId = null;\n'
        '    try {\n'
        '      const admins = await ctx.api.getChatAdministrators(chat.id);\n'
        '      const owner = admins.find((a) => a.status === "creator");\n'
        '      if (owner && owner.user && owner.user.id != null) creatorId = String(owner.user.id);\n'
        '    } catch (_) {}\n'
        '    const payload = JSON.stringify({\n'
        '      chat_id: String(chat.id),\n'
        '      title: chat.title ?? null,\n'
        '      creator_id: creatorId,\n'
        '      added_by_id: ctx.myChatMember?.from?.id != null ? String(ctx.myChatMember.from.id) : null,\n'
        '    });\n'
        '    await Promise.race([\n'
        '      fetch("http://127.0.0.1:3001/api/internal/group-joined", {\n'
        '        method: "POST", headers: { "Content-Type": "application/json" }, body: payload,\n'
        '      }).catch(() => {}),\n'
        '      new Promise((r) => setTimeout(r, 2500)),\n'
        '    ]);\n'
        '  } catch (_) { /* swallow */ }\n'
        '});\n'
    )
    pattern = re.compile(r'(^const bot = new Bot\([^)]*\))', re.MULTILINE)
    new_content, n = pattern.subn(lambda m: m.group(1) + join_inject, content, count=1)   # lambda: see inbound note
    if n > 0:
        content = new_content
        changed = True
        print('[bot] group auto-register: patched')
    else:
        print('[bot] WARNING: group auto-register pattern (const bot = new Bot) not found')
else:
    print('[bot] group auto-register: already patched')

# ── Patch 4 (continued): outbound API transformer ─────────────────────
# grammy's bot.api.config.use(transformer) wraps EVERY API call. We
# log only user-facing send* methods (sendMessage / sendPhoto /
# sendDocument); skip getMe / getFile / setMessageReaction / etc.
tg_outbound_marker = '// CC-BOT-PATCH: telegram outbound transformer'
# Re-apply on EVERY start. The plugin dir persists across deploys, so a bare
# presence-check pins an OLD transformer forever: a changed version (e.g.
# adding the Markdown/em-dash sanitizer) would never land. Strip any prior
# block (from our marker up to the bot.start anchor it sits before) so the
# check below re-injects the current one.
if tg_outbound_marker in content:
    content = re.sub(
        r'// CC-BOT-PATCH: telegram outbound transformer.*?(?=\n\s*await bot\.start\()',
        '', content, count=1, flags=re.DOTALL,
    )
    print('[bot] telegram outbound: stripped prior transformer for re-patch')
if tg_outbound_marker not in content:
    outbound_inject = (
        '// ' + tg_outbound_marker + '\n'
        '// Telegram plain-text hygiene: the model tends to emit Markdown (**bold**,\n'
        '// `code`, # headings) and em dashes; Telegram renders the Markdown as literal\n'
        '// characters (ugly) and em-dash-heavy text reads as machine-generated. Strip\n'
        '// both from every plain-text send. Left alone when parse_mode is set (the\n'
        '// caller intentionally chose markdownv2/HTML and escaped it themselves).\n'
        'const stripTgMd = (s: any) => {\n'
        '  if (typeof s !== "string") return s;\n'
        '  return s\n'
        '    .replace(/`([^`]+)`/g, "$1")\n'
        '    .replace(/\\*\\*([^*]+)\\*\\*/g, "$1")\n'
        '    .replace(/__([^_]+)__/g, "$1")\n'
        '    .replace(/~~([^~]+)~~/g, "$1")\n'
        '    .replace(/^\\s{0,3}#{1,6}\\s+/gm, "")\n'
        '    .replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, "$1 ($2)")\n'
        '    .replace(/\\s*\\u2014\\s*/g, " - ")\n'
        '    .replace(/ -- /g, " - ");\n'
        '};\n'
        'bot.api.config.use(async (prev, method, payload) => {\n'
        '  try {\n'
        '    const q: any = payload;\n'
        '    if (q && !q.parse_mode) {\n'
        '      if (method === "sendMessage" && typeof q.text === "string") q.text = stripTgMd(q.text);\n'
        '      else if ((method === "sendPhoto" || method === "sendDocument") && typeof q.caption === "string") q.caption = stripTgMd(q.caption);\n'
        '    }\n'
        '  } catch (_) { /* swallow: never block a send on hygiene */ }\n'
        '  const result = await prev(method, payload);\n'
        '  try {\n'
        '    if (method === "sendMessage" || method === "sendPhoto" || method === "sendDocument") {\n'
        '      const p: any = payload;\n'
        '      appendTelegramLog({\n'
        '        direction: "outbound",\n'
        '        method,\n'
        '        chat_id: p?.chat_id != null ? String(p.chat_id) : null,\n'
        '        message_id: (result as any)?.message_id ?? null,\n'
        '        text: method === "sendMessage" ? (p?.text ?? null) : (p?.caption ?? null),\n'
        '        file: method !== "sendMessage" ? "(file attached)" : null,\n'
        '      });\n'
        '    }\n'
        '  } catch (_) { /* swallow */ }\n'
        '  return result;\n'
        '});\n\n'
    )
    # Anchor: same `bot.start()` line. Insert AFTER the inbound block we
    # just added so order in source is helper → inbound → outbound → start.
    # Anchor on `await bot.start(` — real plugin uses `bot.start({...options})`
    # not a bare `bot.start()` call. Match indentation + the `await ` prefix.
    pattern = re.compile(r'^(\s*)(await bot\.start\()', re.MULTILINE)
    # lambda, NOT string concat — outbound_inject contains TS regexes with "\s",
    # which a template replacement parses as a bad escape and crashes the whole
    # patcher (re.PatternError, live 2026-07-11: bot ran with ZERO patches —
    # group diversion dead, groups fell back to the stock plugin gate).
    new_content, n = pattern.subn(lambda m: outbound_inject + m.group(1) + m.group(2), content, count=1)
    if n > 0:
        content = new_content
        changed = True
        print('[bot] telegram-log outbound: patched')
    else:
        print('[bot] WARNING: telegram-log outbound pattern (bot.start()) not found')
else:
    print('[bot] telegram-log outbound: already patched')

# ── Patch 4d: pid-lock sibling guard ───────────────────────────────────
# Upstream's "replace stale poller" logic SIGTERMs whatever PID is in
# bot.pid before writing its own, without checking whether that PID is a
# recently-started sibling (e.g. duplicate MCP spawn during claude boot)
# or a true orphan from a crashed previous session. Observed 2026-06-14:
# the second plugin instance to start killed the first, the first held
# claude's MCP connection, so the connection closed and claude lost the
# telegram tool. Inbound messages queued silently on Telegram for hours
# (no typing indicator, no reply).
#
# Fix: gate the SIGTERM on the PID file's mtime. If it was written less
# than 30s ago, the owner is almost certainly a healthy sibling — bow out
# cleanly (process.exit(0)) instead of taking it down. Past 30s the
# original takeover kicks in, which still handles the real "orphan from
# a crashed previous session" case.
pid_lock_marker = '// CC-BOT-PATCH: pid-lock sibling guard'
if pid_lock_marker not in content:
    old_block = (
        "try {\n"
        "  const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)\n"
        "  if (stale > 1 && stale !== process.pid) {\n"
        "    process.kill(stale, 0)\n"
        "    process.stderr.write(`telegram channel: replacing stale poller pid=${stale}\\n`)\n"
        "    process.kill(stale, 'SIGTERM')\n"
        "  }\n"
        "} catch {}\n"
    )
    new_block = (
        pid_lock_marker + "\n"
        "try {\n"
        "  const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)\n"
        "  if (stale > 1 && stale !== process.pid) {\n"
        "    process.kill(stale, 0)\n"
        "    const ageMs = Date.now() - statSync(PID_FILE).mtimeMs\n"
        "    if (ageMs < 30_000) {\n"
        "      process.stderr.write(`telegram channel: sibling poller already running pid=${stale} (age=${ageMs}ms) — exiting cleanly\\n`)\n"
        "      process.exit(0)\n"
        "    }\n"
        "    process.stderr.write(`telegram channel: replacing stale poller pid=${stale}\\n`)\n"
        "    process.kill(stale, 'SIGTERM')\n"
        "  }\n"
        "} catch {}\n"
    )
    if old_block in content:
        content = content.replace(old_block, new_block)
        changed = True
        print('[bot] pid-lock guard: patched')
    else:
        print('[bot] WARNING: pid-lock guard pattern not found (upstream server.ts may have changed)')
else:
    print('[bot] pid-lock guard: already patched')

# ── Patch 4g: continuous "typing…" in 1:1 ──────────────────────────────
# The plugin fires sendChatAction('typing') ONCE on inbound; Telegram expires it
# after ~5s, so a long (tool-using) turn shows no "typing…" for most of its run.
# Refresh it on an interval from the inbound message until the reply goes out (or
# a 3-min safety cap). __startTyping replaces the one-shot send; __stopTyping
# fires as the reply chunks go out in the `reply` tool handler.
typing_marker = '// CC-BOT-PATCH: continuous typing'
if typing_marker not in content:
    helpers = (
        '\n// ' + typing_marker + '\n'
        'const __typingTimers = new Map();\n'
        'function __stopTyping(cid) {\n'
        '  const t = __typingTimers.get(String(cid));\n'
        '  if (t) { clearInterval(t.iv); clearTimeout(t.to); __typingTimers.delete(String(cid)); }\n'
        '}\n'
        'function __startTyping(cid) {\n'
        '  __stopTyping(cid);\n'
        '  void bot.api.sendChatAction(cid, "typing").catch(() => {});\n'
        '  const iv = setInterval(() => { void bot.api.sendChatAction(cid, "typing").catch(() => {}); }, 4500);\n'
        '  const to = setTimeout(() => __stopTyping(cid), 180000);\n'
        '  __typingTimers.set(String(cid), { iv, to });\n'
        '}\n'
    )
    n1 = n2 = n3 = 0
    pat = re.compile(r'(^const bot = new Bot\([^)]*\))', re.MULTILINE)
    content, n1 = pat.subn(r'\1' + helpers, content, count=1)
    one_shot = "void bot.api.sendChatAction(chat_id, 'typing').catch(() => {})"
    if one_shot in content:
        content = content.replace(one_shot, '__startTyping(chat_id)', 1); n2 = 1
    stop_anchor = 'const chunks = chunk(text, limit, mode)'
    if stop_anchor in content:
        content = content.replace(stop_anchor, '__stopTyping(chat_id)\n        ' + stop_anchor, 1); n3 = 1
    if n1 and n2 and n3:
        changed = True
        print('[bot] continuous typing: patched')
    else:
        print(f'[bot] WARNING: continuous typing patch incomplete (helpers={n1} start={n2} stop={n3})')
else:
    print('[bot] continuous typing: already patched')

# ── Patch 5: /restart slash command + Telegram slash menu ──────────────
# Operator-only command that exits the bot cleanly. PM2 sees the exit and
# restarts the process (max_restarts: 50, restart_delay: 10s). On restart,
# claude re-reads ~/.claude.json so newly activated integrations show up
# in the tool catalog without needing a full container redeploy or a UI
# button. setMyCommands registers the slash menu so /restart appears in
# the Telegram client's autocomplete next to /start, /help, /status.
#
# Security: command body checks ctx.chat.id against TELEGRAM_ADMIN_CHAT_ID
# and silently no-ops for anyone else. The Telegram slash menu IS visible
# to every chat (Telegram has no per-chat command list for non-admin bots),
# but invoking it from a non-admin chat does nothing.
#
# Anchor history: v1 was anchored on `await bot.start(`, which placed the
# injection AFTER the plugin's bot.on('message:text') handler. grammy
# routes by registration order — the text handler matched /restart first
# and forwarded the message to the claude assistant instead of treating
# it as a command. v2 anchors on the first `bot.command('start'` (plugin
# already registers /start before bot.on) so our /restart sits in the
# command-filter cluster.
def _strip_marked_blocks(text, marker):
    """Remove EVERY `// <marker>\n{ ... }` block by brace-counting (string- and
    template-literal-aware), not a regex — the old regex couldn't match the
    block's nested braces, so the idempotent remove silently failed and copies
    piled up (100+ on long-lived bots). Returns (text, count_removed)."""
    removed = 0
    while True:
        i = text.find(marker)
        if i == -1:
            break
        b = text.find('{', i)
        if b == -1:                       # marker with no block — drop the line
            nl = text.find('\n', i)
            text = text[:i] + (text[nl + 1:] if nl != -1 else '')
            removed += 1
            continue
        depth, j, quote, esc = 0, b, None, False
        while j < len(text):
            c = text[j]
            if esc:
                esc = False
            elif c == '\\':
                esc = True
            elif quote:
                if c == quote:
                    quote = None
            elif c in ('"', "'", '`'):
                quote = c
            elif c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    j += 1
                    break
            j += 1
        end = j
        while end < len(text) and text[end] in '\r\n':
            end += 1
        text = text[:i] + text[end:]
        removed += 1
    return text, removed

content, _v1_removed = _strip_marked_blocks(content, '// // CC-BOT-PATCH: restart command + slash menu\n')
if _v1_removed:
    changed = True
    print('[bot] restart command: removed v1 (was anchored post-handlers)')

# v2 of the same block (anchored pre-bot.on but included an own
# setMyCommands call that got overridden by the plugin's
# all_private_chats-scope call). Strip it so the v3 layout below
# applies cleanly on the next deploy.
content, _v2_removed = _strip_marked_blocks(content, '// // CC-BOT-PATCH: restart command + slash menu v2')
if _v2_removed:
    changed = True
    print('[bot] restart command: removed v2 (own setMyCommands ignored due to scope priority)')

# Strip-and-reapply pattern (vs the old skip-if-marker-present approach).
# Why: a marker-only check meant that any time we updated the patch BODY
# while keeping the same v3 label, an already-patched cache file kept the
# OLD body forever. That's how the 2026-05-22 incident happened — operator
# updated v3 to add `process.kill(ppid)`, deployed, but every bot the
# patch had already run on kept the pre-update v3 and silently swallowed
# the new behaviour. Now: detect ANY block our patcher previously injected
# (matched by the marker line + the {...} that follows), wipe it, then
# apply the current body. Net: re-patching is idempotent AND auto-updating.
tg_restart_marker = '// CC-BOT-PATCH: restart command v3'
# Brace-counting strip (was a single-nesting-level regex that NEVER matched
# the 3-deep injected body, while the reinject below is unconditional →
# one extra copy per bot restart; a fleet host was found with 48 copies).
content, _v3_removed = _strip_marked_blocks(content, '// ' + tg_restart_marker)
if _v3_removed:
    changed = True
    # No log line here — we'll print the "patched" line after reinject
    # so a single restart shows one event per patch, not two.

restart_inject = (
    '// ' + tg_restart_marker + '\n'
    '{\n'
    '  const __adminChatId: string = String(process.env.TELEGRAM_ADMIN_CHAT_ID || "");\n'
    '  bot.command("restart", async (ctx) => {\n'
    '    if (!__adminChatId || String(ctx.chat?.id) !== __adminChatId) return;\n'
    '    try { await ctx.reply("🔄 Restarting — back in a moment."); } catch (_) {}\n'
    '    // process.exit(0) only kills THIS plugin sub-process — claude\n'
    '    // (our parent) survives, tmux session stays alive, bot.sh\n'
    '    // does not exit, PM2 does not restart. We need claude itself\n'
    '    // to die so tmux pane closes → bot.sh while-tmux-has-session\n'
    '    // loop exits → PM2 cycle.\n'
    '    //\n'
    '    // process.ppid is NOT claude — bun runs the plugin via a\n'
    '    // `bun run` wrapper script, so ppid points at the wrapper, not\n'
    '    // at claude (one more hop up). Walk the parent chain via\n'
    '    // /proc/<pid>/status until we find a process named "claude",\n'
    '    // then SIGTERM it. Caught 2026-05-24 when /restart kept\n'
    '    // replying "Restartuję" but PM2 restart count stayed at 0 for\n'
    '    // 13h straight.\n'
    '    try {\n'
    '      const { readFileSync } = await import("fs");\n'
    '      let pid = process.pid;\n'
    '      for (let i = 0; i < 8 && pid > 1; i++) {\n'
    '        const status = readFileSync("/proc/" + pid + "/status", "utf8");\n'
    '        const name = (status.match(/^Name:\\s+(.+)/m) || [])[1];\n'
    '        if (name === "claude") { process.kill(pid, "SIGTERM"); break; }\n'
    '        const m = status.match(/^PPid:\\s+(\\d+)/m);\n'
    '        if (!m) break;\n'
    '        pid = parseInt(m[1], 10);\n'
    '      }\n'
    '    } catch (_) { /* fall through to process.exit; bot may not restart but TG ACK already went out */ }\n'
    '    setTimeout(() => process.exit(0), 800);\n'
    '  });\n'
    '}\n\n'
)
# Anchor: immediately BEFORE the plugin's first `bot.command(` (its
# `/start` handler). That sits before `bot.on('message:text')`, which
# is where v1 silently broke — text handler swallowed /restart updates.
#
# Note: use a lambda for the replacement instead of a `\1`-style template
# string. The inject body contains a JS regex literal (`\s+` inside a
# `.match()`) — when passed as a Python sub replacement TEMPLATE, the
# template parser chokes on `\s` ("bad escape \\s" — only `\1`-`\9` and
# a small set are valid in replacements). A lambda bypasses the template
# parser entirely; the returned string is taken verbatim. Caught 2026-
# 05-24 — the silent crash meant no v3 patch was applied, no /restart
# patched line in logs, and PM2 never cycled on operator's /restart.
pattern = re.compile(r"^(bot\.command\(['\"]start['\"])", re.MULTILINE)
new_content, n = pattern.subn(lambda m: restart_inject + m.group(1), content, count=1)
if n > 0:
    content = new_content
    changed = True
    print('[bot] restart command: patched (v3, pre-bot.on)')
else:
    print('[bot] WARNING: restart command pattern (bot.command start) not found')

# ── Patch 5b: append /restart to plugin's setMyCommands list ──────────
# The plugin's bot.start onStart calls setMyCommands with a 3-item array
# scoped to all_private_chats. Telegram's resolution rule is
# "most-specific scope wins", so our own default-scope setMyCommands
# (Patch 5 v2) was never surfaced in private chats. Solution: extend
# the plugin's own array with our /restart entry so the slash menu the
# user actually sees includes it.
#
# Idempotency: anchor matches the 3-item shape exactly; once we've
# inserted /restart, the 4-item shape no longer matches, so subsequent
# patch runs leave the file alone.
restart_menu_marker = "{ command: 'restart',"
if restart_menu_marker not in content:
    plugin_menu_pattern = re.compile(
        r"(\{ command: 'status', description: '[^']+' \},)\n(\s+\],)",
        re.MULTILINE,
    )
    insertion = (
        r"\1\n"
        r"              { command: 'restart', description: 'Restart the bot (admin only)' },\n"
        r"\2"
    )
    new_content, n = plugin_menu_pattern.subn(insertion, content, count=1)
    if n > 0:
        content = new_content
        changed = True
        print('[bot] /restart slash menu entry: patched into plugin setMyCommands')
    else:
        print('[bot] WARNING: plugin setMyCommands status-line anchor not found')
else:
    print('[bot] /restart slash menu entry: already patched')

# ── Patch 6: /correct slash command (verification-failure logger) ─────
# Operator-typed `/correct <text>` appends a dated bullet to
# ~/project/memory/patterns/verification-failures.md. Use after the bot
# falsely claimed a skill/file/tool doesn't exist (or any verification
# slip) — the appended entry feeds into the cached prefix so the model
# sees its own historical failures and self-reinforces against repeating.
#
# Admin-only (gated on TELEGRAM_ADMIN_CHAT_ID, same as /restart). Patches
# the plugin source to register the command + adds /correct to the
# setMyCommands slash menu.
#
# Idempotency: marker check + remove old version before reinjecting, so
# the bot.sh runs idempotently on every container restart.
correct_marker = '// CC-BOT-PATCH: correct command v1'
content, _correct_removed = _strip_marked_blocks(content, '// ' + correct_marker)
if _correct_removed:
    changed = True

correct_inject = (
    '// ' + correct_marker + '\n'
    '{\n'
    '  const __adminChatId: string = String(process.env.TELEGRAM_ADMIN_CHAT_ID || "");\n'
    '  const __patternsFile: string = (process.env.HOME || "/home/coder") + "/project/memory/patterns/verification-failures.md";\n'
    '  bot.command("correct", async (ctx) => {\n'
    '    if (!__adminChatId || String(ctx.chat?.id) !== __adminChatId) return;\n'
    '    const raw = String(ctx.message?.text || "").replace(/^\\/correct(@\\S+)?\\s*/, "").trim();\n'
    '    if (!raw) {\n'
    '      try { await ctx.reply("Usage: /correct <what the bot got wrong>\\nExample: /correct claimed no skill for shopify-orders — exists at ~/.claude/skills/shopify-orders/"); } catch (_) {}\n'
    '      return;\n'
    '    }\n'
    '    try {\n'
    '      const { mkdir, appendFile, stat } = await import("fs/promises");\n'
    '      const path = await import("path");\n'
    '      await mkdir(path.dirname(__patternsFile), { recursive: true });\n'
    '      // If the file is new, seed minimal frontmatter so taste-recall picks it up.\n'
    '      let isNew = false;\n'
    '      try { await stat(__patternsFile); } catch { isNew = true; }\n'
    '      if (isNew) {\n'
    '        const header = "---\\npattern: avoid\\ntrigger: claiming absence (skill/file/tool) without verification\\nreason: bot has historically claimed it lacks capabilities it actually has; this log surfaces those misses so the model learns\\n---\\n\\n# Verification failures\\n\\nOperator-logged misses where the bot falsely claimed something didn\'t exist. Each entry: date + what was claimed vs. what was actually true.\\n\\n";\n'
    '        await appendFile(__patternsFile, header);\n'
    '      }\n'
    '      const today = new Date().toISOString().slice(0, 10);\n'
    '      await appendFile(__patternsFile, `- ${today}: ${raw}\\n`);\n'
    '      await ctx.reply(`Logged to memory/patterns/verification-failures.md:\\n${today}: ${raw}`);\n'
    '    } catch (e: any) {\n'
    '      try { await ctx.reply(`Could not append: ${e?.message || e}`); } catch (_) {}\n'
    '    }\n'
    '  });\n'
    '}\n\n'
)
# Anchor: same as /restart — just before plugin\'s first `bot.command("start"`.
pattern = re.compile(r"^(bot\.command\(['\"]start['\"])", re.MULTILINE)
new_content, n = pattern.subn(lambda m: correct_inject + m.group(1), content, count=1)
if n > 0:
    content = new_content
    changed = True
    print('[bot] correct command: patched (v1, pre-bot.on)')
else:
    print('[bot] WARNING: correct command pattern (bot.command start) not found')

# ── Patch 6b: append /correct to plugin's setMyCommands list ──────────
correct_menu_marker = "{ command: 'correct',"
if correct_menu_marker not in content:
    # Anchor after the /restart menu entry we already added in Patch 5b.
    plugin_menu_pattern_6b = re.compile(
        r"(\{ command: 'restart', description: '[^']+' \},)\n(\s+\],)",
        re.MULTILINE,
    )
    insertion = (
        r"\1\n"
        r"              { command: 'correct', description: 'Log a bot verification failure to memory (admin only)' },\n"
        r"\2"
    )
    new_content, n = plugin_menu_pattern_6b.subn(insertion, content, count=1)
    if n > 0:
        content = new_content
        changed = True
        print('[bot] /correct slash menu entry: patched into plugin setMyCommands')
    else:
        print('[bot] WARNING: /correct slash menu anchor (post-/restart) not found — slash menu may not show entry')
else:
    print('[bot] /correct slash menu entry: already patched')

# ── Patch 7: REMOVE the legacy /memory slash command ─────────────────
# Memory is now fully background/autonomous: reflect-distill auto-applies
# safe additive facts (concept pages ≥0.75, canonical cards ≥0.8) with an
# undo snapshot + audit trail, and RULES/AGENT_IDENTITY land only on
# cross-day recurrence — all with NO operator review. So the /memory
# review/approve/reject command is gone. This block only STRIPS any command
# a previous bot version injected (idempotent marker check); it never adds.
memory_marker = '// CC-BOT-PATCH: memory command v1'

content, _mem_removed = _strip_marked_blocks(content, memory_marker)
if _mem_removed:
    changed = True
    print(f'[bot] /memory command: removed {_mem_removed} injected block(s) (memory is now background-only)')

# ── Patch 7b: REMOVE /memory from the plugin's setMyCommands list ──────
# Strip the menu entry a previous bot version added, so the slash-menu no
# longer advertises /memory. Matches the injected line regardless of leading
# indentation; a no-op on bots that never had it.
memory_menu_line = re.compile(r"\n[ \t]*\{ command: 'memory', description: '[^']*' \},")
if memory_menu_line.search(content):
    content = memory_menu_line.sub('', content)
    changed = True
    print('[bot] /memory slash menu entry: removed')

if changed:
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
sys.exit(0)
PYEOF
        set -e
    done
else
    log "WARNING: Telegram plugin not found in marketplaces/ or cache/ — permissions may still prompt, sendPhoto may still fail"
fi

sleep 1

# === Wait for workspace-api to finish boot before claude reads .claude.json ===
# workspace-api/index.js runs migrateFromLegacy → syncMcpServers → broker
# SYNCHRONOUSLY BEFORE binding :3001. So /api/health responding = the
# mcpServers block in /home/bot/.claude.json is the final, post-sync
# state.
#
# Without this wait, bot.sh races wsapi at container boot — claude in
# tmux reads .claude.json once at startup and pins that snapshot in
# memory. If wsapi hadn't yet written the integration entries, claude
# sees only the entrypoint pre-seed (memory/playwright/reminders) and
# reports "MCP X not available" for every brokered integration until
# the next bot restart. First-time rollouts are the worst case (Phase 2
# + Phase 3 migration adds minutes to wsapi boot). Caught
# 2026-05-12 — claude reported "Gmail MCP not connected" while the
# config file on disk was correct.
#
# 180s deadline because first-time migrations can be slow. On a warm
# boot wsapi is usually ready in <10s. On WARN we still proceed —
# stale-mcpServers degrades the bot but doesn't crash it; a subsequent
# `pm2 restart bot` recovers, matching pre-fix behaviour.
log "Waiting for workspace-api ready (mcpServers sync complete)..."
WSAPI_DEADLINE=$(($(date +%s) + 180))
while [ "$(date +%s)" -lt "$WSAPI_DEADLINE" ]; do
    if curl -sf --max-time 2 http://localhost:3001/api/health >/dev/null 2>&1; then
        log "workspace-api ready, starting claude tmux"
        break
    fi
    sleep 2
done
if [ "$(date +%s)" -ge "$WSAPI_DEADLINE" ]; then
    log "WARN: workspace-api /api/health did not respond in 180s — claude may start with stale mcpServers (recover with: pm2 restart $SESSION)"
fi

# Force a fresh broker re-mint before claude reads .claude.json. wsapi only
# auto-syncs at its OWN boot; on a bot-only restart (Telegram /restart, PM2
# cycle) the BROKER_NONCE values already in .claude.json may be stale or
# expired (24h TTL), and the broker rejects every brokered MCP grant
# (Trello, GitHub, …) — web chat keeps working, integrations silently don't.
# This loopback-only call re-issues fresh nonces into the live broker Map and
# rewrites .claude.json so THIS claude session starts with valid grants.
if curl -sf --max-time 5 -X POST http://localhost:3001/api/internal/sync-mcp >/dev/null 2>&1; then
    log "Broker MCP grants re-minted (fresh nonces for this session)"
else
    log "WARN: broker re-mint call failed — claude may start with stale grants (recover: /restart)"
fi

# Re-source integrations.env now that wsapi has finished booting. wsapi's
# startup re-hydrates this file from the encrypted store (see
# rehydrateRuntimeFiles in workspace-api/lib/setup.js) — the initial source
# at the top of this script may have read a stale snapshot that the
# entrypoint migration block restored from .migrated.bak on container
# recreate (/home/bot/ isn't volume-mounted). Re-sourcing here guarantees
# the CLAUDE_CODE_OAUTH_TOKEN exported into claude --channels below is the
# one currently in the encrypted store, not the months-old migration backup.
if [ -f "$INTEGRATIONS_ENV" ]; then
    set -a; . "$INTEGRATIONS_ENV"; set +a
fi

# Clear the Telegram plugin's PID file before claude starts. /home/bot is
# a named volume, so the file persists across container recreations — old
# PIDs from a defunct container can collide with reused PIDs in the new
# one. The pid-lock guard's mtime check then triggers in the wrong mode
# (ageMs > 30_000 from the file's old mtime → "replacing stale poller"
# kills an UNRELATED process that happened to inherit the same PID).
# Wiping the file at startup forces a clean re-claim; the in-session
# mtime guard still handles the sibling-race case for plugin re-spawns
# within the same claude session. Diagnosed 2026-06-15 on canary.
PLUGIN_PID_FILE="$BOT_HOME/.claude/channels/telegram/bot.pid"
if [ -f "$PLUGIN_PID_FILE" ]; then
    rm -f "$PLUGIN_PID_FILE"
    log "Cleared stale plugin PID file at $PLUGIN_PID_FILE"
fi

log "Starting Claude Code channel in tmux..."
# tmux spawns its pane via the user's login shell — bot uid (Phase-3) has
# /usr/sbin/nologin set in /etc/passwd, so without an explicit SHELL the
# shell `exec`'d inside the pane returns immediately, the pane process
# exits, the tmux session dies, and claude never gets to start. Forcing
# SHELL=/bin/bash here is cheaper than changing the user's login shell
# globally (which would also let `su - bot` succeed, expanding the attack
# surface for no benefit). Diagnosed 2026-05-30 on canary.
export SHELL=/bin/bash

# ── Memory prefix injection ───────────────────────────────────────────
# Fetch the cached memory prefix from wsapi (same content the web side
# gets via claude.js's inline buildCachedPrefix() call) and write it to a
# file passed to claude via --append-system-prompt-file. Without this,
# the bot starts with global-claude.md + project CLAUDE.md only — the
# memory cards (USER_PROFILE, USER_PREFERENCES, RULES, AGENT_IDENTITY,
# AGENT_TOOLS, INDEX, RECENT_WEB, RECENT_TELEGRAM, ≈15k tokens) are NOT
# loaded. global-claude.md tells the model "you have them in your prefix,
# don't re-read at session start" — gaslit. After this fix the bot has
# the same memory the web side has at session start.
#
# The prefix is static for the lifetime of the tmux session. If memory
# cards change (operator edits, reflect-apply applies a draft), the next
# /restart picks up the fresh prefix. RECENT_*.md snapshots stale during
# the session too — bot's tmux already carries the live conversation in
# its own process memory, so this is acceptable.
PREFIX_FILE="$BOT_HOME/.claude/memory-prefix.txt"
CLAUDE_EXTRA_ARGS=""
if command -v curl >/dev/null 2>&1; then
    if curl -sS --max-time 5 --fail "http://localhost:3001/api/memory/prefix?raw=1" -o "$PREFIX_FILE" 2>/dev/null && [ -s "$PREFIX_FILE" ]; then
        CLAUDE_EXTRA_ARGS="--append-system-prompt-file '$PREFIX_FILE'"
        chmod 644 "$PREFIX_FILE" 2>/dev/null || true
        log "Memory prefix fetched: $(wc -c < "$PREFIX_FILE") bytes → $PREFIX_FILE"
    else
        log "WARN: failed to fetch memory prefix from wsapi (:3001); bot will start without it"
        rm -f "$PREFIX_FILE" 2>/dev/null || true
    fi
fi

# ── Operator identity (team mode) ─────────────────────────────────────
# Export the operator's slug so the brain's web_send_message relays carry
# from=<operator>: that's what gives the RECIPIENT an attributed chat title
# AND toast ("📨 Message from <op>") instead of an anonymous bubble (F3).
# Also IDE_ACTOR_IS_ADMIN=1 so scope-guard.mjs short-circuits (its line 109)
# and the slug NEVER fences the operator brain out of shared/other files —
# the brain keeps full access exactly as before. The slug is FETCHED from
# wsapi (not derived in bash) so it can't drift from team.js's slugify /
# uniqueSlug. Solo / non-team → the endpoint returns teamMode:false and we
# leave the env unset (legacy full-access behaviour, unchanged). Exported
# BEFORE the tmux launch so the claude process + its MCP servers inherit it.
if command -v curl >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
    OP_JSON=$(curl -sS --max-time 5 --fail "http://localhost:3001/api/internal/operator-identity" 2>/dev/null || true)
    if [ -n "$OP_JSON" ]; then
        OP_SLUG=$(printf '%s' "$OP_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j&&j.teamMode&&j.slug?String(j.slug):"")}catch{process.stdout.write("")}})' 2>/dev/null || true)
        if printf '%s' "$OP_SLUG" | grep -qE '^[a-z0-9-]+$'; then
            export IDE_ACTOR_SLUG="$OP_SLUG"
            export IDE_ACTOR_IS_ADMIN=1
            log "Operator identity: IDE_ACTOR_SLUG=$OP_SLUG IDE_ACTOR_IS_ADMIN=1 (relays attributed; scope-guard admin-passthrough)."
        else
            log "Operator identity: not in team mode (or no slug) — leaving IDE_ACTOR_SLUG unset (solo/legacy)."
        fi
    fi
fi

# Only load the Telegram channel plugin when we actually have a token —
# without one the plugin process exits on startup with "TELEGRAM_BOT_TOKEN
# required" and claude loses the MCP connection (diagnosed 2026-06-15 on
# canary). For TG-less clients, claude still runs in the tmux session
# (web-channel-mcp + reminder-monitor's tmux send-keys give it I/O), it
# just doesn't have the Telegram listener loop.
CHANNELS_ARG=""
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
    CHANNELS_ARG="--channels plugin:telegram@claude-plugins-official"
    # When the bot has Telegram available, default new reminders to
    # 'all' — the bot replies on TG (its primary surface here) and the
    # web-mirror.sh PostToolUse hook copies the outbound onto the web
    # bubble surface in parallel. Explicit channel=web/telegram tool args
    # still win.
    export REMINDER_DEFAULT_CHANNEL=all
    log "Launching claude with Telegram channel plugin. REMINDER_DEFAULT_CHANNEL=all."
else
    # No Telegram: the bot's only outbound surface is web_send_message.
    # Default new reminders to 'web' so reminder-monitor routes the
    # trigger with channel=web and the bot picks the web reply tool.
    export REMINDER_DEFAULT_CHANNEL=web
    log "TELEGRAM_BOT_TOKEN not set — launching claude without channel plugin (web/tmux I/O only). REMINDER_DEFAULT_CHANNEL=web."
fi
tmux -L "$SESSION" new-session -d -s "$SESSION" \
    "cd $PROJECT_DIR && claude --dangerously-skip-permissions --add-dir '$CLAUDE_CONFIG_DIR' $CHANNELS_ARG $CLAUDE_EXTRA_ARGS"

# ── Post-tmux-start settings re-merge ────────────────────────────────────
# `claude --dangerously-skip-permissions` writes skipDangerousModePermission
# Prompt to settings.json on its first start, which on canary 2026-06-04
# was observed to happen ~7s after tmux launch — AFTER the pre-tmux merge
# above. That overwrites our hooks + autoMemoryEnabled block again. We
# re-merge in a background watchdog: initially every 5s for 30s (catches
# the first-run write), then every 5min as a safety net for any later
# CC-side rewrites (e.g. plugin reloads). The merge is idempotent — if
# the file already has our keys, jq merge is a no-op.
(
    # Catch the first-run race
    for i in $(seq 1 6); do
        sleep 5
        merge_bot_settings "post-tmux-watchdog #$i"
    done
    # Long-term safety net
    while tmux -L "$SESSION" has-session -t "$SESSION" 2>/dev/null; do
        sleep 300
        merge_bot_settings "periodic"
    done
) &

# ── Memory prefix refresh watchdog ──────────────────────────────────────
# The --append-system-prompt-file content is loaded by claude ONCE at tmux
# start; CC doesn't re-read it mid-session. But the RECENT_WEB.md /
# RECENT_TELEGRAM.md cards inside that prefix go stale as new messages
# come in. The model can fall back to mcp__workspace-api__recent_messages
# (live read from disk) via the `recent-context` skill — but for that to
# work, /home/bot/.claude/memory-prefix.txt also needs to be kept fresh
# so anyone who Reads it directly (operator debugging, another tool, the
# model via the prefix path itself) sees recent data. Refresh once every
# 5 min from wsapi /api/memory/prefix?raw=1 while tmux session is alive.
#
# Note: writing the file does NOT make claude reload its in-memory prefix
# (that requires a /restart). The freshness here is only for callers who
# Read the file path. The live MCP tool is the real fix for the model side.
(
    while tmux -L "$SESSION" has-session -t "$SESSION" 2>/dev/null; do
        sleep 300
        if command -v curl >/dev/null 2>&1; then
            TMP=$(mktemp 2>/dev/null) || continue
            if curl -sS --max-time 5 --fail "http://localhost:3001/api/memory/prefix?raw=1" -o "$TMP" 2>/dev/null && [ -s "$TMP" ]; then
                mv "$TMP" "$BOT_HOME/.claude/memory-prefix.txt"
                chmod 644 "$BOT_HOME/.claude/memory-prefix.txt" 2>/dev/null || true
            else
                rm -f "$TMP"
            fi
        fi
    done
) &

# Restart-signal watcher — polls mtime every 2s. When wsapi touches the
# signal file, kill the tmux session; the monitor loop further down exits,
# the script ends, PM2 cycles the bot with whatever new creds wsapi just
# wrote (.credentials.json, integrations.env, .claude.json, etc.).
#
# Why this exists: routing restart through Telegram (the previous design)
# required the bot to currently be polling a TG token that matched the
# message we sent. That failed for every interesting case (fresh activate,
# token rotation, setup-token rotation before TG configured). The file
# signal has zero dependency on integration state.
(
    while tmux -L "$SESSION" has-session -t "$SESSION" 2>/dev/null; do
        sleep 2
        current=$(stat -c %Y "$RESTART_SIGNAL_FILE" 2>/dev/null || echo 0)
        if [ "$current" != "$RESTART_SIGNAL_BASELINE" ] && [ "$current" -gt 0 ]; then
            log "Restart signal received via $RESTART_SIGNAL_FILE ($RESTART_SIGNAL_BASELINE → $current)"
            tmux -L "$SESSION" kill-session -t "$SESSION" 2>/dev/null || true
            break
        fi
    done
) &

# 5. Wait for plugin to be ready, auto-accepting prompts along the way
(
    READY=0
    for i in $(seq 1 20); do
        sleep 3
        PANE=$(tmux -L "$SESSION" capture-pane -t "$SESSION" -p 2>/dev/null || echo "")

        # Readiness, two signals (either counts):
        #  - the "Listening for channel messages" banner (claude-code ≤2.1.128;
        #    2.1.207 no longer prints it — caught 2026-07-12 when the online
        #    notification silently stopped firing after the CLI bump), or
        #  - the plugin's OWN pid file with a live process behind it — the
        #    poller writes it on startup, version-independent (the launch
        #    section above clears any stale copy, so its existence here means
        #    THIS session's plugin came up).
        PLUGIN_PID=$(cat "$PLUGIN_PID_FILE" 2>/dev/null || echo "")
        if echo "$PANE" | grep -q "Listening for channel messages" \
           || { [ -n "$PLUGIN_PID" ] && kill -0 "$PLUGIN_PID" 2>/dev/null; }; then
            log "Telegram plugin is up (pid=${PLUGIN_PID:-pane-banner})."
            notify "Bot is online and listening."
            READY=1
            break
        fi

        # Bypass-Permissions warning screen (shown on first --dangerously-skip-
        # permissions launch on a fresh bot home). Default highlight is on
        # "No, exit" so plain Enter kills claude. Send "2" to select+confirm
        # "Yes, I accept" directly. Once accepted, claude remembers it and
        # this screen doesn't re-appear, but we re-handle every restart for
        # safety (e.g. bot home wiped by entrypoint cleanup). Must come before
        # the generic "Enter to confirm" matcher below — that one would match
        # this screen too and submit the wrong default.
        if echo "$PANE" | grep -qi "Bypass Permissions mode"; then
            tmux -L "$SESSION" send-keys -t "$SESSION" "2"
            log "Auto-accepted Bypass-Permissions warning (attempt $i)"
        elif echo "$PANE" | grep -qiE "trust this folder|trust this project|Enter to confirm|theme"; then
            tmux -L "$SESSION" send-keys -t "$SESSION" Enter
            log "Auto-accepted prompt (attempt $i)"
        fi

        if echo "$PANE" | grep -qiE "not logged in|expired|sign in"; then
            log "ERROR: login required"
            notify "Cannot start — sign-in required."
            exit 1
        fi
    done
    # Never give up silently: the 2026-07-12 CLI bump hid readiness for a day
    # because this loop timed out with no trace.
    if [ "$READY" != "1" ]; then
        log "WARN: readiness not confirmed within 60s (no banner, no live plugin pid) — bot may still come up; check the tmux pane"
    fi
) &

# ── Telegram plugin liveness watchdog ────────────────────────────────────
# The channel plugin is an MCP-server child of claude. It sometimes dies —
# SIGINT/disconnect/crash — and claude does NOT reconnect it. The session
# stays up but the Telegram channel is DEAD: inbound messages never arrive
# and nothing is sent. Seen silently for hours on two deployments
# (2026-07-13, canary + one prod client) until a manual `docker restart`. This
# watchdog detects a dead plugin and restarts the session (kill tmux → PM2
# respawns bot.sh → fresh claude + reconnected plugin) so the channel heals
# itself instead of waiting for the operator to notice.
#
# Only armed when the Telegram channel is expected (token → CHANNELS_ARG).
# It first waits to SEE the plugin alive (so it never fights the startup
# window before the pid file exists), then treats `grace` consecutive dead
# reads as a real death — long enough to ride out the plugin's own
# poller-replacement (pid-lock) reconnect, short enough to heal fast.
if [ -n "$CHANNELS_ARG" ]; then
(
    plugin_alive() {
        local pid cmd
        pid=$(cat "$PLUGIN_PID_FILE" 2>/dev/null) || return 1
        [ -n "$pid" ] || return 1
        kill -0 "$pid" 2>/dev/null || return 1
        # pid-reuse guard: if the pid was recycled by an unrelated process,
        # the channel is really dead. Trust kill -0 when cmdline is unreadable.
        cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null) || return 0
        case "$cmd" in
            ""|*telegram*|*node*|*bun*|*server.ts*) return 0 ;;
            *) return 1 ;;
        esac
    }

    # Phase 1 — wait until the plugin is first seen alive (bounded ~200s).
    seen=0
    for _ in $(seq 1 40); do
        sleep 5
        tmux -L "$SESSION" has-session -t "$SESSION" 2>/dev/null || exit 0
        if plugin_alive; then seen=1; break; fi
    done
    if [ "$seen" != "1" ]; then
        log "plugin-watchdog: plugin never came up in ~200s — leaving recovery to the readiness path, not arming."
        exit 0
    fi
    log "plugin-watchdog: Telegram plugin confirmed alive — monitoring channel health."

    # Phase 2 — monitor. `grace` consecutive dead reads (~60s) → restart.
    dead=0
    while tmux -L "$SESSION" has-session -t "$SESSION" 2>/dev/null; do
        sleep 30
        if plugin_alive; then
            dead=0
        else
            dead=$((dead + 1))
            log "plugin-watchdog: Telegram plugin not alive (strike ${dead}/2)"
            if [ "$dead" -ge 2 ]; then
                log "plugin-watchdog: Telegram channel is DOWN — restarting session to reconnect the plugin."
                notify "Telegram channel dropped — auto-restarting to reconnect." 2>/dev/null || true
                tmux -L "$SESSION" kill-session -t "$SESSION" 2>/dev/null || true
                exit 0
            fi
        fi
    done
) &
fi

# 6. Monitor: keep script alive + auto-dismiss known interactive blockers.
# PM2 sees the bot alive via this loop. If tmux dies, script exits → PM2 restarts.
#
# Auto-dismiss pattern: every 30s capture the pane and send Enter when Claude
# is sitting on a known interactive prompt that would otherwise wedge the bot
# until manual intervention. Currently handles:
#   • /rate-limit-options menu — Claude pauses with two options when the OAuth
#     token's plan limit is exhausted. Default option ("Stop and wait for
#     limit to reset") is what we want anyway, so Enter dismisses it and the
#     bot resumes processing the next message after reset.
while tmux -L "$SESSION" has-session -t "$SESSION" 2>/dev/null; do
    sleep 30
    PANE=$(tmux -L "$SESSION" capture-pane -t "$SESSION" -p 2>/dev/null || echo "")
    if echo "$PANE" | grep -q "rate-limit-options"; then
        tmux -L "$SESSION" send-keys -t "$SESSION" Enter
        log "Auto-dismissed rate-limit menu"
    fi
done

log "Bot session ended."
