/**
 * How the planner's reminders landed — what the next plan learns from.
 *
 * The planner placed reminders and never heard what came of them: whether the
 * bot said something when one fired or stayed silent, whether the person wrote
 * back, whether they took a routine off. This reads it back for one person
 * over the last days, per routine:
 *   - fired reminders: the planner's one-shots the monitor settled as sent
 *     (they stay in .reminders.json as tombstones for 30 days, with their
 *     `routine` and `kind_of` — info or action);
 *   - the outcome of each run (said / silent / sent itself), recorded here by
 *     /internal/invoke-turn when it delivers a planner reminder's result;
 *   - whether the person wrote within ANSWER_WINDOW after it: their web chats
 *     and their Telegram DMs;
 *   - routines they removed lately.
 * Silence after an `info` reminder is not a signal — a weather note is read
 * and that's it; the summary says so, so the planner changes an info routine
 * only on an explicit signal.
 */
import { readFileSync, appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { dmOwnerSlug, getTeamMode, primaryAdminSlug } from './team.js';
import { readRoutines } from './routines-store.js';
import { routinesOwner } from './memory-v4-writes.js';

const project = () => process.env.PROJECT_DIR || '/home/coder/project';
const OUTCOMES = () => join(process.env.WSAPI_STORE_DIR || '/var/wsapi-store', 'planner', 'outcomes.jsonl');
const TG_LOG = () => process.env.TELEGRAM_LOG_PATH || '/home/bot/.telegram/conversation.jsonl';
const ANSWER_WINDOW_MS = 2 * 3600_000;

function readJsonl(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** One planner reminder's run: said something, stayed silent, or messaged them itself. */
export function recordOutcome({ id, slug, outcome }) {
  if (!id || !slug || !['said', 'silent', 'sent-itself'].includes(outcome)) return;
  try {
    mkdirSync(dirname(OUTCOMES()), { recursive: true });
    appendFileSync(OUTCOMES(), JSON.stringify({ ts: new Date().toISOString(), id: String(id), slug, outcome }) + '\n');
  } catch (err) { process.stderr.write(`[planner-feedback] outcome not recorded: ${err.message}\n`); }
}

// The times the person wrote — web chats and Telegram DMs — since `since`.
function personWrote(slug, since) {
  const out = [];
  const solo = !getTeamMode() && slug === primaryAdminSlug();
  for (const who of solo ? [slug, 'default'] : [slug]) {
    const dir = join(project(), '.team', 'users', who, 'chats');
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { /* no web chats */ }
    for (const f of files) {
      for (const m of readJsonl(join(dir, f))) {
        const t = Date.parse(m.ts || '');
        if (m.role === 'user' && t >= since) out.push(t);
      }
    }
  }
  for (const m of readJsonl(TG_LOG())) {
    if (m.direction !== 'inbound') continue;
    const t = Date.parse(m.ts || '');
    if (!(t >= since)) continue;
    const owner = dmOwnerSlug(m.chat_id == null ? '' : String(m.chat_id));
    if (owner === slug || (solo && owner === 'default')) out.push(t);
  }
  return out.sort((a, b) => a - b);
}

/** The summary for the planner (memory_now), or '' when there is nothing to tell yet. */
export function plannerFeedback(slug, { now = Date.now(), days = 7 } = {}) {
  if (!slug) return '';
  const since = now - days * 86400_000;
  let reminders = [];
  try { reminders = JSON.parse(readFileSync(join(project(), '.reminders.json'), 'utf8')); } catch { /* none */ }
  const forThem = (r) => (Array.isArray(r.recipients) && r.recipients.length
    ? r.recipients.length === 1 && r.recipients[0] === slug
    : !getTeamMode());
  const all = Array.isArray(reminders) ? reminders : [];
  // Suggestions (a routine or an integration offered once, `routine: "suggest:<what>"`):
  // told separately and over the whole retention window, placed or already fired,
  // so the same thing is never offered twice.
  const isSuggestion = (r) => String(r.routine || '').startsWith('suggest:');
  const suggested = all.filter((r) => r && r.origin === 'planner' && isSuggestion(r) && forThem(r))
    .map((r) => `- ${String(r.routine).slice(8).trim()} (${String(r.settledAt || r.due || '').slice(0, 10)}${r.status === 'pending' ? ', still to come' : ''})`);
  const fired = all.filter((r) => r && r.origin === 'planner' && !r.recur && !isSuggestion(r)
    && r.status === 'sent' && forThem(r) && Date.parse(r.settledAt || '') >= since);
  const outcome = new Map(readJsonl(OUTCOMES()).filter((o) => o.slug === slug).map((o) => [o.id, o.outcome]));
  const wrote = personWrote(slug, since);
  const answered = (t) => wrote.some((w) => w > t && w <= t + ANSWER_WINDOW_MS);

  const groups = new Map();
  for (const r of fired) {
    const key = String(r.routine || r.title || 'a reminder').trim();
    const g = groups.get(key) || { kind: r.kind_of || null, n: 0, said: 0, silent: 0, answered: 0 };
    g.n++;
    if (r.kind_of && !g.kind) g.kind = r.kind_of;
    const o = outcome.get(r.id);
    if (o === 'said' || o === 'sent-itself') g.said++;
    else if (o === 'silent') g.silent++;
    if (answered(Date.parse(r.settledAt))) g.answered++;
    groups.set(key, g);
  }

  const lines = [];
  for (const [key, g] of [...groups].sort((a, b) => b[1].n - a[1].n)) {
    const ran = g.said || g.silent ? ` — you spoke ${g.said}×, stayed silent ${g.silent}×` : '';
    if (g.kind === 'info') lines.push(`- ${key} (info): ${g.n} fired${ran}. No reply is expected; change it only if they asked for less or more.`);
    else lines.push(`- ${key}${g.kind ? ` (${g.kind})` : ''}: ${g.n} fired${ran}; they wrote within 2 h after ${g.answered} of them.`);
  }
  try {
    for (const r of readRoutines(routinesOwner(slug)).routines) {
      if (r.retired && Date.parse(r.updatedAt || '') >= since) lines.push(`- They removed the routine "${r.title}" on ${String(r.updatedAt).slice(0, 10)}.`);
    }
  } catch { /* no routines */ }
  const parts = [];
  if (lines.length) parts.push([`How the plan's reminders landed for them (last ${days} days):`, ...lines].join('\n'));
  if (suggested.length) parts.push(['Suggested to them lately (never offer these again):', ...suggested].join('\n'));
  return parts.join('\n\n');
}
