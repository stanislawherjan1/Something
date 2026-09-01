#!/usr/bin/env python3
"""Reconcile system-ritual reminders into the live .reminders.json.

Runs on EVERY container boot (from entrypoint.sh), BEFORE services start — so
there is no race with the reminder-monitor. bootstrap-project.sh seeds the file
only ONCE (first boot); this makes NEW/updated system rituals "default
everywhere": a plain redeploy converges every existing client's live file.

Rules:
  - Add a template kind:system reminder if its id is missing (idempotent).
  - For a system reminder that already exists, KEEP its schedule/runtime state
    (due, created, status, repeat, recur) but re-sync its TEXT/routing fields
    (title, description, message, channel) from the image template — so a
    redeploy can correct a trigger's wording without resetting anyone's schedule.
  - PER-USER DAY PLANNING (team mode): the single [PLAN_DAY_TRIGGER] doesn't
    work in a team — the one operator brain won't loop a roster, it plans only
    itself. So in team mode we generate one trigger PER member from the roster
    (`r_system_plan_day__<slug>`), each a discrete "plan <slug>" task, and retire
    the generic `r_system_plan_day`. Self-heals as members come and go. Solo keeps
    the generic trigger.
  - Never touch user reminders (only kind:system, matched by id).
  - Preserve owner/group/mode on an existing file (in-place write); on a brand
    new file, set bot:workspace 664 to match how the reminder-mcp owns it.
"""
import json, os, re, sys, time, datetime

TEMPLATE = os.environ.get("REMINDERS_TEMPLATE", "/opt/ide/bootstrap/reminders.json")
PROJECT = os.environ.get("PROJECT_DIR", "/home/coder/project")
LIVE = os.path.join(PROJECT, ".reminders.json")
ROSTER = os.path.join(PROJECT, ".allowed-emails.json")
CONFIG = os.path.join(PROJECT, ".team-config.json")
WD = {"MONDAY":0,"TUESDAY":1,"WEDNESDAY":2,"THURSDAY":3,"FRIDAY":4,"SATURDAY":5,"SUNDAY":6}

PLAN_BASE_ID = "r_system_plan_day"
# Text/routing fields safe to keep in sync from the image template on every boot.
# Schedule/runtime state (due, created, status, repeat, recur) is owned by the
# live file, so re-syncing text never disturbs anyone's schedule.
# `recipients` + `exec` ride here too so a redeploy BACKFILLS them onto per-user
# plan triggers that pre-date the fix (older triggers had neither → they wrongly
# fired into the operator brain). Non-per-user rituals lack these keys in their
# template, so `k in tmpl_e` skips them — only the per-user triggers get them.
SYNC_FIELDS = ("title", "description", "message", "channel", "recipients", "exec")


def compute_due(placeholder, now):
    m = re.match(r"BOOTSTRAP_NEXT_([A-Z]+)_(\d{1,2})_UTC", placeholder or "")
    if not m:
        return now + datetime.timedelta(days=1)
    day, hh = m.group(1), int(m.group(2))
    due = now.replace(hour=hh, minute=0, second=0, microsecond=0)
    if day == "DAILY":
        if due <= now:
            due += datetime.timedelta(days=1)
        return due
    due += datetime.timedelta(days=(WD[day] - now.weekday()) % 7)
    if due <= now:
        due += datetime.timedelta(days=7)
    return due


def read_json(path, default):
    try:
        return json.load(open(path))
    except Exception:
        return default


def per_user_tmpl(slug, base):
    """A per-member plan-day trigger, specialised from the generic base entry.

    Carries recipients:[slug] + exec:true so reminder-monitor runs the planner AS
    that member (their own identity + scope) instead of the operator brain. The
    operator's own trigger routes to fire_operator (the brain reads its own cards
    fine); a teammate's routes to /internal/invoke-turn, which runs the planner as
    that teammate — the only path that can read their now-private cards.
    """
    msg = (
        f"[PLAN_DAY_TRIGGER slug={slug}] Morning day-planning for {slug}. Run the "
        f"morning-planner skill: re-read {slug}'s CURRENT memory/users/{slug}/ cards "
        f"(RESPONSIBILITIES + USER_PROFILE + USER_PREFERENCES) plus their calendar/tasks, "
        f"then plan THEIR day into timed reminders with recipient:{slug}, on their preferred "
        f"channel, at sensible FUTURE times. Plan ONLY {slug}. Set each reminder's urgency "
        f"(now vs ambient). SILENT: set reminders, post nothing. Suggestions only, nothing "
        f"outside the platform."
    )
    e = dict(base)
    e["id"] = f"{PLAN_BASE_ID}__{slug}"
    # No slug in the title: each user sees only THEIR OWN planner trigger (the
    # UI scopes per-recipient), so the slug would just be redundant noise.
    e["title"] = "Morning planning"
    e["message"] = msg
    e["description"] = msg
    e["recipients"] = [slug]   # FOR this member (assignment)
    e["exec"] = True           # EXECUTE the planner AS them, don't just notify
    return e


try:
    tmpl = json.load(open(TEMPLATE))
