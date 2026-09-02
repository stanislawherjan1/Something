#!/usr/bin/env python3
"""
reflect-apply.py — bridges the reflect-learnings skill's JSON output to
the operator-review flow.

Two modes:

  1. ingest <json-file>
       Reads a JSON proposal list (the skill's stdout) and appends
       each proposal as a `## proposal-NNN-UUID8` markdown section to
       ~/project/memory/_drafts/learnings-YYYY-MM-DD.md. Creates the
       _drafts/ folder + the day's file as needed. Append-only — never
       overwrites existing proposals in the same file.

  2. apply <proposal-id>
       Reads the draft files, finds the matching proposal section,
       applies it to the canonical card per the action field
       (append / update_field / replace_section), and strikes the
       proposal in the draft file with `~~...~~ (applied YYYY-MM-DD)`
       so it doesn't show up in /memory review again.

  3. reject <proposal-id>
       Strikes the proposal as `~~...~~ (rejected YYYY-MM-DD)` without
       applying. Same dedup effect.

  4. list
       Prints pending proposals (those without ~~strikethrough~~) one
       per line as `id | card | confidence | rationale-1-liner`. Used
       by the /memory review Telegram command.

Why a separate Python script (not bash): JSON parsing + multi-file
markdown manipulation + atomic writes. Bash would be 3x longer and
half-broken on edge cases.

Activity log: every apply/reject is appended to
~/project/memory/_drafts/.activity.jsonl with the BEFORE state of
the target card (for any future undo path).
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import secrets
import sys
from pathlib import Path

PROJECT_DIR = Path(os.environ.get("PROJECT_DIR", "/home/coder/project"))
MEMORY_DIR = PROJECT_DIR / "memory"
DRAFTS_DIR = MEMORY_DIR / "_drafts"
ACTIVITY_LOG = DRAFTS_DIR / ".activity.jsonl"
# Before-bytes of every auto-applied write land here so the dashboard's per-node
# diff + one-tap revert can restore them (reflect v2). Under _reflect/ so the
# graph and memory_grep ignore it.
UNDO_DIR = MEMORY_DIR / "_reflect" / "undo"

# Confidence floors per action — proposals below floor are rejected at
# apply-time even if operator approves. Defends against propagating a
# 0.4-confidence proposal the operator accidentally typed.
CONFIDENCE_FLOORS = {"append": 0.7, "update_field": 0.85, "replace_section": 0.9}

# ── Auto-apply envelope (reflect v2) ─────────────────────────────────────────
# The old flow queued EVERY proposal to _drafts for a manual /memory review that
# nobody ran — 11 days of good facts rotted and zero pages were ever born. So
# the safe, additive writes now auto-apply (with an undo snapshot + audit trail
# + after-the-fact digest), while destructive / canonical-rule writes stay gated.
AUTO_APPLY_CONF = float(os.environ.get("REFLECT_AUTO_APPLY_CONF", "0.8"))
# A global kill switch: REFLECT_AUTO_APPLY=0 reverts to draft-everything.
AUTO_APPLY_ON = os.environ.get("REFLECT_AUTO_APPLY", "1") not in ("0", "false", "no")
# Cards whose edits never ride ONE distill's confidence — behavioural
# commitments and the agent's own voice are too consequential to write from a
# single LLM read. They apply in the background only on cross-day recurrence
# (see RULE_RECUR_DAYS + prior_recurrence); there is no operator review.
AUTO_APPLY_CARD_DENY = {"RULES", "AGENT_IDENTITY"}
# Concept/topic pages are the core auto surface and low-risk (accreting, cited,
# non-canonical) — a slightly lower bar than canonical cards so genuinely useful
# context (a client contact, a relationship fact) isn't lost to the 0.8 gate.
AUTO_APPLY_CONF_CONCEPT = float(os.environ.get("REFLECT_AUTO_APPLY_CONF_CONCEPT", "0.75"))
# A gated card (RULES/AGENT_IDENTITY) applies once the SAME fact has surfaced on
# this many DISTINCT daily drafts (this run included): recurrence is the
# confidence signal in place of a single score. 0 → keep them fully out (never).
RULE_RECUR_DAYS = int(os.environ.get("REFLECT_RULE_RECUR_DAYS", "2"))


# ── Secrets kill-list (reflect v2, structural) ───────────────────────────────
# Credentials must NEVER persist to memory — not even a private card (markdown is
# plaintext at rest). The scope-router prompt is told to discard them; this makes
# it true in CODE regardless of what the model emits. A proposal whose content
# trips the kill-list is dropped at ingest.
SECRET_PATTERNS = [
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),                 # AWS access key id
    re.compile(r"\bsk-ant-[A-Za-z0-9_-]{16,}"),          # Anthropic API key / OAuth token (sk-ant-api03-… / sk-ant-oat01-…; hyphens break the plain sk- rule below)
    re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"),              # OpenAI-style key
    re.compile(r"\bghp_[A-Za-z0-9]{30,}\b"),             # GitHub PAT
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),     # Slack token
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),   # PEM private key
    re.compile(r"\bAIza[0-9A-Za-z_\-]{30,}\b"),          # Google API key
    re.compile(r"(?i)\b(?:password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*\S{6,}"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b"),  # JWT
]


def looks_like_secret(text: str) -> bool:
    return any(p.search(text or "") for p in SECRET_PATTERNS)


# ── Append dedup (reflect v2) ────────────────────────────────────────────────
# Concept/topic pages get curated (folded, deduped); canonical CARDS did not, so
# a fact stated twice (repeat distills, LLM restatements) piled up duplicate
# bullets. This catches a NEW append whose content substantially overlaps a line
# already on the target — a near-duplicate, not just an exact one — and drops it.
_DUP_STOP = {"the", "and", "with", "for", "that", "this", "user", "brand", "via", "per"}


def _dup_words(s: str) -> set[str]:
    s = re.sub(r"\[source:[^\]]*\]", " ", (s or "").lower())
    s = re.sub(r"[^0-9a-ząćęłńóśźż ]", " ", s)
    return {w for w in s.split() if len(w) > 2 and w not in _DUP_STOP}


def is_duplicate_append(card_text: str, content: str) -> bool:
    cw = _dup_words(content)
    if len(cw) < 3:
        return False
    for line in (card_text or "").splitlines():
        line = line.strip()
        # A struck line is a RETIRED claim ("strike superseded claims, never
        # delete"). Matching against it let a superseded fact block its own
        # replacement forever — the page could never take the claim that
        # replaced it.
        if "~~" in line:
            continue
        if not line.startswith(("-", "*", "|")) and not line[:2].isalpha():
            continue
        lw = _dup_words(line)
        if not lw:
            continue
        # Overlap must be high in BOTH directions to count as a duplicate. The
        # one-directional test (new content only) dropped concise corrections:
        # "X is not the flagship product" shares almost all of its few words
        # with "X is the flagship product and serves as …" and was discarded,
        # while a verbose correction survived — i.e. the more tightly a claim
        # was written, the likelier it was destroyed, and these pages ask for
        # exactly that ("one atomic, cited claim per line").
        #
        # This is a heuristic and it has a hard floor: word overlap cannot tell
        # "X does Y" from "X no longer does Y", where the whole meaning turns on
        # one short token. A correction that restates the old claim and negates
        # it still reads as a duplicate here. That case is meant to be carried
        # by an explicit `supersedes` on the proposal (see apply_proposal_dict),
        # not by making this heuristic cleverer.
        if len(cw & lw) / len(cw) >= 0.7 and len(cw & lw) / len(lw) >= 0.7:
            return True
    return False


def prior_recurrence(p: dict) -> int:
    """How many PRIOR distinct daily drafts already carried a matching proposal
    (same card + ≥70% content-word overlap). Today's draft is excluded, so this
    counts how many EARLIER days independently surfaced the same fact — the
    signal that lets a gated card apply in the background without a one-shot
    confidence bet."""
    cw = _dup_words(p.get("content", ""))
    if len(cw) < 3:
        return 0
    card = str(p.get("card", ""))
    today_name = today_draft().name
    days = 0
    try:
        files = sorted(DRAFTS_DIR.glob("learnings-*.md"))
    except Exception:
        return 0
    for f in files:
        if f.name == today_name:
            continue
        try:
            blocks = parse_proposal_blocks(f.read_text())
        except Exception:
            continue
        for b in blocks:
            if str(b.get("card", "")) != card:
                continue
            lw = _dup_words(b.get("content", ""))
            if lw and len(cw & lw) / len(cw) >= 0.7:
                days += 1
                break   # count each day at most once
    return days


def is_auto_applicable(p: dict) -> bool:
    """True when a proposal is inside the safe auto-apply envelope. Only ADDITIVE
    writes auto-apply (append / concept-page claim / new-page seed); destructive
    edits (update_field, replace_section) and lint findings never do. Thresholds:
    concept/topic pages at AUTO_APPLY_CONF_CONCEPT (low-risk, cited), canonical
    cards at AUTO_APPLY_CONF. RULES / AGENT_IDENTITY never ride a single read —
    they enter only once the fact recurs across RULE_RECUR_DAYS distinct daily
    drafts (background, no operator review)."""
    if not AUTO_APPLY_ON:
        return False
    if p.get("action", "append") != "append":
        return False           # only additive writes auto-apply
    kind = p.get("kind", "")
    conf = float(p.get("confidence", 0))
    if kind == "lint":
        # A lint finding is advisory, and it can only ever land in memory/LINT.md
        # — resolve_target hard-codes that path and ignores the card field, and
        # the append-only check above still applies — so applying one cannot
        # mutate a card. Refusing it outright is what made the detector useless:
        # findings queued as pending proposals, LINT.md was never created, and
        # nothing drains that queue since the review command was removed. The
        # one component that looks for contradictions and stale claims produced
        # output no human or agent has ever seen.
        return conf >= AUTO_APPLY_CONF_CONCEPT
    if kind in ("concept", "page_seed", "page_edit"):
        return conf >= AUTO_APPLY_CONF_CONCEPT   # concept/topic pages — lower bar
    if str(p.get("card", "")) in AUTO_APPLY_CARD_DENY:
        # Behavioural rules + the agent's voice: recurrence is the confidence
        # signal. Apply only when the same fact surfaced on ≥ RULE_RECUR_DAYS
        # distinct days (this run being the latest). The per-action floor was
        # already enforced upstream, so no extra confidence gate here.
        return RULE_RECUR_DAYS > 0 and prior_recurrence(p) >= (RULE_RECUR_DAYS - 1)
    return conf >= AUTO_APPLY_CONF   # canonical / private CARD append


def write_undo_snapshot(target: Path, before_text: str) -> Path | None:
    """Persist the pre-write bytes so a change can be reverted with one tap.
    Best-effort — a snapshot failure must never block the write itself."""
    if not before_text:
        return None
    try:
        UNDO_DIR.mkdir(parents=True, exist_ok=True)
        ts = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S")
        safe = re.sub(r"[^A-Za-z0-9_-]", "_", target.stem)[:40]
        snap = UNDO_DIR / f"{ts}-{secrets.token_hex(3)}-{safe}.md"
        snap.write_text(before_text)
        return snap
    except Exception:
        return None


def today_draft() -> Path:
    """~/project/memory/_drafts/learnings-YYYY-MM-DD.md"""
    return DRAFTS_DIR / f"learnings-{dt.date.today().isoformat()}.md"


def ensure_drafts_dir() -> None:
    DRAFTS_DIR.mkdir(parents=True, exist_ok=True)


def gen_proposal_id(existing_ids: set[str]) -> str:
    """proposal-NNN-UUID8 — NNN is 1-indexed monotonic, UUID8 is random hex."""
    next_n = 1 + max((int(m.group(1)) for pid in existing_ids if (m := re.match(r"proposal-(\d+)-", pid))), default=0)
    return f"proposal-{next_n:03d}-{secrets.token_hex(4)}"


def parse_proposal_blocks(draft_text: str) -> list[dict]:
    """Parse a draft file into [{id, card, section, action, confidence, rationale, content, status}].
    status is 'pending' | 'applied' | 'rejected' (detected from strikethrough header).
    """
    proposals = []
    # Split on `## proposal-...` headers. Keep separator.
    parts = re.split(r"(?=^## (?:~~)?proposal-\d+-[0-9a-f]+)", draft_text, flags=re.MULTILINE)
    for part in parts:
        if not part.lstrip().startswith("## "):
            continue
        # Header line + body
        header_line, _, body = part.partition("\n")
        header_match = re.match(r"^## (~~)?(proposal-\d+-[0-9a-f]+)(~~)?(.*)$", header_line)
        if not header_match:
            continue
        struck = header_match.group(1) == "~~"
        pid = header_match.group(2)
        suffix = header_match.group(4) or ""
        if "(applied" in suffix:
            status = "applied"
        elif "(rejected" in suffix:
            status = "rejected"
        elif struck:
            status = "applied"  # struck w/o explicit (applied X) tag — assume applied
        else:
            status = "pending"

        # Parse metadata bullets from body
        meta = {}
        for line in body.splitlines():
            m = re.match(r"^\*\*(\w+):\*\*\s*(.*)$", line)
            if m:
                meta[m.group(1)] = m.group(2).strip()

        # Parse fenced content block (```...```)
        content_match = re.search(r"```\n(.*?)```", body, re.DOTALL)
        content = content_match.group(1).rstrip("\n") if content_match else ""

        proposals.append({
            "id": pid,
            "card": meta.get("card", ""),
            # "concept" routes to memory/concepts/<slug>.md (the accreting
            # entity layer); empty/anything else routes to a canonical card.
            "kind": meta.get("kind", ""),
            "section": meta.get("section", ""),
            "action": meta.get("action", "append"),
            "field": meta.get("field", ""),
            "confidence": float(meta.get("confidence", "0") or "0"),
            "rationale": meta.get("rationale", ""),
            # Team mode: a private proposal carries scope=private + the owner
            # slug, so it applies to memory/users/<owner>/<card>.md. Absent /
            # scope=shared → flat memory/<card>.md (solo, or a shared card).
            "scope": meta.get("scope", ""),
            "owner": meta.get("owner", ""),
            "content": content,
            "status": status,
        })
    return proposals


def render_proposal(pid: str, p: dict, status_note: str = "") -> str:
    """Render one proposal as a markdown section. `status_note` (e.g.
    'auto-applied 2026-07-03') strikes the header so an auto-applied proposal
    is an audit record, not a pending review item."""
    header = f"## ~~{pid}~~ ({status_note})" if status_note else f"## {pid}"
    lines = [
        header,
        f"**card:** {p.get('card', '')}",
        f"**section:** {p.get('section', '')}",
        f"**action:** {p.get('action', 'append')}",
    ]
    if p.get("kind"):
        lines.append(f"**kind:** {p['kind']}")
    if p.get("field"):
        lines.append(f"**field:** {p['field']}")
    if p.get("scope"):
        lines.append(f"**scope:** {p['scope']}")
    if p.get("owner"):
        lines.append(f"**owner:** {p['owner']}")
    lines.extend([
        f"**confidence:** {p.get('confidence', 0)}",
        f"**rationale:** {p.get('rationale', '')}",
        "**content:**",
        "```",
        p.get("content", ""),
        "```",
        "",
        "---",
        "",
    ])
    return "\n".join(lines)


def cmd_ingest(args) -> int:
    """Reads JSON from file or stdin, appends to today's draft."""
    src = Path(args.json_file) if args.json_file else None
    raw = src.read_text() if src else sys.stdin.read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"ERROR: invalid JSON: {e}", file=sys.stderr)
        return 1

    proposals = data.get("proposals", [])
    if not proposals:
        print("No proposals to ingest. (Reflect-bot returned empty list — the correct answer most of the time.)")
        return 0

    ensure_drafts_dir()
    draft = today_draft()
    today = dt.date.today().isoformat()

    # Build existing-IDs set from today's draft
    existing_text = draft.read_text() if draft.exists() else ""
    existing_ids = {p["id"] for p in parse_proposal_blocks(existing_text)}

    # Emit one proposal section per JSON entry with a freshly generated ID.
    # With --auto (reflect v2), proposals inside the safe envelope are APPLIED
    # now and recorded struck as an audit trail; everything else is queued
    # pending for /memory review exactly as before.
    new_text = existing_text
    if not existing_text.strip():
        new_text = f"# Learnings draft — {today}\n\n"
    auto = bool(getattr(args, "auto", False))
    appended = applied = gated = 0
    applied_targets = []
    for p in proposals:
        floor = CONFIDENCE_FLOORS.get(p.get("action", "append"), 0.7)
        if float(p.get("confidence", 0)) < floor:
            print(f"SKIP (below {floor} floor): {p.get('card')} — {p.get('rationale', '')[:60]}", file=sys.stderr)
            continue
        # Secrets kill-list: a credential must never reach memory, not even a
        # private card — drop it outright (structural, not prompt-dependent).
        if looks_like_secret(p.get("content", "")):
            print(f"SKIP (secret detected): {p.get('card')} — dropped, never stored", file=sys.stderr)
            continue
        pid = gen_proposal_id(existing_ids)
        existing_ids.add(pid)
        if auto and is_auto_applicable(p):
            res = apply_proposal_dict(p, source="auto-apply", pid=pid)
            if res["ok"]:
                new_text += render_proposal(pid, p, status_note=f"auto-applied {today}")
                applied += 1
                applied_targets.append(res["target"])
                continue
            if res.get("duplicate"):
                # Already recorded — drop silently, don't queue (that's the whole point).
                print(f"SKIP (duplicate): {p.get('card')} — already recorded", file=sys.stderr)
                existing_ids.discard(pid)
                continue
            # An auto-apply that couldn't land cleanly (e.g. ambiguous field) falls
            # back to a pending draft item so the operator can resolve it — never lost.
            print(f"AUTO-FALLBACK ({res['error']}): {p.get('card')} → queued for review", file=sys.stderr)
            gated += 1
        else:
            gated += (1 if auto else 0)
        new_text += render_proposal(pid, p)
        appended += 1

    if appended == 0 and applied == 0:
        print("No proposals above confidence floor.")
        return 0

    tmp = draft.with_suffix(".md.tmp")
    tmp.write_text(new_text)
    tmp.replace(draft)
    if auto:
        tail = f" ({', '.join(applied_targets)})" if applied_targets else ""
        print(f"Auto-applied {applied}, queued {appended} for review in {draft.relative_to(PROJECT_DIR)}{tail}.")
    else:
        print(f"Appended {appended} proposal(s) to {draft.relative_to(PROJECT_DIR)}.")
    return 0


