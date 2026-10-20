/**
 * Where a filed window came from: a web chat is 'web' unless every human line
 * in it was mirrored from one surface (Telegram, Slack) — then it is that
 * surface's, and "See source" says so. Run: node lib/memory-source-of.test.mjs
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.PROJECT_DIR = mkdtempSync(join(tmpdir(), 'source-of-'));
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'source-of-store-'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}`); } };
const { sourceOf } = await import('./memory-consolidator.js');
const web = { kind: 'web' };
ok('a plain web chat is web', sourceOf(web, [{ human: true }, { human: false }]) === 'web');
ok('a mirrored Slack DM is slack', sourceOf(web, [{ human: true, kind: 'slack' }, { human: false, kind: 'bot' }, { human: true, kind: 'slack' }]) === 'slack');
ok('a mirrored Telegram DM is telegram', sourceOf(web, [{ human: true, kind: 'telegram' }]) === 'telegram');
ok('a mix stays web', sourceOf(web, [{ human: true, kind: 'slack' }, { human: true }]) === 'web');
ok('an unknown kind stays web', sourceOf(web, [{ human: true, kind: 'fax' }]) === 'web');
ok('no human line stays web', sourceOf(web, [{ human: false, kind: 'bot' }]) === 'web');
ok('the Telegram log is telegram, a group is group', sourceOf({ kind: 'dm' }, []) === 'telegram' && sourceOf({ kind: 'group' }, []) === 'group');
console.log(`memory-source-of: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
