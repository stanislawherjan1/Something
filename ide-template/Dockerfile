# Pin the base image — `:latest` would re-roll on every rebuild and silently
# pull in upstream regressions. Bump deliberately on a schedule. For full
# reproducibility, also add the @sha256:<digest> after testing one rebuild
# (we don't pin the digest here so this template isn't blocked on a manual
# `docker pull` step, but it's a real follow-up).
FROM codercom/code-server:4.118.0

USER root

# Strip the base image's `coder ALL=(ALL) NOPASSWD:ALL` sudoers entry. Without
# this, every process running as `coder` (workspace-api, the bot, every MCP,
# any terminal) can escalate to root and read /run/secrets/integrations.key
# directly — turning the AES-GCM credential store into theatre against any
# in-container code execution. The two `sudo` calls in entrypoint.sh both
# run while pid 1 is still root, so they don't depend on this passwordless
# path. If a specific command genuinely needs root, add a tight sudoers
# entry for that one binary (e.g. `coder ALL=(root) NOPASSWD: /bin/chown …`).
RUN rm -f /etc/sudoers.d/nopasswd && \
    sed -i '/coder.*NOPASSWD/d' /etc/sudoers && \
    grep -rl 'coder.*NOPASSWD' /etc/sudoers.d/ 2>/dev/null | xargs -r rm -f

# === LAYER 0a: Privilege-isolation users + groups ============================
# Four uids:
#   1000 (coder, base-image default)  — code-server, terminal sessions, the
#                                       VS Code editor itself
#   1001 (wsapi)                      — workspace-api process; owns the AES
#                                       master key + encrypted store
#   1002 (mcp)                        — every MCP subprocess (Shopify, Meta,
#                                       Google Workspace bundle, etc.); only
#                                       sees its own credentials via the broker
#   1003 (bot)                        — the bot's tmux Claude session
#                                       (`claude --channels`). Owns the
#                                       Claude OAuth token + Telegram bot
#                                       token; coder cannot read them.
#
# Three groups bridge them:
#   workspace      (gid 1100)  coder + wsapi + mcp + bot — shared rw on PROJECT_DIR
#   wsapi-broker   (gid 1101)  wsapi + mcp              — UDS access to broker
#                                                         socket. Coder + bot
#                                                         NOT in this group.
#   botshare       (gid 1102)  wsapi + bot              — wsapi writes secret
#                                                         files for bot to read.
#                                                         Coder NOT in this
#                                                         group, so the IDE
#                                                         terminal/code-server
#                                                         cannot read the
#                                                         Claude OAuth token
#                                                         or bot integrations.env.
#
# wsapi, mcp, and bot all use /usr/sbin/nologin — they're never logged into;
# entered only via the matching setuid runner binaries.
RUN groupadd -g 1100 workspace && \
    groupadd -g 1101 wsapi-broker && \
    groupadd -g 1102 botshare && \
    useradd  -u 1001 -g 1001 -m -s /usr/sbin/nologin --no-user-group wsapi 2>/dev/null || \
        useradd -u 1001 -m -s /usr/sbin/nologin wsapi && \
    useradd  -u 1002 -g 1002 -m -s /usr/sbin/nologin --no-user-group mcp   2>/dev/null || \
        useradd -u 1002 -m -s /usr/sbin/nologin mcp && \
    useradd  -u 1003 -g 1003 -d /home/bot -m -s /usr/sbin/nologin --no-user-group bot 2>/dev/null || \
        useradd -u 1003 -d /home/bot -m -s /usr/sbin/nologin bot && \
    usermod -a -G workspace coder && \
    usermod -a -G workspace wsapi && \
    usermod -a -G workspace mcp && \
    usermod -a -G workspace bot && \
    usermod -a -G wsapi-broker wsapi && \
    usermod -a -G wsapi-broker mcp && \
    usermod -a -G botshare wsapi && \
    usermod -a -G botshare bot && \
    chown bot:botshare /home/bot && \
    chmod 0771 /home/bot

