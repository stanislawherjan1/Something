/**
 * Guards for the v4 ledger — the ground truth everything else is rebuilt from.
 *
 * It must: never lose or tear a record under concurrent writes; keep scopes apart
 * by path; let a group turn read shared + that group only; keep hide reversible;
 * make redaction complete (gone from disk, other lines byte-identical, content
 * unable to come back through a re-append) and leave no text in the log.
 *
 * Run: node lib/memory-ledger.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'ledger-'));
process.env.PROJECT_DIR = ROOT;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 400)}` : ''}`); }
};

const L = await import('./memory-ledger.js');
let threw = null;

// ─── (a) scopes ──────────────────────────────────────────────────────────────
ok('(a) shared scope dir', L.scopeDir('shared').endsWith('memory/ledger'));
ok('(a) user scope dir', L.scopeDir('user:kasia').endsWith('memory/users/kasia/ledger'));
ok('(a) group scope dir', L.scopeDir('group:-1004242').endsWith('memory/groups/-1004242/ledger'));
for (const bad of ['user:../stan', 'user:', 'user:default', 'group:1234', 'group:-12', 'team', 'user:Kasia']) {
  let threw = false; try { L.scopeDir(bad); } catch { threw = true; }
  ok(`(a) invalid scope refused: ${bad}`, threw);
}
ok('(a) a 1:1 turn reads own + shared + member groups',
  JSON.stringify(L.readableScopes({ actor: 'kasia', memberGroups: ['-1004242'] })) === JSON.stringify(['shared', 'user:kasia', 'group:-1004242']));
ok('(a) a group turn reads shared + that group only',
  JSON.stringify(L.readableScopes({ actor: 'kasia', groupId: '-1004242', memberGroups: ['-1009999'] })) === JSON.stringify(['shared', 'group:-1004242']));
ok('(a) the shared "team" actor has no private scope', JSON.stringify(L.readableScopes({ actor: 'team' })) === '["shared"]');
ok('(a) solo mode is a team of one: the owner reads their own scope', JSON.stringify(L.readableScopes({ actor: 'stan' })) === '["shared","user:stan"]');
ok('(a) ...and a group turn in solo mode still never does', JSON.stringify(L.readableScopes({ actor: 'stan', groupId: '-1004242' })) === '["shared","group:-1004242"]');
const withOrigin = await L.append({ scope: 'shared', source: 'telegram', ts: '2026-09-01T09:00:00Z', text: 'Stan: launch moves to Oct 3', origin: 'user:stan' });
ok('(a) a shared excerpt remembers its origin', withOrigin.record.origin === 'user:stan');
threw = null;
try { await L.append({ scope: 'shared', source: 'web', text: 'x', origin: 'user:../x' }); } catch (e) { threw = e.message; }
ok('(a) an invalid origin is refused', /invalid scope/.test(threw || ''));

// ─── (b) appends: ordering, months, concurrency ─────────────────────────────
const a1 = await L.append({ scope: 'user:stan', source: 'telegram', ts: '2026-08-30T10:00:00Z', speaker: 'Stan', text: 'Stan: the seed round is a SAFE now' });
const a2 = await L.append({ scope: 'user:stan', source: 'telegram', ts: '2026-09-02T09:00:00Z', speaker: 'Stan', text: 'Stan: Riverstone signed', notes: ['Riverstone signed the SAFE.'] });
await L.append({ scope: 'shared', source: 'web', ts: '2026-09-01T12:00:00Z', text: 'Stan: standup moves to Wednesdays' });
ok('(b) appends succeed with ids', a1.ok && a2.ok && a1.id < a2.id, { a1, a2 });
ok('(b) one file per month', readdirSync(L.scopeDir('user:stan')).sort().join(',') === '2026-08.jsonl,2026-09.jsonl');
const stan = L.read({ scopes: ['user:stan'] });
ok('(b) read returns oldest first', stan.map(r => r.text).join('|') === 'Stan: the seed round is a SAFE now|Stan: Riverstone signed');
ok('(b) notes are kept as objects', stan[1].notes[0].text === 'Riverstone signed the SAFE.');
ok('(b) scopes stay apart', L.read({ scopes: ['shared'] }).length === 2 && L.read({ scopes: ['user:kasia'] }).length === 0);
ok('(b) since/until filter', L.read({ scopes: ['user:stan'], since: '2026-09-01T00:00:00Z' }).length === 1);
threw = null;
try { await L.append({ scope: 'shared', source: 'gossip', text: 'x' }); } catch (e) { threw = e.message; }
ok('(b) an unknown source is refused', /invalid source/.test(threw || ''));
threw = null;
try { await L.append({ scope: 'shared', source: 'web', text: '   ' }); } catch (e) { threw = e.message; }
ok('(b) an empty record is refused', /empty/.test(threw || ''));

const many = await Promise.all(Array.from({ length: 200 }, (_, i) =>
  L.append({ scope: 'group:-1004242', source: 'group', ts: '2026-09-10T10:00:00Z', speaker: `P${i}`, text: `message number ${i} ${'x'.repeat(i % 50)}` })));
const lines = readFileSync(join(L.scopeDir('group:-1004242'), '2026-09.jsonl'), 'utf8').split('\n').filter(Boolean);
ok('(b) 200 concurrent appends: 200 intact lines', many.every(r => r.ok) && lines.length === 200 && lines.every(l => { try { JSON.parse(l); return true; } catch { return false; } }));
ok('(b) ids are unique', new Set(many.map(r => r.id)).size === 200);

// ─── (c) hide / unhide ───────────────────────────────────────────────────────
await L.hide('user:stan', a1.id, 'stan');
ok('(c) a hidden record leaves reads', !L.read({ scopes: ['user:stan'] }).some(r => r.id === a1.id));
ok('(c) ...but is still on disk and listed with includeHidden', L.read({ scopes: ['user:stan'], includeHidden: true }).find(r => r.id === a1.id)?.hidden === true);
await L.unhide('user:stan', a1.id, 'stan');
ok('(c) unhide brings it back', L.read({ scopes: ['user:stan'] }).some(r => r.id === a1.id));

// ─── (d) redaction ───────────────────────────────────────────────────────────
const monthPath = join(L.scopeDir('user:stan'), '2026-09.jsonl');
const keepLine = readFileSync(join(L.scopeDir('user:stan'), '2026-08.jsonl'), 'utf8');
const removedRows = [];
const red = await L.redact('user:stan', [a2.id], 'stan', { onRemoved: (s, m, rows) => removedRows.push([s, m, rows]) });
ok('(d) redaction removes the record', red.removed === 1 && !L.read({ scopes: ['user:stan'], includeHidden: true }).some(r => r.id === a2.id));
ok('(d) ...its text is gone from disk', !readFileSync(monthPath, 'utf8').includes('Riverstone'));
ok('(d) other months are byte-identical', readFileSync(join(L.scopeDir('user:stan'), '2026-08.jsonl'), 'utf8') === keepLine);
ok('(d) derived stores are told which rows went', removedRows.length === 1 && removedRows[0][1] === '2026-09.jsonl');
const again = await L.append({ scope: 'user:stan', source: 'telegram', ts: '2026-09-03T09:00:00Z', text: 'Stan:   Riverstone   SIGNED' });
ok('(d) erased content cannot come back (normalised match)', again.ok === false && again.skipped === 'tombstoned', again);
const log = readFileSync(join(ROOT, 'memory', '_engine', 'v4-log.jsonl'), 'utf8');
ok('(d) the log records the redaction without its text', /"op":"redact"/.test(log) && !log.includes('Riverstone'));

// ─── (d2) retag: metadata only, other lines byte-identical ───────────────────
const tagged = await L.append({ scope: 'user:stan', source: 'web', ts: '2026-09-04T10:00:00Z', text: 'Stan: Leo builds the board.', tags: { entities: [{ name: 'Stan', kind: 'person' }, { name: 'Leo', kind: 'person' }] } });
const untouchedBefore = readFileSync(join(L.scopeDir('user:stan'), '2026-08.jsonl'), 'utf8');
const rt = await L.retag('user:stan', (r) => (r.tags?.entities ? { ...r.tags, entities: r.tags.entities.filter(e => e.name !== 'Stan') } : null));
const after = L.read({ scopes: ['user:stan'] }).find(r => r.id === tagged.id);
ok('(d2) retag drops the tag and nothing else', rt.changed === 1 && JSON.stringify(after.tags.entities) === '[{"name":"Leo","kind":"person"}]' && after.text === 'Stan: Leo builds the board.', after);
ok('(d2) months it did not touch are byte-identical', readFileSync(join(L.scopeDir('user:stan'), '2026-08.jsonl'), 'utf8') === untouchedBefore);

// ─── (d4) a hidden fact is purged with the hidden records, after 30 days ─────
const withFacts = await L.append({ scope: 'user:stan', source: 'web', ts: '2026-09-05T10:00:00Z', text: 'Stan: two things.', notes: [{ text: 'Thing one.', kind: 'fact', hidden: true, hiddenAt: '2026-08-01T00:00:00Z' }, { text: 'Thing two.', kind: 'fact', hidden: true, hiddenAt: new Date().toISOString() }, { text: 'Thing three.', kind: 'fact' }] });
await L.purgeHidden(['user:stan'], { now: Date.now() });
const trimmed = L.read({ scopes: ['user:stan'] }).find(r => r.id === withFacts.id);
ok('(d4) the fact hidden long ago is gone, the recent one and the visible one stay', trimmed.notes.length === 2 && trimmed.notes.some(n => n.text === 'Thing two.' && n.hidden) && trimmed.notes.some(n => n.text === 'Thing three.'), trimmed.notes);
ok('(d4) visibleNotes hides what is hidden', L.visibleNotes(trimmed).length === 1);

// ─── (d3) rewriteMeta may move a record's date, within its month ─────────────
const mv = await L.rewriteMeta('user:stan', (r) => (r.id === tagged.id ? { ts: '2026-09-02T09:00:00.000Z' } : null), 'redate');
const moved = L.read({ scopes: ['user:stan'] }).find(r => r.id === tagged.id);
ok('(d3) the date moved, the text did not', mv.changed === 1 && moved.ts === '2026-09-02T09:00:00.000Z' && moved.text === 'Stan: Leo builds the board.', moved);
ok('(d3) ...never out of its month file', (await L.rewriteMeta('user:stan', (r) => (r.id === tagged.id ? { ts: '2026-10-02T09:00:00.000Z' } : null))).changed === 0);
ok('(d2) a second pass changes nothing', (await L.retag('user:stan', (r) => (r.tags?.entities ? { ...r.tags, entities: r.tags.entities.filter(e => e.name !== 'Stan') } : null))).changed === 0);
ok('(d2) it is logged without text', /"op":"retag"/.test(readFileSync(join(ROOT, 'memory', '_engine', 'v4-log.jsonl'), 'utf8')) && !readFileSync(join(ROOT, 'memory', '_engine', 'v4-log.jsonl'), 'utf8').includes('builds the board'));

// ─── (e) purge of long-hidden records ────────────────────────────────────────
const old = await L.append({ scope: 'shared', source: 'note', ts: '2026-09-05T10:00:00Z', text: 'an old hidden note' });
await L.hide('shared', old.id, 'stan');
let purged = await L.purgeHidden(['shared']);
ok('(e) a record hidden today is not purged', !purged.shared && L.read({ scopes: ['shared'], includeHidden: true }).some(r => r.id === old.id));
purged = await L.purgeHidden(['shared'], { now: Date.now() + (L.HIDE_GRACE_DAYS + 1) * 86400_000 });
ok('(e) after the grace period it is erased for good', purged.shared === 1 && !L.read({ scopes: ['shared'], includeHidden: true }).some(r => r.id === old.id));
ok('(e) allScopes finds every ledger', ['shared', 'user:stan', 'group:-1004242'].every(s => L.allScopes().includes(s)), L.allScopes());

console.log(`memory-ledger: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
