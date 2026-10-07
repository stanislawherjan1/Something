/**
 * A meeting notetaker read as the workspace, for the services whose hosted
 * MCP server we know by its tool NAMES (published) but not by every argument
 * and field (their schemas sit behind a login). So the adapter is driven by
 * what the server itself declares:
 *
 *  - the tools: the first of the configured names the server lists;
 *  - the arguments: filled from the tool's own inputSchema, by the API field
 *    names services use for a date range, an id, a limit, an "include" flag;
 *  - the answer: JSON when it is JSON (after any preamble), the items found
 *    wherever the list sits, each field taken from the names services use;
 *    plain text otherwise (a transcript or a summary as the service wrote it).
 *
 * Anything it cannot read throws, and lib/memory-sources.js reads that
 * service's notes through a turn instead — a service that answers
 * differently than expected never loses a night.
 */
import { textOf } from '../integrations/mcp-client.js';

// ─── answers ─────────────────────────────────────────────────────────────────

const PREAMBLE = /^[^{[]*?(?=[{[])/s;
/** JSON after a preamble line ("The content below is …"), or null. */
export function json(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  for (const cut of [s, s.replace(PREAMBLE, '')]) { try { return JSON.parse(cut); } catch { /* not this */ } }
  return null;
}

const ID = ['id', 'transcriptId', 'transcript_id', 'meeting_id', 'meetingId', 'recording_id', 'recordingId', 'conversation_id', 'conversationId', 'otid', 'speech_id', 'ulid', 'document_id', 'documentId', 'uuid'];
const TITLE = ['title', 'meeting_title', 'meetingTitle', 'name', 'subject', 'topic'];
const WHEN = ['start_time', 'startTime', 'started_at', 'startedAt', 'scheduled_start_time', 'recording_start_time', 'meeting_start_time', 'start', 'date', 'dateString', 'datetime', 'created_at', 'createdAt'];
const PEOPLE = ['participants', 'attendees', 'calendar_invitees', 'invitees', 'speakers', 'meeting_attendees'];
const SUMMARY = ['summary', 'default_summary', 'overview', 'short_summary', 'notes', 'meeting_notes', 'recap', 'key_points', 'keyPoints'];
const ACTIONS = ['action_items', 'actionItems', 'action_items_list', 'tasks'];
const TRANSCRIPT = ['transcript', 'sentences', 'transcript_text', 'segments', 'utterances', 'speeches'];
const URL = ['url', 'transcript_url', 'share_url', 'report_url', 'meeting_url', 'link', 'web_url'];

const pick = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return null; };

/** A time in any of the shapes services use: ISO, epoch ms or s, "Oct 5, 2026 5:00 PM GMT+7". */
export function when(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d{10,13}$/.test(String(v))) { const n = Number(v); const ms = n < 1e12 ? n * 1000 : n; return new Date(ms).toISOString(); }
  const s = String(v).replace(/GMT([+-])(\d{1,2})(?::?(\d{2}))?$/, (_, g, h, m) => `GMT${g}${String(h).padStart(2, '0')}${m || '00'}`);
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const nameOf = (p) => (typeof p === 'string' ? p : p && (p.name || p.displayName || p.display_name || p.full_name || p.speaker_name || p.email || p.email_address)) || '';
const people = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/,\s*/) : []).map(p => String(nameOf(p)).replace(/<[^>]*>/g, '').trim()).filter(Boolean).slice(0, 30);

/** A summary in whatever shape: text, markdown, or an object of sections. */
export function prose(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map(x => (typeof x === 'string' ? `- ${x}` : `- ${prose(pick(x, ['text', 'description', 'title', 'content']) ?? x)}`)).join('\n');
  if (typeof v === 'object') {
    const direct = pick(v, ['markdown_formatted', 'markdown', 'text', 'content', 'overview', 'short_summary']);
    const rest = Object.entries(v).filter(([k, x]) => x && !['markdown_formatted', 'markdown', 'text', 'content'].includes(k) && (typeof x === 'string' || Array.isArray(x)));
    return [direct ? prose(direct) : null, ...rest.filter(([k]) => k !== 'overview' && k !== 'short_summary').map(([k, x]) => `${k.replace(/_/g, ' ')}:\n${prose(x)}`)].filter(Boolean).join('\n\n').trim();
  }
  return String(v);
}

/** A transcript as "Speaker: words" lines, from text or from segments. */
export function lines(v) {
  if (v == null) return '';
  // "[00:05 - 00:08] Ola: …" (Fireflies) or "[00:02](https://…?timestamp=2) Ola: …" (Fathom): the stamp goes.
  if (typeof v === 'string') return v.split('\n').map(l => l.replace(/^\s*\[[\d:.\s-]+\](\([^)]*\))?\s*/, '')).join('\n').trim();
  if (Array.isArray(v)) return v.map(x => { if (typeof x === 'string') return x; const who = nameOf(x.speaker) || x.speaker_name || x.speakerName || x.speaker || ''; const said = x.text || x.raw_text || x.content || x.transcript || ''; return said ? (who ? `${who}: ${said}` : said) : ''; }).filter(Boolean).join('\n').trim();
  if (typeof v === 'object') return lines(pick(v, ['text', 'sentences', 'segments', 'utterances']));
  return '';
}

