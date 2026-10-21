/**
 * A note saved mid-turn meets the sharing gate; when the router does not
 * answer, the note is still saved, its record is tagged `ungated`, the tool
 * says so, and the night's pass judges it once the model is back — shared for
 * an "auto" owner, a question for an "ask" owner. A router down again at
 * night leaves the tag for the next one. Seen on a production client: the
 * owner's "auto" mode shared nothing for days while the model was slow, and
 * nobody was told. Real router on 127.0.0.1, real turn tokens, a fake model.
 *
 * Run: node lib/memory-regate.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = mkdtempSync(join(tmpdir(), 'mem-regate-'));
process.env.PROJECT_DIR = ROOT;
process.env.BOT_TURN_ID_HASH_FILE = join(ROOT, 'bot-turn-id.sha256');
writeFileSync(process.env.BOT_TURN_ID_HASH_FILE, createHash('sha256').update('bot-token-for-tests-0123456789').digest('hex'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 600)}` : ''}`); }
};

writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', telegramChatId: '1110001', addedAt: '2026-09-01T00:00:00Z', sharing: 'auto' },
  { email: 'kasia@example.test', role: 'member', slug: 'kasia', displayName: 'Kasia', telegramChatId: '2220002', addedAt: '2026-09-01T00:00:00Z', sharing: 'ask' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true, groups: {} }));

const L = await import('./memory-ledger.js');
const FS = await import('./memory-facts.js');
const A = await import('./memory-asks.js');
const RG = await import('./memory-regate.js');
const ti = await import('./turn-identity.js');
(await import('./embedder-client.js')).configureEmbedder(async () => { throw new Error('none'); });

// The fake model: the router copies the person's line to "shared" (or is
// down); the split makes one company fact from the note, grounded in the words.
let routerDown = false;
const calls = [];
(await import('./memory-llm.js')).configureRunner(async ({ user, schema }) => {
  if (schema?.properties?.shared) {
    calls.push('route');
    if (routerDown) throw new Error('model call failed: down');
    return { shared: String(user).split('\n\n').slice(1).join('\n\n'), private: '', ask: '', ask_question: '' };
  }
  if (schema?.properties?.decisions) return { decisions: [] };
  if (schema?.properties?.notes) {
    const note = String(user).match(/NOTE: ([^\n]+)/)?.[1] || '';
    const said = String(user).match(/WORDS: [^:]+: ([\s\S]*)$/)?.[1]?.trim() || '';
    return { notes: [{ title: note.replace(/\.$/, '').slice(0, 60), text: note, importance: 2, kind: 'fact', evidence: said, concerns: 'a company or project', subject: null, names: [] }], rules: [], entities: [], known_mentioned: [] };
  }
  return { unsupported: [] };
});

const express = (await import('express')).default;
const router = (await import('../routes/memory-v4.js')).default;
const app = express();
app.use(express.json());
app.use('/api', router());
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/internal/memory/v4`;
const note = async (token, text, said) => {
  const r = await fetch(`${base}/note`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-IDE-Turn': token }, body: JSON.stringify({ text, said }) });
  return { status: r.status, body: await r.json() };
};
const stanTurn = ti.issueTurnToken({ actor: 'stan' });
const kasiaTurn = ti.issueTurnToken({ actor: 'kasia' });
const inShared = (re) => L.read({ scopes: ['shared'] }).some(r => re.test(r.text));
const recOf = (scope, re) => L.read({ scopes: [scope] }).find(r => re.test(r.text));

// ─── the router answers: an "auto" owner's company fact reaches the team at once
let r = await note(stanTurn, 'Northbeam renews in March.', 'Northbeam renews in March');
ok('a note is saved and, the owner sharing automatically, reaches the team', r.body.ok && r.body.shared === 1 && !r.body.ungated && inShared(/Northbeam/), r.body);
ok('...its record carries no tag', !recOf('user:stan', /Northbeam/)?.tags?.ungated, recOf('user:stan', /Northbeam/));

// ─── the router is down: saved, tagged, said so ──────────────────────────────
routerDown = true;
r = await note(stanTurn, 'Southgate renews in April.', 'Southgate renews in April');
ok('with the router down the note is still saved, privately', r.body.ok && r.body.scope === 'private' && FS.all('user:stan').some(f => /Southgate/.test(f.text)), r.body);
ok('...nothing reaches the team, nobody is asked', !inShared(/Southgate/) && !r.body.shared && !r.body.asked && A.listAsks('stan').length === 0);
ok('...the answer says the team question is open', r.body.ungated === true, r.body);
ok('...and the record is tagged for the night', recOf('user:stan', /Southgate/)?.tags?.ungated === true, recOf('user:stan', /Southgate/));
r = await note(kasiaTurn, 'Westfield signed the pilot.', 'Westfield signed the pilot');
ok('an "ask" owner\'s note is tagged the same', r.body.ok && r.body.ungated === true && recOf('user:kasia', /Westfield/)?.tags?.ungated === true, r.body);

// ─── the night, router still down: nothing judged, tags kept ─────────────────
const logs = [];
let g = await RG.regateUngated({ log: (m) => logs.push(m) });
ok('the night with the router still down judges nothing and keeps the tags', g.records === 0 && g.left === 2 && recOf('user:stan', /Southgate/)?.tags?.ungated === true && recOf('user:kasia', /Westfield/)?.tags?.ungated === true, { g, logs });
ok('...and says so', logs.length === 2 && logs.every(m => /router did not answer/.test(m)), logs);

// ─── the night, router back: judged by each owner's mode, tags off ───────────
routerDown = false;
g = await RG.regateUngated();
ok('the night judges both notes', g.records === 2 && g.left === 0, g);
ok('the "auto" owner\'s fact reached the team', g.shared === 1 && inShared(/Southgate/), L.read({ scopes: ['shared'] }).map(x => x.text));
ok('the "ask" owner is asked instead', g.asked === 1 && A.listAsks('kasia').some(a => /Westfield/.test(a.text)) && !inShared(/Westfield/), A.listAsks('kasia'));
ok('the tags are gone', !recOf('user:stan', /Southgate/)?.tags?.ungated && !recOf('user:kasia', /Westfield/)?.tags?.ungated);
ok('...and the records are otherwise untouched', recOf('user:stan', /Southgate/)?.text.startsWith('Southgate renews in April.') && recOf('user:stan', /Southgate/)?.source === 'note', recOf('user:stan', /Southgate/));
g = await RG.regateUngated();
ok('a second night finds nothing to do', g.records === 0 && g.left === 0, g);

// ─── the cap: what is left waits for tomorrow ────────────────────────────────
routerDown = true;
await note(stanTurn, 'Eastgate renews in May.', 'Eastgate renews in May');
await note(stanTurn, 'Harbor renews in June.', 'Harbor renews in June');
routerDown = false;
g = await RG.regateUngated({ cap: 1 });
ok('a capped night judges one and leaves the rest tagged', g.records === 1 && g.left === 1 && [recOf('user:stan', /Eastgate/), recOf('user:stan', /Harbor/)].filter(x => x?.tags?.ungated).length === 1, g);

server.close();
console.log(`memory-regate: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
