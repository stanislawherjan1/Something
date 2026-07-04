#!/usr/bin/env bash
# =============================================================================
# memory-rebuild.sh — one-shot reflect v2 migration for an existing client
# =============================================================================
# Runs INSIDE the container (invoke via: docker exec <container> \
#   /opt/ide/scripts/memory-rebuild.sh). Idempotent — safe to re-run.
#
# Formalises the manual phase-0 cleanup for the fleet: relocates the old verdict
# corpus into the invisible _reflect/ plumbing, archives pure-noise verdicts,
# strips the dead Threads section out of INDEX, then forces one distill + curate
# so the first concept/topic pages materialise from retained history.
#
# Everything moved goes to .memory-archive/ (never deleted) + a tar snapshot,
# so a bad run is fully reversible.
# =============================================================================
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/home/coder/project}"
MEM="$PROJECT_DIR/memory"
ARCHIVE="$PROJECT_DIR/.memory-archive"
STAMP="$(date -u +%Y%m%dT%H%M%S)"
DEST="$ARCHIVE/reflect-v2-migrate-$STAMP"

[ -d "$MEM" ] || { echo "No memory dir at $MEM — nothing to migrate."; exit 0; }
mkdir -p "$DEST"/{threads,drafts}

echo "[memory-rebuild] backing up memory/ → $ARCHIVE/pre-reflect-v2-$STAMP.tar.gz"
tar czf "$ARCHIVE/pre-reflect-v2-$STAMP.tar.gz" -C "$PROJECT_DIR" memory 2>/dev/null || true

# ── 1. Relocate legacy verdict cards into the _reflect/ plumbing ─────────────
# Old location: memory/threads/ + memory/users/<slug>/threads/.
# New location: memory/_reflect/threads/ + memory/users/<slug>/_reflect/threads/.
python3 - "$MEM" "$DEST" <<'PY'
import os, sys, shutil, re
mem, dest = sys.argv[1], sys.argv[2]

def is_noise(text):
    # Pure-noise verdict: no decisions AND no open items AND no durable facts.
    def empty(section):
        m = re.search(rf"##\s*{section}\s*\n(.*?)(?:\n##\s|\Z)", text, re.S | re.I)
        body = (m.group(1) if m else "").strip()
        return (not body) or body.startswith("_(none")
    noteworthy = re.search(r"^noteworthy:\s*true\s*$", text, re.M) is not None
    substance_noise = re.search(r"^substance:\s*noise\s*$", text, re.M) is not None
    if noteworthy:
        return False
    if substance_noise:
        return True
    return empty("Decisions made") and empty("Open items") and empty("Durable facts")

relocated = archived = 0
def process(src_dir, reflect_dir):
    global relocated, archived
    if not os.path.isdir(src_dir):
        return
    os.makedirs(reflect_dir, exist_ok=True)
    for f in os.listdir(src_dir):
        if not f.endswith(".md"):
            continue
        p = os.path.join(src_dir, f)
        try:
            text = open(p, encoding="utf-8", errors="replace").read()
        except Exception:
            continue
        if is_noise(text):
            shutil.move(p, os.path.join(dest, "threads", f"{os.path.basename(src_dir)}_{f}"))
            archived += 1
        else:
            shutil.move(p, os.path.join(reflect_dir, f))
            relocated += 1
    try: os.rmdir(src_dir)
    except OSError: pass

process(os.path.join(mem, "threads"), os.path.join(mem, "_reflect", "threads"))
users = os.path.join(mem, "users")
if os.path.isdir(users):
    for u in os.listdir(users):
        process(os.path.join(users, u, "threads"), os.path.join(users, u, "_reflect", "threads"))
print(f"[memory-rebuild] verdicts: {relocated} relocated to _reflect/, {archived} noise archived")
PY

# ── 2. Strip the dead Threads section + routing row out of INDEX ─────────────
if [ -f "$MEM/INDEX.md" ]; then
  python3 - "$MEM/INDEX.md" <<'PY'
import sys, re
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
lines, out, skip = s.splitlines(keepends=True), [], False
for ln in lines:
    if "Outcome of a prior thread" in ln:      # routing-table row
        continue
    if ln.startswith("## Threads"):            # whole verdict-cards section
        skip = True; continue
    if skip and ln.startswith("## "):
        skip = False
    if skip:
        continue
    out.append(ln)
new = "".join(out)
if new != s:
    open(p, "w", encoding="utf-8").write(new)
    print("[memory-rebuild] INDEX: stripped dead Threads section")
PY
fi

# ── 3. Force one distill + curate so pages materialise from retained history ─
echo "[memory-rebuild] forcing distill (seeds concept/topic pages from hot slugs)…"
curl -sf --max-time 180 -X POST "http://localhost:3001/api/internal/reflect-distill" \
     -H "Content-Type: application/json" -d '{"force":true}' 2>/dev/null || \
     echo "  (distill call failed — run it later; the pipeline picks up on the next tick)"
echo
echo "[memory-rebuild] forcing curate (folds fresh claim buffers into tight pages)…"
curl -sf --max-time 180 -X POST "http://localhost:3001/api/internal/reflect-curate" \
     -H "Content-Type: application/json" -d '{"force":true}' 2>/dev/null || \
     echo "  (curate call failed — safe to skip; runs on the next tick)"
echo

echo "[memory-rebuild] done. Archived material: $DEST (+ tar snapshot). Reversible."
