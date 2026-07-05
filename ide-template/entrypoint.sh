#!/bin/bash
# --- ROOT WRAPPER: Fix volume permissions and drop privileges ---
if [ "$(id -u)" = "0" ]; then
    echo "[entrypoint] Starting as root to fix volume permissions..."
    # Fix ownership of potential volume mount points. Docker bind mounts +
    # named volumes default to root-owned at first creation, so PM2 (running
    # as `coder`) can't write log files there. Without this, workspace-api
    # crashloops with EACCES on /home/coder/.${BOT_NAME}/workspace-api-out.log.
    chown -R coder:coder /home/coder/.claude /home/coder/.pm2 2>/dev/null || true
    # Per-bot logs dir — name comes from BOT_NAME at runtime (the
    # docker-compose.yml mount target uses the same variable). Cover both
    # the current name and any legacy names a previous deploy may have
    # populated as a side-effect of changing BOT_NAME (rare but possible).
    for d in "/home/coder/.${BOT_NAME:-bot}" /home/coder/.claude-bot /home/coder/.bot; do
        [ -e "$d" ] && chown -R coder:coder "$d" 2>/dev/null || true
    done

    # ─── Privilege-isolation: wsapi (1001) + mcp (1002) plumbing ────────────
    # Encrypted credential store + AES master key live OUTSIDE PROJECT_DIR
    # (see /var/wsapi-store) so the coder uid (1000) and the mcp uid (1002)
    # cannot read either. workspace-api at uid 1001 is the only process
    # that decrypts.
    mkdir -p /var/wsapi-store
    chown 1001:1001 /var/wsapi-store
    # Mode 0711: owner full, others traverse-only (+x). Originally 0700 but
    # that blocked mcp uid 1002 from reaching the broker UDS at
    # /var/wsapi-store/run/broker.sock — Linux requires +x on every path
    # component, and mcp's group membership in wsapi-broker (which gates
    # /var/wsapi-store/run/) is useless if mcp can't even traverse the
    # parent. Files inside this dir stay restricted by their own per-file
    # modes (credentials.json 0600 wsapi-only, audit.log 0600 wsapi-only,
    # .migrated 0644 wsapi). +x on the dir does NOT grant read/list — mcp
    # can only navigate to a known sub-path, not enumerate.
    #
    # Caught on 2026-05-11 re-audit: poked at /var/wsapi-store/run/broker.sock
    # connect as mcp uid and got EACCES. MCPs (grok, shopify, etc.) had
    # silently been unable to fetch their credentials post-Phase-2.
    chmod 0711      /var/wsapi-store
    # Master key — bind-mount target. workspace-api reads it; nobody else.
    [ -f /run/secrets/integrations.key ] && chown 1001:1001 /run/secrets/integrations.key 2>/dev/null || true
    [ -f /run/secrets/integrations.key ] && chmod 0400 /run/secrets/integrations.key 2>/dev/null || true
    # Broker UDS dir — created here so wsapi-uid can bind a socket without
    # having write access to /var/run at large.
    mkdir -p /var/wsapi-store/run
    chown 1001:1101 /var/wsapi-store/run
    chmod 2770      /var/wsapi-store/run
    # Secure-file dir — workspace-api writes per-integration config files
    # here that the corresponding MCP needs to read but the bot must not.
    # Today only email-imap accounts.json. Mode 2770 with setgid so files
    # inherit group=wsapi-broker; wsapi (1001) writes, mcp (1002) reads,
    # coder (1000) cannot enter (group not granted).
    mkdir -p /var/wsapi-store/files
    chown 1001:1101 /var/wsapi-store/files
    chmod 2770      /var/wsapi-store/files

    # Docs Comments interactive-login profile — persistent across container
    # restarts. wsapi (1001) runs chromium during the noVNC-mediated login
    # flow → writes user-data-dir here. docs-comments-mcp (uid 1002) later reads
    # the same dir on every add_comment tool call. Shared via the
    # `workspace` group (gid 1100) — both uids are members. setgid bit so
    # files chromium creates inside inherit group=workspace.
    mkdir -p /var/wsapi-store/docs-comments-profile
    chown 1001:1100 /var/wsapi-store/docs-comments-profile
    chmod 2770      /var/wsapi-store/docs-comments-profile

    # PROJECT_DIR shared between coder + wsapi + mcp via the `workspace`
    # group. setgid bit on every dir so newly-created files inherit the
    # group; g+rwx so all three can read/write.
    chgrp -R workspace /home/coder/project 2>/dev/null || true
    chmod  -R g+rwX    /home/coder/project 2>/dev/null || true
    find /home/coder/project -type d -exec chmod g+s {} \; 2>/dev/null || true

    # /home/coder itself is mode 0700 owner=coder. wsapi + mcp need to
    # TRAVERSE it to reach PROJECT_DIR — Linux requires +x on every path
    # component. `o+x` grants traversal to everyone without granting
    # listing (no `r`); contents of /home/coder remain restricted by
    # their own per-file modes (e.g. ~/.claude/.credentials.json stays
    # 0600 coder-readable only). Without this fix, wsapi gets EACCES on
    # any /home/coder/project/* path even though PROJECT_DIR itself is
    # group-shared.
    chmod o+x /home/coder 2>/dev/null || true

    # Specific shared files that BOTH coder (bot/cli) and wsapi (workspace-api)
    # need to read+write. Each gets chgrp workspace + g+rw so members of
    # the workspace group (which includes both uids) can use them. Without
    # this, workspace-api at uid 1001 hits EACCES every time it tries to
    # update one of these.
    #
    #   .claude.json                — Claude CLI config; wsapi rewrites the
    #                                 mcpServers block on every integration
    #                                 activate; coder/bot reads it via
    #                                 claude --channels.
    #   .${BOT_NAME}/integrations.env — bot's shell-source'd env file;
    #                                  wsapi writes (writeFiles shell-env
    #                                  format), coder/bot.sh reads.
    #   .egress/                    — egress allowlist file dir; bind-mounted
    #                                  from /srv/<ide>/egress/. wsapi writes
    #                                  the txt; host script reads as root.
    BOT_HOME_DIR="/home/coder/.${BOT_NAME:-bot}"
    for shared_path in \
            /home/coder/.claude.json \
            /home/coder/.claude.json.persistent \
            "$BOT_HOME_DIR/integrations.env"; do
        if [ -e "$shared_path" ]; then
            chgrp workspace "$shared_path" 2>/dev/null || true
            chmod g+rw      "$shared_path" 2>/dev/null || true
        fi
    done
    # The bot's home dir itself needs to be group-traversable + writable
    # so wsapi can CREATE integrations.env if it doesn't exist yet.
    if [ -d "$BOT_HOME_DIR" ]; then
        chgrp workspace "$BOT_HOME_DIR" 2>/dev/null || true
        chmod g+rwx     "$BOT_HOME_DIR" 2>/dev/null || true
        chmod g+s       "$BOT_HOME_DIR" 2>/dev/null || true
    fi
    # Same for .claude/ — wsapi writes ~/.claude/.credentials.json from
    # setClaudeToken (hydrateClaudeCredentials).
    if [ -d /home/coder/.claude ]; then
        chgrp -R workspace /home/coder/.claude 2>/dev/null || true
        chmod  -R g+rwX    /home/coder/.claude 2>/dev/null || true
        find /home/coder/.claude -type d -exec chmod g+s {} \; 2>/dev/null || true
    fi

    # ─── Phase-3 (H4 closure): bot uid 1003 plumbing ────────────────────────
    # The bot's home (/home/bot) is owned bot:botshare 0770 from the
    # Dockerfile useradd. Ensure it survives container recreate (Docker
    # named volume /home/bot/) — if the volume mounted empty, restore the
    # ownership the Dockerfile set up.
    if [ -d /home/bot ]; then
        chown bot:botshare /home/bot 2>/dev/null || true
        # Mode 2771: owner+group full, others traverse-only (+x), setgid.
        # Setgid bit makes files CREATED in this dir inherit
        # group=botshare instead of the creating uid's primary group.
        # Critical for /home/bot/.claude.json which wsapi (uid 1001,
        # primary group wsapi) writes via CLAUDE_CONFIG_PATH — without
        # setgid the file lands group=wsapi and bot (uid 1003) cannot
        # read it. The +x for others lets coder uid 1000 STAT files
        # here (e.g. entrypoint's gate `[ -f /home/bot/.claude/.creds ]`)
        # without granting read or list — files inside stay 0660 botshare.
        chmod 2771          /home/bot 2>/dev/null || true
        # Dirs that downstream code expects to exist at start, with the
        # right ownership for wsapi (uid 1001, in botshare) to write into
        # and bot (uid 1003) to read.
        for d in /home/bot/.claude /home/bot/.${BOT_NAME:-bot} /home/bot/.npm-global /home/bot/.cache; do
            mkdir -p "$d"
            chown bot:botshare "$d" 2>/dev/null || true
            # 2771 = owner+group full, others traverse-only, setgid.
            # entrypoint's credential gate must be able to STAT files
            # here from coder uid even though it can't READ them; setgid
            # ensures newly-created files inherit group=botshare.
            chmod 2771          "$d" 2>/dev/null || true
        done

        # Fix-up: existing integrations.env may have been written by an
        # earlier wsapi build with mode 0640 (group r-only). wsapi (in
        # group botshare but not the file owner) then can't overwrite it
        # on the next migrate cycle — it loops forever logging EACCES.
        # Force 0660 (group rw) so wsapi can update it as a group member.
        if [ -f /home/bot/.${BOT_NAME:-bot}/integrations.env ]; then
            chown bot:botshare /home/bot/.${BOT_NAME:-bot}/integrations.env 2>/dev/null || true
            chmod 0660         /home/bot/.${BOT_NAME:-bot}/integrations.env 2>/dev/null || true
        fi

        # /home/bot/.claude.json — the file claude (uid 1003) reads at
        # tmux start and the file workspace-api (uid 1001) writes to via
        # CLAUDE_CONFIG_PATH. Pre-seed it here, as root, BEFORE PM2 fires
        # so wsapi's startup syncMcpServers and bot.sh's first-boot seed
        # don't race over file creation.
        #
        # Source priority:
        #   1. /home/coder/.claude/.claude.json.persistent — the periodic
        #      backup that mirrors a known-good post-run state (preserves
        #      theme, recent dirs, hasCompletedOnboarding=true if claude
        #      ever ran to completion on this volume before).
        #   2. /home/coder/.claude.json — the live config file (may have
        #      stale mcpServers but otherwise complete).
        #   3. Minimal stub with just hasCompletedOnboarding so the welcome
        #      dialog doesn't block first-boot.
        #
        # Idempotent: only seeds when the target is missing. wsapi
        # syncMcpServers later rewrites only the mcpServers block (the
        # rest of the file is preserved via read-modify-write).
        if [ ! -f /home/bot/.claude.json ]; then
            if [ -f /home/coder/.claude/.claude.json.persistent ]; then
                cp /home/coder/.claude/.claude.json.persistent /home/bot/.claude.json
                echo "[entrypoint] Pre-seeded /home/bot/.claude.json from .persistent"
            elif [ -f /home/coder/.claude.json ]; then
                cp /home/coder/.claude.json /home/bot/.claude.json
                echo "[entrypoint] Pre-seeded /home/bot/.claude.json from /home/coder/.claude.json"
            else
                echo '{"hasCompletedOnboarding":true}' > /home/bot/.claude.json
                echo "[entrypoint] Pre-seeded /home/bot/.claude.json with minimal stub"
            fi
        fi
        # Defensive stamp — covers seed-from-source-that-lacks-flag plus
        # any older copy that somehow lost the flag.
        python3 - <<'PY' 2>/dev/null || true
import json, pathlib
f = pathlib.Path('/home/bot/.claude.json')
try:
    d = json.loads(f.read_text() or '{}')
except Exception:
    d = {}
