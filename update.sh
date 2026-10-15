#!/usr/bin/env bash
# =============================================================================
# update.sh — pull the latest code and redeploy your workspace(s)
# =============================================================================
# Run this from your Something checkout to update an existing deployment:
#
#   ./update.sh
#
# It pulls the newest code, then redeploys every client in clients/ (your
# config in clients/<name>/ and clients/admin.env is gitignored, so it's never
# touched by the pull). The deploy is idempotent — safe to re-run.
# =============================================================================

set -uo pipefail
cd "$(dirname "$0")" || exit 1

echo "Pulling the latest code..."
if ! git pull --ff-only; then
    echo ""
    echo "git pull couldn't fast-forward."
    echo "  • Local edits?  run 'git stash', then './update.sh', then 'git stash pop'."
    echo "  • History diverged?  re-clone fresh: git clone <repo-url>"
    exit 1
fi

found=0
failed=()
for d in clients/*/; do
    name="$(basename "$d")"
    [ "$name" = "example-client" ] && continue
    [ -f "$d/deploy.sh" ] || continue
    found=1
    echo ""
    echo "→ Redeploying ${name} ..."
    # One client's failure must not stop the others, but it must not be lost
    # either: the exit code used to be dropped here, so a deploy that failed
    # mid-list still ended in "Update complete".
    ( cd "$d" && ./deploy.sh ) || failed+=("$name")
done

if [ "$found" -eq 0 ]; then
    echo "No deployment found in clients/. Run ./install.sh first."
    exit 1
fi

if [ ${#failed[@]} -gt 0 ]; then
    echo ""
    echo "✗ Update finished with ${#failed[@]} failed deploy(s):"
    for name in "${failed[@]}"; do
        echo "  • ${name}  — re-run: (cd clients/${name} && ./deploy.sh)"
    done
    exit 1
fi

echo ""
echo "✓ Update complete."
