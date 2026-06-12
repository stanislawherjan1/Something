#!/usr/bin/env bash
# Interactive restic restore wrapper. Lists snapshots, prompts for one,
# restores into a temp directory, then prints a hint about how to copy
# pieces back into the live volume. Never overwrites live data on its own.
#
# Usage:
#   restic-restore.sh <ide-name>          # latest snapshot for that IDE
#   restic-restore.sh <ide-name> <id>     # specific snapshot id
#   restic-restore.sh -l <ide-name>       # list snapshots and exit
#
# Reads creds from ~/.workspace-admin/restic.env (same file used by
# restic-backup.sh).

set -euo pipefail

ENV_FILE="${RESTIC_ENV_FILE:-$HOME/.workspace-admin/restic.env}"
if [[ ! -f "$ENV_FILE" ]]; then
    echo "[restic-restore] missing env file: $ENV_FILE" >&2
    exit 1
fi
# shellcheck disable=SC1090
. "$ENV_FILE"

LIST_ONLY=false
if [[ "${1:-}" == "-l" || "${1:-}" == "--list" ]]; then
    LIST_ONLY=true
    shift
fi

IDE="${1:-}"
if [[ -z "$IDE" ]]; then
    echo "usage: $0 [-l] <ide-name> [snapshot-id]" >&2
    exit 1
fi
SNAPSHOT_ID="${2:-latest}"

if $LIST_ONLY; then
    exec restic snapshots --tag "ide=$IDE"
fi

TARGET="${RESTIC_RESTORE_DIR:-/tmp/ide-restore-$IDE-$(date +%s)}"
mkdir -p "$TARGET"

echo "[restic-restore] restoring snapshot '$SNAPSHOT_ID' for ide=$IDE → $TARGET"
restic restore "$SNAPSHOT_ID" \
    --tag "ide=$IDE" \
    --target "$TARGET"

cat <<MSG

Restore complete. Files are at:
  $TARGET

Inspect, then copy individual pieces back into the live volume by
running rsync from the restored path into the Docker volume mount.
For project files:

  CONTAINER_ID=\$(docker ps -q --filter name=^${IDE}\$)
  docker cp $TARGET/var/lib/docker/volumes/${IDE}_project-data/_data/. \\
            \$CONTAINER_ID:/home/coder/project/

To delete the restore directory once you're done:
  rm -rf $TARGET

MSG