if not d.get('hasCompletedOnboarding'):
    d['hasCompletedOnboarding'] = True
    f.write_text(json.dumps(d, indent=2))
    print('[entrypoint] Stamped hasCompletedOnboarding=true in /home/bot/.claude.json')
PY
        # Force group=botshare + 0660 every boot. Pre-Phase-3 the seed
        # came from /home/coder/.claude.json (group=workspace mode g+rw)
        # which left the file COder-readable inside /home/bot — H4 model
        # inconsistency. Forcing 0660 botshare here closes that gap
        # whether the file was seeded above or written later by wsapi.
        chown bot:botshare /home/bot/.claude.json 2>/dev/null || true
        chmod 0660         /home/bot/.claude.json 2>/dev/null || true

        # Force-write the playwright mcpServers entry into /home/bot/.claude.json.
        # The later python heredoc that builds the `managed` dict runs as
        # coder uid and writes to /home/coder/.claude.json — which the bot
        # (uid 1003 with HOME=/home/bot) does NOT read. wsapi-managed entries
        # land in /home/bot/.claude.json via syncMcpServers, but wsapi only
        # touches brokered integrations from the catalog; playwright is
        # plugin-style (no broker) and falls through that filter.
        #
        # So we patch /home/bot/.claude.json directly from the root block,
        # which has write access regardless of file ownership. Force the
        # args (--user-data-dir + --proxy-server) every boot so they survive
        # a stale .claude.json carried in from a previous deploy that didn't
        # carry these flags.
        #
        # --user-data-dir: /tmp/playwright-mcp-data is world-writable
        #   tmpfs. @playwright/mcp defaults profile-dir to a path under
        #   PLAYWRIGHT_BROWSERS_PATH which is read-only.
        # --proxy-server: Chromium itself ignores HTTPS_PROXY env (that's
        #   for Node fetch). We have to push the proxy URL via the CLI flag
        #   that @playwright/mcp converts to chromium's --proxy-server arg.
        python3 - <<'PY' || true
import json, os
p = '/home/bot/.claude.json'
try:
    d = json.load(open(p))
except Exception:
    d = {}
d.setdefault('mcpServers', {})
d['mcpServers']['playwright'] = {
    'command': '/home/coder/.npm-global/bin/playwright-mcp',
    'args': [
        '--headless',
        '--browser', 'chrome',
        '--no-sandbox',
        '--user-data-dir', '/tmp/playwright-mcp-data',
        '--proxy-server', 'http://egress-proxy:3130',
        '--executable-path', '/opt/playwright-browsers/chromium-1223/chrome-linux64/chrome',
    ],
}
# Web Channel MCP — always-on reply tool that pushes into the
# workspace UI's notification stream. Force-written here for the
# same reason as playwright above: wsapi (running as coder uid)
# writes /home/coder/.claude.json's mcpServers, but the bot's
# Claude (uid 1003, HOME=/home/bot) reads /home/bot/.claude.json.
# Without this block the MCP only registers on the coder side and
# the bot never gains the web_send_message tool — caught on canary
# 2026-06-15.
d['mcpServers']['web-channel'] = {
    'command': 'node',
    'args': ['/opt/ide/apps/web-channel-mcp/index.js'],
    'env': {
        'WORKSPACE_API_PORT': os.environ.get('WORKSPACE_API_PORT', '3001'),
    },
}
with open(p, 'w') as f:
    json.dump(d, f, indent=2)
print('[entrypoint] Forced playwright + web-channel mcpServers entries in /home/bot/.claude.json')
PY
        chown bot:botshare /home/bot/.claude.json 2>/dev/null || true
        chmod 0660         /home/bot/.claude.json 2>/dev/null || true

        # Materialize the Telegram plugin into /home/bot/.claude/plugins/.
        # Source lives at /opt/ide/plugins-src (cloned + bun-installed at
        # image build time — see Dockerfile LAYER 2b.5). We copy + write
        # installed_plugins.json + known_marketplaces.json with paths
        # pointing at /home/bot/, so claude --channels finds the plugin
        # at the right location and `claude plugins install` doesn't get
        # called at runtime (it would otherwise try to clone github,
        # which the egress allow-list rightly refuses).
        #
        # Idempotent — only writes when the target version dir doesn't
        # exist yet, so container restarts after a manual user-side
        # plugin tweak don't blow it away. installed_plugins.json +
        # known_marketplaces.json are rewritten every boot to guarantee
        # paths stay aligned with HOME=/home/bot regardless of what
        # bot.sh's overlay-copy from /home/coder might have dropped in.
        PLUGIN_SRC=/opt/ide/plugins-src/external_plugins/telegram
        if [ -d "$PLUGIN_SRC" ]; then
            # plugin.json may be in .claude-plugin/ subdir or absent —
            # default version pin keeps the cache layout deterministic
            # even if the upstream marketplace skips per-plugin meta.
            PLUGIN_VER=$(python3 -c "import json; print(json.load(open('$PLUGIN_SRC/.claude-plugin/plugin.json'))['version'])" 2>/dev/null || echo "0.0.6")
            CACHE_DIR="/home/bot/.claude/plugins/cache/claude-plugins-official/telegram/$PLUGIN_VER"
            MARKET_DIR="/home/bot/.claude/plugins/marketplaces/claude-plugins-official"
            if [ ! -d "$CACHE_DIR" ]; then
                mkdir -p "$CACHE_DIR"
                cp -a "$PLUGIN_SRC/." "$CACHE_DIR/"
            fi
            if [ ! -d "$MARKET_DIR/.claude-plugin" ]; then
                mkdir -p "$MARKET_DIR"
                cp -a /opt/ide/plugins-src/. "$MARKET_DIR/"
            fi
            mkdir -p /home/bot/.claude/plugins
            cat > /home/bot/.claude/plugins/installed_plugins.json <<INSTALLED_EOF
{
  "version": 2,
  "plugins": {
    "telegram@claude-plugins-official": [
      {
        "scope": "user",
        "installPath": "$CACHE_DIR",
        "version": "$PLUGIN_VER",
        "installedAt": "2026-05-11T00:00:00.000Z",
        "lastUpdated": "2026-05-11T00:00:00.000Z",
        "gitCommitSha": "embedded-at-build"
      }
    ]
  }
}
INSTALLED_EOF
            cat > /home/bot/.claude/plugins/known_marketplaces.json <<MARKETS_EOF
{
  "claude-plugins-official": {
    "source": { "source": "github", "repo": "anthropics/claude-plugins-official" },
    "installLocation": "$MARKET_DIR",
    "lastUpdated": "2026-05-11T00:00:00.000Z"
  }
}
MARKETS_EOF
            chown -R bot:botshare /home/bot/.claude/plugins 2>/dev/null || true
            chmod -R g+rwX        /home/bot/.claude/plugins 2>/dev/null || true
            find /home/bot/.claude/plugins -type d -exec chmod g+s {} \; 2>/dev/null || true
            echo "[entrypoint] Telegram plugin materialized at $CACHE_DIR"
        fi
    fi
    # Migrate the Claude OAuth token + bot integrations.env from
    # /home/coder/ (pre-Phase-3 location, coder-readable) to /home/bot/
    # (bot-only via botshare group, coder-blocked). Idempotent on a flag
    # file; copies LIVE files first, falls back to .migrated.bak for
    # redeploy recovery (same pattern as the wsapi-store migration above).
    BOT_HOME_NEW="/home/bot"
    BOT_HOME_OLD="/home/coder/.${BOT_NAME:-bot}"
    BOT_NAME_VAL="${BOT_NAME:-bot}"
    if [ ! -f "$BOT_HOME_NEW/.migrated" ]; then
        # Claude credentials.json (OAuth token).
        if [ ! -f "$BOT_HOME_NEW/.claude/.credentials.json" ]; then
            for src in "/home/coder/.claude/.credentials.json" \
                       "/home/coder/.claude/.credentials.json.migrated.bak"; do
                if [ -f "$src" ]; then
                    cp -a "$src" "$BOT_HOME_NEW/.claude/.credentials.json"
                    chown bot:botshare "$BOT_HOME_NEW/.claude/.credentials.json"
                    chmod 0640         "$BOT_HOME_NEW/.claude/.credentials.json"
                    # Move the live coder copy aside so coder can't read
                    # it any more. Keep .migrated.bak for re-recovery.
                    if [ "$src" = "/home/coder/.claude/.credentials.json" ]; then
                        mv "$src" "${src}.migrated.bak"
                    fi
                    echo "[entrypoint] Migrated Claude credentials from $src to bot home"
                    break
                fi
            done
        fi
        # Bot integrations.env (Telegram bot token + CLAUDE_CODE_OAUTH_TOKEN).
        # Mode 0660 (group rw, not just r): wsapi (in botshare) must be able
        # to OVERWRITE this file on every restart — see runtime.js comment.
        if [ ! -f "$BOT_HOME_NEW/.${BOT_NAME_VAL}/integrations.env" ]; then
            for src in "$BOT_HOME_OLD/integrations.env" \
                       "${BOT_HOME_OLD}/integrations.env.migrated.bak"; do
                if [ -f "$src" ]; then
                    cp -a "$src" "$BOT_HOME_NEW/.${BOT_NAME_VAL}/integrations.env"
                    chown bot:botshare "$BOT_HOME_NEW/.${BOT_NAME_VAL}/integrations.env"
                    chmod 0660         "$BOT_HOME_NEW/.${BOT_NAME_VAL}/integrations.env"
                    if [ "$src" = "$BOT_HOME_OLD/integrations.env" ]; then
                        mv "$src" "${src}.migrated.bak"
                    fi
                    echo "[entrypoint] Migrated bot integrations.env from $src to bot home"
                    break
                fi
            done
        fi
        # Always force 0660 on the live file in case an earlier deploy
        # migrated it with 0640 (group r-only) and left wsapi unable to
        # update it on restart.
        if [ -f "$BOT_HOME_NEW/.${BOT_NAME_VAL}/integrations.env" ]; then
            chmod 0660 "$BOT_HOME_NEW/.${BOT_NAME_VAL}/integrations.env" 2>/dev/null || true
        fi
        date -u +"%Y-%m-%dT%H:%M:%SZ" > "$BOT_HOME_NEW/.migrated"
        chown bot:botshare "$BOT_HOME_NEW/.migrated"
    fi

    # Migrate the legacy encrypted store from PROJECT_DIR/.integrations to
    # /var/wsapi-store/. Idempotent + redeploy-safe via three sources:
    #
    #   1. Already migrated AND volume persists → /var/wsapi-store/credentials.json
    #      already exists, .migrated marker is set. Skip.
    #   2. First-ever Phase-2 migration → legacy .integrations/ dir exists.
    #      Copy it across, mark migrated, rename original to .migrated.bak.
    #   3. Re-recovery (volume was lost between deploys, but legacy dir was
    #      previously renamed to .migrated.bak) → copy from the .bak so the
    #      operator doesn't have to re-enter every credential. Same destination.
    #
    # The wsapi-store volume in docker-compose is the primary persistence
    # mechanism; (3) is belt-and-braces for the case where the volume is
    # accidentally pruned (`docker volume rm`) or lost across hosts.
    LEGACY_INT_DIR="/home/coder/project/.integrations"
    LEGACY_BAK_DIR="${LEGACY_INT_DIR}.migrated.bak"
    NEW_INT_DIR="/var/wsapi-store"
    SOURCE_DIR=""
    if [ -f "$NEW_INT_DIR/credentials.json" ] && [ -f "$NEW_INT_DIR/.migrated" ]; then
        :   # Already done. Skip without warning.
    elif [ -d "$LEGACY_INT_DIR" ]; then
        SOURCE_DIR="$LEGACY_INT_DIR"
    elif [ -d "$LEGACY_BAK_DIR" ]; then
        SOURCE_DIR="$LEGACY_BAK_DIR"
        echo "[entrypoint] WARN: wsapi-store volume empty but $LEGACY_BAK_DIR exists — recovering from bak"
    fi
    if [ -n "$SOURCE_DIR" ]; then
        echo "[entrypoint] Migrating credentials store: $SOURCE_DIR → $NEW_INT_DIR"
        cp -a "$SOURCE_DIR/." "$NEW_INT_DIR/" 2>/dev/null || true
        chown -R 1001:1001 "$NEW_INT_DIR"
        find "$NEW_INT_DIR" -type d -exec chmod 0700 {} \; 2>/dev/null || true
        find "$NEW_INT_DIR" -type f -exec chmod 0600 {} \; 2>/dev/null || true
        date -u +"%Y-%m-%dT%H:%M:%SZ" > "$NEW_INT_DIR/.migrated"
        chown 1001:1001 "$NEW_INT_DIR/.migrated"
        # Only rename the live legacy dir; never touch the .bak (it stays
        # as recovery state for the next redeploy if the volume is lost
        # again). Renaming the live dir prevents workspace-api from ever
        # writing to it after the migration.
        if [ "$SOURCE_DIR" = "$LEGACY_INT_DIR" ]; then
            mv "$LEGACY_INT_DIR" "$LEGACY_BAK_DIR" 2>/dev/null || true
            echo "[entrypoint] Migration complete; legacy preserved at $LEGACY_BAK_DIR"
        else
            echo "[entrypoint] Recovery from $LEGACY_BAK_DIR complete"
        fi
    fi
    # Same redeploy-safe logic for the platform token (Claude OAuth) +
    # audit log. They lived in PROJECT_DIR alongside the integrations
    # store; move them too so bot at uid 1000 can't read them.
    PLATFORM_FILES=(.platform.json .platform.token.enc .platform.audit.log)
    for f in "${PLATFORM_FILES[@]}"; do
        DEST="$NEW_INT_DIR/$f"
        SRC=""
        if [ -f "$DEST" ]; then
            continue   # Already in place from a previous boot.
        elif [ -f "/home/coder/project/$f" ]; then
            SRC="/home/coder/project/$f"
        elif [ -f "/home/coder/project/${f}.migrated.bak" ]; then
            SRC="/home/coder/project/${f}.migrated.bak"
            echo "[entrypoint] WARN: recovering platform file $f from .migrated.bak"
        fi
        if [ -n "$SRC" ]; then
            cp -a "$SRC" "$DEST"
            chown 1001:1001 "$DEST"
            chmod 0600      "$DEST"
            # Only rename live source; bak stays put for re-recovery.
            if [ "$SRC" = "/home/coder/project/$f" ]; then
                mv "$SRC" "/home/coder/project/${f}.migrated.bak" 2>/dev/null || true
            fi
        fi
    done
    if [ ! -f "$NEW_INT_DIR/.platform-migrated" ]; then
        date -u +"%Y-%m-%dT%H:%M:%SZ" > "$NEW_INT_DIR/.platform-migrated"
        chown 1001:1001 "$NEW_INT_DIR/.platform-migrated"
    fi

    # Re-apply Phase-2 special-dir perms AFTER the credentials migration.
    # The migration block above does `chown -R 1001:1001 $NEW_INT_DIR` +
    # `find -type d -exec chmod 0700`, which clobbers the carefully
    # crafted broker-socket / secure-files perms set earlier (lines 44-54):
    # those dirs are supposed to be 2770 group=wsapi-broker so mcp uid 1002
    # can both traverse them AND connect to / read what's inside. Without
    # restoring them, mcp can't reach the broker socket on the first
    # Phase-2 deploy (clean wsapi-store volume → migration runs → clobber),
    # and email / signwell / any MCP needing decrypted creds silently
    # fails to spawn. Caught 2026-06-01 — first-ever Phase-2
    # rollout where email + signwell were registered in claude.json but
    # never loaded. Older deploys dodged this because their migration
    # already ran on a past deploy; subsequent deploys skip migration
    # (.migrated guard) so lines 44-54 are the last thing to touch perms.
    chown 1001:1101 "$NEW_INT_DIR/run"   "$NEW_INT_DIR/files"
    chmod 2770      "$NEW_INT_DIR/run"   "$NEW_INT_DIR/files"

    # ─── Transparent egress: redsocks + iptables REDIRECT ─────────────────
    # Architecture (Option A, 2026-05-13):
    #   client (any uid in this container)
    #       │ dials gmail.com:993 directly
    #       ▼
    #   iptables nat OUTPUT chain
    #       │ REDIRECT to 127.0.0.1:12345
    #       ▼
    #   redsocks (uid 0, listening :12345)
    #       │ reads SO_ORIGINAL_DST from the redirected socket
    #       │ opens HTTP CONNECT to egress-proxy
    #       ▼
    #   egress-proxy:3129 (strict allow-list, hostname filter via dnsSnoopCache)
    #       │ if CONNECT <ip>:<port> resolves to allow-listed hostname → tunnel
    #       │ else 403
    #       ▼
    #   actual upstream
    #
    # Why this exists: every library that has its own quirky proxy support
    # (grammy multipart in bun, imapflow pre-resolve, nodemailer streams)
    # silently fails when we ask it to honor HTTPS_PROXY. Each fix = a per-
    # library patch and a deploy. Transparent redirect kills the entire
    # class of bugs: libraries dial direct (default behaviour for all of
    # them), iptables routes through proxy, proxy filters by hostname.
    #
    # Skipped if NET_ADMIN is missing (e.g. compose without the cap_add).
    # In that case the container falls back to the per-library HTTPS_PROXY
    # path, which is the old behaviour — still works for libs we patched.
    if iptables -t nat -L OUTPUT >/dev/null 2>&1; then
        echo "[entrypoint] Transparent egress: configuring redsocks + iptables..."

        # redsocks config — listens on :12345, sends HTTP CONNECT upstream
        # to our egress-proxy. log to stderr (visible in docker logs).
        cat > /etc/redsocks.conf <<'REDSOCKS_EOF'
