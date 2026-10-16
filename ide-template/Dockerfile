# syntax=docker/dockerfile:1
# === STAGE: setuid wrappers (compiled here; the compiler stays out of the image) ===
# Six ~80-line C programs that drop privileges before exec'ing Node (source +
# rationale in setuid-wrappers/). Same Debian release as the base image so the
# binaries link against the same libc.
FROM debian:trixie-slim AS wrappers
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY setuid-wrappers /src
RUN mkdir -p /out && for w in wsapi-runner mcp-runner bot-runner monitor-runner turn-runner priv-tree; do \
      gcc -O2 -Wall -Wextra -o "/out/$w" "/src/$w.c"; done

# Pin the base image — `:latest` would re-roll on every rebuild and silently
# pull in upstream regressions. Bump deliberately on a schedule. For full
# reproducibility, also add the @sha256:<digest> after testing one rebuild
# (we don't pin the digest here so this template isn't blocked on a manual
# `docker pull` step, but it's a real follow-up).
FROM codercom/code-server:4.118.0
# Layer order is the build cache: what rarely changes (packages, browser, CLI,
# extensions) comes first, the apps and scripts that change every release last,
# so a routine deploy rebuilds only the tail. Ownership is set in the layer that
# creates the files — a later chown copies every file into a new layer.

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
    chmod 0771 /home/bot && \
    # The turn users: a web, group or headless Claude turn runs as one of
    # them, started by workspace-api through turn-runner (which names the
    # slot). Each is in `workspace` for the project files and in nothing
    # else: not botshare (its MCP config is written per turn, see
    # lib/claude.js), not wsapi-broker (no broker socket).
    #   turn (1005)            a solo workspace: one person, one turn user
    #   turn-group (1130)      a Telegram group's turn — no private tree at all
    #   turn-01…24 (1101–1124) one per person on the roster, each with a
    #                          private group priv-01…24 (1201–1224) that owns
    #                          their private trees (users/<slug>, memory/users/
    #                          <slug>, .team/users/<slug>: turn-NN:priv-NN 2770).
    #                          wsapi is in every priv-* group — the engine must
    #                          read and write them; bot and coder join the
    #                          primary admin's at boot (priv-tree grant).
    # Homes live under /home/turns (a volume); the entrypoint lays them out.
    useradd  -u 1005 -g 1005 -d /home/turns/solo -M -s /usr/sbin/nologin --no-user-group turn 2>/dev/null || \
        useradd -u 1005 -d /home/turns/solo -M -s /usr/sbin/nologin turn && \
    usermod -a -G workspace turn && \
    groupadd -g 1130 turn-group && \
    useradd  -u 1130 -g 1130 -d /home/turns/group -M -s /usr/sbin/nologin turn-group && \
    usermod -a -G workspace turn-group && \
    # (RUN is /bin/sh: no bash arithmetic — the slot number is padded by printf.)
    for i in $(seq 1 24); do \
        n=$(printf '%02d' "$i") && \
        groupadd -g $((1200 + i)) priv-$n && \
        useradd -u $((1100 + i)) -g priv-$n -d /home/turns/$n -M -s /usr/sbin/nologin turn-$n && \
        usermod -a -G workspace turn-$n && \
        usermod -a -G priv-$n wsapi || exit 1; \
    done && \
    # The run directories a turn's MCP config is written into: one per slot,
    # root:<slot's group> 2730 — workspace-api (in the group) writes, the
    # slot's user (the group too) reads what it is given, nobody else sees in.
    mkdir -p /run/turns && chmod 0711 /run/turns && \
    mkdir -p /run/turns/solo /run/turns/group && \
    chown root:turn /run/turns/solo && chmod 2730 /run/turns/solo && usermod -a -G turn wsapi && \
    chown root:turn-group /run/turns/group && chmod 2730 /run/turns/group && usermod -a -G turn-group wsapi && \
    for i in $(seq 1 24); do n=$(printf '%02d' "$i") && mkdir -p /run/turns/$n && chown root:priv-$n /run/turns/$n && chmod 2730 /run/turns/$n || exit 1; done

