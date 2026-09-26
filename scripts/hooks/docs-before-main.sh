#!/bin/bash
# docs-before-main.sh — Claude Code PreToolUse hook (matcher: Bash) for agents
# working on THIS repository. Blocks a `git push` that would update main when
# the pushed range has no docs decision (see scripts/check-docs-impact.sh and
# the "Docs before main" section of CLAUDE.md).
#
# main receives local merges + direct pushes, so the CI docs job can only flag
# a violation after the fact; this hook is the gate that runs before it.
#
# Wire it in .claude/settings.json (gitignored, per operator):
#   "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [
#       { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/scripts/hooks/docs-before-main.sh" } ] } ] }
#
# Exit: 0 = allow, 2 = block (stderr is shown to the model).

PAYLOAD=$(cat)
command -v jq >/dev/null 2>&1 || exit 0
CMD=$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$CMD" ] && exit 0

# Only `git push` commands.
printf '%s' "$CMD" | grep -qE '(^|[;&|[:space:]])git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+push\b' || exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

# Positional args of the push segment (flags dropped): [remote] [refspec…].
SEG=$(printf '%s' "$CMD" | sed -E 's/.*git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+push//; s/[;&|].*//')
ARGS=()
for w in $SEG; do case "$w" in -*) ;; *) ARGS+=("$w") ;; esac; done
REFSPECS=("${ARGS[@]:1}")

# Does this push update main, and from which local ref?
SRC=""
if [ ${#REFSPECS[@]} -eq 0 ]; then
    [ "$BRANCH" = "main" ] && SRC=HEAD          # bare `git push` on main
else
    for r in "${REFSPECS[@]}"; do
        r="${r#+}"
        case "$r" in
            main|refs/heads/main)          SRC=main ;;
            *:main|*:refs/heads/main)      SRC="${r%%:*}" ;;
            HEAD)                          [ "$BRANCH" = "main" ] && SRC=HEAD ;;
        esac
        [ -n "$SRC" ] && break
    done
fi
[ -n "$SRC" ] || exit 0
git fetch --quiet origin main 2>/dev/null

if OUT=$("$CLAUDE_PROJECT_DIR/scripts/check-docs-impact.sh" origin/main "$SRC" 2>&1); then
    exit 0
fi
{
    echo "Blocked: this push would put code on main without a docs decision."
    echo
    echo "$OUT"
} >&2
exit 2
