#!/bin/bash
# verify-denials.sh — Stop hook that blocks the model from claiming
# absence ("I don't have that skill / file / tool") without first
# running a lookup (Read / Bash / Glob / Grep).
#
# Why: the model has a documented pattern of falsely claiming a skill
# or file doesn't exist when it actually does. Operator-side workaround
# was the `/correct` Telegram command (Bundle 4), which logs the
# correction to memory/patterns/verification-failures.md so the model
# sees its own historical failures next session. This hook is the
# tighter loop — catches the false claim BEFORE the user has to type
# /correct, by blocking the response and asking the model to verify.
#
# Wiring: registered in ~/.claude/settings.json under hooks.Stop. CC
# pipes a JSON payload on stdin per the Stop hook spec.
#
# Implementation notes (rewritten 2026-06-04 canary incident):
#   - Primary source for the assistant's last text is the transcript
#     JSONL at $transcript_path (documented Stop-hook field). The earlier
#     version of this script depended on `last_assistant_message`, which
#     is NOT in the official Stop-hook spec (R.1 spike on canary 2026-05-30
#     observed it empirically, but undocumented = unstable). We fall back
#     to that field only as an accelerator when present.
#   - Every fire now logs to /tmp/verify-denials.log so we can confirm
#     the hook is actually being triggered (otherwise a stub settings.json
#     can leave it inert without anyone noticing).
#   - Absence-claim pattern list extended to ≈90% of observed forms; on
#     match we ALSO append the offending phrase to
#     memory/patterns/verification-failures.md so taste-recall can show
#     it back to the model next session.
#
# Exit:
#   0 — let the response through (no absence claim, or claim was verified)
#   2 — block the response, send stderr back to the model as feedback

set +e

# Log path. The hook runs as whatever user CC spawned claude as — could be
# bot (uid 1003) on Telegram side, wsapi (uid 1001) or coder (uid 1000) on
# web side. /tmp/verify-denials.log was sometimes owned by a different uid
# from a previous hook fire, causing "Permission denied" and silent logging
# loss. Per-uid log paths sidestep that.
LOG="/tmp/verify-denials-$(id -u 2>/dev/null || echo 0).log"
log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG" 2>/dev/null; }

PAYLOAD=$(cat)

# Defensive bailouts: empty payload or no jq → exit 0 (never break the
# bot over its own hook bugs).
[ -z "$PAYLOAD" ] && { log "empty payload, exit 0"; exit 0; }
command -v jq >/dev/null 2>&1 || { log "no jq, exit 0"; exit 0; }

# Anti-infinite-loop guard. CC sets stop_hook_active=true if a previous
# Stop hook already blocked this turn — re-blocking would cause an
# infinite block/retry cycle. If we've already had our say, let through.
STOP_ACTIVE=$(echo "$PAYLOAD" | jq -r '.stop_hook_active // false' 2>/dev/null)
if [ "$STOP_ACTIVE" = "true" ]; then
    log "stop_hook_active=true, exit 0"
    exit 0
fi

TRANSCRIPT=$(echo "$PAYLOAD" | jq -r '.transcript_path // empty' 2>/dev/null)
LAST=$(echo "$PAYLOAD" | jq -r '.last_assistant_message // empty' 2>/dev/null)

