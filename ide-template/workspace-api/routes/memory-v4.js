/**
 * Memory v4 routes.
 *
 * Tool side (/internal/memory/v4/*, loopback + turn token): what memory_search,
 * memory_timeline, memory_note and memory_forget do. Identity — who is asking,
 * and whether it is a group turn and which group — comes from the turn token
 * (lib/turn-identity.js), never from the model's arguments or a bare header:
 *   a person's turn  → reads their own scope, shared, and their groups;
 *                      writes their own scope, or shared when asked to share;
 *   a group turn     → reads shared + that group; writes that group only;
 *                      cannot hide anything (the whole group talks to it).
 * There is no admin bypass: privacy is by path, never by role.
 */
import { readFor, isUserScope } from '../lib/tasks.js';
import { attachTasks, factsByRecord } from '../lib/memory-task-links.js';
import { attachFiles, filesOfFact } from '../lib/memory-file-links.js';
import { avatarUrl } from '../lib/user-avatars.js';
import { Router } from 'express';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ledger from '../lib/memory-ledger.js';
import * as views from '../lib/memory-views.js';
import { search, timeline , tokens, near } from '../lib/memory-search.js';
import { renderResults } from '../lib/memory-recall.js';
import { listAsks, resolveAsk, listRules, clearRule, mentionedAt } from '../lib/memory-asks.js';
import { setSharing } from '../lib/team.js';
import { modeOf as sharingModeOf, concernsAPerson } from '../lib/memory-sharing.js';
import { readRoutines, writeRoutines } from '../lib/routines-store.js';
import { routinesOwner } from '../lib/memory-v4-writes.js';
import * as routinesCatalog from '../lib/routines-catalog.js';
import { addFromCatalog, flushWaiting, waitingView, dropWaiting, usableFor } from '../lib/routines-add.js';
import { plannerFeedback } from '../lib/planner-feedback.js';
import { remember as engineRemember, retire as engineRetire } from '../lib/memory-engine.js';
import { resolveTurnToken } from '../lib/turn-identity.js';
import { resolve as resolveBranding } from '../lib/branding.js';
import { requireActor } from '../lib/auth.js';
import { goingOnCard, settingsCard, routinesCard } from '../lib/claude.js';
import * as facts from '../lib/memory-facts.js';
import * as sources from '../lib/memory-sources.js';
import * as integrationsCatalog from '../lib/integrations/catalog.js';
import { unsupportedDetails, splitNote } from '../lib/memory-router.js';
import { routeSaid, gateFacts } from '../lib/memory-regate.js';
import { primaryAdminSlug, memberGroupsOf, list as rosterList, getUser, getTeamMode } from '../lib/team.js';
import { getGroup } from '../lib/team.js';
import { groupIdKind } from '../lib/group-id.js';
import { lookupMine, outsidersOf, memberBySlug, takePrefetched, askMyConnections } from '../lib/integrations/private-lookup.js';

function loopbackOnly(req, res, next) {
  const ip = req.socket?.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  return res.status(403).json({ error: 'loopback only' });
}

const SLUG_RE = /^[a-z0-9-]+$/;

/**
 * The turn behind a tool call, as scopes. A turn with no person on it (the
 * operator's own brain, a solo deployment) is the primary admin.
 */
function whoIsAsking(req) {
  const turn = resolveTurnToken(req.get('x-ide-turn'), req.get('x-ide-actor'));
  if (!turn) return null;
  if (turn.group) {
    return {
      group: true, groupId: turn.groupId, actor: turn.actor,
      read: ledger.readableScopes({ groupId: turn.groupId, groupOnly: !!turn.groupOnly }),
      write: turn.groupId ? `group:${turn.groupId}` : null,
    };
  }
  const actor = turn.actor || primaryAdminSlug();
  if (!SLUG_RE.test(actor || '') || actor === 'default') return null;
  return { group: false, actor, read: ledger.readableScopes({ actor, memberGroups: memberGroupsOf(actor) }), write: `user:${actor}` };
}

/**
 * Add a Marketplace routine to a person's list — the same for the Add button
 * and the bot's add_routine tool. Idempotent; 409 until its integration is on.
 */
/** Share of a note's content words (3+ letters) that appear in what the person said. */
function wordsFrom(text, said) {
  const words = (t) => (String(t).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) || []);
  const have = new Set(words(said));
  const mine = words(text);
  return mine.length ? mine.filter((w) => have.has(w)).length / mine.length : 0;
}

function nameOf(slug) {
  try { return rosterList().find(u => u.slug === slug)?.displayName || slug; } catch { return slug; }
}

/** A window of `text` around the first word of `term`, for timeline output. */
function around(text, term, width = 700) {
  const words = String(term).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const low = text.toLowerCase();
  const i = words.length ? low.indexOf(words[0]) : -1;
  if (text.length <= width || i < 0) return text.slice(0, width);
  const start = Math.max(0, i - width / 2);
  return `${start > 0 ? '… ' : ''}${text.slice(start, start + width)}${start + width < text.length ? ' …' : ''}`;
}

// ─── UI side: the signed-in person's own view ─────────────────────────────────

/** The signed-in person as scopes. Solo: the one person is the primary admin. */
function viewer(req) {
  if (!req.actor) return null;
  const u = getUser(req.actor);
  const slug = u?.slug || (getTeamMode() ? null : primaryAdminSlug());
  if (!slug || slug === 'default' || !SLUG_RE.test(slug)) return null;
  const groups = memberGroupsOf(slug);
  return { slug, own: `user:${slug}`, groups, read: ledger.readableScopes({ actor: slug, memberGroups: groups }), isAdmin: u?.role === 'admin', displayName: u?.displayName || null };
}

