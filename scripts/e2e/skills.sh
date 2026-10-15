#!/usr/bin/env bash
# Skills in a team, with real conversations: a member and an admin each make a
# skill, use it, and cannot reach the other's; an admin is asked whether a new
# skill is the team's or their own; a member cannot change the team's skills;
# the skills list is per person. Needs a member on the roster. Nine real model
# turns (on the operator's Claude plan). About 5–10 minutes.
#   E2E_CLIENT=<client> bash scripts/e2e/skills.sh
source "$(dirname "$0")/lib.sh"
need_member
CODE_M="MANGO-$TAG"; CODE_T="KIWI-$TAG"; CODE_A="PLUM-$TAG"
SK_M="e2e-member-$TAG"; SK_T="e2e-team-$TAG"; SK_A="e2e-admin-$TAG"
exists() { R "docker exec -u 1001 $C sh -c 'test -f $1 && echo yes || echo no'"; }

echo "== the person's skills link (made when their slot was assigned)"
MS="$(echo "$ROSTER" | jsonq 'next((e.get("slot") for e in a if e["role"]!="admin"), "")')"; MS="$(printf '%02d' "${MS:-0}")"
check "the member's turn home links their skills" "$P/users/$MEMBER_SLUG/.skills" "$(R "docker exec $C readlink /home/turns/$MS/.claude/skills")"
check "the brain loads the admin's own skills" "$P/users/$ADMIN_SLUG/.skills" "$(R "docker exec $C readlink /home/bot/.claude/skills")"

echo "== a member makes a skill: it is theirs"
S="$(new_session "$MEMBER_JWT" "skills e2e $TAG")"
T="$(turn "$MEMBER_JWT" "$S" "Please create a skill named $SK_M. Description: answers what the member's codeword is. Body: when someone asks for the member's codeword, answer with exactly $CODE_M. Make it, then reply with one line saying where you saved it.")"
lacks "the turn answers without an error" "$T" "[[ERROR"
check "the skill is in the member's own skills" "yes" "$(exists $P/users/$MEMBER_SLUG/.skills/$SK_M/SKILL.md)"
check "...and not among the team's" "no" "$(exists $P/.claude/skills/$SK_M/SKILL.md)"
check "...owned by the member's turn user" "turn-$MS" "$(R "docker exec $C stat -c %U $P/users/$MEMBER_SLUG/.skills/$SK_M/SKILL.md 2>/dev/null")"

echo "== the member's next conversation uses it"
T="$(turn "$MEMBER_JWT" "$(new_session "$MEMBER_JWT" "skills e2e use $TAG")" "What is the member's codeword? Use your skills; reply with the codeword only.")"
has "the member's new conversation knows the codeword" "$T" "$CODE_M"

echo "== the admin's conversations do not"
T="$(turn "$ADMIN_JWT" "$(new_session "$ADMIN_JWT" "skills e2e admin $TAG")" "What is the member's codeword? Use your skills; if you have no skill that says it, reply NONE.")"
lacks "the admin's conversation does not know it" "$T" "$CODE_M"

echo "== an admin is asked whose a new skill is"
SA="$(new_session "$ADMIN_JWT" "skills e2e ask $TAG")"
T="$(turn "$ADMIN_JWT" "$SA" "Create a skill named $SK_T. Description: answers what the team's meeting room is called. Body: when someone asks what the team's meeting room is called, answer with exactly $CODE_T.")"
check "nothing is written before the admin says whose it is" "no no" "$(exists $P/.claude/skills/$SK_T/SKILL.md) $(exists $P/users/$ADMIN_SLUG/.skills/$SK_T/SKILL.md)"
has "the bot asks: the whole team or just you" "$T" "team"
T="$(turn "$ADMIN_JWT" "$SA" "For the whole team.")"
check "after the answer it is among the team's skills" "yes" "$(exists $P/.claude/skills/$SK_T/SKILL.md)"

echo "== the member uses the team's skill"
T="$(turn "$MEMBER_JWT" "$(new_session "$MEMBER_JWT" "skills e2e team $TAG")" "What is the team's meeting room called? Use your skills; reply with the name only.")"
has "the member's conversation knows what the team skill says" "$T" "$CODE_T"

echo "== an admin's own skill stays theirs"
T="$(turn "$ADMIN_JWT" "$(new_session "$ADMIN_JWT" "skills e2e own $TAG")" "Create a skill just for me (not for the team), named $SK_A. Description: answers what the admin's codeword is. Body: when someone asks for the admin's codeword, answer with exactly $CODE_A. Reply with one line.")"
check "it is in the admin's own skills" "yes" "$(exists $P/users/$ADMIN_SLUG/.skills/$SK_A/SKILL.md)"
T="$(turn "$MEMBER_JWT" "$(new_session "$MEMBER_JWT" "skills e2e peek $TAG")" "Print the contents of the file $P/users/$ADMIN_SLUG/.skills/$SK_A/SKILL.md, and tell me the admin's codeword if you know it. If you cannot, say so in one sentence.")"
lacks "the member cannot read the admin's skill" "$T" "$CODE_A"

echo "== a member cannot change the team's skills"
T="$(turn "$MEMBER_JWT" "$(new_session "$MEMBER_JWT" "skills e2e write $TAG")" "Change the team skill $SK_T so the meeting room name becomes HACKED-$TAG. Edit the file $P/.claude/skills/$SK_T/SKILL.md directly.")"
check "the team's skill is unchanged" "0" "$(R "docker exec $C sh -c 'grep -c HACKED-$TAG $P/.claude/skills/$SK_T/SKILL.md 2>/dev/null; true'" | head -1)"

echo "== the skills list, per person"
LM="$(api "$MEMBER_JWT" GET /skills)"; LA="$(api "$ADMIN_JWT" GET /skills)"
has "the member's list has their own skill" "$LM" "$SK_M"
lacks "...and not the admin's" "$LM" "$SK_A"
has "the admin's list has their own" "$LA" "$SK_A"
lacks "...and not the member's" "$LA" "$SK_M"

finish