def cmd_list(args) -> int:
    """One pending proposal per line. Used by /memory review Telegram command."""
    if not DRAFTS_DIR.exists():
        return 0
    pending = []
    for draft in sorted(DRAFTS_DIR.glob("learnings-*.md")):
        for p in parse_proposal_blocks(draft.read_text()):
            if p["status"] == "pending":
                summary = (p["rationale"][:60] + "…") if len(p["rationale"]) > 60 else p["rationale"]
                # Show whose private card a proposal targets, so the operator
                # reviewing on Telegram knows it's <owner>'s private memory.
                # Concept proposals are labelled concept:<slug> so they're
                # distinguishable from canonical-card writes at a glance.
                owner_sfx = f" (→{p['owner']})" if p.get("scope") == "private" and p.get("owner") else ""
                if p.get("kind") == "concept":
                    card_label = f"concept:{p['card']}{owner_sfx}"
                else:
                    card_label = f"{p['card']}{owner_sfx}"
                pending.append(f"{p['id']} | {card_label} | {p['confidence']:.2f} | {summary}")
    if not pending:
        print("(No pending proposals.)")
        return 0
    for line in pending:
        print(line)
    return 0


SLUG_RE = re.compile(r"^[a-z0-9-]+$")
# Card names are bare identifiers (AGENT_IDENTITY, USER_PROFILE, RECENT_WEB, …)
# or kebab topic slugs — NEVER a path. Validating this blocks a model-generated
# proposal from smuggling `../` into `card` to escape memory/ and overwrite an
# arbitrary file (RULES, .allowed-emails, another teammate's card).
CARD_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def seed_concept_page(slug: str) -> str:
    """Initial body for a brand-new concept page: frontmatter + an empty
    `## Claims` section that apply_action(append) then writes the first claim
    into. Concept pages are the accreting entity layer — one atomic, cited
    claim per line; superseded claims are struck, never deleted."""
    title = slug.replace("-", " ").title()
    today = dt.date.today().isoformat()
    return (
        "---\n"
        f"title: {title}\n"
        "kind: concept\n"
        f"created: {today}\n"
        f"purpose: Accreting claims about {title}. One atomic, cited claim per line; strike superseded claims, never delete.\n"
        "---\n\n"
        f"Accreting claims about **{title}**. Each line is one atomic, cited assertion.\n\n"
        "## Claims\n"
    )


