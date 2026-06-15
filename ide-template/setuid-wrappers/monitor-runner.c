/*
 * monitor-runner.c — drop privileges to the bot user (uid 1003) and exec
 * one of a small whitelist of monitor scripts. Used by PM2 (which runs as
 * coder uid 1000) to spawn the reminder + recent-snapshot monitors with
 * the right identity for them to actually function post-Phase-3:
 *
 *   - tmux sockets are per-uid (`/tmp/tmux-$UID/`). The bot's tmux
 *     session lives under uid 1003. Before this wrapper, reminder-
 *     monitor.sh ran as coder and `tmux -L $BOT has-session` always
 *     failed → every reminder fell through to the bot-notify.sh direct
 *     fallback. (And then THAT also failed for the next reason.)
 *
 *   - bot-notify.sh's fallback to `$HOME/.claude/channels/telegram/.env`
 *     for the Telegram token requires read access to /home/bot/ files,
 *     which post-Phase-3 are mode 0640 group=botshare. coder is NOT in
 *     botshare → cannot read → "Missing TELEGRAM_BOT_TOKEN" failure.
 *     Running as uid 1003 (in botshare) closes both gaps.
 *
 * Why a separate wrapper and not bot-runner: bot-runner has its script
 * path hardcoded (/opt/ide/bot.sh) and passes argv through to bot.sh,
 * which doesn't know about reminder-monitor.sh. Generalising bot-runner
 * to accept an argv-supplied script would widen its attack surface
 * (today bot-runner has zero argv-dependent behaviour). Cleaner to ship
 * a second narrow wrapper that explicitly enumerates the monitors it
 * accepts.
 *
 * Why a whitelist and not just "exec argv[1]": a setuid binary that
 * execs an attacker-controlled path is a textbook bait-and-switch. The
 * whitelist is the security boundary — without it, anyone who could
 * call /usr/local/bin/monitor-runner could spawn an arbitrary script as
 * the bot user.
 *
 * Invoked by PM2 with the target script as argv[1]:
 *   /usr/local/bin/monitor-runner /opt/ide/reminder-monitor.sh
 *   /usr/local/bin/monitor-runner /opt/ide/recent-snapshot-monitor.sh
 *
 * Sets PR_SET_NO_NEW_PRIVS — these monitors don't legitimately need to
 * call further setuid binaries (unlike bot.sh, whose claude → mcp-runner
 * chain is the whole point of bot-runner skipping this flag). Locks
 * down further privilege escalation paths.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <grp.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/prctl.h>
#include <errno.h>

#define BOT_USER  "bot"
#define BOT_UID   1003
#define BOT_GID   1003
#define BOT_HOME  "/home/bot"
#define BASH_BIN  "/bin/bash"

/* Whitelist of scripts this wrapper is allowed to launch. Add entries
 * here when a new monitor needs to run as the bot user. Each entry is
 * matched verbatim against argv[1] — no path normalisation, no glob. */
static const char *ALLOWED_SCRIPTS[] = {
    "/opt/ide/reminder-monitor.sh",
    "/opt/ide/recent-snapshot-monitor.sh",
    "/opt/ide/browser-watchdog.sh",
    /* bot-relay.sh: short-lived helper invoked by workspace-api (uid 1000)
     * to inject a [WEB_USER] message into the bot's tmux session, which is
     * owned by bot uid 1003 (different /tmp/tmux-<uid>/ socket). Stdin /
     * env-var carries the user's text; the script does tmux send-keys -l
     * (literal) so no shell metacharacter interpretation. */
    "/opt/ide/bot-relay.sh",
    NULL,
};

extern char **environ;

static int is_allowed(const char *path) {
    for (int i = 0; ALLOWED_SCRIPTS[i] != NULL; i++) {
        if (strcmp(path, ALLOWED_SCRIPTS[i]) == 0) return 1;
    }
    return 0;
}

int main(int argc, char *argv[]) {
    /* Refuse if our own binary lost its setuid bit (means a deploy bug). */
    struct stat self_stat;
    if (stat("/proc/self/exe", &self_stat) != 0) {
        perror("monitor-runner: stat /proc/self/exe");
        return 1;
    }
    if ((self_stat.st_mode & S_ISUID) == 0 && getuid() != 0) {
        fprintf(stderr, "monitor-runner: setuid bit missing on this binary; refusing to run\n");
        return 1;
    }

    if (argc < 2) {
        fprintf(stderr, "monitor-runner: usage: %s <script-path>\n", argv[0]);
        fprintf(stderr, "monitor-runner: allowed scripts:\n");
        for (int i = 0; ALLOWED_SCRIPTS[i] != NULL; i++) {
            fprintf(stderr, "  %s\n", ALLOWED_SCRIPTS[i]);
        }
        return 1;
    }

    const char *script = argv[1];
    if (!is_allowed(script)) {
        fprintf(stderr, "monitor-runner: script %s not in whitelist; refusing\n", script);
        return 1;
    }

    /* Verify script actually exists before dropping privs. */
    struct stat script_stat;
    if (stat(script, &script_stat) != 0) {
        fprintf(stderr, "monitor-runner: %s not found: %s\n", script, strerror(errno));
        return 1;
    }
    if (!S_ISREG(script_stat.st_mode)) {
        fprintf(stderr, "monitor-runner: %s is not a regular file\n", script);
        return 1;
    }

    /* Load supplementary groups for bot before privilege drop —
     * `workspace` (PROJECT_DIR access) + `botshare` (read /home/bot/
     * shared files written by wsapi: telegram .env, .credentials.json). */
    if (initgroups(BOT_USER, BOT_GID) != 0) {
        perror("monitor-runner: initgroups");
        return 1;
    }

    if (setgid(BOT_GID) != 0) {
        perror("monitor-runner: setgid");
        return 1;
    }
    if (setuid(BOT_UID) != 0) {
        perror("monitor-runner: setuid");
        return 1;
    }
    if (getuid() != BOT_UID || geteuid() != BOT_UID) {
        fprintf(stderr, "monitor-runner: privilege drop failed\n");
        return 1;
    }

    /* Monitors don't need to exec further setuid binaries — lock the door. */
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
        perror("monitor-runner: prctl(PR_SET_NO_NEW_PRIVS)");
        return 1;
    }

    /* Override HOME so the monitor scripts (and any descendant lookups,
     * e.g. bot-notify.sh reading $HOME/.claude/channels/telegram/.env)
     * see /home/bot/ rather than PM2's coder home. */
    if (setenv("HOME", BOT_HOME, 1) != 0) {
        perror("monitor-runner: setenv HOME");
        return 1;
    }
    if (chdir(BOT_HOME) != 0) {
        /* Non-fatal — bash will run from wherever, just less tidy. */
        perror("monitor-runner: chdir");
    }

    /* Build argv: bash <script> <pass-through args...> */
    char **bash_argv = calloc(argc + 1, sizeof(char *));
    if (!bash_argv) {
        fprintf(stderr, "monitor-runner: out of memory\n");
        return 1;
    }
    int idx = 0;
    bash_argv[idx++] = (char *)"bash";
    bash_argv[idx++] = (char *)script;
    for (int i = 2; i < argc; i++) {
        bash_argv[idx++] = argv[i];
    }
    bash_argv[idx] = NULL;

    execve(BASH_BIN, bash_argv, environ);
    fprintf(stderr, "monitor-runner: execve %s: %s\n", BASH_BIN, strerror(errno));
    free(bash_argv);
    return 1;
}