# Primary path: read the last assistant message from the transcript JSONL.
# `last_assistant_message` is used only as an accelerator when present.
#
# IMPORTANT: bot tmux channel-mode claude does NOT emit `content[].type=="text"`
# entries for its replies — it ONLY emits `tool_use` blocks for
# `mcp__plugin_telegram_telegram__reply` (and similar telegram MCP tools)
# with the user-facing message in `.input.text`. Pre-2026-06-05 the hook
# extracted only the standard text shape and silently saw empty input
# for every Telegram turn — logged "no last_assistant text, exit 0" and
# never blocked. We now read BOTH text content AND telegram MCP tool_use
# inputs so the hook actually sees what the user will see.
if [ -z "$LAST" ] && [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
    LAST=$(tail -200 "$TRANSCRIPT" 2>/dev/null | jq -r '
        select(.type == "assistant") |
        .message.content[]? |
        if .type == "text" then
            .text
        elif .type == "tool_use" and (.name | test("^mcp__plugin_telegram_telegram__|^mcp__telegram__")) then
            (.input.text // .input.message // empty)
        else
            empty
        end
    ' 2>/dev/null | tail -c 4000)
fi

# No response text → nothing to scan, let through
if [ -z "$LAST" ]; then
    log "no last_assistant text, exit 0"
    exit 0
fi

# Match Polish + English absence-claim patterns. Extended 2026-06-05
# to cover paraphrases the earlier narrow list missed:
#   - "nie znalazłem", "nie widzę X w narzędziach"
#   - "sprawdziłem i nie ma"
#   - "it's not configured / available / set up"
#   - "I don't see X in my tools"
#
# CRITICAL: build the regex as a bash array joined with `|`. The previous
# implementation used a single-quoted multi-line string with `\` at the end
# of each line, expecting bash to treat them as line continuations — but
# inside single quotes `\<newline>` is LITERAL, so the resulting variable
# contained real backslash+newline pairs that grep -E treats as trailing
# backslashes, errors out, and `! grep` falls into the "no absence" branch
# regardless of input. Hook was effectively dead from its first deploy
# until 2026-06-05. Empirically reproduced: "Nie mam tego w pamięci" did
# NOT trigger the block.
ABSENCE_PATTERNS_ARR=(
    # ── Polish direct denials ─────────────────────────────────────────
    'nie mam (tego|takiego|żadnego|w pamięci|w (mojej |swojej )?(pamięci|kontekście)|.{0,30}pamięci|.{0,30}kontekście|dostępu|kontekstu|tej|takich|tej rozmowy|tej karty|tego logu)'
    'tego (już )?nie mam'
    'już tego nie mam'
    'nie ma (takiego|tej|tego|żadnego)'
    'nie znajduję'
    'nie znalazłem'
    'nie pamiętam'
    'nie zapamiętałem'
    'nie widzę (tego|tej|całej|.{0,40}(rozmowy|karty|wiadomości|w pamięci|w kontekście|w snapshot|w logu|w transcript))'
    'sprawdziłem i nie ma'
    'nie posiadam (tego|takiej|takiego)'

    # ── Polish "hedged confessions" — model admits limitation but
    # without saying "nie mam". Common after we ask about older context.
    # 2026-06-05 canary: bot wrote "mój snapshot się urywa wcześniej,
    # więc nie widzę całej rozmowy" — hedged but functionally an
    # absence claim. Block it the same way so the model learns to
    # check recent_messages BEFORE confessing.
    '(snapshot|log|prefix) (mi |się )?(urywa|kończy się|ucina|nie sięga)'
    '(mój|moje|moja) (snapshot|prefix|log|pamięć|kontekst|okno).{0,30}(urywa|kończy|ucina|nie sięga|nie zawiera|wcześniej)'
    '(snapshot|log|prefix|pamięć|kontekst).{0,40}(urywa|kończy|ucina|nie sięga|nie zawiera)'
    '(jest |to )?poza (moim|moją|moimi) (oknem|kontekstem|snapshotem|prefixem|pamięcią)'
    'wykracza poza (moje|moją|moim) (okno|kontekst|snapshot|prefix|pamięć)'
    'sesja (się )?urwała'

    # ── English direct denials ────────────────────────────────────────
    'do(n.?t|esn.?t) have (that|a|an|any|it)'
    'do(n.?t|esn.?t) (see|recall|remember) (that|a|any|it)'
    'do(n.?t|esn.?t) exist'
    'does not exist'
    'can.?t find (that|a|any|it)'
    'cannot find (that|a|any|it)'
    'no such (skill|file|tool|command|integration)'
    "it.?s not (configured|available|set up|enabled|in my)"
    'it is not (configured|available|set up|enabled|in my)'
    'I (do(n.?t|esn.?t) (see|have)|cannot find) (that|a|any|it) in my (tools|skills|mcp|memory|context|prefix)'
    'not in my (memory|context|prefix|snapshot|tools|skills|mcp)'

    # ── English hedged confessions ────────────────────────────────────
    '(my )?(snapshot|prefix|context|log|memory|window) (is )?(truncat|cut off|limited|earlier|incomplete|out of date|stale)'
    'beyond (my )?(window|context|snapshot|prefix|memory)'
    "i (don.?t|can.?t) see (it|that|the full)"
)
# Join array with `|` into a single ERE alternation.
ABSENCE_PATTERNS=$(IFS='|'; echo "${ABSENCE_PATTERNS_ARR[*]}")

if ! echo "$LAST" | grep -qiE -- "$ABSENCE_PATTERNS"; then
    log "no absence claim, exit 0"
    exit 0
fi

# Absence claim detected. Now verify whether the model ran a lookup
# tool in the just-finished turn. The Stop payload doesn't directly
# include tools-used, but transcript_path gives us the session JSONL
# — we tail it and grep for tool_use entries from the most recent
# assistant turn.
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
    log "absence claim but no transcript, exit 0"
    exit 0
fi

# CC writes one JSON object per line. Each assistant message entry
# contains `message.content` which is an array of content blocks;
# tool_use blocks have type="tool_use" + a `name` field.
# We scan the last ~100 lines (the most recent turn) for any
# Read/Bash/Glob/Grep tool_use.
TOOLS_USED=$(tail -100 "$TRANSCRIPT" 2>/dev/null | jq -r '
    select(.type == "assistant") |
    .message.content[]? |
    select(.type == "tool_use") |
    .name
' 2>/dev/null | sort -u)

LOOKUP_TOOLS_PATTERN='^(Read|Bash|Glob|Grep|mcp__workspace-api__memory_grep)$'

if echo "$TOOLS_USED" | grep -qE "$LOOKUP_TOOLS_PATTERN"; then
    log "absence claim BUT lookup tool was used, exit 0"
    exit 0
fi

# Block. Also append to patterns/verification-failures.md so taste-recall
# can surface this back to the model in future sessions.
PATTERNS_FILE="${PROJECT_DIR:-/home/coder/project}/memory/patterns/verification-failures.md"
if [ -d "$(dirname "$PATTERNS_FILE")" ] || mkdir -p "$(dirname "$PATTERNS_FILE")" 2>/dev/null; then
    {
        echo ""
        echo "## $(date -u '+%Y-%m-%d %H:%M:%S UTC') — absence-claim blocked"
        echo ""
        echo "**Quoted from response:**"
        echo "> $(echo "$LAST" | head -c 240 | tr -d '\n')"
        echo ""
        echo "**Trigger:** matched ABSENCE_PATTERNS without prior lookup tool in turn."
        echo ""
    } >> "$PATTERNS_FILE" 2>/dev/null
fi

log "BLOCKING absence claim"

cat >&2 <<EOF
Your response claims something is missing ("I don't have that skill/file/tool" or similar) but you did not run a lookup tool this turn.

Before claiming absence, verify with at least one of:
  - cat ~/.claude/skills/INDEX.md | grep -i <keyword>      # for skills (symlinked to ~/project/.claude/skills/INDEX.md)
  - ls ~/.claude/skills/ ~/project/.claude/skills/         # for skills (raw list)
  - find ~/project/ -iname "*<keyword>*" -type f | head    # for files
  - mcp__workspace-api__memory_grep <keyword>              # for memory content
  - grep mcp ~/.claude.json                                # for tools/MCPs

If after 1-2 lookups you still don't find it, ASK the operator for clarification — don't refuse outright.

This block has been logged to memory/patterns/verification-failures.md so
taste-recall can show it back to you next session — try not to repeat it.

Retry your response with a verification step first.
EOF

exit 2
