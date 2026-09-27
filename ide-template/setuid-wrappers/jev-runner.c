/*
 * jev-runner.c — run the Jev autopilot runner as the mcp user (uid 1002).
 *
 * Usage (from workspace-api only — the binary is root:1001 mode 4750, so
 * only the wsapi user can execute it):
 *   jev-runner
 *
 * Execs /usr/bin/python3 on the fixed script /opt/ide/apps/jev-runner/runner.py.
 * It takes NO path or argument: a compromised caller cannot point this setuid
 * binary at anything else.
 *
 * Why: the runner executes third-party policy code (jev-ultrafast). Like every
 * integration's MCP code it runs as mcp — not as wsapi, which can decrypt every
 * integration's credentials. The TypeSafe key reaches it on stdin (never in
 * its environment, so /proc/<pid>/environ holds no secret), and the environment
 * it gets is rebuilt from a short allow-list: the egress proxy settings and a
 * locale. See docs/BROWSER_EXTENSION.md ("Autopilot").
 *
 * Hardening, as mcp-runner.c:
 *   - fixed script path, stat'ed as a regular file before exec;
 *   - refuse to run without our own setuid bit;
 *   - initgroups + setgid + setuid to mcp, verified;
 *   - PR_SET_NO_NEW_PRIVS after the drop;
 *   - a fresh, allow-listed environment.
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

#define MCP_USER "mcp"
#define MCP_UID 1002
#define MCP_GID 1002
#define PYTHON_BIN "/usr/bin/python3"
#define SCRIPT "/opt/ide/apps/jev-runner/runner.py"

extern char **environ;

/* Variables copied from the caller's environment, if set. Nothing else passes. */
static const char *ALLOWED_ENV[] = {
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
    "LANG", "TYPESAFE_MODEL", "SSL_CERT_FILE", NULL,
};

int main(int argc, char *argv[]) {
    (void)argv;
    if (argc != 1) {
        fprintf(stderr, "usage: jev-runner\n");
        return 2;
    }

    struct stat st;
    if (stat(SCRIPT, &st) != 0 || !S_ISREG(st.st_mode)) {
        fprintf(stderr, "jev-runner: %s missing or not a regular file\n", SCRIPT);
        return 2;
    }

    struct stat self_stat;
    if (stat("/proc/self/exe", &self_stat) != 0) {
        perror("jev-runner: stat /proc/self/exe");
        return 1;
    }
    if ((self_stat.st_mode & S_ISUID) == 0 && getuid() != 0) {
        fprintf(stderr, "jev-runner: setuid bit missing on this binary; refusing to run\n");
        return 1;
    }

    /* Build the child's environment before dropping privileges. */
    static char *child_env[16];
    int n = 0;
    child_env[n++] = (char *)"PATH=/usr/local/bin:/usr/bin:/bin";
    child_env[n++] = (char *)"HOME=/nonexistent";
    child_env[n++] = (char *)"PYTHONUNBUFFERED=1";
    child_env[n++] = (char *)"PYTHONDONTWRITEBYTECODE=1";
    child_env[n++] = (char *)"JEV_ULTRAFAST_DIR=/opt/jev-ultrafast";
    for (int i = 0; ALLOWED_ENV[i] && n < 15; i++) {
        size_t len = strlen(ALLOWED_ENV[i]);
        for (char **e = environ; *e; e++) {
            if (strncmp(*e, ALLOWED_ENV[i], len) == 0 && (*e)[len] == '=') {
                child_env[n++] = *e;
                break;
            }
        }
    }
    child_env[n] = NULL;

    if (initgroups(MCP_USER, MCP_GID) != 0) {
        perror("jev-runner: initgroups");
        return 1;
    }
    if (setgid(MCP_GID) != 0) {
        perror("jev-runner: setgid");
        return 1;
    }
    if (setuid(MCP_UID) != 0) {
        perror("jev-runner: setuid");
        return 1;
    }
    if (getuid() != MCP_UID || geteuid() != MCP_UID) {
        fprintf(stderr, "jev-runner: privilege drop failed\n");
        return 1;
    }
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
        perror("jev-runner: prctl(NO_NEW_PRIVS)");
        /* Non-fatal, as in mcp-runner. */
    }

    char *py_argv[] = { (char *)"python3", (char *)"-I", (char *)SCRIPT, NULL };
    execve(PYTHON_BIN, py_argv, child_env);
    fprintf(stderr, "jev-runner: execve %s: %s\n", PYTHON_BIN, strerror(errno));
    return 1;
}
