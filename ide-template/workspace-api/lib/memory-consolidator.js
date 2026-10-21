/**
 * memory-consolidator — files finished conversations into the v4 ledger.
 *
 * Replaces the sweep's "did anything durable get said?" question with a simpler
 * rule that does not depend on a model noticing: every finished conversation is
 * kept, whole, in its owner's scope — as chunks of at most ~2500 characters cut at
 * message boundaries, the unit retrieval was measured on (real canary questions:
 * 0.95 with excerpts + reader rules). Models only ADD to that:
 *   - the router picks lines the whole team may also read (1:1 conversations);
 *     a failure there means nothing is shared, never that anything is lost;
 *   - the notes pass writes 0–2 durable one-liners (Facts rows) and any standing
 *     rule the person stated; a failure there means no notes, nothing else.
 *
 * Sources and owners (a conversation's owner is decided by code, never a model):
 *   web chat   .team/users/<slug>/chats/*.jsonl        → user:<slug>
 *   Telegram   the bot's log, one source per chat_id    → user:<roster owner of that chat>
 *   group      .group-watcher/<gid>-history.jsonl       → group:<gid> (registered groups only)
 * A DM nobody on the roster owns is never filed under anyone.
 *
 * Per source a watermark (the last message filed), so each message is filed once;
 * a source is due when it has new messages and has been quiet for 15 minutes.
 * A window with no human message in it (a reminder the bot sent that nobody
 * answered) is a schedule by-product, not a memory, and is skipped.
 */
import { tasksCreatedDuring, linkFactToTask } from './memory-task-links.js';
import { filesWrittenDuring, linkFactToFiles } from './memory-file-links.js';
import { orgContext } from './memory-org.js';
import * as facts from './memory-facts.js';
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ledger from './memory-ledger.js';
import * as router from './memory-router.js';
import { addAsk, listRules, decisions as askDecisions } from './memory-asks.js';
import * as sharing from './memory-sharing.js';
import { knownNames, knownKinds, dismissedNames } from './memory-views.js';
import { getTeamMode, isAllowedGroup, dmOwnerSlug, primaryAdminSlug, list as rosterList } from './team.js';

const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };
const IDLE_MS      = num('MEMORY_V4_IDLE_SECONDS', 900) * 1000;
let traceOnce = false;   // one tick's trace on request (the canary asks), MEMORY_TRACE=1 for all
/** How long a conversation must be quiet before it is filed. */
export const idleMs = () => IDLE_MS;
const FIRST_RUN_MS = num('MEMORY_V4_FIRST_RUN_HOURS', 48) * 3600_000;   // no watermark yet → look this far back
const MAX_PER_TICK = num('MEMORY_V4_MAX_PER_TICK', 3);
const MAX_MESSAGES = 400;                                               // per source per tick; the rest waits
const CHUNK_CHARS  = 2500;
const NOTES_RETRIES = 3;                                                // failed notes calls before a window is filed without notes
const ASSISTANT_CLAMP = 1500;                                           // long drafts / tool dumps → their start
const DEDUPE_DAYS  = 7;
const TELEGRAM_LOG = () => process.env.TELEGRAM_LOG_PATH || '/home/bot/.telegram/conversation.jsonl';

function projectDir() { return process.env.PROJECT_DIR || '/home/coder/project'; }
function statePath() { return join(projectDir(), 'memory', '_engine', 'consolidator.json'); }

export function readState() {
  try { return JSON.parse(readFileSync(statePath(), 'utf8')); } catch { return { sources: {}, runs: [] }; }
}
function writeState(st) {
  mkdirSync(join(projectDir(), 'memory', '_engine'), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(st, null, 1));
}

// ─── names ───────────────────────────────────────────────────────────────────

let botNameCache = null;
async function botName() {
  if (botNameCache) return botNameCache;
  try { botNameCache = (await import('./branding.js')).resolve().botName || 'Assistant'; } catch { botNameCache = 'Assistant'; }
  return botNameCache;
}
function personName(slug) {
  try {
    const u = rosterList().find(x => x.slug === slug);
    if (u?.displayName) return u.displayName;
  } catch { /* no roster */ }
  return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : 'User';
}

