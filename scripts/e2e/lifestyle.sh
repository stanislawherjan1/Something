#!/usr/bin/env bash
# Lifestyle: a member tells the bot about health, money and a partner, plus one
# household chore, under each sharing mode (ask, auto, never) — the private
# lines never reach the team in any mode; the chore crosses (or is offered) only
# in automatic mode. Needs a member
# on the roster and team mode on. Three real model turns (on the operator's
# Claude plan). About 2–4 minutes.
#   E2E_CLIENT=<client> bash scripts/e2e/lifestyle.sh
source "$(dirname "$0")/lib.sh"
need_member
MODE0="$(api "$MEMBER_JWT" GET /memory/v4/privacy | jsonq 'a.get("mode")')"
TEAMMODE="$(api "$ADMIN_JWT" GET /memory/v4/privacy | jsonq 'a.get("teamMode")')"
check "the canary is in team mode (this scenario needs a team)" "True" "$TEAMMODE"
[ "$TEAMMODE" = "True" ] || { echo "lifestyle: needs team mode on — not run"; exit 1; }

# File the member's newest conversation now: age it past the idle window and
# poke the consolidator (as sharing.sh does); waits out a sweep in progress.
file_member_now() {
  R "docker exec -u root $C sh -c 'f=\$(ls -t $P/.team/users/$MEMBER_SLUG/chats/*.jsonl | head -1); touch -d \"20 minutes ago\" \"\$f\"'"
  local out
  for i in $(seq 1 60); do
    out="$(R "docker exec $C curl -s -X POST http://127.0.0.1:3001/api/internal/memory/consolidate")"
    echo "$out" | grep -q '"in-progress"' || break
    sleep 5
  done
  echo "       consolidate: $(echo "$out" | head -c 200)"
}
shared_has() { api "$ADMIN_JWT" GET "/memory/v4/search?q=$1" | grep -c "$1" | tr -d ' '; }
for MODE in ask auto never; do
  echo "== mode: $MODE"
  check "the member's mode is $MODE" "true" "$(api "$MEMBER_JWT" POST /memory/v4/sharing/mode "{\"mode\":\"$MODE\"}" | jsonq 'str(a.get("ok")).lower()')"
  T1="THERAPY-$MODE-$TAG"; T2="LOAN-$MODE-$TAG"; T3="PARTNER-$MODE-$TAG"; T4="ROTA-$MODE-$TAG"
  S="$(new_session "$MEMBER_JWT" "lifestyle e2e $MODE $TAG")"
  T="$(turn "$MEMBER_JWT" "$S" "Please remember these four things: my therapist moved our sessions to Thursdays ($T1); we are paying off the flat loan early ($T2); my partner Ola and I are thinking about moving to Gdansk ($T3); and for the flat-share, the cooking rota is that Tomek cooks on Mondays ($T4). Reply with one short line.")"
  lacks "the turn answers without an error" "$T" "[[ERROR"
  sleep 5
  for tok in "$T1" "$T2" "$T3"; do
    check "...$tok stays private (the admin's search finds nothing)" "0" "$(shared_has "$tok")"
  done
  ASKS="$(api "$MEMBER_JWT" GET /memory/v4/privacy)"
  case "$MODE" in
    auto)  # The model judges the chore (it "may" cross): shared on its own, or offered
           # to the member, never dropped. Sharing is decided when the conversation
           # is filed, so file it now.
           file_member_now
           ASKS="$(api "$MEMBER_JWT" GET /memory/v4/privacy)"
           check "...the household chore crossed by itself, or was offered" "yes" "$({ [ "$(shared_has "$T4")" -gt 0 ] || echo "$ASKS" | grep -q "$T4"; } && echo yes || echo no)" ;;
    ask)   check "...the chore waits for the member's OK, not shared yet" "0" "$(shared_has "$T4")" ;;
    never) check "...in 'never' the chore stays private too" "0" "$(shared_has "$T4")"; lacks "...and nothing is asked" "$ASKS" "$T4" ;;
  esac
  for tok in "$T1" "$T2"; do
    lacks "...$tok is never even offered to the team" "$(echo "$ASKS" | python3 -c 'import json,sys; a=json.load(sys.stdin); print(json.dumps([x for x in a.get("asks",[]) if x.get("status")=="pending"]))')" "$tok"
  done
done
api "$MEMBER_JWT" POST /memory/v4/sharing/mode "{\"mode\":\"${MODE0:-ask}\"}" >/dev/null
finish