def seed_lint_page() -> str:
    """Initial body for memory/LINT.md — the append-only advisory log the
    memory-lint health-check writes findings into. Non-destructive: findings are
    observations the operator acts on; nothing here mutates a fact."""
    today = dt.date.today().isoformat()
    return (
        "---\n"
        "card: LINT\n"
        "kind: lint\n"
        f"created: {today}\n"
        "purpose: Memory health findings (contradictions, stale claims, orphan/missing concept pages, index drift) proposed by the memory-lint pass. Advisory only — review and act, then strike the finding.\n"
        "---\n\n"
        "# Memory health — lint findings\n\n"
        "Append-only advisory log. Each finding names the issue + the files involved. "
        "Resolve it by hand, then strike the line `~~…~~ (resolved YYYY-MM-DD)`.\n\n"
        "## Findings\n"
    )


def resolve_target(proposal: dict) -> tuple[Path, str | None]:
    """Resolve a proposal to its target file path.

    kind="lint": a memory-health advisory — always the fixed shared file
    memory/LINT.md (the `card`/`slug` field is ignored). Append-only.

    kind="concept": the `card` field is a SLUG; the target is the accreting
    concept page memory/concepts/<slug>.md (shared) or, for a private concept,
    memory/users/<owner>/concepts/<slug>.md. Validated slug-only (SLUG_RE) — a
    slug, NEVER a path; a malformed owner hard-fails (no silent shared fallback,
    which could leak a private fact).

    Otherwise (a canonical card): a private proposal (scope=private + a valid
    owner slug) targets memory/users/<owner>/<card>.md — that teammate's private
    card. Anything else (scope=shared, or no scope = solo/legacy) targets the
    flat memory/<card>.md.

    Returns (path, error) — error is a string if validation fails (refuse rather
    than risk a path escape).
    """
    card = proposal["card"]
    if proposal.get("kind") == "lint":
        path = MEMORY_DIR / "LINT.md"
        if not path.resolve().is_relative_to(MEMORY_DIR.resolve()):
            return MEMORY_DIR / "INVALID.md", f"resolved lint path escapes memory dir: {path}"
        return path, None
    if proposal.get("kind") == "concept":
        slug = card
        if not isinstance(slug, str) or not SLUG_RE.match(slug):
            return MEMORY_DIR / "INVALID.md", f"concept proposal has invalid slug {slug!r}"
        if proposal.get("scope") == "private":
            owner = proposal.get("owner", "")
            if not SLUG_RE.match(owner):
                return MEMORY_DIR / "INVALID.md", f"private concept has invalid owner slug {owner!r}"
            base = MEMORY_DIR / "users" / owner
        else:
            base = MEMORY_DIR
        path = base / "concepts" / f"{slug}.md"
        # A graduated entity lives at topics/<slug>.md — cmd_graduate MOVES the
        # file and unlinks the source. Without this fallthrough the slug reads as
        # having no page at all: new claims seed a FRESH concepts/<slug>.md
        # beside the topic, both land in the INDEX under identical link text, and
        # the graduated page becomes unreachable — it can no longer be appended
        # to, and reflect-curate skips it for having an empty claim buffer, so
        # nothing can ever supersede what it says. Observed live: an entity with
        # a topic page frozen for ten days next to a concept page still taking
        # every update. Append creates a missing section, so a topic page is a
        # safe target. Only redirect when the concept page does NOT exist, so an
        # already-split entity keeps writing where its claims already are.
        if not path.exists():
            graduated = base / "topics" / f"{slug}.md"
            if graduated.exists():
                path = graduated
        if not path.resolve().is_relative_to(MEMORY_DIR.resolve()):
            return MEMORY_DIR / "INVALID.md", f"resolved concept path escapes memory dir: {path}"
        return path, None
    if not isinstance(card, str) or not CARD_RE.match(card):
        return MEMORY_DIR / "INVALID.md", f"proposal has invalid card name {card!r}"
    if proposal.get("scope") == "private":
        owner = proposal.get("owner", "")
        if not SLUG_RE.match(owner):
            # Hard-fail — never fall back to the SHARED memory/<card>.md path, which
            # would route a fact the model marked PRIVATE into the team-wide tree.
            return MEMORY_DIR / "INVALID.md", f"private proposal has invalid owner slug {owner!r}"
        path = MEMORY_DIR / "users" / owner / f"{card}.md"
    else:
        path = MEMORY_DIR / f"{card}.md"
    # Belt-and-braces: the resolved path MUST stay inside memory/ — catches any
    # traversal/symlink escape even if the regex above is somehow bypassed.
    if not path.resolve().is_relative_to(MEMORY_DIR.resolve()):
        return MEMORY_DIR / "INVALID.md", f"resolved card path escapes memory dir: {path}"
    return path, None


