/**
 * Granola, read as the workspace (lib/integrations/mcp-client.js): the
 * meetings since a time, and one meeting's notes and transcript. The server
 * answers in a light XML-ish text (list, notes) and JSON (transcript); the
 * parsers here take exactly the fields memory needs and nothing else is
 * interpreted. Verified against the hosted server on 2026-10-05.
 */
import { textOf } from '../integrations/mcp-client.js';

const unescape = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** "Oct 5, 2026 5:00 PM GMT+7" → ISO; null when it cannot be read. */
export function parseDate(s) {
  const t = String(s || '').trim().replace(/GMT([+-])(\d)(?::?(\d{2}))?$/, (_, sign, h, m) => `GMT${sign}0${h}${m || '00'}`).replace(/GMT([+-])(\d{2})(?::?(\d{2}))?$/, (_, sign, h, m) => `GMT${sign}${h}${m || '00'}`);
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** "Ola Nowak (note creator) from Quillwork <ola@q.test>, Marek <m@x.test>" → ["Ola Nowak", "Marek"] */
export function parseParticipants(s) {
  return unescape(s).split(/,\s*(?![^<]*>)/).map(p => p.replace(/\(note creator\)/i, '').replace(/\s+from\s+.*$/i, '').replace(/<[^>]*>/g, '').trim()).filter(Boolean);
}

/** The same, with each one's address kept ("Marek <m@x.test>"): a placeholder name ("Kontakt") is resolved by its address. */
export function parseParticipantsWithAddresses(s) {
  return unescape(s).split(/,\s*(?![^<]*>)/).map(p => { const addr = p.match(/<([^>]*)>/)?.[1]; const name = p.replace(/\(note creator\)/i, '').replace(/\s+from\s+.*$/i, '').replace(/<[^>]*>/g, '').trim(); return name ? (addr ? `${name} <${addr}>` : name) : (addr || ''); }).filter(Boolean);
}

const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? unescape(m[1]) : ''; };

/** The meetings in a list or notes answer: id, title, time, people, link (+ summary when present). */
export function parseMeetings(text) {
  const out = [];
  const re = /<meeting\b([^>]*)>([\s\S]*?)<\/meeting>/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const tag = m[1], body = m[2];
    const people = body.match(/<known_participants>([\s\S]*?)<\/known_participants>/);
    const summary = body.match(/<summary>([\s\S]*?)<\/summary>/);
    out.push({
      id: attr(tag, 'id'), title: attr(tag, 'title'), at: parseDate(attr(tag, 'date')), url: attr(tag, 'url') || null,
      participants: people ? parseParticipants(people[1]) : [],
      participantsLine: people ? parseParticipantsWithAddresses(people[1]) : [],
      summary: summary ? unescape(summary[1]).trim() : '',
    });
  }
  return out.filter(x => x.id);
}

/** The transcript answer: JSON after a preamble line. */
export function parseTranscript(text) {
  const s = String(text || '');
  const i = s.indexOf('{');
  if (i < 0) return { transcript: '', at: null };
  try {
    const o = JSON.parse(s.slice(i));
    return { transcript: String(o.transcript || '').trim(), at: o.created_at ? parseDate(o.created_at) : null, title: o.title || '' };
  } catch { return { transcript: '', at: null }; }
}

export default {
  id: 'granola',
  /** Meetings started in [since, until]. */
  async list(client, { since, until }) {
    const r = await client.callTool({ name: 'list_meetings', arguments: { time_range: 'custom', custom_start: new Date(since).toISOString(), custom_end: new Date(until).toISOString() } });
    return parseMeetings(textOf(r)).map(({ summary, ...m }) => m);
  },
  /** One meeting: notes and transcript. */
  async get(client, id) {
    const notes = await client.callTool({ name: 'get_meetings', arguments: { meeting_ids: [id] } });
    const m = parseMeetings(textOf(notes))[0] || { id, title: '', at: null, participants: [], url: null, summary: '' };
    let t = { transcript: '', at: null };
    try { t = parseTranscript(textOf(await client.callTool({ name: 'get_meeting_transcript', arguments: { meeting_id: id } }))); } catch { /* no transcript on this plan */ }
    return { ...m, at: m.at || t.at, title: m.title || t.title || '', transcript: t.transcript };
  },
};