base {
    log_debug = off;
    log_info = on;
    log = "stderr";
    daemon = off;
    redirector = iptables;
}
redsocks {
    local_ip = 127.0.0.1;
    local_port = 12345;
    ip = 172.30.0.10;
    port = 3129;
    type = http-connect;
}
REDSOCKS_EOF
        chmod 644 /etc/redsocks.conf

        # Start redsocks as a backgrounded daemon. PID file for restart
        # detection. Run as root so iptables-redirected packets can be
        # accepted (REDIRECT lands traffic at the listening socket
        # regardless of who owns it, but redsocks needs to read
        # SO_ORIGINAL_DST).
        pkill -9 -f /etc/redsocks.conf 2>/dev/null || true
        sleep 0.5
        nohup redsocks -c /etc/redsocks.conf > /var/log/redsocks.log 2>&1 &
        REDSOCKS_PID=$!
        # Give redsocks a moment to bind :12345 before iptables routes
        # traffic at it. If it failed to start, the iptables rules below
        # would redirect into a closed port and ALL outbound TCP would
        # ERESETPIPE — so we fail-closed by skipping iptables setup if
        # redsocks didn't come up.
        sleep 1
        if kill -0 "$REDSOCKS_PID" 2>/dev/null; then
            echo "[entrypoint] redsocks started (pid $REDSOCKS_PID)"

            # IMPORTANT: do NOT `-F OUTPUT` — Docker's embedded DNS resolver
            # on 127.0.0.11 is implemented via an iptables NAT rule in this
            # chain (DNAT 127.0.0.11:53 → host Docker DNS). Flushing OUTPUT
            # destroys that rule and every `getaddrinfo` call in the
            # container returns "host not found" until the next container
            # recreate (caught 2026-05-13 on the first Option A deploy).
            # Use a CUSTOM chain we own, jumped to from OUTPUT. Flushing
            # our own chain is safe.
            CHAIN=EGRESS_OPTION_A
            iptables -t nat -N "$CHAIN" 2>/dev/null || iptables -t nat -F "$CHAIN"

            # Jump from OUTPUT to our chain — idempotent (only insert if
            # not already there). Insert at TAIL so Docker's pre-existing
            # rules (DNS DNAT, etc.) get evaluated first.
            iptables -t nat -C OUTPUT -j "$CHAIN" 2>/dev/null \
                || iptables -t nat -A OUTPUT -j "$CHAIN"

            # 1. Loopback — never redirect. Proxy + redsocks talk over lo.
            iptables -t nat -A "$CHAIN" -o lo -j RETURN

            # 2. egress-proxy itself — redsocks's outbound connection to
            #    172.30.0.10:3129 must not loop back through iptables.
            iptables -t nat -A "$CHAIN" -p tcp -d 172.30.0.10 -j RETURN

            # 3. Inter-container traffic on bot-net (frontend, auth, etc.)
            #    stays direct. We only want EXTERNAL traffic transparently
            #    routed.
            iptables -t nat -A "$CHAIN" -p tcp -d 172.30.0.0/24 -j RETURN

            # 4. Everything else — REDIRECT to local redsocks port. From
            #    redsocks's POV the socket has SO_ORIGINAL_DST set to the
            #    original destination, which it translates into an HTTP
            #    CONNECT to the upstream proxy.
            iptables -t nat -A "$CHAIN" -p tcp -j REDIRECT --to-ports 12345

            # Fake default route via egress-proxy — without this, bot-net's
            # `internal: true` means there's no default gateway, so the
            # kernel rejects connect() with ENETUNREACH BEFORE iptables
            # gets a chance to REDIRECT the packet. iptables NAT OUTPUT
            # chain only fires on packets the kernel actually generates;
            # if the routing decision fails up-front, our rules are
            # bypassed entirely (REDIRECT counter stays at 0 even with
            # active client traffic — caught 2026-05-13).
            #
            # 172.30.0.10 (egress-proxy) is a real container in the same
            # subnet, so the kernel happily accepts it as a "gateway"
            # candidate. No actual packets ever leave the host via this
            # gateway — they're REDIRECT'd to 127.0.0.1 by the rule
            # above before the routing layer matters.
            #
            # Without a default route the iptables REDIRECT chain never
            # fires for direct-dial clients (bun fetch multipart,
            # imapflow pre-resolve, any lib that ignores HTTPS_PROXY) —
            # the kernel rejects connect() with ENETUNREACH BEFORE
            # iptables OUTPUT NAT gets a chance to redirect. So a
            # missing route here = silent breakage for those clients,
            # ONLY HTTPS_PROXY-honouring traffic works.  Caught
            # 2026-05-13: iproute2 wasn't in the image, `ip
            # route` was absent, default route never installed, Telegram
            # plugin's bun sendPhoto failed with "network error" while
            # sendMessage went through fine via env-based proxy.
            #
            # iproute2 is now installed in Dockerfile LAYER 1 so `ip` is
            # always present. If it ever disappears, fall back to the
            # net-tools `route` binary, then yell loudly. Anything short
            # of a working default route means Option A is non-functional
            # for any direct-dial client.
            ROUTE_INSTALLED=0
            if command -v ip >/dev/null 2>&1; then
                if ip route replace default via 172.30.0.10 2>/dev/null; then
                    ROUTE_INSTALLED=1
                fi
            elif command -v route >/dev/null 2>&1; then
                # net-tools fallback. `route add` errors if a default
                # already exists (no -replace semantics); delete first,
                # ignore errors if it wasn't there.
                route del default 2>/dev/null || true
                if route add default gw 172.30.0.10 2>/dev/null; then
                    ROUTE_INSTALLED=1
                fi
            fi
            if [ "$ROUTE_INSTALLED" -eq 1 ]; then
                echo "[entrypoint] Default route added: default via 172.30.0.10"
            else
                echo "[entrypoint] ERROR: could not add default route (neither iproute2 'ip' nor net-tools 'route' worked). Direct-dial clients will get ENETUNREACH. HTTPS_PROXY-honouring clients still work." >&2
            fi

            echo "[entrypoint] Transparent egress active: external TCP → redsocks:12345 → egress-proxy:3129"
        else
            echo "[entrypoint] WARN: redsocks failed to start; skipping iptables rules. Libraries must honour HTTPS_PROXY manually."
        fi
    else
        echo "[entrypoint] WARN: iptables not available (no NET_ADMIN cap?); transparent egress disabled. Libraries must honour HTTPS_PROXY manually."
    fi

    # Re-execute this script as the 'coder' user with the correct HOME directory
    exec sudo -E HOME=/home/coder -u coder "$0" "$@"
