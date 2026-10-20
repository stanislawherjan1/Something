/**
 * A person's preferred surfaces are a set; the one word older roster files and
 * clients use ('both') still reads and still comes back out of the set.
 * Run: node lib/surfaces.test.mjs
 */
import { normalizeSurfaces, parseSurfaces, prefers, legacySurface, describeSurfaces } from './surfaces.js';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}`); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Reading what is on disk — the old word or the set.
ok("'both' is web + telegram", same(normalizeSurfaces('both'), ['web', 'telegram']));
ok("'telegram' alone", same(normalizeSurfaces('telegram'), ['telegram']));
ok("'web' alone", same(normalizeSurfaces('web'), ['web']));
ok('a set is kept in a fixed order and deduplicated', same(normalizeSurfaces(['slack', 'web', 'web', 'telegram']), ['web', 'telegram', 'slack']));
ok('case and spaces are forgiven', same(normalizeSurfaces([' Slack ', 'WEB']), ['web', 'slack']));
for (const v of [null, undefined, '', [], 'fax', ['web', 'fax'], 42, {}, 'web,fax']) ok(`${JSON.stringify(v)} reads as unset`, normalizeSurfaces(v) === null);

// Writing — strict.
ok('parse: both', same(parseSurfaces('both'), ['web', 'telegram']));
ok('parse: a set', same(parseSurfaces(['web', 'slack']), ['web', 'slack']));
ok('parse: cleared', parseSurfaces('') === null && parseSurfaces(null) === null);
let threw = false; try { parseSurfaces('fax'); } catch { threw = true; } ok('parse: junk throws', threw);
threw = false; try { parseSurfaces(['web', 'fax']); } catch { threw = true; } ok('parse: one junk name spoils the set', threw);

// Gating — exactly what the old comparisons meant.
ok("'both' prefers telegram", prefers({ preferredSurface: 'both' }, 'telegram'));
ok("'telegram' prefers telegram", prefers({ preferredSurface: 'telegram' }, 'telegram'));
ok("'web' does not prefer telegram", !prefers({ preferredSurface: 'web' }, 'telegram'));
ok('unset prefers nothing', !prefers({ preferredSurface: null }, 'telegram') && !prefers({}, 'web') && !prefers(null, 'web'));
ok('the set wins over the word when both are present', prefers({ surfaces: ['web', 'slack'], preferredSurface: 'web' }, 'slack'));
ok('slack in the set', prefers({ surfaces: ['slack'] }, 'slack') && !prefers({ surfaces: ['slack'] }, 'telegram'));

// The old word, for clients that still speak it.
ok('legacy: web+telegram → both', legacySurface(['web', 'telegram']) === 'both');
ok('legacy: telegram+slack → telegram', legacySurface(['telegram', 'slack']) === 'telegram');
ok('legacy: slack alone → null', legacySurface(['slack']) === null);
ok('legacy: unset → null', legacySurface(null) === null);
ok('legacy round-trips the word', legacySurface('both') === 'both' && legacySurface('web') === 'web');
ok('describe', describeSurfaces(['web', 'slack']) === 'web and Slack' && describeSurfaces('both') === 'web and Telegram');
console.log(`surfaces: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