/** Web chats of a solo deployment can live under 'default'; they belong to its owner. */
function ownerOf(slug) {
  if (slug !== 'default') return slug;
  const p = primaryAdminSlug();
  return p && p !== 'default' ? p : null;
}

// ─── sources ─────────────────────────────────────────────────────────────────

function readJsonl(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of raw.split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* torn line */ } }
  return out;
}

/** Normalised messages of one source: [{ ts, human, speaker, text }], oldest first. */
async function messagesOf(src) {
  const assistant = await botName();
  const rows = readJsonl(src.path);
  const out = [];
  for (const m of rows) {
    const ts = String(m.ts || '');
    if (!ts) continue;
    let text = String(m.text ?? '').trim();
    if (!text) continue;
    let human, speaker, worked = false;
    // The person sent something to look at — a photo, a file — and the reply
    // reads it: that reply reports what it found, with the person's own
    // material as its source. On Telegram the transcript has no tool marks at
    // all, so a meeting read off a screenshot was a recital and never a fact.
    const readsWhatWasSent = !!out.length && out[out.length - 1].human && out[out.length - 1].sent;
    if (src.kind === 'web') {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      // An answer written with a web page open may quote the page — untrusted text.
      if (m.role === 'assistant' && m.page) continue;
      human = m.role === 'user';
      speaker = human ? src.name : assistant;
      // An answer written after a tool that READS THE WORLD (a mailbox, a
      // calendar, an integration, a page, a file) reports what the assistant
      // FOUND — a source. Any other answer — no tool, or tools that only read
      // memory back — is a recital of what it already knew. The web transcript
      // keeps the tool steps; other channels carry no such mark.
      worked = !human && (isFinding(m.tools) || readsWhatWasSent);
    } else if (src.kind === 'dm') {
      if ((m.chat_id == null ? '' : String(m.chat_id)) !== src.chatId) continue;
      human = m.direction === 'inbound';
      speaker = human ? src.name : assistant;
      worked = !human && readsWhatWasSent;
    } else {
      human = m.role !== 'assistant';
      speaker = human ? (String(m.who || '').trim() || 'Someone') : assistant;
    }
    if (!human && text.length > ASSISTANT_CLAMP) text = `${text.slice(0, ASSISTANT_CLAMP - 300)} […]`;
    // What the person attached: a Telegram row's kind (photo, document, voice…), or the
    // attachment block the web chat appends to the message.
    const sent = human && ((src.kind === 'dm' && !!m.kind && m.kind !== 'text') || (src.kind === 'web' && /\.attachments\//.test(text)));
    out.push({ ts, human, worked, speaker, text: text.replace(/\n{3,}/g, '\n\n'), ...(sent ? { sent: true } : {}), ...(Array.isArray(m.tools) ? { tools: m.tools.map(t => String(t?.name || '')).filter(Boolean) } : {}) });
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/** Every source that could hold something new, with its owner scope. */
export function listSources() {
  const base = projectDir();
  const out = [];
  try {
    const usersRoot = join(base, '.team', 'users');
    for (const u of readdirSync(usersRoot, { withFileTypes: true })) {
      if (!u.isDirectory() || !/^[a-z0-9-]+$/.test(u.name)) continue;
      const owner = ownerOf(u.name);
      if (!owner) continue;
      const dir = join(usersRoot, u.name, 'chats');
      let files; try { files = readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const path = join(dir, f);
        let st; try { st = statSync(path); } catch { continue; }
        out.push({ id: `web:${u.name}:${f}`, kind: 'web', path, mtime: st.mtimeMs, owner, scope: `user:${owner}`, name: personName(owner), conv: `web:${f.replace(/\.jsonl$/, '')}` });
      }
    }
  } catch { /* no web chats */ }

  try {
    const path = TELEGRAM_LOG();
    const st = statSync(path);
    // One log holds every DM; a chat's own last message is its "mtime", so a busy
    // chat does not make every other chat look due.
    const lastByChat = new Map();
    for (const m of readJsonl(path)) {
      const c = m.chat_id == null ? '' : String(m.chat_id);
      if (!c || c.startsWith('-')) continue;
      lastByChat.set(c, Math.max(lastByChat.get(c) || 0, Date.parse(m.ts || '') || st.mtimeMs));
    }
    for (const [chatId, last] of lastByChat) {
      const owner = dmOwnerSlug(chatId);
      if (!owner || owner === 'default') continue;
      out.push({ id: `dm:${chatId}`, kind: 'dm', path, chatId, mtime: last, owner, scope: `user:${owner}`, name: personName(owner), conv: `tg:${chatId}` });
    }
  } catch { /* no Telegram log */ }

  try {
    const dir = join(base, '.group-watcher');
    for (const f of readdirSync(dir)) {
      const m = f.match(/^(-\d{4,20})-history\.jsonl$/);
      if (!m || !isAllowedGroup(m[1])) continue;
      const path = join(dir, f);
      let st; try { st = statSync(path); } catch { continue; }
      out.push({ id: `group:${m[1]}`, kind: 'group', path, mtime: st.mtimeMs, owner: null, scope: `group:${m[1]}`, name: 'the team', conv: `group:${m[1]}` });
    }
  } catch { /* no groups */ }
  return out;
}

// Tools that write a file in the workspace (not memory's own write tool).
const WRITES_FILES = /^(Write|Edit|MultiEdit|NotebookEdit)$|^mcp__.*(write_file|create_file|save_file|render_pdf|create_pdf)/;

// ─── chunking ────────────────────────────────────────────────────────────────

// The assistant's own turns are kept short in a record: asked "what do you
// know about me?", the bot recites its memory, and filed whole that answer
// became new facts and topics about the person — memory feeding on itself.
// The person's words are the memory; the bot's reply is context, a line of it.
// A turn written after a tool that reads the world is different: it reports
// what the bot FOUND (a mailbox read, a calendar checked, a page fetched) —
// kept in full, within reason, and labelled so the notes pass may treat it
// as a source. Which tools read the world is an ALLOWLIST — web search and
// fetch, the browser tab, and every integration in the catalog except the
// ones that generate, translate or deliver — so the default is "recital": a
// tool added later is not a finding until it is listed. (The old rule was the
// inverse, a deny list of memory tools; the day memory_now was missing from
// it, a "what's in Right now?" recital came back as three fresh facts, one
// with a guessed trip end the person had never said.)
const HERE = dirname(fileURLToPath(import.meta.url));
// Not the file tools: "what do you know about me?" answered by reading the
// memory files with Read or Bash is a recital too (seen in a replay — every
// such answer came back marked as a finding).
const READING_TOOLS = /^(WebSearch|WebFetch)$|(^|__)(tab_snapshot|tab_screenshot|use_integrations)$/;
const NOT_A_FINDING = new Set(['openai', 'gemini-chat', 'grok', 'nano-banana', 'seedream', 'deepl', 'telegram']);
const READING_MCPS = (() => {
  const names = new Set(['playwright', 'google-workspace', 'email']);
  try {
    for (const i of JSON.parse(readFileSync(join(HERE, '..', 'integrations.catalog.json'), 'utf8')).integrations || []) {
      const n = i?.mcp?.name || i?.id;
      if (n && !NOT_A_FINDING.has(n)) names.add(n);
    }
  } catch { /* the built-ins stand */ }
  return names;
})();
/** Did this turn's tools read the world? (A failed call reads nothing.) */
export function isFinding(tools) {
  if (!Array.isArray(tools)) return false;
  return tools.some(t => {
    if (!t || t.ok === false) return false;
    const name = String(t.name || '');
    if (READING_TOOLS.test(name)) return true;
    const m = name.match(/^mcp__([a-z0-9-]+)__/i);
    return !!m && READING_MCPS.has(m[1].toLowerCase());
  });
}
const ASSISTANT_CHARS = 200;
const WORKED_CHARS = 2000;
function line(m) {
  if (m.worked) {
    const text = m.text.length <= WORKED_CHARS ? m.text : `${m.text.slice(0, WORKED_CHARS).trimEnd()}…`;
    return `${m.speaker} (after checking): ${text}`;
  }
  const text = m.human || m.text.length <= ASSISTANT_CHARS ? m.text : `${m.text.slice(0, ASSISTANT_CHARS).trimEnd()}…`;
  return `${m.speaker}: ${text}`;
}

/** Cut messages into ≤ CHUNK_CHARS chunks at message boundaries. */
export function chunk(messages) {
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const m of messages) {
    const l = line(m).slice(0, 11000);
    if (cur.length && len + l.length + 1 > CHUNK_CHARS) { chunks.push(cur); cur = []; len = 0; }
    cur.push({ ...m, line: l });
    len += l.length + 1;
  }
  if (cur.length) chunks.push(cur);
  return chunks.map(c => ({ ts: c[0].ts, speaker: c.find(m => m.human)?.speaker || c[0].speaker, text: c.map(m => m.line).join('\n'), messages: c }));
}

// ─── one source ──────────────────────────────────────────────────────────────

const SOURCE_OF = { web: 'web', dm: 'telegram', group: 'group' };

/**
 * File the new messages of one source. Returns counts; never throws — a failure
 * is reported so the tick can log it loudly, and the watermark is only moved
 * once the records are on disk.
 */
export async function consolidateSource(src, { state, now = Date.now() }) {
  const prev = state.sources[src.id] || {};
  const w = prev.lastTs || new Date(now - FIRST_RUN_MS).toISOString();
  // A message whose every line its owner erased stays erased, whatever window it
  // is re-read in.
  const erased = (m) => line(m).split('\n').filter(l => l.trim()).every(l => ledger.isTombstoned(l));
  const all = (await messagesOf(src)).filter(m => m.ts > w && !erased(m));
  const fresh = all.slice(0, MAX_MESSAGES);
  const result = { id: src.id, records: 0, shared: 0, asks: 0, notes: 0, rules: 0, titles: [], skipped: null, errors: [] };
  // `mtime` = the version of the source already looked at; left behind when more
  // messages wait, so the source is due again on the next tick.
  const seen = all.length > MAX_MESSAGES ? prev.mtime || 0 : src.mtime;
  if (!fresh.length) { state.sources[src.id] = { ...prev, mtime: src.mtime }; return { ...result, skipped: 'nothing new' }; }
  const lastTs = fresh[fresh.length - 1].ts;
  const advance = () => { state.sources[src.id] = { lastTs, mtime: seen, at: new Date(now).toISOString() }; };

  if (!fresh.some(m => m.human)) { advance(); return { ...result, skipped: 'no human message' }; }

  const text = fresh.map(line).join('\n');
  const group = src.kind === 'group';

  // The router (who may read what) sees the whole window. A failed call is
  // not a decision: nothing is filed and the next tick retries the window —
  // three times, then it is filed as private with nothing offered to the
  // team, loudly. (A night when the model was down once filed every window
  // without a sharing decision, and nothing ever came back to them.)
  let routed = null;
  if (!group) {
    try {
      routed = await router.route({ name: src.name, channel: SOURCE_OF[src.kind], ts: fresh[0].ts, text, org: orgContext({ person: src.name }) });
    } catch (e) {
      const tries = prev.notesFailures || 0;
      if (tries < NOTES_RETRIES) {
        result.errors.push(`router: ${e.message} — nothing filed, the window is retried next tick (${tries + 1}/${NOTES_RETRIES})`);
        state.sources[src.id] = { ...prev, notesFailures: tries + 1 };
        return result;
      }
      result.errors.push(`router: ${e.message} — filed private, nothing offered to the team, after ${tries} failed ticks`);
    }
  }

  // Near-verbatim repeats inside a week (the same message sent twice) are not re-filed.
  const since = new Date(now - DEDUPE_DAYS * 86400_000).toISOString();
  const known = new Set(ledger.read({ scopes: [src.scope], since, includeHidden: true }).map(r => ledger.contentHash(r.text)));

  // The notes pass runs PER CHUNK — the text the model reads is the record it
  // writes to, so a quote is attested against exactly what will be on disk, a
  // name travels with the chunk that holds it, and no call is ever bigger than
  // one record. (A source with days to catch up once came in as one window of
  // 234 lines; the one call for it timed out and twelve records were filed with
  // no notes.) Every call is made before anything is written: a failed call
  // files nothing and the watermark stays, so the next tick retries the window
  // — three times, then it is filed without notes, loudly.
  const chunks = chunk(fresh);
  const noted = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (known.has(ledger.contentHash(c.text))) { noted.push(null); continue; }
    // What people said — plus what the assistant found with its tools: a note's
    // evidence and a topic's name must be attested there, never only in a reply
    // the assistant wrote from what it already knew.
    const spoken = c.messages.filter(m => m.human || m.worked).map(line).join('\n');
    try {
      // Tasks put on the board while this was being said: the model may tie a note to the one it was made for.
      const span = { from: c.ts, to: c.messages[c.messages.length - 1]?.ts || c.ts, owner: src.owner, group };
      const boardTasks = tasksCreatedDuring(span);
      // Only a file this conversation is about: one it names, or any written
      // while the assistant here used a tool that writes files. A file is found
      // by its time alone, and in a group a slide another job wrote in that
      // minute was linked to the group's decision as "the one file it wrote".
      const wroteHere = c.messages.some(m => (m.tools || []).some(t => WRITES_FILES.test(t)));
      const named = (f) => c.text.toLowerCase().includes(String(f.path).split('/').pop().toLowerCase());
      const written = filesWrittenDuring(span).filter(f => wroteHere || named(f));
      const n = await router.notes({ tasks: boardTasks, files: written, name: src.name, group, ...(group ? {} : { org: orgContext({ person: src.name }) }), ts: c.ts, text: c.text, attest: spoken, known: knownNames([src.scope, 'shared']), kinds: knownKinds([src.scope, 'shared']), exclude: [await botName(), ...dismissedNames(src.scope)], max: router.notesCap(c.messages.filter(m => m.human).length) });
      // Where each note stands: on what a person said, or on what the
      // assistant found — its quote is in one or the other. One standing for
      // the whole chunk once marked a registry check "said".
      const said = c.messages.filter(m => m.human).map(line).join('\n');
      for (const x of n?.notes || []) x.standing = router.isVerbatim(x.evidence, said, 8) || router.isNearVerbatim(x.evidence, said) ? 'said' : 'found';
      if (n) n.written = written;   // what the filing loop below links
      noted.push(n);
      // MEMORY_TRACE=1: what the gate saw and did, one line per chunk, for a
      // replay to read — the standing of every line, the candidates kept and
      // the ones rejected with the reason.
      if (process.env.MEMORY_TRACE || traceOnce) {
        try {
          mkdirSync(join(projectDir(), 'memory', '_engine'), { recursive: true });
          // Outside the project tree (turns read it) and readable by workspace-api alone.
          const traceDir = join(process.env.WSAPI_STORE_DIR || '/var/wsapi-store', 'trace');
          try { mkdirSync(traceDir, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
          appendFileSync(join(traceDir, 'consolidator.jsonl'), JSON.stringify({
            ts: new Date(now).toISOString(), src: src.id, scope: src.scope, chunk: `${i + 1}/${chunks.length}`, tasks: boardTasks.map(t => t.id), written: written.map(f => f.path),
            lines: c.messages.map(m => ({ who: m.speaker, standing: m.human ? 'said' : m.worked ? 'found' : 'recital', ...(m.tools?.length ? { tools: m.tools } : {}), text: m.text.slice(0, 200) })),
            kept: (n?.notes || []).map(x => ({ title: x.title, text: x.text, kind: x.kind, about: x.about, when: x.when, expires: x.expires, evidence: x.evidence })),
            rejected: n?.rejected || [], entities: n?.entities || [], rules: n?.rules || [],
          }) + '\n', { mode: 0o600 });
        } catch { /* a trace is never worth a failed filing */ }
      }
    } catch (e) {
      const tries = prev.notesFailures || 0;
      if (tries < NOTES_RETRIES) {
        result.errors.push(`notes: ${e.message} — nothing filed, the window is retried next tick (${tries + 1}/${NOTES_RETRIES})`);
        state.sources[src.id] = { ...prev, notesFailures: tries + 1 };
        return result;
      }
      result.errors.push(`notes: ${e.message} — chunk ${i + 1}/${chunks.length} filed without notes after ${tries} failed ticks`);
      noted.push(null);
    }
  }
  result.dropped = noted.reduce((a, n) => a + (n?.dropped || 0), 0);

  // What may reach the team from this conversation, per fact: the person's
  // mode, their standing rules and earlier answers (lib/memory-sharing.js).
  const gate = src.owner && routed ? { mode: sharing.modeOf(src.owner), rules: listRules(src.owner), decided: askDecisions(src.owner) } : null;
  const sharedIds = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (known.has(ledger.contentHash(c.text))) continue;
      const n = noted[i];
      const tags = {};
      if (n?.rules?.length) tags.rules = n.rules;
      // Names the chunk is about — attested in its own lines — so a topic's
      // records are the ones that mention it.
      if (n?.entities?.length) tags.entities = n.entities;
      // The conversation is recorded as it was; what it holds goes to the facts
      // store (lib/memory-facts.js), which keeps one fact per thing: a repeat
      // confirms the fact memory has, a change replaces it.
      const r = await ledger.append({ scope: src.scope, source: SOURCE_OF[src.kind], ts: c.ts, conv: src.conv, speaker: c.speaker, text: c.text, tags });
      if (r.ok) {
        result.records++; result.rules += tags.rules?.length || 0;
        if (n?.notes?.length) {
          // `convSince`: this window is one conversation; an earlier window of
          // the same chat is another (lib/memory-facts.js, apply).
          const got = await facts.remember(src.scope, n.notes, { record: r.id, ts: c.ts, entities: n.entities || [], by: SOURCE_OF[src.kind], standing: 'said', conv: src.conv, convSince: fresh[0].ts });
          result.notes += got.added; result.updated = (result.updated || 0) + got.updated.length; result.superseded = (result.superseded || 0) + got.superseded.length;
          for (const t of got.titles) if (result.titles.length < 5) result.titles.push(t);
          // A note the model tied to a task made during this conversation: the
          // fact and the task point at each other from now on.
          // A conversation that wrote exactly one file wrote it for what it was
          // about: that file is every note's, whether the model said so or not.
          const theFile = (n.written || []).length === 1 ? [n.written[0].path] : null;
          for (const [ni, nt] of n.notes.entries()) {
            const files = nt.files?.length ? nt.files : theFile;
            if (!nt.task && !files) continue;
            try {
              // The fact that stands for this note now — a new one, or the one it
              // confirmed (the bot often notes the same thing during the turn).
              const standsFor = got.linkable?.[ni] ?? got.linkable?.[nt.text];
              const f = (standsFor && facts.get(src.scope, standsFor))
                || facts.all(src.scope).filter(x => x.text === nt.text && !x.retired && !x.hidden).sort((a, b) => (a.ts < b.ts ? 1 : -1))[0];
              if (!f) continue;
              if (nt.task && await linkFactToTask(src.scope, f.id, nt.task)) result.linked = (result.linked || 0) + 1;
              if (files && await linkFactToFiles(src.scope, f.id, files)) result.filesLinked = (result.filesLinked || 0) + 1;
            } catch (e) { process.stderr.write(`[memory-v4] link: ${e.message}\n`); }
          }
          // Each fact goes to the team, to a question, or stays — the fact,
          // never the excerpt. A fact that merely repeats one memory holds
          // (nothing added) is not offered again.
          if (gate && got.added) {
            // Only what this batch actually added: a note that merely confirmed or
            // merged into a fact memory had is not offered again (no second question).
            for (const [fi, f] of n.notes.entries()) {
              if (got.fresh && !got.fresh[fi]) continue;
              const d = sharing.decide({ mode: gate.mode, fact: f, routed, rules: gate.rules, decided: gate.decided });
              if (d.outcome === 'team') {
                const out = await sharing.fileTeamFact(src.owner, f, { ts: c.ts, conv: src.conv, source: SOURCE_OF[src.kind], name: src.name, by: SOURCE_OF[src.kind] });
                if (out.recordId) { result.shared++; sharedIds.push(out.recordId); }
              } else if (d.outcome === 'ask') {
                addAsk(src.owner, { text: f.text, question: routed.askQuestion || '', conv: src.conv, ts: c.ts, source: SOURCE_OF[src.kind], fact: f, reason: d.reason, key: sharing.factKey(f) });
                result.asks++;
              }
            }
          }
        }
      }
    }
    const sharedId = sharedIds[0] || null;
    if (result.records) {
      // `dropped`: notes the model offered whose quote was not in the person's
      // words — visible in Changes, so a thin filing is not a silent one.
      ledger.logEvent({ op: 'file', scope: src.scope, source: SOURCE_OF[src.kind], conv: src.conv, records: result.records, notes: result.notes, rules: result.rules, dropped: result.dropped || 0, ...(result.updated ? { updated: result.updated } : {}), ...(result.superseded ? { superseded: result.superseded } : {}), ...(result.titles.length ? { titles: result.titles } : {}), shared: sharedId, asks: result.asks });
    }
  } catch (e) {
    result.errors.push(`append: ${e.message}`);
    return result;                     // watermark stays: the next tick retries this window
  }
  advance();
  return result;
}

// ─── the tick ────────────────────────────────────────────────────────────────

let running = false;

/**
 * File every due source (capped per tick). Single-flight; safe to call on a
 * timer. Off unless MEMORY_V4 is shadow/read/on.
 */
export async function consolidateIdle({ force = false, now = Date.now(), trace = false } = {}) {
  if (trace) traceOnce = true;
  if (ledger.v4Mode() === 'off' && !force) return { ok: true, skipped: 'off' };
  if (running) return { ok: true, skipped: 'in-progress' };
  running = true;
  try {
    const state = readState();
    state.sources ||= {};
    const due = listSources()
      .filter(s => s.mtime > (state.sources[s.id]?.mtime || 0) && now - s.mtime >= IDLE_MS)
      .sort((a, b) => a.mtime - b.mtime);
    const results = [];
    for (const src of due.slice(0, MAX_PER_TICK)) {
      results.push(await consolidateSource(src, { state, now }));
      writeState(state);
    }
    const sum = (k) => results.reduce((s, r) => s + (r[k] || 0), 0);
    const failures = results.filter(r => r.errors.length);
    traceOnce = false;
    const summary = { ok: true, sources: results.length, records: sum('records'), shared: sum('shared'), asks: sum('asks'), notes: sum('notes'), linked: sum('linked'), filesLinked: sum('filesLinked'), pending: Math.max(0, due.length - MAX_PER_TICK), failures: failures.map(r => ({ id: r.id, errors: r.errors })) };
    if (results.length) {
      state.runs = [...(state.runs || []), { at: new Date(now).toISOString(), ...summary }].slice(-50);
      writeState(state);
    }
    for (const f of failures) process.stderr.write(`[memory-v4] ${f.id}: ${f.errors.join('; ')}\n`);
    return summary;
  } finally {
    running = false;
  }
}

export { messagesOf as _messagesOfForTests };
