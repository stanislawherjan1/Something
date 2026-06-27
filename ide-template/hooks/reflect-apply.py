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

# Confidence floors per action — proposals below floor are rejected at
# apply-time even if operator approves. Defends against propagating a
# 0.4-confidence proposal the operator accidentally typed.
CONFIDENCE_FLOORS = {"append": 0.7, "update_field": 0.85, "replace_section": 0.9}


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


def render_proposal(pid: str, p: dict) -> str:
    """Render one proposal as a markdown section."""
    lines = [
        f"## {pid}",
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

    # Build existing-IDs set from today's draft
    existing_text = draft.read_text() if draft.exists() else ""
    existing_ids = {p["id"] for p in parse_proposal_blocks(existing_text)}

    # Emit one proposal section per JSON entry with a freshly generated ID
    new_text = existing_text
    if not existing_text.strip():
        new_text = f"# Learnings draft — {dt.date.today().isoformat()}\n\n"
    appended = 0
    for p in proposals:
        # Confidence floor gate
        floor = CONFIDENCE_FLOORS.get(p.get("action", "append"), 0.7)
        if float(p.get("confidence", 0)) < floor:
            print(f"SKIP (below {floor} floor): {p.get('card')} — {p.get('rationale', '')[:60]}", file=sys.stderr)
            continue
        pid = gen_proposal_id(existing_ids)
        existing_ids.add(pid)
        new_text += render_proposal(pid, p)
        appended += 1

    if appended == 0:
        print("No proposals above confidence floor.")
        return 0

    # Atomic write
    tmp = draft.with_suffix(".md.tmp")
    tmp.write_text(new_text)
    tmp.replace(draft)
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
            path = MEMORY_DIR / "users" / owner / "concepts" / f"{slug}.md"
        else:
            path = MEMORY_DIR / "concepts" / f"{slug}.md"
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

    floor = CONFIDENCE_FLOORS.get(proposal["action"], 0.7)
    if proposal["confidence"] < floor:
        print(f"ERROR: confidence {proposal['confidence']} below {floor} floor for action {proposal['action']}.", file=sys.stderr)
        return 1

    target, err = resolve_target(proposal)
    if err:
        print(f"ERROR: {err}.", file=sys.stderr)
        return 1

    is_private = proposal.get("scope") == "private"
    is_concept = proposal.get("kind") == "concept"
    is_lint = proposal.get("kind") == "lint"
    if target.exists():
        before = target.read_text()
    elif is_lint:
        # First lint finding — seed the advisory log (## Findings section).
        target.parent.mkdir(parents=True, exist_ok=True)
        before = seed_lint_page()
    elif is_concept:
        # First claim about this entity — seed the concept page (frontmatter +
        # an empty ## Claims section the append then writes into).
        target.parent.mkdir(parents=True, exist_ok=True)
        before = seed_concept_page(target.stem)
    elif is_private:
        # First write to a teammate's private card — seed it (append actions
        # create the section from empty; the dir may not be bootstrapped yet).
        target.parent.mkdir(parents=True, exist_ok=True)
        before = ""
    else:
        print(f"ERROR: target card {target} doesn't exist.", file=sys.stderr)
        return 1
    after = apply_action(before, proposal)
    if after is None:
        print(f"ERROR: action {proposal['action']} could not be applied unambiguously.", file=sys.stderr)
        return 1

    # Atomic write target
    tmp = target.with_suffix(".md.tmp")
    tmp.write_text(after)
    tmp.replace(target)

    # Log to activity (BEFORE state preserved)
    log_activity({
        "ts": dt.datetime.now(dt.timezone.utc).isoformat(),
        "action": "apply",
        "proposal_id": pid,
        "card": proposal["card"],
        "kind": proposal.get("kind", ""),
        "scope": proposal.get("scope", ""),
        "owner": proposal.get("owner", ""),
        "section": proposal["section"],
        "before_sha256": hashlib.sha256(before.encode()).hexdigest(),
    })

    # Strike proposal in draft
    mark_proposal_status(draft, pid, "applied")
    print(f"Applied {pid} → {target.relative_to(PROJECT_DIR)}")
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

    sub.add_parser("list", help="List pending proposals across all drafts.")

    p_apply = sub.add_parser("apply", help="Apply a proposal to its canonical card.")
    p_apply.add_argument("proposal_id")

    p_reject = sub.add_parser("reject", help="Reject a proposal without applying.")
    p_reject.add_argument("proposal_id")

    args = parser.parse_args()
    return {"ingest": cmd_ingest, "list": cmd_list, "apply": cmd_apply, "reject": cmd_reject}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
