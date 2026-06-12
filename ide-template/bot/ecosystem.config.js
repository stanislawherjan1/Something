// Parametric pm2 ecosystem config
// Bot name controlled by BOT_NAME environment variable (set in docker-compose).
// All three processes inherit BOT_NAME from the container environment.

const BOT = process.env.BOT_NAME || 'bot';
const HOME = '/home/coder';

module.exports = {
  apps: [
    {
      // Phase-3 (H4 closure): the bot now runs as uid 1003 (`bot`) in its
      // own home (/home/bot), with the Claude OAuth token + integrations.env
      // group-shared with wsapi via the `botshare` group. Coder uid 1000
      // (code-server, terminal sessions) is NOT in botshare → cannot read
      // bot's secrets at rest.
      //
      // PM2 itself runs as coder. The setuid bot-runner binary
      // (/usr/local/bin/bot-runner) drops to uid 1003 + initgroups
      // + sets HOME=/home/bot before exec'ing /opt/ide/bot.sh. After the
      // drop, PR_SET_NO_NEW_PRIVS prevents any further escalation.
      //
      // PM2 logs (error_file/out_file) stay under /home/coder/.${BOT}/
      // because PM2 itself writes them as coder. Bot's process stdout/
      // stderr is plumbed through PM2's pipes regardless of the bot's
      // own uid.
      name: BOT,
      script: '/usr/local/bin/bot-runner',
      interpreter: 'none',
      max_restarts: 50,
      min_uptime: '20s',
      restart_delay: 10000,
      exp_backoff_restart_delay: 2000,
      max_memory_restart: '1G',
      error_file: `${HOME}/.${BOT}/${BOT}-error.log`,
      out_file:   `${HOME}/.${BOT}/${BOT}-out.log`,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      // Reminder monitor — polls ~/project/.reminders.json every 60s,
      // fires due reminders via the bot's tmux session (Claude elaborates)
      // or bot-notify.sh as a direct-API fallback.
      //
      // SECURITY (Phase 3): runs as uid 1003 (bot) via the monitor-runner
      // setuid wrapper. Two reasons:
      //   1. tmux sockets are per-uid (/tmp/tmux-$UID/). Before this,
      //      reminder-monitor ran as coder (1000) and `tmux -L $BOT
      //      has-session` always failed → every reminder fell through to
      //      the fallback path.
      //   2. bot-notify.sh's fallback reads $HOME/.claude/channels/
      //      telegram/.env for the Telegram token. Post-Phase-3 that file
      //      is mode 0640 group=botshare under /home/bot/, which coder
      //      cannot read → "Missing TELEGRAM_BOT_TOKEN" failure. Running
      //      as bot (in botshare with HOME=/home/bot) fixes this.
      name: `${BOT}-reminders`,
      script: '/usr/local/bin/monitor-runner',
      args: ['/opt/ide/reminder-monitor.sh'],
      interpreter: 'none',
      max_restarts: 50,
      min_uptime: '30s',
      restart_delay: 15000,
      error_file: `${HOME}/.${BOT}/${BOT}-reminders-error.log`,
      out_file:   `${HOME}/.${BOT}/${BOT}-reminders-out.log`,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      // Recent-snapshot monitor — every 60s pings wsapi to refresh
      // memory/RECENT_WEB.md + RECENT_TELEGRAM.md if their source JSONLs
      // have been idle ≥10 min. Keeps the cached system-prompt prefix
      // current across sessions without bursting it mid-conversation.
      //
      // Runs as uid 1003 (bot) via monitor-runner — same rationale as the
      // reminders process: lets the script reach bot-owned paths
      // (/home/bot/.telegram/conversation.jsonl is consumed by the snapshot
      // writer route) and matches the running uid of the rest of the bot
      // pipeline. The actual snapshot writes happen inside wsapi (uid
      // 1001) via the HTTP nudge — this PM2 entry only does the curl.
      name: `${BOT}-snapshot`,
      script: '/usr/local/bin/monitor-runner',
      args: ['/opt/ide/recent-snapshot-monitor.sh'],
      interpreter: 'none',
      max_restarts: 50,
      min_uptime: '30s',
      restart_delay: 15000,
      error_file: `${HOME}/.${BOT}/${BOT}-snapshot-error.log`,
      out_file:   `${HOME}/.${BOT}/${BOT}-snapshot-out.log`,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      // Browser watchdog — every 5 min kills Chromium processes that have
      // been pinning CPU for > 60 min. Catches the playwright-mcp /
      // docs-comments-mcp hang pattern where a renderer enters a busy-loop on
      // a heavy page and the MCP doesn't clean it up. Runs as uid 1003
      // (bot) via monitor-runner — Chrome procs are bot-owned so kill -9
      // works without privilege escalation. See browser-watchdog.sh for
      // the AND threshold rationale (elapsed > 60 min AND cpu > 5%).
      name: `${BOT}-browser-watchdog`,
      script: '/usr/local/bin/monitor-runner',
      args: ['/opt/ide/browser-watchdog.sh'],
      interpreter: 'none',
      max_restarts: 50,
      min_uptime: '60s',
      restart_delay: 15000,
      error_file: `${HOME}/.${BOT}/${BOT}-browser-watchdog-error.log`,
      out_file:   `${HOME}/.${BOT}/${BOT}-browser-watchdog-out.log`,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      // Workspace API — wraps `claude -p` with SSE for the web chat panel.
      // Listens on :3001 inside the container; nginx (frontend service)
      // auth-gates and reverse-proxies /api/* here.
      //
      // SECURITY (Phase 2 broker isolation): the actual node process runs
      // as uid 1001 (`wsapi`), not coder (1000). PM2 itself runs as coder
      // and can't directly setuid; the wsapi-runner setuid binary
      // (/usr/local/bin/wsapi-runner) drops to 1001 then exec's
      // /usr/bin/node /opt/ide/workspace-api/index.js. After the drop the
      // process is fully bound to 1001 (PR_SET_NO_NEW_PRIVS set), and the
      // bot/coder uid can't read its /proc/<pid>/environ or any of its
      // privileged files (encryption key, encrypted store).
      //
      // PM2 calls the wrapper directly as a binary (no interpreter). The
      // wrapper has the source path baked in — no env override possible.
      name: 'workspace-api',
      script: '/usr/local/bin/wsapi-runner',
      interpreter: 'none',
      env: {
        WORKSPACE_API_PORT: '3001',
        PROJECT_DIR: `${HOME}/project`,
        // Encrypted store + audit lives at /var/wsapi-store after the
        // Phase-2 migration. workspace-api's lib/integrations/{store,setup}.js
        // honour these env paths over the legacy PROJECT_DIR/.integrations
        // location.
        WSAPI_STORE_DIR:    '/var/wsapi-store',
        // UDS socket the broker listens on. wsapi creates it; mcp uid
        // 1002 connects via the wsapi-broker group. Coder (1000) is NOT
        // in that group, so the bot can't even open this socket.
        BROKER_SOCKET:      '/var/wsapi-store/run/broker.sock',
        // Phase-3 (H4 closure): the bot runs at uid 1003 with its home
        // at /home/bot/. setup.js writes the Claude OAuth token to
        // ${BOT_USER_HOME}/.claude/.credentials.json + the bot
        // integrations.env to ${BOT_USER_HOME}/.${BOT}/integrations.env,
        // both with group=botshare so coder (1000) can't read them.
        // runtime.js's `{home}` placeholder for catalog `writeFiles` paths
        // also resolves through this var.
        BOT_USER_HOME:      '/home/bot',
        // Where workspace-api's syncMcpServers writes the mcpServers block.
        // Default would be ${HOME}/.claude.json = /home/coder/.claude.json
        // (PM2 inherits HOME from coder), but the bot reads from
        // /home/bot/.claude.json after Phase-3 — pointing wsapi at the
        // same path closes the "bot doesn't see newly-activated
        // integrations until it's first restarted" gap. entrypoint.sh
        // pre-seeds this file with hasCompletedOnboarding + initial
        // content before PM2 starts, so there's no race over creation.
        CLAUDE_CONFIG_PATH: '/home/bot/.claude.json',
        // BOT_NAME is needed for path templating: telegram credentials get
        // written to ${BOT_USER_HOME}/.${BOT}/integrations.env via the
        // {bot} placeholder.
        BOT_NAME: BOT,
      },
      max_restarts: 50,
      min_uptime: '20s',
      restart_delay: 10000,
      max_memory_restart: '512M',
      // Give wsapi 8s to shut down gracefully on SIGTERM (server.close drain
      // + chokidar inotify cleanup + broker UDS socket unlink — see index.js
      // shutdown handler). Without this, PM2 sends SIGKILL after its default
      // 1.6s, port :3001 stays held by the kernel for a few extra seconds,
      // and the replacement wsapi spawn hits EADDRINUSE → crash → restart
      // loop → orphan broker socket. Caught 2026-06-04 canary incident.
      kill_timeout: 8000,
      error_file: `${HOME}/.${BOT}/workspace-api-error.log`,
      out_file:   `${HOME}/.${BOT}/workspace-api-out.log`,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    }
  ],
};