# === LAYER 1: System packages (Node.js 20, rclone, tmux, socat) ===
# build-essential added so the setuid wrappers compile in LAYER 1b.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
    nodejs \
    rclone \
    inotify-tools \
    wget \
    unzip \
    xclip \
    tmux \
    build-essential \
    python3 \
    python3-pip \
    python3-venv \
    iptables \
    iproute2 \
    redsocks \
    xvfb \
    x11vnc \
    websockify \
    novnc \
    jq && \
    rm -rf /var/lib/apt/lists/*

# === LAYER 1b: Compile + install setuid wrappers =============================
# Two tiny ~80-line C programs that drop privileges before exec'ing Node.
# Source + rationale lives in setuid-wrappers/. Compiled in-image so we
# don't have to ship binaries from the operator's laptop.
#
# Mode 4755 = setuid bit + rwxr-xr-x. owner=root means coder/PM2 invoking
# /usr/local/bin/wsapi-runner ends up as uid 1001 (wsapi). Same for
# mcp-runner → uid 1002 (mcp). After the exec the setuid bit doesn't
# propagate to the spawned Node process.
#
# mcp-runner + monitor-runner ALSO call PR_SET_NO_NEW_PRIVS post-drop —
# they're terminal nodes (no further setuid exec downstream). wsapi-runner
# + bot-runner do NOT call it: they spawn claude which spawns mcp-runner,
# and PR_SET_NO_NEW_PRIVS would inherit and kill mcp-runner's setuid bit.
# The 2026-06-04 canary incident traced 11/16 web-side MCPs silently
# failing back to a stale `prctl(PR_SET_NO_NEW_PRIVS)` call in wsapi-runner;
# removing it matched the same trade-off bot-runner.c documents.
COPY setuid-wrappers /tmp/setuid-wrappers
RUN gcc -O2 -Wall -Wextra -o /usr/local/bin/wsapi-runner   /tmp/setuid-wrappers/wsapi-runner.c   && \
    gcc -O2 -Wall -Wextra -o /usr/local/bin/mcp-runner     /tmp/setuid-wrappers/mcp-runner.c     && \
    gcc -O2 -Wall -Wextra -o /usr/local/bin/bot-runner     /tmp/setuid-wrappers/bot-runner.c     && \
    gcc -O2 -Wall -Wextra -o /usr/local/bin/monitor-runner /tmp/setuid-wrappers/monitor-runner.c && \
    chown root:root /usr/local/bin/wsapi-runner /usr/local/bin/mcp-runner /usr/local/bin/bot-runner /usr/local/bin/monitor-runner && \
    chmod 4755     /usr/local/bin/wsapi-runner /usr/local/bin/mcp-runner /usr/local/bin/bot-runner /usr/local/bin/monitor-runner && \
    rm -rf /tmp/setuid-wrappers

# === LAYER 2: Claude Code CLI + pm2 ===
# claude-code ≥2.1.86 ships a stub `bin/claude.exe` + `install.cjs`
# postinstall that hardlinks the per-arch native binary from an
# optionalDependency (e.g. @anthropic-ai/claude-code-linux-x64) over
# the stub. With --ignore-scripts the postinstall never ran and the
# stub printed "Error: claude native binar..." → bot tmux crashloop.
# install.cjs only does a local hardlink — no network, no github CDN
# — so dropping the flag is safe on every Hetzner host we deploy to.
# pm2 stays with --ignore-scripts (no postinstall it needs).
RUN npm install -g @anthropic-ai/claude-code@2.1.128 && \
    mkdir -p /home/coder/.npm-global && \
    npm install -g pm2 --prefix /home/coder/.npm-global --ignore-scripts

# === LAYER 2b: Bun runtime (for Telegram plugin) ===
# Was: `curl -fsSL https://bun.sh/install | bash`. The bun.sh script
# downloads the linux-x64 zip from github.com/oven-sh/bun/releases.
# On at least one of our Hetzner hosts (2026-05-12) every
# attempt to fetch that release URL from inside a Docker build
# container terminates with "curl: (35) Recv failure: Connection
# reset by peer" — same curl from the host shell works fine, so it
# looks like a buildkit/networking interaction with github releases'
# CDN. Multi-stage copy from oven/bun's official image sidesteps the
# entire HTTPS dance and is repeatable on every host we deploy to.
# Same binary, same version pin (bumping = bump the FROM tag).
COPY --from=oven/bun:1.3 /usr/local/bin/bun /home/coder/.bun/bin/bun
RUN chmod 0755 /home/coder/.bun/bin/bun && chown -R coder:coder /home/coder/.bun

# === LAYER 2b.5: Pre-install Telegram plugin offline ============================
# COPY the plugin marketplace + telegram source from the build
# context. deploy.sh pre-clones github.com/anthropics/claude-plugins-official
# on the deploy host (where the shell has working network) and stages
# it under plugins-src/ next to the Dockerfile.
#
# We don't `RUN git clone` inside the build itself because at least
# one of our Hetzner hosts (2026-05-12) terminates github CDN
# fetches from BuildKit network with TCP RST. Same git clone runs
# fine from the host shell, so we stage on the host and COPY.
#
# bun install runs inside the build container — it talks to
# registry.npmjs.org which has been historically reliable from
# BuildKit on every host. --frozen-lockfile enforces reproducible
# resolution against the marketplace's pinned bun.lock.
#
# entrypoint.sh root-block materializes /opt/ide/plugins-src into
# /home/bot/.claude/plugins/{cache,marketplaces}/ with installed_plugins.json
# + known_marketplaces.json pre-pointed at /home/bot paths, so bot.sh
# never needs `claude plugins install` (the previous path which
# required runtime github access).
ENV CLAUDE_PLUGIN_SRC=/opt/ide/plugins-src
COPY plugins-src /opt/ide/plugins-src
# Telegram plugin source lives at external_plugins/telegram/ inside
# the marketplace clone — the top-level marketplace.json points at
# `./external_plugins/telegram` as the plugin source for the "telegram"
# entry. bun install fetches the plugin's npm deps (grammy, MCP SDK)
# from registry.npmjs.org (always-on in our egress allow-list).
RUN cd /opt/ide/plugins-src/external_plugins/telegram && \
    /home/coder/.bun/bin/bun install --frozen-lockfile && \
    chown -R coder:coder /opt/ide/plugins-src

# === LAYER 2c: MCP servers — pre-installed so there's no cold npx download at runtime ===
ENV PATH="/home/coder/.bun/bin:/home/coder/.npm-global/bin:${PATH}"

RUN npm install -g \
    @modelcontextprotocol/server-memory \
    --prefix /home/coder/.npm-global

RUN pip install --no-cache-dir --break-system-packages --ignore-installed \
    google-analytics-mcp

# === LAYER 2d: Custom MCP servers (shopify, meta, google-ads, seedream) ===
# Shared helpers used by every MCP — google-oauth.js (token refresh) +
# broker-client.js (credential fetch over UDS + global HTTPS_PROXY
# ProxyAgent for Node fetch).
#
# broker-client.js imports `undici` for the ProxyAgent (Node's built-in
# fetch DOES use undici internally but doesn't export ProxyAgent — needs
# the npm package). Each MCP imports `../_shared/broker-client.js` so
# Node's ESM resolver walks UP from /opt/ide/apps/_shared/ looking for
# `node_modules/undici/`. Installing it HERE once means every MCP
# automatically resolves it — no need to duplicate the dep across all
# 11 MCP package.json files.
#
# Without this install: every brokered MCP crashes at import time with
# `ERR_MODULE_NOT_FOUND: Cannot find package 'undici'` BEFORE
# loadCredentials() even runs. claude mcp list shows them as
# "✗ Failed to connect" and the bot reports the tool as unavailable.
# Caught on a first-broker-deploy 2026-05-13.
COPY apps/_shared /opt/ide/apps/_shared
RUN cd /opt/ide/apps/_shared && npm install --omit=dev

COPY apps/shopify-mcp /opt/ide/apps/shopify-mcp
RUN cd /opt/ide/apps/shopify-mcp && npm install --production

COPY apps/meta-mcp /opt/ide/apps/meta-mcp
RUN cd /opt/ide/apps/meta-mcp && npm install --production

COPY apps/google-ads-mcp /opt/ide/apps/google-ads-mcp
RUN cd /opt/ide/apps/google-ads-mcp && npm install --production

COPY apps/seedream-mcp /opt/ide/apps/seedream-mcp
RUN cd /opt/ide/apps/seedream-mcp && npm install --production

COPY apps/nano-banana-mcp /opt/ide/apps/nano-banana-mcp
RUN cd /opt/ide/apps/nano-banana-mcp && npm install --production

COPY apps/reminder-mcp /opt/ide/apps/reminder-mcp
RUN cd /opt/ide/apps/reminder-mcp && npm install --production

COPY apps/workspace-api-mcp /opt/ide/apps/workspace-api-mcp
RUN cd /opt/ide/apps/workspace-api-mcp && npm install --production

COPY apps/web-channel-mcp /opt/ide/apps/web-channel-mcp
RUN cd /opt/ide/apps/web-channel-mcp && npm install --production

COPY apps/email-mcp /opt/ide/apps/email-mcp
RUN cd /opt/ide/apps/email-mcp && npm install --production

# github-mcp: thin node wrapper + official Go binary from github/github-mcp-server.
# Wrapper handles broker creds + conditional --read-only / --toolsets flags;
# binary does the actual GitHub API work. Pin to a release tag — `latest` would
# silently swap the binary under us on every rebuild.
ARG GITHUB_MCP_VERSION=v1.1.2
COPY apps/github-mcp /opt/ide/apps/github-mcp
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64)  asset="github-mcp-server_Linux_x86_64.tar.gz" ;; \
      aarch64) asset="github-mcp-server_Linux_arm64.tar.gz"  ;; \
      *) echo "github-mcp: unsupported arch $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/github-mcp.tar.gz \
      "https://github.com/github/github-mcp-server/releases/download/${GITHUB_MCP_VERSION}/${asset}"; \
    tar -xzf /tmp/github-mcp.tar.gz -C /opt/ide/apps/github-mcp/ github-mcp-server; \
    chmod +x /opt/ide/apps/github-mcp/github-mcp-server; \
    rm /tmp/github-mcp.tar.gz

COPY apps/grok-mcp /opt/ide/apps/grok-mcp
RUN cd /opt/ide/apps/grok-mcp && npm install --production

COPY apps/openai-mcp /opt/ide/apps/openai-mcp
RUN cd /opt/ide/apps/openai-mcp && npm install --production

# Docs Comments (Playwright range-anchored Google Docs comments) — first-class
# integration shipped to every client. Pulls playwright-core (reuses the system
# chromium installed by the playwright-mcp layer; no bundled browsers).
COPY apps/docs-comments-mcp /opt/ide/apps/docs-comments-mcp
RUN cd /opt/ide/apps/docs-comments-mcp && npm install --production

COPY apps/gemini-chat-mcp /opt/ide/apps/gemini-chat-mcp
RUN cd /opt/ide/apps/gemini-chat-mcp && npm install --production

COPY apps/signwell-mcp /opt/ide/apps/signwell-mcp
RUN cd /opt/ide/apps/signwell-mcp && npm install --production

COPY apps/trello-mcp /opt/ide/apps/trello-mcp
RUN cd /opt/ide/apps/trello-mcp && npm install --production

COPY apps/gdocs-mcp /opt/ide/apps/gdocs-mcp
RUN cd /opt/ide/apps/gdocs-mcp && npm install --production

COPY apps/gsheets-mcp /opt/ide/apps/gsheets-mcp
RUN cd /opt/ide/apps/gsheets-mcp && npm install --production

COPY apps/gcalendar-mcp /opt/ide/apps/gcalendar-mcp
RUN cd /opt/ide/apps/gcalendar-mcp && npm install --production

COPY apps/gdrive-mcp /opt/ide/apps/gdrive-mcp
RUN cd /opt/ide/apps/gdrive-mcp && npm install --production

COPY apps/gslides-mcp /opt/ide/apps/gslides-mcp
RUN cd /opt/ide/apps/gslides-mcp && npm install --production

COPY apps/gtasks-mcp /opt/ide/apps/gtasks-mcp
RUN cd /opt/ide/apps/gtasks-mcp && npm install --production

COPY apps/x-mcp /opt/ide/apps/x-mcp
RUN cd /opt/ide/apps/x-mcp && npm install --production

COPY apps/substack-mcp /opt/ide/apps/substack-mcp
RUN cd /opt/ide/apps/substack-mcp && npm install --production

# === LAYER 2f: workspace-api (web chat backend) ===
# Express server that wraps `claude -p` with SSE streaming for the React workspace.
# Started by PM2 alongside the bot. Listens on 127.0.0.1:3001 inside the container.
COPY workspace-api /opt/ide/workspace-api
RUN cd /opt/ide/workspace-api && npm install --production

# === LAYER 2e: Playwright MCP + Chromium browser ===
# Pre-installed so there's no download at runtime — the egress-proxy
# does NOT allow cdn.playwright.dev (and never will: arbitrary browser
# downloads at runtime are a prompt-injection escape hatch).
#
# Browser install path is FIXED via PLAYWRIGHT_BROWSERS_PATH so every
# uid in the container (coder 1000, wsapi 1001, mcp 1002, bot 1003)
# resolves to the same binary regardless of which $HOME they inherit.
# Without this, install lands in /root/.cache/ms-playwright (the user
# active in this Dockerfile layer is root for the `apt install` step),
# bot at uid 1003 with HOME=/home/bot can't read it, and playwright-mcp
# silently tries to download via `npx` — which hits the 403 egress wall
# and bubbles up as "browser not available" in chat.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
# Stable alias for the chromium version the codebase hardcodes. `playwright
# install` pulls whatever version it currently pins (e.g. chromium-1228), so the
# literal /opt/playwright-browsers/chromium-1223/... paths in docs-comments and
# entrypoint.sh go stale and spawn() ENOENTs after a rebuild. If the pinned dir
# is absent, symlink chromium-1223 → the version that actually landed so every
# hardcoded path keeps resolving across playwright bumps.
RUN npm install -g @playwright/mcp playwright --prefix /home/coder/.npm-global && \
    mkdir -p /opt/playwright-browsers && \
    /home/coder/.npm-global/bin/playwright install --with-deps chromium && \
    chmod -R a+rX /opt/playwright-browsers && \
    { [ -e /opt/playwright-browsers/chromium-1223/chrome-linux64/chrome ] || \
      ln -sfn "$(ls -d /opt/playwright-browsers/chromium-[0-9]*/ | sort -V | tail -1 | sed 's#/$##')" /opt/playwright-browsers/chromium-1223 ; }

