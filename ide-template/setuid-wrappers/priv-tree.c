/*
 * priv-tree.c — give a person's private trees to their turn user, and take
 * them back when they leave. The one root helper workspace-api may call.
 *
 * A person's private trees in the project — users/<slug>/ (their files),
 * memory/users/<slug>/ (their memory) and .team/users/<slug>/ (their chats and
 * app data) — are owned by their turn user and private group
 * (turn-NN:priv-NN, dirs 2770, files 0660): the kernel keeps another person's
 * turn out, workspace-api (in every priv-* group) keeps its access. Ownership
 * changes need root, and workspace-api runs as uid 1001, so it asks here:
 *
 *   priv-tree assign  <slug> <01..24>   the trees (created if missing) become
 *                                       the slot's — on add, and at every boot
 *   priv-tree archive <slug>            the trees move into the project's
 *                                       .archived-members/<slug>-<time>/ as
 *                                       root 0700 — before a slot is reused
 *   priv-tree grant   <01..24>          the operator's brain (bot) and the
 *                                       editor (coder) join the slot's private
 *                                       group — the primary admin's slot only;
 *                                       takes effect for processes started after
 *
 *   - Only root or workspace-api may start it (mode 4750, group wsapi).
 *   - Every argument is validated here: the slug is [a-z0-9][a-z0-9-]{0,39},
 *     the slot is inside the pool; the project root is fixed. No shell.
 *   - It never follows a symlink: a tree that is a link is refused, and the
 *     walk uses lstat, so a planted link in a private tree cannot aim the
 *     chown elsewhere.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <dirent.h>
#include <fcntl.h>
#include <time.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <errno.h>

#define WSAPI_UID 1001
#define PROJECT_ROOT "/home/coder/project"
#define ARCHIVE_DIR  ".archived-members"   /* under PROJECT_ROOT: same volume, so a rename works */
#define TURN_HOMES   "/home/turns"
#define TURN_POOL_SIZE     24
#define TURN_POOL_UID_BASE 1100
#define TURN_POOL_GID_BASE 1200

#include "env-guard.h"   /* declares environ, env_guard_caller_ok */
/* This helper runs one fixed program with a fixed environment (gpasswd); the
 * environment filter the runners apply has no role here. */
static int (*const env_guard_unused)(uid_t) __attribute__((unused)) = env_guard_apply;

static const char *const TREES[] = { "users", "memory/users", ".team/users", NULL };

static int valid_slug(const char *s) {
    size_t n = strlen(s);
    if (n < 1 || n > 40) return 0;
    for (size_t i = 0; i < n; i++) {
        char c = s[i];
        int ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || (c == '-' && i > 0);
        if (!ok) return 0;
    }
    return 1;
}

static int parse_slot(const char *arg) {
    if (!arg || strlen(arg) != 2 || arg[0] < '0' || arg[0] > '9' || arg[1] < '0' || arg[1] > '9') return -1;
    int n = (arg[0] - '0') * 10 + (arg[1] - '0');
    return (n >= 1 && n <= TURN_POOL_SIZE) ? n : -1;
}

/*
 * Everything below walks by file descriptor, never by path: a tree's owner can
 * swap a directory for a link at any moment, and a path walk that checked
 * with lstat and then acted by name would follow the swap (chown /etc to the
 * slot). Each step opens with O_NOFOLLOW relative to the directory it came
 * from and acts on that descriptor (fchown/fchmod/fdopendir).
 */

/* A parent such as PROJECT_ROOT/memory/users, opened component by component
 * with O_NOFOLLOW: a link anywhere on the way is refused. */
