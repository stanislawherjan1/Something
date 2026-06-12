#!/bin/bash
# stamp-skill-frontmatter.sh — idempotent frontmatter stamping for unified-location skills (Bundle 6 / WS3).
#
# Adds `source:`, `editable:`, `managed_by:` fields to every SKILL.md
# in the given directory tree. Skips files that already have any of
# these (idempotent — safe to re-run).
#
# Usage:
#   ./stamp-skill-frontmatter.sh <skills-dir> <source-value> <editable-value> <managed-by-value>
#
# Examples:
#   stamp-skill-frontmatter.sh /opt/ide/skills/default/ system false ide-template
#   stamp-skill-frontmatter.sh /opt/ide/skills/optional/ integration false ide-template
#   stamp-skill-frontmatter.sh ~/project/.claude/skills/ project true operator
#
# Why a separate script (not inline in entrypoint): readability +
# testability + reusability (same script runs at image build time
# for /opt/ide/skills/ AND at runtime per-skill via fork endpoint).

set -e

SKILLS_DIR="${1:?Usage: $0 <skills-dir> <source-value> <editable-value> <managed-by-value>}"
SOURCE_VAL="${2:?missing source value}"
EDITABLE_VAL="${3:?missing editable value}"
MANAGED_BY="${4:?missing managed-by value}"

if [ ! -d "$SKILLS_DIR" ]; then
    echo "[stamp] skipping — $SKILLS_DIR does not exist"
    exit 0
fi

STAMPED=0
SKIPPED=0
FAILED=0

# Iterate every SKILL.md (including nested integration skills like
# shopify/shopify-products/SKILL.md). find handles depth 2-3 cleanly.
while IFS= read -r -d '' skill_md; do
    # Idempotency check — if ANY of our three fields already present,
    # skip. The user (or a previous run) already stamped this skill.
    if grep -qE "^(source|editable|managed_by):" "$skill_md"; then
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    # Verify the file has a valid frontmatter opening — line 1 must
    # be exactly `---`. If not (e.g. our 2026-05-15 `d---` bug), bail
    # loudly so the operator sees it.
    if [ "$(head -1 "$skill_md")" != "---" ]; then
        echo "[stamp] FAIL — $skill_md has malformed frontmatter (line 1 is not '---')" >&2
        FAILED=$((FAILED + 1))
        continue
    fi

    # Find the second `---` (closing delimiter). Insert our 3 lines
    # just before it. Awk does this cleanly without regex pitfalls.
    TMP=$(mktemp)
    awk -v src="$SOURCE_VAL" -v ed="$EDITABLE_VAL" -v mb="$MANAGED_BY" '
        BEGIN { in_fm = 0; fm_count = 0 }
        /^---[[:space:]]*$/ {
            fm_count++
            if (fm_count == 1) { in_fm = 1; print; next }
            if (fm_count == 2 && in_fm) {
                print "source: " src
                print "editable: " ed
                print "managed_by: " mb
                print
                in_fm = 0
                next
            }
        }
        { print }
    ' "$skill_md" > "$TMP"

    # Atomic swap
    mv "$TMP" "$skill_md"
    STAMPED=$((STAMPED + 1))
done < <(find "$SKILLS_DIR" -name "SKILL.md" -type f -print0)

echo "[stamp] $SKILLS_DIR: stamped=$STAMPED skipped=$SKIPPED failed=$FAILED (source=$SOURCE_VAL editable=$EDITABLE_VAL managed_by=$MANAGED_BY)"

[ "$FAILED" -gt 0 ] && exit 1
exit 0
