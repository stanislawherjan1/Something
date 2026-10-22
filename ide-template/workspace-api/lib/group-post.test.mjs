/**
 * Posting into a group because a person asked to (/internal/group-post): the
 * person comes from the turn's own token, they can post only into a registered
 * group they are a member of, and the text lands word for word, in the group's
 * history too. Telegram itself is replaced (configurePostSender).
 *
 * Run: node lib/group-post.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = mkdtempSync(join(tmpdir(), 'group-post-'));
const STORE = mkdtempSync(join(tmpdir(), 'group-post-store-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.BOT_TURN_ID_HASH_FILE = join(STORE, 'bot-turn-id.sha256');
const BOT_TOKEN = 'bot-token-for-tests';
writeFileSync(process.env.BOT_TURN_ID_HASH_FILE, createHash('sha256').update(BOT_TOKEN).digest('hex'));

// Ann is in both groups, Bob only in the team group, Cid has no Telegram linked.
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'ann@example.test', role: 'admin', slug: 'ann', displayName: 'Ann', telegramChatId: '111111111', slackUserId: 'U0ANN00001', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'bob@example.test', role: 'member', slug: 'bob', displayName: 'Bob', telegramChatId: '222222222', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'cid@example.test', role: 'member', slug: 'cid', displayName: 'Cid', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({
  teamMode: true,
  groups: {
    '-1001234567890': { title: 'Team Room', members: { 111111111: 'Ann', 222222222: 'Bob' } },
    '-1009876543210': { title: 'Suppliers', members: { 111111111: 'Ann' } },
    'slack-C0ROOM0001': { title: '#glazes', members: { U0ANN00001: 'Ann' } },
  },
}));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 500)}` : ''}`); }
};

const ti = await import('./turn-identity.js');
const gw = await import('./integrations/group-watcher.js');
const sent = [];
gw.configurePostSender(async (chatId, text, opts) => { sent.push({ chatId, text, opts }); return { ok: true, messageId: 900 + sent.length }; });

const express = (await import('express')).default;
const router = (await import('../routes/internal.js')).default;
const app = express();
app.use(express.json());
app.use('/api', router());
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const post = async (body, token) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-IDE-Turn'] = token;
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/internal/group-post`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const ann = ti.issueTurnToken({ actor: 'ann' });
const bob = ti.issueTurnToken({ actor: 'bob' });
const cid = ti.issueTurnToken({ actor: 'cid' });
const groupTurn = ti.issueTurnToken({ actor: 'ann', group: true, groupId: '-1001234567890' });
const TEXT = 'Hi all,\n\nthe website changes are live: https://example.com\nTell me what to change next.';

let r = await post({ group: 'Team Room', text: TEXT });
ok('no turn token: refused', r.status === 403 && sent.length === 0, r);
r = await post({ group: 'Team Room', text: TEXT }, 'made-up');
ok('a made-up token: refused', r.status === 403 && sent.length === 0, r);
r = await post({ group: 'Suppliers', text: TEXT }, groupTurn);
ok('a group turn cannot reach a group', r.status === 403 && sent.length === 0, r);

r = await post({ group: 'team room', text: TEXT }, ann);
ok('a member posts into her group by name', r.status === 200 && r.body.ok && r.body.group.chatId === '-1001234567890', r);
ok('...word for word, as a group send', sent.length === 1 && sent[0].chatId === '-1001234567890' && sent[0].text === TEXT && sent[0].opts?.logKind === 'group', sent);
const histPath = join(ROOT, '.group-watcher', '-1001234567890-history.jsonl');
const hist = existsSync(histPath) ? readFileSync(histPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
ok('...and the group\'s history has it as the assistant\'s', hist.some((h) => h.role === 'assistant' && h.text === TEXT), hist);

r = await post({ text: TEXT }, ann);
ok('in several groups, no name: asks which, lists them', r.status === 422 && /which/.test(r.body.error) && r.body.groups.length === 3 && sent.length === 1, r);
r = await post({ group: 'supp', text: 'Order update' }, ann);
ok('part of a name finds the one group', r.status === 200 && sent.at(-1).chatId === '-1009876543210', r);

// A Slack channel: by its bare id as Slack shows it, by the registry's id in any case, by its name without the #.
for (const [how, group] of [['bare id', 'C0ROOM0001'], ['lowercased registry id', 'slack-c0room0001'], ['name without #', 'glazes'], ['name with #', '#Glazes']]) {
  const before = sent.length;
  r = await post({ group, text: 'Kiln is on.' }, ann);
  ok(`a Slack channel is found by its ${how}`, r.status === 200 && r.body.group.chatId === 'slack-C0ROOM0001' && sent.length === before + 1 && sent.at(-1).chatId === 'slack-C0ROOM0001', r);
}
r = await post({ group: 'Suppliers', text: TEXT }, bob);
ok('not a member: refused, and the list shows only his own groups', r.status === 422 && r.body.groups.length === 1 && r.body.groups[0].title === 'Team Room' && sent.length === 6, r);
r = await post({ group: 'Suppliers', text: TEXT, actor: 'ann', from: 'ann' }, bob);
ok('naming someone else in the body changes nothing', r.status === 422 && sent.length === 6, r);
r = await post({ group: '-1000000000009', text: TEXT }, bob);
ok('an unregistered chat id: refused', r.status === 422 && sent.length === 6, r);
r = await post({ text: 'Done with the samples.' }, bob);
ok('in one group, no name needed', r.status === 200 && sent.at(-1).chatId === '-1001234567890' && sent.at(-1).text === 'Done with the samples.', r);

r = await post({ group: 'Team Room', text: TEXT }, cid);
ok('no Telegram linked: refused, says why', r.status === 403 && /not a member/.test(r.body.error) && sent.length === 7, r);

r = await post({ group: 'Team Room', text: 'x'.repeat(gw.GROUP_POST_MAX + 1) }, ann);
ok('too long for one message: refused, nothing sent', r.status === 422 && /too long/.test(r.body.error) && sent.length === 7, r);
r = await post({ group: 'Team Room', text: '   ' }, ann);
ok('empty text: refused', r.status === 422 && sent.length === 7, r);

r = await post({ group: 'Suppliers', text: 'From the operator.' }, BOT_TOKEN);
ok('the operator\'s brain posts as the operator', r.status === 200 && sent.at(-1).chatId === '-1009876543210', r);

gw.configurePostSender(async () => ({ ok: false, error: 'telegram 403: bot was kicked' }));
r = await post({ group: 'Team Room', text: 'Still there?' }, ann);
ok('a failed send says so, nothing recorded as sent', r.status === 422 && /kicked/.test(r.body.error), r);

server.close();
console.log(`group-post: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
