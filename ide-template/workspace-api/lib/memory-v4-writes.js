/**
 * memory-v4-writes — where a memory_write lands once memory v4 is the memory.
 *
 * The model's instructions (global-claude.md, the skill fence, the planner and
 * memory-cards skills) have long said "record a duty with memory_write into
 * RESPONSIBILITIES" and "save facts with memory_write". After the move (0005) the
 * card files those writes named are gone, and writing them again would recreate
 * files nothing loads — a duty saved that way would silently do nothing. So with
 * v4 on, the same calls land where v4 keeps things:
 *
 *   RESPONSIBILITIES                  → the person's routines.json
 *   a card v4 still loads             → the engine, as before (return null)
 *   anything else (pages, other cards)→ a ledger note in the right scope
 *   supersede of a duty               → that routine, updated
 *   supersede of anything else        → a newer note (in v4 the later one wins)
 *   retire of a duty                  → that routine, retired
 *   rename_entity                     → an alias (topics merge, reversibly)
 *
 * Returns the response to send, or null when the engine should handle the call.
 */
import * as ledger from './memory-ledger.js';
import * as facts from './memory-facts.js';
import { decideAlias } from './memory-views.js';
import { V4_LOAD_ORDER } from './memory-registry.js';
import { parseLegacyCard, readRoutines, writeRoutines, moveRoutines } from './routines-store.js';
import { primaryAdminSlug, getTeamMode } from './team.js';

const V4_CARDS = new Set(V4_LOAD_ORDER.map(c => c.id));
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Whose routines.json: the person in team mode, the single 'default' store in solo. */
export function routinesOwner(slug) {
  const team = getTeamMode();
  // Routines follow the mode, like the admin's cards: solo reads 'default',
  // team reads the admin's own list. Whichever side is not current is folded
  // in on the way (a cheap existence check when there is nothing to move), so
  // the switch — or a workspace that was switched before this existed — never
  // leaves the screen empty with the routines sitting in the other file.
  const admin = primaryAdminSlug();
  if (admin && admin !== 'default') {
    try {
      if (team) moveRoutines('default', admin);
      else moveRoutines(admin, 'default');
    } catch (err) {
      process.stderr.write(`[routines] fold for the ${team ? 'team' : 'solo'} switch failed: ${err.message}\n`);
    }
  }
  return team ? slug : 'default';
}

/**
 * A duty in the card grammar (`{icon} **Title** — what to do, how often #tag`),
 * or null. The old fallback took ANY text as a duty, which is how "the user
 * sold their Notely account" ended up on the duties card: a fact, not a duty.
 * Without a bold title there is nothing to fire, so the caller is told to save
 * it as a fact instead.
 */
// An emoji in front of the title is how a model naturally writes "an icon"; the
// grammar wants an icon name in braces. Accept both: a known emoji becomes its
// icon name, any other is dropped (the routine still saves, with the default icon).
const EMOJI_ICON = {
  '🔔': 'bell', '⏰': 'clock', '🕐': 'clock', '📧': 'mail', '✉️': 'mail', '📨': 'mail', '📬': 'mail',
  '📅': 'calendar', '🗓️': 'calendar', '📆': 'calendar', '💰': 'money', '💸': 'money', '🧾': 'receipt',
  '📊': 'trend', '📈': 'trend', '📚': 'book', '📖': 'book', '🎬': 'book', '📝': 'file', '📄': 'file',
  '✅': 'check', '☑️': 'check', '🔍': 'search', '🔎': 'search', '⭐': 'star', '🚀': 'rocket', '📣': 'megaphone',
  '👥': 'users', '💬': 'message', '🔄': 'refresh', '🛡️': 'shield', '⚠️': 'warning', '👀': 'watch', '📁': 'folder',
  '☀️': 'sun', '🌤️': 'weather', '🌦️': 'weather', '📌': 'star', '📋': 'tasks',
};
function parseDuty(text) {
  let t = String(text || '').trim().replace(/^[-*]\s+/, '');
  const em = t.match(/^([\p{Extended_Pictographic}\u2600-\u27BF][\uFE0F\u200D\p{Extended_Pictographic}]*)\s*/u);
  if (em) {
    const name = EMOJI_ICON[em[1]] || EMOJI_ICON[em[1].replace(/\uFE0F/g, '')];
    t = `${name ? `{${name}} ` : ''}${t.slice(em[0].length)}`;
  }
  return parseLegacyCard(`## Responsibilities\n- ${t}`).routines[0] || null;
}

/** The live routine a correction or retirement is about, by its title or wording. */
function findRoutine(list, match) {
  const m = norm(match);
  if (!m) return -1;
  return list.findIndex(r => !r.retired && (norm(r.title) === m || m.includes(norm(r.title)) || norm(`${r.title} ${r.description}`).includes(m)));
}

