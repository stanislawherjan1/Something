/**
 * Memory fed by integrations.
 *
 * A meeting note in a connected notetaker reached memory only when the person
 * discussed it in chat — and they rarely discussed all of it. Here an
 * integration's item becomes a ledger RECORD, the way a conversation does, in
 * the private scope of the person it is imported for: the notes pass
 * (lib/memory-router.js), the facts store and the nightly run then treat it
 * like any other record — one fact per thing, corrections as dated remarks,
 * what is no longer true struck through. No new writer of facts, no new
 * judgment in code; one more source of records.
 *
 * What feeds memory is declared in the integrations catalog (`memory: { kind,
 * default, what }`); which of a person's connected feeders are ON is their own
 * setting (memory/_engine/sources.json), shown on Memory → Sources and on the
 * integration's card. A notetaker is on by default once connected; anything
 * else is off until switched on.
 *
 * The fetch is code: each night, per person, workspace-api reads the service
 * itself as an MCP client (lib/integrations/mcp-client.js) through the
 * service's feeder (lib/memory-feeders/<id>.js: list since a time, get one
 * item) and files each new item — no model in the loop. A feeder without an
 * adapter yet falls back to a headless turn (lib/claude.js runHeadlessTurn:
 * only that service's MCP and the memory tools) that passes the service's
 * NOTES to memory_import verbatim, never a transcript: re-emitting a
 * transcript through a model took twenty minutes for one meeting. The window
 * overlaps the previous run by a day and the item id dedupes, so a skipped
 * item is caught next time and a repeat is harmless.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as ledger from './memory-ledger.js';
import * as facts from './memory-facts.js';
import * as router from './memory-router.js';
import { knownNames, knownKinds } from './memory-views.js';
import * as catalog from './integrations/catalog.js';
import { isUsable } from './integrations/store.js';
import { atomicWrite } from './atomic-write.js';
import { list as rosterList, primaryAdminSlug, getTeamMode, effectiveTimezone, getUser } from './team.js';
import { localClock } from './memory-maintenance.js';
import { withRemote } from './integrations/mcp-client.js';
import granola from './memory-feeders/granola.js';
import { fireflies, fathom, otter, readai, krisp } from './memory-feeders/generic.js';

/**
 * The services workspace-api reads itself. Granola's reader was checked
 * against the live server; the other five follow the tool names their docs
 * publish and fill arguments from the server's own schema — a service whose
 * answer they cannot read is read through a turn that night instead (notes
 * only), so a night is never lost to a changed API.
 */
export const FEEDERS = { granola, fireflies, fathom, otter, readai, krisp };

export const RUN_HOUR = Number(process.env.MEMORY_IMPORT_HOUR) || 2;   // at night, in the person's own zone — before the 04:00 tidy-up
const FIRST_DAYS = 2;               // a freshly switched-on source: the last two days, never its history
const OVERLAP_MS = 86400_000;       // each run re-asks for the last day of the previous one
const MAX_BACK_MS = 7 * 86400_000;  // a source that stood off for weeks does not pull a month
const CHUNK = 2400;                 // a transcript is filed in conversation-sized records
const MAX_TRANSCRIPT = 60_000;
const MAX_SUMMARY = 10_000;
export const SOURCE = 'integration';

function memoryDir() { return join(process.env.PROJECT_DIR || '/home/coder/project', 'memory'); }
function statePath() { return join(memoryDir(), '_engine', 'sources.json'); }
export function readState() { try { return JSON.parse(readFileSync(statePath(), 'utf8')); } catch { return { people: {} }; } }
function writeState(st) { mkdirSync(join(memoryDir(), '_engine'), { recursive: true }); atomicWrite(statePath(), JSON.stringify(st, null, 1)); }
function patchPerson(slug, id, patch) {
  const st = readState();
  st.people = st.people || {};
  st.people[slug] = st.people[slug] || {};
  st.people[slug][id] = { ...(st.people[slug][id] || {}), ...patch };
  writeState(st);
  return st.people[slug][id];
}

/** Catalog entries that can feed memory (connected or not). */
export function feeders() { return catalog.listAll().filter(e => e?.memory?.kind); }

/** One person's connected feeders with their switch and last run. */
export function listFor(slug) {
  const st = readState().people?.[slug] || {};
  return feeders().filter(e => isUsable(e.id)).map(e => {
    const s = st[e.id] || {};
    return {
      id: e.id, label: e.label, logo: e.logo || null, kind: e.memory.kind, what: e.memory.what || '',
      on: typeof s.on === 'boolean' ? s.on : e.memory.default === true,
      how: FEEDERS[e.id] ? 'code' : 'turn',
      lastRun: s.lastRun || null, lastItems: s.lastItems ?? null, lastFacts: s.lastFacts ?? null, lastError: s.lastError || null, cursor: s.cursor || null,
    };
  });
}