/** The array of items in an answer, wherever it sits (top level, data, meetings, items, results …). */
export function items(o, depth = 0) {
  if (!o || depth > 3) return [];
  if (Array.isArray(o)) return o.filter(x => x && typeof x === 'object' && pick(x, ID));
  for (const v of Object.values(o)) if (Array.isArray(v) && v.some(x => x && typeof x === 'object' && pick(x, ID))) return items(v, depth + 1);
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Array.isArray(v)) { const got = items(v, depth + 1); if (got.length) return got; }
  return [];
}

/** One meeting's fields from an item object. */
export function meeting(o) {
  const actions = pick(o, ACTIONS);
  const summary = [prose(pick(o, SUMMARY)), actions ? `Action items:\n${prose(actions)}` : ''].filter(Boolean).join('\n\n');
  return {
    id: String(pick(o, ID) ?? ''), title: String(pick(o, TITLE) ?? ''), at: when(pick(o, WHEN)), url: pick(o, URL) ? String(pick(o, URL)) : null,
    participants: people(pick(o, PEOPLE)), summary, transcript: lines(pick(o, TRANSCRIPT)),
  };
}

// ─── arguments, from the tool's own schema ───────────────────────────────────

const ARG = {
  since: ['fromDate', 'from_date', 'from', 'start_date', 'startDate', 'date_from', 'dateFrom', 'created_after', 'createdAfter', 'after', 'since', 'start_time_from', 'start_time_gte', 'started_after', 'min_date', 'start'],
  until: ['toDate', 'to_date', 'to', 'end_date', 'endDate', 'date_to', 'dateTo', 'created_before', 'createdBefore', 'before', 'until', 'start_time_to', 'start_time_lte', 'started_before', 'max_date', 'end'],
  id: ['transcriptId', 'transcript_id', 'meeting_id', 'meetingId', 'recording_id', 'recordingId', 'conversation_id', 'conversationId', 'otid', 'speech_id', 'document_id', 'documentId', 'id'],
  ids: ['ids', 'meeting_ids', 'meetingIds', 'document_ids', 'documentIds', 'recording_ids'],
  limit: ['limit', 'page_size', 'pageSize', 'max_results', 'maxResults', 'count', 'n'],
  yes: ['include_summary', 'includeSummary', 'include_transcript', 'includeTranscript', 'include_action_items', 'includeActionItems', 'mine'],
};
const DATE_ONLY = /date|^from$|^to$/i;

