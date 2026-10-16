/**
 * The entrypoint makes the parents of the private trees (users/, memory/users/,
 * .team/users/) on a fresh project. Every level it creates must be the workspace
 * group's to write: once, memory/ came out root's 0755 and the card seed could
 * not write a single card. Runs the entrypoint's own loop on a temporary
 * project. Run: node lib/entrypoint-parents.test.mjs
 */
import { readFileSync, mkdtempSync, statSync, existsSync, symlinkSync, mkdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const src = readFileSync(new URL('../../entrypoint.sh', import.meta.url), 'utf8');
const start = src.indexOf('        for d in users memory/users .team/users; do');
// The outer loop's "done" is the first line that is exactly eight spaces + done.
const end = src.indexOf('\n        done\n', src.indexOf('\n            done\n', start) + 1) + '\n        done\n'.length;
ok('(setup) the loop is found in the entrypoint', start > 0 && end > start);
const loop = src.slice(start, end);

const run = (root) => execFileSync('bash', ['-c', loop.replaceAll('/home/coder/project', root)], { encoding: 'utf8' });
const mode = (p) => (statSync(p).mode & 0o7777).toString(8);

const fresh = mkdtempSync(join(tmpdir(), 'ep-parents-'));
run(fresh);
for (const d of ['users', 'memory', 'memory/users', '.team', '.team/users'])
  ok(`a fresh project's ${d}/ is group-writable and setgid (2775)`, existsSync(join(fresh, d)) && mode(join(fresh, d)) === '2775', existsSync(join(fresh, d)) ? mode(join(fresh, d)) : 'missing');

const planted = mkdtempSync(join(tmpdir(), 'ep-parents-link-'));
const target = mkdtempSync(join(tmpdir(), 'ep-parents-target-'));
symlinkSync(target, join(planted, 'memory'));
run(planted);
ok('a link where memory/ should be is replaced by a real directory', !lstatSync(join(planted, 'memory')).isSymbolicLink() && mode(join(planted, 'memory')) === '2775');
ok('...and what the link pointed at is left alone', !existsSync(join(target, 'users')));

const existing = mkdtempSync(join(tmpdir(), 'ep-parents-existing-'));
mkdirSync(join(existing, 'memory'), { mode: 0o755 });
run(existing);
ok('an existing memory/ without group write is put right', mode(join(existing, 'memory')) === '2775', mode(join(existing, 'memory')));

console.log(`entrypoint-parents: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
