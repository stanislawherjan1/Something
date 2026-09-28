/**
 * Who a memory call comes from (lib/turn-identity.js): a turn token proves it;
 * a claimed slug alone proves nothing.
 *
 * Run: node lib/turn-identity.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'turn-id-'));
const BOT_TOKEN = 'bot-token-for-tests-0123456789';
process.env.BOT_TURN_ID_HASH_FILE = join(dir, 'bot.sha256');
writeFileSync(process.env.BOT_TURN_ID_HASH_FILE, createHash('sha256').update(BOT_TOKEN).digest('hex'));
const { issueTurnToken, revokeTurnToken, resolveTurnToken } = await import('./turn-identity.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${extra}` : ''}`); } };

const t = issueTurnToken({ actor: 'anna', group: false });
ok('a turn token resolves to its own actor', resolveTurnToken(t, 'mark')?.actor === 'anna', JSON.stringify(resolveTurnToken(t, 'mark')));
ok('...whatever slug the caller claims', resolveTurnToken(t, 'mark')?.actor !== 'mark');
const g = issueTurnToken({ actor: 'anna', group: true });
ok('a group turn stays a group turn', resolveTurnToken(g)?.group === true);
revokeTurnToken(t);
ok('a revoked token proves nothing', resolveTurnToken(t, 'anna') === null);
ok('no token proves nothing', resolveTurnToken('', 'anna') === null && resolveTurnToken(undefined, 'anna') === null);
ok('a made-up token proves nothing', resolveTurnToken('guess', 'anna') === null);
ok('the bot token carries the slug the bot sends', resolveTurnToken(BOT_TOKEN, 'stan')?.actor === 'stan');
ok('...but only a well-formed one', resolveTurnToken(BOT_TOKEN, '../x')?.actor === null);
ok('the solo actor is no actor', resolveTurnToken(issueTurnToken({ actor: 'default' }))?.actor === null);

console.log(`turn-identity: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