/** Arguments for `tool` from its inputSchema: only properties it declares, with values for what we know. */
export function argsFor(tool, want) {
  const props = tool?.inputSchema?.properties || {};
  const out = {};
  // A value in the type the schema asks for (Fathom's recording_id is an integer).
  const typed = (k, v) => (['integer', 'number'].includes(props[k]?.type) && /^\d+$/.test(String(v)) ? Number(v) : v);
  const set = (keys, v) => { for (const k of keys) if (k in props && v != null) { out[k] = Array.isArray(v) ? v.map(x => typed(k, x)) : typed(k, v); return true; } return false; };
  const asDate = (k, iso) => (props[k]?.format === 'date' || (DATE_ONLY.test(k) && !/time|after|before/i.test(k)) ? iso.slice(0, 10) : iso);
  if (want.since) for (const k of ARG.since) if (k in props) { out[k] = asDate(k, want.since); break; }
  if (want.until) for (const k of ARG.until) if (k in props) { out[k] = asDate(k, want.until); break; }
  // One id: the id property the tool declares, else its list of ids with one in it.
  if (want.id && !set(ARG.id, want.id)) set(ARG.ids, [want.id]);
  if (want.limit) { for (const k of ARG.limit) if (k in props) { const max = props[k]?.maximum; out[k] = max ? Math.min(want.limit, max) : want.limit; break; } }
  for (const k of ARG.yes) if (k in props && props[k]?.type === 'boolean') out[k] = true;
  if ('format' in props && (props.format?.enum || []).includes('json')) out.format = 'json';
  // An enum of what to expand or which documents to get: everything a meeting holds.
  for (const k of ['expand', 'include', 'fields', 'document_types', 'documentTypes', 'types']) {
    const p = props[k];
    const en = p?.items?.enum || p?.enum;
    if (en?.length) out[k] = p.type === 'array' ? en : en.join(',');
  }
  // A required property we could not fill: the call would fail — say so.
  const missing = (tool?.inputSchema?.required || []).filter(k => !(k in out));
  if (missing.length) throw new Error(`${tool.name}: cannot fill ${missing.join(', ')}`);
  return out;
}

// ─── a feeder from a config ──────────────────────────────────────────────────

/**
 * `cfg`: { id, list: [tool names], get?: [tool names], summary?: [names],
 * transcript?: [names], perPage? }. The first listed name the server offers
 * is used for each role.
 */
export function makeFeeder(cfg) {
  const tools = new WeakMap();
  const toolsOf = async (client) => {
    if (!tools.has(client)) tools.set(client, (await client.listTools())?.tools || []);
    return tools.get(client);
  };
  const find = async (client, names) => { const all = await toolsOf(client); for (const n of names || []) { const t = all.find(x => x.name === n); if (t) return t; } return null; };
  const call = async (client, tool, want) => {
    const r = await client.callTool({ name: tool.name, arguments: argsFor(tool, want) });
    if (r?.isError) throw new Error(`${tool.name}: ${textOf(r).slice(0, 200)}`);
    return textOf(r);
  };
  return {
    id: cfg.id,
    async list(client, { since, until }) {
      const tool = await find(client, cfg.list);
      if (!tool) throw new Error(`${cfg.id}: none of ${cfg.list.join(', ')} offered`);
      const text = await call(client, tool, { since, until, limit: cfg.perPage || 50 });
      // The service's own "nothing found" answer (seen live: Fathom's "Found 0 meeting(s).").
      if (cfg.empty && cfg.empty.test(String(text).trim())) return [];
      // A list in the service's own text lines (seen live: Fathom), read by its parser.
      const got = (cfg.parseList && !json(text) ? cfg.parseList(text) : items(json(text)).map(meeting)).filter(m => m.id);
      if (!got.length && String(text).trim() && !json(text)) throw new Error(`${cfg.id}: the list is not in a shape this reader knows`);
      // A service whose list ignores the window: the window is applied here.
      const lo = Date.parse(since) - 86400_000, hi = Date.parse(until);
      return got.filter(m => !m.at || (Date.parse(m.at) >= lo && Date.parse(m.at) <= hi));
    },
    async get(client, id) {
      let m = { id, title: '', at: null, url: null, participants: [], summary: '', transcript: '' };
      const merge = (o) => { for (const [k, v] of Object.entries(o)) if (v && (!Array.isArray(v) || v.length) && !m[k]?.length) m[k] = v; };
      const getTool = await find(client, cfg.get);
      if (getTool) {
        const text = await call(client, getTool, { id });
        const o = json(text);
        const it = o ? (items(o)[0] || (pick(o, ID) ? o : null)) : null;
        if (it) merge(meeting(it)); else if (String(text).trim()) merge({ summary: text.trim() });
      }
      if (!m.summary) { const t = await find(client, cfg.summary); if (t) { const text = await call(client, t, { id }); const o = json(text); const said = o ? (meeting(o).summary || prose(o)) : text.trim(); if (!(cfg.noSummary && cfg.noSummary.test(said))) merge({ summary: said }); } }
      if (!m.transcript) { const t = await find(client, cfg.transcript); if (t) { try { const text = await call(client, t, { id }); const o = json(text); merge({ transcript: o ? (meeting(o).transcript || lines(o)) : lines(text) }); } catch { /* no transcript on this plan */ } } }
      if (!m.summary && !m.transcript) throw new Error(`${cfg.id}: ${id} came back with neither notes nor a transcript`);
      return m;
    },
  };
}

