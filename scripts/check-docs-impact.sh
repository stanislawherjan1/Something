#!/bin/bash
# check-docs-impact.sh — refuse to land code on main without a docs decision.
#
# Rule (CLAUDE.md "Docs before main"): every change that reaches main either
# updates the documentation it affects, or says explicitly why none is needed.
# A text rule alone is not enough — agents and people both skip it under
# pressure — so this script is the gate, used by CI (pull requests to main)
# and by the local PreToolUse hook (before `git push … main`).
#
# Passes when, in BASE..HEAD:
#   - no shipped code changed, or
#   - at least one documentation file changed, or
#   - a commit message carries a trailer:  Docs-Impact: none — <reason>
#
# Usage: scripts/check-docs-impact.sh [BASE] [HEAD]   (default origin/main HEAD)
# Exit:  0 = ok, 1 = docs decision missing, 2 = usage / git error

BASE="${1:-origin/main}"
HEAD="${2:-HEAD}"

if ! git rev-parse --verify --quiet "$BASE" >/dev/null || ! git rev-parse --verify --quiet "$HEAD" >/dev/null; then
    echo "check-docs-impact: cannot resolve $BASE or $HEAD" >&2
    exit 2
fi

CHANGED=$(git diff --name-only "$BASE...$HEAD")
[ -z "$CHANGED" ] && exit 0

# Shipped code: everything that ends up in a deployment or the installer.
# Tests and CI config are not user-facing behaviour.
CODE=$(echo "$CHANGED" \
    | grep -E '^(ide-template/|install\.sh$|update\.sh$|bin/|scripts/)' \
    | grep -vE '\.test\.(mjs|js)$|^ide-template/scripts/test-' \
    | grep -vE '(^|/)README\.md$|^ide-template/PROJECT_STRUCTURE\.md$')

# Documentation: the docs tree, the top-level guides, per-component READMEs.
DOCS=$(echo "$CHANGED" \
    | grep -E '^docs/.*\.md$|^README\.md$|^CONTRIBUTING\.md$|(^|/)README\.md$|^ide-template/PROJECT_STRUCTURE\.md$')

if [ -z "$CODE" ]; then
    echo "check-docs-impact: no shipped code changed — ok"
    exit 0
fi
if [ -n "$DOCS" ]; then
    echo "check-docs-impact: docs updated —"
    echo "$DOCS" | sed 's/^/  /'
    exit 0
fi
if git log --format=%B "$BASE..$HEAD" | grep -qiE '^Docs-Impact:[[:space:]]*none[[:space:]]*[—-]+[[:space:]]*[^[:space:]]'; then
    echo "check-docs-impact: 'Docs-Impact: none' declared with a reason — ok"
    exit 0
fi

cat >&2 <<EOF
check-docs-impact: shipped code changed but no documentation did.

Changed code:
$(echo "$CODE" | sed 's/^/  /')

Before this reaches main, either:
  1. update the docs this change affects (see the doc map in CLAUDE.md), or
  2. if nothing user- or operator-visible changed, add a commit trailer:
       Docs-Impact: none — <one-line reason>
EOF
exit 1