def apply_proposal_dict(p: dict, *, source: str, pid: str = "") -> dict:
    """Apply ONE proposal dict to its target card. The single mutation choke
    point shared by manual approve (cmd_apply) and auto-apply (cmd_ingest
    --auto). Writes an undo snapshot + activity-log entry. Returns
      {ok, target, before_sha256, undo, error}. Never raises for a bad
    proposal — returns ok:False with a reason."""
    floor = CONFIDENCE_FLOORS.get(p.get("action", "append"), 0.7)
    if float(p.get("confidence", 0)) < floor:
        return {"ok": False, "error": f"confidence {p.get('confidence')} below {floor} floor"}

    target, err = resolve_target(p)
    if err:
        return {"ok": False, "error": err}

    is_private = p.get("scope") == "private"
    is_concept = p.get("kind") == "concept"
    is_lint = p.get("kind") == "lint"
    if target.exists():
        before = target.read_text()
    elif is_lint:
        target.parent.mkdir(parents=True, exist_ok=True)
        before = seed_lint_page()
    elif is_concept:
        target.parent.mkdir(parents=True, exist_ok=True)
        before = seed_concept_page(target.stem)
    elif is_private:
        target.parent.mkdir(parents=True, exist_ok=True)
        before = ""
    else:
        return {"ok": False, "error": f"target card {target.name} doesn't exist"}

    # Drop a near-duplicate append before it piles onto the card/page — unless
    # the proposal declares it SUPERSEDES an existing claim. A correction is
    # lexically near-identical to the fact it corrects (the meaning can turn on
    # one negating token), so the duplicate heuristic is exactly wrong for it.
    # An explicit signal is the only reliable way to tell the two apart; the
    # heuristic keeps handling the ordinary case where nothing is declared.
    if (p.get("action", "append") == "append"
            and not str(p.get("supersedes", "")).strip()
            and is_duplicate_append(before, p.get("content", ""))):
        return {"ok": False, "duplicate": True, "error": "duplicate — fact already recorded"}

    after = apply_action(before, p)
    if after is None:
        return {"ok": False, "error": f"action {p.get('action')} could not be applied unambiguously"}

    undo = write_undo_snapshot(target, before)
    undo_rel = str(undo.relative_to(PROJECT_DIR)) if undo else None

    tmp = target.with_suffix(".md.tmp")
    tmp.write_text(after)
    tmp.replace(target)

    # A concept page just accreted a claim (created or appended) — keep its
    # signpost in the right INDEX current so the bot can actually FIND it later
    # (concept pages are never in the prefix; private ones are grep-invisible).
    if is_concept:
        upsert_index_signpost(target)

    before_sha = hashlib.sha256(before.encode()).hexdigest()
    target_rel = str(target.relative_to(PROJECT_DIR))
    log_activity({
        "ts": dt.datetime.now(dt.timezone.utc).isoformat(),
        "action": source,                 # "apply" (manual) | "auto-apply"
        "proposal_id": pid,
        "card": p.get("card", ""),
        "target": target_rel,             # explicit path so revert is uniform
        "kind": p.get("kind", ""),
        "scope": p.get("scope", ""),
        "owner": p.get("owner", ""),
        "section": p.get("section", ""),
        "before_sha256": before_sha,
        "undo": undo_rel,
    })
    return {"ok": True, "target": target_rel, "before_sha256": before_sha, "undo": undo_rel}