# === LAYER 1: System packages (Node.js 22, rclone, tmux, socat) ===
# build-essential added so the setuid wrappers compile in LAYER 1b.
# tzdata-legacy: the old zone names (Asia/Calcutta, Europe/Kiev…)
# moved out of tzdata in Debian trixie; without them `TZ=Asia/Calcutta date`
# prints UTC — the morning planner once thought it was 23:00 and planned nothing.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
    nodejs \
    rclone \
    inotify-tools \
    wget \
    unzip \
    xclip \
    tmux \
    tzdata-legacy \
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
    libpango-1.0-0 \
    libpangoft2-1.0-0 \
    libpangocairo-1.0-0 \
    libharfbuzz0b \
    libffi8 \
    fonts-liberation2 \
    fonts-dejavu-core \
    poppler-utils \
    jq && \
    rm -rf /var/lib/apt/lists/*

# === LAYER 1b: setuid wrappers (from the build stage) ========================
# Mode 4755 = setuid bit + rwxr-xr-x. owner=root means coder/PM2 invoking
# /usr/local/bin/wsapi-runner ends up as uid 1001 (wsapi). Same for
# mcp-runner → uid 1002 (mcp). After the exec the setuid bit doesn't
# propagate to the spawned Node process.
#
# mcp-runner + monitor-runner ALSO call PR_SET_NO_NEW_PRIVS post-drop —
# they're terminal nodes (no further setuid exec downstream). wsapi-runner
# + bot-runner do NOT call it: they spawn claude which spawns mcp-runner,
# and PR_SET_NO_NEW_PRIVS would inherit and kill mcp-runner's setuid bit.
COPY --from=wrappers /out/ /usr/local/bin/
RUN chown root:root /usr/local/bin/wsapi-runner /usr/local/bin/mcp-runner /usr/local/bin/bot-runner /usr/local/bin/monitor-runner && \
    chmod 4755     /usr/local/bin/wsapi-runner /usr/local/bin/mcp-runner /usr/local/bin/bot-runner /usr/local/bin/monitor-runner && \
    # turn-runner and priv-tree: executable by workspace-api's group only (they check the caller too).
    chown root:wsapi /usr/local/bin/turn-runner /usr/local/bin/priv-tree && \
    chmod 4750       /usr/local/bin/turn-runner /usr/local/bin/priv-tree

# === LAYER 2: Claude Code CLI + pm2 ===
# claude-code ≥2.1.86 ships a stub `bin/claude.exe` + `install.cjs`
# postinstall that hardlinks the per-arch native binary from an
# optionalDependency (e.g. @anthropic-ai/claude-code-linux-x64) over
# the stub. With --ignore-scripts the postinstall never ran and the
# stub printed "Error: claude native binar..." → bot tmux crashloop.
# install.cjs only does a local hardlink — no network, no github CDN
# — so dropping the flag is safe on every Hetzner host we deploy to.
# pm2 stays with --ignore-scripts (no postinstall it needs).
# NOTE: claude-code ≥2.1.200 requires node >=22 — LAYER 1's nodesource
# pin (setup_22.x) and this version move together.
# PINNED to 2.1.150 (2026-07-14) — newest version WITHOUT the channel
# killer. CLI ≥2.1.152 SIGINT-kills type-less MCP servers (= channel
# plugins) on connection close; with the ~5s channel-registration
# deadline and Telegram poller-takeover latency (409 window) the channel
# intermittently death-loops and dies (observed 2×/day on 2.1.207 on
# heavy turns; the bot.sh plugin-watchdog auto-healed each in ~90s, but
# a mid-flight turn is still lost). Boundary 2.1.150→2.1.152 found by
# binary diff of the npm platform packages. NOTE: 2.1.150 predates the
# 2.1.156 Opus 4.8 thinking-block fix — pin bot models to Sonnet-family
# (settings.json "model") until the durable fix lands. Durable fix =
# plugin-side: register the channel before poller takeover; then the
# newest CLIs (agent teams, workflows, Opus 4.8) are safe again.
RUN --mount=type=cache,target=/root/.npm npm install -g @anthropic-ai/claude-code@2.1.150 && \
    mkdir -p /home/coder/.npm-global && \
    npm install -g pm2@7.0.4 --prefix /home/coder/.npm-global --ignore-scripts && \
    chown -R coder:coder /home/coder/.npm-global

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
COPY --from=oven/bun:1.3 --chown=coder:coder --chmod=0755 /usr/local/bin/bun /home/coder/.bun/bin/bun
ENV PATH="/home/coder/.bun/bin:/home/coder/.npm-global/bin:${PATH}"

# npm's download cache lives in a BuildKit cache mount on every npm step
# (`--mount=type=cache,target=/root/.npm`): shared between steps and builds,
# never baked into a layer — before, each of ~30 installs left its tarballs
# under /root/.npm in the image.

# === LAYER 2c: MCP servers — pre-installed so there's no cold npx download at runtime ===

RUN --mount=type=cache,target=/root/.npm npm install -g \
    @modelcontextprotocol/server-memory@1.0.0 \
    --prefix /home/coder/.npm-global && \
    chown -R coder:coder /home/coder/.npm-global

# Pinned: an unpinned third-party pip package is code we haven't read changing
# under us between builds (CLAUDE.md "pin what you pull in").
RUN pip install --no-cache-dir --break-system-packages --ignore-installed \
    google-analytics-mcp==2.11.5

# PDF toolchain for pdf-mcp: python-markdown → weasyprint. The one supported
# way to make PDFs (apps/pdf-mcp). System libs (pango/harfbuzz/ffi) + fonts +
# poppler-utils are installed in LAYER 1a above. NO latin-1 mangling, no
# hand-rolled PDF bytes — weasyprint is a real CSS/paged-media engine.
RUN pip install --no-cache-dir --break-system-packages --ignore-installed \
    weasyprint \
    markdown

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
# Pinned (CLAUDE.md: pin what you pull in). Full Chromium only (--no-shell):
# both the MCP and the Docs login launch the full browser by its path, so the
# headless shell was 270 MB nothing ran.
RUN --mount=type=cache,target=/root/.npm npm install -g @playwright/mcp@0.0.83 playwright@1.64.0 --prefix /home/coder/.npm-global && \
    chown -R coder:coder /home/coder/.npm-global && \
    mkdir -p /opt/playwright-browsers && \
    /home/coder/.npm-global/bin/playwright install --with-deps --no-shell chromium && \
    chmod -R a+rX /opt/playwright-browsers && \
    { [ -e /opt/playwright-browsers/chromium-1223/chrome-linux64/chrome ] || \
      { t="$(ls -d /opt/playwright-browsers/chromium-[0-9]*/ 2>/dev/null | sort -V | tail -1 | sed 's#/$##')"; [ -z "$t" ] || ln -sfn "$t" /opt/playwright-browsers/chromium-1223 ; } ; }

