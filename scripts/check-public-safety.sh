#!/bin/bash
# check-public-safety.sh — refuse to publish client names or non-English text.
#
# This repository is public. Two rules (CLAUDE.md "Two rules above all others"):
#   1. everything committed is in English;
#   2. no client names, codenames or their bots' names anywhere — code, docs,
#      commit messages, branch names.
# Text rules get skipped under pressure, so this script is the gate that runs
# before every push (local PreToolUse hook: scripts/hooks/public-safety.sh).
#
# The client list is NEVER stored in the repo: it is derived from the local,
# gitignored clients/ directory, plus an optional gitignored .public-denylist
# (one term per line, # comments) for names that are not directory names —
# a client's bot name, a person, a product.
#
# Checks, over BASE..HEAD and commit by commit: the lines each commit adds,
# each commit's message, and the branch name given as $3. Per commit, not the
# net diff of the range: a term added in one commit and removed in a later
# one is still in the history that gets pushed.
#
# An empty term list is an error when run from a checkout that has clients/
# (the list is derived from it, so empty means it was not found), unless
# --allow-empty-terms is given; CI has no client list and runs only the
# English-only rule.
#
# Usage: scripts/check-public-safety.sh [--allow-empty-terms] [BASE] [HEAD] [BRANCH]
# Exit:  0 = clean, 1 = findings, 2 = usage / git error / no term list

ALLOW_EMPTY_TERMS=0
POS=()
for arg in "$@"; do
    case "$arg" in
        --allow-empty-terms) ALLOW_EMPTY_TERMS=1 ;;
        -*) echo "check-public-safety: unknown option $arg" >&2; exit 2 ;;
        *) POS+=("$arg") ;;
    esac
done
BASE="${POS[0]:-origin/main}"
HEAD="${POS[1]:-HEAD}"
BRANCH="${POS[2]:-}"
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "check-public-safety: not a git repo" >&2; exit 2; }
cd "$ROOT" || exit 2

if ! git rev-parse --verify --quiet "$BASE" >/dev/null || ! git rev-parse --verify --quiet "$HEAD" >/dev/null; then
    echo "check-public-safety: cannot resolve $BASE or $HEAD" >&2
    exit 2
fi

# ── Build the denylist (local only) ─────────────────────────────────────────
# clients/ and .public-denylist are gitignored, so they exist only in the MAIN
# working tree; a linked `git worktree` has neither. Read them from there, or
# a worktree would check against an empty list and pass everything.
MAIN_ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
TERMS=()
for d in "$MAIN_ROOT"/clients/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    [ "$name" = "example-client" ] && continue
    TERMS+=("$name")
    stem=$(printf '%s' "$name" | sed -E 's/-(ide|ai-space|space|bot)$//')
    [ "$stem" != "$name" ] && [ ${#stem} -ge 4 ] && TERMS+=("$stem")
done
if [ -f "$MAIN_ROOT/.public-denylist" ]; then
    while IFS= read -r line; do
        line="${line%%#*}"; line="$(printf '%s' "$line" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
        [ -n "$line" ] && TERMS+=("$line")
    done < "$MAIN_ROOT/.public-denylist"
fi

if [ ${#TERMS[@]} -eq 0 ] && [ -d "$MAIN_ROOT/clients" ] && [ "$ALLOW_EMPTY_TERMS" != 1 ]; then
    cat >&2 <<EOF
check-public-safety: no client terms found (clients/ holds only example-client
and there is no .public-denylist), so the client-name rule cannot run. Add the
names to $MAIN_ROOT/.public-denylist, or pass --allow-empty-terms to run the
English-only rule alone.
EOF
    exit 2
fi

FOUND=0
report() { FOUND=1; printf '%s\n' "$1" >&2; }

# Lines added by each commit, prefixed with the commit and the file, excluding
# i18n tables (allowed other languages). `=== <hash>` separates the commits:
# no line of a diff starts with '='.
ADDED=$(git log -p --unified=0 --no-color --format='=== %h' "$BASE..$HEAD" \
    | awk '/^=== /{c=substr($0,5); next} /^\+\+\+ b\//{f=substr($0,7); next} /^\+[^+]/{ if (f !~ /(^|\/)(i18n|locales?)\//) print c " " f ": " substr($0,2) }')
MSGS=$(git log --format='%h %B' "$BASE..$HEAD")

# ── Rule 2: client names ────────────────────────────────────────────────────
for t in "${TERMS[@]}"; do
    re="(^|[^[:alnum:]])${t}([^[:alnum:]]|$)"
    hits=$(printf '%s\n' "$ADDED" | grep -iE "$re" | head -5)
    [ -n "$hits" ] && report "client term '$t' in added lines:
$(printf '%s\n' "$hits" | cut -c1-160 | sed 's/^/    /')"
    hits=$(printf '%s\n' "$MSGS" | grep -iE "$re" | head -5)
    [ -n "$hits" ] && report "client term '$t' in commit messages:
$(printf '%s\n' "$hits" | cut -c1-160 | sed 's/^/    /')"
    [ -n "$BRANCH" ] && printf '%s' "$BRANCH" | grep -qiE "$re" && report "client term '$t' in branch name '$BRANCH'"
done

# ── Rule 1: English only (Polish diacritics are the reliable tell here) ─────
# Polish letters as UTF-8 byte sequences, so this file itself stays ASCII (it is
# scanned by the same rule). An alternation, not a bracket: a byte-level bracket
# matches stray UTF-8 bytes, e.g. inside an arrow.
PL=$(printf '(%s)' '\xc4\x85|\xc4\x87|\xc4\x99|\xc5\x82|\xc5\x84|\xc3\xb3|\xc5\x9b|\xc5\xba|\xc5\xbc|\xc4\x84|\xc4\x86|\xc4\x98|\xc5\x81|\xc5\x83|\xc3\x93|\xc5\x9a|\xc5\xb9|\xc5\xbb')
PL=$(printf "$PL")
hits=$(printf '%s\n' "$ADDED" | grep -E "$PL" | head -5)
[ -n "$hits" ] && report "non-English text in added lines:
$(printf '%s\n' "$hits" | cut -c1-160 | sed 's/^/    /')"
hits=$(printf '%s\n' "$MSGS" | grep -E "$PL" | head -5)
[ -n "$hits" ] && report "non-English text in commit messages:
$(printf '%s\n' "$hits" | cut -c1-160 | sed 's/^/    /')"

if [ "$FOUND" = 1 ]; then
    cat >&2 <<EOF

check-public-safety: this would publish something that must stay private or
non-English text. Fix the files, and for commit messages rewrite them
(git commit --amend / git rebase) before pushing.
EOF
    exit 1
fi
echo "check-public-safety: clean (${#TERMS[@]} local terms checked)"
exit 0