def cmd_apply(args) -> int:
    """Apply a single proposal by ID, strike it as applied in the draft."""
    pid = args.proposal_id
    draft, proposal = find_proposal(pid)
    if not draft:
        print(f"ERROR: proposal {pid} not found in any draft file.", file=sys.stderr)
        return 1
    if proposal["status"] != "pending":
        print(f"ERROR: proposal {pid} is already {proposal['status']}.", file=sys.stderr)
        return 1

    res = apply_proposal_dict(proposal, source="apply", pid=pid)
    if not res["ok"]:
        if res.get("duplicate"):
            mark_proposal_status(draft, pid, "applied")   # already recorded — clear it
            print(f"Skipped {pid} (duplicate — already recorded).")
            return 0
        print(f"ERROR: {res['error']}.", file=sys.stderr)
        return 1

    mark_proposal_status(draft, pid, "applied")
    print(f"Applied {pid} → {res['target']}")
    return 0


def count_recent_reverts(target_rel: str, within_s: int = 30 * 86400) -> int:
    """How many times this page was reverted in the recent window. Two reverts
    trip the circuit breaker — reflect-curate stops rewriting a page a human
    keeps un-doing (it's theirs now). Reads the activity log."""
    if not ACTIVITY_LOG.exists():
        return 0
    cutoff = dt.datetime.now(dt.timezone.utc).timestamp() - within_s
    n = 0
    try:
        for line in ACTIVITY_LOG.read_text().splitlines():
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("action") != "revert" or e.get("target") != target_rel:
                continue
            try:
                ts = dt.datetime.fromisoformat(e["ts"]).timestamp()
            except Exception:
                ts = cutoff + 1
            if ts >= cutoff:
                n += 1
    except Exception:
        return 0
    return n


def cmd_curate(args) -> int:
    """Apply a full-page rewrite from reflect-curate (guarded upstream in JS).
    Freezes a page with `hand-curated: true` once it's been reverted twice."""
    spec = json.loads(Path(args.json_file).read_text())
    target_rel = str(spec.get("target", "")).strip()
    new_page = spec.get("page", "")
    if not target_rel or not new_page:
        print("ERROR: curate needs {target, page}.", file=sys.stderr)
        return 1
    target = (PROJECT_DIR / target_rel).resolve()
    if not target.is_relative_to(MEMORY_DIR.resolve()) or target.suffix != ".md":
        print(f"ERROR: curate target escapes memory dir: {target_rel}", file=sys.stderr)
        return 1
    if not target.exists():
        print(f"ERROR: curate target does not exist: {target_rel}", file=sys.stderr)
        return 1

    before = target.read_text()
    # Circuit breaker: a page reverted twice becomes the human's — freeze it.
    if count_recent_reverts(target_rel) >= 2 and "hand-curated: true" not in before:
        fm_end = before.find("\n---", 3)
        if fm_end != -1:
            frozen = before[:fm_end] + "\nhand-curated: true" + before[fm_end:]
            _atomic_write(target, frozen)
        print(f"FROZEN {target_rel} (reverted twice — pipeline will stop rewriting it).")
        return 0

    undo = write_undo_snapshot(target, before)
    _atomic_write(target, new_page)
    log_activity({
        "ts": dt.datetime.now(dt.timezone.utc).isoformat(),
        "action": "curate",
        "target": target_rel,
        "before_sha256": hashlib.sha256(before.encode()).hexdigest(),
        "undo": str(undo.relative_to(PROJECT_DIR)) if undo else None,
    })
    print(f"Curated {target_rel}.")
    return 0