# === LAYER 3: VS Code Extensions ===
# Installed straight into the coder user's extensions dir — the one code-server
# reads — and owned by coder in the same layer. (They used to be installed under
# /root, copied to coder's dir, copied again to /opt/ide for a boot-time
# re-copy: three copies of a 350 MB extension in the image.)
ENV CODER_EXT_DIR=/home/coder/.local/share/code-server/extensions
RUN mkdir -p "$CODER_EXT_DIR" && \
    { code-server --extensions-dir "$CODER_EXT_DIR" --install-extension Anthropic.claude-code@2.1.85 \
      || (wget -q "https://open-vsx.org/api/Anthropic/claude-code/2.1.85/file/Anthropic.claude-code.vsix" \
          -O /tmp/claude-code.vsix && \
          code-server --extensions-dir "$CODER_EXT_DIR" --install-extension /tmp/claude-code.vsix && \
          rm -f /tmp/claude-code.vsix); } && \
    chown -R coder:coder /home/coder/.local
RUN { code-server --extensions-dir "$CODER_EXT_DIR" --install-extension cweijan.vscode-office@4.2.1 \
      || echo "WARNING: vscode-office extension not found on marketplace"; } && \
    code-server --extensions-dir "$CODER_EXT_DIR" --uninstall-extension GitHub.copilot 2>/dev/null || true; \
    code-server --extensions-dir "$CODER_EXT_DIR" --uninstall-extension GitHub.copilot-chat 2>/dev/null || true; \
    chown -R coder:coder /home/coder/.local

