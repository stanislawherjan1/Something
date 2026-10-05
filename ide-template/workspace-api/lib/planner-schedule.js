/**
 * Keep a person's morning planning at 06:00 in THEIR time zone.
 *
 * The plan-day trigger (`r_system_plan_day`, or `r_system_plan_day__<slug>` in
 * team mode — bootstrap/reconcile-reminders.py) gets its first time when it is
 * created and then repeats daily. When the person's zone changes (Settings, or
 * the bot noticing they travelled), the next run moves to 06:00 local there.
 *
 * Writes .reminders.json under the same advisory lock the reminder MCP, the
 * monitor and the reminders route use, reading and writing inside one hold.
 */
import { readFileSync, writeFileSync, renameSync, openSync, closeSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getTeamMode, primaryAdminSlug, effectiveTimezone, list as teamList } from './team.js';

const FILE = () => join(process.env.PROJECT_DIR || '/home/coder/project', '.reminders.json');
const PLAN_BASE_ID = 'r_system_plan_day';
export const PLAN_HOUR = 6;

function withLock(fn) {
  const lock = FILE() + '.lock';
  const deadline = Date.now() + 4000;
  let held = false;
  for (;;) {
    try { closeSync(openSync(lock, 'wx')); held = true; break; }
    catch (err) {
      if (err.code !== 'EEXIST') break;
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) { unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() >= deadline) break;   // fail open, like the other writers
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    }
  }
  try { return fn(); } finally { if (held) { try { unlinkSync(lock); } catch { /* gone */ } } }
}

/** Minutes the zone is ahead of UTC at `date`. */
function offsetMinutes(tz, date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** The next `hour`:00 local in `tz`, after `now`, as a Date (DST-safe). */
export function nextLocalHour(tz, hour = PLAN_HOUR, now = new Date()) {
  const local = new Date(now.getTime() + offsetMinutes(tz, now) * 60000);   // wall clock, as if UTC
  let target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, 0, 0);
  if (target <= local.getTime()) target += 24 * 3600 * 1000;
  // Back to a real instant: subtract the offset that applies at the target.
  let at = target - offsetMinutes(tz, new Date(target)) * 60000;
  at = target - offsetMinutes(tz, new Date(at)) * 60000;   // second pass settles a DST edge
  return new Date(at);
}

/** Which plan-day row belongs to this person (null: none of theirs exists). */
export function planIdFor(slug) {
  if (getTeamMode()) return `${PLAN_BASE_ID}__${slug}`;
  return slug === primaryAdminSlug() ? PLAN_BASE_ID : null;
}

/** Move this person's next morning planning to 06:00 in their zone. Returns the new due or null. */
export function reschedulePlanFor(slug, now = new Date()) {
  const id = planIdFor(slug);
  if (!id) return null;
  const tz = effectiveTimezone(slug);
  const due = nextLocalHour(tz, PLAN_HOUR, now).toISOString();
  return withLock(() => {
    let list;
    try { list = JSON.parse(readFileSync(FILE(), 'utf8')); } catch { return null; }
    if (!Array.isArray(list)) return null;
    const row = list.find(r => r && r.id === id);
    if (!row) return null;
    if (row.due === due) return due;
    // A due already passed is about to fire — moving it would skip today's run.
    const cur = Date.parse(row.due);
    if (Number.isFinite(cur) && cur <= now.getTime()) return null;
    row.due = due;
    const tmp = `${FILE()}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(list, null, 2));
    renameSync(tmp, FILE());
    return due;
  });
}

/**
 * Keep every planner on 06:00 local. The reminder monitor re-arms a daily row
 * by +24 h in UTC, which slips an hour across a DST change; this pulls it back.
 * Idempotent — a row already on time is left alone.
 */
export function realignAllPlans(now = new Date()) {
  for (const m of teamList()) { try { reschedulePlanFor(m.slug, now); } catch { /* next pass */ } }
}
