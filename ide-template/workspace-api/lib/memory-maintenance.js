/**
 * memory-maintenance — memory v4's nightly jobs, scheduled inside workspace-api.
 *
 * Each step is idempotent and plain code except the digest
 * (both views/derived, never destructive). One run per local day, after 04:00
 * (IDE_TIMEZONE); a failed step is logged loudly and the others still run.
 *   1. purge  — erase records hidden longer than 30 days (a redaction, tombstoned),
 *               and migration backups older than 30 days
 *   2. check  — every ledger line parses; torn lines are counted, never "fixed"
 *   4. digest — "what is going on" per person, group and the team
 *   5. profiles — one line per topic (who/what it is), per viewer
 * The run log (memory/_engine/maintenance.json) is what the Changes tab shows.
 */
import { readdirSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import * as ledger from './memory-ledger.js';
import { titleUntitled, narrowNames } from './memory-titles.js';
import { mergeLookalikes } from './memory-aliases.js';
import * as facts from './memory-facts.js';
import { check as checkInvariants } from './memory-invariants.js';
import { updateDigest, updateProfiles } from './memory-views.js';
import { atomicWrite } from './atomic-write.js';
import { pruneBackups } from './migrate.js';
import { list as rosterList, listGroups, memberGroupsOf } from './team.js';

const RUN_HOUR = Number(process.env.MEMORY_V4_MAINTENANCE_HOUR) || 4;
const TZ = process.env.IDE_TIMEZONE || 'UTC';

function memoryDir() { return join(process.env.PROJECT_DIR || '/home/coder/project', 'memory'); }
function statePath() { return join(memoryDir(), '_engine', 'maintenance.json'); }
export function readState() { try { return JSON.parse(readFileSync(statePath(), 'utf8')); } catch { return { lastDay: null, runs: [] }; } }
function writeState(st) { mkdirSync(join(memoryDir(), '_engine'), { recursive: true }); atomicWrite(statePath(), JSON.stringify(st, null, 1)); }

/** Local date + hour in the deployment's timezone. */
export function localClock(at = Date.now(), tz = TZ) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(at)).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Ledger lines that do not parse, per scope (torn writes, hand edits). */
export function integrity() {
  const out = {};
  for (const scope of ledger.allScopes()) {
    let dir; try { dir = ledger.scopeDir(scope); } catch { continue; }
    let bad = 0, lines = 0;
    for (const f of readdirSync(dir).filter(n => /^\d{4}-\d{2}\.jsonl$/.test(n))) {
      for (const l of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (!l) continue;
        lines++;
        try { JSON.parse(l); } catch { bad++; }
      }
    }
    out[scope] = { lines, bad };
  }
  return out;
}

/**
 * A `memory/users/<slug>` tree whose slug is not on the roster belongs to
 * nobody the product knows: a removed member, a test account, or — from the
 * old memory — a group member who was never a user and got a private tree
 * anyway. Nobody can read it, the bot sees it in a listing and narrates it.
 * Archived to the migrations store (kept with the backups, 30 days) and
 * removed; the event is logged. Never the roster's own trees.
 */
export function archiveOrphanUsers({ now = Date.now() } = {}) {
  const usersDir = join(memoryDir(), 'users');
  if (!existsSync(usersDir)) return [];
  const roster = new Set(rosterList().map(u => u.slug).filter(Boolean));
  const orphans = readdirSync(usersDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^[a-z0-9-]+$/.test(e.name) && !roster.has(e.name)).map(e => e.name);
  if (!orphans.length) return [];
  const store = join(process.env.WSAPI_STORE_DIR || '/var/wsapi-store', 'migrations');
  mkdirSync(store, { recursive: true });
  const archive = join(store, `orphan-users-${new Date(now).toISOString().replace(/[:.]/g, '-')}.tar.gz`);
  execFileSync('tar', ['czf', archive, '-C', usersDir, ...orphans], { stdio: 'ignore' });
  for (const slug of orphans) rmSync(join(usersDir, slug), { recursive: true, force: true });
  ledger.logEvent({ op: 'archive_orphans', scope: 'shared', by: 'maintenance', slugs: orphans, archive });
  return orphans;
}

/** The people and groups a night's digests cover. */
function targets() {
  const people = rosterList().map(u => u.slug).filter(s => s && s !== 'default' && /^[a-z0-9-]+$/.test(s));
  const groups = listGroups().map(g => String(g.chatId)).filter(g => /^-\d{4,20}$/.test(g));
  return { people, groups };
}