# === LAYER 5: Branding extension (build TypeScript) ===
COPY extensions/branding /tmp/branding
RUN --mount=type=cache,target=/root/.npm cd /tmp/branding && \
    npm install && \
    npm run build && \
    mkdir -p /home/coder/.local/share/code-server/extensions && \
    cp -r /tmp/branding /home/coder/.local/share/code-server/extensions/ide.branding && \
    chown -R coder:coder /home/coder/.local/share/code-server/extensions/ide.branding && \
    rm -rf /tmp/branding

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
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/_shared && npm ci --omit=dev --no-audit --no-fund

# Every app installs from its lockfile (`npm ci`): the image gets exactly the
# versions that were tested, never whatever resolves on build day.
COPY apps/shopify-mcp /opt/ide/apps/shopify-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/shopify-mcp && npm ci --omit=dev --no-audit --no-fund

COPY apps/vercel-mcp /opt/ide/apps/vercel-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/vercel-mcp && npm ci --omit=dev --no-audit --no-fund

COPY apps/meta-mcp /opt/ide/apps/meta-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/meta-mcp && npm ci --omit=dev --no-audit --no-fund

COPY apps/google-ads-mcp /opt/ide/apps/google-ads-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/google-ads-mcp && npm ci --omit=dev --no-audit --no-fund

COPY apps/seedream-mcp /opt/ide/apps/seedream-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/seedream-mcp && npm ci --omit=dev --no-audit --no-fund

COPY apps/nano-banana-mcp /opt/ide/apps/nano-banana-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/nano-banana-mcp && npm ci --omit=dev --no-audit --no-fund

COPY apps/reminder-mcp /opt/ide/apps/reminder-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/reminder-mcp && npm ci --omit=dev --no-audit --no-fund

# pdf-mcp: markdown → PDF via python-markdown + weasyprint (installed above).
# Always on, no credentials. The ONE supported way to make PDFs.
COPY apps/pdf-mcp /opt/ide/apps/pdf-mcp
# Playwright launcher (no deps): starts @playwright/mcp as the mcp user via mcp-runner.
COPY apps/playwright-mcp /opt/ide/apps/playwright-mcp
# Bridge to a provider's hosted MCP server (Granola, Fathom, …): a fresh token per call.
COPY apps/remote-mcp /opt/ide/apps/remote-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/remote-mcp && npm ci --omit=dev --no-audit --no-fund
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/pdf-mcp && npm ci --omit=dev --no-audit --no-fund

# miniapp-mcp: save_as_tab — AI-built mini apps as workspace sidebar tabs.
COPY apps/miniapp-mcp /opt/ide/apps/miniapp-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/miniapp-mcp && npm ci --omit=dev --no-audit --no-fund

COPY apps/workspace-api-mcp /opt/ide/apps/workspace-api-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/workspace-api-mcp && npm ci --omit=dev --no-audit --no-fund

# Memory v4 embedder: a worker workspace-api forks (lib/embedder-client.js),
# with the model deploy.sh fetched into models/ (pinned revision + sha256).
# ONNXRUNTIME_NODE_INSTALL=skip: no CUDA download from NuGet during the build.
# Only this platform's runtime binaries are kept (the package ships all of
# them, ~480 MB); onnxruntime-web is the browser runtime, unused under Node.
COPY apps/embedder /opt/ide/apps/embedder
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/embedder && ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev --no-audit --no-fund && \
    ARCH="$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')" && \
    rm -rf node_modules/onnxruntime-web node_modules/onnxruntime-node/bin/napi-v*/darwin node_modules/onnxruntime-node/bin/napi-v*/win32 && \
    find node_modules/onnxruntime-node/bin -mindepth 3 -maxdepth 3 -type d ! -name "$ARCH" -exec rm -rf {} + && \
    test -d "node_modules/onnxruntime-node/bin/napi-v6/linux/$ARCH"
COPY models /opt/ide/models

COPY apps/web-channel-mcp /opt/ide/apps/web-channel-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/web-channel-mcp && npm ci --omit=dev --no-audit --no-fund

COPY apps/email-mcp /opt/ide/apps/email-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/email-mcp && npm ci --omit=dev --no-audit --no-fund

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
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/grok-mcp && npm ci --omit=dev --no-audit --no-fund

COPY apps/openai-mcp /opt/ide/apps/openai-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/openai-mcp && npm ci --omit=dev --no-audit --no-fund

