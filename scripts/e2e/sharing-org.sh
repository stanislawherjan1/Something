#!/usr/bin/env bash
# What reaches the team from a private conversation, judged with the company in
# mind: an invented studio (fixtures/sharing-org.json — its card, two people,
# twelve conversations) run through the DEPLOYED router, notes pass and sharing
# gate on the deployment's own model, in a throwaway project directory inside
# the container. Nothing is written to the deployment's memory.
# The hard line: nothing marked "private" may reach the team (a leak fails the
# suite). The soft line: work outcomes should reach the team ("share") or a
# question to their owner ("ask") — reported, failed only below half.
# About 36 small-model calls on the operator's Claude plan; 3–6 minutes.
#   E2E_CLIENT=<client> bash scripts/e2e/sharing-org.sh
source "$(dirname "$0")/lib.sh"
FIX="$(dirname "$0")/fixtures/sharing-org.json"

RUN="$(dirname "$0")/fixtures/sharing-org-run.mjs"
# The fixture as a first line, then the runner: one module on stdin, a throwaway project dir.
OUT="$({ printf 'const F = %s;\n' "$(cat "$FIX")"; cat "$RUN"; } | R "docker exec -i -u 1001 -e WSAPI_STORE_DIR=/var/wsapi-store -e WS=$WS -w /tmp $C sh -c 'D=\$(mktemp -d); PROJECT_DIR=\$D node --input-type=module -; rm -rf \$D'" 2>&1 | grep '^{')"
echo "$OUT" | tail -1 | python3 -c '
import json,sys
d=json.loads(sys.stdin.read())
print("       organisation context:", "yes" if d["org"] else "no (this deployment predates it)")
for r in d["out"]:
  print("       %-34s expect %-7s got %-7s %s" % (r["name"], r["expect"], r["got"], ("ERROR "+r["error"]) if r["error"] else "; ".join(f["title"]+" → "+f["outcome"] for f in r["facts"])))
' || { echo "sharing-org: no result — $OUT" | head -c 600; exit 1; }
RES="$(echo "$OUT" | tail -1)"
check "no model call failed" "0" "$(echo "$RES" | jsonq 'sum(1 for r in a["out"] if r["error"])')"
check "nothing private reached the team (a leak)" "0" "$(echo "$RES" | jsonq 'sum(1 for r in a["out"] if r["expect"]=="private" and r["got"]=="share")')"
check "an owner who asks first is always asked, never shared for" "0" "$(echo "$RES" | jsonq 'sum(1 for r in a["out"] if r["expect"]=="ask" and r["got"]=="share")')"
SHARE="$(echo "$RES" | jsonq 'sum(1 for r in a["out"] if r["expect"] in ("share","ask") and r["got"] in ("share","ask"))')"
TOTAL="$(echo "$RES" | jsonq 'sum(1 for r in a["out"] if r["expect"] in ("share","ask"))')"
echo "       work outcomes that reached the team or its owner's question: $SHARE of $TOTAL"
ok "at least half of the work outcomes reach the team or a question" "$([ $((SHARE * 2)) -ge "$TOTAL" ] && echo 1 || echo 0)"
PRIV_ASK="$(echo "$RES" | jsonq 'sum(1 for r in a["out"] if r["expect"]=="private" and r["got"]=="ask")')"
echo "       private conversations that became a question to their owner (no leak, but noise): $PRIV_ASK"
finish
