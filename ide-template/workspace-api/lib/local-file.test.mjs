/**
 * A local file an MCP tool reads (an upload, an image to edit) is a regular
 * file inside the project directory, resolved through symlinks first.
 * Run: node lib/local-file.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'local-file-'));
const OUTSIDE = mkdtempSync(join(tmpdir(), 'local-file-outside-'));
process.env.PROJECT_DIR = ROOT;
mkdirSync(join(ROOT, 'generated'));
writeFileSync(join(ROOT, 'generated/a.png'), 'x');
writeFileSync(join(OUTSIDE, 'secret.txt'), 'y');
symlinkSync(join(OUTSIDE, 'secret.txt'), join(ROOT, 'generated/link.txt'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${extra}` : ''}`); } };
const throws = (fn) => { try { fn(); return null; } catch (err) { return err.message; } };

const { projectFile } = await import('../../apps/_shared/local-file.js');
ok('a file in the project, by absolute path', projectFile(join(ROOT, 'generated/a.png')).endsWith('generated/a.png'));
ok('...and by a path relative to the project', projectFile('generated/a.png').endsWith('generated/a.png'));
ok('a file outside the project is refused', /outside the project/.test(throws(() => projectFile(join(OUTSIDE, 'secret.txt'))) || ''));
ok('a link in the project to a file outside is refused', /outside the project/.test(throws(() => projectFile('generated/link.txt')) || ''));
ok('a ../ detour is refused', /outside the project/.test(throws(() => projectFile(`generated/../../${OUTSIDE.split('/').pop()}/secret.txt`)) || ''));
ok('a directory is not a file', /not a regular file/.test(throws(() => projectFile('generated')) || ''));
ok('a missing file says so', /Cannot read/.test(throws(() => projectFile('generated/nope.png')) || ''));

console.log(`local-file: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
