/**
 * Solo mode: the one person's own cards ("About you", their preferences) are the
 * flat files the prefix and the Memory screen read. They were refused as
 * shared and, written as private, landed under users/ where nothing read them —
 * so nothing could fill "About you" in a solo workspace. Team mode keeps them
 * under users/<slug>/. Run: node lib/solo-personal-cards.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'solo-cards-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'solo-cards-store-'));
process.env.MEMORY_V4 = 'on';
mkdirSync(join(ROOT, 'memory', '_engine'), { recursive: true });
writeFileSync(join(ROOT, 'memory', '_engine', '.v4-migrated'), '{}');
for (const c of ['USER_PROFILE', 'USER_PREFERENCES', 'MISSION'])
  copyFileSync(new URL(`../../bootstrap/memory-cards-templates/${c}.md`, import.meta.url), join(ROOT, 'memory', `${c}.md`));
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([{ email: 'ola@example.test', role: 'admin', slug: 'ola', displayName: 'Ola', addedAt: '2026-09-01T00:00:00Z' }]));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const engine = await import('./memory-engine.js');
const { buildCachedPrefixV4 } = await import('./memory-loader.js');

// ─── solo (no team config at all, as on a fresh install) ─────────────────────
let r = engine.remember({ actor: 'ola', scope: 'private', owner: 'ola', card: 'USER_PROFILE', text: 'Name: Ola Nowak' });
ok('an empty template field is filled in place, not added under it', r.ok && r.filled && /^- Name: Ola Nowak$/m.test(readFileSync(join(ROOT, 'memory', 'USER_PROFILE.md'), 'utf8')) && !/^- Name:\s*$/m.test(readFileSync(join(ROOT, 'memory', 'USER_PROFILE.md'), 'utf8')), r);
r = engine.remember({ actor: 'ola', scope: 'private', owner: 'ola', card: 'USER_PROFILE', text: 'Name: Someone Else' });
ok('a filled field is not overwritten by a plain remember', r.ok === false && r.needs_supersede, r);
r = engine.remember({ actor: 'ola', scope: 'private', owner: 'ola', card: 'USER_PROFILE', text: 'Role: Founder' });
ok('solo: the person\'s own card is written', r.ok, r);
ok('...to the flat file', readFileSync(join(ROOT, 'memory', 'USER_PROFILE.md'), 'utf8').includes('Role: Founder'));
ok('...not under users/', !existsSync(join(ROOT, 'memory', 'users', 'ola', 'USER_PROFILE.md')));
const prefix = buildCachedPrefixV4({ memoryDir: join(ROOT, 'memory'), actor: 'ola', flatPersonal: true });
ok('...where the prefix reads it', String(prefix.block).includes('Role: Founder'));
r = engine.remember({ actor: 'ola', scope: 'shared', card: 'USER_PROFILE', text: 'Shared write' });
ok('solo: a shared write of a private card is still refused', r.ok === false);
r = engine.remember({ actor: 'ola', scope: 'private', owner: 'kasia', card: 'USER_PROFILE', text: 'Planted' });
ok('solo: writing someone else\'s card is refused, and the flat card is untouched', r.ok === false && !readFileSync(join(ROOT, 'memory', 'USER_PROFILE.md'), 'utf8').includes('Planted'), r);
r = engine.remember({ actor: 'ola', scope: 'shared', card: 'MISSION', text: 'We make furniture to measure' });
ok('solo: the company card is shared, as before', r.ok && readFileSync(join(ROOT, 'memory', 'MISSION.md'), 'utf8').includes('furniture'));

// ─── team mode: under users/<slug>/ ──────────────────────────────────────────
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true }));
r = engine.remember({ actor: 'ola', scope: 'private', owner: 'ola', card: 'USER_PROFILE', text: 'Role: CEO' });
ok('team: the person\'s own card goes under users/<slug>/', r.ok && readFileSync(join(ROOT, 'memory', 'users', 'ola', 'USER_PROFILE.md'), 'utf8').includes('Role: CEO'), r);
ok('...and the flat file is not touched', !readFileSync(join(ROOT, 'memory', 'USER_PROFILE.md'), 'utf8').includes('Role: CEO'));
r = engine.remember({ actor: 'ola', scope: 'private', owner: 'kasia', card: 'USER_PROFILE', text: 'x' });
ok('team: another person\'s card is still refused', r.ok === false, r);

console.log(`solo-personal-cards: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