/** One full run. Never throws; returns the run record. */
export async function runNightly({ at = Date.now() } = {}) {
  const run = { at: new Date(at).toISOString(), steps: {}, errors: [] };
  const step = async (name, fn) => {
    try { run.steps[name] = await fn(); } catch (e) { run.errors.push(`${name}: ${e.message}`); }
  };
  const { people, groups } = targets();
  const yesterday = utcDay(at - 86400_000);

  await step('purge', async () => ({ records: await ledger.purgeHidden(ledger.allScopes(), { now: at }), facts: await facts.purgeHidden(ledger.allScopes(), { now: at }) }));
  await step('backups', () => pruneBackups({ now: at }));
  await step('orphans', () => archiveOrphanUsers({ now: at }));
  await step('integrity', () => {
    const r = integrity();
    const torn = Object.entries(r).filter(([, v]) => v.bad);
    if (torn.length) run.errors.push(`integrity: unparseable lines in ${torn.map(([s, v]) => `${s} (${v.bad})`).join(', ')}`);
    return Object.fromEntries(Object.entries(r).map(([s, v]) => [s, v.lines]));
  });

  // Notes that arrived without a title (memory_note, older migrations, a failed
  // call) get one here, so the title + description format holds ledger-wide
  // whatever path wrote the note. Capped per night; the rest follow tomorrow.
  await step('titles', () => titleUntitled(ledger.allScopes(), { cap: 60, log: (m) => run.errors.push(m) }));
  await step('names', () => narrowNames(ledger.allScopes(), { log: (m) => run.errors.push(m) }));

  // The backlog of duplicates folds the same way a new note would, a few model
  // decisions per night — so a freshly migrated client cleans itself up over a
  // handful of nights with no operator ceremony (bin/dedupe-notes.mjs stays as
  // the manual lever, with its dry-run report).
  await step('reconcile', async () => {
    const out = {};
    let budget = 15;
    for (const scope of ledger.allScopes()) {
      if (budget <= 0) break;
      const r = await facts.dedupeBacklog(scope, { capDecisions: budget });
      budget -= r.decisions;
      if (r.same || r.replaced) out[scope] = r;
    }
    return out;
  });


  // What must hold in memory, checked on the real data (lib/memory-invariants.js):
  // read-only; each violation goes to the run's errors, so it is seen.
  await step('invariants', () => {
    const v = checkInvariants();
    for (const x of v.slice(0, 20)) run.errors.push(`invariant ${x.kind}: ${x.scope} "${x.title}" — ${x.why}`);
    return { violations: v.length, byKind: v.reduce((a, x) => ({ ...a, [x.kind]: (a[x.kind] || 0) + 1 }), {}) };
  });
  await step('digest', async () => {
    const out = {};
    const jobs = [
      ...people.map(p => [`user:${p}`, ledger.readableScopes({ actor: p, memberGroups: memberGroupsOf(p) })]),
      ...groups.map(g => [`group:${g}`, ['shared', `group:${g}`]]),
      ['shared', ['shared']],
    ];
    for (const [key, scopes] of jobs) {
      try { out[key] = (await updateDigest(key, scopes, { at })).items.length; } catch (e) { run.errors.push(`digest ${key}: ${e.message}`); }
    }
    return out;
  });
  // Two spellings of one thing become one tile — the model's call, per viewer.
  await step('aliases', async () => {
    const out = {};
    for (const p of people) {
      const scopes = ledger.readableScopes({ actor: p, memberGroups: memberGroupsOf(p) });
      try { out[`user:${p}`] = (await mergeLookalikes(`user:${p}`, scopes, { log: (m) => run.errors.push(m) })).merged.length; } catch (e) { run.errors.push(`aliases ${p}: ${e.message}`); }
    }
    return out;
  });
  // Who each topic is, per viewer — only topics with new records since their line.
  await step('profiles', async () => {
    const out = {};
    const jobs = [
      ...people.map(p => [`user:${p}`, ledger.readableScopes({ actor: p, memberGroups: memberGroupsOf(p) })]),
      ...groups.map(g => [`group:${g}`, ['shared', `group:${g}`]]),
    ];
    for (const [key, scopes] of jobs) {
      try { out[key] = await updateProfiles(key, scopes, { at }); } catch (e) { run.errors.push(`profiles ${key}: ${e.message}`); }
    }
    return out;
  });

  for (const e of run.errors) process.stderr.write(`[memory-v4/maintenance] ${e}\n`);
  return run;
}

let timer = null;
let running = false;

/** Check every 10 minutes; run once per local day after RUN_HOUR. */
export function startMaintenance() {
  if (timer || ledger.v4Mode() === 'off') return false;
  const tick = async () => {
    if (running) return;
    const clock = localClock();
    const st = readState();
    if (clock.hour < RUN_HOUR || st.lastDay === clock.day) return;
    running = true;
    try {
      const run = await runNightly();
      writeState({ lastDay: clock.day, runs: [...(st.runs || []), run].slice(-30) });
    } finally { running = false; }
  };
  timer = setInterval(() => { tick().catch(e => process.stderr.write(`[memory-v4/maintenance] ${e.message}\n`)); }, 10 * 60_000);
  timer.unref?.();
  return true;
}
