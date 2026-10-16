/**
 * A ready-made routine picked before its integration is connected waits for
 * it (routines-waiting.json, never run) and joins the person's routines once
 * the integration is usable; without `later` the add is refused as before.
 *
 * Run: node lib/routines-waiting.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'waiting-'));
const STORE = mkdtempSync(join(tmpdir(), 'waiting-store-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.INTEGRATIONS_KEY_PATH = join(STORE, 'key');
writeFileSync(process.env.INTEGRATIONS_KEY_PATH, 'ab'.repeat(32));
process.env.MEMORY_V4 = 'on';
mkdirSync(join(ROOT, '.team'), { recursive: true });
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'ola@example.test', role: 'admin', slug: 'ola', displayName: 'Ola', addedAt: '2026-10-01T00:00:00Z', slot: 1 },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: false }));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${JSON.stringify(extra).slice(0, 500)}` : ''}`); } };

const crypto = await import('./integrations/crypto.js');
if (!crypto.isReady()) { console.log('routines-waiting: the crypto key is not readable in this environment — skipped'); process.exit(0); }
const store = await import('./integrations/store.js');
const { addFromCatalog, flushAllWaiting, readWaiting, waitingView, dropWaiting } = await import('./routines-add.js');
const { readRoutines } = await import('./routines-store.js');
const { routinesOwner } = await import('./memory-v4-writes.js');
const owner = routinesOwner('ola');
const live = () => readRoutines(owner).routines.filter((r) => !r.retired).map((r) => r.catalogId);

let r = addFromCatalog('ola', 'meeting-actions');
ok('without later, a routine needing an unconnected app is refused', r.status === 409, r);
r = addFromCatalog('ola', 'meeting-actions', { later: true });
ok('with later, it is kept waiting', r.status === 200 && r.body.waiting === true, r);
ok('...and is not a routine yet, so it never runs', !live().includes('meeting-actions') && readWaiting(owner).some((w) => w.id === 'meeting-actions'), { live: live(), waiting: readWaiting(owner) });
const view = waitingView(owner);
ok('the Routines screen gets its title and the apps it waits for', view.length === 1 && view[0].title && view[0].needs.includes('granola'), view);
addFromCatalog('ola', 'board-overdue', { later: true });
ok('removing a waiting routine drops it', dropWaiting(owner, 'board-overdue') && !readWaiting(owner).some((w) => w.id === 'board-overdue'));
addFromCatalog('ola', 'meeting-actions', { later: true });
ok('picking it twice keeps one waiting entry', readWaiting(owner).filter((w) => w.id === 'meeting-actions').length === 1);
ok('nothing to add while the app is still missing', flushAllWaiting() === 0 && !live().includes('meeting-actions'));

store.activate('granola', { fields: { OAUTH_TOKENS: '{"access_token":"g"}' } }, { owner: 'ola', reach: 'workspace' });
ok('once the app is connected it joins the routines', flushAllWaiting() === 1 && live().includes('meeting-actions'), live());
ok('...and stops waiting', readWaiting(owner).length === 0 && !existsSync(join(ROOT, '.team', 'users', owner, 'routines-waiting.json')));
ok('a second flush adds nothing twice', flushAllWaiting() === 0 && live().filter((id) => id === 'meeting-actions').length === 1);
r = addFromCatalog('ola', 'meeting-followup', { later: true });
ok('a usable routine is added at once, later or not', r.body.added === true && live().includes('meeting-followup'), r);

console.log(`routines-waiting: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
