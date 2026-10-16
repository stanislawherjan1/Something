/*
 * turn-runner.c — start a Claude turn (web chat, group, headless) as the
 * turn user for the person it serves, never as workspace-api itself.
 *
 * workspace-api (uid 1001) holds the credential store and its key; a turn
 * runs the model with tools, including a shell, on behalf of whoever is
 * talking. The two must not be the same user — and two people's turns must
 * not be the same user either, or one person's shell could read the other's
 * private files and sessions. So every person on the roster has a slot in a
 * pool of turn users (turn-01 … turn-24, each with a private group
 * priv-01 … priv-24), group turns have a user of their own (turn-group) and
 * a solo workspace keeps the single `turn` user. workspace-api names the
 * slot; this runner switches to it:
 *
 *   turn-runner <slot> <claude args…>       slot = solo | group | 01 … 24
 *
 *   - Only root or workspace-api may start it (mode 4750, group wsapi).
 *   - The slot is validated against the pool here, in code; a slot that is
 *     not in the pool is refused, whatever the roster says.
 *   - The remaining argv is passed through to the CLI as given: workspace-api
 *     builds the whole command line (lib/claude.js); the binary is fixed here.
 *   - The environment passes through minus what env-guard.h removes
 *     (interpreter and loader instructions); workspace-api has already left
 *     its own secrets out of it. HOME becomes the slot's home, where its
 *     settings (the hooks) and its sessions live, 0700, its own.
 *   - umask 002: what a turn writes into the project stays group-writable
 *     for everyone in `workspace`, like the entrypoint's fix-ups make it. A
 *     private tree is turn-NN:priv-NN 2770, so what lands there is the
 *     person's and workspace-api's (in every priv-* group), nobody else's.
 *   - No PR_SET_NO_NEW_PRIVS: a turn starts integration MCPs through
 *     mcp-runner, a setuid binary (see wsapi-runner.c for the same reason).
 *
 * The uids and gids here mirror the Dockerfile; TURN_POOL_SIZE is the build
 * constant the Team screen reports when the pool is full.
 */

#define _GNU_SOURCE   /* setresuid / setresgid */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <grp.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <errno.h>
#include <signal.h>
#include <sys/wait.h>
#include <sys/prctl.h>

#define WSAPI_UID 1001

/* The pool: slot NN → uid TURN_POOL_UID_BASE+NN, gid TURN_POOL_GID_BASE+NN. */
#define TURN_POOL_SIZE     24
#define TURN_POOL_UID_BASE 1100   /* turn-01 = 1101 … turn-24 = 1124 */
#define TURN_POOL_GID_BASE 1200   /* priv-01 = 1201 … priv-24 = 1224 */
#define TURN_HOMES         "/home/turns"

/* The two fixed users. */
#define SOLO_USER  "turn"        /* a solo workspace: one person, one turn user */
#define SOLO_UID   1005
#define SOLO_GID   1005
#define GROUP_USER "turn-group"  /* a Telegram group's turn: in no priv-* group at all */
#define GROUP_UID  1130
#define GROUP_GID  1130

/* Where the CLI's launcher lives (npm -g as root in the image); the first that exists
 * and is root's wins. Never a path the coder uid can write: this runs as root first. */
static const char *const CLAUDE_BINS[] = {
    "/usr/local/bin/claude",
    "/usr/bin/claude",
    NULL,
};

#include "env-guard.h"   /* declares environ */

struct slot { char user[16]; uid_t uid; gid_t gid; char home[64]; };

/* "solo", "group" or a two-digit slot inside the pool; anything else is refused. */
static int resolve_slot(const char *arg, struct slot *out) {
    if (!arg) return 0;
    if (strcmp(arg, "solo") == 0) {
        snprintf(out->user, sizeof out->user, "%s", SOLO_USER);
        out->uid = SOLO_UID; out->gid = SOLO_GID;
        snprintf(out->home, sizeof out->home, "%s/solo", TURN_HOMES);
        return 1;
    }
    if (strcmp(arg, "group") == 0) {
        snprintf(out->user, sizeof out->user, "%s", GROUP_USER);
        out->uid = GROUP_UID; out->gid = GROUP_GID;
        snprintf(out->home, sizeof out->home, "%s/group", TURN_HOMES);
        return 1;
    }
    if (strlen(arg) != 2 || arg[0] < '0' || arg[0] > '9' || arg[1] < '0' || arg[1] > '9') return 0;
    int n = (arg[0] - '0') * 10 + (arg[1] - '0');
    if (n < 1 || n > TURN_POOL_SIZE) return 0;
    snprintf(out->user, sizeof out->user, "turn-%02d", n);
    out->uid = TURN_POOL_UID_BASE + n;
    out->gid = TURN_POOL_GID_BASE + n;
    snprintf(out->home, sizeof out->home, "%s/%02d", TURN_HOMES, n);
    return 1;
}

static volatile pid_t child_pid = 0;

static void forward(int sig) {
    if (child_pid > 0) kill(child_pid, sig);
}

/* The parent after the fork: drop to (real: the caller, effective and saved:
 * the slot) — enough to signal the turn, nothing more — forward stop signals,
 * and leave with the turn's own status. */