/** The feeders in the catalog the workspace has not connected — what could feed memory. */
export function available() {
  return feeders().filter(e => !isUsable(e.id)).map(e => ({ id: e.id, label: e.label, logo: e.logo || null, kind: e.memory.kind, what: e.memory.what || '' }));
}

export function setOn(slug, id, on) {
  const e = catalog.get(id);
  if (!e?.memory?.kind) throw new Error(`${id} cannot feed memory`);
  return patchPerson(slug, id, { on: !!on, ...(on ? { since: new Date().toISOString() } : {}) });
}

// ─── one item → records → facts ──────────────────────────────────────────────

/** Lines into chunks of at most `max` characters, never cutting a line. */
export function splitLines(text, max = CHUNK) {
  const out = [];
  let cur = '';
  for (const line of String(text).split('\n')) {
    const l = line.length > max ? line.slice(0, max) : line;
    if (cur && cur.length + l.length + 1 > max) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${l}` : l;
  }
  if (cur.trim()) out.push(cur);
  return out;
}


/** Done when the item's records are there and none still waits for its notes pass (an interrupted import resumes). */
export function alreadyImported(scope, integration, item) {
  const conv = `import:${integration}:${item}`;
  const recs = ledger.read({ scopes: [scope], includeHidden: true }).filter(r => r.conv === conv);
  return recs.length > 0 && !recs.some(r => r.tags?.import?.pending);
}

/**
 * File one item of an integration for a person: a record per part (the
 * service's notes, then the transcript in chunks), the notes pass on each, the
 * facts against what memory holds. Never shared, never a group. Returns what
 * happened, as memory_note does.
 */
export async function importItem({ actor, name = 'The person', integration, item, title = '', at = null, participants = [], participantsLine = null, url = null, summary = '', transcript = '' }) {
  const entry = catalog.get(String(integration || ''));
  if (!entry?.memory?.kind) return { ok: false, error: `${integration || '(none)'} is not a memory source` };
  if (!isUsable(entry.id)) return { ok: false, error: `${entry.label} is not connected` };
  const src = listFor(actor).find(s => s.id === entry.id);
  if (!src?.on) return { ok: false, error: `${entry.label} is switched off as a memory source for this person` };
  const key = String(item || '').trim().slice(0, 200);
  if (!key) return { ok: false, error: 'item required — the service\'s own id of the meeting' };
  const scope = `user:${actor}`;
  const conv = `import:${entry.id}:${key}`;
  if (alreadyImported(scope, entry.id, key)) return { ok: true, already: true };
  const ts = at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString();
  const people = (Array.isArray(participants) ? participants : []).map(p => String(p).trim()).filter(Boolean).slice(0, 30);
  // The service that recorded the meeting is the record's SOURCE (tags.import),
  // never a party: named in the text it was read as one ("Szymon of Granola").
  const heading = `Meeting: ${String(title || '').trim().slice(0, 200) || '(untitled)'}`;
  // The With: line keeps the addresses the app knew ("Kontakt <kontakt@example.test>"): the
  // model resolves a placeholder by its address against the known names; the tag keeps names.
  const line = (Array.isArray(participantsLine) && participantsLine.length ? participantsLine : people).map(p => String(p).trim()).filter(Boolean).slice(0, 30);
  const head = [heading, line.length ? `With: ${line.join(', ')}` : null].filter(Boolean).join('\n');
  const meta = { integration: entry.id, item: key, title: String(title || '').trim().slice(0, 200), at: ts, url: url ? String(url).slice(0, 500) : null, participants: people };

  // The records go in first, each marked pending until its notes pass has
  // run: an import stopped halfway resumes with what is left, and nothing is
  // filed twice. A rerun of a finished item answers "already".
  const existing = ledger.read({ scopes: [scope], includeHidden: true }).filter(r => r.conv === conv);
  let work = [];
  const out = { records: 0, titles: [], updated: [], superseded: [], dropped: 0, errors: [] };
  if (existing.length) {
    const pending = existing.filter(r => r.tags?.import?.pending && !r.hidden);
    if (!pending.length) return { ok: true, already: true };
    work = pending.map(r => ({ id: r.id, text: r.text, kind: r.tags.import.kind }));
    if (!people.length) people.push(...(pending[0].tags.import.participants || []));
  } else {
    const parts = [];
    const notes = String(summary || '').trim().slice(0, MAX_SUMMARY);
    if (notes) parts.push({ kind: 'notes', text: `${head}\nNotes:\n${notes}` });
    const chunks = splitLines(String(transcript || '').trim().slice(0, MAX_TRANSCRIPT));
    chunks.forEach((c, i) => parts.push({ kind: 'transcript', part: i + 1, of: chunks.length, text: `${head}\nTranscript${chunks.length > 1 ? ` (part ${i + 1} of ${chunks.length})` : ''}:\n${c}` }));
    if (!parts.length) return { ok: false, error: 'nothing to import: the item has neither notes nor a transcript' };
    for (const p of parts) {
      const r = await ledger.append({ scope, source: SOURCE, ts, conv, text: p.text, tags: { import: { ...meta, kind: p.kind, ...(p.part ? { part: p.part, of: p.of } : {}), pending: true } } });
      if (!r.ok) { out.errors.push(r.skipped === 'tombstoned' ? 'erased before — not learned again' : 'not written'); continue; }
      work.push({ id: r.id, text: p.text, kind: p.kind });
    }
  }
  if (!work.length) return { ok: false, error: out.errors.join('; ') || 'nothing written', ...out };

  // One meeting, one pass, one fact: the service's notes and the transcript
  // read together, the summary as the fact's description — twenty-six parts
  // read one by one once gave eleven facts from one hour, each meaningless
  // outside the call. The fact sits on the notes record (or the first part);
  // what is coming up (a dated follow-up, a deadline) is pinned to the part
  // that holds its words, so "See source" opens the right place.
  const known = knownNames([scope, 'shared']);
  const kinds = knownKinds([scope, 'shared']);
  const body = (w) => w.text.replace(/^[\s\S]*?\n(?:Notes|Transcript[^:\n]*):\n/, '');
  const notesRec = work.find(w => w.kind === 'notes');
  const parts = work.filter(w => w.kind === 'transcript');
  const whole = [head, notesRec ? `Notes:\n${body(notesRec)}` : null, parts.length ? `Transcript:\n${parts.map(body).join('\n')}` : null].filter(Boolean).join('\n');
  const got = new Map();            // record id → notes to file on it
  let m = null;
  // The meeting's day and time on the person's own clock (a 23:30 meeting is
  // not the next UTC day; a chat-made "call at 17:00" keys with it).
  const tz = effectiveTimezone(actor) || 'UTC';
  const local = (() => { try { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ts)).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; } catch { return ts.slice(0, 16); } })();
  try { m = await router.meeting({ name, ts, when: local, text: whole, participants: people, known, kinds, exclude: [entry.label, entry.id] }); } catch (e) { out.errors.push(`meeting: ${e.message}`); }
  if (m) {
    for (const w of work) got.set(w.id, { notes: [], entities: m.entities || [] });
    const home = notesRec || parts[0];
    got.get(home.id).notes.push({ ...m.fact, standing: notesRec ? 'found' : 'said' });
    for (const x of m.upcoming) {
      const at = parts.find(w => router.isVerbatim(x.evidence, body(w), 6) || router.isNearVerbatim(x.evidence, body(w))) || (notesRec && (router.isVerbatim(x.evidence, body(notesRec), 6) || router.isNearVerbatim(x.evidence, body(notesRec))) ? notesRec : null) || home;
      got.get(at.id).notes.push({ ...x, standing: at.kind === 'transcript' ? 'said' : 'found' });
    }
    out.dropped += m.dropped || 0;
  }
  // The facts, in the record's order, against what memory holds.
  for (const w of work) {
    const n = got.get(w.id);
    if (!n) continue;   // the pass failed: the records stay pending and are tried again next time
    out.records++;
    if (n.notes?.length) {
      const res = await facts.remember(scope, n.notes, { record: w.id, ts, entities: n.entities || [], by: SOURCE, standing: n.notes[0].standing, conv });
      out.titles.push(...res.titles);
      out.updated.push(...res.updated);
      out.superseded.push(...res.superseded);
    }
  }
  // Done: the names each record is about, and the pending mark off.
  await ledger.rewriteMeta(scope, (r) => {
    if (r.conv !== conv || !r.tags?.import?.pending || !got.has(r.id)) return null;
    const { pending: _p, ...imp } = r.tags.import;
    const ents = got.get(r.id)?.entities;
    return { tags: { ...r.tags, import: imp, ...(ents?.length ? { entities: ents } : {}) } };
  }, 'import-meta');
  if (out.records) {
    ledger.logEvent({ op: 'import', scope, by: actor, integration: entry.id, label: entry.label, item: key, title: meta.title, records: out.records, notes: out.titles.length, updated: out.updated.length, superseded: out.superseded.length, dropped: out.dropped });
  }
  return { ok: out.records > 0, ...(out.records ? {} : { error: out.errors.join('; ') || 'nothing written' }), ...out };
}

// ─── the night turn ──────────────────────────────────────────────────────────

/** Whose memory may be fed: the roster in team mode, the owner alone otherwise. */
export function people() {
  const all = getTeamMode() ? rosterList().map(u => u.slug) : [primaryAdminSlug()];
  return all.filter(s => s && s !== 'default');
}

/** The task for one person's night turn: which services, since when. */
/** The window one source is asked for: a day before its cursor, two days on a fresh one, a week at most. */
export function windowFor(s, now = Date.now()) {
  const since = s.cursor ? new Date(Math.max(Date.parse(s.cursor) - OVERLAP_MS, now - MAX_BACK_MS)) : new Date(now - FIRST_DAYS * 86400_000);
  return { since: since.toISOString(), until: new Date(now + 86400_000).toISOString() };
}

/** The task for the turn that reads the sources workspace-api has no feeder for: notes only, verbatim. */
export function taskFor(slug, { now = Date.now(), only = null, also = [] } = {}) {
  const sources = listFor(slug).filter(s => s.on && (s.how === 'turn' || also.includes(s.id)) && (!only || s.id === only));
  if (!sources.length) return null;
  const lines = sources.map(s => {
    const e = catalog.get(s.id);
    return { id: s.id, label: s.label, server: e?.mcp?.name || s.id, kind: s.kind, since: windowFor(s, now).since };
  });
  const message = [
    'Memory import — a system task; nobody reads this reply.',
    'For each service below, list its meetings that started since the time given, and pass EACH one to memory_import, once, exactly as the service gives it:',
    ...lines.map(l => `- ${l.label} (tools mcp__${l.server}__*): meetings since ${l.since}`),
    '',
    'memory_import takes: integration (its id, listed below), item (the service\'s own id of the meeting), title, at (start time, ISO 8601), participants (names), url if any, and summary (the service\'s notes or summary, whole). Pass the NOTES only — never fetch or pass a transcript.',
    `Integration ids: ${lines.map(l => `${l.label} = "${l.id}"`).join(', ')}.`,
    'Copy text exactly: do not summarise, shorten, translate or add anything. When memory_import answers "already imported", move on. Do nothing else — no other tools, no notes, no messages. Reply with one line: how many meetings you passed.',
  ].join('\n');
  return { message, servers: [...new Set(lines.map(l => l.server))], sources: lines };
}

/**
 * Read one source as the workspace and file what is new. Returns counts; an
 * item that fails is logged and skipped, the rest go on.
 */
export async function importFromService(slug, source, { now = Date.now(), log = () => {} } = {}) {
  const feeder = FEEDERS[source.id];
  if (!feeder) return { items: 0, skipped: 0, failed: 0, error: 'no feeder' };
  const u = getUser(slug);
  const name = u?.displayName || slug;
  const scope = `user:${slug}`;
  const w = windowFor(source, now);
  const out = { items: 0, skipped: 0, failed: 0, error: null };
  try {
    await withRemote(source.id, async (client) => {
      const list = await feeder.list(client, w);
      log(`${source.id}: ${list.length} item(s) since ${w.since.slice(0, 16)}`);
      for (const it of list) {
        if (alreadyImported(scope, source.id, it.id)) { out.skipped++; continue; }
        try {
          const full = await feeder.get(client, it.id);
          const r = await importItem({ actor: slug, name, integration: source.id, item: it.id, title: full.title || it.title, at: full.at || it.at, participants: full.participants?.length ? full.participants : it.participants, participantsLine: full.participantsLine?.length ? full.participantsLine : it.participantsLine, url: full.url || it.url, summary: full.summary, transcript: full.transcript });
          if (r.ok && !r.already) { out.items++; log(`${source.id}: ${it.id} → ${r.records} record(s), ${r.titles.length} fact(s)${r.errors?.length ? `; ${r.errors.length} part(s) left pending: ${[...new Set(r.errors)].join('; ').slice(0, 200)}` : ''}`); }
          else if (r.already) out.skipped++;
          else { out.failed++; log(`${source.id}: ${it.id} refused: ${r.error}`); }
        } catch (e) { out.failed++; log(`${source.id}: ${it.id} failed: ${e.message}`); }
      }
    });
  } catch (e) { out.error = e.message; log(`${source.id}: ${e.message}`); }
  return out;
}

const running = new Set();

/**
 * Run one person's import turn now. `runTurn({ message, actor, actorName,
 * servers })` is the headless turn (lib/claude.js by default; a stand-in in
 * tests). The outcome is read from the import events the turn left.
 */
export async function runFor(slug, { now = Date.now(), only = null, runTurn = null, log = (m) => process.stdout.write(`[memory-v4/imports] ${slug}: ${m}\n`) } = {}) {
  if (running.has(slug)) return { skipped: 'running' };
  const sources = listFor(slug).filter(s => s.on && (!only || s.id === only));
  if (!sources.length) return { skipped: 'no sources on' };
  running.add(slug);
  const startedAt = new Date().toISOString();   // the wall clock: the events are stamped by it, whatever `now` says
  const u = getUser(slug);
  const errors = {};
  try {
    // The services workspace-api reads itself, one after another. One it
    // could not read (its answer changed, a tool was renamed) goes to the
    // turn below for this night, notes only.
    const fallback = [];
    for (const s of sources.filter(x => x.how === 'code')) {
      const r = await importFromService(slug, s, { now, log });
      if (r.error) { fallback.push(s.id); errors[s.id] = r.error; log(`${s.id}: read by code failed (${r.error}); its notes are read through the assistant tonight`); }
    }
    // The rest through one turn, notes only.
    const task = taskFor(slug, { now, only, also: fallback });
    if (task) {
      const turn = runTurn || (async (o) => (await import('./claude.js')).runHeadlessTurn({ ...o, label: 'imports' }));
      try {
        await turn({ message: task.message, actor: slug, actorName: u?.displayName || slug, servers: task.servers });
        for (const s of task.sources) delete errors[s.id];   // read after all, through the turn
      } catch (e) { for (const s of task.sources) errors[s.id] = errors[s.id] ? `${errors[s.id]}; ${e.message}` : e.message; }
    }
    const events = ledger.readEvents({ since: startedAt }).filter(e => e.op === 'import' && e.by === slug);
    const out = { at: new Date().toISOString(), items: 0, facts: 0, error: Object.keys(errors).length ? Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join('; ') : null };
    for (const s of sources) {
      const mine = events.filter(e => e.integration === s.id);
      const newest = mine.map(e => ledger.read({ scopes: [`user:${slug}`], includeHidden: true }).find(r => r.conv === `import:${s.id}:${e.item}`)?.ts).filter(Boolean).sort().pop();
      const prev = readState().people?.[slug]?.[s.id] || {};
      patchPerson(slug, s.id, {
        lastRun: out.at, lastItems: mine.length, lastFacts: mine.reduce((a, e) => a + (e.notes || 0), 0), lastError: errors[s.id] || null,
        cursor: newest && (!prev.cursor || newest > prev.cursor) ? newest : prev.cursor || null,
      });
      out.items += mine.length;
      out.facts += mine.reduce((a, e) => a + (e.notes || 0), 0);
    }
    const st = readState();
    st.runs = [...(st.runs || []), { slug, ...out, sources: sources.map(s => s.id) }].slice(-60);
    if (!only) { st.days = st.days || {}; st.days[slug] = localClock(now, effectiveTimezone(slug)).day; }
    writeState(st);
    return out;
  } finally { running.delete(slug); }
}

/** People whose night hour has come and whose turn has not run today. */
export function dueNow(now = Date.now()) {
  const st = readState();
  return people().filter(slug => {
    if (!listFor(slug).some(s => s.on)) return false;
    const clock = localClock(now, effectiveTimezone(slug));
    return clock.hour >= RUN_HOUR && st.days?.[slug] !== clock.day;
  });
}

let timer = null;
/** Check every 10 minutes; one turn per person per local day after RUN_HOUR, one at a time. */
export function startImports() {
  if (timer || ledger.v4Mode() === 'off') return false;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const slug of dueNow()) {
        const r = await runFor(slug);
        process.stdout.write(`[memory-v4/imports] ${slug}: ${JSON.stringify(r)}\n`);
      }
    } finally { busy = false; }
  };
  timer = setInterval(() => { tick().catch(e => process.stderr.write(`[memory-v4/imports] ${e.message}\n`)); }, 10 * 60_000);
  timer.unref?.();
  return true;
}