# Docs Comments (Playwright range-anchored Google Docs comments) — first-class
# integration shipped to every client. Pulls playwright-core (reuses the system
# chromium installed by the playwright-mcp layer; no bundled browsers).
COPY apps/docs-comments-mcp /opt/ide/apps/docs-comments-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/docs-comments-mcp && npm ci --omit=dev --no-audit --no-fund

COPY apps/gemini-chat-mcp /opt/ide/apps/gemini-chat-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/gemini-chat-mcp && npm ci --omit=dev --no-audit --no-fund

COPY apps/signwell-mcp /opt/ide/apps/signwell-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/signwell-mcp && npm ci --omit=dev --no-audit --no-fund

COPY apps/trello-mcp /opt/ide/apps/trello-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/trello-mcp && npm ci --omit=dev --no-audit --no-fund

COPY apps/gdocs-mcp /opt/ide/apps/gdocs-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/gdocs-mcp && npm ci --omit=dev --no-audit --no-fund

COPY apps/gsheets-mcp /opt/ide/apps/gsheets-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/gsheets-mcp && npm ci --omit=dev --no-audit --no-fund

COPY apps/gcalendar-mcp /opt/ide/apps/gcalendar-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/gcalendar-mcp && npm ci --omit=dev --no-audit --no-fund

COPY apps/gdrive-mcp /opt/ide/apps/gdrive-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/gdrive-mcp && npm ci --omit=dev --no-audit --no-fund

COPY apps/gslides-mcp /opt/ide/apps/gslides-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/gslides-mcp && npm ci --omit=dev --no-audit --no-fund

COPY apps/gtasks-mcp /opt/ide/apps/gtasks-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/gtasks-mcp && npm ci --omit=dev --no-audit --no-fund

COPY apps/x-mcp /opt/ide/apps/x-mcp
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/apps/x-mcp && npm ci --omit=dev --no-audit --no-fund

# === LAYER 2f: workspace-api (web chat backend) ===
# Express server that wraps `claude -p` with SSE streaming for the React workspace.
# Started by PM2 alongside the bot. Listens on 127.0.0.1:3001 inside the container.
# `npm ci` from the lockfile (deploy.sh ships it): the image gets exactly the
# versions CI tested, not whatever `npm install` resolves on build day.
COPY workspace-api /opt/ide/workspace-api
RUN --mount=type=cache,target=/root/.npm cd /opt/ide/workspace-api && npm ci --omit=dev --no-audit --no-fund

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
COPY bot/mcp-auth-helper.sh /opt/ide/mcp-auth-helper.sh
COPY bot/bot-relay.sh /opt/ide/bot-relay.sh
COPY bot/tmux-inject.sh /opt/ide/tmux-inject.sh
COPY bot/reminder-monitor.sh /opt/ide/reminder-monitor.sh
COPY bot/recent-snapshot-monitor.sh /opt/ide/recent-snapshot-monitor.sh
COPY bot/browser-watchdog.sh /opt/ide/browser-watchdog.sh
COPY bot/ecosystem.config.js /opt/ide/ecosystem.config.js
RUN chmod +x /opt/ide/bot.sh /opt/ide/bot-notify.sh /opt/ide/web-notify.sh /opt/ide/mcp-auth-helper.sh /opt/ide/bot-relay.sh /opt/ide/tmux-inject.sh /opt/ide/reminder-monitor.sh /opt/ide/recent-snapshot-monitor.sh /opt/ide/browser-watchdog.sh

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
    chown coder:coder /home/coder/project /home/coder/.config /home/coder/.config/rclone /home/coder/.claude /home/coder/.claude/channels /home/coder/.claude/channels/telegram /home/coder/.${BOT_NAME} /home/coder/.npm /home/coder/.bashrc /home/coder/.profile && \
    { [ ! -e /home/coder/.zshrc ] || chown coder:coder /home/coder/.zshrc; }

# USER coder (Disabled to allow entrypoint.sh to fix volume permissions as root on startup)
USER root

EXPOSE 8080
EXPOSE 9090

# Health check: code-server (main UI) AND workspace-api (:3001, the backend
# every web screen and the bot's web channel depend on) must both answer.
# code-server alone used to be enough, so a container whose wsapi never
# bound :3001 reported healthy.
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD curl -sf http://localhost:8080/ > /dev/null 2>&1 && \
        curl -sf http://127.0.0.1:3001/api/health > /dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