static int supervise(uid_t caller, const struct slot *slot) {
    if (setgroups(0, NULL) != 0 || setresgid(slot->gid, slot->gid, slot->gid) != 0
        || setresuid(caller, slot->uid, slot->uid) != 0) {
        kill(child_pid, SIGKILL);
        fprintf(stderr, "turn-runner: supervisor privilege drop failed\n");
        return 1;
    }
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = forward;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGHUP, &sa, NULL);
    /* The turn holds the pipes; the supervisor needs none of them. */
    close(STDIN_FILENO);
    close(STDOUT_FILENO);
    int status = 0;
    while (waitpid(child_pid, &status, 0) < 0) {
        if (errno != EINTR) return 1;
    }
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return 1;
}

int main(int argc, char *argv[]) {
    /* The uid that started us — getuid() before the switch below. */
    const uid_t caller = getuid();

    /* Refuse if our own binary lost its setuid bit (means a deploy bug). */
    struct stat self_stat;
    if (stat("/proc/self/exe", &self_stat) != 0) {
        perror("turn-runner: stat /proc/self/exe");
        return 1;
    }
    if ((self_stat.st_mode & S_ISUID) == 0 && getuid() != 0) {
        fprintf(stderr, "turn-runner: setuid bit missing on this binary; refusing to run\n");
        return 1;
    }

    /* workspace-api starts turns; nothing else may. */
    static const uid_t allowed_callers[] = { 0, WSAPI_UID };
    if (!env_guard_caller_ok(caller, allowed_callers, sizeof allowed_callers / sizeof allowed_callers[0])) {
        fprintf(stderr, "turn-runner: not started by an allowed user (uid %u); refusing to run\n", (unsigned)caller);
        return 1;
    }

    struct slot slot;
    if (argc < 2 || !resolve_slot(argv[1], &slot)) {
        fprintf(stderr, "turn-runner: usage: turn-runner <solo|group|01..%02d> <claude args…>\n", TURN_POOL_SIZE);
        return 1;
    }

    const char *claude_bin = NULL;
    for (int i = 0; CLAUDE_BINS[i] != NULL; i++) {
        struct stat bin_stat;
        if (stat(CLAUDE_BINS[i], &bin_stat) == 0 && S_ISREG(bin_stat.st_mode) && bin_stat.st_uid == 0 && !(bin_stat.st_mode & 022)) { claude_bin = CLAUDE_BINS[i]; break; }
    }
    if (!claude_bin) {
        fprintf(stderr, "turn-runner: the claude CLI was not found at any known path\n");
        return 1;
    }

    /* The turn runs in a child; this process stays as its supervisor. A turn
     * fully switched to its slot's uid cannot be signalled by workspace-api
     * (kill → EPERM), so a new message could not stop the reply before it and
     * the chat died with "kill EPERM". The supervisor keeps the caller's real
     * uid — so workspace-api may signal it — and passes SIGTERM/SIGINT/SIGHUP
     * on to the turn. It holds nothing else: no root, no groups. */
    child_pid = fork();
    if (child_pid < 0) {
        perror("turn-runner: fork");
        return 1;
    }
    if (child_pid > 0) return supervise(caller, &slot);

    /* Supplementary groups before the drop: workspace (the project files) and
     * the slot's own private group — and nothing of the bot's. */
    if (initgroups(slot.user, slot.gid) != 0) {
        fprintf(stderr, "turn-runner: initgroups %s: %s\n", slot.user, strerror(errno));
        return 1;
    }
    if (setgid(slot.gid) != 0) {
        perror("turn-runner: setgid");
        return 1;
    }
    if (setuid(slot.uid) != 0) {
        perror("turn-runner: setuid");
        return 1;
    }
    if (getuid() != slot.uid || geteuid() != slot.uid) {
        fprintf(stderr, "turn-runner: privilege drop failed\n");
        return 1;
    }
    /* If the supervisor goes (killed outright), the turn goes too. Set after
     * the uid change, which clears it. */
    prctl(PR_SET_PDEATHSIG, SIGTERM);
    if (getppid() == 1) return 1;   /* the supervisor is already gone */

    if (setenv("HOME", slot.home, 1) != 0) {
        perror("turn-runner: setenv HOME");
        return 1;
    }
    /* The slot's name, for the scope guard's messages and the logs. */
    if (setenv("IDE_TURN_SLOT", argv[1], 1) != 0) {
        perror("turn-runner: setenv IDE_TURN_SLOT");
        return 1;
    }
    umask(002);

    if (env_guard_apply(caller) != 0) {
        fprintf(stderr, "turn-runner: could not prepare the environment; refusing to run\n");
        return 1;
    }

    /* argv: claude <args as given, after the slot> */
    char **node_argv = calloc(argc, sizeof(char *));
    if (!node_argv) {
        fprintf(stderr, "turn-runner: out of memory\n");
        return 1;
    }
    node_argv[0] = (char *)"claude";
    for (int i = 2; i < argc; i++) node_argv[i - 1] = argv[i];
    node_argv[argc - 1] = NULL;

    execve(claude_bin, node_argv, environ);
    fprintf(stderr, "turn-runner: execve %s: %s\n", claude_bin, strerror(errno));
    free(node_argv);
    return 1;
}