function withViewer(handler) {
  return async (req, res) => {
    const v = viewer(req);
    if (!v) return res.status(403).json({ ok: false, error: 'not on this workspace\'s team' });
    res.set('Cache-Control', 'no-store');
    try { return await handler(req, res, v); } catch (err) {
      process.stderr.write(`[memory-v4] ${req.method} ${req.path}: ${err.stack || err}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  };
}

const whereOf = (scope) => (scope === 'shared' ? 'shared' : scope.startsWith('group:') ? 'group' : 'private');

/**
 * Who may hide or erase a record: its owner (their own scope, or what they
 * shared themselves), and an admin for what the team holds in common — shared
 * and group records. After the move most shared records have no author at all,
 * and nobody could take them down. Private records stay their owner's: that is
 * a path, never a role — an admin cannot read them, let alone hide them.
 */
const isOwned = (v, r) => r.scope === v.own || r.origin === v.own;
/** The facts a record gave rise to, still on the screen. */
function factsOf(r) { try { return r ? facts.forRecord(r.scope, r.id) : []; } catch { return []; } }
function canManage(v, r) { return isOwned(v, r) || (v.isAdmin && !String(r.scope).startsWith('user:')); }
function ownedRecord(v, id) {
  const rec = ledger.get(String(id), v.read);
  return rec && canManage(v, rec) ? rec : null;
}

/**
 * A record shown as one line when it has no note: what the people in it said,
 * never the assistant's reply — that is the memory, the reply is context.
 */
/** Who can open a line of a record: the people on the roster and the assistant. */
function speakersOf(rec) {
  let bot = 'Assistant';
  try { bot = resolveBranding().botName || bot; } catch { /* the default */ }
  const names = new Set(['Assistant', bot, 'Someone', 'the team']);
  if (rec?.speaker) names.add(rec.speaker);
  try { for (const u of rosterList()) if (u.displayName) names.add(u.displayName); } catch { /* no roster */ }
  return names;
}
function spokenExcerpt(text, max = 220) {
  let bot = 'Assistant';
  try { bot = resolveBranding().botName || bot; } catch { /* the default */ }
  const said = messagesOf(text, speakersOf(null)).filter(m => m.who && m.who !== bot && m.who !== 'Assistant').map(m => m.text).join(' ').replace(/\s+/g, ' ').trim();
  const s = said || String(text).replace(/\s+/g, ' ').trim();
  return `${s.slice(0, max)}${s.length > max ? '…' : ''}`;
}

/**
 * "Name: text" lines → [{ who, text }]; a line without a label continues the
 * one before. Only a real speaker opens a line: a bullet in a reply ("- On the
 * table: role, pay, location") read as a speaker called "- On the table" and
 * split the reply in two on the screen.
 */
function messagesOf(text, speakers = null) {
  const out = [];
  // A known name, or one shaped like a name: one to three words, opening with a
  // letter (a group's members are not all on the roster).
  const isSpeaker = (who) => { const w = who.replace(/\s*\(after checking\)$/, ''); return !speakers || speakers.has(w) || /^\p{L}[\p{L}'’.-]*( \p{L}[\p{L}'’.-]*){0,2}$/u.test(w); };
  for (const line of String(text).split('\n')) {
    const m = line.match(/^([^:\n]{1,40}):\s(.*)$/);
    if (m && isSpeaker(m[1])) out.push({ who: m[1], text: m[2] });
    else if (out.length) out[out.length - 1].text += `\n${line}`;
    else out.push({ who: '', text: line });
  }
  return out;
}

function cardPath(slug, file) {
  const base = join(process.env.PROJECT_DIR || '/home/coder/project', 'memory');
  return getTeamMode() ? join(base, 'users', slug, file) : join(base, file);
}
/** Bullet lines of a card, without their [Source: …] tails. */
function cardLines(path) {
  let raw = '', kb = 0;
  try { raw = readFileSync(path, 'utf8'); kb = Math.round(statSync(path).size / 102.4) / 10; } catch { /* no card */ }
  const body = raw.replace(/^---[\s\S]*?\n---\n/, '').replace(/<!--[\s\S]*?-->/g, '');
  const lines = body.split('\n').filter(l => /^\s*[-*]\s+\S/.test(l)).map(l => l.replace(/^\s*[-*]\s+/, '').replace(/\s*\[Source:[^\]]*\]\s*$/i, '').trim()).filter(Boolean);
  return { lines, kb };
}

// Writes from the Memory screen: generous for a person clicking through, a stop
// for anything looping.
const screenWrites = new Map();
function writeLimit(req, res, next) {
  const who = req.actor || req.ip || 'anon';
  const now = Date.now();
  const recent = (screenWrites.get(who) || []).filter(t => now - t < 60_000);
  if (recent.length >= 120) return res.status(429).json({ ok: false, error: 'Too many changes at once — try again in a minute.' });
  recent.push(now); screenWrites.set(who, recent);
  return next();
}

export default function memoryV4Router() {
  const router = Router();
  // Every screen write (not the bot's /internal routes) passes the limiter.
  router.use((req, res, next) => (req.method === 'POST' && req.path.startsWith('/memory/v4/') ? writeLimit(req, res, next) : next()));

  // What is going on: right now + the digest.
  router.get('/memory/v4/overview', requireActor, withViewer((req, res, v) => res.json({
    ok: true, mode: ledger.v4Mode(), now: views.now(v.read), digest: views.readDigest(v.own, v.read),
  })));

  // Facts: every note and review item the person can read, newest first.
  router.get('/memory/v4/facts', requireActor, withViewer((req, res, v) => {
    const want = ['shared', 'private', 'group'].includes(req.query.scope) ? req.query.scope : 'all';
    const history = req.query.history === '1';
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const before = typeof req.query.before === 'string' ? req.query.before : null;
    const today = new Date().toISOString().slice(0, 10);
    // A fact about something that has ended is history, like an expired
    // status: the digest says which topics are closed and since when, and a
    // note whose topics are all closed folds under "Past" — except the closing
    // fact itself and anything after it. Without this, a dead project's every
    // detail from months ago reads as current.
    const closed = new Map(views.readDigest(v.own, v.read).items.filter(i => i.state === 'closed').map(i => [views.nameKey(i.name), i.date]));
    const closedSince = (r) => {
      const names = (r.tags?.entities || []).map(e => views.nameKey(typeof e === 'string' ? e : e?.name));
      if (!names.length || !names.every(k => closed.has(k))) return null;
      return names.map(k => closed.get(k)).sort().pop();
    };
    const items = factItems(v, { history, want, closedSince, today });
    items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    const page = (before ? items.filter(x => x.ts < before) : items).slice(0, limit);
    return res.json({ ok: true, total: items.length, items: page });
  }));

  /**
   * Every fact a viewer may see, as the screen shows it: replaced ones are
   * history ("Past"), hidden ones are off the screen, one whose every
   * conversation is hidden goes with them (lib/memory-facts.js).
   */
  function factItems(v, { history = false, want = 'all', closedSince = () => null, today = new Date().toISOString().slice(0, 10) } = {}) {
    const recs = new Map(ledger.read({ scopes: v.read }).map(r => [r.id, r]));
    const items = [];
    const all = facts.visible(v.read, { history: true });
    // The board, for the facts that point at a task: its live title and state,
    // from the lists this viewer may read (the team board and their own). A
    // task that is gone leaves no pill behind; so does someone else's own task
    // behind a shared fact — it is not this viewer's to see.
    let board = null;
    const lists = (v.read || []).filter(s => s === 'shared' || isUserScope(s));
    const taskOf = (f) => {
      if (!f.task?.id) return null;
      if (!lists.includes(f.task.scope || 'shared')) return null;
      if (!board) { try { board = new Map(readFor(lists).map(t => [t.id, t])); } catch { board = new Map(); } }
      const t = board.get(f.task.id);
      if (!t) return null;
      // As the board shows it: who, by when, how urgent.
      const person = t.owner && getTeamMode() ? rosterList().find(m => m.slug === t.owner) : null;
      return { id: t.id, title: t.title, status: t.status, deadline: t.deadline || null, priority: t.priority || null,
        owner: t.owner || null, ownerName: person ? (person.displayName || person.slug) : (t.owner || null), ownerAvatar: person ? (avatarUrl(person.slug) || null) : null };
    };
    const byId = new Map(all.map(f => [f.id, f]));
    // The versions a current fact replaced, oldest first — its own timeline.
    const prev = new Map();
    for (const f of all) if (f.replacedBy) (prev.get(f.replacedBy) || prev.set(f.replacedBy, []).get(f.replacedBy)).push(f);
    const chain = (f) => {
      const out = [];
      let cur = f;
      for (let i = 0; i < 10 && cur; i++) {
        const older = (prev.get(cur.id) || []).sort((a, b) => (a.ts < b.ts ? -1 : 1))[0];
        if (!older) break;
        out.unshift({ id: older.id, ts: older.at || older.ts, until: older.replacedAt || null, title: older.title || null, text: older.text, updates: (older.updates || []).map(u => ({ ts: u.ts, text: u.text })), why: older.replacedWhy || 'replaced' });
        cur = older;
      }
      return out;
    };
    for (const f of all) {
      const where = whereOf(f.scope);
      if (want !== 'all' && where !== want) continue;
      const r = recs.get(f.record) || { id: f.record, scope: f.scope, ts: f.ts, source: f.by || 'note', tags: { entities: f.entities || [] } };
      // A person's digest says what has ended in THEIR memory: it folds their own
      // facts, never the team's — a shared fact reads the same to everyone (one
      // person's closed topic once hid shared facts from them alone). In solo the
      // shared memory is the one person's own.
      const mine = f.scope === v.own || (f.scope === 'shared' && !getTeamMode());
      const ended = mine ? closedSince({ tags: { entities: f.entities || r.tags?.entities || [] } }) : null;
      const expired = f.kind === 'status' && f.expires && f.expires < today;
      const sup = !!f.replacedBy || !!f.retired;
      const past = expired || sup || (ended && f.ts.slice(0, 10) < ended);
      if (past && !history) continue;
      items.push({
        id: f.id, recordId: f.record || null,
        // The Facts list is dated by when memory learned the fact (a meeting
        // read at night sits under that night); `said` is the conversation's time.
        ts: f.at || f.ts, said: f.ts, title: f.title || null, text: f.text, kind: f.kind || 'fact', importance: f.importance || null,
        expires: f.expires || null, past: !!past, superseded: sup ? (f.replacedAt || f.retired) : null, sources: f.sources.length || 1,
        supersededBy: f.replacedBy || null, supersededWhy: f.replacedWhy || f.retiredWhy || null, supersededByTitle: f.replacedBy ? (byId.get(f.replacedBy)?.title || null) : null,
        updates: (f.updates || []).map(u => ({ ts: u.ts, text: u.text, recordId: u.record || null })),
        history: f.replacedBy || f.retired ? [] : chain(f),
        ended: !expired && !sup && past ? ended : null, evidence: f.evidence || null,
        undated: !!f.undated,   // a card line without a date: `ts` is when the card last changed — known by then
        scope: where, source: r.source, review: r.source === 'review',
        // Where it was said — web, Telegram or Slack — for the glyph beside the fact; a
        // room's by the room's kind; a note saved mid-turn or an import carries none.
        via: ['web', 'telegram', 'slack'].includes(r.source) ? r.source : r.source === 'group' ? (groupIdKind(String(r.conv || '').replace(/^group:/, '')) === 'slack' ? 'slack' : 'telegram') : null,
        // A fact an integration stands behind — its own record, or one of its
        // sources (a chat-made "call with X" confirmed by the meeting's import)
        // — wears the service's icon after its title.
        integration: (() => {
          const imp = [r, ...(f.sources || []).map(id => recs.get(id))].find(x => x?.tags?.import)?.tags.import;
          return imp ? { id: imp.integration, label: integrationsCatalog.get(imp.integration)?.label || imp.integration, logo: integrationsCatalog.get(imp.integration)?.logo || null, title: imp.title || null } : null;
        })(),
        mine: canManage(v, { scope: f.scope, origin: r.origin }), owned: isOwned(v, { scope: f.scope, origin: r.origin }),
        task: taskOf(f),
        files: filesOfFact(f),
        names: (f.entities || []).map(e => (typeof e === 'string' ? e : e?.name)).filter(Boolean),
      });
    }
    return items;
  }

  // One record — the conversation a fact came from.
  router.get('/memory/v4/records/:id', requireActor, withViewer((req, res, v) => {
    const r = ledger.get(String(req.params.id), v.read);
    if (!r || r.hidden) return res.status(404).json({ ok: false, error: 'not found' });
    // An imported meeting: its header (title, service, people) is shown as a
    // heading, the notes or the transcript as the conversation.
    const imp = r.tags?.import || null;
    const body = imp ? r.text.replace(/^[\s\S]*?\n(?:Notes|Transcript[^:\n]*):\n/, '') : r.text;
    const meeting = imp ? { ...imp, integration: { id: imp.integration, label: integrationsCatalog.get(imp.integration)?.label || imp.integration, logo: integrationsCatalog.get(imp.integration)?.logo || null } } : null;
    return res.json({ ok: true, id: r.id, ts: r.ts, source: r.source, scope: whereOf(r.scope), meeting, messages: messagesOf(body, imp?.kind === 'transcript' ? null : speakersOf(r)), notes: factsOf(r), mine: canManage(v, r), owned: isOwned(v, r) });
  }));

  // Topics, with their latest line and state from the digest.
  router.get('/memory/v4/topics', requireActor, withViewer((req, res, v) => {
    const recs = new Map(ledger.read({ scopes: v.read }).map(r => [r.id, r]));
    const digest = views.readDigest(v.own, v.read).items;
    const profiles = views.readProfiles(v.own).topics;
    const items = views.topics(v.read, { min: views.TOPIC_MIN, hide: views.dismissedKeys(v.own) }).map(t => {
      const d = digest.find(x => views.nameKey(x.name) === t.key);
      const p = profiles[t.key];
      const latest = views.topicFacts(v.read, [t.key, ...t.aliases.map(views.topicKey)], { history: false }).reverse().find(n => n.text) || null;
      const latestNote = latest ? { text: facts.fullText(latest) } : null;
      return {
        name: t.name, key: t.key, kind: t.kind, aliases: t.aliases, n: t.mentions, convs: t.convs, first: t.first, last: t.last,
        // Who/what it is (the profile line), else the latest state, else the latest note.
        who: p?.line || null, whoAt: p?.updatedAt || null, edited: !!p?.editedBy, suggested: p?.suggested?.line || null,
        line: p?.line || d?.line || latestNote?.text || '',
        state: d && d.state !== 'active' ? d.state : null,
      };
    });
    return res.json({ ok: true, items });
  }));

  // A topic's timeline: the facts about it, one line each — plus, for a record
  // tagged with the name that gave no fact (a migrated page), what was said.
  router.get('/memory/v4/topics/:key/timeline', requireActor, withViewer((req, res, v) => {
    const t = views.topics(v.read, { min: 1 }).find(x => x.key === String(req.params.key));
    if (!t) return res.status(404).json({ ok: false, error: 'not found' });
    const recs = new Map(ledger.read({ scopes: v.read }).map(r => [r.id, r]));
    const ofFact = (f) => {
      const r = recs.get(f.record) || null;
      return {
        ts: f.ts, factId: f.id, recordId: f.record, source: r?.source || f.by || null, scope: whereOf(f.scope),
        text: f.text, updates: (f.updates || []).map(u => ({ ts: u.ts, text: u.text })), kind: f.kind || 'fact', undated: !!f.undated, past: !!(f.replacedBy || f.retired), supersededWhy: f.replacedWhy || f.retiredWhy || null, mine: r ? canManage(v, r) : false,
      };
    };
    const ofRecord = (r) => ({
      ts: r.ts, recordId: r.id, source: r.source, scope: whereOf(r.scope),
      text: spokenExcerpt(r.text), kind: 'excerpt', undated: false, mine: canManage(v, r),
    });
    // A topic's timeline is what memory knows about it: its facts. A
    // conversation that named it and gave no fact (an instruction to draft a
    // reply, a passing mention) is not knowledge — it once showed as a raw
    // quote among the facts. It stays searchable and behind the facts'
    // sources; it is not on the timeline.
    const bare = [];
    const all = [...views.topicFacts(v.read, [t.key, ...t.aliases.map(views.topicKey)]).map(ofFact), ...bare].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));   // oldest first
    const item = (x) => x;
    // Newest first, all of it — the owner reads a timeline from the top. (The
    // oldest three used to sit apart as "How it came up", in the opposite
    // order, and read as the timeline running backwards.) The newest 40, all
    // on request.
    const full = req.query.all === '1';
    const first = [];
    const rest = (full ? all : all.slice(-40)).slice().reverse().map(item);
    const p = views.readProfiles(v.own).topics[t.key] || null;
    return res.json({
      ok: true, name: t.name, kind: t.kind, n: t.mentions, aliases: t.aliases,
      who: p ? { line: p.line || null, evidence: p.evidence || null, recordId: p.recordId || null, updatedAt: p.updatedAt || null, edited: !!p.editedBy, suggested: p.suggested || null } : null,
      first, items: rest, total: all.length,
    });
  }));
  // The owner's own wording for a topic's line, or their answer to a suggestion.
  router.post('/memory/v4/topics/:key/who', requireActor, withViewer((req, res, v) => {
    const key = String(req.params.key);
    if (!views.topics(v.read, { min: 1 }).some(x => x.key === key)) return res.status(404).json({ ok: false, error: 'not found' });
    const { line, takeSuggestion, declineSuggestion } = req.body || {};
    const out = views.editProfile(v.own, key, { line, by: v.slug, takeSuggestion: takeSuggestion === true, declineSuggestion: declineSuggestion === true });
    return res.json({ ok: true, who: { line: out.line || null, edited: !!out.editedBy, suggested: out.suggested || null } });
  }));
  // Aliases are one file for everyone (a merge is a fact about names, not a
  // viewer's taste), so in team mode an admin decides; a teammate's "same"
  // would rename a tile for the whole team. Logged, like every decision.
  router.post('/memory/v4/topics/alias', requireActor, withViewer((req, res, v) => {
    const { from, into, same } = req.body || {};
    if (!from || !into) return res.status(400).json({ ok: false, error: 'from and into required' });
    if (getTeamMode() && !v.isAdmin) return res.status(403).json({ ok: false, error: 'an admin merges or separates topics for the team' });
    views.decideAlias({ from: String(from), into: String(into), same: same !== false });
    ledger.logEvent({ op: 'alias', scope: 'shared', by: v.slug, from: String(from).slice(0, 80), into: String(into).slice(0, 80), same: same !== false });
    return res.json({ ok: true });
  }));

  // Remove a topic: the name stops making a tile, for this person, and their
  // conversations stop being tagged with it. The records keep their text —
  // they are about other things too, and search still finds them; only the
  // name tag comes off the records this person may manage. Reversible from
  // Changes, which puts the tag back on exactly those records.
  router.post('/memory/v4/topics/:key/dismiss', requireActor, withViewer(async (req, res, v) => {
    const key = String(req.params.key);
    const t = views.topics(v.read, { min: 1 }).find(x => x.key === key);
    if (!t) return res.status(404).json({ ok: false, error: 'not found' });
    // Every spelling the tile gathered goes, by key — a bare first name folded
    // into the full name included, or it would come back as a tile of its own.
    const keys = new Set([key, ...[t.name, ...t.aliases].map(views.topicKey)]);
    const nameOfEnt = (e) => (typeof e === 'string' ? e : e?.name);
    const records = [];   // what came off each record, exactly, so a restore puts it back as it was
    for (const scope of v.read) {
      await ledger.rewriteMeta(scope, (rec) => {
        if (!canManage(v, rec)) return null;
        const ents = rec.tags?.entities || [];
        const removed = ents.filter(e => keys.has(views.topicKey(nameOfEnt(e))));
        if (!removed.length) return null;
        records.push({ id: rec.id, entities: removed });
        return { tags: { ...(rec.tags || {}), entities: ents.filter(e => !removed.includes(e)) } };
      }, 'dismiss-topic');
    }
    views.dismissTopic(v.own, { key, name: t.name, keys: [...keys], spellings: [t.name, ...t.aliases], by: v.slug, records });
    ledger.logEvent({ op: 'dismiss_topic', scope: v.own, by: v.slug, key, name: t.name, ids: records.map(r => r.id) });
    return res.json({ ok: true, records: records.length });
  }));
  router.post('/memory/v4/topics/:key/restore', requireActor, withViewer(async (req, res, v) => {
    const key = String(req.params.key);
    const d = views.restoreTopic(v.own, key);
    if (!d) return res.status(404).json({ ok: false, error: 'not removed' });
    const back = new Map((d.records || []).map(r => (typeof r === 'string' ? [r, [{ name: d.name }]] : [r.id, r.entities])));
    const nameOfEnt = (e) => (typeof e === 'string' ? e : e?.name);
    for (const scope of v.read) {
      await ledger.rewriteMeta(scope, (rec) => {
        if (!back.has(rec.id) || !canManage(v, rec)) return null;
        const ents = rec.tags?.entities || [];
        const have = new Set(ents.map(e => views.nameKey(nameOfEnt(e))));
        const add = back.get(rec.id).filter(e => !have.has(views.nameKey(nameOfEnt(e))));
        return add.length ? { tags: { ...(rec.tags || {}), entities: [...ents, ...add] } } : null;
      }, 'restore-topic');
    }
    ledger.logEvent({ op: 'restore_topic', scope: v.own, by: v.slug, key, name: d.name, ids: [...back.keys()] });
    return res.json({ ok: true });
  }));

  // Preferences & rules: the person's profile and preferences cards, the rules
  // they stated (the rules channel), and the team's RULES.
  router.get('/memory/v4/prefs', requireActor, withViewer((req, res, v) => {
    const base = join(process.env.PROJECT_DIR || '/home/coder/project', 'memory');
    return res.json({
      ok: true,
      about: { ...cardLines(cardPath(v.slug, 'USER_PROFILE.md')), budgetKb: 2 },
      likes: { ...cardLines(cardPath(v.slug, 'USER_PREFERENCES.md')), budgetKb: 3 },
      rules: views.rules([v.own]),
      team: { ...cardLines(join(base, 'RULES.md')), budgetKb: 3, editable: v.isAdmin },
      // The company is the team's: an admin keeps it (or the one person, solo).
      company: { ...cardLines(join(base, 'MISSION.md')), budgetKb: 3, editable: v.isAdmin || !getTeamMode() },
    });
  }));
  router.post('/memory/v4/prefs', requireActor, withViewer((req, res, v) => {
    const { card, op, text } = req.body || {};
    // What this route may write: the person's own cards, and the team's two.
    const ownCards = ['USER_PROFILE', 'USER_PREFERENCES'], teamCards = ['MISSION', 'RULES'];
    if (![...ownCards, ...teamCards].includes(card) || !['add', 'remove'].includes(op) || !String(text || '').trim()) {
      return res.status(400).json({ ok: false, error: 'card, op and text required' });
    }
    const team = getTeamMode();
    // The company and the team's rules are the team's: an admin keeps them.
    if (teamCards.includes(card)) {
      if (team && !v.isAdmin) return res.status(403).json({ ok: false, error: card === 'RULES' ? 'admins keep the team rules' : 'admins keep the company card' });
      const out = op === 'add'
        ? engineRemember({ actor: v.slug, scope: 'shared', card, text: String(text).trim(), source: 'memory screen' })
        : engineRetire({ actor: v.slug, match: String(text).trim(), reason: 'removed on the memory screen' });
      return res.status(out.ok ? 200 : 422).json(out);
    }
    const out = op === 'add'
      ? engineRemember({ actor: v.slug, scope: 'private', owner: v.slug, card, text: String(text).trim(), source: 'memory screen' })
      : engineRetire({ actor: v.slug, match: String(text).trim(), reason: 'removed on the memory screen' });
    return res.status(out.ok ? 200 : 422).json(out);
  }));
  router.post('/memory/v4/rules', requireActor, withViewer(async (req, res, v) => {
    const text = String(req.body?.text || '').trim();
    if (!text || text.length > 240) return res.status(400).json({ ok: false, error: 'a rule is one sentence' });
    if (req.body?.retired !== undefined) {
      await views.setRuleRetired(v.own, text, req.body.retired === true, v.slug);
      return res.json({ ok: true });
    }
    const r = await ledger.append({ scope: v.own, source: 'note', text: `Rule set on the memory screen: ${text}`, tags: { rules: [text] } });
    return res.json({ ok: r.ok });
  }));

  // Privacy: questions waiting for the person, what they shared, what is hidden.
  // Every row is the facts a record holds, never the conversation itself: the
  // transcript is the engine's source, the facts are what the person sees.
  router.get('/memory/v4/privacy', requireActor, withViewer((req, res, v) => {
    const since = new Date(Date.now() - 14 * 86400_000).toISOString();
    // "What I shared" is by the time of sharing (the fact's filing), not by
    // when the thing was said: a fact shared today about last month is new here.
    const sharedSince = new Date(Date.now() - 60 * 86400_000).toISOString();
    const factTexts = (r) => factsOf(r).map(n => n.text);
    const teamMode = getTeamMode();
    // Solo workspace: there is no team to share with, so nothing to list.
    // What the person shared, as facts: one row per fact, with what tells it
    // apart (its subject) and whom it concerns, so a fact about a person stands
    // out. A record shared before facts were shared shows its facts' lines.
    const sharedFromMe = !teamMode ? [] : ledger.read({ scopes: ['shared'] }).filter(r => r.origin === v.own)
      .flatMap(r => {
        const fs = factsOf(r).filter(f => (f.at || f.ts || r.ts) >= sharedSince);
        if (!fs.length) return [];
        return fs.map(f => ({ id: f.id, recordId: r.id, ts: f.ts || r.ts, source: r.source, title: f.title || null, text: f.text, kind: f.kind, subject: f.subject || null,
          concerns: f.concerns || null, aboutPerson: concernsAPerson(f), entities: f.entities || [] }));
      }).reverse();
    const mode = sharingModeOf(v.slug);
    const rules = listRules(v.slug);
    const hidden = ledger.read({ scopes: [v.own, 'shared'], includeHidden: true })
      .filter(r => r.hidden && (r.scope === v.own || r.origin === v.own))
      .map(r => ({ id: r.id, ts: r.ts, source: r.source, facts: factTexts(r), text: spokenExcerpt(r.text, 160), eraseOn: new Date(Date.parse(r.hiddenAt) + ledger.HIDE_GRACE_DAYS * 86400_000).toISOString().slice(0, 10) }));
    let erased = [];
    try {
      erased = readFileSync(join(process.env.PROJECT_DIR || '/home/coder/project', 'memory', '_engine', 'v4-log.jsonl'), 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(e => e && e.op === 'redact' && (e.scope === v.own || e.by === v.slug) && e.removed)
        .map(e => ({ ts: e.ts, removed: e.removed, by: e.by === 'purge' ? 'the 30-day rule' : e.by === v.slug ? 'you' : e.by })).reverse().slice(0, 50);
    } catch { /* none */ }
    const asks = listAsks(v.slug, { status: 'pending' }).map(a => ({ ...a, aboutPerson: a.fact ? concernsAPerson(a.fact) : null }));
    return res.json({ ok: true, teamMode, mode, rules, asks, sharedFromMe, hidden, erased, mentionedAt: mentionedAt(v.slug) });
  }));

  // The person's sharing mode: ask (default) / auto / never — their own choice.
  router.post('/memory/v4/sharing/mode', requireActor, withViewer((req, res, v) => {
    const mode = String(req.body?.mode || '');
    if (!['ask', 'auto', 'never'].includes(mode)) return res.status(400).json({ ok: false, error: 'mode must be ask, auto or never' });
    setSharing(req.actor, mode);
    ledger.logEvent({ op: 'sharing_mode', scope: v.own, by: v.slug, mode });
    return res.json({ ok: true, mode });
  }));
  router.post('/memory/v4/sharing/rules/clear', requireActor, withViewer((req, res, v) => {
    clearRule(v.slug, String(req.body?.subject || ''));
    return res.json({ ok: true });
  }));

  // Several questions answered at once (share all / keep all).
  router.post('/memory/v4/asks/batch', requireActor, withViewer(async (req, res, v) => {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))].slice(0, 200) : [];
    const name = v.displayName || v.slug;
    const out = [];
    for (const id of ids) out.push({ id, ...(await resolveAsk(v.slug, id, req.body?.decision, v.slug, { name })) });
    return res.json({ ok: out.every(o => o.ok), results: out });
  }));

  // A fact the person shared, taken back: hidden from the team; its record
  // too when nothing else of it is left. Their private copy is untouched.
  router.post('/memory/v4/shared/:id/withdraw', requireActor, withViewer(async (req, res, v) => {
    const id = String(req.params.id);
    const f = facts.all('shared').find(x => x.id === id);
    const rec = f ? ledger.get(f.record, ['shared']) : null;
    if (!f || !rec || rec.origin !== v.own) return res.status(404).json({ ok: false, error: 'not a fact you shared' });
    await facts.hide('shared', id, v.slug, { why: 'made private' });
    if (!facts.forRecord('shared', rec.id).length) await ledger.hide('shared', rec.id, v.slug);
    ledger.logEvent({ op: 'hide', scope: 'shared', ids: [rec.id], by: v.slug, facts: [id] });
    return res.json({ ok: true });
  }));
  router.post('/memory/v4/shared/:id/restore', requireActor, withViewer(async (req, res, v) => {
    const id = String(req.params.id);
    const f = facts.all('shared').find(x => x.id === id);
    const rec = f ? ledger.get(f.record, ['shared']) : null;
    if (!f || !rec || rec.origin !== v.own) return res.status(404).json({ ok: false, error: 'not a fact you shared' });
    await facts.unhide('shared', id, v.slug);
    if (rec.hidden) await ledger.unhide('shared', rec.id, v.slug);
    return res.json({ ok: true });
  }));
  router.post('/memory/v4/asks/:id', requireActor, withViewer(async (req, res, v) => {
    const out = await resolveAsk(v.slug, String(req.params.id), req.body?.decision, v.slug, { rememberSubject: req.body?.rememberSubject === true, name: v.displayName || v.slug });
    return res.status(out.ok ? 200 : 422).json(out);
  }));

  // What happened to memory, newest first: the v4 event log, scoped to what the
  // viewer could read, with the labels the Changes tab shows. Never the text of a
  // record — an erased record left nothing to show, and the rest is one click away.
  router.get('/memory/v4/changes', requireActor, withViewer((req, res, v) => {
    const days = Math.max(1, Math.min(90, Number(req.query.days) || 14));
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const readable = new Set(v.read);
    const recs = new Map(ledger.read({ scopes: v.read, includeHidden: true }).map(r => [r.id, r]));
    // Who sees an event: whoever may read the record it is about, as it is now.
    // A share is addressed to the team, so the team sees it; a hide withdraws a
    // record from the team, so only the person who hid it sees that — the
    // record's scope alone would show a teammate what someone took back.
    const own = (e) => e.by === v.slug;
    const mine = (e) => {
      switch (e.op) {
        case 'hide': case 'unhide': case 'keep_private': case 'dismiss_topic': case 'restore_topic': case 'hide_fact': case 'unhide_fact': case 'erase_fact': return own(e) || e.by === 'nightly';
        case 'alias': return true;
        case 'source': return own(e);
        case 'redact': return own(e) || (e.by === 'purge' && readable.has(e.scope));
        case 'share': return true;
        case 'note': return e.scope === 'shared' ? true : readable.has(e.scope);
        case 'private_lookup': return e.scope === v.own;
        default: return readable.has(e.scope || 'shared');
      }
    };
    const items = ledger.readEvents({ since }).filter(mine).map(e => {
      const rec = e.ids?.length === 1 ? recs.get(e.ids[0]) : null;
      const preview = rec && !rec.hidden ? factsOf(rec)[0]?.title || factsOf(rec)[0]?.text || spokenExcerpt(rec.text, 160) : null;
      const base = { ts: e.ts, op: e.op, scope: whereOf(e.scope || 'shared'), by: e.by === v.slug ? 'you' : e.by || null };
      switch (e.op) {
        case 'file': return { ...base, label: 'Remembered a conversation', detail: `${e.records} excerpt${e.records === 1 ? '' : 's'}${e.notes ? `, ${e.notes} fact${e.notes === 1 ? '' : 's'}` : ''}${e.updated ? `, ${e.updated} corrected` : ''}${e.superseded ? `, ${e.superseded} no longer true` : ''}${e.rules ? `, ${e.rules} rule${e.rules === 1 ? '' : 's'}` : ''}${e.shared ? ', part shared with the team' : ''}${e.asks ? ', a question for you' : ''}`, preview: e.titles?.length ? e.titles.join(' · ') : null, source: e.source, conv: e.conv };
        // A share is addressed to the team: shown as shared, undone only by its sharer.
        case 'share': return { ...base, scope: 'shared', label: 'Shared with the team', preview, recordId: e.ids?.[0] || null, undo: own(e) && rec && !rec.hidden ? 'hide' : null };
        case 'keep_private': return { ...base, label: 'Kept private' };
        case 'private_lookup': return { ...base, label: e.answered ? 'Answered from your memory in a team room' : 'Looked in your memory for a team room, found nothing', detail: e.room ? `in ${e.room}` : undefined };
        case 'note': return { ...base, label: e.updated?.length && !e.titles?.length ? 'Corrected on request' : 'Saved on request', detail: [e.updated?.length ? `remark added to ${e.updated.join(' · ')}` : null, e.superseded?.length ? `no longer true: ${e.superseded.join(' · ')}` : null].filter(Boolean).join('; ') || undefined, preview, recordId: e.ids?.[0] || null };
        case 'alias': return { ...base, label: e.same === false ? 'Kept two names apart' : 'Merged two spellings', detail: `${e.from} ${e.same === false ? '≠' : '→'} ${e.into}${e.why ? ` — ${e.why}` : ''}` };
        // Taking back one's own share makes it private again; an admin hiding
        // what the team held in common just hides it.
        case 'hide': return { ...base, label: e.scope === 'shared' && rec?.origin === `user:${e.by}` ? 'Made private' : 'Hidden', preview, recordId: e.ids?.[0] || null, undo: rec?.hidden ? 'unhide' : null };
        case 'unhide': return { ...base, label: 'Restored', preview, recordId: e.ids?.[0] || null };
        case 'hide_fact': {
          // Undo while any of the facts is still hidden. (Events from before the
          // facts store name a record and text hashes; they show, without undo.)
          const still = (e.factIds || []).filter(id => facts.find([e.scope], id)?.hidden);
          return { ...base, label: e.facts === 1 ? 'Hid a fact' : `Hid ${e.facts} facts`, preview: e.titles?.length ? e.titles.join(' · ') : preview, factIds: still, undo: still.length ? 'unhide_fact' : null };
        }
        case 'unhide_fact': return { ...base, label: e.facts === 1 ? 'Restored a fact' : `Restored ${e.facts} facts`, preview };
        case 'erase_fact': return { ...base, label: e.facts === 1 ? 'Erased a fact' : `Erased ${e.facts} facts`, detail: 'the conversation it came from is kept', preview: e.titles?.length ? e.titles.join(' · ') : preview };
        case 'dismiss_topic': return { ...base, label: `Removed the topic “${e.name}”`, detail: `${e.ids?.length || 0} memor${e.ids?.length === 1 ? 'y keeps' : 'ies keep'} their text; the name no longer makes a tile`, topicKey: e.key, undo: own(e) && views.readDismissed(v.own)[e.key] ? 'restore_topic' : null };
        case 'restore_topic': return { ...base, label: `Restored the topic “${e.name}”` };
        case 'redact': return { ...base, label: e.by === 'purge' ? 'Erased after 30 days hidden' : 'Erased', detail: `${e.removed} record${e.removed === 1 ? '' : 's'} — nothing about ${e.removed === 1 ? 'it' : 'them'} is kept`, preview: e.titles?.length ? e.titles.join(' · ') : null, by: e.by === 'purge' ? 'the 30-day rule' : base.by };
        case 'review': return { ...base, label: e.period === 'weekly' ? 'Weekly review' : 'Daily review', detail: `${e.items} thing${e.items === 1 ? '' : 's'} that mattered on ${e.day}` };
        case 'source': return { ...base, label: `${e.on ? 'Switched on' : 'Switched off'} ${integrationsCatalog.get(e.integration)?.label || e.integration} as a memory source` };
        case 'import': return { ...base, label: `Imported a meeting from ${e.label || e.integration}`, preview: e.title || null, detail: [`${e.records} excerpt${e.records === 1 ? '' : 's'}`, `${e.notes} fact${e.notes === 1 ? '' : 's'}`, e.updated ? `${e.updated} remark${e.updated === 1 ? '' : 's'} added` : null, e.superseded ? `${e.superseded} no longer true` : null].filter(Boolean).join(', ') };
        default: return null;
      }
    }).filter(Boolean).reverse();
    return res.json({ ok: true, days, items });
  }));

  // A fact is one note of a record. Hiding or erasing a fact leaves the record
  // it came from — its other facts, and the conversation for search — so a
  // person can take one line off the screen without losing the rest. Hidden
  // facts are purged with hidden records (30 days) and restored from Changes,
  // found again by the hash of their text: the log never holds the text, and
  // an index would move when a neighbour is erased.
  // A fact is its own thing (lib/memory-facts.js): hiding or erasing one leaves
  // the conversation it came from — its other facts, and the text for search —
  // so a person can take one line off the screen without losing the rest.
  // Hidden facts are purged after 30 days, restored from Changes by their id.
  const ownedFact = (v, id) => {
    const f = facts.find(v.read, id);
    if (!f) return null;
    const r = f.record ? ledger.get(f.record, [f.scope]) : null;
    return canManage(v, { scope: f.scope, origin: r?.origin }) ? f : null;
  };
  router.post('/memory/v4/facts/bulk', requireActor, withViewer(async (req, res, v) => {
    const op = String(req.body?.op || '');
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))].slice(0, 500) : [];
    if (!['hide', 'erase'].includes(op) || !ids.length) return res.status(400).json({ ok: false, error: 'op (hide or erase) and ids required' });
    const done = [], refused = [], byScope = new Map();
    for (const id of ids) {
      const f = ownedFact(v, id);
      if (!f) { refused.push(id); continue; }
      (byScope.get(f.scope) || byScope.set(f.scope, []).get(f.scope)).push(f);
    }
    for (const [scope, list] of byScope) {
      if (op === 'hide') for (const f of list) await facts.hide(scope, f.id, v.slug);
      else await facts.erase(scope, list.map(f => f.id));
      // The log keeps ids and titles only, never a fact's text.
      ledger.logEvent({ op: `${op}_fact`, scope, by: v.slug, factIds: list.map(f => f.id), facts: list.length, titles: list.map(f => f.title).filter(Boolean).slice(0, 5) });
      done.push(...list.map(f => f.id));
    }
    return res.json({ ok: true, done, refused });
  }));
  // Undo of a fact hide.
  router.post('/memory/v4/facts/unhide', requireActor, withViewer(async (req, res, v) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 500) : [];
    let restored = 0;
    const byScope = new Map();
    for (const id of ids) {
      const f = ownedFact(v, id);
      if (!f || !f.hidden) continue;
      await facts.unhide(f.scope, f.id, v.slug);
      restored++;
      (byScope.get(f.scope) || byScope.set(f.scope, []).get(f.scope)).push(f.id);
    }
    for (const [scope, list] of byScope) ledger.logEvent({ op: 'unhide_fact', scope, by: v.slug, factIds: list, facts: list.length });
    return res.json({ ok: true, restored });
  }));

  // Many at once, the same rule per record: what this person may not manage
  // is refused, the rest is done — each with its own event, as single calls.
  router.post('/memory/v4/records/bulk', requireActor, withViewer(async (req, res, v) => {
    const op = String(req.body?.op || '');
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))].slice(0, 500) : [];
    if (!['hide', 'unhide', 'erase'].includes(op) || !ids.length) return res.status(400).json({ ok: false, error: 'op (hide, unhide or erase) and ids required' });
    const done = [], refused = [];
    for (const id of ids) {
      const rec = ownedRecord(v, id);
      if (!rec) { refused.push(id); continue; }
      if (op === 'hide') await ledger.hide(rec.scope, rec.id, v.slug);
      else if (op === 'unhide') await ledger.unhide(rec.scope, rec.id, v.slug);
      else { await ledger.redact(rec.scope, [rec.id], v.slug, { titles: factsOf(rec).map(f => f.title).filter(Boolean) }); await facts.sweepOrphans(rec.scope); }
      done.push(id);
    }
    return res.json({ ok: true, done, refused });
  }));

  // Hide / restore / erase — the person's own records and what they shared;
  // an admin, anything shared or from a group (canManage above).
  for (const op of ['hide', 'unhide', 'erase']) {
    router.post(`/memory/v4/records/:id/${op}`, requireActor, withViewer(async (req, res, v) => {
      const rec = ownedRecord(v, req.params.id);
      if (!rec) return res.status(404).json({ ok: false, error: 'not found, or not yours' });
      if (op === 'hide') await ledger.hide(rec.scope, rec.id, v.slug);
      else if (op === 'unhide') await ledger.unhide(rec.scope, rec.id, v.slug);
      else { await ledger.redact(rec.scope, [rec.id], v.slug, { titles: factsOf(rec).map(f => f.title).filter(Boolean) }); await facts.sweepOrphans(rec.scope); }
      return res.json({ ok: true });
    }));
  }

  // Routines: the person's routines.json (the Routines view once v4 is on).
  router.get('/routines', requireActor, withViewer((req, res, v) => {
    const owner = routinesOwner(v.slug);
    flushWaiting(owner);
    const store = readRoutines(owner);
    return res.json({ ok: true, mode: ledger.v4Mode(), routines: store.routines, unparsed: store.unparsed, waiting: waitingView(owner) });
  }));
  // ── Marketplace: ready-made routines (lib/routines-catalog.js) ──
  router.get('/routines/catalog', requireActor, withViewer((req, res, v) => {
    const store = readRoutines(routinesOwner(v.slug));
    return res.json({ ok: true, categories: routinesCatalog.CATEGORIES.map(([id, label]) => ({ id, label })), integrations: routinesCatalog.integrationsInCatalog(usableFor(v.slug)), groups: routinesCatalog.offer({ isUsable: usableFor(v.slug), routines: store.routines }) });
  }));
  router.post('/routines/catalog/:id', requireActor, withViewer((req, res, v) => {
    const r = addFromCatalog(v.slug, req.params.id, { later: req.query.later === '1' });
    return res.status(r.status).json(r.body);
  }));
  router.delete('/routines/catalog/:id', requireActor, withViewer((req, res, v) => {
    const key = routinesOwner(v.slug);
    const store = readRoutines(key);
    const hits = store.routines.filter(r => !r.retired && r.catalogId === req.params.id);
    const wasWaiting = dropWaiting(key, req.params.id);
    if (!hits.length) return wasWaiting ? res.json({ ok: true, retired: 0, waiting: true }) : res.status(404).json({ ok: false, error: 'not one of your routines' });
    for (const r of hits) r.retired = true;   // retired, not erased: history stays
    writeRoutines(key, store);
    return res.json({ ok: true, retired: hits.length });
  }));

  // ── The person's own routines: add, edit, delete from the Routines screen ──
  // (The bot does the same through memory_write: remember / supersede / retire.)
  const routineFields = (b = {}) => {
    const out = {};
    if (b.title !== undefined) out.title = String(b.title || '').trim().slice(0, 200);
    if (b.description !== undefined) out.description = String(b.description || '').trim().slice(0, 2000);
    if (b.icon !== undefined) out.icon = b.icon || null;
    if (b.tags !== undefined) out.tags = Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(/[\s,]+/).map(t => t.replace(/^#/, '')).filter(Boolean);
    return out;
  };
  router.post('/routines', requireActor, withViewer((req, res, v) => {
    const f = routineFields(req.body);
    if (!f.title || !f.description) return res.status(400).json({ ok: false, error: 'a routine needs a title and what to do' });
    const key = routinesOwner(v.slug);
    const store = readRoutines(key);
    store.routines.push({ ...f, source: 'ui' });
    const saved = writeRoutines(key, store);
    return res.json({ ok: true, routine: saved.routines[saved.routines.length - 1] });
  }));
  router.patch('/routines/:id', requireActor, withViewer((req, res, v) => {
    const key = routinesOwner(v.slug);
    const store = readRoutines(key);
    const i = store.routines.findIndex(r => r.id === req.params.id && !r.retired);
    if (i < 0) return res.status(404).json({ ok: false, error: 'not one of your routines' });
    const f = routineFields(req.body);
    if (f.title === '' || f.description === '') return res.status(400).json({ ok: false, error: 'a routine needs a title and what to do' });
    // Edited text replaces the catalog one-liner, which would describe the old routine.
    const { summary: _old, ...cur } = store.routines[i];
    store.routines[i] = { ...(f.description !== undefined && f.description !== cur.description ? cur : store.routines[i]), ...f, source: 'ui' };
    const saved = writeRoutines(key, store);
    return res.json({ ok: true, routine: saved.routines[i] });
  }));
  router.delete('/routines/:id', requireActor, withViewer((req, res, v) => {
    const key = routinesOwner(v.slug);
    const store = readRoutines(key);
    const r = store.routines.find(x => x.id === req.params.id && !x.retired);
    if (!r) return res.status(404).json({ ok: false, error: 'not one of your routines' });
    r.retired = true;   // retired, not erased: the planner stops, history stays
    writeRoutines(key, store);
    return res.json({ ok: true });
  }));

  // A line the routine grammar could not read is the owner's to place: a fact
  // becomes a dated memory record, or it becomes a routine with the title they
  // give it. Either way it leaves `unparsed` — nothing is dropped.
  router.post('/routines/unparsed', requireActor, withViewer(async (req, res, v) => {
    const key = routinesOwner(v.slug);
    const store = readRoutines(key);
    const line = String(req.body?.line || '');
    const i = store.unparsed.indexOf(line);
    if (i < 0) return res.status(404).json({ ok: false, error: 'not found' });
    const text = line.replace(/^[-*]\s+/, '').trim();
    if (req.body?.as === 'memory') {
      const r = await ledger.append({ scope: v.own, source: 'note', text, notes: [{ text, kind: 'fact', evidence: text }] });
      if (!r.ok) return res.status(422).json({ ok: false, error: 'not saved' });
      ledger.logEvent({ op: 'note', scope: v.own, ids: [r.id], by: v.slug });
    } else if (req.body?.as === 'routine') {
      const title = String(req.body?.title || '').trim().slice(0, 200);
      if (!title) return res.status(400).json({ ok: false, error: 'a routine needs a title' });
      store.routines.push({ title, description: text, icon: null, tags: [], retired: false, source: 'ui' });
    } else {
      return res.status(400).json({ ok: false, error: 'as must be memory or routine' });
    }
    store.unparsed.splice(i, 1);
    writeRoutines(key, store);
    return res.json({ ok: true });
  }));

  // The screen's search: the topics the words name, the facts about them (best
  // match first), and the conversation excerpts the assistant would recall —
  // the same retrieval, with the topics' other spellings added to the words.
  router.get('/memory/v4/search', requireActor, withViewer(async (req, res, v) => {
    const q = String(req.query.q || '').trim().slice(0, 500);
    if (!q) return res.json({ ok: true, total: 0, topics: [], facts: [], hits: [] });
    const ex = views.expandQuery(v.read, q);
    const query = ex.terms.length ? `${q} ${ex.terms.join(' ')}` : q;
    const r = await search({ query, scopes: v.read, k: 10 });
    const rank = new Map(r.ranked.map((h, i) => [h.id, i]));
    const words = tokens(query);
    // A fact scores by the query words its own words carry (its title counts
    // double), plus a little for standing on a conversation the search found.
    const scored = factItems(v, { history: false }).map(f => {
      const own = tokens(`${f.text} ${(f.updates || []).map(u => u.text).join(' ')} ${f.names.join(' ')}`), title = tokens(f.title || '');
      let s = 0;
      for (const w of words) { if (own.some(x => near(w, x))) s += 1; if (title.some(x => near(w, x))) s += 1; }
      // The conversation it stands on being found is a tie-breaker, never a reason on its own.
      if (s > 0 && rank.has(f.recordId)) s += 1 / (1 + rank.get(f.recordId));
      return { f, s };
    }).filter(x => x.s > 0).sort((a, b) => b.s - a.s || (a.f.ts < b.f.ts ? 1 : -1)).slice(0, 40);
    return res.json({
      ok: true, total: r.total,
      topics: ex.topics.map(t => ({ name: t.name, key: t.key, kind: t.kind, aliases: t.aliases, n: t.mentions })),
      facts: scored.map(x => x.f),
      hits: r.ranked.map(h => ({ id: h.id, ts: h.ts, source: h.source, scope: whereOf(h.scope), messages: messagesOf(h.text.slice(0, 1500)), notes: h.notes || [] })),
    });
  }));

  // The bot adds a Marketplace routine once the person said yes to it in a
  // direct conversation (the routines skill). Never from a group: a routine is personal.
  router.post('/internal/routines/catalog/:id', loopbackOnly, (req, res) => {
    const who = whoIsAsking(req);
    if (!who) return res.status(403).json({ ok: false, error: 'no turn identity' });
    if (who.group) return res.status(403).json({ ok: false, error: 'routines are personal — add it in a direct conversation' });
    const r = addFromCatalog(who.actor, req.params.id);
    return res.status(r.status).json(r.body);
  });

  // What is going on for the turn's person right now — the Memory screen's
  // "Right now" and "What I'm keeping track of", plus their time zone and
  // language. The Telegram brain's prefix is loaded once per session, so a turn
  // that plans (the morning planner) fetches these fresh instead.
  router.get('/internal/memory/v4/now', loopbackOnly, (req, res) => {
    const who = whoIsAsking(req);
    if (!who) return res.status(403).json({ ok: false, error: 'no turn identity' });
    if (who.group) return res.status(403).json({ ok: false, error: 'personal — not in a group conversation' });
    const routines = routinesCard(who.actor);
    const parts = [settingsCard(who.actor), goingOnCard(who.actor), routines && `Your routines for them:\n${routines}`, plannerFeedback(who.actor)].filter(Boolean);
    return res.json({ ok: true, text: parts.join('\n\n') || 'Nothing current recorded for this person.' });
  });

  router.get('/internal/memory/v4/search', loopbackOnly, async (req, res) => {
    const who = whoIsAsking(req);
    if (!who) return res.status(403).json({ ok: false, error: 'no turn identity' });
    const q = String(req.query.q || '').trim().slice(0, 1000);
    if (!q) return res.status(400).json({ ok: false, error: 'q required' });
    const k = Math.min(20, Math.max(1, Number(req.query.k) || 10));
    const extra = views.expandQuery(who.read, q).terms;
    const r = await search({ query: extra.length ? `${q} ${extra.join(' ')}` : q, scopes: who.read, k });
    try { const idx = factsByRecord(who.read); attachTasks(r.hits, who.read, idx); attachFiles(r.hits, who.read, idx); } catch { /* the board is not memory's concern */ }
    return res.json({ ok: true, total: r.total, text: renderResults({ hits: r.hits, total: r.total, what: `memory search for "${q.slice(0, 80)}"` }) });
  });

  router.get('/internal/memory/v4/timeline', loopbackOnly, (req, res) => {
    const who = whoIsAsking(req);
    if (!who) return res.status(403).json({ ok: false, error: 'no turn identity' });
    const term = String(req.query.term || '').trim().slice(0, 200);
    if (!term) return res.status(400).json({ ok: false, error: 'term required' });
    const since = /^\d{4}-\d{2}-\d{2}/.test(String(req.query.since || '')) ? String(req.query.since) : null;
    const hits = timeline({ term, scopes: who.read, since, limit: 40 }).map(h => ({ ...h, clip: around(h.text, term) }));
    try { const idx = factsByRecord(who.read); attachTasks(hits, who.read, idx); attachFiles(hits, who.read, idx); } catch { /* the board is not memory's concern */ }
    const total = ledger.read({ scopes: who.read, since }).length;
    return res.json({ ok: true, count: hits.length, text: renderResults({ hits, total, what: `every mention of "${term.slice(0, 80)}"` }) });
  });

  router.post('/internal/memory/v4/note', loopbackOnly, async (req, res) => {
    const who = whoIsAsking(req);
    if (!who) return res.status(403).json({ ok: false, error: 'no turn identity' });
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'text required' });
    if (text.length > 2000) return res.status(400).json({ ok: false, error: 'a note is at most 2000 characters' });
    // A group turn writes its group; a person writes their own scope unless they
    // asked for it to be shared with the team.
    const scope = who.group ? who.write : (req.body?.share === true ? 'shared' : who.write);
    if (!scope) return res.status(403).json({ ok: false, error: 'this group turn has no group scope' });
    // The person's own words it comes from: a note is grounded like any other
    // fact, and a name the person did not use and memory does not know cannot
    // be written — a correction once arrived with an invented first name. A
    // plain word the check cannot tell from a name (a place, a translation)
    // is resent vouched for by name.
    const said = String(req.body?.said || '').trim().slice(0, 2000);
    if (!said) return res.status(400).json({ ok: false, error: "Nothing was saved: said required — the person's own words this comes from, copied exactly" });
    const vouched = (Array.isArray(req.body?.confirmNames) ? req.body.confirmNames : []).map(v => String(v).toLowerCase());
    const knownNames = views.knownNames([who.write, 'shared']);
    const speaker = who.actor ? nameOf(who.actor) : 'The person';
    // Two model calls, side by side: what the note adds that the person did
    // not say, and the note split into one entry per thing, each worded as it
    // stands now and grounded in the person's words — a paragraph about six
    // things once became one fact, so a correction of one of them replaced
    // nothing; a dayless note once merged a call on the 20th into a meeting on
    // the 5th. A split the model cannot make (a failed call) files the note
    // whole; a note none of whose parts the words support is refused, so the
    // assistant quotes more of what the person said.
    const [unsupported, split] = await Promise.all([
      unsupportedDetails({ text, said, known: knownNames, person: speaker }),
      splitNote({ name: speaker, said, text, known: knownNames, max: 6 }).catch(() => null),
    ]);
    // A detail the model flags that stands verbatim in the person's words (or
    // is vouched for) is not unsupported — the check once flagged a name copied
    // from the words as new, and the note was refused and written again.
    const saidLower = said.toLowerCase();
    const unknown = unsupported.filter(n => !vouched.includes(n.toLowerCase()) && !saidLower.includes(n.toLowerCase()));
    if (unknown.length) return res.status(400).json({ ok: false, error: `Nothing was saved: not in what the person said nor in memory: ${unknown.join(', ')} — write only what they said (or ask them); if a detail is right after all, resend with it in confirmNames` });
    let pieces = split?.notes || [];
    const leftOut = (split?.rejected || []).filter(x => !x.kept);
    // The split is a model's call and once threw out every piece of a note the
    // person had dictated word for word ("remember: the spare key is with the
    // receptionist, code …"); the assistant retried for minutes, then said it
    // was saved. A note whose words are plainly the person's — most of them in
    // what they said, nothing unsupported above — is filed whole instead.
    if (split && !pieces.length && wordsFrom(text, said) >= 0.6) pieces = [{ text, kind: 'fact', evidence: said }];
    if (split && !pieces.length) return res.status(400).json({ ok: false, error: `Nothing was saved: nothing in the note is in the person's words${leftOut.length ? ` (${leftOut.map(x => x.why).join('; ')})` : ''} — quote the part of what they said it comes from in \`said\`; what they said earlier in the conversation is filed from the conversation itself` });
    const cands = pieces.length ? pieces : [{ text, kind: 'fact', evidence: said }];
    // Already remembered → not saved twice; a change → the old note is replaced.
    const plan = await facts.plan(scope, cands, { entities: split?.entities || [] });
    if (!plan.some(d => ['add', 'replace', 'update'].includes(d.op))) {
      const known = plan.filter(d => d.op === 'confirm').map(d => d.target);
      if (known.length) await facts.apply(scope, plan, { standing: 'note', by: 'note' });
      return res.json({ ok: true, already: true, repeats: known.map(k => k.title || k.text), leftOut: leftOut.length });
    }
    // A note in a person's own memory goes through the same gate as a filed
    // conversation (lib/memory-sharing.js): the router reads the person's
    // words, then each new fact goes to the team, to a question, or stays —
    // by their mode, their rules and earlier answers. A fact the bot noted
    // during the turn once never crossed, because only the night's pass asked.
    // The router is asked before the record is written: when it does not
    // answer, the record is tagged `ungated` and the night's pass judges it
    // (lib/memory-regate.js) — it used to stay private with nobody told.
    const fresh = plan.filter(d => d.fact && ['add', 'replace', 'update'].includes(d.op)).map(d => d.fact);
    const gated = fresh.length > 0 && getTeamMode() && !who.group && who.actor && scope === `user:${who.actor}`;
    const routed = gated ? await routeSaid({ name: speaker, said }) : null;
    const tags = { ...(split?.entities?.length ? { entities: split.entities } : {}), ...(gated && !routed ? { ungated: true } : {}) };
    // The person's words are the record (source "note"); what memory takes
    // from them is written to the facts store against that record.
    const r = await ledger.append({
      scope, source: 'note', text: said === text ? text : `${text}\n\n(said: ${said})`,
      ...(Object.keys(tags).length ? { tags } : {}),
      speaker: who.actor ? nameOf(who.actor) : null,
      origin: scope === 'shared' ? who.write : null,
    });
    if (!r.ok) return res.json({ ok: false, error: r.skipped === 'tombstoned' ? 'this was erased by its owner and cannot be saved again' : 'not saved' });
    const got = await facts.apply(scope, plan, { record: r.id, standing: 'note', by: 'note', single: cands.length === 1 });
    ledger.logEvent({ op: 'note', scope, ids: [r.id], by: who.actor || null, ...(got.titles.length ? { titles: got.titles } : {}), ...(got.updated.length ? { updated: got.updated } : {}), ...(got.superseded.length ? { superseded: got.superseded } : {}) });
    const titles = plan.filter(d => d.fact && (d.op === 'add' || d.op === 'replace')).map(d => d.fact.title || d.fact.text);
    const { shared, asked } = gated ? await gateFacts(who.actor, fresh, { routed, said, name: speaker }) : { shared: 0, asked: 0 };
    return res.json({ ok: true, id: got.ids[0] || r.id, scope: scope === 'shared' ? 'team' : scope.startsWith('group:') ? 'group' : 'private', replaced: got.replaced, superseded: got.superseded, updated: got.updated, saved: titles[0] || got.updated[0] || text, titles: titles.length ? titles : got.updated, repeats: got.repeats, leftOut: leftOut.length, ...(shared ? { shared } : {}), ...(asked ? { asked } : {}), ...(gated && !routed ? { ungated: true } : {}) });
  });

  // A verified member's own memory, asked from a team room — the one bridge
  // across the group fence, and it runs OUTSIDE the room: a one-shot turn as
  // the member (lib/integrations/private-lookup.js) answers in a few
  // sentences, and only those enter the room's session. Who may ask is
  // decided here, in code: the turn's token names the sender (resolved by the
  // watcher from their Slack or Telegram identity), the roster vouches for
  // them, the room must be the team's. The asker's own scope, never another's.
  const lookupsPerTurn = new Map();   // turn token → count (two a turn)
  router.post('/internal/memory/v4/mine', loopbackOnly, async (req, res) => {
    const who = whoIsAsking(req);
    if (!who) return res.status(403).json({ ok: false, error: 'no turn identity' });
    if (!who.group || !who.actor || who.actor === 'team') return res.status(403).json({ ok: false, error: 'only a known person in a team room can ask their own memory here' });
    const member = memberBySlug(who.actor);
    if (!member) return res.status(403).json({ ok: false, error: 'not on the team' });
    const room = getGroup(who.groupId);
    if (!room) return res.status(403).json({ ok: false, error: 'not a registered room' });
    const question = String(req.body?.question || '').trim().slice(0, 1500);
    if (!question) return res.status(400).json({ ok: false, error: 'question required' });
    if (room.privateAnswers === 'off') return res.json({ ok: true, nothing: true, off: true, note: 'answers from a person\'s own memory are switched off in this room' });
    // Someone from outside in the room does not stop it: what the asker asks
    // about themselves is theirs to have said. The one-shot is told who is
    // there and leaves out anything about them.
    const outsiders = outsidersOf(room);
    const token = String(req.get('x-ide-turn') || '');
    const n = (lookupsPerTurn.get(token) || 0) + 1;
    lookupsPerTurn.set(token, n);
    if (lookupsPerTurn.size > 500) lookupsPerTurn.delete(lookupsPerTurn.keys().next().value);
    if (n > 2) return res.json({ ok: true, nothing: true, note: 'already looked twice this turn' });
    // The watcher started this person's lookup when it decided to answer them,
    // with the exchange around their message; the turn's first call gets it.
    const early = n === 1 ? takePrefetched(who.groupId, member.slug) : null;
    let r;
    try { r = await (early || lookupMine({ member, question, room })); } catch (e) { r = { failed: true, error: e.message }; }
    const answered = !!(r && r.answer);
    ledger.logEvent({ op: 'private_lookup', scope: `user:${member.slug}`, by: member.slug, group: who.groupId, room: room.title || who.groupId, answered });
    if (!r || r.failed) return res.json({ ok: true, failed: true, note: 'could not check their memory right now; say so, do not guess' });
    if (r.secret) return res.json({ ok: true, nothing: true, secret: true, note: 'the answer is a secret (a code, a password): never said in a room; send it to their DM' });
    if (r.private) return res.json({ ok: true, private: true, note: 'theirs, but held back for this room: offer it in their DM' });
    return res.json({ ok: true, nothing: !answered, answer: answered ? r.answer : null, ...(outsiders.length ? { outsiders: outsiders.length } : {}) });
  });

  // The same, for the asker's own connected accounts (their Supabase, their
  // mailbox): a one-shot as them with those connections alone, which may
  // change something there as in their own chat.
  // Same gate as their memory: the turn's token, the roster, a team room.
  const connectionCallsPerTurn = new Map();
  router.post('/internal/memory/v4/mine/connections', loopbackOnly, async (req, res) => {
    const who = whoIsAsking(req);
    if (!who) return res.status(403).json({ ok: false, error: 'no turn identity' });
    if (!who.group || !who.actor || who.actor === 'team') return res.status(403).json({ ok: false, error: 'only a known person in a team room can ask their own connections here' });
    const member = memberBySlug(who.actor);
    if (!member) return res.status(403).json({ ok: false, error: 'not on the team' });
    const room = getGroup(who.groupId);
    if (!room) return res.status(403).json({ ok: false, error: 'not a registered room' });
    const question = String(req.body?.question || '').trim().slice(0, 1500);
    if (!question) return res.status(400).json({ ok: false, error: 'question required' });
    if (room.privateAnswers === 'off') return res.json({ ok: true, off: true, note: 'answers from a person\'s own accounts are switched off in this room' });
    const token = String(req.get('x-ide-turn') || '');
    const n = (connectionCallsPerTurn.get(token) || 0) + 1;
    connectionCallsPerTurn.set(token, n);
    if (connectionCallsPerTurn.size > 500) connectionCallsPerTurn.delete(connectionCallsPerTurn.keys().next().value);
    if (n > 2) return res.json({ ok: true, nothing: true, note: 'already asked twice this turn' });
    let r;
    try { r = await askMyConnections({ member, question, room }); } catch (e) { r = { failed: true, error: e.message }; }
    ledger.logEvent({ op: 'private_lookup', kind: 'connections', scope: `user:${member.slug}`, by: member.slug, group: who.groupId, room: room.title || who.groupId, answered: !!r?.answer });
    if (!r || r.failed) return res.json({ ok: true, failed: true, ...(r?.reason ? { reason: r.reason } : {}) });
    return res.json({ ok: true, ...(r.private ? { private: true } : {}), ...(r.none ? { none: true } : r.secret ? { secret: true } : r.nothing ? { nothing: true } : { answer: r.answer }) });
  });

  // One item of an integration (a meeting), passed verbatim by the night
  // import turn (lib/memory-sources.js) — or by the assistant when the person
  // asks for today's notes to be read in. Filed in the actor's private scope.
  router.post('/internal/memory/v4/import', loopbackOnly, async (req, res) => {
    const who = whoIsAsking(req);
    if (!who) return res.status(403).json({ ok: false, error: 'no turn identity' });
    if (who.group) return res.status(403).json({ ok: false, error: 'not in a group' });
    const b = req.body || {};
    try {
      const r = await sources.importItem({
        actor: who.actor, name: nameOf(who.actor), integration: b.integration, item: b.item, title: b.title, at: b.at,
        participants: b.participants, url: b.url, summary: b.summary, transcript: b.transcript,
      });
      return res.status(r.ok || r.already ? 200 : 400).json(r);
    } catch (err) {
      process.stderr.write(`[memory-v4] import: ${err.stack || err}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Memory → Sources: the person's connected integrations that can feed
  // memory, each with its switch and last run; the same switch sits on the
  // integration's card. "Run now" starts their import turn at once.
  router.get('/memory/v4/sources', requireActor, withViewer((req, res, v) => {
    // The two sources every workspace has, always on: the person's own
    // conversations, filed when they go quiet. What the last day brought.
    const since = new Date(Date.now() - 86400_000).toISOString();
    const filed = ledger.readEvents({ since }).filter(e => e.op === 'file' && e.scope === v.own);
    const sum = (src, k) => filed.filter(e => e.source === src).reduce((a, e) => a + (e[k] || 0), 0);
    const builtin = [
      { id: 'web', label: 'Web chat', what: 'every conversation here, once it has gone quiet', records: sum('web', 'records'), facts: sum('web', 'notes') },
      { id: 'telegram', label: 'Telegram', what: 'every conversation with me on Telegram, once it has gone quiet', records: sum('telegram', 'records'), facts: sum('telegram', 'notes') },
    ];
    return res.json({ ok: true, hour: sources.RUN_HOUR, builtin, items: sources.listFor(v.slug), available: sources.available(v.slug) });
  }));
  router.post('/memory/v4/sources/:id', requireActor, withViewer((req, res, v) => {
    // By the connection key (`granola@ann`) or, for one of a kind, the entry's id.
    const id = String(req.params.id || '');
    const src = sources.listFor(v.slug).find(s => s.key === id) || sources.listFor(v.slug).find(s => s.id === id);
    if (!src) return res.status(404).json({ ok: false, error: 'not a connected memory source' });
    const s = sources.setOn(v.slug, src.key, req.body?.on === true);
    ledger.logEvent({ op: 'source', scope: v.own, by: v.slug, integration: src.id, connection: src.key, on: !!s.on });
    return res.json({ ok: true, items: sources.listFor(v.slug) });
  }));
  router.post('/memory/v4/sources/:id/run', requireActor, withViewer((req, res, v) => {
    const id = String(req.params.id || '');
    const src = sources.listFor(v.slug).find(s => s.key === id && s.on) || sources.listFor(v.slug).find(s => s.id === id && s.on);
    if (!src) return res.status(400).json({ ok: false, error: 'switch the source on first' });
    sources.runFor(v.slug, { only: src.key }).then(r => process.stdout.write(`[memory-v4/imports] ${v.slug} (${id}, on request): ${JSON.stringify(r)}\n`)).catch(e => process.stderr.write(`[memory-v4/imports] ${v.slug}: ${e.message}\n`));
    return res.status(202).json({ ok: true, started: id });
  }));

  router.post('/internal/memory/v4/forget', loopbackOnly, async (req, res) => {
    const who = whoIsAsking(req);
    if (!who) return res.status(403).json({ ok: false, error: 'no turn identity' });
    if (who.group) return res.status(403).json({ ok: false, error: 'nothing can be forgotten from a group chat — the owner can do it on the Memory screen' });
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).filter(id => /^[0-9a-z]{9,40}$/.test(id)).slice(0, 50);
    if (!ids.length) return res.status(400).json({ ok: false, error: 'ids required' });
    const hidden = [], refused = [];
    for (const id of ids) {
      const rec = ledger.get(id, [who.write, 'shared']);
      // Their own records, and what they themselves shared — nothing of anyone else's.
      if (rec && (rec.scope === who.write || rec.origin === who.write)) {
        await ledger.hide(rec.scope, id, who.actor);
        hidden.push(id);
      } else refused.push(id);
    }
    return res.json({ ok: true, hidden, refused, note: hidden.length ? `hidden now, erased for good after ${ledger.HIDE_GRACE_DAYS} days unless restored on the Memory screen` : undefined });
  });

  return router;
}
