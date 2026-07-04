#!/usr/bin/env python3
"""Memory WRITE guards + INDEX correctness (the deterministic, container-free half
of the memory safety harness). Imports hooks/reflect-apply.py against a throwaway
memory tree and asserts the "silent killer" guards: path-escape, secret kill-list,
append dedup, and index-map generation (shared/private/empty/drift/missing)."""
import importlib.util, os, sys, tempfile, shutil
from pathlib import Path

TMP = tempfile.mkdtemp(prefix="memtest-")
os.environ["PROJECT_DIR"] = TMP
MEM = Path(TMP) / "memory"
for d in ("topics", "concepts", "users/alice/topics", "users/alice/concepts", "users/bob"):
    (MEM / d).mkdir(parents=True, exist_ok=True)

RA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks", "reflect-apply.py")
spec = importlib.util.spec_from_file_location("ra", RA)
ra = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ra)

P = F = 0
def check(name, cond):
    global P, F
    print(("  OK   " if cond else "  FAIL ") + name)
    P, F = (P + 1, F) if cond else (P, F + 1)

# ── path-escape (a model-authored slug must never escape memory/) ──
check("path-escape: '../../RULES' concept slug rejected", ra.resolve_target({"kind": "concept", "card": "../../RULES"})[1] is not None)
check("path-escape: 'evil/../x' slug rejected",           ra.resolve_target({"kind": "concept", "card": "evil/../x"})[1] is not None)
check("path-escape: private proposal, owner '../bob' rejected", ra.resolve_target({"scope": "private", "owner": "../bob", "card": "USER_PROFILE"})[1] is not None)
check("valid concept slug 'acme' accepted",               ra.resolve_target({"kind": "concept", "card": "acme"})[1] is None)
check("valid shared card accepted",                       ra.resolve_target({"card": "USER_PROFILE"})[1] is None)

# ── secret kill-list ──
check("secret: Anthropic key caught",  ra.looks_like_secret("token is sk-ant-api03-AbC123dEf456GhI789"))
check("secret: PEM private key caught", ra.looks_like_secret("-----BEGIN RSA PRIVATE KEY-----\nMIIE"))
check("secret: normal prose passes",   not ra.looks_like_secret("Stan prefers concise replies in Polish"))

# ── append dedup ──
card = "## Facts\n- Stan relocated to Gdansk in June 2026 for work\n"
check("dedup: near-duplicate append dropped", ra.is_duplicate_append(card, "Stan relocated to Gdansk in June 2026"))
check("dedup: distinct append kept",          not ra.is_duplicate_append(card, "Stan's newest client is Meridian, a fintech"))

# ── INDEX = the map of its scope ──
def card_md(p): p.write_text("---\ntitle: X\n---\n\n# X\nbody.\n")
def page_md(p, kind, purpose): p.write_text(f"---\ntitle: X\nkind: {kind}\npurpose: {purpose}\n---\n\n## Claims\n- c. [s]\n")
for c in ("RULES", "MISSION"): card_md(MEM / f"{c}.md")
page_md(MEM / "concepts" / "acme.md", "concept", "Accreting claims about Acme")
page_md(MEM / "topics" / "roadmap.md", "topic", "The 2026 product roadmap")
card_md(MEM / "users" / "alice" / "USER_PROFILE.md")
page_md(MEM / "users" / "alice" / "topics" / "orbit.md", "topic", "Orbit engagement, confidential margins")
ra._rebuild_shared_index(); ra._rebuild_private_index("alice"); ra._rebuild_private_index("bob")
sidx = (MEM / "INDEX.md").read_text(); pidx = (MEM / "users" / "alice" / "INDEX.md").read_text()
check("index: shared maps cards (RULES, MISSION)", "[[RULES]]" in sidx and "[[MISSION]]" in sidx)
check("index: shared maps topic + concept",         "[[roadmap]]" in sidx and "[[acme]]" in sidx)
check("index: private maps its card + topic",       "[[USER_PROFILE]]" in pidx and "[[orbit]]" in pidx)
check("index: NO private page leaks into shared",   "orbit" not in sidx.lower())
check("index: empty user 'bob' gets NO index file", not (MEM / "users" / "bob" / "INDEX.md").exists())
(MEM / "topics" / "roadmap.md").unlink(); ra._rebuild_shared_index()
check("index drift: a removed page drops from the map", "[[roadmap]]" not in (MEM / "INDEX.md").read_text())
(MEM / "INDEX.md").unlink(); ra._rebuild_shared_index()
check("index: a MISSING shared INDEX is regenerated", (MEM / "INDEX.md").exists())

print(f"\nGUARDS+INDEX: {P} passed, {F} failed")
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(1 if F else 0)