def _atomic_write(target: Path, text: str) -> None:
    tmp = target.with_suffix(".md.tmp")
    tmp.write_text(text)
    tmp.replace(target)


# ── INDEX = the map of each memory scope ─────────────────────────────────────
# An INDEX.md is the auto-maintained MAP of everything in ITS scope. The shared
# tree → memory/INDEX.md lists every shared card + topic + concept; each user's
# private tree → memory/users/<owner>/INDEX.md lists THAT user's cards + topics +
# concepts. It is load-bearing three ways:
#   1. Prefix — the shared INDEX (always) and the per-user USER_INDEX are the map
#      the bot navigates from. Concept/topic pages live OUTSIDE the prefix by
#      invariant and memory_grep skips users/**, so without the index a private
#      page is undiscoverable (write-only).
#   2. Graph — the index node's `[[wiki-links]]` become the strong edges that
#      make each scope's index the visible HUB connecting all its cards/pages.
#   3. Lint — memory-lint keys on "index_drift" (a page with no INDEX entry, or
#      an entry whose page is gone), i.e. it EXPECTS the index to map everything.
# The file is fully machine-generated (a map, not prose): the memory grammar
# lives in the cached-prefix PREAMBLE, so INDEX.md carries only the map. Every
# entry is `[[<stem>]] — <blurb>`; `[[<stem>]]` resolves in-scope (a private
# index's [[user_profile]] → that user's card), which is what draws the hub.

# One-line blurbs for the canonical role cards (they carry no `purpose:`
# frontmatter). Topic/concept pages use their own `purpose:`/`title:` instead.
# Membership here also classifies a root .md as a CARD; any other root .md
# (e.g. a stray topic saved at the root) is listed under Topics.
CARD_DESCRIPTIONS = {
    "RULES": "hard never/always rules — override preferences on conflict",
    "MISSION": "what the bot is here to do: responsibilities, principles, org context",
    "AGENT_IDENTITY": "the agent's name, voice, mood, defaults",
    "AGENT_TOOLS": "per-tool gotchas + activation notes for active integrations",
    "CHANNELS": "the Telegram groups the bot is in + who's in them",
    "RESPONSIBILITIES": "the bot's standing duties toward this person",
    "TEAM": "the team roster + each member's role",
    "USER_PROFILE": "stable facts about the user (role, location, languages, focus)",
    "USER_PREFERENCES": "soft preferences (tone, formatting, working style)",
    "USER_RELATIONSHIPS": "people in the user's life",
    "USER_REFLECTIONS": "the user's own self-introspection entries",
    "RECENT_WEB": "rolling snapshot of the recent web chat",
    "RECENT_TELEGRAM": "rolling snapshot of the recent Telegram conversation",
}


def _frontmatter_field(text: str, field: str) -> str | None:
    m = re.search(rf"^{re.escape(field)}:\s*(.+?)\s*$", text, re.MULTILINE)
    return m.group(1).strip() if m else None


def _clip_blurb(s: str) -> str:
    """First sentence of s, whitespace-collapsed + capped for a one-line blurb."""
    s = re.sub(r"\s+", " ", s).strip()
    s = re.split(r"(?<=[.!?])\s+", s)[0]        # first sentence only
    return s.strip().rstrip(".")[:110]


def _clean_blurb_line(s: str) -> str:
    """Strip markdown/citation furniture off one line so it reads as a blurb."""
    s = s.strip()
    s = re.sub(r"^[-*+]\s+", "", s)                                     # list marker
    s = re.sub(r"\s*\[(?:Source|src)\s*:.*?\]\s*$", "", s, flags=re.I)  # citation tail
    s = re.sub(r"~~(.+?)~~", r"\1", s)                                  # unstrike
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)                              # unbold
    s = re.sub(r"\[\[([^\]]+)\]\]", r"\1", s)                           # unwrap wikilinks
    return s.strip()


def _claim_lines(body: str) -> list[str]:
    """The `## Claims` bullets of a page, oldest first (append order). Split on
    headings rather than regex-capturing the section — a non-greedy capture with
    multiline `$` truncates at the first line end and reports only one claim."""
    parts = re.split(r"\n##\s+", str(body))
    sec = next((p for p in parts if re.match(r"^Claims\b", p.lstrip())), None)
    if not sec:
        return []
    out = []
    for line in sec.split("\n")[1:]:
        s = line.strip()
        if s.startswith("-") and "~~" not in s:   # a struck claim is retired — never the blurb
            out.append(s)
    return out


def _page_date(abs_path: Path, body: str) -> str:
    """Best available freshness stamp for an index entry: the latest date cited
    by a claim, else the file's mtime. Concept pages carry only `created:` in
    frontmatter and curate cannot add an `updated:` (the rewrite guard requires
    byte-identical frontmatter), so without this nothing on ANY recall surface
    tells the model how old a page's content is."""
    dates = re.findall(r"\[(?:Source|src)\s*:[^\]]*?(\d{4}-\d{2}-\d{2})[^\]]*\]", body or "", re.I)
    if dates:
        return max(dates)
    try:
        return dt.datetime.fromtimestamp(abs_path.stat().st_mtime, dt.timezone.utc).strftime("%Y-%m-%d")
    except OSError:
        return ""


def _describe(abs_path: Path, stem_up: str) -> str:
    """A one-line blurb for an index entry — every topic/concept gets one, even
    without a `purpose:` field. Order: canonical card → its fixed description; a
    NON-boilerplate `purpose:`; the first real prose line / claim of the body; the
    page's H1 heading; `title:`. (Concept `purpose:` is the seed boilerplate
    'Accreting claims about X' — skipped so we surface the actual first claim.)"""
    if stem_up in CARD_DESCRIPTIONS:
        return CARD_DESCRIPTIONS[stem_up]
    try:
        raw = abs_path.read_text()
    except OSError:
        return ""
    fm, body = "", raw
    if raw.startswith("---"):
        end = raw.find("\n---", 3)
        if end != -1:
            fm, body = raw[3:end], raw[end + 4:]
    # `purpose:` is the reflect-v2 field; `summary:` is what older hand-made topic
    # pages use — accept either so those pages get a real blurb, not a raw first line.
    purpose = _frontmatter_field(fm, "purpose") or _frontmatter_field(fm, "summary") or ""
    if purpose and not purpose.lower().startswith("accreting claims about"):
        return _clip_blurb(purpose)
    heading = ""
    in_claims = False
    for line in body.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            if not heading and s.startswith("# "):
                heading = s[2:].strip()
            # Skip the Claims buffer in this forward scan. Appends land at the
            # END of that section, so taking its first line advertised every
            # accreting page by its OLDEST claim. A curated page still gets its
            # Summary (a better description than any single claim); a page whose
            # only content IS claims falls through to the newest one below.
            in_claims = bool(re.match(r"^##\s+Claims\b", s, re.I))
            continue
        if in_claims:
            continue
        if s.startswith("<!--") or s.lower().startswith("accreting claims about"):
            continue
        s = re.sub(r"^[-*+]\s+", "", s)                              # list marker
        s = re.sub(r"\s*\[(?:Source|src)\s*:.*?\]\s*$", "", s, flags=re.I)  # citation tail
        s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)                       # unbold
        s = re.sub(r"\[\[([^\]]+)\]\]", r"\1", s)                    # unwrap wikilinks (no stray edges)
        if len(s) >= 8:
            return _clip_blurb(s)
    claims = _claim_lines(body)
    if claims:
        return _clip_blurb(_clean_blurb_line(claims[-1]))            # newest, not oldest
    return _clip_blurb(heading or _frontmatter_field(fm, "title") or "")


