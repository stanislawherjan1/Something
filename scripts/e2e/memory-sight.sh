#!/usr/bin/env bash
# What the bot sees of memory, in real turns — each layer a turn depends on:
#   - the person's own cards ("About you", "How you like things"): a line put on
#     the card is answered from, and a preference there is followed;
#   - privacy: another person's card is not seen (the admin asks about the
#     member's line);
#   - a note from an earlier conversation is found in a new one;
#   - a team rule an admin asks for lands on Team rules and a member follows it;
#   - the views: their routines and the integrations connected for them, and
#     built-in abilities are not called integrations.
# A bot that had the cards on screen but not in its turn passed every other
# suite; this one fails then. Needs a member. About ten short model turns on
# the operator's Claude plan; 5–8 minutes. Test lines are removed after.
#   E2E_CLIENT=<client> bash scripts/e2e/memory-sight.sh
source "$(dirname "$0")/lib.sh"
need_member
MARK="E2E-$TAG"
prefs() { code "$1" POST /memory/v4/prefs "{\"card\":\"$2\",\"op\":\"$3\",\"text\":\"$4\"}" >/dev/null; }
ABOUT="Locker number: $MARK"
LIKE="Ends every reply with the word $MARK-bye"

echo "── the person's own cards reach their turn"
prefs "$MEMBER_JWT" USER_PROFILE add "$ABOUT"
prefs "$MEMBER_JWT" USER_PREFERENCES add "$LIKE"
S="$(new_session "$MEMBER_JWT" "memory e2e cards")"
REPLY="$(turn "$MEMBER_JWT" "$S" "What is my locker number? Answer briefly.")"
has "a line on About you is answered from" "$REPLY" "$MARK"
has "a line on How you like things is followed" "$REPLY" "$MARK-bye"
lacks "...without an error" "$REPLY" "[[ERROR"

echo "── another person's private card is not seen"
S="$(new_session "$ADMIN_JWT" "memory e2e privacy")"
REPLY="$(turn "$ADMIN_JWT" "$S" "What is the locker number on file? If you do not know it, say only: unknown.")"
lacks "the admin's turn does not see the member's card" "$REPLY" "$MARK"
prefs "$MEMBER_JWT" USER_PROFILE remove "$ABOUT"
prefs "$MEMBER_JWT" USER_PREFERENCES remove "$LIKE"

echo "── a team rule: an admin asks for it, it lands on Team rules, a member's turn follows it"
S="$(new_session "$ADMIN_JWT" "memory e2e team rule")"
REPLY="$(turn "$ADMIN_JWT" "$S" "Make this a rule for the whole team, from now on: every reply ends with the word $MARK-team.")"
lacks "...the rule is taken without an error" "$REPLY" "[[ERROR"
TEAM="$(api "$ADMIN_JWT" GET /memory/v4/prefs | jsonq "' || '.join(l for l in a['team'].get('lines',[]) if '$MARK' in l)")"
has "it is on the Team rules card" "$TEAM" "$MARK-team"
S="$(new_session "$MEMBER_JWT" "memory e2e team rule seen")"
REPLY="$(turn "$MEMBER_JWT" "$S" "Say hello in one short sentence.")"
has "a member's turn follows the team rule" "$REPLY" "$MARK-team"
api "$ADMIN_JWT" GET /memory/v4/prefs | python3 -c "
import json,sys; a=json.load(sys.stdin)
for l in a['team'].get('lines',[]):
    if '$MARK' in l: print(json.dumps({'card':'RULES','op':'remove','text':l}))" | while read -r body; do
  code "$ADMIN_JWT" POST /memory/v4/prefs "$body" >/dev/null
done
check "...and it is gone after" "" "$(api "$ADMIN_JWT" GET /memory/v4/prefs | jsonq "' '.join(l for l in a['team'].get('lines',[]) if '$MARK' in l)")"

echo "── a note from an earlier conversation is found in a new one"
S="$(new_session "$MEMBER_JWT" "memory e2e note")"
REPLY="$(turn "$MEMBER_JWT" "$S" "Remember this, please: the spare office key is with the receptionist, code $MARK-key.")"
lacks "...the note is taken without an error" "$REPLY" "[[ERROR"
S="$(new_session "$MEMBER_JWT" "memory e2e recall")"
REPLY="$(turn "$MEMBER_JWT" "$S" "Where is the spare office key, and what is its code?")"
has "the note is found in a new conversation" "$REPLY" "$MARK-key"

echo "── the views: routines and integrations"
ROUTINES="$(api "$MEMBER_JWT" GET /routines | jsonq "' | '.join(r['title'] for r in a.get('routines',[]) if not r.get('retired'))")"
S="$(new_session "$MEMBER_JWT" "memory e2e views")"
REPLY="$(turn "$MEMBER_JWT" "$S" "List my routines by name, then the integrations connected for me, by name. No other text.")"
if [ -n "$ROUTINES" ]; then
  IFS='|' read -ra RS <<< "$ROUTINES"
  for r in "${RS[@]}"; do r="$(echo "$r" | sed 's/^ *//;s/ *$//')"; [ -n "$r" ] && has "a routine of theirs is listed: $r" "$REPLY" "$r"; done
else
  echo "  (no routines on this member — skipped)"
fi
CONNECTED="$(api "$MEMBER_JWT" GET /integrations | jsonq "' | '.join(e['label'] for e in a.get('integrations',[]) if (e.get('active') or (e.get('mine') or {}).get('active')) and e['id']!='telegram')")"
if [ -n "$CONNECTED" ]; then
  IFS='|' read -ra CS <<< "$CONNECTED"
  for c in "${CS[@]}"; do c="$(echo "$c" | sed 's/^ *//;s/ *$//')"; [ -n "$c" ] && has "a connected integration is listed: $c" "$REPLY" "$c"; done
else
  echo "  (nothing connected for this member — skipped)"
fi
lacks "built-in abilities are not listed as integrations" "$REPLY" "Playwright"

finish
