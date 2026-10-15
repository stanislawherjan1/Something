/**
 * One turn user per person: a roster entry gets the lowest free slot when
 * added, the slot frees when they leave (their trees archived first), a full
 * pool refuses cleanly, the boot reconcile backfills and owns, and a turn is
 * started as its person's slot. The root helper is a stub that records what
 * it was asked. Run: node lib/turn-slots.test.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'slots-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'slots-store-'));
process.env.TURN_POOL_SIZE = '3';
const CALLS = join(ROOT, 'priv-tree.calls');
const STUB = join(ROOT, 'priv-tree');
writeFileSync(STUB, `#!/bin/sh\necho "$@" >> ${CALLS}\n`); chmodSync(STUB, 0o755);
process.env.PRIV_TREE_BIN = STUB;
const RUNNER = join(ROOT, 'turn-runner');
writeFileSync(RUNNER, '#!/bin/sh\n'); chmodSync(RUNNER, 0o755);
process.env.TURN_RUNNER_BIN = RUNNER;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${JSON.stringify(extra)}` : ''}`); } };
const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean) : []);

const T = await import('./team.js');
const C = await import('./claude.js');

// ─── adding ──────────────────────────────────────────────────────────────────
const a = T.add({ email: 'ann@example.test', role: 'admin', addedBy: 'ann@example.test' });
ok('the first person gets slot 1', a.slot === 1, a);
ok('...and their trees are owned at once', calls().includes(`assign ${a.slug} 01`), calls());
const b = T.add({ email: 'bob@example.test', role: 'member', addedBy: 'ann@example.test' });
ok('the next gets the next slot', b.slot === 2);
ok('the roster lists the slots', T.list().map(m => m.slot).join(',') === '1,2');
ok('a slot is found by slug', T.slotOf(a.slug) === 1 && T.slotOf(b.slug) === 2 && T.slotOf('nobody') === null);

// ─── leaving ─────────────────────────────────────────────────────────────────
T.remove({ email: 'bob@example.test', actor: 'ann@example.test' });
ok('leaving archives the trees before the slot is free', calls().includes(`archive ${b.slug}`), calls());
const c = T.add({ email: 'cat@example.test', role: 'member', addedBy: 'ann@example.test' });
ok('the freed slot is reused (lowest free)', c.slot === 2, c);
const d = T.add({ email: 'dan@example.test', role: 'member', addedBy: 'ann@example.test' });
ok('...then the next', d.slot === 3);
let err = null;
try { T.add({ email: 'eve@example.test', role: 'member', addedBy: 'ann@example.test' }); } catch (e) { err = e.message; }
ok('a full pool refuses with the reason, nothing half-added', /supports up to 3 people/.test(err) && T.list().length === 3, err);

// ─── the boot reconcile ──────────────────────────────────────────────────────
// A roster from before the pool: no slots at all.
const FILE = join(ROOT, '.allowed-emails.json');
const raw = JSON.parse(readFileSync(FILE, 'utf8')).map(({ slot, ...rest }) => rest);
writeFileSync(FILE, JSON.stringify(raw));
ok('(setup) nobody has a slot', T.list().every(m => m.slot === null));
const out = T.reconcileSlots();
ok('reconcile assigns everyone a slot, in roster order', out.assigned.length === 3 && T.list().map(m => m.slot).join(',') === '1,2,3', out);
ok('...owns every tree set', out.owned.length === 3);
ok('...and opens the primary admin\'s slot to the brain and the editor', out.granted === 1 && calls().includes('grant 01'), calls());
const again = T.reconcileSlots();
ok('a second reconcile changes nothing', again.assigned.length === 0 && T.list().map(m => m.slot).join(',') === '1,2,3');

// ─── a turn runs as its person ───────────────────────────────────────────────
ok('a group turn runs as the group user', C.turnSlot({ actor: a.slug, groupContext: true }) === 'group');
ok('a person\'s turn runs as their slot', C.turnSlot({ actor: c.slug }) === '02');
ok('a solo workspace\'s turn runs as the solo user', C.turnSlot({ actor: 'default' }) === 'solo');
ok('a person without a slot falls back to solo, not to someone else', C.turnSlot({ actor: 'stranger' }) === 'solo');
const cmd = C.turnCommand(['-p', 'x'], '02');
ok('the runner is given the slot first, then the CLI\'s arguments', cmd.bin === RUNNER && cmd.args.join(' ') === '02 -p x', cmd);

// ─── an archive that fails ───────────────────────────────────────────────────
// The departed person's trees are still in place: their uid must not go to the
// next person until the archive goes through.
writeFileSync(STUB, `#!/bin/sh\necho "$@" >> ${CALLS}\n[ "$1" = archive ] && exit 1\nexit 0\n`);
T.remove({ email: 'cat@example.test', actor: 'ann@example.test' });
err = null;
try { T.add({ email: 'fay@example.test', role: 'member', addedBy: 'ann@example.test' }); } catch (e) { err = e.message; }
ok('a failed archive holds the slot: the newcomer does not get it', /supports up to 3 people/.test(err), err);
ok('...the reconcile keeps it held while the archive still fails', T.reconcileSlots().released.length === 0);
writeFileSync(STUB, `#!/bin/sh\necho "$@" >> ${CALLS}\n`);
const back = T.reconcileSlots();
ok('...and releases it once the archive goes through', back.released.join(',') === String(c.slot), back);
const g = T.add({ email: 'gus@example.test', role: 'member', addedBy: 'ann@example.test' });
ok('...after which it is free again', g.slot === c.slot, g);

console.log(`turn-slots: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
