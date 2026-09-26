#!/bin/bash
# public-safety.sh — Claude Code PreToolUse hook (matcher: Bash). Runs
# scripts/check-public-safety.sh before ANY `git push`: pushing any branch of
# a public repository publishes it, so the gate is not limited to main.
#
# Range checked: what the push would add on top of what the remote already has
# — the branch's upstream if it has one, otherwise origin/main.
#
# Wire in .claude/settings.json (gitignored, per operator):
#   { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/scripts/hooks/public-safety.sh" }
#
# Exit: 0 = allow, 2 = block (stderr is shown to the model).

PAYLOAD=$(cat)
command -v jq >/dev/null 2>&1 || exit 0
CMD=$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$CMD" ] && exit 0
printf '%s' "$CMD" | grep -qE '(^|[;&|[:space:]])git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+push\b' || exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

# Source ref: `<src>:<dst>` if given, else HEAD.
SRC=$(printf '%s' "$CMD" | grep -oE '[^[:space:]:+]+:[^[:space:]]+' | head -1 | cut -d: -f1)
[ -z "$SRC" ] && SRC=HEAD
DST_BRANCH=$(printf '%s' "$CMD" | grep -oE ':[^[:space:]]+' | head -1 | cut -c2-)
[ -z "$DST_BRANCH" ] && DST_BRANCH="$BRANCH"

BASE=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)
[ -z "$BASE" ] && BASE=origin/main
git fetch --quiet origin 2>/dev/null

if OUT=$("$CLAUDE_PROJECT_DIR/scripts/check-public-safety.sh" "$BASE" "$SRC" "$DST_BRANCH" 2>&1); then
    exit 0
fi
{
    echo "Blocked: this push would publish a client name or non-English text."
    echo
    echo "$OUT"
} >&2
exit 2
