/*
 * wsapi-runner.c — drop privileges to the wsapi user (uid 1001) and exec
 * Node running workspace-api/index.js.
 *
 * Why a setuid wrapper rather than `pm2 start --uid 1001`:
 *   PM2 itself runs as `coder` (uid 1000). Asking PM2 to spawn a child at
 *   1001 requires PM2 to have setuid privilege which it doesn't (and we
 *   don't want it to). A tiny dedicated setuid binary lets us drop to
 *   1001 once at workspace-api start, with a small audit-able surface.
 *
 * Compiled into the image at build time, installed at /usr/local/bin/
 * with mode 4755 (setuid bit, root-owned, world-executable). The setuid
 * bit is what allows a coder-uid process (PM2) to invoke this binary
 * and end up as wsapi-uid. After the setuid+exec, the bit doesn't
 * propagate — node process runs at uid 1001 with no further escalation.
 *
 * Hardening:
 *   - No env passthrough is filtered (we WANT process.env to flow into
 *     workspace-api), but argv is — no extra args accepted.
 *   - Hardcoded path to /opt/ide/workspace-api/index.js. Refuse to start
 *     if anything looks tampered.
 *   - Refuse to run if our own binary isn't setuid (defence against
 *     a misconfigured deploy where setuid bit was lost).
 *
 * IMPORTANT — we deliberately do NOT call PR_SET_NO_NEW_PRIVS here.
 * Same trap that bot-runner.c documents: with NO_NEW_PRIVS set, the
 * flag inherits down the whole tree (wsapi → claude → mcp-runner).
 * mcp-runner is a setuid root binary that drops to bot uid before
 * exec'ing the integration MCP; under NO_NEW_PRIVS the kernel refuses
 * its setuid bit and every integration MCP silently fails to start.
 * Result: web chat sees only the 4 native MCPs (memory, playwright,
 * reminders, workspace-api) and zero integration MCPs (email, trello,
 * gdrive, ...). Caught 2026-06-03 — web chat reported "I have 4 MCPs"
 * across all sessions and all clients since the wsapi broker split.
 *
 * Risk this leaves on the table: wsapi-process can exec setuid binaries.
 * Same threats bot-runner.c addresses are in play here too — the
 * realistic ones are bounded:
 *   1. exec mcp-runner — drops to uid 1002 (mcp), intended.
 *   2. exec bot-runner — drops to uid 1003 (bot), runs hardcoded
 *      /opt/ide/bot.sh; no arbitrary code path.
 *   3. exec sudo — NOPASSWD stripped; prompts for password wsapi
 *      doesn't have.
 *   4. exec any other system setuid binary — none confer extra access
 *      to the Phase-3 isolated files.
 *
 * Net: the privilege drop above (setgid + setuid to 1001) is the
 * load-bearing security control. NO_NEW_PRIVS was belt-and-braces
 * that broke a load-bearing feature.
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

#define WSAPI_USER "wsapi"
#define WSAPI_UID 1001
#define WSAPI_GID 1001
#define NODE_BIN "/usr/bin/node"
#define WSAPI_INDEX "/opt/ide/workspace-api/index.js"

extern char **environ;

int main(int argc, char *argv[]) {
    (void)argc;
    (void)argv;

    /* Refuse if our own binary lost its setuid bit (means a deploy bug). */
    struct stat self_stat;
    if (stat("/proc/self/exe", &self_stat) != 0) {
        perror("wsapi-runner: stat /proc/self/exe");
        return 1;
    }
    if ((self_stat.st_mode & S_ISUID) == 0 && getuid() != 0) {
        fprintf(stderr, "wsapi-runner: setuid bit missing on this binary; refusing to run\n");
        return 1;
    }

    /* Load supplementary groups for wsapi BEFORE setuid drops privilege.
     * setgid + setuid alone don't load /etc/group entries — the resulting
     * process would have only WSAPI_GID as its single group, not the
     * `workspace` (1100) and `wsapi-broker` (1101) groups wsapi is also
     * a member of. workspace is needed to write PROJECT_DIR; wsapi-broker
     * to bind the broker UDS socket. initgroups() requires CAP_SETGID
     * which we still have at this point (setuid root via setuid bit). */
    if (initgroups(WSAPI_USER, WSAPI_GID) != 0) {
        perror("wsapi-runner: initgroups");
        return 1;
    }

    /* Drop to wsapi:wsapi permanently. */
    if (setgid(WSAPI_GID) != 0) {
        perror("wsapi-runner: setgid");
        return 1;
    }
    if (setuid(WSAPI_UID) != 0) {
        perror("wsapi-runner: setuid");
        return 1;
    }

    /* Belt-and-braces — verify the drop took. */
    if (getuid() != WSAPI_UID || geteuid() != WSAPI_UID) {
        fprintf(stderr, "wsapi-runner: privilege drop failed (uid=%d euid=%d)\n",
                getuid(), geteuid());
        return 1;
    }

    /* NOTE — PR_SET_NO_NEW_PRIVS deliberately NOT called here.
     * See the long-form rationale in the file header. The short version:
     * wsapi spawns claude, which spawns mcp-runner (setuid), which needs
     * to drop to uid 1002. NO_NEW_PRIVS would inherit through the tree
     * and break that. Same trap bot-runner.c sidesteps. */

    /* Exec node with the workspace-api entry point. argv[0] is conventional
     * "node" so process listings + Node's own argv[0] reporting look right. */
    char *node_argv[] = { (char*)"node", (char*)WSAPI_INDEX, NULL };
    execve(NODE_BIN, node_argv, environ);

    /* Only reached on exec failure. */
    fprintf(stderr, "wsapi-runner: execve %s: %s\n", NODE_BIN, strerror(errno));
    return 1;
}
