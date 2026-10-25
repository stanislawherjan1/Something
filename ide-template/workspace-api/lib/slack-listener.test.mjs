/**
 * What a Slack event becomes. A DM from a roster person is a turn as them,
 * delivered back into that conversation with a status reaction; a DM from a
 * stranger gets one fixed line, once, and lands on the pending list; the bot's
 * own messages, other bots, system subtypes and a message seen before are
 * ignored; a user from another workspace is never matched; a revoked token
 * removes the connection. The API, the turn and the roster are injected.
 * Run: node lib/slack-listener.test.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'slack-listener-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'slack-listener-store-'));
process.env.SLACK_PROXY_URL = '';
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', slackUserId: 'U0ANN0001', addedAt: '2026-09-01T00:00:00Z' },
]));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const L = await import('./integrations/slack-listener.js');
const team = await import('./team.js');

// A fake Slack and a fake turn.
const posted = [], reactions = [], turns = [];
const users = {
  U0STAN001: { id: 'U0STAN001', team_id: 'T1', profile: { email: 'stan@example.test' }, real_name: 'Stan' },
  U0GUEST01: { id: 'U0GUEST01', team_id: 'T1', profile: { email: 'guest@elsewhere.test' }, real_name: 'Guest' },
  U0EXTERN1: { id: 'U0EXTERN1', team_id: 'T9', profile: { email: 'stan@example.test' }, real_name: 'Stan (other org)' },
  U0DELETED: { id: 'U0DELETED', team_id: 'T1', deleted: true, profile: { email: 'ann@example.test' } },
  U0BOTUSER: { id: 'U0BOTUSER', team_id: 'T1', is_bot: true, profile: { email: 'ann@example.test' } },
};
const fakeApi = {
  usersInfo: async (id) => { if (!users[id]) throw new Error('user_not_found'); return users[id]; },
  postMessage: async ({ channel, text, thread_ts }) => { posted.push({ channel, text, thread_ts }); return ['9.9']; },
  addReaction: async (c, ts, name) => { reactions.push(`+${name}`); },
  removeReaction: async (c, ts, name) => { reactions.push(`-${name}`); },
  downloadFile: async (url) => Buffer.from(`file from ${url}`),
};
let revoked = null;
const self = () => ({ user_id: 'U0SELF', bot_id: 'B1', team_id: 'T1', team: 'Example' });
const uploads = [];
fakeApi.uploadFile = async ({ channel, filename, bytes, thread_ts }) => { uploads.push({ channel, filename, size: bytes.length, thread_ts }); return 'F1'; };
const memberDm = (member, body, deps) => { turns.push({ member, body, deps }); return deps.send(deps.target, `echo: ${body}`).then(() => ({ delivered: true, reason: 'slack' })); };
const handle = L.createHandler({ api: fakeApi, self, memberDm, onRevoked: async (why) => { revoked = why; } });

const dm = (over) => ({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U0ANN0001', text: 'hi there', ts: String(Math.random()), ...over });

// a roster member's DM
let r = await handle(dm({ ts: '1.0' }));
await r.done;
ok('a DM from a linked member is a turn as that member, on the Slack surface, into that conversation',
  r.did === 'member-dm' && turns[0].member.slug === 'ann' && turns[0].body === 'hi there' && turns[0].deps.surface === 'slack' && turns[0].deps.target === 'D1', r);
ok('the reply goes back as a post in the DM', posted[0]?.channel === 'D1' && posted[0].text === 'echo: hi there' && !posted[0].thread_ts, posted);
await new Promise(res => setTimeout(res, 10));
ok('eyes while working, a check mark when done', reactions.join(' ') === '+eyes -eyes +white_check_mark', reactions);

// first sighting: matched by email, remembered on the roster
r = await handle(dm({ ts: '2.0', user: 'U0STAN001', channel: 'D2', text: `<@U0SELF> what's up? see <https://x.test/a|the doc> &amp; <#C1|general>` }));
await r.done;
ok('a first DM is matched to the roster by email and the id is remembered', r.did === 'member-dm' && r.slug === 'stan' && team.userBySlackId('U0STAN001')?.slug === 'stan');
ok('the markup is plain text: our mention gone, links as label (url), entities decoded', turns[1].body === "what's up? see the doc (https://x.test/a) & #general", turns[1].body);
const audit = readFileSync(join(ROOT, '.allowed-emails.audit.log'), 'utf8');
ok('the link is audited', /slack_update/.test(audit));

// strangers
r = await handle(dm({ ts: '3.0', user: 'U0GUEST01', channel: 'D3' }));
ok('a workspace user not on the roster gets the fixed line and no turn', r.did === 'stranger-told' && posted.at(-1).channel === 'D3' && /admin/.test(posted.at(-1).text) && turns.length === 2);
const nPosted = posted.length;
r = await handle(dm({ ts: '3.1', user: 'U0GUEST01', channel: 'D3' }));
ok('...once', r.did === 'ignored' && posted.length === nPosted);
ok('...and lands on the pending list with their email', L.pendingUsers().some(p => p.id === 'U0GUEST01' && p.email === 'guest@elsewhere.test'));
r = await handle(dm({ ts: '4.0', user: 'U0EXTERN1', channel: 'D4' }));
ok('a user of another workspace is never matched, even with a roster email', r.did === 'stranger-told' && !team.list().some(m => m.slackUserId === 'U0EXTERN1'));
r = await handle(dm({ ts: '4.1', user: 'U0DELETED', channel: 'D5' }));
ok('a deleted user is not matched', r.did === 'stranger-told' && team.userBySlackId('U0DELETED') === null);
r = await handle(dm({ ts: '4.2', user: 'U0BOTUSER', channel: 'D6' }));
ok('a bot user is not matched', r.did === 'stranger-told');
r = await handle(dm({ ts: '4.3', user: 'U0ANN0001', channel: 'D1', user_team: 'T9' }));
ok('a message stamped with another team id is ignored', r.did === 'ignored' && r.why === 'another workspace');

// ignored shapes
const before = turns.length;
for (const [name, ev] of [
  ['own message', dm({ ts: '5.0', user: 'U0SELF' })],
  ['a bot', dm({ ts: '5.1', bot_id: 'B9' })],
  ['bot_message subtype', dm({ ts: '5.2', subtype: 'bot_message' })],
  ['channel_join', dm({ ts: '5.3', subtype: 'channel_join' })],
  ['message_changed', dm({ ts: '5.4', subtype: 'message_changed' })],
  ['message_deleted', dm({ ts: '5.5', subtype: 'message_deleted' })],
  ['an unknown type', { type: 'reaction_added', channel: 'D1', ts: '5.6' }],
  ['no ts', dm({ ts: undefined })],
  ['empty text', dm({ ts: '5.7', text: '' })],
]) {
  const x = await handle(ev);
  ok(`${name} is ignored`, x.did === 'ignored', x);
}
ok('...with no turn started', turns.length === before);

// dedup: a mention arrives as app_mention and as message
r = await handle({ type: 'app_mention', channel: 'D1', channel_type: 'im', user: 'U0ANN0001', text: 'x', ts: '6.0' });
await r.done;
const again = await handle(dm({ ts: '6.0', text: 'x' }));
ok('the same message (channel+ts) is handled once', r.did === 'member-dm' && again.did === 'ignored' && again.why === 'seen');

// a file the reply hands over goes into the conversation through Slack's upload
writeFileSync(join(ROOT, 'audit.md'), '# audit\n');
await turns.at(-1).deps.sendFile('D1', { abs: join(ROOT, 'audit.md'), name: 'audit.md' });
ok('the DM turn can attach a file into its conversation', uploads.length === 1 && uploads[0].channel === 'D1' && uploads[0].filename === 'audit.md' && uploads[0].size > 0, uploads);

// threads and files
r = await handle(dm({ ts: '7.1', thread_ts: '7.0', text: 'in a thread', files: [{ id: 'F1', name: 'notes.txt', url_private: 'https://files.slack.com/f/notes.txt' }] }));
await r.done;
ok('a reply in a thread stays in that thread', posted.at(-1).thread_ts === '7.0');
{
  const now = Date.now(), sec = (ago) => String((now - ago) / 1000);
  const fake = { conversationsHistory: async () => [
    { ts: sec(3 * 86400_000), text: 'top-level, no thread' },
    { ts: sec(2 * 86400_000), thread_ts: sec(2 * 86400_000), reply_count: 3, latest_reply: sec(2 * 86400_000 - 60_000), text: 'older conversation' },
    { ts: sec(5 * 3600_000), thread_ts: sec(5 * 3600_000), reply_count: 2, latest_reply: sec(4 * 3600_000), text: 'newest conversation' },
  ] };
  const got = await L.recoverPane('U0LATE001', 'D9', { api: fake }, now);
  ok('with no pane on record, the newest conversation in their DM is found and kept', got?.thread_ts === sec(5 * 3600_000) && L.dmPlace('U0LATE001', now)?.thread_ts === sec(5 * 3600_000), got);
  const none = await L.recoverPane('U0LATE002', 'D8', { api: { conversationsHistory: async () => [{ ts: sec(1000), text: 'only top-level' }] } }, now);
  ok('...and nothing is made up when their DM has no conversation thread', none === null && L.dmPlace('U0LATE002', now) === null);
  const stale = await L.recoverPane('U0LATE003', 'D7', { api: { conversationsHistory: async () => [{ ts: sec(9 * 86400_000), thread_ts: sec(9 * 86400_000), reply_count: 1, latest_reply: sec(9 * 86400_000) }] } }, now);
  ok('...nor a conversation older than a week', stale === null);
}
ok('a message for that person later goes into the conversation they last wrote in', JSON.stringify(L.dmPlace('U0ANN0001')) === '{"channel":"D1","thread_ts":"7.0"}', L.dmPlace('U0ANN0001'));
ok('...still a day later (a week is kept), not once it is stale, and nowhere for someone who never wrote in one', !!L.dmPlace('U0ANN0001', Date.now() + 26 * 3600_000) && L.dmPlace('U0ANN0001', Date.now() + 8 * 24 * 3600_000) === null && L.dmPlace('U0NOBODY1') === null);
ok('...and it is kept on disk, so a restart does not send it to Activity', JSON.parse(readFileSync(join(ROOT, '.team', 'slack-pane-threads.json'), 'utf8')).U0ANN0001?.thread_ts === '7.0');
{
  const opened = await handle({ type: 'assistant_thread_started', assistant_thread: { user_id: 'U0STAN001', channel_id: 'D2', thread_ts: '9.0' } });
  ok('opening the assistant pane is enough to know where a message for that person goes', opened.did === 'pane-opened' && JSON.stringify(L.dmPlace('U0STAN001')) === '{"channel":"D2","thread_ts":"9.0"}', L.dmPlace('U0STAN001'));
}
ok('a file the person sent is saved and named to the turn', /\[Attachments — read these files to answer\]\n- \.attachments\/slack-ann\/\d+\/notes\.txt/.test(turns.at(-1).body), turns.at(-1).body);
const saved = readFileSync(join(ROOT, turns.at(-1).body.match(/- (\.attachments\/[^\n]+)/)[1]), 'utf8');
ok('...with the bytes Slack served', saved === 'file from https://files.slack.com/f/notes.txt');

// the assistant pane: a status line and a title instead of reactions
const statuses = [], titles = [];
fakeApi.setAssistantStatus = async (c, t, s) => { statuses.push(s); };
fakeApi.setAssistantTitle = async (c, t, title) => { titles.push(title); };
reactions.length = 0;
r = await handle(dm({ ts: '7.5', thread_ts: '7.5', text: 'plan my week' }));
await r.done;
await new Promise(res => setTimeout(res, 10));
ok('in the assistant pane the thread gets a status while working and a title from the first words', statuses.join('|') === 'is thinking…|' && titles[0] === 'plan my week' && reactions.length === 0, { statuses, titles, reactions });
r = await handle(dm({ ts: '7.6', thread_ts: '7.5', text: 'and next week' }));
await r.done;
ok('...the title is set once per thread', titles.length === 1);

// catch-up after a lost window: live DMs are read back, the dedup keeps repeats out
fakeApi.conversationsHistory = async (channel, { oldest }) => (channel === 'D1' ? [
  { ts: '7.6', user: 'U0ANN0001', text: 'and next week' },          // already seen
  { ts: '7.9', user: 'U0ANN0001', text: 'missed while down' },
  { ts: '7.95', user: 'U0SELF', text: 'own' },
  { ts: '7.97', user: 'U0ANN0001', bot_id: 'B2', text: 'a bot' },
  { ts: '7.98', user: 'U0ANN0001', subtype: 'channel_join', text: 'x' },
] : []);
const nTurns = turns.length;
const cu = await L.catchUp(new Date(Date.now() - 60_000).toISOString(), { api: fakeApi, handle });
ok('the catch-up handles only the messages not seen before, from people', cu.messages === 1 && turns.length === nTurns + 1 && turns.at(-1).body === 'missed while down', cu);
ok('a catch-up with no window does nothing', (await L.catchUp(null, { api: fakeApi, handle })).messages === 0);
{
  // channels: only the messages that mention the bot, in approved channels
  const routed = [];
  const h2 = async (ev) => { if (ev.channel_type === 'channel') { routed.push(ev.text); return { did: 'routed' }; } return { did: 'ignored' }; };
  const api2 = { conversationsHistory: async (channel) => (channel === 'C9' ? [
    { ts: '9.2', user: 'U0ANN0001', text: 'just chatting' },
    { ts: '9.1', user: 'U0ANN0001', text: '<@U0SELF> where are we with Northbeam?' },
    { ts: '9.3', user: 'U0SELF', text: '<@U0SELF> own' },
  ] : []) };
  const c2 = await L.catchUp(new Date(Date.now() - 60_000).toISOString(), { api: api2, handle: h2, rooms: () => ['C9'], selfId: () => 'U0SELF' });
  ok('after a restart a mention in an approved channel is read back and handled, other chatter is not', c2.mentions === 1 && routed.length === 1 && /Northbeam/.test(routed[0]), { c2, routed });
}
{
  // a restart: where the last process left off is on disk
  writeFileSync(join(ROOT, '.team', 'slack-listener-state.json'), JSON.stringify({ lastEventAt: new Date(Date.now() - 120_000).toISOString(), dms: { D7: Date.now() - 60_000 } }));
  const since = L.restoreState();
  ok('the last process\'s last event is where the catch-up starts', !!since && Date.now() - Date.parse(since) < 200_000, since);
  writeFileSync(join(ROOT, '.team', 'slack-listener-state.json'), JSON.stringify({ lastEventAt: new Date(Date.now() - 3 * 3600_000).toISOString() }));
  ok('...not when it is hours old (that is not a restart, it is a pause)', L.restoreState() === null);
}

// a channel message with no channel handler yet
r = await handle({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U0ANN0001', text: 'hello all', ts: '8.0' });
ok('a channel message with no channel handler is silent', r.did === 'ignored');

// revocation
r = await handle({ type: 'tokens_revoked' });
ok('tokens_revoked removes the connection', r.did === 'revoked' && revoked === 'tokens_revoked');

// status shape
const s = L.status();
ok('status reports the socket state for the page', s && typeof s.running === 'boolean' && typeof s.connected === 'boolean' && Array.isArray(s.lost));

console.log(`slack-listener: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