export async function v4Write({ op, body, actor, inGroup, groupId, scope, owner }) {
  if (ledger.v4Mode() !== 'on') return null;
  const me = actor && actor !== 'default' ? actor : primaryAdminSlug();

  if (op === 'remember') {
    if (body.card === 'RESPONSIBILITIES') {
      if (inGroup) return { status: 403, body: { ok: false, error: 'duties are private — record them in a direct conversation' } };
      const key = routinesOwner(owner || me);
      if (!key || (key === 'default' && getTeamMode())) return { status: 422, body: { ok: false, error: 'no person to record the duty for' } };
      const store = readRoutines(key);
      const duty = parseDuty(body.text);
      if (!duty) return { status: 422, body: { ok: false, error: 'not a duty: write a routine as `**Short title** — what to do, where to look and how often #tag`, optionally starting with an icon name in braces such as `{bell}` or `{mail}`. A fact or a status about the person is saved with memory_note instead.' } };
      const i = store.routines.findIndex(r => !r.retired && norm(r.title) === norm(duty.title));
      if (i >= 0) store.routines[i] = { ...store.routines[i], ...duty, source: 'bot' };
      else store.routines.push({ ...duty, source: 'bot' });
      const saved = writeRoutines(key, store);
      const r = i >= 0 ? saved.routines[i] : saved.routines[saved.routines.length - 1];
      return { status: 200, body: { ok: true, target: 'routines', routine_id: r.id, updated: i >= 0, note: 'saved to their Routines' } };
    }
    if (body.card && V4_CARDS.has(body.card)) return null;
    // A page or a card v4 no longer loads: the fact becomes a note in the ledger.
    const text = String(body.text || '').trim();
    if (!text) return { status: 400, body: { ok: false, error: 'text required' } };
    const target = inGroup ? (groupId ? `group:${groupId}` : 'shared') : scope === 'private' ? `user:${owner || me}` : 'shared';
    const r = await ledger.append({
      scope: target, source: 'note', speaker: null,
      text: body.page ? `${String(body.page).replace(/-/g, ' ')}: ${text}` : text,
      origin: target === 'shared' && !inGroup && me ? `user:${me}` : null,
      tags: body.page ? { entities: [{ name: String(body.page).replace(/-/g, ' '), kind: 'topic' }] } : {},
    });
    if (!r.ok) return { status: 422, body: { ok: false, error: 'erased by its owner — not saved again' } };
    // The record is what was asked to be kept; the fact goes to the facts store,
    // one per thing like any other (a repeat confirms, a change replaces).
    const got = await facts.remember(target, [{ text, kind: 'fact' }], { record: r.id, standing: 'note', by: 'note', entities: body.page ? [{ name: String(body.page).replace(/-/g, ' '), kind: 'topic' }] : [] });
    ledger.logEvent({ op: 'note', scope: target, ids: [r.id], by: me || null });
    return { status: 200, body: { ok: true, target: 'memory', id: got.ids[0] || r.id, ...(got.replaced.length ? { replaced: got.replaced } : {}), ...(got.updated?.length ? { updated: got.updated } : {}), ...(got.superseded?.length ? { superseded: got.superseded } : {}), ...(got.confirmed && !got.added ? { already: true } : {}) } };
  }

  if (op === 'supersede' || op === 'retire') {
    if (!inGroup) {
      const key = routinesOwner(me);
      if (key) {
        const store = readRoutines(key);
        const i = findRoutine(store.routines, body.match);
        if (i >= 0) {
          const duty = op === 'retire' ? null : parseDuty(body.text);
          if (op !== 'retire' && !duty) return { status: 422, body: { ok: false, error: 'not a duty: write the routine again as `**Short title** — what to do and how often #tag` (an icon name in braces like `{bell}` may come first)' } };
          // An edited routine drops its catalog one-liner: the old summary would
          // describe what it no longer does. (It keeps catalogId — still "Added".)
          const { summary: _old, ...cur } = store.routines[i];
          store.routines[i] = op === 'retire'
            ? { ...store.routines[i], retired: true, source: 'bot' }
            : { ...cur, ...duty, source: 'bot' };
          writeRoutines(key, store);
          return { status: 200, body: { ok: true, target: 'routines', routine_id: store.routines[i].id, [op === 'retire' ? 'retired' : 'updated']: true } };
        }
      }
    }
    // Not a duty: a card claim is corrected by the engine (and a fact the engine
    // cannot find any more is saved again as a newer note — v4SupersedeFallback).
    return null;
  }

  if (op === 'rename_entity' && body.from && body.to) {
    decideAlias({ from: String(body.from), into: String(body.to), same: true });
    return { status: 200, body: { ok: true, target: 'topics', note: `${body.from} is now shown as ${body.to}` } };
  }
  return null;
}

/**
 * After the engine could not find a claim to correct (the old pages are gone),
 * a supersede still means "this is true now": saved as a newer note.
 */
export async function v4SupersedeFallback({ body, actor, inGroup, groupId }) {
  if (ledger.v4Mode() !== 'on') return null;
  const text = String(body.text || '').trim();
  if (!text) return null;
  const me = actor && actor !== 'default' ? actor : primaryAdminSlug();
  const target = inGroup ? (groupId ? `group:${groupId}` : 'shared') : `user:${me}`;
  const r = await ledger.append({ scope: target, source: 'note', text });
  if (!r.ok) return null;
  const got = await facts.remember(target, [{ text, kind: 'fact' }], { record: r.id, standing: 'note', by: 'note' });
  return { status: 200, body: { ok: true, target: 'memory', id: got.ids[0] || r.id, note: got.replaced.length ? `replaces: ${got.replaced.join('; ')}` : got.updated?.length ? `remark added to: ${got.updated.join('; ')}` : got.superseded?.length ? `marks no longer true: ${got.superseded.join('; ')}` : 'saved' } };
}
