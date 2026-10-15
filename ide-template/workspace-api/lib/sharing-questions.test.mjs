/**
 * The bot is told that sharing questions wait: once a day at most, in the
 * person's own conversation, never in a group, never without a team.
 * Run: node lib/sharing-questions.test.mjs
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'sq-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'sq-store-'));
process.env.MEMORY_V4 = 'on';
mkdirSync(join(ROOT, 'memory', 'users', 'ann'), { recursive: true });
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team.json'), JSON.stringify({ teamMode: true }));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 500)}` : ''}`); } };

const A = await import('./memory-asks.js');
const C = await import('./claude.js');
const T = await import('./team.js');

ok('nothing waits: no card', C.sharingQuestionsCard('ann') === '');
A.addAsk('ann', { text: 'Vellmark starts the pilot on 4 November.', question: 'Share with the team?', ts: '2026-10-13T10:00:00Z', source: 'web' });
A.addAsk('ann', { text: 'Jarek wants more office presence.', question: 'Share with the team?', ts: '2026-10-13T11:00:00Z', source: 'web' });
const own = C.buildTurnPrefix({ actor: 'ann', groupContext: false });
ok('the person\'s own prefix carries the card, which says so once without listing the questions', /## SHARING_QUESTIONS\n\n2 things from this person's conversations wait for their OK/.test(own.block) && !/Vellmark|Jarek/.test(own.block), own.sources?.map(s => s.id));
ok('...and remembers it was said', !!A.mentionedAt('ann'));
ok('the same day: nothing again', C.sharingQuestionsCard('ann') === '' && !/SHARING_QUESTIONS/.test(C.buildTurnPrefix({ actor: 'ann', groupContext: false }).block));
ok('a day later: said again', /^2 things/.test(C.sharingQuestionsCard('ann', Date.now() + 86400_000 + 1000)));
A.resolveAsk('ann', A.listAsks('ann', { status: 'pending' })[0].id, 'keep');
const group = C.buildTurnPrefix({ actor: 'ann', groupContext: true, groupId: '-100123456' });
ok('a group turn never gets it', !/SHARING_QUESTIONS/.test(group.block) && !/wait for their OK/.test(group.block));
ok('the pending count is what is said', /^1 thing from/.test(C.sharingQuestionsCard('ann', Date.now() + 2 * 86400_000)));
writeFileSync(join(ROOT, '.team.json'), JSON.stringify({ teamMode: false }));
T.setTeamMode?.(false);
ok('no team: no card at all', C.sharingQuestionsCard('ann', Date.now() + 3 * 86400_000) === '');

console.log(`sharing-questions: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