fi

# --- CODER LOGIC: Everything below runs as the restricted 'coder' user ---

# ========================================
# IDE Entrypoint
# Starts rclone sync + code-server
# ========================================

PROJECT_DIR="/home/coder/project"
mkdir -p "$PROJECT_DIR"

# --- Branding bootstrap (LEGACY ONLY) ---
# Only legacy clients (LEGACY_CONFIG=true) need this. They have BOT_NAME /
# VITE_APP_TITLE baked into their .env from the pre-wizard era; the operator
# manages branding through .env + redeploy and the in-UI editor is read-only.
# Without a seeded `.branding.json`, the setup-status check would refuse to
# clear the wizard's Step 1-3 prompts (it wants source='file', not 'env').
#
# Non-legacy clients DO NOT bootstrap. The wizard is the single source of
# truth — operator's .env carries only operational/deploy fields, the
# end-user enters every branding value through Step 1 (title + logo),
# Step 2 (bot name + avatar), Step 3 (backstory + personality) themselves.
BRANDING_FILE="$PROJECT_DIR/.branding.json"
if [ "${LEGACY_CONFIG:-false}" = "true" ] && [ ! -f "$BRANDING_FILE" ] && { [ -n "${BOT_NAME:-}" ] || [ -n "${VITE_APP_TITLE:-}" ]; }; then
    if BRANDING_FILE_OUT="$BRANDING_FILE" python3 - <<'PYEOF'
import os, json, datetime, re, sys
title = (os.environ.get('VITE_APP_TITLE') or os.environ.get('IDE_TITLE') or '').strip()
title = re.sub(r'\s*(?:IDE|Workspace)\s*$', '', title, flags=re.IGNORECASE).strip()
bot   = (os.environ.get('BOT_NAME') or os.environ.get('VITE_BOT_NAME') or '').strip()
out   = {'updatedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'updatedBy': 'bootstrap'}
if title: out['title']   = title
if bot:   out['botName'] = bot
if 'title' not in out and 'botName' not in out:
    sys.exit(2)
with open(os.environ['BRANDING_FILE_OUT'], 'w') as f:
    json.dump(out, f, indent=2)
PYEOF
    then
        chmod 600 "$BRANDING_FILE"
        echo "[entrypoint] Legacy mode — branding bootstrapped from env defaults."
    fi
fi

# --- Memory cards bootstrap (Karpathy LLM-wiki, 7-card seed) ---
# Seeds project/memory/ with the seven canonical cards on first start.
# Idempotent: any pre-existing file is preserved — the user may have
# edited a card before we got around to seeding it, or this is a
# redeploy and we're keeping their edits.
#
# Why an explicit allowlist (CARDS=...) instead of `for tpl in templates/*`:
# the templates dir can accumulate stragglers across image versions.
# Iterating the directory glob would silently seed those into
# project/memory/ — leaking obsolete templates into the user's tree.
# The allowlist reflects exactly the seven cards the loader expects.
MEMORY_DIR="$PROJECT_DIR/memory"
MEMORY_TEMPLATES_DIR="/opt/ide/bootstrap/memory-cards-templates"
CARDS=(RULES USER_PROFILE USER_PREFERENCES AGENT_IDENTITY AGENT_TOOLS USER_RELATIONSHIPS USER_REFLECTIONS RECENT_WEB RECENT_TELEGRAM)
if [ -d "$MEMORY_TEMPLATES_DIR" ]; then
    mkdir -p "$MEMORY_DIR"
    MEMORY_SEEDED=0
    for card in "${CARDS[@]}"; do
        tpl="$MEMORY_TEMPLATES_DIR/$card.md"
        dest="$MEMORY_DIR/$card.md"
        if [ -f "$tpl" ] && [ ! -f "$dest" ]; then
            cp "$tpl" "$dest"
            chmod 644 "$dest"
            MEMORY_SEEDED=$((MEMORY_SEEDED+1))
        fi
    done
    if [ "$MEMORY_SEEDED" -gt 0 ]; then
        echo "[entrypoint] Memory cards seeded: $MEMORY_SEEDED of ${#CARDS[@]} cards copied (existing files preserved)."
    else
        echo "[entrypoint] Memory cards already present — skipping seed."
    fi

    # Karpathy LLM-wiki layer on top of the 7 cards. INDEX.md + topics/
    # folder convention. Both are pure additions; existing card content
    # is untouched. See docs/MEMORY_REWORK.md.
    if [ -f "$MEMORY_TEMPLATES_DIR/INDEX.md" ] && [ ! -f "$MEMORY_DIR/INDEX.md" ]; then
        cp "$MEMORY_TEMPLATES_DIR/INDEX.md" "$MEMORY_DIR/INDEX.md"
        chmod 644 "$MEMORY_DIR/INDEX.md"
        echo "[entrypoint] Memory INDEX.md seeded (wiki entry point)."
    fi
    if [ -d "$MEMORY_TEMPLATES_DIR/topics" ] && [ ! -d "$MEMORY_DIR/topics" ]; then
        mkdir -p "$MEMORY_DIR/topics"
        if [ -f "$MEMORY_TEMPLATES_DIR/topics/ABOUT.md" ]; then
            cp "$MEMORY_TEMPLATES_DIR/topics/ABOUT.md" "$MEMORY_DIR/topics/ABOUT.md"
            chmod 644 "$MEMORY_DIR/topics/ABOUT.md"
        fi
        echo "[entrypoint] Memory topics/ folder seeded (wiki long-form)."
    fi
    # taste-recall — anti-pattern store. Same shape as topics/, but
    # only holds "the agent got X wrong; here's the rule that prevents
    # repeating it" cards. Empty dir + ABOUT.md is enough;
    # reflect-learnings will populate it over time.
    if [ -d "$MEMORY_TEMPLATES_DIR/patterns" ] && [ ! -d "$MEMORY_DIR/patterns" ]; then
        mkdir -p "$MEMORY_DIR/patterns"
        if [ -f "$MEMORY_TEMPLATES_DIR/patterns/ABOUT.md" ]; then
            cp "$MEMORY_TEMPLATES_DIR/patterns/ABOUT.md" "$MEMORY_DIR/patterns/ABOUT.md"
            chmod 644 "$MEMORY_DIR/patterns/ABOUT.md"
        fi
        echo "[entrypoint] Memory patterns/ folder seeded (anti-pattern store)."
    fi
fi

# --- Team whitelist bootstrap ---
# Seed PROJECT_DIR/.allowed-emails.json from every email in IDE_ALLOWED_EMAILS:
#   - first email becomes admin (so SOMEONE can manage the team)
#   - the rest become members
# Idempotent: skips if the file already exists (= already managed via the
# Team dashboard).
ALLOWED_EMAILS_FILE="$PROJECT_DIR/.allowed-emails.json"
if [ ! -f "$ALLOWED_EMAILS_FILE" ] && [ -n "$IDE_ALLOWED_EMAILS" ]; then
    if python3 - <<'PYEOF' > "${ALLOWED_EMAILS_FILE}.tmp"
import os, json, datetime, sys
raw = (os.environ.get('IDE_ALLOWED_EMAILS') or '').strip()
emails = []
seen = set()
for piece in raw.split(','):
    e = piece.strip().lower()
    if not e or e in seen:
        continue
    if '@' not in e:
        continue
    seen.add(e)
    emails.append(e)
if not emails:
    sys.exit(2)
now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
entries = [
    {
        'email':   e,
        'role':    'admin' if i == 0 else 'member',
        'addedAt': now,
        'addedBy': 'bootstrap',
    }
    for i, e in enumerate(emails)
]
print(json.dumps(entries, indent=2))
PYEOF
    then
        mv "${ALLOWED_EMAILS_FILE}.tmp" "$ALLOWED_EMAILS_FILE"
        # 660 (not 600): workspace-api runs as uid 1001 (wsapi), but this file
        # is created here owned by coder (1000). Both are in the shared
        # `workspace` group (1100, setgid on PROJECT_DIR), so group-rw lets
        # wsapi read it. With 600 wsapi gets EACCES → admin checks fail → the
        # first-login wizard's "save token" button silently 403s.
        chmod 660 "$ALLOWED_EMAILS_FILE"
        COUNT=$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))))" "$ALLOWED_EMAILS_FILE" 2>/dev/null || echo "?")
        echo "[entrypoint] Team whitelist bootstrapped: $COUNT user(s) (first = admin)."
    else
        rm -f "${ALLOWED_EMAILS_FILE}.tmp"
        echo "[entrypoint] WARNING: team whitelist bootstrap failed — no valid emails in IDE_ALLOWED_EMAILS." >&2
    fi
fi

# --- Force settings.json into volume (overwrites stale volume data) ---
mkdir -p /home/coder/.local/share/code-server/User
cp /opt/ide/settings.json /home/coder/.local/share/code-server/User/settings.json
echo "[entrypoint] settings.json applied."

# --- Deploy global Claude operational rules to ~/.claude/CLAUDE.md ---
# This file is inherited by all bots (bot.sh copies ~/.claude/ to bot home on every start).
# Contains: Telegram formatting, Drive verification, error handling, cron patterns,
# capability surfacing, file routing. Client identity stays in ~/project/CLAUDE.md.
if [ -f /opt/ide/global-claude.md ]; then
    cp /opt/ide/global-claude.md /home/coder/.claude/CLAUDE.md
    echo "[entrypoint] Global CLAUDE.md deployed."
fi

# --- Deploy default skills to ~/project/.claude/skills/ (Bundle 6) ---
# Bundle 6 / WS3 unified location: ALL skills (system defaults + integration
# + user-created) live under ~/project/.claude/skills/. Single source of
# truth, volume-persistent, frontmatter-tagged with source/editable/managed_by
# so the bot, workspace-api, and frontend can tell them apart by metadata
# instead of by path convention.
#
# Idempotent rebuild:
#   1. Wipe every subfolder whose frontmatter source != "project"
#      (user skills preserved; system + integration restaged from scratch)
#   2. Copy /opt/ide/skills/default/* into SKILLS_DIR
#   3. Stamp each just-copied dir with source=system editable=false
#
# Per R.3 (Anthropic Skills spec): CC discovers SKILL.md files in
# .claude/skills/ in cwd's ancestor chain. Bot.sh cd's to /home/coder/project
# before launching claude, so CC walks → /home/coder/project/.claude/skills/
# and discovers everything in one place.
SKILLS_DIR="/home/coder/project/.claude/skills"
STAMP_SCRIPT="/opt/ide/scripts/stamp-skill-frontmatter.sh"

