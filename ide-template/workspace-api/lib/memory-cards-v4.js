/**
 * memory-cards-v4 — sorting the v3 cards into what memory v4 keeps where.
 *
 * The move (0005) left three cards alone because v4 still loads them into every
 * turn: USER_PROFILE, USER_PREFERENCES and RULES. On the canary they had become
 * the place everything went: the profile held 37 lines (facts with dates, live
 * statuses, every project — each a Topics tile already), the preferences held
 * one-off task instructions beside standing ones, RULES held tool tips for the
 * bot. The same fact then reached the prompt twice (card + ledger) and the
 * cards grew without bound.
 *
 * One structured call per card sorts every bullet:
 *   profile    — who the person is, stable for months → stays (USER_PROFILE)
 *   preference — how they want things done, standing  → stays (USER_PREFERENCES)
 *   one-off    — a rule that was for one task/client    → the ledger, dated (not a standing rule)
 *   fact       — something that happened or is so now  → the ledger, dated
 *   status     — true for a while                       → the ledger, with expiry
 *   project    — a venture or project                   → the ledger (a Topic)
 *   tool       — how the assistant should use a tool    → AGENT_TOOLS
 *   team       — a hard team rule                       → RULES
 *   duplicate  — says what an earlier line says         → dropped (the earlier one stays)
 *   superseded — a later line holds the current value  → the ledger, marked past
 * Every kept line is the original bullet, verbatim (the model only labels; it
 * writes nothing), so nothing can be invented. A bullet the model does not
 * label keeps its card. A duplicate carries `by`, the line it repeats: the
 * migration drops a line only on that evidence (on the canary a current fact
 * came back as a duplicate of nothing).
 */
import { runStructured } from './memory-llm.js';

export const KINDS = ['profile', 'preference', 'one-off', 'fact', 'status', 'project', 'tool', 'team', 'log', 'duplicate', 'superseded'];
const DATE_RE = /\[Source:[^\]]*?(\d{4}-\d{2}-\d{2})[^\]]*\]/i;
/** The latest ISO date the bullet itself mentions ("as of 2026-09-29", "(noted 2026-09-03)"), not later than today. */
function dateIn(text) {
  const today = new Date().toISOString().slice(0, 10);
  return (String(text).match(/\b\d{4}-\d{2}-\d{2}\b/g) || []).filter(d => d <= today).sort().pop() || null;
}

export const SORT_SYSTEM = `You tidy the memory cards of an AI assistant that works with one person. You get the bullets of ONE card, numbered. Label each bullet with exactly one kind:
- profile: who the person is — name, roles, where they live, languages, birthday, mailboxes, chat ids, working hours. Stable for months.
- preference: a standing rule for how they want things done, from now on, in general — language, tone, formatting, channels, when to ask. Not tied to one task or one client.
- one-off: an instruction that was for ONE task, document, client, project or occasion — "in the pitch deck, avoid…", "for the VC list, format as…", "on this audit, only count…", "Trello: the X review workflow", "never count Y in the Z timesheet" — and does not bind future work in general. A rule that names a specific client, project, tool workflow or document is one-off even when written as "never"/"always". The old memory saved these as standing rules; they are not.
- fact: something that happened, was decided or is the case, with or without a date — a job change, a sale, an admin item, a rate. Belongs in a dated record, not on a profile.
- status: true only for a while — a trip, a current location, "waiting on X", "currently focused on". Give "expires" (ISO date) when the bullet implies one.
- project: a venture, product or project the person runs or works on. It is a topic of its own, not a profile line.
- tool: how the assistant should use a tool, skill, integration or file path. Not about the person.
- team: a hard rule for everyone on the team (never / always), about people or data — not about a tool.
- log: the assistant's OWN working record — a run history, audit findings, housekeeping counts ("auto-wiped 2 stale files"), first-run markers, what a skill did on a date. Working state, not memory of the person or the team.
- duplicate: says what an EARLIER bullet in this list already says (same fact, possibly older). Label the later one duplicate; never the first. Give "by": the number of the bullet it repeats.
- superseded: a LATER bullet in this list states the current value of the same thing, and this one is the old value (a role since changed, a plan since dropped, a status since replaced). Label the EARLIER one superseded; the later one keeps its own kind. Give "by": the number of the bullet that supersedes it.
Label only. Never rewrite a bullet. Answer for every number.`;

export const SORT_SCHEMA = {
  type: 'object',
  properties: {
    labels: {
      type: 'array',
      items: {
        type: 'object',
        properties: { n: { type: 'integer' }, kind: { type: 'string', enum: KINDS }, expires: { type: ['string', 'null'] }, by: { type: ['integer', 'null'] } },
        required: ['n', 'kind'],
      },
    },
  },
  required: ['labels'],
};

/** Bullets of a card body as [{ n, line, text, section, date }]; frontmatter and comments skipped. */
/**
 * The old wiki wrote notes to itself about how to file things (ABOUT pages,
 * "use a topic page when…", "this dir is only for…"). That is the previous
 * system's documentation, not a memory: dropped before any model sees it.
 */
