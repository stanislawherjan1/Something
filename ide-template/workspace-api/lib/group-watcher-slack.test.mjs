/**
 * The group watcher with a Slack channel behind the adapter: a message in an
 * approved channel is buffered like a Telegram group's, the sender is the
 * roster person behind the Slack id, a paused channel is silent, a Slack id
 * that is not registered is ignored, a direct post goes into the channel
 * through the Slack adapter and a reminder aimed at it too; the files a group
 * keeps are named after the Slack id, and the group turn is fenced to that
 * channel's own scope. No model, no network: the adapter is a fake.
 * Run: node lib/group-watcher-slack.test.mjs
 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'gw-slack-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'gw-slack-store-'));
process.env.SLACK_PROXY_URL = '';
process.env.GROUP_WATCHER_QUIET_MS = '20';
process.env.GROUP_WATCHER_MAX_WINDOW_MS = '40';
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', slackUserId: 'U0STAN001', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', slackUserId: 'U0ANN0001', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true, groups: {
  'slack-C0GENERAL': { title: '#general', requireMention: true, addedAt: '2026-10-01T00:00:00Z', members: {} },
  'slack-C0PAUSED1': { title: '#paused', requireMention: true, paused: true, addedAt: '2026-10-01T00:00:00Z', members: {} },
  '-1001234567890': { title: 'Team Room', addedAt: '2026-10-01T00:00:00Z', members: {} },
} }));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const A = await import('./integrations/channel-adapter.js');
const sends = [], reacts = [];
A.__setAdapter('slack', {
  kind: 'slack', label: 'Slack', roomNoun: 'Slack CHANNEL', replyMax: 12000,
  prompt: { otherBots: '- OTHER BOTS: none.', reactions: 'a common emoji.' },
  send: async (chatId, text, opts) => { sends.push({ chatId, text, opts }); return { ok: true, messageId: `${sends.length}.0` }; },
  sendFile: async () => ({ ok: true }), typing: async () => {}, react: async (c, m, e) => { reacts.push(e); return { ok: true }; },
  download: async () => ({ ok: false, error: 'no' }),
  memberOf: (id) => (id === 'U0ANN0001' ? { slug: 'ann', displayName: 'Ann', role: 'member' } : id === 'U0STAN001' ? { slug: 'stan', displayName: 'Stan', role: 'admin' } : null),
  selfId: () => 'U0SELF', isSelf: (id) => id === 'U0SELF', ensureSelf: () => {}, sendingReady: () => true,
  replyRef: (t) => (t && t.message_id && !/^(sys-|n)/.test(String(t.message_id)) ? { thread_ts: String(t.thread_id || t.message_id) } : {}),
  creatorOf: async () => null, afterRegister: async () => {},
});

const gw = await import('./integrations/group-watcher.js');
const team = await import('./team.js');

// routing
let r = gw.routeGroupMessage({ chat_id: 'slack-C0GENERAL', chat_title: '#general', message_id: '10.0', text: 'hello everyone', from_id: 'U0ANN0001', from_name: 'Ann', is_mention: true });
ok('a message in an approved Slack channel is buffered', r.decision === 'buffered', r);
r = gw.routeGroupMessage({ chat_id: 'slack-C0GENERAL', message_id: '10.0', text: 'hello everyone', from_id: 'U0ANN0001' });
ok('the same message again is a duplicate', r.reason_enum === 'duplicate');
r = gw.routeGroupMessage({ chat_id: 'slack-C0PAUSED1', message_id: '11.0', text: 'anyone?', from_id: 'U0ANN0001', is_mention: true });
ok('a paused channel is silent', r.decision === 'ignore' && r.reason_enum === 'paused', r);
r = gw.routeGroupMessage({ chat_id: 'slack-C0NOTREG1', message_id: '12.0', text: 'hi', from_id: 'U0ANN0001' });
ok('an unregistered Slack channel is ignored (no retro-registration for Slack)', r.reason_enum === 'not-allowed' && !team.getGroup('slack-C0NOTREG1'));
r = gw.routeGroupMessage({ chat_id: 'slack-c0bad', message_id: '13.0', text: 'hi', from_id: 'U0ANN0001' });
ok('a malformed id is not a group', r.reason_enum === 'not-allowed');
ok('the sender was recorded as a member of the channel by their Slack id', team.getGroup('slack-C0GENERAL').members?.U0ANN0001 === 'Ann');
ok('...so the channel counts among the groups she is in', team.memberGroupsOf('ann').includes('slack-C0GENERAL'));

await new Promise(res => setTimeout(res, 120));
const hist = join(ROOT, '.group-watcher', 'slack-C0GENERAL-history.jsonl');
ok('the channel\'s durable history is named after its Slack id', existsSync(hist) && /hello everyone/.test(readFileSync(hist, 'utf8')) && /"who":"Ann"/.test(readFileSync(hist, 'utf8')));

// the group turn is fenced to this channel's scope
const params = gw.groupTurnParams(team.getGroup('slack-C0GENERAL'), [{ role: 'user', message_id: '10.0', from_id: 'U0ANN0001', who: 'Ann', text: 'hello everyone', ts: new Date().toISOString() }], { message_id: '10.0', from_id: 'U0ANN0001', text: 'hello everyone' });
ok('the group turn runs as the roster person behind the Slack id, in group context, on this channel only', params.actor === 'ann' && params.groupContext === true && params.groupId === 'slack-C0GENERAL');
ok('the prompt speaks of a Slack channel and points at the channel\'s own transcript', /Slack CHANNEL/.test(params.message) && params.message.includes('slack-C0GENERAL-history.jsonl') && !/Telegram GROUP CHAT/.test(params.message));
ok('the Slack adapter\'s own bots/reactions lines are in the prompt', /OTHER BOTS: none/.test(params.message) && /a common emoji/.test(params.message));

// an open-audience room: the turn is group-only
team.touchGroupMeta('slack-C0GENERAL', { openAudience: true, audience: { ok: false, outsiders: ['U0GUEST01'], shared: false, members: 3 } });
const openParams = gw.groupTurnParams(team.getGroup('slack-C0GENERAL'), [], { message_id: '10.0', from_id: 'U0ANN0001', text: 'x' });
ok('an open room with an outsider in it runs its turn on the room\'s scope only', openParams.groupOnly === true && /OPEN AUDIENCE/.test(openParams.message));
team.touchGroupMeta('slack-C0GENERAL', { audience: { ok: true, outsiders: [], shared: false, members: 2 } });
ok('...the same room with everyone on the team is an ordinary room', gw.groupTurnParams(team.getGroup('slack-C0GENERAL'), [], { message_id: '10.0', from_id: 'U0ANN0001', text: 'x' }).groupOnly === false);
team.touchGroupMeta('slack-C0GENERAL', { openAudience: false });
const ledger = await import('./memory-ledger.js');
ok('group-only reads the room and nothing shared', JSON.stringify(ledger.readableScopes({ groupId: 'slack-C0GENERAL', groupOnly: true })) === '["group:slack-C0GENERAL"]' && JSON.stringify(ledger.readableScopes({ groupId: 'slack-C0GENERAL' })) === '["shared","group:slack-C0GENERAL"]');
const ti = await import('./turn-identity.js');
const tok = ti.issueTurnToken({ actor: 'ann', group: true, groupId: 'slack-C0GENERAL', groupOnly: true });
ok('the turn token carries group-only', ti.resolveTurnToken(tok).groupOnly === true && ti.resolveTurnToken(ti.issueTurnToken({ actor: 'ann', group: false, groupOnly: true })).groupOnly === false);

// a direct post goes through the adapter, top-level
gw.configurePostSender(null);
r = await gw.postToGroup({ chatId: 'slack-C0GENERAL', text: 'Posted as asked.' });
ok('a direct post lands in the channel through the Slack adapter', r.ok && sends.at(-1).chatId === 'slack-C0GENERAL' && sends.at(-1).text === 'Posted as asked.' && !sends.at(-1).opts?.thread_ts, sends.at(-1));
r = await gw.postToGroup({ chatId: 'slack-C0PAUSED1', text: 'x' });
ok('a direct post into a paused channel is refused', !r.ok && /paused/.test(r.error));
r = await gw.postToGroup({ chatId: 'slack-C0GENERAL', text: 'y'.repeat(4001) });
ok('the post limit is the smaller of ours and the platform\'s', !r.ok && /too long for one Slack message/.test(r.error));
r = await gw.sayInGroup({ chatId: 'slack-C0PAUSED1', text: 'remind them' });
ok('a reminder aimed at a paused channel is refused, not swallowed', !r.ok && /paused/.test(r.error));
ok('sending is enabled per platform', gw.sendingEnabled('slack-C0GENERAL') === true);

// a Telegram group still takes the Telegram adapter
A.__setAdapter('telegram', { kind: 'telegram', label: 'Telegram', roomNoun: 'Telegram GROUP CHAT', replyMax: 4000, prompt: { otherBots: '- OTHER BOTS: tg.', reactions: 'tg set.' },
  send: async (chatId, text) => { sends.push({ chatId, text, tg: true }); return { ok: true, messageId: 7 }; }, sendFile: async () => ({ ok: true }), typing: async () => {}, react: async () => ({ ok: true }),
  download: async () => ({ ok: false }), memberOf: () => null, selfId: () => '999', isSelf: () => false, ensureSelf: () => {}, sendingReady: () => true, replyRef: () => ({}), creatorOf: async () => null, afterRegister: async () => {} });
r = await gw.postToGroup({ chatId: '-1001234567890', text: 'tg post' });
ok('a Telegram group posts through the Telegram adapter', r.ok && sends.at(-1).tg === true && sends.at(-1).chatId === '-1001234567890');
const tgParams = gw.groupTurnParams(team.getGroup('-1001234567890'), [], { message_id: '1', from_id: '111', text: 'x' });
ok('...and its prompt still says Telegram', /Telegram GROUP CHAT/.test(tgParams.message) && /OTHER BOTS: tg/.test(tgParams.message));

console.log(`group-watcher-slack: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