if [ -d /opt/ide/skills/default ]; then
    mkdir -p "$SKILLS_DIR"

    # 1. Wipe non-project skills (preserve `source: project` and unstamped
    #    pre-existing user content — first-deploy safe default)
    for d in "$SKILLS_DIR"/*/; do
        [ -d "$d" ] || continue
        if [ -f "$d/SKILL.md" ]; then
            src=$(awk -F': *' '/^source:/{print $2; exit}' "$d/SKILL.md" 2>/dev/null | tr -d '[:space:]')
            case "$src" in
                project|"") ;;   # keep user skills + unstamped first-deploy content
                *) rm -rf "$d" ;;  # wipe stamped system/integration
            esac
        fi
    done

    # 2. Copy system defaults
    for skill_src in /opt/ide/skills/default/*/; do
        [ -d "$skill_src" ] || continue
        name=$(basename "$skill_src")
        cp -r "$skill_src" "$SKILLS_DIR/$name"
    done

    # 3. Stamp source=system on the just-copied dirs
    if [ -x "$STAMP_SCRIPT" ]; then
        for skill_dir in /opt/ide/skills/default/*/; do
            [ -d "$skill_dir" ] || continue
            name=$(basename "$skill_dir")
            "$STAMP_SCRIPT" "$SKILLS_DIR/$name" system false ide-template 2>&1 | sed 's/^/[entrypoint] /'
        done
    fi

    # Ownership: workspace-api (coder) reads + writes; bot.sh reads via CC
    # ancestor-chain discovery. `coder:workspace` matches the project dir.
    chown -R coder:workspace "$SKILLS_DIR" 2>/dev/null || true
    find "$SKILLS_DIR" -type d -exec chmod 2775 {} \; 2>/dev/null || true
    find "$SKILLS_DIR" -type f -exec chmod 664 {} \; 2>/dev/null || true

    echo "[entrypoint] System skills deployed to $SKILLS_DIR (wiped non-project + restaged + stamped)."
fi

# Legacy cleanup: pre-Bundle-6, system skills lived at /home/coder/.claude/skills/.
# Wipe that location so the model doesn't see duplicates from two paths.
# Per-project skills NEVER lived there — safe to nuke unconditionally.
if [ -d /home/coder/.claude/skills ]; then
    rm -rf /home/coder/.claude/skills
    echo "[entrypoint] Removed legacy /home/coder/.claude/skills/ (pre-Bundle-6 system-skill location)."
fi

# --- Autogenerate skills INDEX.md (WS4 v1, dual-location walk) ---
# Walks both ~/.claude/skills/ (system defaults) and (if it exists)
# ~/project/.claude/skills/ (project + integration), parses each
# SKILL.md's `name:` + `description:` frontmatter, and writes a flat
# index to ~/project/.claude/skills/INDEX.md.
#
# Why: model frequently claims "I don't have skill X" without checking
# — the cached frontmatter discovery loses signal in 16+ defaults +
# 20+ integration skills. A compact one-line-per-skill index (~30-50
# lines) gives the model a deterministic `cat | grep` path before any
# absence claim. Combined with global-claude.md "Before claiming
# absence" rule, the model has a concrete check to run instead of
# guessing.
#
# v2 (post-WS3 / Bundle 6, after skills consolidate into a single
# location with source: frontmatter) drops the dual-walk in favour of
# one path. For now v1 walks both.
{
    INDEX_DIR=/home/coder/project/.claude/skills
    INDEX_FILE="$INDEX_DIR/INDEX.md"
    mkdir -p "$INDEX_DIR"

    # Helper: extract frontmatter `name:` + `description:` from a SKILL.md.
    # Writes one row per skill: "- <name> — <description (1 line, trimmed)>"
    # Awk handles multi-line descriptions defensively (joins to one line).
    extract_skill_row() {
        local skill_md="$1"
        [ -f "$skill_md" ] || return
        awk '
            /^---[[:space:]]*$/ { fm = !fm; if (!fm && have_name) { sub(/[[:space:]]+$/, "", desc); printf "- %s — %s\n", name, desc; exit } next }
            fm && /^name:/      { sub(/^name:[[:space:]]*/, ""); name = $0; have_name = 1; next }
            fm && /^description:/ { sub(/^description:[[:space:]]*/, ""); desc = $0; next }
            fm && desc && /^[a-z_-]+:/ { sub(/[[:space:]]+$/, "", desc); if (have_name) printf "- %s — %s\n", name, desc; exit }
            fm && desc { desc = desc " " $0 }
        ' "$skill_md"
    }

    # Write index header + 2 sections (System / Project). Project section
    # only emitted if ~/project/.claude/skills/ has any skill folders.
    {
        echo "# Skills index"
        echo ""
        echo "_Autogenerated at container boot from SKILL.md frontmatter. Do not edit by hand — changes will be overwritten on next deploy._"
        echo ""
        echo "Scan this list before claiming \"I don't have skill X\". Each row is one skill the model can invoke; full SKILL.md is in the listed directory."
        echo ""
        echo "## Skills (all in workspace volume — editable)"
        echo ""
        # Post-Bundle-6 all skills live in $INDEX_DIR (=/home/coder/project/.claude/skills/).
        # The legacy walker over /home/coder/.claude/skills/ was iterating a
        # wiped directory (rm -rf at the start of the legacy-cleanup block)
        # and produced an empty "## System" header — confusing both the model
        # and operators. Single unified section now.
        for d in "$INDEX_DIR"/*/; do
            [ -d "$d" ] || continue
            extract_skill_row "$d/SKILL.md"
        done | sort
    } > "$INDEX_FILE.tmp" && mv "$INDEX_FILE.tmp" "$INDEX_FILE"
    chmod 644 "$INDEX_FILE" 2>/dev/null || true
    SKILL_COUNT=$(grep -c '^- ' "$INDEX_FILE" 2>/dev/null || echo 0)
    echo "[entrypoint] Skills INDEX autogenerated: $INDEX_FILE ($SKILL_COUNT skills)"

    # Symlink INDEX.md so `cat ~/.claude/skills/INDEX.md` works for both
    # the bot (HOME=/home/bot) and the coder/web side (HOME=/home/coder).
    # global-claude.md's "Before claiming absence" rule tells the model to
    # check `~/.claude/skills/INDEX.md` — without these symlinks, the model
    # hit "No such file or directory" and concluded skills were missing.
    # The actual INDEX is at $INDEX_FILE (~/project/.claude/skills/INDEX.md);
    # the symlinks just bridge the legacy path the rule still references.
    mkdir -p /home/coder/.claude/skills 2>/dev/null
    ln -sfn "$INDEX_FILE" /home/coder/.claude/skills/INDEX.md
    chown -h coder:workspace /home/coder/.claude/skills/INDEX.md 2>/dev/null || true
    # bot.sh's tar | tar overlay (later in lifecycle) carries the symlink
    # to /home/bot/.claude/skills/INDEX.md without further work.
}

# --- Deploy ~/.claude/settings.json (autoMemoryEnabled: false + hooks) ---
# WS2: disables CC's native auto-memory at the source (per R.2 outcome
# the official settings flag exists). WS6.5: registers PostToolUse hook
# that fires post-write-memory.sh after Write/Edit to ~/project/memory/
# → Telegram notification closes the write feedback loop.
#
# Merge strategy: if a settings.json already exists (e.g. operator added
# custom keys), DON'T clobber. Use jq to merge our keys in. If jq missing
# or no existing file, write template directly.
if [ -f /opt/ide/bootstrap/claude-settings.json ]; then
    mkdir -p /home/coder/.claude
    DEST=/home/coder/.claude/settings.json
    if [ ! -f "$DEST" ]; then
        cp /opt/ide/bootstrap/claude-settings.json "$DEST"
        echo "[entrypoint] ~/.claude/settings.json deployed (fresh)."
    elif command -v jq >/dev/null 2>&1; then
        # Shallow-merge in slurped mode: existing first, template second
        # — template's keys override on overlap (so hooks + autoMemoryEnabled
        # always get the latest template values), but custom operator
        # keys not in the template are preserved.
        TMP=$(mktemp)
        if jq -s '.[0] * .[1]' "$DEST" /opt/ide/bootstrap/claude-settings.json > "$TMP" 2>&1; then
            mv "$TMP" "$DEST"
            echo "[entrypoint] ~/.claude/settings.json merged with template (autoMemoryEnabled + hooks refreshed)."
        else
            ERR=$(cat "$TMP" 2>/dev/null | head -2)
            rm -f "$TMP"
            echo "[entrypoint] WARNING: settings.json merge failed; existing file kept. jq error: $ERR"
        fi
    else
        echo "[entrypoint] ~/.claude/settings.json exists; jq missing for merge; skipping (manual review needed)."
    fi
    chmod 644 "$DEST"
fi

# Optional-skills install moved to AFTER workspace-api starts (migration
# needs to populate .claude.json's mcpServers with the user's integrations
# before we can decide which optional skills to install). See block lower
# in this file, after the workspace-api pm2 start.

# --- Pre-stamp ~/.claude.json so claude --channels skips first-time UI ---
# Without `hasCompletedOnboarding: true` claude's interactive mode (used by
# the Telegram bot's tmux session) renders the "Select login method" screen
# and silently drops every Telegram message, even with CLAUDE_CODE_OAUTH_TOKEN
# set as an env var. Auth is fine; it's the welcome dialog that blocks.
# Idempotent — only stamps when the file exists and the flag isn't set.
#
# We're already running as coder at this point (the root wrapper at the top
# of this script exec'd `sudo -u coder $0` and re-entered). The `sudo -u coder`
# here was a redundant no-op when NOPASSWD sudo was on, but the 2026-05-09
# audit stripped that grant — so just drop the sudo and run python directly.
python3 - <<'PY'
import json, os, pathlib
home = pathlib.Path(os.path.expanduser('~coder'))
for f in [home / '.claude.json']:
    if not f.exists():
        f.write_text(json.dumps({}))
    try:
        d = json.loads(f.read_text() or '{}')
    except Exception:
        d = {}
    changed = False
    if not d.get('hasCompletedOnboarding'):
        d['hasCompletedOnboarding'] = True
        changed = True
    if changed:
        f.write_text(json.dumps(d, indent=2))
        print(f"[entrypoint] Stamped hasCompletedOnboarding=true in {f}")
PY

# Phase-2 broker isolation: workspace-api at uid 1001 needs to write
# /home/coder/.claude.json to update the mcpServers block on every
# integration activate. The python stamp above creates/touches the file
# as coder (uid 1000) — chgrp it to `workspace` and add g+rw so wsapi
# (also in `workspace` group) can write. Coder is the file owner so this
# `chgrp` succeeds without root. This block must live AFTER the stamp
# (root-block chgrp would fire before the file exists on a fresh
# container, since .claude.json isn't volume-mounted).
chgrp workspace /home/coder/.claude.json 2>/dev/null || true
chmod g+rw      /home/coder/.claude.json 2>/dev/null || true
# Same for the persistent backup .claude.json.persistent — written by
# the periodic backup loop that follows below.
[ -f /home/coder/.claude/.claude.json.persistent ] && {
    chgrp workspace /home/coder/.claude/.claude.json.persistent 2>/dev/null || true
    chmod g+rw      /home/coder/.claude/.claude.json.persistent 2>/dev/null || true
}

# --- Force all staged extensions into volume (always overwrite from image) ---
if [ -d /opt/ide/extensions ]; then
    mkdir -p /home/coder/.local/share/code-server/extensions
    cp -r /opt/ide/extensions/* /home/coder/.local/share/code-server/extensions/
    echo "[entrypoint] Extensions forced from image."
fi

# --- rclone Google Drive sync (legacy path) ---
# New deploys default to server-only file storage backed by Hetzner snapshots
# / restic — no Drive sync, no rclone running. Legacy clients opt back in
# by setting LEGACY_DRIVE_SYNC=true in their .env, which
# keeps the rclone bidirectional sync behaviour from before.
#
# When the flag is off, files live in the project-data Docker volume only.
# That removes a major source of bugs (rclone token expiry, race conditions
# between Drive and the workspace UI, surprise file changes mid-edit).
if [ "${LEGACY_DRIVE_SYNC:-false}" = "true" ] && [ -n "$RCLONE_GDRIVE_TOKEN" ]; then
    RCLONE_CONFIG="/home/coder/.config/rclone/rclone.conf"
    mkdir -p "$(dirname "$RCLONE_CONFIG")"

    cat > "$RCLONE_CONFIG" <<EOF
[gdrive]
type = drive
client_id = ${RCLONE_GDRIVE_CLIENT_ID:-}
client_secret = ${RCLONE_GDRIVE_CLIENT_SECRET:-}
scope = drive
token = ${RCLONE_GDRIVE_TOKEN}
root_folder_id = ${RCLONE_GDRIVE_ROOT_FOLDER_ID:-}
EOF
    chmod 600 "$RCLONE_CONFIG"

    echo "[entrypoint] Legacy Drive sync enabled — initial pull..."
    # rclone exclude list — every workspace-managed state file lives in
    # PROJECT_DIR but must NEVER round-trip through Drive. Without these
    # excludes the download cycle deletes them every 30s because Drive
    # doesn't have them, breaking auth (whitelist), branding, encrypted
    # credentials, audit trails. Mirrors the HARD_HIDDEN set in
    # workspace-api/lib/config.js — keep in sync.
    RCLONE_EXCLUDES=(
        --exclude ".reminders.json"
        --exclude ".tasks.json"
        --exclude ".allowed-emails.json"
        --exclude ".allowed-emails.audit.log"
        --exclude ".branding.json"
        --exclude ".branding.json.tmp"
        --exclude ".branding/**"
        --exclude ".platform.json"
        --exclude ".platform.json.tmp"
        --exclude ".platform.token.enc"
        --exclude ".platform.token.enc.tmp"
        --exclude ".platform.audit.log"
        --exclude ".platform.audit.log.preserved.*"
        --exclude ".integrations/**"
        --exclude ".claude/CLAUDE.md.preserved.*"
    )
    rclone sync gdrive: "$PROJECT_DIR" \
        --create-empty-src-dirs \
        "${RCLONE_EXCLUDES[@]}" \
        --log-file /tmp/rclone.log \
        --log-level INFO \
        2>&1 || echo "[entrypoint] WARNING: Initial sync failed. Check /tmp/rclone.log"

    echo "[entrypoint] Initial sync complete."

    SYNC_LOCK="/tmp/rclone-sync.lock"

    # --- Background download: every 30s sync Drive → local ---
    (
        while true; do
            sleep 30
            # flock -n = non-blocking: skip if upload is running
            flock -n "$SYNC_LOCK" \
                rclone sync gdrive: "$PROJECT_DIR" \
                    --create-empty-src-dirs \
                    "${RCLONE_EXCLUDES[@]}" \
                    --log-file /tmp/rclone-download.log \
                    --log-level INFO 2>&1 || true
        done
    ) &
    DOWNLOAD_PID=$!
    echo "[entrypoint] Background download started (PID: $DOWNLOAD_PID, every 30s)"

    # --- Instant upload: on any local change, full sync local → Drive ---
    (
        while true; do
            inotifywait -r -q \
                -e modify,create,delete,move \
                "$PROJECT_DIR" 2>/dev/null || true
            # Debounce: wait for rapid changes to settle
            sleep 3
            # flock = blocking: wait for download to finish, then sync
            flock "$SYNC_LOCK" \
                rclone sync "$PROJECT_DIR" gdrive: \
                    --create-empty-src-dirs \
                    "${RCLONE_EXCLUDES[@]}" \
                    --log-file /tmp/rclone-upload.log \
                    --log-level INFO 2>&1 || true
        done
    ) &
    UPLOAD_PID=$!
    echo "[entrypoint] Instant upload watcher started (PID: $UPLOAD_PID)"
elif [ "${LEGACY_DRIVE_SYNC:-false}" = "true" ]; then
    echo "[entrypoint] LEGACY_DRIVE_SYNC=true but RCLONE_GDRIVE_TOKEN is empty — skipping sync."
else
    echo "[entrypoint] Drive sync disabled (LEGACY_DRIVE_SYNC not set) — server-only mode."
fi

# --- Graceful shutdown ---
cleanup() {
    echo "[entrypoint] Shutting down..."

    # 1. Send Telegram shutdown notification
    if [ -x /home/coder/bot-notify.sh ]; then
        /home/coder/bot-notify.sh "Going offline for maintenance..." 2>/dev/null &
        NOTIFY_PID=$!
    fi

    # 2. Stop watchdog and health server (prevents bot restart during shutdown)
    pm2 stop "${BOT_NAME}-watchdog" 2>/dev/null || true
    pm2 stop "${BOT_NAME}-health" 2>/dev/null || true

    # 3. Graceful bot stop — allow 5s to finish any in-flight response
    pm2 stop "$BOT_NAME" 2>/dev/null || true
    sleep 5
    tmux -L "$BOT_NAME" kill-session -t "$BOT_NAME" 2>/dev/null || true

    # 4. Wait for notification to be sent
    [ -n "$NOTIFY_PID" ] && wait "$NOTIFY_PID" 2>/dev/null || true

    # 5. Stop pm2 daemon
    pm2 kill 2>/dev/null || true

    # 6. Final .claude.json backup + rclone sync (only when Drive sync is on)
    [ -n "$CLAUDE_JSON_BACKUP_PID" ] && kill "$CLAUDE_JSON_BACKUP_PID" 2>/dev/null || true
    [ -f /home/coder/.claude.json ] && cp /home/coder/.claude.json /home/coder/.claude/.claude.json.persistent 2>/dev/null || true
    [ -n "$DOWNLOAD_PID" ] && kill "$DOWNLOAD_PID" 2>/dev/null || true
    [ -n "$UPLOAD_PID" ] && kill "$UPLOAD_PID" 2>/dev/null || true
    if [ "${LEGACY_DRIVE_SYNC:-false}" = "true" ] && [ -n "$RCLONE_GDRIVE_TOKEN" ]; then
        rclone sync "$PROJECT_DIR" gdrive: \
            --create-empty-src-dirs \
            "${RCLONE_EXCLUDES[@]}" \
            --log-file /tmp/rclone-shutdown.log \
            --log-level INFO 2>&1 || true
        echo "[entrypoint] Final sync done."
    fi
    wait
}
trap cleanup SIGTERM SIGINT

# --- Bot: Telegram bot token provisioning ---
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
    mkdir -p /home/coder/.claude/channels/telegram
    # Always overwrite to ensure updates are applied
    echo "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN" > /home/coder/.claude/channels/telegram/.env
    chmod 600 /home/coder/.claude/channels/telegram/.env
    echo "[entrypoint] Telegram bot token updated from environment."
fi

# --- Restore .claude.json from persistent volume (skips onboarding + trust on container recreate) ---
if [ -f /home/coder/.claude/.claude.json.persistent ] && [ ! -f /home/coder/.claude.json ]; then
    cp /home/coder/.claude/.claude.json.persistent /home/coder/.claude.json
    echo "[entrypoint] Restored .claude.json from persistent volume."
elif [ -f /home/coder/.claude.json ]; then
    cp /home/coder/.claude.json /home/coder/.claude/.claude.json.persistent
fi

# --- Periodic backup of .claude.json (captures trust acceptance and other runtime changes) ---
(
    while true; do
        sleep 60
        if [ -f /home/coder/.claude.json ]; then
            cp /home/coder/.claude.json /home/coder/.claude/.claude.json.persistent 2>/dev/null || true
        fi
    done
) &
CLAUDE_JSON_BACKUP_PID=$!
echo "[entrypoint] .claude.json periodic backup started (every 60s)"

# --- Bot: Claude settings with acceptEdits (bypassPermissions is silently ignored in Remote) ---
# NOTE: enabledPlugins is NOT set here — bot's --channels flag handles plugin loading.
# Setting enabledPlugins globally would cause the code-server sidebar Claude to ALSO
# start a Telegram plugin instance, creating a duplicate long-polling conflict.
#
# This block USED to clobber the whole file. After Bundle 4 we ship hooks
# + autoMemoryEnabled via bootstrap/claude-settings.json (deployed earlier
# in this entrypoint at the skill-deploy block). Clobber here was eating
# those keys. Switched to jq-merge: shallow-merge our permissions block
# on top of the existing file, preserving everything else.
if command -v jq >/dev/null 2>&1 && [ -f /home/coder/.claude/settings.json ]; then
    TMP=$(mktemp)
    jq '. + {
        "permissions": {
            "allow": ["mcp__*", "Read", "Bash", "Glob", "Grep", "Write", "Edit"],
            "defaultMode": "acceptEdits"
        },
        "skipDangerousModePermissionPrompt": true
    }' /home/coder/.claude/settings.json > "$TMP" \
        && mv "$TMP" /home/coder/.claude/settings.json \
        && echo "[entrypoint] Claude settings.json: permissions merged (autoMemoryEnabled + hooks preserved)." \
        || { rm -f "$TMP"; echo "[entrypoint] WARNING: settings.json permissions merge failed; falling back to overwrite."; cat > /home/coder/.claude/settings.json <<'SETTINGS_FALLBACK'
{
  "permissions": {
    "allow": ["mcp__*", "Read", "Bash", "Glob", "Grep", "Write", "Edit"],
    "defaultMode": "acceptEdits"
  },
  "skipDangerousModePermissionPrompt": true
}
SETTINGS_FALLBACK
        }
else
    # No jq or no existing file → write the full minimal config (legacy behaviour).
    cat > /home/coder/.claude/settings.json <<'SETTINGS'
{
  "permissions": {
    "allow": ["mcp__*", "Read", "Bash", "Glob", "Grep", "Write", "Edit"],
    "defaultMode": "acceptEdits"
  },
  "skipDangerousModePermissionPrompt": true
}
SETTINGS
    echo "[entrypoint] Claude settings.json with acceptEdits written (no merge — jq missing or no existing file)."
fi

# --- User-level CLAUDE.md: explicit permission grant ---
# Loaded into every Claude session as system context. The chat / bot run with
# --dangerously-skip-permissions and acceptEdits, but the model still tends to
# ask for confirmation on .claude/* writes ("system files"). This grant tells
# it the workspace is single-tenant and edits anywhere under .claude/ or
# ~/.claude/ are pre-authorised. Without this, the chat UI shows "I need your
# consent" with no Allow button (no permission_request handler in ChatPanel).
#
# APPENDED to the global-claude.md content from line 547 — was clobbering it
# with `>` until 2026-05-13. Both blocks belong in the same file (claude reads
# ~/.claude/CLAUDE.md as one system-context blob); the order is global rules
# first, then the workspace permission grant.
cat >> /home/coder/.claude/CLAUDE.md <<'CLAUDEMD'

---

# Workspace permissions

This is a single-tenant container. Every authenticated user is the owner.

You are running with `--dangerously-skip-permissions` and `defaultMode: acceptEdits`.
You have **pre-authorised full read/write** on:

- the project at `/home/coder/project/` (including `.claude/`, `.chat/`, dotfiles)
- the user home at `/home/coder/` (including `~/.claude/skills/`, `~/.claude/CLAUDE.md`,
  `~/.claude.json`, `~/.bot/`)

Do not ask the user to "click Allow" or wait for consent. The chat UI in this
workspace has **no permission-request renderer** — any prompt you emit goes
nowhere and looks to the user like a silent failure. Just perform the edit.

If a write fails with EACCES or similar, surface the actual error message —
don't paraphrase it as "needs permission".
CLAUDEMD
# Mode 0644: bot.sh runs as uid 1003 and tar-overlays /home/coder/.claude/
# → /home/bot/.claude/. With 0600 (owner=coder only) the bot's tar read of
# CLAUDE.md gets EACCES and the file silently drops from the bot's copy —
# bot loses the global rules entirely. The file is system context for the
# model, not secret material; world-read is appropriate.
chmod 644 /home/coder/.claude/CLAUDE.md
echo "[entrypoint] Claude user-level CLAUDE.md (global rules + permission grant) written."

# --- Copy bot scripts to home (always overwrite from image) ---
cp /opt/ide/bot.sh /home/coder/bot.sh
cp /opt/ide/bot-notify.sh /home/coder/bot-notify.sh
cp /opt/ide/reminder-monitor.sh /home/coder/reminder-monitor.sh
cp /opt/ide/recent-snapshot-monitor.sh /home/coder/recent-snapshot-monitor.sh
cp /opt/ide/ecosystem.config.js /home/coder/ecosystem.config.js
chmod +x /home/coder/bot.sh /home/coder/bot-notify.sh /home/coder/reminder-monitor.sh /home/coder/recent-snapshot-monitor.sh

# --- Start code-server (auth handled by auth-service via nginx auth_request) ---
echo "[entrypoint] Starting code-server on port 8080 (auth: none — protected by nginx auth_request + Supabase)..."

code-server \
    --bind-addr 0.0.0.0:8080 \
    --auth none \
    --disable-telemetry \
    --disable-update-check \
    /home/coder/project &
CODE_SERVER_PID=$!

# --- MCP: Write server config directly into ~/.claude.json ---
# Uses pre-installed packages (Dockerfile LAYER 2c) — no network required at runtime.
# Runs unconditionally: idempotent, fast (<1s), always reflects current env vars.
# mcpServers is persisted via the .claude.json.persistent backup mechanism above.
python3 - <<PYEOF
import json, os

config_path = os.path.expanduser('~/.claude.json')
try:
    with open(config_path) as f:
        config = json.load(f)
except Exception:
    config = {}

npm_bin = '/home/coder/.npm-global/bin'

# Build only the servers we manage via env vars.
# These will be merged into mcpServers — any server the bot configured itself
# (via "claude mcp add" during a chat session) is preserved under its own key.
managed = {}

# Memory — always on, persisted to claude-data volume so it survives container restarts
managed['memory'] = {
    'command': f'{npm_bin}/mcp-server-memory',
    'args': [],
    'env': {'MEMORY_FILE_PATH': '/home/coder/.claude/memory.jsonl'}
}

# Playwright Browser — always on (headless Chromium).
# Kept in this `managed` dict for backwards compatibility on the legacy
# /home/coder/.claude.json path (some web-chat code-paths still read it).
# The AUTHORITATIVE definition for the bot's claude (uid 1003,
# HOME=/home/bot) lives in the root block above — search for "Force-write
# the playwright mcpServers entry into /home/bot/.claude.json". Keep both
# in sync: --user-data-dir + --proxy-server are required, and the python
# heredoc here cannot write to /home/bot because it runs as coder.
managed['playwright'] = {
    'command': f'{npm_bin}/playwright-mcp',
    'args': [
        '--headless',
        # @playwright/mcp's --browser only accepts: chrome, firefox, webkit,
        # msedge (verified via --help). Passing "chromium" is interpreted as
        # an unrecognised channel and triggers the install-browser flow
        # against "chrome-for-testing" — which our egress blocks. Use
        # "chrome" and pin the binary with --executable-path to the
        # Dockerfile-installed Chrome for Testing (it's the same artifact
        # playwright would have downloaded as "chromium-1223" anyway).
        '--browser', 'chrome',
        # --no-sandbox: Chromium's zygote sandbox uses unprivileged user
        # namespaces, which our container doesn't enable. Without this
        # flag the browser FATALs with "No usable sandbox!" before any
        # page can load. We're already inside a Docker container with
        # uid 1003 + no-new-privs in the bot-runner — the browser sandbox
        # would be defence-in-depth, not a primary boundary.
        '--no-sandbox',
        '--user-data-dir', '/tmp/playwright-mcp-data',
        '--proxy-server', 'http://egress-proxy:3130',
        '--executable-path', '/opt/playwright-browsers/chromium-1223/chrome-linux64/chrome',
    ],
}

# Google Analytics 4 — only if credentials are provided.
# Requires GA4_PROPERTY_ID + GA4_CREDENTIALS_JSON (path to service account JSON).
# Server binary: ga4-mcp-server (entry point of google-analytics-mcp pip package).
# Credentials are passed as env vars (not CLI args) per the package's interface.
# If not in .env, bot can configure itself via "claude mcp add" — merge preserves it.
ga4_property = os.environ.get('GA4_PROPERTY_ID', '')
ga_creds = os.environ.get('GA4_CREDENTIALS_JSON', '')
if ga4_property and ga_creds:
    managed['analytics'] = {
        'command': 'ga4-mcp-server',
        'args': [],
        'env': {
            'GA4_PROPERTY_ID': ga4_property,
            'GOOGLE_APPLICATION_CREDENTIALS': ga_creds
        }
    }

# Google Ads — only if developer token + customer ID are provided.
# All ops (including reads) require OAuth: google-ads-api npm never uses service accounts.
# Required: GOOGLE_ADS_DEVELOPER_TOKEN + GOOGLE_ADS_LOGIN_CUSTOMER_ID +
#           GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_ADS_REFRESH_TOKEN.
ads_token = os.environ.get('GOOGLE_ADS_DEVELOPER_TOKEN', '')
ads_customer_id = os.environ.get('GOOGLE_ADS_LOGIN_CUSTOMER_ID', '')
if ads_token and ads_customer_id:
    managed['google-ads'] = {
        'command': 'node',
        'args': ['/opt/ide/apps/google-ads-mcp/index.js'],
        'env': {
            'GOOGLE_ADS_DEVELOPER_TOKEN':    ads_token,
            'GOOGLE_ADS_LOGIN_CUSTOMER_ID':  ads_customer_id,
            'GOOGLE_CLIENT_ID':              os.environ.get('GOOGLE_CLIENT_ID', ''),
            'GOOGLE_CLIENT_SECRET':          os.environ.get('GOOGLE_CLIENT_SECRET', ''),
            'GOOGLE_ADS_REFRESH_TOKEN':      os.environ.get('GOOGLE_ADS_REFRESH_TOKEN', ''),
        }
    }

# Shopify — only if store domain + access token are provided.
# Uses the custom internal MCP server at /opt/ide/shopify-mcp/index.js.
shopify_domain  = os.environ.get('SHOPIFY_STORE_DOMAIN', '')
shopify_id      = os.environ.get('SHOPIFY_CLIENT_ID', '')
shopify_secret  = os.environ.get('SHOPIFY_CLIENT_SECRET', '')
if shopify_domain and shopify_id and shopify_secret:
    managed['shopify'] = {
        'command': 'node',
        'args': ['/opt/ide/apps/shopify-mcp/index.js'],
        'env': {
            'SHOPIFY_STORE_DOMAIN': shopify_domain,
            'SHOPIFY_CLIENT_ID':    shopify_id,
            'SHOPIFY_CLIENT_SECRET': shopify_secret,
        }
    }

# Amadeus Flights — only if client ID + secret are provided.
signwell_key = os.environ.get('SIGNWELL_API_KEY', '')
if signwell_key:
    managed['signwell'] = {
        'command': 'node',
        'args': ['/opt/ide/apps/signwell-mcp/index.js'],
        'env': {
            'SIGNWELL_API_KEY': signwell_key,
        }
    }

# Meta Ads — only if access token is provided.
# Uses the custom internal MCP server at /opt/ide/apps/meta-mcp/index.js.
meta_token = os.environ.get('META_ACCESS_TOKEN', '')
if meta_token:
    managed['meta'] = {
        'command': 'node',
        'args': ['/opt/ide/apps/meta-mcp/index.js'],
        'env': {
            'META_ACCESS_TOKEN':          meta_token,
            'META_AD_ACCOUNT_ID':         os.environ.get('META_AD_ACCOUNT_ID', ''),
            'META_PAGE_ID':               os.environ.get('META_PAGE_ID', ''),
            'META_INSTAGRAM_ACCOUNT_ID':  os.environ.get('META_INSTAGRAM_ACCOUNT_ID', ''),
            'META_BUSINESS_ID':           os.environ.get('META_BUSINESS_ID', ''),
        }
    }

# Seedream — BytePlus ModelArk image generation (Seedream 4.5 + Seededit).
# Only if BYTEPLUS_API_KEY is set. Output directory defaults to project/generated/.
byteplus_key = os.environ.get('BYTEPLUS_API_KEY', '')
if byteplus_key:
    managed['seedream'] = {
        'command': 'node',
        'args': ['/opt/ide/apps/seedream-mcp/index.js'],
        'env': {
            'BYTEPLUS_API_KEY':       byteplus_key,
            'BYTEPLUS_MODEL_ID':      os.environ.get('BYTEPLUS_MODEL_ID') or 'seedream-4-5-251128',
            'BYTEPLUS_EDIT_MODEL_ID': os.environ.get('BYTEPLUS_EDIT_MODEL_ID') or 'seedream-5-0-260128',
            'SEEDREAM_OUTPUT_DIR':    os.environ.get('SEEDREAM_OUTPUT_DIR') or '/home/coder/project/generated',
        }
    }

# Reminder MCP — persistent reminders stored in ~/project/.reminders.json.
# Always on: no credentials required. Paired with reminder-monitor.sh (PM2 process).
managed['reminders'] = {
    'command': 'node',
    'args': ['/opt/ide/apps/reminder-mcp/index.js'],
    'env': {
        'REMINDERS_FILE': '/home/coder/project/.reminders.json',
    }
}

# Tasks MCP — the structured task board stored in ~/project/.tasks.json. Always
# on: no credentials required. The board replaced Tasks.md; the bot manages it
# through this MCP (list/add/update/move) — never by editing a Markdown file.
managed['tasks'] = {
    'command': 'node',
    'args': ['/opt/ide/apps/tasks-mcp/index.js'],
    'env': {
        'TASKS_FILE': '/home/coder/project/.tasks.json',
        'WORKSPACE_API_PORT': os.environ.get('WORKSPACE_API_PORT', '3001'),
    }
}

# PDF MCP — markdown → clean typeset PDF via python-markdown + weasyprint.
# The ONE supported way to make a PDF (render_pdf) plus preview_pdf to
# rasterise a page so the bot can SEE the result before sending. Always on:
# no credentials required. Renders under PROJECT_DIR; default output Documents/.
managed['pdf'] = {
    'command': 'node',
    'args': ['/opt/ide/apps/pdf-mcp/index.js'],
    'env': {
        'PROJECT_DIR': '/home/coder/project',
    }
}

# Workspace-API MCP — thin wrapper exposing workspace-api HTTP routes as
# MCP tools. Currently surfaces `memory_grep` (the tool the cached prefix
# PREAMBLE instructs the model to use). Always on: no credentials required.
# Talks to workspace-api on localhost — the URL must match WORKSPACE_API_PORT
# (default 3001 per workspace-api/lib/config.js).
managed['workspace-api'] = {
    'command': 'node',
    'args': ['/opt/ide/apps/workspace-api-mcp/index.js'],
    'env': {
        'WORKSPACE_API_URL': f"http://localhost:{os.environ.get('WORKSPACE_API_PORT', '3001')}",
    }
}

# Web Channel MCP — push messages from the bot into the workspace UI's
# notification stream (the SSE channel NotificationToasts consumes).
# Always on: no credentials required, loopback call to workspace-api.
# The bot uses web_send_message when the inbound prompt came over the
# web channel (e.g. [WEB_USER] or [REMINDER channel=web]) — see
# bootstrap/memory/AGENT_TOOLS.md for the routing rules.
managed['web-channel'] = {
    'command': 'node',
    'args': ['/opt/ide/apps/web-channel-mcp/index.js'],
    'env': {
        'WORKSPACE_API_PORT': os.environ.get('WORKSPACE_API_PORT', '3001'),
    }
}

# Nano Banana — Google Gemini image generation (Imagen 3 + Gemini 2.0 Flash editing).
# Only if GEMINI_API_KEY is set. Output directory shared with Seedream by default.
gemini_key = os.environ.get('GEMINI_API_KEY', '')
if gemini_key:
    managed['nano-banana'] = {
        'command': 'node',
        'args': ['/opt/ide/apps/nano-banana-mcp/index.js'],
        'env': {
            'GEMINI_API_KEY':          gemini_key,
            'GEMINI_T2I_MODEL':        os.environ.get('GEMINI_T2I_MODEL') or 'imagen-3.0-generate-002',
            'GEMINI_EDIT_MODEL':       os.environ.get('GEMINI_EDIT_MODEL') or 'gemini-2.0-flash-preview-image-generation',
            'NANO_BANANA_OUTPUT_DIR':  os.environ.get('NANO_BANANA_OUTPUT_DIR') or '/home/coder/project/generated',
        }
    }

# Email MCP — read-only multi-account IMAP (Gmail App Password / custom IMAP).
# Only registered if /home/coder/.email/accounts.json is bind-mounted in.
# Without the file, the plugin would exit(1) at boot — so we skip registration
# entirely for clients that haven't deployed credentials yet.
email_accounts = '/home/coder/.email/accounts.json'
if os.path.isfile(email_accounts):
    managed['email'] = {
        'command': 'node',
        'args': ['/opt/ide/apps/email-mcp/index.js'],
        'env': {
            'EMAIL_ACCOUNTS_FILE': email_accounts,
        }
    }

# Grok MCP — xAI's Grok via OpenAI-compatible API. Legacy path: enabled if
# XAI_API_KEY is in env at container start. New path: workspace-api manages
# the entry dynamically based on the encrypted credentials store, so most
# clients won't have this set in env at all.
xai_key = os.environ.get('XAI_API_KEY', '')
if xai_key:
    managed['grok'] = {
        'command': 'node',
        'args':    ['/opt/ide/apps/grok-mcp/index.js'],
        'env':     { 'XAI_API_KEY': xai_key },
    }

# Merge: preserve bot-configured servers, update managed ones
existing = config.get('mcpServers', {})
config['mcpServers'] = {**existing, **managed}

with open(config_path, 'w') as f:
    json.dump(config, f, indent=2)

names = ', '.join(config['mcpServers'].keys())
print(f'[entrypoint] MCP: {len(config["mcpServers"])} servers ({names})', flush=True)
PYEOF

# --- Playwright: clear stale Chrome SingletonLock files ---
# Chrome leaves SingletonLock / SingletonCookie / SingletonSocket symlinks in
# the user-data-dir to mark the profile as "in use". On unclean shutdown
# (container kill, OOM, deploy mid-flight) those symlinks survive and the
# next browser launch fails with "browser is already in use" — even though
# no Chrome process is alive. Clearing them at startup is safe because we
# know nothing else owns these dirs yet.
find /home/coder/.cache/ms-playwright \
     /home/coder/.bot/.cache/ms-playwright \
     /home/coder/project/.playwright-mcp \
     -maxdepth 4 -type l \( -name 'SingletonLock' -o -name 'SingletonCookie' -o -name 'SingletonSocket' \) \
     -delete 2>/dev/null || true

# --- PM2 ecosystem ---
# Two-stage start so the workspace-api (which serves the onboarding wizard)
# always comes up, even on a brand-new deploy without Claude credentials yet.
# The bot + reminder-monitor only start once the operator has supplied a
# Claude OAuth token (either legacy .credentials.json from `claude login`,
# or new-style PROJECT_DIR/.platform.token.enc from the wizard).
export PATH="/home/coder/.bun/bin:/home/coder/.npm-global/bin:$PATH"
sleep 5

# Logs directory — pm2 needs it to exist + writable before any app starts.
mkdir -p "/home/coder/.${BOT_NAME:?BOT_NAME is not set}"

# Clean slate: delete old processes to avoid duplicates
pm2 delete all 2>/dev/null || true

# Stage 1: workspace-api — always start, no auth deps. This is what serves
# /api/setup/* (the wizard) and /api/branding to the frontend. Without it,
# the SPA gets 502 and the user can't even paste the Claude token.
pm2 start /home/coder/ecosystem.config.js --only workspace-api \
    2>&1 || echo "[entrypoint] WARNING: workspace-api failed to start"
echo "[entrypoint] workspace-api started (serves /api/* including the wizard)."

# Optional-skill install — run AFTER workspace-api boots so its migration
# logic has had a chance to populate ~/.claude.json's mcpServers with the
# user's integrations. We sleep a few seconds to let that finish before
# scanning. Idempotent: skips skills already in ~/.claude/skills/, so
# user edits and manual deletes survive container restarts.
(
    sleep 6
    if [ -d /opt/ide/skills/optional ] && [ -f /home/coder/.claude.json ]; then
        python3 <<'PYEOF' || echo "[entrypoint] WARNING: optional skill deploy failed"
import json, os, shutil, subprocess, sys
opt_dir = '/opt/ide/skills/optional'
# Bundle 6: single location for ALL skills. Default + optional + user-created
# all live here, distinguished by `source:` frontmatter (system / integration:<name> / project).
dest_root = '/home/coder/project/.claude/skills'
stamp_script = '/opt/ide/scripts/stamp-skill-frontmatter.sh'
os.makedirs(dest_root, exist_ok=True)
try:
    with open('/home/coder/.claude.json') as f:
        active = set((json.load(f).get('mcpServers') or {}).keys())
except Exception as e:
    print(f'[entrypoint] could not read .claude.json: {e}', file=sys.stderr)
    sys.exit(0)

def parse_requires(skill_md_path):
    try:
        with open(skill_md_path) as f: text = f.read()
        parts = text.split('---', 2)
        if len(parts) < 3: return []
        for line in parts[1].splitlines():
            if line.startswith('requires:'):
                val = line.split(':', 1)[1].strip()
                if val.startswith('['):
                    return [v.strip().strip('"\'') for v in val.strip('[]').split(',') if v.strip()]
                return [val.strip('"\'')]
    except Exception:
        return []
    return []

def stamp_dir(skill_dir, source_val):
    """Stamp source/editable/managed_by via the shared script."""
    if not os.path.exists(stamp_script): return
    try:
        subprocess.run([stamp_script, skill_dir, source_val, 'false', 'ide-template'],
                       check=False, capture_output=True, text=True, timeout=10)
    except Exception:
        pass  # stamp failures are non-fatal — skill still deployed

# Wipe stale integration skills first (preserve user-stamped `source: project`).
# Re-stages from scratch so deactivating an integration removes its skill cleanly.
for entry in os.listdir(dest_root):
    skill_path = os.path.join(dest_root, entry)
    skill_md = os.path.join(skill_path, 'SKILL.md')
    if not os.path.isdir(skill_path) or not os.path.exists(skill_md): continue
    try:
        with open(skill_md) as f: head = f.read(2000)
    except Exception:
        continue
    # If source: integration:* — wipe (we'll re-stage if still active)
    if 'source: integration:' in head:
        shutil.rmtree(skill_path, ignore_errors=True)

installed = []
for root, dirs, files in os.walk(opt_dir):
    if 'SKILL.md' not in files: continue
    requires = parse_requires(os.path.join(root, 'SKILL.md'))
    if not requires: continue
    if not any(r in active for r in requires): continue
    skill_name = os.path.basename(root)
    dest = os.path.join(dest_root, skill_name)
    if os.path.exists(dest): continue  # idempotent: skip if already there (user might have forked)
    shutil.copytree(root, dest)
    # Stamp source=integration:<first-requirement> (the MCP that gates it)
    primary_req = requires[0]
    stamp_dir(dest, f'integration:{primary_req}')
    installed.append(skill_name)

# Match ownership pattern from default-skill deploy
try:
    subprocess.run(['chown', '-R', 'coder:workspace', dest_root], check=False, capture_output=True)
except Exception:
    pass

if installed:
    print(f'[entrypoint] Optional skills deployed: {", ".join(sorted(installed))}')
else:
    print(f'[entrypoint] Optional skills: none to install (active={sorted(active)})')
PYEOF
    fi
) &

# Stage 2: bot + reminder-monitor — need Claude auth. Three ways to satisfy
# (in order of how Phase 3 evolved):
#   (a) wizard:  /var/wsapi-store/.platform.token.enc — encrypted in the
#                wsapi-store volume; workspace-api decrypts + hydrates on
#                token-set. The canonical path post-Phase-2.
#   (a') legacy wizard: PROJECT_DIR/.platform.token.enc — pre-Phase-2 path,
#                still checked for compat with old deploys.
#   (b)  bot-home: /home/bot/.claude/.credentials.json — the hydrated copy
#                that bot.sh actually reads at startup. Phase-3 path.
#   (c)  legacy:  /home/coder/.claude/.credentials.json — pre-Phase-3 path
#                (file is now renamed to .migrated.bak after H4 migration,
#                so this is here purely for the very first deploy where
#                migration hasn't run yet).
# True if Claude credentials exist by any path (legacy creds or wizard token).
has_claude_creds() {
    for f in /home/bot/.claude/.credentials.json \
             /home/coder/.claude/.credentials.json \
             /var/wsapi-store/.platform.token.enc \
             /home/coder/project/.platform.token.enc; do
        [ -f "$f" ] && return 0
    done
    return 1
}

# Start the bot process group (+ idempotent first-run project bootstrap).
# Used both when creds are present at container start AND by the deferred-token
# watcher below — so a token pasted into the wizard AFTER startup brings the
# bot up on its own, without a manual container restart.
start_bot_stack() {
    # First-run bootstrap: scaffold default folder structure + system reminders
    # + Tasks/Pending templates on a fresh project. Idempotent (gated by
    # ~/project/.bootstrapped) and skipped when ~/project/.claude/CLAUDE.md exists.
    if [ -x /opt/ide/bootstrap/bootstrap-project.sh ]; then
        BOT_NAME="$BOT_NAME" PROJECT_DIR="$PROJECT_DIR" BOOTSTRAP_SRC=/opt/ide/bootstrap \
            su coder -c '/opt/ide/bootstrap/bootstrap-project.sh' \
            2>&1 | sed 's/^/[bootstrap] /' || \
            echo "[entrypoint] WARNING: bootstrap-project.sh exited non-zero — workspace may be missing baseline rituals"
    fi

    # One-time migration of an existing Markdown Tasks.md into the structured
    # board (.tasks.json). Idempotent + self-guarded (no-op once migrated or if
    # there's no Tasks.md), so it's safe to run on every boot for old clients.
    # Runs as coder (a workspace-group member); then we match .tasks.json to the
    # .reminders.json ownership model (group `workspace`, group-writable) so both
    # wsapi (the board API) and the tasks MCP can rewrite it on mutation.
    # NOTE: use `runuser`, not `su coder -c` — in this non-interactive entrypoint
    # context `su` hits PAM and fails with "Authentication failure" (the same
    # reason the bootstrap-project su line above is effectively a no-op). runuser
    # drops privileges as root without PAM auth.
    if [ -f /opt/ide/bootstrap/migrate-tasks.mjs ]; then
        runuser -u coder -- env PROJECT_DIR="$PROJECT_DIR" node /opt/ide/bootstrap/migrate-tasks.mjs \
            2>&1 | sed 's/^/[migrate-tasks] /' || true
        if [ -f "$PROJECT_DIR/.tasks.json" ]; then
            chgrp workspace "$PROJECT_DIR/.tasks.json" 2>/dev/null || true
            chmod 664 "$PROJECT_DIR/.tasks.json" 2>/dev/null || true
        fi
    fi

    pm2 start /home/coder/ecosystem.config.js --only "${BOT_NAME},${BOT_NAME}-reminders,${BOT_NAME}-snapshot,${BOT_NAME}-browser-watchdog,${BOT_NAME}-docs-keepalive" \
        2>&1 || echo "[entrypoint] WARNING: ${BOT_NAME} failed to start"
    pm2 save 2>/dev/null || true
}

if has_claude_creds; then
    echo "[entrypoint] Claude credentials present — starting ${BOT_NAME} + reminders."
    start_bot_stack
else
    echo "[entrypoint] Claude not logged in — ${BOT_NAME} bot deferred. Paste a token in the wizard (Step 4); the bot starts automatically within seconds — no restart needed."
    pm2 save 2>/dev/null || true
    # Alert via Telegram only if creds were ever expected (token configured but missing now)
    if [ -x /home/coder/bot-notify.sh ] && [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
        /home/coder/bot-notify.sh "Claude credentials missing on ${IDE_NAME:-workspace} — bot deferred until token is supplied via wizard." 2>/dev/null &
    fi
    # Watch for the wizard to write a token, then start the bot. Closes the
    # bootstrapping gap: restartBot() only signals an ALREADY-running bot.sh, so
    # a token supplied after container start would otherwise never launch the
    # deferred bot. This watcher runs for the container's lifetime until a token
    # appears, then starts the stack once and exits.
    (
        while ! has_claude_creds; do sleep 5; done
        echo "[entrypoint] Claude token detected — starting deferred ${BOT_NAME} bot."
        start_bot_stack
    ) &
fi

# Wait for code-server (main process)
wait $CODE_SERVER_PID
