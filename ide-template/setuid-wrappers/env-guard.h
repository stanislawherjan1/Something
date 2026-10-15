/*
 * env-guard.h — shared by the four setuid runners.
 *
 * A runner switches to another uid and then execs node or bash with the
 * caller's environment, because the program it starts reads its settings from
 * there. Some variables are not settings for that program but instructions to
 * the interpreter or the loader: NODE_OPTIONS (--require), BASH_ENV, exported
 * bash functions, LD_*. Once the uid switch is complete the kernel no longer
 * treats the exec as privileged, so node and bash honour them like any other
 * variable. They are removed here, before the exec. Application variables
 * (PROJECT_DIR, tokens, IDE_*, proxy settings, NODE_ENV) pass through.
 *
 * PATH is kept as given only when the caller is root or PM2's uid (coder);
 * any other caller gets the image's default PATH, so a command a script runs
 * by name resolves to the same binary it would under PM2.
 */
#ifndef ENV_GUARD_H
#define ENV_GUARD_H

#include <stdlib.h>
#include <string.h>
#include <sys/types.h>

#define ENV_GUARD_PM2_UID 1000
#define ENV_GUARD_DEFAULT_PATH \
    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:" \
    "/home/coder/.bun/bin:/home/coder/.npm-global/bin"

extern char **environ;

static const char *const ENV_GUARD_DROP_PREFIX[] = {
    "LD_", "NODE_", "BASH_FUNC_", "PYTHON", "PERL", "RUBY", "GIT_",
    "MALLOC_", "GLIBC_", NULL,
};
static const char *const ENV_GUARD_DROP_NAME[] = {
    "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "PS4", "PROMPT_COMMAND",
    "CDPATH", "GLOBIGNORE", "IFS", "GCONV_PATH", "LOCPATH", "NLSPATH",
    "HOSTALIASES", "RES_OPTIONS", "LOCALDOMAIN", NULL,
};
/* Matched by a prefix above but a plain setting: production mode for the
 * node programs (workspace-api refuses to start without its session secret
 * when it is set). */
static const char *const ENV_GUARD_KEEP_NAME[] = { "NODE_ENV", NULL };

static int env_guard_listed(const char *name, size_t len, const char *const *list) {
    for (int i = 0; list[i] != NULL; i++) {
        if (strlen(list[i]) == len && strncmp(name, list[i], len) == 0) return 1;
    }
    return 0;
}

static int env_guard_drops(const char *entry) {
    const char *eq = strchr(entry, '=');
    size_t len = eq ? (size_t)(eq - entry) : strlen(entry);
    if (env_guard_listed(entry, len, ENV_GUARD_KEEP_NAME)) return 0;
    if (env_guard_listed(entry, len, ENV_GUARD_DROP_NAME)) return 1;
    for (int i = 0; ENV_GUARD_DROP_PREFIX[i] != NULL; i++) {
        size_t plen = strlen(ENV_GUARD_DROP_PREFIX[i]);
        if (len >= plen && strncmp(entry, ENV_GUARD_DROP_PREFIX[i], plen) == 0) return 1;
    }
    return 0;
}

/* `caller` is the real uid the runner was started by (getuid() before the
 * switch). Returns 0, or -1 when the environment could not be rewritten — the
 * runner then refuses to start rather than exec with it. */
static int env_guard_apply(uid_t caller) {
    size_t n = 0;
    for (char **e = environ; e && *e; e++) n++;
    char **kept = calloc(n + 1, sizeof(char *));
    if (!kept) return -1;
    size_t k = 0;
    for (char **e = environ; e && *e; e++) {
        if (!env_guard_drops(*e)) kept[k++] = *e;
    }
    kept[k] = NULL;
    environ = kept;
    if (caller != 0 && caller != ENV_GUARD_PM2_UID) {
        if (setenv("PATH", ENV_GUARD_DEFAULT_PATH, 1) != 0) return -1;
    }
    return 0;
}

/* Is `caller` one of the uids allowed to start this runner? */
__attribute__((unused))
static int env_guard_caller_ok(uid_t caller, const uid_t *allowed, size_t n) {
    for (size_t i = 0; i < n; i++) {
        if (caller == allowed[i]) return 1;
    }
    return 0;
}

#endif
