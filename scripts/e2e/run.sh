#!/usr/bin/env bash
# Runs end-to-end suites against one deployment, one at a time, and prints a
# summary line per suite. Exits non-zero if any suite failed.
#   run.sh smoke        isolation + imports: no or few model turns, after every deploy
#   run.sh full         every suite, in turn (many real model turns, ~1 hour or more)
#   run.sh <name>...    the named suites (isolation imports access sharing
#                       shared-spaces accounts skills lifestyle group tasks-memory
#                       conversation memory-sight planner)
# The deployment comes from E2E_CLIENT or scripts/e2e/.env.local (see lib.sh).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
SMOKE="isolation imports"
FULL="isolation imports access sharing shared-spaces accounts skills lifestyle group group-window tasks-memory conversation memory-sight planner"
usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[ $# -gt 0 ] || usage
case "$1" in
  smoke) SUITES="$SMOKE" ;;
  full)  SUITES="$FULL" ;;
  -h|--help) usage ;;
  *)     SUITES="$*" ;;
esac
for s in $SUITES; do
  [ -f "$DIR/$s.sh" ] && [ "$s" != lib ] && [ "$s" != run ] && [ "$s" != cleanup ] || { echo "run: no suite named '$s'" >&2; usage; }
done
SUMMARY=(); FAILED=0
for s in $SUITES; do
  echo "######## $s"
  OUT="$(mktemp)"
  bash "$DIR/$s.sh" 2>&1 | tee "$OUT"
  rc=${PIPESTATUS[0]}
  line="$(grep -E "^$s: [0-9]+ passed, [0-9]+ failed$" "$OUT" | tail -1)"
  [ -n "$line" ] || line="$s: did not finish (exit $rc)"
  [ "$rc" -eq 0 ] || FAILED=1
  SUMMARY+=("$line")
  rm -f "$OUT"
  echo
done
echo "######## summary"
printf '%s\n' "${SUMMARY[@]}"
exit "$FAILED"
