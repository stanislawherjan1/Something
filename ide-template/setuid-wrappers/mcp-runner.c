/*
 * mcp-runner.c — drop privileges to the mcp user (uid 1002) and exec
 * Node running an MCP server from the whitelisted apps directory.
 *
 * Usage:
 *   mcp-runner <integration-id>
 *
 * Resolves <integration-id> to /opt/ide/apps/<integration-id>-mcp/index.js
 * and execs node on it. The translation is hardcoded — we DO NOT take an
 * arbitrary path argument because that would let a compromised process
 * inside the container exec arbitrary code via this setuid binary.
 *
 * Why setuid + uid split rather than "all MCPs run as coder":
 *   Without isolation, the bot (coder uid 1000) can read every active
 *   MCP's /proc/<pid>/environ and extract every integration's plaintext
 *   credentials. With MCPs at uid 1002, that read returns EACCES — the
 *   bot is on a different uid and Linux's /proc default permissions
 *   refuse cross-uid environ reads.
 *
 * Combined with the broker's nonce-based credential delivery (no
 * plaintext env injected at spawn time), an MCP at uid 1002 receives
 * only an integration id + single-use nonce. The actual secrets
 * arrive over the UDS broker socket and live only in the MCP's own
 * heap, not in /proc/<pid>/environ.
 *
 * Hardening:
 *   - Argv whitelist: only [a-z0-9-]{1,32}, no slashes / dots / NULs.
 *   - Path templating to /opt/ide/apps/<id>-mcp/index.js, then stat the
 *     resolved path. If it doesn't exist or isn't a regular file, abort.
 *   - PR_SET_NO_NEW_PRIVS to stop any further escalation.
 *   - Setuid bit must be on the wrapper itself; abort if missing.
 *   - NULL the wrapper-only env vars before exec'ing node so the MCP
 *     doesn't see internals.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <ctype.h>
#include <grp.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/prctl.h>
#include <errno.h>

#define MCP_USER "mcp"
#define MCP_UID 1002
#define MCP_GID 1002
#define NODE_BIN "/usr/bin/node"
#define APPS_PREFIX "/opt/ide/apps/"
#define INDEX_SUFFIX "-mcp/index.js"
#define MAX_INTEGRATION_LEN 32
#define MAX_PATH_LEN 256

extern char **environ;

static int valid_integration_id(const char *s) {
    if (!s) return 0;
    size_t n = strlen(s);
    if (n == 0 || n > MAX_INTEGRATION_LEN) return 0;
    /* Allow only lowercase letters, digits, hyphens. No leading hyphen
     * (would look like an arg flag if it ever leaks into argv parsing). */
    if (s[0] == '-') return 0;
    for (size_t i = 0; i < n; i++) {
        char c = s[i];
        if (c >= 'a' && c <= 'z') continue;
        if (c >= '0' && c <= '9') continue;
        if (c == '-') continue;
        return 0;
    }
    return 1;
}

int main(int argc, char *argv[]) {
    if (argc != 2) {
        fprintf(stderr, "usage: mcp-runner <integration-id>\n");
        return 2;
    }
    if (!valid_integration_id(argv[1])) {
        fprintf(stderr, "mcp-runner: invalid integration id\n");
        return 2;
    }

    /* Build the script path: /opt/ide/apps/<id>-mcp/index.js */
    char script_path[MAX_PATH_LEN];
    int written = snprintf(script_path, sizeof(script_path),
                           "%s%s%s", APPS_PREFIX, argv[1], INDEX_SUFFIX);
    if (written < 0 || written >= (int)sizeof(script_path)) {
        fprintf(stderr, "mcp-runner: path overflow\n");
        return 2;
    }

    /* Verify the script exists and is a regular file. */
    struct stat st;
    if (stat(script_path, &st) != 0) {
        fprintf(stderr, "mcp-runner: stat %s: %s\n", script_path, strerror(errno));
        return 2;
    }
    if (!S_ISREG(st.st_mode)) {
        fprintf(stderr, "mcp-runner: %s is not a regular file\n", script_path);
        return 2;
    }

    /* Verify our own setuid bit is set. If a deploy lost it (chmod
     * accident, FS migration), refuse to run rather than silently
     * running unprivileged and confusing the caller. */
    struct stat self_stat;
    if (stat("/proc/self/exe", &self_stat) != 0) {
        perror("mcp-runner: stat /proc/self/exe");
        return 1;
    }
    if ((self_stat.st_mode & S_ISUID) == 0 && getuid() != 0) {
        fprintf(stderr, "mcp-runner: setuid bit missing on this binary; refusing to run\n");
        return 1;
    }

    /* Load mcp's supplementary groups (workspace 1100 + wsapi-broker 1101)
     * before privilege drop. workspace is needed to read shared files in
     * PROJECT_DIR; wsapi-broker is needed to connect to the broker UDS.
     * setuid alone wouldn't carry these — the process would end up with
     * only MCP_GID as its single group. See wsapi-runner.c for the same
     * fix rationale. */
    if (initgroups(MCP_USER, MCP_GID) != 0) {
        perror("mcp-runner: initgroups");
        return 1;
    }

    /* Drop to mcp:mcp permanently. */
    if (setgid(MCP_GID) != 0) {
        perror("mcp-runner: setgid");
        return 1;
    }
    if (setuid(MCP_UID) != 0) {
        perror("mcp-runner: setuid");
        return 1;
    }
    if (getuid() != MCP_UID || geteuid() != MCP_UID) {
        fprintf(stderr, "mcp-runner: privilege drop failed\n");
        return 1;
    }

    /* Block any further setuid escalation by the exec'd node. */
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
        perror("mcp-runner: prctl(NO_NEW_PRIVS)");
        /* Non-fatal. */
    }

    /* Exec node with the resolved script path. argv[0] is conventional
     * "node" so existing tooling that inspects argv[0] keeps working. */
    char *node_argv[] = { (char*)"node", script_path, NULL };
    execve(NODE_BIN, node_argv, environ);

    fprintf(stderr, "mcp-runner: execve %s: %s\n", NODE_BIN, strerror(errno));
    return 1;
}
