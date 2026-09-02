/**
 * Build-failing guards for the memory card REGISTRY and the prefix paths that
 * derive from it.
 *
 * The load-bearing one is (c): a GROUP turn's prefix must contain no private
 * card. It is written against `buildTurnPrefix` — the same function lib/claude.js
 * calls before spawning — precisely because the previous guard tested a
 * hand-rebuilt exclusion list and therefore could not see the live bug: the
 * group list in claude.js had drifted from the card set and preloaded the
 * SENDER's private RESPONSIBILITIES card into a prompt whose reply is public to
 * the whole group.
 *
 * Run: node lib/memory-registry.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// recent-snapshot.js freezes its memory dir at module load (via config.js), so
// PROJECT_DIR has to point at a scratch workspace BEFORE anything is imported —
// otherwise the snapshot section writes into the real /home/coder/project.
const SNAP_ROOT = mkdtempSync(join(tmpdir(), 'mem-snap-'));
mkdirSync(join(SNAP_ROOT, 'memory'), { recursive: true });
mkdirSync(join(SNAP_ROOT, '.team', 'users', 'default', 'chats'), { recursive: true });
process.env.PROJECT_DIR = SNAP_ROOT;

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}`); } };

const { CARDS, LOAD_ORDER, USER_TIER, GROUP_EXCLUDED, ADOPT_CARDS, CANONICAL_CARD_IDS, SEED_FILES, CARD_DESCRIPTIONS }
  = await import('./memory-registry.js');

// ─── (a) registry integrity ──────────────────────────────────────────────────
ok('ids are unique', new Set(CARDS.map(c => c.id)).size === CARDS.length);
ok('every card declares tier/prefix/seed/machine/stale/adopt/desc', CARDS.every(c =>
  ['shared', 'user'].includes(c.tier) &&
  typeof c.prefix === 'boolean' && typeof c.seed === 'boolean' &&
  typeof c.machine === 'boolean' && typeof c.adopt === 'boolean' &&
  ['claims', 'none'].includes(c.stale) && !!c.desc));

// The prefix order is the prompt-cache key for the whole fleet: any reorder
// invalidates every cached prefix, so it is pinned here literally.
const EXPECTED_ORDER = ['AGENT_IDENTITY', 'AGENT_TOOLS', 'RESPONSIBILITIES', 'RULES', 'INDEX',
  'USER_INDEX', 'CHANNELS', 'USER_PROFILE', 'USER_PREFERENCES', 'RECENT_WEB', 'RECENT_TELEGRAM'];
ok('cached-prefix order is unchanged (cache key)',
  JSON.stringify(LOAD_ORDER.map(c => c.id)) === JSON.stringify(EXPECTED_ORDER));
ok('every user-tier card is fenced out of group prefixes',
  [...USER_TIER].every(id => GROUP_EXCLUDED.has(id)));
ok('adoption never moves a machine-written file (it deleted the shared INDEX)',
  ADOPT_CARDS.every(c => CARDS.find(x => x.id === c.id)?.machine === false));
ok('adoption covers only private cards', ADOPT_CARDS.every(c => USER_TIER.has(c.id)));
ok('every card has an INDEX blurb', CARDS.every(c => c.id === 'USER_INDEX' || !!CARD_DESCRIPTIONS[c.id]));
ok('graph classifies RESPONSIBILITIES + CHANNELS as cards, not topics',
  CANONICAL_CARD_IDS.has('RESPONSIBILITIES') && CANONICAL_CARD_IDS.has('CHANNELS'));
ok('seed list matches the entrypoint template set',
  SEED_FILES.includes('RESPONSIBILITIES.md') && !SEED_FILES.includes('CHANNELS.md'));

// ─── (b) no second card list anywhere in the JS tree ─────────────────────────
// The whole point of the registry: one definition. A second hardcoded list is
// how RESPONSIBILITIES came to leak, so re-introducing one fails the build.
// A card INVENTORY names the identity/profile cards together. A per-surface
// policy list (e.g. excluding the RECENT_* tails on the web path) is a
// legitimate decision, not a duplicated registry, so it must not trip this.
const SUSPECT = /\[[^\]]*'(?:USER_PROFILE|USER_PREFERENCES)'[^\]]*'(?:AGENT_IDENTITY|AGENT_TOOLS|RULES)'[^\]]*\]|\[[^\]]*'(?:AGENT_IDENTITY|AGENT_TOOLS|RULES)'[^\]]*'(?:USER_PROFILE|USER_PREFERENCES)'[^\]]*\]/;
function jsFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) jsFiles(p, out);
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.mjs')) out.push(p);
  }
  return out;
}
const offenders = jsFiles(new URL('..', import.meta.url).pathname)
  .filter(f => !f.endsWith('memory-registry.js'))
  .filter(f => SUSPECT.test(readFileSync(f, 'utf8')));
ok(`no hardcoded card list outside the registry${offenders.length ? ` (found: ${offenders.join(', ')})` : ''}`,
  offenders.length === 0);

// ─── (c) GROUP prefix carries nothing private — the real path ────────────────
const root = mkdtempSync(join(tmpdir(), 'mem-registry-'));
const memoryDir = join(root, 'memory');
mkdirSync(join(memoryDir, 'users', 'sam'), { recursive: true });
writeFileSync(join(memoryDir, 'RULES.md'), '# RULES\n- shared rule\n');
writeFileSync(join(memoryDir, 'INDEX.md'), '# Memory index\n- [[rules]]\n');
writeFileSync(join(memoryDir, 'CHANNELS.md'), '# CHANNELS\n- team group\n');
// One distinctive marker per private card, so a leak names itself.
const PRIVATE = {
  RESPONSIBILITIES: 'PRIVATE-MARKER-RESPONSIBILITIES watch his personal bank alerts',
  USER_PROFILE: 'PRIVATE-MARKER-PROFILE lives in Krakow',
  USER_PREFERENCES: 'PRIVATE-MARKER-PREFERENCES prefers terse replies',
  RECENT_WEB: 'PRIVATE-MARKER-RECENTWEB yesterday we discussed salaries',
  RECENT_TELEGRAM: 'PRIVATE-MARKER-RECENTTG operator DM tail',
  INDEX: 'PRIVATE-MARKER-USERINDEX map of sam private pages',
};
for (const [id, body] of Object.entries(PRIVATE)) {
  writeFileSync(join(memoryDir, 'users', 'sam', `${id === 'INDEX' ? 'INDEX' : id}.md`), `# ${id}\n- ${body}\n`);
}

const { buildTurnPrefix } = await import('./claude.js');

const group = buildTurnPrefix({
  actor: 'sam', groupContext: true, isTgOperator: false,
  callerExcludeIds: ['USER_INDEX'], memoryDir,
});
const leaked = Object.entries(PRIVATE).filter(([, body]) => group.block.includes(body)).map(([id]) => id);
ok(`group prefix leaks no private card${leaked.length ? ` (leaked: ${leaked.join(', ')})` : ''}`, leaked.length === 0);
ok('group prefix renders no user-tier block at all',
  ![...USER_TIER].some(id => group.block.includes(`## ${id}\n`)));
ok('group prefix still carries the shared cards', group.block.includes('shared rule') && group.block.includes('team group'));

// ─── (d) 1:1 prefix still resolves the actor's own private cards ─────────────
const solo = buildTurnPrefix({ actor: 'sam', groupContext: false, isTgOperator: true, memoryDir });
ok('1:1 prefix loads the actor\'s own profile', solo.block.includes(PRIVATE.USER_PROFILE));
ok('1:1 prefix loads the actor\'s own duties', solo.block.includes(PRIVATE.RESPONSIBILITIES));
ok('1:1 prefix always drops RECENT_WEB (same-surface bleed)', !solo.block.includes(PRIVATE.RECENT_WEB));
ok('operator keeps the Telegram tail', solo.block.includes(PRIVATE.RECENT_TELEGRAM));

const mate = buildTurnPrefix({ actor: 'sam', groupContext: false, isTgOperator: false, memoryDir });
ok('a non-operator never gets the operator Telegram tail', !mate.block.includes(PRIVATE.RECENT_TELEGRAM));

// ─── (e) team migration keeps the SHARED index and adopts private content ────
const { migrateDefaultMemory } = await import('./memory-loader.js');
const root2 = mkdtempSync(join(tmpdir(), 'mem-migrate-'));
process.env.PROJECT_DIR = root2;   // memoryDirFor() reads this at call time
mkdirSync(join(root2, 'memory', 'users', 'stan'), { recursive: true });
writeFileSync(join(root2, 'memory', 'INDEX.md'), '# SHARED index\n');
writeFileSync(join(root2, 'memory', 'users', 'stan', 'INDEX.md'), '# stan private index\n');
writeFileSync(join(root2, 'memory', 'USER_PROFILE.md'), '# profile\n- solo-era fact\n');
writeFileSync(join(root2, 'memory', 'USER_RELATIONSHIPS.md'), '# people\n- Kasia\n');
migrateDefaultMemory('stan');
ok('migration keeps the SHARED INDEX.md', existsSync(join(root2, 'memory', 'INDEX.md')));
ok('migration leaves the private INDEX alone',
  readFileSync(join(root2, 'memory', 'users', 'stan', 'INDEX.md'), 'utf8').includes('stan private'));
ok('migration adopts the profile', existsSync(join(root2, 'memory', 'users', 'stan', 'USER_PROFILE.md'))
  && !existsSync(join(root2, 'memory', 'USER_PROFILE.md')));
ok('migration adopts relationships (was left teammate-readable)',
  existsSync(join(root2, 'memory', 'users', 'stan', 'USER_RELATIONSHIPS.md'))
  && !existsSync(join(root2, 'memory', 'USER_RELATIONSHIPS.md')));

// ─── (f) snapshots: unchanged content must not rewrite the prefix bytes ──────
const root3 = SNAP_ROOT;
process.env.PROJECT_DIR = root3;
const chats = join(root3, '.team', 'users', 'default', 'chats');
writeFileSync(join(chats, 's1.jsonl'),
  '{"ts":"2026-09-01T10:00:00Z","role":"user","text":"hello"}\n' +
  '{"ts":"2026-09-01T10:00:05Z","role":"assistant","text":"hi"}\n');
const { writeRecentSnapshot } = await import('./recent-snapshot.js');
const snapPath = join(root3, 'memory', 'RECENT_WEB.md');
writeRecentSnapshot({ channel: 'web' });
const firstBytes = readFileSync(snapPath, 'utf8');
const firstMtime = statSync(snapPath).mtimeMs;
await new Promise(r => setTimeout(r, 15));
const again = writeRecentSnapshot({ channel: 'web' });
ok('re-render of an unchanged tail does NOT rewrite the file (prompt cache holds)',
  readFileSync(snapPath, 'utf8') === firstBytes && again.changed === false);
ok('an unchanged snapshot is still marked current (mtime touched)',
  statSync(snapPath).mtimeMs >= firstMtime);
writeFileSync(join(chats, 's1.jsonl'),
  readFileSync(join(chats, 's1.jsonl'), 'utf8') +
  '{"ts":"2026-09-01T11:00:00Z","role":"user","text":"a genuinely new message"}\n');
const third = writeRecentSnapshot({ channel: 'web' });
ok('a real new message DOES rewrite the snapshot',
  third.changed === true && readFileSync(snapPath, 'utf8').includes('a genuinely new message'));

// The phase-0 exit criterion, asserted end to end: an idle tick must leave the
// cached prefix byte-identical, or the prompt cache is invalidated once a minute
// for the whole idle window.
const { buildCachedPrefix } = await import('./memory-loader.js');
const prefixBefore = buildCachedPrefix({ memoryDir: join(root3, 'memory') }).block;
writeRecentSnapshot({ channel: 'web' });          // idle tick, no new messages
writeRecentSnapshot({ channel: 'web' });          // and another
const prefixAfter = buildCachedPrefix({ memoryDir: join(root3, 'memory') }).block;
ok('cached prefix is byte-identical across idle snapshot ticks', prefixBefore === prefixAfter);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