# === LAYER 3: VS Code Extensions ===
RUN code-server --install-extension Anthropic.claude-code@2.1.85 \
    || (wget -q "https://open-vsx.org/api/Anthropic/claude-code/2.1.85/file/Anthropic.claude-code.vsix" \
    -O /tmp/claude-code.vsix && \
    code-server --install-extension /tmp/claude-code.vsix && \
    rm -f /tmp/claude-code.vsix)
RUN code-server --install-extension cweijan.vscode-office \
    || echo "WARNING: vscode-office extension not found on marketplace"

# === Uninstall GitHub Copilot extensions (we use Claude Code only) ===
RUN code-server --uninstall-extension GitHub.copilot 2>/dev/null || true
RUN code-server --uninstall-extension GitHub.copilot-chat 2>/dev/null || true

# === LAYER 4: VS Code settings + global Claude rules (staged for entrypoint copy) ===
RUN mkdir -p /opt/ide
COPY settings.json /opt/ide/settings.json
COPY global-claude.md /opt/ide/global-claude.md
COPY skills/default /opt/ide/skills/default
# Optional skills — auto-installed when the matching integration goes
# active. Folder name convention: <integration-id>-protocol/. Entrypoint
# (and workspace-api on activate) copies the matching ones into
# ~/.claude/skills/ idempotently; existing copies are never overwritten,
# so user edits to a skill survive future activations.
COPY skills/optional /opt/ide/skills/optional
COPY bootstrap /opt/ide/bootstrap
RUN chmod +x /opt/ide/bootstrap/bootstrap-project.sh

