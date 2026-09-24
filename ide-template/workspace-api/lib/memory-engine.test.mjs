/**
 * Guards for the memory ENGINE — the one write path.
 *
 * These encode the failures the engine was built to end, each one observed in
 * the live system before the rebuild:
 *   - a correction landed BESIDE the falsehood instead of replacing it;
 *   - the same falsehood lived in several files, so fixing one copy let it come
 *     back from another weeks later;
 *   - a correction was silently dropped as a "duplicate";
 *   - a wrong page NAME kept being re-learned as canonical;
 *   - "strike, never delete" left the error in the always-loaded prompt;
 *   - a revert would have discarded everything written after it.
 *
 * Run: node lib/memory-engine.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'mem-engine-'));
process.env.PROJECT_DIR = ROOT;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}`); }
};

const engine = await import('./memory-engine.js');
const mem = join(ROOT, 'memory');
const read = (p) => { try { return readFileSync(join(ROOT, p), 'utf8'); } catch { return ''; } };

mkdirSync(join(mem, 'users', 'stan'), { recursive: true });
mkdirSync(join(mem, 'concepts'), { recursive: true });
writeFileSync(join(mem, 'RULES.md'), '---\ncard: RULES\n---\n\n# RULES\n\n## Never\n- send mail without approval\n');
writeFileSync(join(mem, 'AGENT_TOOLS.md'), '---\ncard: AGENT_TOOLS\n---\n\n# AGENT_TOOLS\n\n## Trello\n- use the board id, not the name\n');
writeFileSync(join(mem, 'users', 'stan', 'RESPONSIBILITIES.md'),
  '---\ncard: RESPONSIBILITIES\n---\n\n# Responsibilities\n\n## Responsibilities\n- {mail} **Morning inbox pass** — each morning, flag what matters. #email\n');
writeFileSync(join(mem, 'users', 'stan', 'USER_PROFILE.md'),
  '---\ncard: USER_PROFILE\n---\n\n# USER_PROFILE\n\n## Identity\n- Name: Viktor\n- Based in: Warsaw, Poland\n');

// ─── (a) remember: routing, sections, page creation ──────────────────────────

// RESPONSIBILITIES declares ONE FLAT LIST in its own frontmatter. A model
// passing the duty's own title as `section` used to spawn a heading of its own,
// so the duty lived twice — once in the list the Routines panel and the planner
// read, once where only the engine looked. The later edit matched the invisible
// copy and the user was told it was done. (Live, 2026-09-24.)
engine.remember({
  actor: 'stan', scope: 'private', owner: 'stan', card: 'RESPONSIBILITIES',
  section: 'Hourly Email Watch',
  text: '{mail} **Hourly email watch** — every hour, check the inbox. #email',
});
{
  const card = read('memory/users/stan/RESPONSIBILITIES.md');
  ok('a flat-list card ignores the requested section',
    !/^## Hourly Email Watch/m.test(card), card);
  ok('the duty lands in the one list the readers parse',
    /## Responsibilities\n- \{mail\} \*\*Morning inbox pass\*\*[^\n]*\n- \{mail\} \*\*Hourly email watch\*\*/.test(card), card);
  ok('the flat-list card grew no second heading',
    (card.match(/^## /gm) || []).length === 1, card);
}

// `## Never` is half of RULES. A live AGENT_TOOLS card grew one of its own,
// holding a constraint no reader of the rules card ever saw. Refused, not
// re-routed: only the caller knows whether the claim is a rule or a tool note.
{
  const r = engine.remember({ actor: 'stan', scope: 'shared', card: 'AGENT_TOOLS', section: 'Never', text: 'never send mail unattended' });
  ok('a heading reserved for another card is refused', r.ok === false && /RULES/.test(r.error || ''), r);
  ok('and nothing was written', !/^## Never/m.test(read('memory/AGENT_TOOLS.md')), read('memory/AGENT_TOOLS.md'));
  const r2 = engine.remember({ actor: 'stan', scope: 'shared', card: 'RULES', section: 'Always', text: 'always show the draft first' });
  ok('the same section on its own card is fine', r2.ok === true, r2);
}

// Repair: a card that grew a second heading of the same name, and a flat-list
// card whose duties parked under headings of their own. Content MOVES; nothing
// is dropped.
{
  const twice = [
    '---', 'card: RULES', '---', '', '# RULES', '',
    '## Never', '- alpha', '', '## Always', '- gamma', '',
    '## Never', '- beta', '', '## Always', '- delta', '',
  ].join('\n');
  const fixed = engine.repairCardText(twice).text;
  ok('duplicate headings collapse into the first', (fixed.match(/^## Never/gm) || []).length === 1, fixed);
  ok('no rule is lost in the merge',
    ['alpha', 'beta', 'gamma', 'delta'].every(x => fixed.includes(`- ${x}`)), fixed);

  const scattered = [
    '---', 'card: RESPONSIBILITIES', '---', '', '# Responsibilities', '',
    '## Responsibilities', '- {mail} **A** — one. #x', '',
    '## Hourly Email Watch', '- {mail} **B** — two. #y', '',
    '## Standing Checks', '- C every evening', '',
  ].join('\n');
  const folded = engine.repairCardText(scattered, { flatHeading: 'Responsibilities' }).text;
  ok('a flat-list card ends with exactly one heading', (folded.match(/^## /gm) || []).length === 1, folded);
  ok('every stray duty is folded into the list',
    /\*\*A\*\*/.test(folded) && /\*\*B\*\*/.test(folded) && /- C every evening/.test(folded), folded);

  const clean = ['---', 'card: RULES', '---', '', '# RULES', '', '## Never', '- alpha', ''].join('\n');
  ok('a healthy card reports no change', engine.repairCardText(clean).moved === 0);
}

// Frontmatter is a card's instructions, and `key: value` is exactly the shape
// isClaimLine accepts — so `write_how: One responsibility per line …` matched as
// a claim, and a supersede could have rewritten a card's own specification.
{
  writeFileSync(join(mem, 'users', 'stan', 'USER_REFLECTIONS.md'),
    '---\ncard: USER_REFLECTIONS\nwrite_how: One reflection per line under the dated heading\n---\n\n# USER_REFLECTIONS\n\n## 2026-01-01\n- one reflection per line is easy to read\n');
  const hits = engine.findClaims('One reflection per line', { actor: 'stan' });
  ok('frontmatter is not searched for claims',
    hits.every(h => h.line > 4), JSON.stringify(hits));
  ok('but the real claim below it still matches', hits.length === 1, JSON.stringify(hits));
}

// An entry written without its list marker is invisible to findClaims, so the
// engine can neither correct nor retire it — a duty sat on a live card, shown in
// the panel, while every edit landed elsewhere. The repair gives the marker back.
{
  const unmarked = [
    '---', 'card: RESPONSIBILITIES', '---', '', '# Responsibilities', '',
    '## Responsibilities',
    'mail **Hourly email watch** — every hour, check the inbox. #email',
    '- {file} **Weekly recap** — each Friday. #team', '',
  ].join('\n');
  const healed = engine.repairCardText(unmarked, { flatHeading: 'Responsibilities' }).text;
  ok('an unmarked entry gets its list marker back',
    /^- mail \*\*Hourly email watch\*\*/m.test(healed), healed);
  ok('an entry that already had one is untouched',
    (healed.match(/^- \{file\} \*\*Weekly recap\*\*/gm) || []).length === 1, healed);
}

// repairCards over the real tree. The pure function was tested first and the
// walker was not, so a double-joined path made the whole pass a silent no-op:
// it reported "nothing to do" over cards that were visibly broken.
{
  writeFileSync(join(mem, 'users', 'stan', 'USER_PREFERENCES.md'),
    '---\ncard: USER_PREFERENCES\n---\n\n# USER_PREFERENCES\n\n## Communication\n- terse\n\n## Communication\n- no preamble\n');
  const dry = engine.repairCards({ actor: 'test', dryRun: true });
  ok('the walk reaches a per-user card', dry.some(r => r.file.includes('users/stan/USER_PREFERENCES.md')), dry);
  ok('a dry run writes nothing',
    (read('memory/users/stan/USER_PREFERENCES.md').match(/^## Communication/gm) || []).length === 2);

  engine.repairCards({ actor: 'test' });
  const fixed = read('memory/users/stan/USER_PREFERENCES.md');
  ok('applying the repair collapses the duplicate', (fixed.match(/^## Communication/gm) || []).length === 1, fixed);
  ok('and keeps both preferences', /- terse/.test(fixed) && /- no preamble/.test(fixed), fixed);
  ok('a second run is a no-op', engine.repairCards({ actor: 'test', dryRun: true }).every(r => !r.file.includes('USER_PREFERENCES')));
}

// Punctuation drift is the same heading: a card that sprouts `## Working-style`
// beside `## Working style` splits what every reader treats as one place.
engine.remember({ actor: 'stan', scope: 'shared', card: 'AGENT_TOOLS', section: 'trello', text: 'archive, never delete a list' });
engine.remember({ actor: 'stan', scope: 'shared', card: 'AGENT_TOOLS', section: 'Trello!', text: 'card ids are opaque' });
{
  const card = read('memory/AGENT_TOOLS.md');
  ok('a punctuation-drifted section reuses the existing heading',
    (card.match(/^## Trello/gm) || []).length === 1, card);
}

let r = engine.remember({ actor: 'stan', scope: 'shared', card: 'RULES', section: 'Never', text: 'never deploy on Friday' });
ok('remember writes into the named section', r.ok && /## Never\n- send mail without approval\n- never deploy on Friday/.test(read('memory/RULES.md')), r);

// A case-drifted section name must NOT create a second heading — that was a real
// source of duplicate `## Identity` blocks on cards.
engine.remember({ actor: 'stan', scope: 'shared', card: 'RULES', section: 'never', text: 'never force-push main' });
ok('a case-drifted section reuses the existing heading',
  (read('memory/RULES.md').match(/^## Never$/gim) || []).length === 1
  && read('memory/RULES.md').includes('never force-push main'));

r = engine.remember({ actor: 'stan', scope: 'shared', page: 'acme', text: 'Renews its contract annually in Q3' });
ok('remember seeds a new concept page and cites the write',
  r.ok && read('memory/concepts/acme.md').includes('kind: concept')
  && /- Renews its contract annually in Q3 {2}\[Source: /.test(read('memory/concepts/acme.md')), r);

r = engine.remember({ actor: 'stan', scope: 'shared', page: 'acme', text: 'Renews its contract annually in Q3' });
ok('re-remembering the same fact is a no-op, not a duplicate line', r.ok && r.noop === true);

// ─── (b) the correction reflex: remember must refuse to state it twice ───────
r = engine.remember({ actor: 'stan', scope: 'shared', page: 'acme', text: 'Renews its contract monthly now, not annually' });
ok('remember refuses a rival claim and points at supersede',
  r.ok === false && r.needs_supersede === true && /annually in Q3/.test(r.existing || ''), r);
ok('...and nothing was written', (read('memory/concepts/acme.md').match(/Renews its contract/g) || []).length === 1);

// ─── (c) supersede is TRANSITIVE — every copy, not just the first ────────────
// The live failure: one name was corrected in one place and survived elsewhere
// for six weeks. Plant the same claim in three files, correct it once.
writeFileSync(join(mem, 'concepts', 'viktor.md'),
  '---\ntitle: Viktor\nkind: concept\n---\n\n## Claims\n- Viktor is the lead designer on the rebrand  [Source: distilled 2026-07-14]\n');
engine.remember({ actor: 'stan', scope: 'private', owner: 'stan', card: 'USER_RELATIONSHIPS', section: 'People', text: 'Viktor is the lead designer on the rebrand' });

r = engine.supersede({
  actor: 'stan',
  match: 'Viktor is the lead designer on the rebrand',
  text: 'Marek is the lead designer on the rebrand',
  source: 'correction',
});
ok('supersede replaces every copy across files', r.ok && r.targets.length >= 2, r);
const afterAll = ['memory/concepts/viktor.md', 'memory/users/stan/USER_RELATIONSHIPS.md'].map(read).join('\n');
ok('no copy of the old claim survives anywhere', !/Viktor is the lead designer/.test(afterAll), afterAll);
ok('the correction is present in each file', (afterAll.match(/Marek is the lead designer/g) || []).length >= 2);
ok('the retired wording leaves NO trace on the page (no ~~, no [was:])',
  !/~~|\[was:/.test(afterAll), afterAll);

// ─── (d) ambiguity is refused, not guessed ──────────────────────────────────
writeFileSync(join(mem, 'concepts', 'pricing.md'),
  '---\ntitle: Pricing\nkind: concept\n---\n\n## Claims\n- Standard rate is 400 per day\n- Rush rate is 600 per day\n');
r = engine.supersede({ actor: 'stan', match: 'rate is per day', text: 'Standard rate is 450 per day' });
ok('supersede refuses when several different claims match',
  r.ok === false && Array.isArray(r.ambiguous) && r.ambiguous.length >= 2, r);
ok('...and changed nothing', read('memory/concepts/pricing.md').includes('400 per day')
  && read('memory/concepts/pricing.md').includes('600 per day'));

r = engine.supersede({ actor: 'stan', match: 'this was never written anywhere', text: 'x' });
ok('supersede on a missing claim says so instead of writing', r.ok === false && r.not_found === true);

// ─── (e) retire deletes outright ────────────────────────────────────────────
r = engine.retire({ actor: 'stan', match: 'Rush rate is 600 per day', reason: 'never true' });
ok('retire removes the line', r.ok && !read('memory/concepts/pricing.md').includes('600 per day'), r);
ok('retire leaves the rest of the page intact', read('memory/concepts/pricing.md').includes('400 per day'));

// ─── (f) guards ─────────────────────────────────────────────────────────────
r = engine.remember({ actor: 'stan', scope: 'shared', card: 'AGENT_TOOLS', section: 'Trello', text: 'api_key: sk-ant-api03-AAAAAAAAAAAAAAAAAAAA' });
ok('a credential is refused', r.ok === false && /credential/i.test(r.error), r);

r = engine.remember({ actor: 'stan', scope: 'private', owner: 'kasia', card: 'USER_PROFILE', text: 'anything' });
ok("writing another teammate's private card is refused", r.ok === false, r);

r = engine.remember({ actor: 'stan', scope: 'private', owner: '../../etc', card: 'USER_PROFILE', text: 'anything' });
ok('a traversal owner slug is refused', r.ok === false && /owner/i.test(r.error), r);

r = engine.remember({ actor: 'stan', scope: 'shared', card: 'USER_PROFILE', text: 'anything' });
ok('a private card cannot be written to the shared tree', r.ok === false && /private card/.test(r.error), r);

r = engine.remember({ actor: 'stan', scope: 'shared', card: 'INDEX', text: 'anything' });
ok('a machine-written card is refused', r.ok === false && /auto-maintained/.test(r.error), r);

r = engine.remember({ actor: 'stan', scope: 'shared', page: '../escape', text: 'anything' });
ok('a traversal page slug is refused', r.ok === false && /invalid page slug/.test(r.error), r);

// ─── (g) rename_entity — the page NAME is a claim too ───────────────────────
writeFileSync(join(mem, 'concepts', 'nordica.md'),
  '---\ntitle: Nordica\nkind: concept\n---\n\n## Claims\n- Signed a 12-month contract\n');
mkdirSync(join(mem, 'topics'), { recursive: true });
writeFileSync(join(mem, 'topics', 'notes.md'), '# Notes\n\n- see [[nordica]] for the contract\n');
r = engine.renameEntity({ actor: 'stan', from: 'nordica', to: 'nordica-group' });
ok('rename moves the page', r.ok && existsSync(join(mem, 'concepts', 'nordica-group.md'))
  && !existsSync(join(mem, 'concepts', 'nordica.md')), r);
ok('rename repoints wiki-links so the old name stops being re-learned',
  read('memory/topics/notes.md').includes('[[nordica-group]]'), read('memory/topics/notes.md'));

// ─── (h) revert restores WITHOUT eating later writes ────────────────────────
const target = 'memory/concepts/acme.md';
const ev = engine.remember({ actor: 'stan', scope: 'shared', page: 'acme', text: 'Head office is in Gdansk' });
engine.remember({ actor: 'stan', scope: 'shared', page: 'acme', text: 'Uses net-30 payment terms' });
r = engine.revert({ actor: 'stan', eventId: ev.event_id });
ok('revert removes the reverted claim', r.ok && !read(target).includes('Head office is in Gdansk'), r);
ok('revert REPLAYS the later write instead of discarding it', read(target).includes('Uses net-30 payment terms'), read(target));
ok('revert keeps the untouched earlier claims', read(target).includes('Renews its contract annually in Q3'));

// ─── (i) the INDEX map follows every write ──────────────────────────────────
const idx = read('memory/INDEX.md');
ok('shared INDEX lists the concept pages', /\[\[acme\]\]/.test(idx) && /\[\[pricing\]\]/.test(idx), idx);
ok('shared INDEX groups cards separately from concepts', /## Cards/.test(idx) && /## Concepts/.test(idx));
ok('shared INDEX never lists a private page', !/\[\[user_profile\]\]/i.test(idx));
const pidx = read('memory/users/stan/INDEX.md');
ok("the owner's private INDEX maps their own cards", /\[\[USER_RELATIONSHIPS\]\]/i.test(pidx), pidx);

// A page whose newest cited date is old must be flagged, so the model prefers
// asking over asserting from a stale page.
writeFileSync(join(mem, 'concepts', 'old-thing.md'),
  '---\ntitle: Old Thing\nkind: concept\n---\n\n## Claims\n- Was true once  [Source: distilled 2019-01-05]\n');
engine.reindexAll();
ok('a long-unreviewed page is flagged in the INDEX', /\[\[old-thing\]\].*⚠ unreviewed/.test(read('memory/INDEX.md')),
  read('memory/INDEX.md'));

// ─── (j) the audit trail exists and is complete ─────────────────────────────
const log = engine.readLog({ limit: 0 });
ok('every mutation is logged', log.length >= 10);
ok('the log records what a supersede removed',
  log.some(e => e.op === 'supersede' && e.removed.some(t => /Viktor is the lead designer/.test(t))));
ok('every write kept an undo snapshot', log.filter(e => ['remember', 'supersede', 'retire'].includes(e.op))
  .every(e => e.undo === null || existsSync(join(ROOT, e.undo))));
ok('the retired wording survives ONLY in the log, never on a page',
  log.some(e => e.removed.some(t => /Viktor/.test(t)))
  && !/Viktor is the lead designer/.test(read('memory/concepts/viktor.md')));

// ─── (k) the store stays bounded ────────────────────────────────────────────
// Everything the audit found rotting had the same shape: it only ever grew.
// The undo snapshots and the write log are the two things here that grow with
// use, on boxes whose disk has already killed a deploy.
import { utimesSync, readdirSync as rd } from 'node:fs';
const undoDir = join(mem, '_engine', 'undo');
const before = rd(undoDir).length;
ok('writes leave undo snapshots to prune', before > 0);

// Age half of them past the window.
const aged = rd(undoDir).slice(0, Math.ceil(before / 2));
const old0 = new Date(Date.now() - 120 * 86400 * 1000);
for (const f of aged) utimesSync(join(undoDir, f), old0, old0);
const pruned = engine.pruneEngineStore();
ok(`old undo snapshots are dropped (${pruned.removed} of ${before})`, pruned.removed === aged.length, pruned);
ok('recent ones are kept', rd(undoDir).length === before - aged.length);

// The log rotates instead of growing without end, keeping one generation.
const logFile = join(mem, '_engine', 'log.jsonl');
const kept = readFileSync(logFile, 'utf8');
writeFileSync(logFile, kept + 'x'.repeat(6 * 1024 * 1024));
const r2 = engine.pruneEngineStore();
ok('an oversized log is rotated', r2.rotated === true && existsSync(`${logFile}.1`), r2);
ok('...and the previous generation survives the rotation',
  readFileSync(`${logFile}.1`, 'utf8').includes(kept.slice(0, 80)));
ok('...leaving the live log empty rather than deleted', existsSync(logFile));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
