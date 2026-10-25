/**
 * The channel adapter: the right platform for a group id, a reply in Slack
 * goes into the message's thread, an emoji becomes Slack's name for it (or is
 * refused), a file the brain may send must be a regular file under the project
 * directory, and the sender is resolved on the right roster field.
 * Run: node lib/channel-adapter.test.mjs
 */
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'channel-adapter-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'channel-adapter-store-'));
process.env.SLACK_PROXY_URL = '';
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', telegramChatId: '2220002', slackUserId: 'U0ANN0001', addedAt: '2026-09-01T00:00:00Z' },
]));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const A = await import('./integrations/channel-adapter.js');

ok('a Telegram chat id gets the Telegram adapter', A.adapterFor('-1001234567890').kind === 'telegram');
ok('a Slack channel id gets the Slack adapter', A.adapterFor('slack-C0123ABCD').kind === 'slack');
ok('something that is no group id falls back to Telegram (legacy callers)', A.adapterFor(null).kind === 'telegram' && A.adapterFor('junk').kind === 'telegram');

const slack = A.adapterFor('slack-C0123ABCD');
const tg = A.adapterFor('-1001234567890');
ok('each platform names its room and its limits', slack.roomNoun === 'Slack CHANNEL' && tg.roomNoun === 'Telegram GROUP CHAT' && slack.replyMax > tg.replyMax);
ok('a Slack reply to a channel message goes into the channel, not a new thread', JSON.stringify(slack.replyRef({ message_id: '1700.1' })) === '{}');
ok('...and a reply to a message in a thread goes into that thread', JSON.stringify(slack.replyRef({ message_id: '1700.5', thread_id: '1700.1' })) === '{"thread_ts":"1700.1"}');
ok('a scheduled frame (no real message) posts top-level', JSON.stringify(slack.replyRef({ message_id: 'sys-123' })) === '{}' && JSON.stringify(slack.replyRef(null)) === '{}');
ok('a Telegram group is one stream', JSON.stringify(tg.replyRef({ message_id: '42' })) === '{}');
ok('the sender is resolved on each platform\'s roster field', slack.memberOf('U0ANN0001')?.slug === 'ann' && tg.memberOf('2220002')?.slug === 'ann' && slack.memberOf('2220002') === null && tg.memberOf('U0ANN0001') === null);

// reactions
ok('an emoji becomes Slack\'s name for it', A.slackReactionName('👀') === 'eyes' && A.slackReactionName('👍') === '+1' && A.slackReactionName('✅') === 'white_check_mark' && A.slackReactionName('🫡') === 'saluting_face');
ok('a Slack name passes through', A.slackReactionName('thumbsup') === 'thumbsup');
ok('anything else is refused', A.slackReactionName('🧿') === null && A.slackReactionName('') === null && A.slackReactionName('not a name!') === null);
ok('a channel id is the id behind the prefix', A.slackChannelOf('slack-C0123ABCD') === 'C0123ABCD' && A.slackChannelOf('C0123ABCD') === 'C0123ABCD');

// files
mkdirSync(join(ROOT, 'out'), { recursive: true });
writeFileSync(join(ROOT, 'out', 'report.pdf'), 'pdf');
const outside = mkdtempSync(join(tmpdir(), 'outside-'));
writeFileSync(join(outside, 'secret.txt'), 'no');
symlinkSync(join(outside, 'secret.txt'), join(ROOT, 'out', 'link.txt'));
ok('a file under the project directory may go', A.confinedFile(join(ROOT, 'out', 'report.pdf')).ok && A.confinedFile('out/report.pdf').name === 'report.pdf');
ok('a file outside may not', !A.confinedFile(join(outside, 'secret.txt')).ok && /outside/.test(A.confinedFile(join(outside, 'secret.txt')).error));
ok('...nor through a link pointing outside', !A.confinedFile(join(ROOT, 'out', 'link.txt')).ok);
ok('...nor a directory, a missing file, or nothing', !A.confinedFile(join(ROOT, 'out')).ok && !A.confinedFile(join(ROOT, 'nope.txt')).ok && !A.confinedFile('').ok);
ok('a Slack send of a file outside the project is refused before any upload', (await slack.sendFile('C1', join(outside, 'secret.txt'))).ok === false);

// the test seam
A.__setAdapter('slack', { kind: 'slack', fake: true });
ok('a test may swap an adapter in', A.adapterFor('slack-C0123ABCD').fake === true);
A.__setAdapter('slack', null);
ok('...and out', !A.adapterFor('slack-C0123ABCD').fake);

console.log(`channel-adapter: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
