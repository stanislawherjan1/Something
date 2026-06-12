#!/bin/bash
FORK_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE_DIR="$(cd "$FORK_DIR/../../ide-template" && pwd)"
exec "$TEMPLATE_DIR/rotate.sh" "$FORK_DIR/.env" "$@"