def _md_files(d: Path):
    try:
        return sorted(f for f in d.iterdir() if f.is_file() and f.suffix == ".md")
    except OSError:
        return []


def rebuild_scope_index(scope_root: Path, index_path: Path, *, title: str, intro: str) -> None:
    """(Re)generate an INDEX.md as the full MAP of scope_root: every root card,
    every topics/<x>.md and concepts/<x>.md — one `[[<stem>]] — blurb` line each,
    grouped under Cards / Topics / Concepts. Fully machine-owned, so it is written
    wholesale (any stale hand/clone content is replaced). Writes nothing when the
    scope is empty (no card/topic/concept), so we never litter empty indexes.
    Best-effort — never raises into the caller."""
    try:
        cards, topics, concepts = [], [], []

        def entry(f: Path) -> str:
            blurb = _describe(f, f.stem.upper())
            line = f"- [[{f.stem}]]" + (f" — {blurb}" if blurb else "")
            # Carry the age on the line the model actually reads when deciding
            # what to open. Without it two pages about the same entity — one
            # current, one months stale — are indistinguishable at the moment of
            # choosing, and the stale one wins as often as not.
            try:
                stamp = _page_date(f, f.read_text())
            except OSError:
                stamp = ""
            return line + (f" · {stamp}" if stamp else "")

        for f in _md_files(scope_root):
            if f.name.lower() in ("index.md", "about.md"):
                continue
            (cards if f.stem.upper() in CARD_DESCRIPTIONS else topics).append(entry(f))
        for f in _md_files(scope_root / "topics"):
            if f.name.lower() == "about.md":
                continue
            topics.append(entry(f))
        for f in _md_files(scope_root / "concepts"):
            if f.name.lower() == "about.md":
                continue
            concepts.append(entry(f))

        if not (cards or topics or concepts):
            return  # empty scope → no index file

        parts = [f"# {title}\n\n{intro}\n"]
        for label, items in (("Cards", cards), ("Topics", topics), ("Concepts", concepts)):
            if items:
                parts.append(f"\n## {label}\n" + "\n".join(sorted(set(items))) + "\n")
        index_path.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write(index_path, "".join(parts))
    except Exception:
        pass


def _rebuild_shared_index() -> None:
    rebuild_scope_index(
        MEMORY_DIR, MEMORY_DIR / "INDEX.md",
        title="Memory index",
        intro="Map of SHARED (team-wide) memory — cards, topics, concepts. The wiki "
              "entry point; `Read` a target when a turn needs its depth.",
    )


def _rebuild_private_index(owner: str) -> None:
    rebuild_scope_index(
        MEMORY_DIR / "users" / owner, MEMORY_DIR / "users" / owner / "INDEX.md",
        title=f"{owner}'s private memory",
        intro=f"Map of {owner}'s PRIVATE memory — cards, topics, concepts. `Read` a "
              "target for its depth; these are not all in the prefix and memory_grep "
              "cannot see private pages.",
    )


def upsert_index_signpost(page_path: Path) -> None:
    """A concept/topic page just changed — regenerate the INDEX map for ITS scope
    (shared → memory/INDEX.md; private → memory/users/<owner>/INDEX.md) so the map
    always reflects reality. Best-effort; never breaks the underlying page write."""
    try:
        p = page_path.resolve()
        if not p.is_relative_to(MEMORY_DIR.resolve()):
            return
        parts = p.relative_to(MEMORY_DIR.resolve()).parts
        if parts and parts[0] == "users":
            if len(parts) >= 2 and SLUG_RE.match(parts[1]):
                _rebuild_private_index(parts[1])
        else:
            _rebuild_shared_index()
    except Exception:
        pass


def cmd_reindex(args) -> int:
    """Regenerate every INDEX map from scratch: the shared tree (memory/INDEX.md)
    and each user's private tree (memory/users/<slug>/INDEX.md). Idempotent; safe
    to re-run. Use to backfill/repair after the index generator changes, or when a
    shared INDEX.md went missing. Empty scopes get no index file."""
    _rebuild_shared_index()
    n = 1
    users_dir = MEMORY_DIR / "users"
    if users_dir.is_dir():
        for u in sorted(users_dir.iterdir()):
            if u.is_dir() and SLUG_RE.match(u.name):
                _rebuild_private_index(u.name)
                n += 1
    print(f"Rebuilt {n} INDEX map(s) (shared + per-user).")
    return 0


def cmd_graduate(args) -> int:
    """Graduate a matured concept page to a topic (reflect v2 lifecycle): an
    entity that started as an accreting concept, once curated into a rich
    multi-section page, becomes a proper long-form topic. Moves
    concepts/<slug>.md -> topics/<slug>.md and flips `kind: concept` ->
    `kind: topic`. The graph re-renders it as a topic node by directory."""
    src_rel = str(args.path).strip()
    src = (PROJECT_DIR / src_rel).resolve()
    if not src.is_relative_to(MEMORY_DIR.resolve()) or "concepts" not in src.parts or src.suffix != ".md":
        print(f"ERROR: not a concept page: {src_rel}", file=sys.stderr)
        return 1
    if not src.exists():
        print(f"ERROR: concept page gone: {src_rel}", file=sys.stderr)
        return 1
    dest = Path(str(src).replace(f"{os.sep}concepts{os.sep}", f"{os.sep}topics{os.sep}"))
    if dest.exists():
        print(f"SKIP: a topic already exists at {dest.relative_to(PROJECT_DIR)}", file=sys.stderr)
        return 0
    text = src.read_text()
    write_undo_snapshot(src, text)
    text = re.sub(r"^kind:\s*concept\s*$", "kind: topic", text, count=1, flags=re.MULTILINE)
    # Refresh the stale concept-seed purpose line to a topic-shaped one.
    slug = src.stem
    text = re.sub(r"^purpose:\s*Accreting claims about .*$",
                  f"purpose: Long-form context on {slug}. Read when the topic comes up; keep tight, curate in place.",
                  text, count=1, flags=re.MULTILINE)
    dest.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write(dest, text)
    src.unlink()
    # Update the signpost: keyed on slug, so this replaces the old concepts/<slug>
    # line with the new topics/<slug> one (same INDEX — shared or the owner's).
    upsert_index_signpost(dest)
    log_activity({
        "ts": dt.datetime.now(dt.timezone.utc).isoformat(),
        "action": "graduate",
        "target": str(dest.relative_to(PROJECT_DIR)),
        "from": src_rel,
    })
    print(f"Graduated {src_rel} -> {dest.relative_to(PROJECT_DIR)} (concept -> topic).")
    return 0