// ─── the five services (tool names as their docs publish them) ───────────────

export const fireflies = makeFeeder({ id: 'fireflies', list: ['fireflies_get_transcripts'], get: ['fireflies_fetch'], summary: ['fireflies_get_summary'], transcript: ['fireflies_get_transcript'] });
/**
 * Fathom's list, as its live server answers (2026-10-06):
 *   Found 1 meeting(s). Each entry has recording_id and url.
 *   - Impromptu Call | 2026-10-06 | id: 189873189 | url: https://fathom.video/calls/850460162 | recorded by Ola Nowak
 */
export function fathomList(text) {
  return String(text || '').split('\n').map(l => l.trim()).filter(l => /^- /.test(l) && /\|\s*id:\s*\d+/.test(l)).map(l => {
    const parts = l.slice(2).split(/\s+\|\s+/);
    const field = (k) => parts.find(p => p.toLowerCase().startsWith(`${k}:`))?.slice(k.length + 1).trim() || null;
    const day = parts.find(p => /^\d{4}-\d{2}-\d{2}/.test(p)) || null;
    const by = parts.find(p => /^recorded by /i.test(p))?.replace(/^recorded by /i, '').trim();
    return { id: field('id'), title: parts[0] || '', at: day ? when(day.length === 10 ? `${day}T12:00:00Z` : day) : null, url: field('url'), participants: by ? [by] : [], summary: '', transcript: '' };
  });
}
// Fathom: tool names, argument schemas and answers checked against the live server (2026-10-06).
export const fathom = makeFeeder({ id: 'fathom', list: ['list_meetings'], get: [], summary: ['get_meeting_summary'], transcript: ['get_meeting_transcript'], empty: /^Found 0 meeting/i, parseList: fathomList, noSummary: /^No summary available/i });
export const otter = makeFeeder({ id: 'otter', list: ['list_meetings', 'list_conversations'], get: ['get_meeting', 'get_conversation'], summary: ['get_meeting_summary', 'get_summary'], transcript: ['get_transcript'] });
export const readai = makeFeeder({ id: 'readai', list: ['list_meetings'], get: ['get_meeting_by_id', 'get_meeting'], summary: ['get_meeting_summary'], transcript: ['get_meeting_transcript', 'get_transcript'] });
export const krisp = makeFeeder({ id: 'krisp', list: ['search_meetings', 'list_meetings'], get: ['get_multiple_documents', 'get_document', 'get_meeting'], summary: [], transcript: [] });
