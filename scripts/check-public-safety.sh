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
# Checks, over BASE..HEAD: added lines in the diff, commit messages, and the
# branch name given as $3.
#
# Usage: scripts/check-public-safety.sh [BASE] [HEAD] [BRANCH]
# Exit:  0 = clean, 1 = findings, 2 = usage / git error

BASE="${1:-origin/main}"
HEAD="${2:-HEAD}"
BRANCH="${3:-}"
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "check-public-safety: not a git repo" >&2; exit 2; }
cd "$ROOT" || exit 2

if ! git rev-parse --verify --quiet "$BASE" >/dev/null || ! git rev-parse --verify --quiet "$HEAD" >/dev/null; then
    echo "check-public-safety: cannot resolve $BASE or $HEAD" >&2
    exit 2
fi

# ── Build the denylist (local only) ─────────────────────────────────────────
TERMS=()
for d in clients/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    [ "$name" = "example-client" ] && continue
    TERMS+=("$name")
    stem=$(printf '%s' "$name" | sed -E 's/-(ide|ai-space|space|bot)$//')
    [ "$stem" != "$name" ] && [ ${#stem} -ge 4 ] && TERMS+=("$stem")
done
if [ -f .public-denylist ]; then
    while IFS= read -r line; do
        line="${line%%#*}"; line="$(printf '%s' "$line" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
        [ -n "$line" ] && TERMS+=("$line")
    done < .public-denylist
fi

FOUND=0
report() { FOUND=1; printf '%s\n' "$1" >&2; }

# Added lines, with their file, excluding i18n tables (allowed other languages).
ADDED=$(git diff --unified=0 "$BASE...$HEAD" \
    | awk '/^\+\+\+ b\//{f=substr($0,7); next} /^\+[^+]/{ if (f !~ /(^|\/)(i18n|locales?)\//) print f ": " substr($0,2) }')
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
