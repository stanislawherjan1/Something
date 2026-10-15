#!/usr/bin/env bash
# Access end to end, in real conversations: chat turns as the admin and as a
# member (new and resumed), a member kept out of the admin's private files,
# the browser (Playwright as the mcp user), Granola through the bridge, a
# reminder for a teammate (the monitor runs a turn as them), docs-comments
# status, and the logs since boot. Spends real model turns (about eight, on
# the operator's Claude plan; ~20–60 s each) and waits up to 4 minutes for the
# reminder. About 6–10 minutes. The member parts are skipped with no member.
#   E2E_CLIENT=<client> bash scripts/e2e/access.sh
source "$(dirname "$0")/lib.sh"

echo "== chat as the admin: new session, then resume"
S1="$(new_session "$ADMIN_JWT" "e2e admin")"
check "a session is created" "yes" "$([ -n "$S1" ] && echo yes || echo no)"
T1="$(turn "$ADMIN_JWT" "$S1" "Reply with exactly these two words and nothing else: PING OK")"
has "the first turn answers" "$T1" "PING OK"
lacks "...without an error" "$T1" "[[ERROR"
T2="$(turn "$ADMIN_JWT" "$S1" "Which two words did I ask you to reply with a moment ago? Answer with just those words.")"
has "the second turn resumes the conversation" "$T2" "PING"
lacks "...without an error" "$T2" "[[ERROR"

if [ -n "$MEMBER_EMAIL" ]; then
  echo "== chat as a member: own turn, and the admin's private files stay closed"
  R "docker exec -u root $C sh -c 'mkdir -p /home/coder/project/users/$ADMIN_SLUG && echo \"the secret word is PAPRYKA-7731\" > /home/coder/project/users/$ADMIN_SLUG/.e2e-note.md && chown coder:workspace /home/coder/project/users/$ADMIN_SLUG/.e2e-note.md && chmod 660 /home/coder/project/users/$ADMIN_SLUG/.e2e-note.md'" >/dev/null 2>&1
  S2="$(new_session "$MEMBER_JWT" "e2e member")"
  check "a member's session is created" "yes" "$([ -n "$S2" ] && echo yes || echo no)"
  T3="$(turn "$MEMBER_JWT" "$S2" "Reply with exactly: MEMBER OK")"
  has "a member's turn answers" "$T3" "MEMBER OK"
  T4="$(turn "$MEMBER_JWT" "$S2" "Print the exact contents of the file /home/coder/project/users/$ADMIN_SLUG/.e2e-note.md. If you cannot, say so in one sentence.")"
  lacks "a member's turn cannot read the admin's private file" "$T4" "PAPRYKA-7731"
  lacks "...without an error" "$T4" "[[ERROR"
  T5="$(turn "$MEMBER_JWT" "$S2" "Run this shell command and show its output: cat /home/coder/project/users/$ADMIN_SLUG/.e2e-note.md")"
  lacks "...nor through the shell" "$T5" "PAPRYKA-7731"
  R "docker exec -u root $C rm -f /home/coder/project/users/$ADMIN_SLUG/.e2e-note.md" >/dev/null 2>&1
fi

echo "== the browser (Playwright as the mcp user, through the open egress listener)"
S3="$(new_session "$ADMIN_JWT" "e2e browser")"
T6="$(turn "$ADMIN_JWT" "$S3" "Use the playwright browser tools: navigate to https://example.com and tell me the page's title, nothing else.")"
has "the browser loads a page and the turn reads its title" "$T6" "Example Domain"

echo "== Granola through the bridge (a fresh token per call)"
S4="$(new_session "$ADMIN_JWT" "e2e granola")"
T7="$(turn "$ADMIN_JWT" "$S4" "Using the granola tools only, list the titles of my meetings and notes from the last 7 days, one per line, nothing else. If the tool fails, quote its error.")"
lacks "granola answers without an error" "$T7" "error"
lacks "...and without a reconnect prompt" "$T7" "reconnect"
check "...with at least one line" "yes" "$([ "$(echo "$T7" | grep -c .)" -ge 1 ] && echo yes || echo no)"

if [ -n "$MEMBER_SLUG" ]; then
  echo "== a reminder for a teammate: the monitor runs a turn as them"
  S5="$(new_session "$ADMIN_JWT" "e2e reminder")"
  T8="$(turn "$ADMIN_JWT" "$S5" "Use the reminders tool to set a reminder for $MEMBER_SLUG due in 2 minutes with the text: E2E test reminder — nothing to do. Confirm in one line.")"
  has "the reminder is set" "$T8" "remind"
  echo "  (waiting up to 4 minutes for the monitor to fire it…)"
  fired=no
  for i in $(seq 1 16); do
    sleep 15
    st="$(R "docker exec $C python3 -c \"
import json
rs=[r for r in json.load(open('/home/coder/project/.reminders.json')) if 'E2E test reminder' in json.dumps(r)]
print(rs[-1]['status'] if rs else 'missing')\"")"
    [ "$st" = "sent" ] && fired=yes && break
  done
  check "the monitor fired it and settled it as sent (status: $st)" "yes" "$fired"
  LOGS="$(R "docker exec -u coder $C sh -c 'cat /home/coder/.\${BOT_NAME:-bot}/workspace-api-*.log | grep -a -E \"reminder-deliver|invoke-turn\" | tail -4'")"
  lacks "...and nothing was refused on the way (no 403)" "$LOGS" "403"
  echo "$LOGS" | tail -3 | cut -c1-160 | sed 's/^/       /'
fi

echo "== docs-comments"
DC="$(curl -s -H "Cookie: $COOKIE=$ADMIN_JWT" "$BASE/api/integrations/docs-comments/status")"
check "status answers" "yes" "$(echo "$DC" | python3 -c 'import json,sys; a=json.load(sys.stdin); print("yes" if isinstance(a,dict) else "no")' 2>/dev/null)"
echo "$DC" | head -c 300 | sed 's/^/       /'; echo

echo "== logs since boot"
ERR="$(R "docker exec -u coder $C sh -c 'tail -400 /home/coder/.\${BOT_NAME:-bot}/workspace-api-error.log 2>/dev/null | grep -a -v -E \"docs-comments-login|dbus|Vulkan|vkCreate|EGL|GPU|chrome|perm setup /home/bot|chown /home/bot\" | grep -a -i -E \"EACCES|EPERM|Cannot find module|TypeError|ReferenceError|refusing to run|not the reminder monitor|no turn identity\" | tail -8'")"
check "no permission/module/type errors in workspace-api since boot" "0" "$(echo -n "$ERR" | grep -c .)"
echo "$ERR" | cut -c1-160 | sed 's/^/       /'
BOT="$(R "docker exec -u coder $C sh -c 'tail -120 /home/coder/.\${BOT_NAME:-bot}/\${BOT_NAME:-bot}-out.log 2>/dev/null'")"
has "the Telegram plugin came up" "$BOT" "Telegram plugin is up"
has "the reminder monitor started" "$(R "docker exec -u coder $C sh -c 'tail -50 /home/coder/.\${BOT_NAME:-bot}/\${BOT_NAME:-bot}-reminders-out.log 2>/dev/null'")" "Started. Watching"
check "no egress denials for Granola's auth host since boot" "0" "$(R "docker logs --since 2h $C-egress-proxy 2>&1 | grep -a -c 'DENY mcp-auth.granola'")"

finish