def cmd_reject(args) -> int:
    """Mark proposal as rejected without applying."""
    pid = args.proposal_id
    draft, proposal = find_proposal(pid)
    if not draft:
        print(f"ERROR: proposal {pid} not found.", file=sys.stderr)
        return 1
    if proposal["status"] != "pending":
        print(f"ERROR: proposal {pid} is already {proposal['status']}.", file=sys.stderr)
        return 1
    log_activity({
        "ts": dt.datetime.now(dt.timezone.utc).isoformat(),
        "action": "reject",
        "proposal_id": pid,
        "card": proposal["card"],
    })
    mark_proposal_status(draft, pid, "rejected")
    print(f"Rejected {pid}.")
    return 0


def find_proposal(pid: str) -> tuple[Path | None, dict | None]:
    if not DRAFTS_DIR.exists():
        return None, None
    for draft in sorted(DRAFTS_DIR.glob("learnings-*.md")):
        for p in parse_proposal_blocks(draft.read_text()):
            if p["id"] == pid:
                return draft, p
    return None, None


def mark_proposal_status(draft: Path, pid: str, new_status: str) -> None:
    """Strike the proposal header with ~~...~~ (status YYYY-MM-DD)."""
    text = draft.read_text()
    today = dt.date.today().isoformat()
    pattern = re.compile(rf"^## {re.escape(pid)}\s*$", re.MULTILINE)
    replacement = f"## ~~{pid}~~ (applied {today})" if new_status == "applied" else f"## ~~{pid}~~ (rejected {today})"
    new_text = pattern.sub(replacement, text, count=1)
    tmp = draft.with_suffix(".md.tmp")
    tmp.write_text(new_text)
    tmp.replace(draft)


def apply_action(card_text: str, p: dict) -> str | None:
    """Returns new card text, or None if action couldn't apply unambiguously."""
    action = p["action"]
    section = p["section"]
    content = p["content"]

    if action == "append":
        # Find section, append content after section's last line (before next ## or EOF)
        if not section:
            return card_text.rstrip() + f"\n\n{content}\n"
        sec_pattern = re.compile(rf"^(## {re.escape(section)}.*?)(?=^## |\Z)", re.MULTILINE | re.DOTALL)
        m = sec_pattern.search(card_text)
        if not m:
            # Section doesn't exist — create it at end
            return card_text.rstrip() + f"\n\n## {section}\n{content}\n"
        sec_text = m.group(1).rstrip()
        new_sec = sec_text + "\n" + content + "\n\n"
        return card_text[:m.start()] + new_sec + card_text[m.end():]

    if action == "update_field":
        field = p.get("field", "")
        if not field or not section:
            return None
        sec_pattern = re.compile(rf"^(## {re.escape(section)}.*?)(?=^## |\Z)", re.MULTILINE | re.DOTALL)
        m = sec_pattern.search(card_text)
        if not m:
            return None
        sec_text = m.group(1)
        field_pattern = re.compile(rf"^- {re.escape(field)}:.*$", re.MULTILINE)
        matches = field_pattern.findall(sec_text)
        if len(matches) != 1:
            return None  # ambiguous or missing — refuse
        new_sec = field_pattern.sub(content.lstrip("- ").strip() if content.startswith("-") else f"- {field}: {content}", sec_text, count=1)
        if not new_sec.startswith("- "):
            # Make sure replacement is a proper bullet
            new_sec = field_pattern.sub(content, sec_text, count=1)
        return card_text[:m.start()] + new_sec + card_text[m.end():]

    if action == "replace_section":
        if not section:
            return None
        sec_pattern = re.compile(rf"^(## {re.escape(section)})(.*?)(?=^## |\Z)", re.MULTILINE | re.DOTALL)
        m = sec_pattern.search(card_text)
        if not m:
            return None
        new_sec = f"{m.group(1)}\n{content}\n\n"
        return card_text[:m.start()] + new_sec + card_text[m.end():]

    return None


def log_activity(entry: dict) -> None:
    ensure_drafts_dir()
    with ACTIVITY_LOG.open("a") as f:
        f.write(json.dumps(entry) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="reflect-apply: ingest reflect-learnings JSON, apply approved proposals to canonical cards.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_ingest = sub.add_parser("ingest", help="Append JSON proposals to today's draft.")
    p_ingest.add_argument("json_file", nargs="?", help="Path to JSON file (default: stdin).")
    p_ingest.add_argument("--auto", action="store_true", help="Auto-apply proposals inside the safe envelope; queue the rest (reflect v2).")

    sub.add_parser("list", help="List pending proposals across all drafts.")

    p_apply = sub.add_parser("apply", help="Apply a proposal to its canonical card.")
    p_apply.add_argument("proposal_id")

    p_reject = sub.add_parser("reject", help="Reject a proposal without applying.")
    p_reject.add_argument("proposal_id")

    p_curate = sub.add_parser("curate", help="Apply a full-page rewrite {target, page} from reflect-curate.")
    p_curate.add_argument("json_file", help="Path to JSON file with {target, page}.")

    p_grad = sub.add_parser("graduate", help="Promote a matured concept page to a topic.")
    p_grad.add_argument("path", help="Relative path of the concept page (memory/.../concepts/<slug>.md).")

    sub.add_parser("reindex", help="Rebuild INDEX signposts for all concept/topic pages (shared + per-user). Idempotent backfill/repair.")

    args = parser.parse_args()
    return {"ingest": cmd_ingest, "list": cmd_list, "apply": cmd_apply, "reject": cmd_reject, "curate": cmd_curate, "graduate": cmd_graduate, "reindex": cmd_reindex}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
