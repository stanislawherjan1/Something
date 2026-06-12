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
            "section": meta.get("section", ""),
            "action": meta.get("action", "append"),
            "field": meta.get("field", ""),
            "confidence": float(meta.get("confidence", "0") or "0"),
            "rationale": meta.get("rationale", ""),
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
    if p.get("field"):
        lines.append(f"**field:** {p['field']}")
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
                pending.append(f"{p['id']} | {p['card']} | {p['confidence']:.2f} | {summary}")
    if not pending:
        print("(No pending proposals.)")
        return 0
    for line in pending:
        print(line)
    return 0


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

    target = MEMORY_DIR / f"{proposal['card']}.md"
    if not target.exists():
        print(f"ERROR: target card {target} doesn't exist.", file=sys.stderr)
        return 1

    before = target.read_text()
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