# CC hooks — bash scripts wired into ~/.claude/settings.json that fire
# at PostToolUse / Stop / etc. See ide-template/hooks/ for sources +
# bootstrap/claude-settings.json for hook registration.
COPY hooks /opt/ide/hooks
RUN chmod +x /opt/ide/hooks/*.sh /opt/ide/hooks/*.py 2>/dev/null || true

# Helper scripts — frontmatter stamping (Bundle 6), etc.
COPY scripts /opt/ide/scripts
RUN chmod +x /opt/ide/scripts/*.sh 2>/dev/null || true

# === LAYER 5: Branding extension (build TypeScript) ===
COPY extensions/branding /tmp/branding
RUN cd /tmp/branding && \
    npm install && \
    npm run build && \
    mkdir -p /home/coder/.local/share/code-server/extensions && \
    cp -r /tmp/branding /home/coder/.local/share/code-server/extensions/ide.branding && \
    rm -rf /tmp/branding

# === LAYER 6: Merge root-installed extensions + coder extensions, then stage ===
RUN cp -r /root/.local/share/code-server/extensions/* \
    /home/coder/.local/share/code-server/extensions/ 2>/dev/null || true && \
    cp -r /home/coder/.local/share/code-server/extensions /opt/ide/extensions

# === LAYER 7: Custom CSS + JS injection (overrides + mobile view switcher) ===
COPY overrides.css /opt/ide/overrides.css
COPY mobile.js /opt/ide/mobile.js
COPY inject.js /opt/ide/inject.js
RUN WORKBENCH_HTML=$(find /usr/lib/code-server -name "workbench.html" -path "*/browser/*" 2>/dev/null | head -1) && \
    if [ -n "$WORKBENCH_HTML" ]; then \
    node /opt/ide/inject.js "$WORKBENCH_HTML"; \
    else \
    echo "WARNING: workbench.html not found"; \
    fi

# === LAYER 8: Bot scripts (parametric — name controlled by BOT_NAME env var) ===
ENV BOT_NAME=bot
COPY bot/bot.sh /opt/ide/bot.sh
COPY bot/bot-notify.sh /opt/ide/bot-notify.sh
COPY bot/web-notify.sh /opt/ide/web-notify.sh
COPY bot/bot-relay.sh /opt/ide/bot-relay.sh
COPY bot/reminder-monitor.sh /opt/ide/reminder-monitor.sh
COPY bot/recent-snapshot-monitor.sh /opt/ide/recent-snapshot-monitor.sh
COPY bot/browser-watchdog.sh /opt/ide/browser-watchdog.sh
COPY bot/ecosystem.config.js /opt/ide/ecosystem.config.js
RUN chmod +x /opt/ide/bot.sh /opt/ide/bot-notify.sh /opt/ide/web-notify.sh /opt/ide/bot-relay.sh /opt/ide/reminder-monitor.sh /opt/ide/recent-snapshot-monitor.sh /opt/ide/browser-watchdog.sh

# === LAYER 9: Entrypoint ===
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# === LAYER 10: Directories, permissions, and shell PATH ===
RUN mkdir -p /home/coder/project \
    /home/coder/.config/rclone \
    /home/coder/.claude \
    /home/coder/.claude/channels/telegram \
    /home/coder/.${BOT_NAME} \
    /home/coder/.npm && \
    echo 'export PATH="$HOME/.bun/bin:$HOME/.npm-global/bin:$PATH"' >> /home/coder/.bashrc && \
    echo 'export PATH="$HOME/.bun/bin:$HOME/.npm-global/bin:$PATH"' >> /home/coder/.zshrc 2>/dev/null || true && \
    echo 'export PATH="$HOME/.bun/bin:$HOME/.npm-global/bin:$PATH"' >> /home/coder/.profile && \
    chown -R coder:coder /home/coder

# USER coder (Disabled to allow entrypoint.sh to fix volume permissions as root on startup)
USER root

EXPOSE 8080
EXPOSE 9090

# Health check: verifies code-server (main UI) is alive
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD curl -sf http://localhost:8080/ > /dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