static int open_dir_nofollow(const char *base, const char *rel) {
    int fd = open(base, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return -1;
    char buf[4096];
    if (snprintf(buf, sizeof buf, "%s", rel) >= (int)sizeof buf) { close(fd); errno = ENAMETOOLONG; return -1; }
    char *save = NULL;
    for (char *part = strtok_r(buf, "/", &save); part; part = strtok_r(NULL, "/", &save)) {
        int next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        close(fd);
        if (next < 0) return -1;
        fd = next;
    }
    return fd;
}

/* chown -R uid:gid, dirs 2770, files 0660 — of `name` inside the directory
 * `dirfd`. A link is left as it is and never followed (top == 1: refused). */
static int own_tree_at(int dirfd, const char *name, uid_t uid, gid_t gid, int top, int depth) {
    if (depth > 64) { fprintf(stderr, "priv-tree: %s: too deep\n", name); return -1; }
    int fd = openat(dirfd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) {
        if (errno == ELOOP) {
            if (top) { fprintf(stderr, "priv-tree: %s is a link; refusing\n", name); return -1; }
            return 0;   /* a link inside the tree: left as it is, not followed */
        }
        fprintf(stderr, "priv-tree: open %s: %s\n", name, strerror(errno));
        return -1;
    }
    struct stat st;
    if (fstat(fd, &st) != 0) { close(fd); return -1; }
    int rc = 0;
    if (fchown(fd, uid, gid) != 0) { fprintf(stderr, "priv-tree: chown %s: %s\n", name, strerror(errno)); rc = -1; }
    if (S_ISDIR(st.st_mode)) {
        if (fchmod(fd, 02770) != 0) { fprintf(stderr, "priv-tree: chmod %s: %s\n", name, strerror(errno)); rc = -1; }
        int dfd = dup(fd);
        DIR *d = dfd >= 0 ? fdopendir(dfd) : NULL;
        if (!d) { if (dfd >= 0) close(dfd); close(fd); return -1; }
        struct dirent *e;
        while ((e = readdir(d)) != NULL) {
            if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
            if (own_tree_at(fd, e->d_name, uid, gid, 0, depth + 1) != 0) rc = -1;
        }
        closedir(d);
    } else if (S_ISREG(st.st_mode)) {
        if (fchmod(fd, 0660) != 0) { fprintf(stderr, "priv-tree: chmod %s: %s\n", name, strerror(errno)); rc = -1; }
    }
    close(fd);
    return rc;
}

static int do_assign(const char *slug, int slot) {
    uid_t uid = TURN_POOL_UID_BASE + slot;
    gid_t gid = TURN_POOL_GID_BASE + slot;
    int rc = 0;
    for (int i = 0; TREES[i]; i++) {
        /* The parent (users/, memory/users/, .team/users/) exists already — the
         * entrypoint makes them; a missing or linked parent is a real error. */
        int pfd = open_dir_nofollow(PROJECT_ROOT, TREES[i]);
        if (pfd < 0) { fprintf(stderr, "priv-tree: %s/%s: %s\n", PROJECT_ROOT, TREES[i], strerror(errno)); rc = -1; continue; }
        if (mkdirat(pfd, slug, 02770) != 0 && errno != EEXIST) { fprintf(stderr, "priv-tree: mkdir %s/%s: %s\n", TREES[i], slug, strerror(errno)); rc = -1; close(pfd); continue; }
        /* A tree an archive closed in place (root, 0700: the move failed) is a
         * departed person's: never handed to whoever comes next under the name. */
        struct stat cst;
        if (fstatat(pfd, slug, &cst, AT_SYMLINK_NOFOLLOW) == 0 && S_ISDIR(cst.st_mode) && cst.st_uid == 0 && (cst.st_mode & 07777) == 0700) {
            fprintf(stderr, "priv-tree: %s/%s belongs to a departed member (closed by archive); refusing\n", TREES[i], slug);
            rc = -1; close(pfd); continue;
        }
        if (own_tree_at(pfd, slug, uid, gid, 1, 0) != 0) rc = -1;
        close(pfd);
    }
    /* The person's own skills: users/<slug>/.skills, loaded by their turns
     * only — the slot's home links ~/.claude/skills to it (the CLI reads a
     * person's skills from HOME, the team's from the project). A link already
     * there is replaced (a reused slot); anything else there is left alone. */
    char skills[4096], home_claude[4096], rel[4096];
    snprintf(skills, sizeof skills, "%s/users/%s/.skills", PROJECT_ROOT, slug);
    snprintf(rel, sizeof rel, "users/%s", slug);
    int ufd = open_dir_nofollow(PROJECT_ROOT, rel);
    if (ufd >= 0) {
        if (mkdirat(ufd, ".skills", 02770) != 0 && errno != EEXIST) { fprintf(stderr, "priv-tree: mkdir %s: %s\n", skills, strerror(errno)); rc = -1; }
        else if (own_tree_at(ufd, ".skills", uid, gid, 1, 0) != 0) rc = -1;
        close(ufd);
    } else rc = -1;
    snprintf(home_claude, sizeof home_claude, "%s/%02d/.claude", TURN_HOMES, slot);
    int hfd = open(home_claude, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (hfd >= 0) {
        struct stat lst;
        int have = fstatat(hfd, "skills", &lst, AT_SYMLINK_NOFOLLOW) == 0;
        if (have && S_ISLNK(lst.st_mode)) { unlinkat(hfd, "skills", 0); have = 0; }
        if (!have) {
            if (symlinkat(skills, hfd, "skills") != 0) { fprintf(stderr, "priv-tree: link %s/skills: %s\n", home_claude, strerror(errno)); rc = -1; }
            else if (fchownat(hfd, "skills", uid, gid, AT_SYMLINK_NOFOLLOW) != 0) { fprintf(stderr, "priv-tree: chown %s/skills: %s\n", home_claude, strerror(errno)); rc = -1; }
        }
        close(hfd);
    }
    return rc;
}

/* A person leaves: their three trees move, within the project volume, under
 * PROJECT_ROOT/.archived-members/<slug>-<time>/ (root, 0700) — out of the way of anyone added
 * later under the same name, and out of every turn's reach. (The store is a
 * separate volume, where a rename cannot go.) */
static int do_archive(const char *slug) {
    int pfd = open(PROJECT_ROOT, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (pfd < 0) return -1;
    if (mkdirat(pfd, ARCHIVE_DIR, 0700) != 0 && errno != EEXIST) { fprintf(stderr, "priv-tree: mkdir %s: %s\n", ARCHIVE_DIR, strerror(errno)); close(pfd); return -1; }
    int afd = openat(pfd, ARCHIVE_DIR, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (afd < 0) { fprintf(stderr, "priv-tree: %s is not a directory of its own; refusing\n", ARCHIVE_DIR); close(pfd); return -1; }
    if (fchown(afd, 0, 0) != 0 || fchmod(afd, 0700) != 0) { close(afd); close(pfd); return -1; }
    char dest[256];
    snprintf(dest, sizeof dest, "%s-%ld", slug, (long)time(NULL));
    if (mkdirat(afd, dest, 0700) != 0) { fprintf(stderr, "priv-tree: mkdir %s/%s: %s\n", ARCHIVE_DIR, dest, strerror(errno)); close(afd); close(pfd); return -1; }
    int dfd = openat(afd, dest, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (dfd < 0) { close(afd); close(pfd); return -1; }
    int rc = 0;
    for (int i = 0; TREES[i]; i++) {
        int tfd = open_dir_nofollow(PROJECT_ROOT, TREES[i]);
        if (tfd < 0) continue;                              /* no such parent */
        struct stat st;
        if (fstatat(tfd, slug, &st, AT_SYMLINK_NOFOLLOW) != 0) { close(tfd); continue; }   /* nothing of that kind */
        if (S_ISLNK(st.st_mode)) { fprintf(stderr, "priv-tree: %s/%s is a link; refusing\n", TREES[i], slug); rc = -1; close(tfd); continue; }
        /* users → users, memory/users → memory, .team/users → team */
        const char *name = i == 0 ? "users" : i == 1 ? "memory" : "team";
        if (renameat(tfd, slug, dfd, name) != 0) {
            fprintf(stderr, "priv-tree: move %s/%s: %s — closing it in place\n", TREES[i], slug, strerror(errno));
            if (own_tree_at(tfd, slug, 0, 0, 1, 0) != 0 || fchmodat(tfd, slug, 0700, 0) != 0) rc = -1;
            close(tfd);
            continue;
        }
        close(tfd);
        if (own_tree_at(dfd, name, 0, 0, 1, 0) != 0 || fchmodat(dfd, name, 0700, 0) != 0) rc = -1;
    }
    unlinkat(afd, dest, AT_REMOVEDIR);                      /* fails, as it should, unless nothing moved */
    close(dfd); close(afd); close(pfd);
    return rc;
}

/* gpasswd -a <user> priv-NN, for bot and coder: the one place this helper runs a program. */
static int add_to_group(const char *user, const char *group) {
    pid_t pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) {
        char *const argv[] = { (char *)"gpasswd", (char *)"-a", (char *)user, (char *)group, NULL };
        char *const envp[] = { (char *)"PATH=/usr/sbin:/usr/bin:/sbin:/bin", NULL };
        int devnull = open("/dev/null", O_WRONLY);
        if (devnull >= 0) { dup2(devnull, 1); close(devnull); }
        execve("/usr/bin/gpasswd", argv, envp);
        _exit(127);
    }
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) return -1;
    return (WIFEXITED(status) && WEXITSTATUS(status) == 0) ? 0 : -1;
}

static int do_grant(int slot) {
    char group[16];
    snprintf(group, sizeof group, "priv-%02d", slot);
    int rc = 0;
    if (add_to_group("bot", group) != 0) { fprintf(stderr, "priv-tree: could not add bot to %s\n", group); rc = -1; }
    if (add_to_group("coder", group) != 0) { fprintf(stderr, "priv-tree: could not add coder to %s\n", group); rc = -1; }
    return rc;
}

int main(int argc, char *argv[]) {
    const uid_t caller = getuid();
    struct stat self_stat;
    if (stat("/proc/self/exe", &self_stat) != 0) { perror("priv-tree: stat /proc/self/exe"); return 1; }
    if ((self_stat.st_mode & S_ISUID) == 0 && getuid() != 0) {
        fprintf(stderr, "priv-tree: setuid bit missing on this binary; refusing to run\n");
        return 1;
    }
    static const uid_t allowed_callers[] = { 0, WSAPI_UID };
    if (!env_guard_caller_ok(caller, allowed_callers, sizeof allowed_callers / sizeof allowed_callers[0])) {
        fprintf(stderr, "priv-tree: not started by an allowed user (uid %u); refusing to run\n", (unsigned)caller);
        return 1;
    }
    if (setuid(0) != 0 || setgid(0) != 0) { perror("priv-tree: setuid 0"); return 1; }
    umask(007);

    if (argc >= 4 && strcmp(argv[1], "assign") == 0) {
        int slot = parse_slot(argv[3]);
        if (!valid_slug(argv[2]) || slot < 0) { fprintf(stderr, "priv-tree: assign <slug> <01..%02d>\n", TURN_POOL_SIZE); return 2; }
        return do_assign(argv[2], slot) == 0 ? 0 : 1;
    }
    if (argc >= 3 && strcmp(argv[1], "archive") == 0) {
        if (!valid_slug(argv[2])) { fprintf(stderr, "priv-tree: archive <slug>\n"); return 2; }
        return do_archive(argv[2]) == 0 ? 0 : 1;
    }
    if (argc >= 3 && strcmp(argv[1], "grant") == 0) {
        int slot = parse_slot(argv[2]);
        if (slot < 0) { fprintf(stderr, "priv-tree: grant <01..%02d>\n", TURN_POOL_SIZE); return 2; }
        return do_grant(slot) == 0 ? 0 : 1;
    }
    fprintf(stderr, "priv-tree: usage: assign <slug> <slot> | archive <slug> | grant <slot>\n");
    return 2;
}
