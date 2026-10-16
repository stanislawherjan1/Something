#!/usr/bin/env bash
# A conversation's basics, in real turns:
#   - the cards reach the turn: a line on the company card is answered from;
#   - a preference asked to be kept lands on the person's card in that turn;
#   - a message sent while a reply is still running stops it cleanly (each
#     person's turns run as their own uid; stopping one used to fail with
#     "kill EPERM" and kill the reply);
#   - a reply says it is complete ("settled") before the turn's process exits.
# Needs a member on the roster. Four or five short model turns on the
# operator's Claude plan; about 3–5 minutes. Test lines are removed after.
#   E2E_CLIENT=<client> bash scripts/e2e/conversation.sh
source "$(dirname "$0")/lib.sh"
need_member
MARK="E2E-$TAG"

echo "── the company card reaches the turn"
code "$ADMIN_JWT" POST /memory/v4/prefs "{\"card\":\"MISSION\",\"op\":\"add\",\"text\":\"The office plant is called Fern $MARK.\"}" >/dev/null
S="$(new_session "$ADMIN_JWT" "conversation e2e cards")"
REPLY="$(turn "$ADMIN_JWT" "$S" "What is our office plant called? Answer with its full name only.")"
has "the bot answers from the company card" "$REPLY" "$MARK"
lacks "...without an error" "$REPLY" "[[ERROR"
code "$ADMIN_JWT" POST /memory/v4/prefs "{\"card\":\"MISSION\",\"op\":\"remove\",\"text\":\"The office plant is called Fern $MARK.\"}" >/dev/null

echo "── a preference asked to be kept lands on the card, at once"
S="$(new_session "$MEMBER_JWT" "conversation e2e preference")"
REPLY="$(turn "$MEMBER_JWT" "$S" "Please remember this from now on: whenever you suggest a tool for polishing text, mention $MARK as the code name of the request.")"
lacks "...the turn ends without an error" "$REPLY" "[[ERROR"
PREFS="$(api "$MEMBER_JWT" GET /memory/v4/prefs)"
ON_CARD="$(echo "$PREFS" | jsonq "any('$MARK' in l for l in a['likes'].get('lines',[]) + a['about'].get('lines',[])) or any('$MARK' in (r.get('text') or '') for r in a.get('rules',[]))")"
check "it is on the person's card when the turn ends" "True" "$ON_CARD"
echo "$PREFS" | python3 -c "
import json,sys; a=json.load(sys.stdin)
for card,key in (('USER_PREFERENCES','likes'),('USER_PROFILE','about')):
    for l in a[key].get('lines',[]):
        if '$MARK' in l: print(json.dumps({'card':card,'op':'remove','text':l}))" | while read -r body; do
  code "$MEMBER_JWT" POST /memory/v4/prefs "$body" >/dev/null
done

echo "── a new message stops the reply before it, without an error"
S="$(new_session "$MEMBER_JWT" "conversation e2e interrupt")"
FIRST="$(mktemp)"
curl -s -N -m 120 -H "Cookie: $COOKIE=$MEMBER_JWT" --form-string "sessionId=$S" \
  --form-string "message=Write the numbers from 1 to 300 in words, one per line, nothing else." "$BASE/api/chat" > "$FIRST" &
CURL=$!
sleep 8
SECOND="$(turn "$MEMBER_JWT" "$S" "Stop that. Reply with the single word $MARK and nothing else.")"
wait "$CURL" 2>/dev/null
lacks "the first reply did not die with kill EPERM" "$(cat "$FIRST")" "EPERM"
has "the second message was answered" "$SECOND" "$MARK"
lacks "...without an error" "$SECOND" "[[ERROR"
rm -f "$FIRST"

echo "── a reply settles before the turn ends"
S="$(new_session "$ADMIN_JWT" "conversation e2e settled")"
RAW="$(curl -s -N -m 120 -H "Cookie: $COOKIE=$ADMIN_JWT" --form-string "sessionId=$S" --form-string "message=Reply with the single word ready." "$BASE/api/chat")"
ORDER="$(echo "$RAW" | grep -E '^event: (settled|done)' | sed 's/event: //' | tr '\n' ' ' | sed 's/ $//')"
check "the reply is marked complete, then done" "settled done" "$ORDER"

finish
