/*
 * bot-runner.c — drop privileges to the bot user (uid 1003) and exec
 * /opt/ide/bot.sh. Closes the H4 partial-leak: pre-Phase-3 the bot ran
 * as coder uid 1000 and could `cat /home/coder/.claude/.credentials.json`
 * + `cat /home/coder/.<bot>/integrations.env` directly. With this
 * wrapper, bot.sh runs as uid 1003 with HOME=/home/bot, so:
 *   - The Claude OAuth token + Telegram bot token live under /home/bot/
 *     mode 0640 group=botshare. wsapi (in botshare) writes; bot (in
 *     botshare) reads. coder is NOT in botshare → cannot read.
 *   - A prompt-injected bot can no longer trivially exfiltrate via
 *     `cat ~/.claude/.credentials.json` from the IDE terminal because
 *     that's coder's home; the actual creds aren't there anymore.
 *
 * Invoked by PM2 (which runs as coder uid 1000). The setuid bit on this
 * binary lets us drop to bot uid 1003 once at start.
 *
 * IMPORTANT — we deliberately do NOT call PR_SET_NO_NEW_PRIVS here.
 * The Phase-2 credential broker design has bot.sh's children (claude
 * --channels) spawn /usr/local/bin/mcp-runner (another setuid binary)
 * which drops to uid 1002 (mcp) before exec'ing the integration MCP.
 * With NO_NEW_PRIVS set on the bot-runner process, that flag inherits
 * down the whole tree: kernel then refuses every subsequent setuid
 * exec, mcp-runner's initgroups() fails with EPERM, and every
 * broker-mediated MCP server fails to start. That's the bug Stan ran
 * into on 2026-05-11.
 *
 * Risk this introduces: bot.sh / claude / claude tools CAN exec setuid
 * binaries. The realistic threats:
 *   1. exec /usr/local/bin/mcp-runner — drops to uid 1002 (mcp), not
 *      root. This is the intended use case (Phase-2 broker design).
 *   2. exec /usr/local/bin/wsapi-runner — drops to uid 1001 (wsapi).
 *      Wsapi-runner hard-codes the script path (/opt/ide/workspace-api/
 *      index.js) and only execs node on that file; there's no way for
 *      a caller to influence what runs. The worst a compromised
 *      bot-session could do is start a second wsapi instance, which
 *      would fail to bind the broker UDS and exit cleanly.
 *   3. exec /usr/bin/sudo — Phase-0 stripped NOPASSWD; sudo prompts
 *      for a password that bot doesn't have.
 *   4. exec any other system setuid binary — standard Linux primitives
 *      (passwd, su, mount), none confer extra read access to the
 *      Phase-3 isolated files (mode 0640 botshare).
 *
 * Net: dropping NO_NEW_PRIVS from this wrapper makes the broker
 * actually function as designed. The other two setuid wrappers
 * (mcp-runner, wsapi-runner) keep NO_NEW_PRIVS — those processes are
 * terminal and shouldn't ever exec further setuid binaries.
 *
 * HOME is explicitly set to /home/bot so claude --channels (spawned
 * downstream by bot.sh) reads /home/bot/.claude/.credentials.json
 * rather than the parent process's HOME.
 *
 * Args are passed through verbatim to bot.sh (today bot.sh takes none,
 * but pass-through keeps the wrapper future-proof).
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
#define BOT_SCRIPT "/opt/ide/bot.sh"
#define BASH_BIN  "/bin/bash"

extern char **environ;

int main(int argc, char *argv[]) {
    /* Refuse if our own binary lost its setuid bit (means a deploy bug). */
    struct stat self_stat;
    if (stat("/proc/self/exe", &self_stat) != 0) {
        perror("bot-runner: stat /proc/self/exe");
        return 1;
    }
    if ((self_stat.st_mode & S_ISUID) == 0 && getuid() != 0) {
        fprintf(stderr, "bot-runner: setuid bit missing on this binary; refusing to run\n");
        return 1;
    }

    /* Verify bot.sh actually exists before dropping privs. Saves us a
     * confusing error later when bash tries to source nothing. */
    struct stat script_stat;
    if (stat(BOT_SCRIPT, &script_stat) != 0) {
        fprintf(stderr, "bot-runner: %s not found: %s\n", BOT_SCRIPT, strerror(errno));
        return 1;
    }
    if (!S_ISREG(script_stat.st_mode)) {
        fprintf(stderr, "bot-runner: %s is not a regular file\n", BOT_SCRIPT);
        return 1;
    }

    /* Load supplementary groups for bot before privilege drop —
     * `workspace` (PROJECT_DIR access) + `botshare` (read its own
     * secret files written by wsapi). Without initgroups, bot would
     * end up with only its primary gid and lose group reads on the
     * shared files we just chowned to group=botshare. */
    if (initgroups(BOT_USER, BOT_GID) != 0) {
        perror("bot-runner: initgroups");
        return 1;
    }

    /* Drop to bot:bot permanently. */
    if (setgid(BOT_GID) != 0) {
        perror("bot-runner: setgid");
        return 1;
    }
    if (setuid(BOT_UID) != 0) {
        perror("bot-runner: setuid");
        return 1;
    }
    if (getuid() != BOT_UID || geteuid() != BOT_UID) {
        fprintf(stderr, "bot-runner: privilege drop failed\n");
        return 1;
    }

    /* DELIBERATELY skip PR_SET_NO_NEW_PRIVS — see header comment.
     * Setting it here propagates to claude → mcp-runner, the kernel
     * then refuses mcp-runner's setuid escalation, and every
     * broker-mediated MCP fails to start ("initgroups: Operation not
     * permitted"). mcp-runner and wsapi-runner DO set NO_NEW_PRIVS
     * themselves after their drops — those are terminal processes. */

    /* Override HOME so bot.sh + descendant claude --channels look in
     * /home/bot/ for credentials. The wrapper's parent (PM2) ran as
     * coder, so without this HOME would still be /home/coder.
     *
     * Build a fresh argv but reuse environ — except for HOME, which we
     * inject explicitly. Same trick for any other inherited env we
     * want to cleanly override.
     *
     * We DON'T zero out the rest of environ — bot.sh + claude legitimately
     * need PATH, NODE_PATH, and a few platform vars passed through.
     */
    if (setenv("HOME", BOT_HOME, 1) != 0) {
        perror("bot-runner: setenv HOME");
        return 1;
    }
    if (chdir(BOT_HOME) != 0) {
        /* Non-fatal — bash will run from wherever, just less tidy. */
        perror("bot-runner: chdir");
    }

    /* Exec bash with bot.sh as argv[1], plus any args passed to us
     * (passthrough for future flag use). argv[0] is conventional bash. */
    char **bash_argv = calloc(argc + 2, sizeof(char *));
    if (!bash_argv) {
        fprintf(stderr, "bot-runner: out of memory\n");
        return 1;
    }
    int idx = 0;
    bash_argv[idx++] = (char *)"bash";
    bash_argv[idx++] = (char *)BOT_SCRIPT;
    for (int i = 1; i < argc; i++) {
        bash_argv[idx++] = argv[i];
    }
    bash_argv[idx] = NULL;

    execve(BASH_BIN, bash_argv, environ);
    fprintf(stderr, "bot-runner: execve %s: %s\n", BASH_BIN, strerror(errno));
    free(bash_argv);
    return 1;
}