except Exception:
    sys.exit(0)  # no template → nothing to reconcile
rituals = [r for r in tmpl if r.get("kind") == "system"]
if not rituals:
    sys.exit(0)

existed = os.path.exists(LIVE)
live = []
if existed:
    try:
        live = json.load(open(LIVE))
        if not isinstance(live, list):
            sys.exit(0)             # unexpected shape — don't clobber
    except Exception:
        sys.exit(0)                 # corrupt/locked — leave it for the owner tools

by_id = {r.get("id"): r for r in live if isinstance(r, dict)}
now = datetime.datetime.now(datetime.timezone.utc)
added, updated, removed = [], [], []

# Team mode: an explicit config flag, or more than one person on the roster.
roster = read_json(ROSTER, [])
slugs = [r.get("slug") for r in roster if isinstance(r, dict) and r.get("slug")]
team_mode = bool(read_json(CONFIG, {}).get("teamMode")) or len(slugs) > 1


def sync_entry(rid, tmpl_e, schedule_src):
    """Add rid if missing (due from schedule_src's placeholder), else sync text."""
    cur = by_id.get(rid)
    if cur is None:
        e = dict(tmpl_e)
        e["id"] = rid
        e["due"] = compute_due(schedule_src.get("due"), now).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        e["created"] = now.strftime("%Y-%m-%dT%H:%M:%S.000Z")
        e["status"] = "pending"
        live.append(e)
        by_id[rid] = e
        added.append(rid)
    else:
        drift = [k for k in SYNC_FIELDS if k in tmpl_e and cur.get(k) != tmpl_e[k]]
        if drift:
            for k in drift:
                cur[k] = tmpl_e[k]
            updated.append(rid)


# 1) Static rituals. Skip the GENERIC plan trigger in team mode (per-user replaces it).
for t in rituals:
    rid = t.get("id")
    if not rid:
        continue
    if rid == PLAN_BASE_ID and team_mode:
        continue
    sync_entry(rid, t, t)

# 2) Per-user plan-day triggers.
base = next((t for t in rituals if t.get("id") == PLAN_BASE_ID), None)
if team_mode and slugs and base:
    desired = set()
    for slug in slugs:
        rid = f"{PLAN_BASE_ID}__{slug}"
        desired.add(rid)
        sync_entry(rid, per_user_tmpl(slug, base), base)
    # Prune per-user triggers for departed members + retire the generic one.
    for r in list(live):
        rid = r.get("id", "")
        if (rid.startswith(PLAN_BASE_ID + "__") and rid not in desired) or rid == PLAN_BASE_ID:
            live.remove(r)
            by_id.pop(rid, None)
            removed.append(rid)
else:
    # Solo / no roster: keep the generic; drop any stray per-user triggers.
    for r in list(live):
        rid = r.get("id", "")
        if rid.startswith(PLAN_BASE_ID + "__"):
            live.remove(r)
            by_id.pop(rid, None)
            removed.append(rid)

if not (added or updated or removed):
    print("[reconcile-reminders] all system rituals present and current")
    sys.exit(0)

# Take the advisory lock the reminder MCP and the monitor share, so this — the
# fourth writer of .reminders.json — cannot interleave with a fire/advance or an
# add. Normally this runs from the entrypoint before pm2 starts the monitor, so
# contention is unlikely; it costs nothing to be correct when it isn't, and an
# interleaved write here would leave unparseable JSON, after which the monitor
# exits zero on every tick forever and all scheduling stops silently.
#
# Fails OPEN like the other two holders (a crashed holder must never wedge boot),
# and the write stays an in-place O_TRUNC so owner/group/mode survive — writing
# through a temp file and renaming would hand the file to whoever runs this.
_lock = LIVE + ".lock" if isinstance(LIVE, str) else str(LIVE) + ".lock"
_held = False
_deadline = time.time() + 4.0
while True:
    try:
        os.close(os.open(_lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
        _held = True
        break
    except FileExistsError:
        try:
            if time.time() - os.stat(_lock).st_mtime > 30:
                os.unlink(_lock)
                continue
        except OSError:
            continue
        if time.time() >= _deadline:
            break
        time.sleep(0.04)
    except OSError:
        break

try:
    with open(LIVE, "w") as f:    # in-place O_TRUNC preserves owner/group/mode when it existed
        json.dump(live, f, indent=2)
        f.write("\n")
finally:
    if _held:
        try:
            os.unlink(_lock)
        except OSError:
            pass

if not existed:
    # brand-new file: match how the reminder-mcp owns it (bot:workspace 664)
    try:
        import pwd, grp
        os.chown(LIVE, pwd.getpwnam("bot").pw_uid, grp.getgrnam("workspace").gr_gid)
    except Exception:
        pass
    try:
        os.chmod(LIVE, 0o664)
    except Exception:
        pass

parts = []
if added:
    parts.append(f"added {len(added)}: {added}")
if updated:
    parts.append(f"synced text on {len(updated)}: {updated}")
if removed:
    parts.append(f"removed {len(removed)}: {removed}")
print("[reconcile-reminders] " + "; ".join(parts))