export function isSystemSelfDescription({ page = '', text = '' }) {
  if (/(^|\/)ABOUT\.md$/i.test(page)) return true;
  return /^(use a topic page|don't use a topic page|when you promote a card section|this dir is\b|per-topic deep dives|each `<slug>\.md`)/i.test(String(text).trim());
}

/**
 * A card bullet as plain text: bold/italic markers, backticks and wiki links
 * off ("**Beacon** — see [[beacon]]" → "Beacon — see beacon"). A note is shown
 * as text on the Facts tab and in the recall block, never rendered.
 */
export function plainText(s) {
  return String(s || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1$2').replace(/`([^`]+)`/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s{2,}/g, ' ').trim();
}

export function bullets(md) {
  const body = String(md || '').replace(/^---[\s\S]*?\n---\n/, '').replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  let section = '';
  for (const raw of body.split('\n')) {
    const h = raw.match(/^#{2,6}\s+(.*)$/);
    if (h) { section = h[1].trim(); continue; }
    if (!/^\s*[-*]\s+\S/.test(raw)) continue;
    const line = raw.trim();
    const text = line.replace(/^[-*]\s+/, '').replace(/\s*\[Source:[^\]]*\]\s*$/i, '').trim();
    if (!text) continue;
    // Dated by its source tag, else by the latest date it states itself; a
    // bullet with neither is undated (the migration then says "known by" the
    // card's last change, never "today").
    out.push({ n: out.length + 1, line, text, section, date: line.match(DATE_RE)?.[1] || dateIn(text) });
  }
  return out;
}

/**
 * Sort one card's bullets. Returns the bullets with `kind` (and `expires`) set;
 * an unlabelled bullet keeps `kind: null` and stays where it is. Throws when
 * the model fails twice — the caller then leaves the card untouched.
 */
const BATCH = 12;   // a 37-line card in one call timed out on the pinned CLI
// A sorter call on the canary took 75–90 s alone and longer under load; the
// module default (2 min) is for a turn, not a migration. Ten minutes here.
const SORT_TIMEOUT_MS = Number(process.env.MEMORY_V4_SORT_TIMEOUT_MS) || 10 * 60_000;
// Two at a time, not four: on the 4 GB canary four parallel calls pushed one
// past its timeout and cost the whole run. Slower, and it finishes.
const CONCURRENCY = 2;

/** How many sorter calls `md` will take — for progress totals before any call is made. */
export function batchCount(md) { return Math.ceil(bullets(md).length / BATCH); }

/**
 * Sort one card's bullets. Batches run `concurrency` at a time (on the canary
 * one call took ~75 s, and 125 of them in a row was two and a half hours);
 * "duplicate / superseded of another line" still holds because every batch is
 * shown ALL the other lines, labelled or not. `onBatch()` fires as each batch
 * lands; `shouldStop()` is checked before each batch so a cancel from the
 * screen takes effect within one call.
 */
export async function sortCard({ card, md, name = 'the person', runner = runStructured, onBatch = null, shouldStop = null, concurrency = CONCURRENCY }) {
  const list = bullets(md);
  if (!list.length) return [];
  const all = list.map(b => `${b.n}. [${b.section || card}] ${b.text}`).join('\n');
  const batches = [];
  for (let i = 0; i < list.length; i += BATCH) batches.push(list.slice(i, i + BATCH));
  const byN = new Map();
  const failures = [];
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      if (shouldStop?.()) throw new Error('cancelled');
      const batch = batches[next++];
      const want = batch.map(b => b.n).join(', ');
      let raw = null;
      try {
        raw = await runner({
          system: SORT_SYSTEM,
          user: `Card: ${card} (about ${name})\n\nALL LINES (for duplicate and superseded checks):\n${all}\n\nLABEL ONLY THESE NUMBERS: ${want}`,
          schema: SORT_SCHEMA,
          timeoutMs: SORT_TIMEOUT_MS,
        });
      } catch (e) {
        // One batch failing (a timeout, a bad answer) must not cost the run:
        // its lines stay unlabelled — and an unlabelled line keeps its card,
        // which is the safe outcome. Counted so the plan can say so.
        failures.push({ batch: want, error: String(e?.message || e).slice(0, 200) });
      }
      for (const l of Array.isArray(raw?.labels) ? raw.labels : []) {
        const n = Number(l?.n);
        if (batch.some(b => b.n === n)) byN.set(n, l);
      }
      onBatch?.(failures.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  const out = list.map(b => {
    const l = byN.get(b.n);
    const kind = l && KINDS.includes(l.kind) ? l.kind : null;
    const expires = kind === 'status' && /^\d{4}-\d{2}-\d{2}/.test(String(l?.expires || '')) ? String(l.expires).slice(0, 10) : null;
    const by = (kind === 'superseded' || kind === 'duplicate') && Number.isInteger(l?.by) ? l.by : null;
    return { ...b, kind, expires, by };
  });
  out.failures = failures;
  return out;
}

/** Which card a kind belongs on after sorting; null = the ledger; 'drop' = gone. */
export function destinationOf(kind, card) {
  switch (kind) {
    case 'profile': return 'USER_PROFILE';
    case 'preference': return 'USER_PREFERENCES';
    case 'one-off': return null;   // a dated record: findable when that context returns, carried by no turn
    case 'tool': return 'AGENT_TOOLS';
    case 'team': return 'RULES';
    case 'fact': case 'status': case 'project': return null;
    case 'log': return 'drop';        // the bot's working state belongs in .bot-state, never in memory
    case 'duplicate': return 'drop';
    case 'superseded': return null;   // a dated record, folded as past: the later value is the current one
    default: return card;   // unlabelled: stays
  }
}
