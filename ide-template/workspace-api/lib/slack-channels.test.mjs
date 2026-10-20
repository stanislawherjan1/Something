/**
 * Slack channels as rooms: an invitation is a request for an admin (never an
 * automatic yes), a shared channel is left at once, approval registers the
 * channel answering mentions only, a guest in the room pauses it and their
 * leaving resumes it, a request nobody answered in a day ends with the bot
 * leaving, and a channel message reaches the group watcher in the shape a
 * Telegram message takes — with its thread, its files and whether the bot
 * was addressed. Slack, the watcher and the clock are injected.
 * Run: node lib/slack-channels.test.mjs
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'slack-channels-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'slack-channels-store-'));
process.env.SLACK_PROXY_URL = '';
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', slackUserId: 'U0STAN001', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', slackUserId: 'U0ANN0001', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true, groups: {} }));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const C = await import('./integrations/slack-channels.js');
const team = await import('./team.js');

// A fake Slack.
const channels = {
  C0GENERAL: { id: 'C0GENERAL', name: 'general', members: ['U0SELF', 'U0STAN001', 'U0ANN0001'] },
  C0SHARED1: { id: 'C0SHARED1', name: 'partner', is_ext_shared: true, members: ['U0SELF', 'U0STAN001', 'U0EXT0001'] },
  C0PRIVATE: { id: 'C0PRIVATE', name: 'ops', is_private: true, members: ['U0SELF', 'U0ANN0001'] },
};
const left = [], notices = [], routed = [];
let clock = Date.parse('2026-10-20T10:00:00Z');
const fakeApi = {
  conversationsInfo: async (id) => { const c = channels[id]; if (!c) throw new Error('channel_not_found'); return { ...c, num_members: c.members.length }; },
  conversationsMembers: async (id) => channels[id].members.slice(),
  conversationsLeave: async (id) => { left.push(id); },
  usersInfo: async (id) => ({ id, real_name: `Person ${id}` }),
};
C.__setDeps({
  api: fakeApi,
  self: () => ({ botUserId: 'U0SELF', teamId: 'T1', team: 'Example' }),
  resolveMember: async () => null,   // a stranger stays a stranger
  notify: (n) => notices.push(n),
  route: (p) => { routed.push(p); return { ok: true, decision: 'buffered' }; },
  now: () => clock,
  log: () => {},
});

// invitation → pending
let r = await C.onChannelEvent({ type: 'member_joined_channel', channel: 'C0GENERAL', user: 'U0SELF', inviter: 'U0ANN0001' });
ok('being added to a channel makes a pending request, not a registration', r.did === 'pending' && !team.getGroup('slack-C0GENERAL') && C.pendingChannels().length === 1, r);
ok('the request names the channel and who invited', C.pendingChannels()[0].title === '#general' && C.pendingChannels()[0].inviterSlug === 'ann');
ok('every admin hears about it', notices.length === 1 && notices[0].recipient === 'stan' && /approval/.test(notices[0].title));
r = await C.onChannelMessage({ type: 'message', channel: 'C0GENERAL', user: 'U0ANN0001', text: 'hello', ts: '1.0' });
ok('a message in a pending channel goes nowhere', r.did === 'ignored' && routed.length === 0);

// a shared channel is left at once
r = await C.onChannelEvent({ type: 'member_joined_channel', channel: 'C0SHARED1', user: 'U0SELF', inviter: 'U0STAN001' });
ok('a shared (Slack Connect) channel is left at once and never pending', r.did === 'left-shared' && left.includes('C0SHARED1') && C.pendingChannels().every(p => p.channel !== 'C0SHARED1'));

// approval
const g = await C.approveChannel('slack-C0GENERAL', { actor: 'stan@example.test' });
ok('approval registers the channel, mentions only by default, and clears the request', g && g.kind === 'slack' && g.requireMention === true && !g.paused && C.pendingChannels().length === 0, g);
ok('the audience was checked at approval: all ours', g.audience?.ok === true && g.audience.members === 3);

// a channel message → the watcher
r = await C.onChannelMessage({ type: 'app_mention', channel: 'C0GENERAL', user: 'U0ANN0001', text: '<@U0SELF> can you check <https://x.test/doc|the doc>?', ts: '2.0', files: [{ url_private: 'https://files.slack.com/f/a.pdf', name: 'a.pdf', mimetype: 'application/pdf', size: 10 }] });
ok('a channel message reaches the watcher as a group message', r.did === 'routed' && routed.length === 1 && routed[0].chat_id === 'slack-C0GENERAL');
const p = routed[0];
ok('...with the sender named from the roster, the markup gone, the mention flagged', p.from_id === 'U0ANN0001' && p.from_name === 'Ann' && p.text === 'can you check the doc (https://x.test/doc)?' && p.is_mention === true, p);
ok('...with its file as a document for the adapter to fetch', p.attachment?.kind === 'document' && p.attachment.file_id === 'https://files.slack.com/f/a.pdf' && p.attachment.name === 'a.pdf');
ok('...and no thread when it is top-level', p.thread_id === null && p.message_id === '2.0');
r = await C.onChannelMessage({ type: 'message', channel: 'C0GENERAL', user: 'U0STAN001', text: 'ok', ts: '2.5', thread_ts: '2.0', parent_user_id: 'U0SELF', files: [{ url_private: 'https://files.slack.com/f/p.png', name: 'p.png', mimetype: 'image/png' }] });
ok('a reply in a thread under the bot carries the thread and counts as a reply to it', routed[1].thread_id === '2.0' && routed[1].is_reply_to_bot === true && routed[1].is_mention === false);
ok('an image becomes a photo reference the adapter understands', routed[1].photo_file_id?.file_id === 'https://files.slack.com/f/p.png' && routed[1].photo_file_id.mime === 'image/png');

// a guest joins → paused; leaves → resumed
channels.C0GENERAL.members.push('U0GUEST01');
notices.length = 0;
r = await C.onChannelEvent({ type: 'member_joined_channel', channel: 'C0GENERAL', user: 'U0GUEST01' });
ok('someone not on the team joining pauses the channel', r.did === 'audience' && team.getGroup('slack-C0GENERAL').paused === true && r.audience.outsiders.includes('U0GUEST01'), r);
ok('...and the admins hear who is in the way', notices.some(n => /paused/.test(n.title) && /1 person not on the team/.test(n.body)));
r = await C.onChannelMessage({ type: 'message', channel: 'C0GENERAL', user: 'U0ANN0001', text: 'hello?', ts: '3.0' });
ok('a message in a paused channel goes nowhere', r.did === 'ignored' && r.why === 'paused' && routed.length === 2);
channels.C0GENERAL.members = channels.C0GENERAL.members.filter(m => m !== 'U0GUEST01');
notices.length = 0;
r = await C.onChannelEvent({ type: 'member_left_channel', channel: 'C0GENERAL', user: 'U0GUEST01' });
ok('the guest leaving resumes it', !team.getGroup('slack-C0GENERAL').paused && notices.some(n => /resumed/.test(n.title)));

// the channel becomes shared → paused
channels.C0GENERAL.is_shared = true;
r = await C.onChannelEvent({ type: 'channel_shared', channel: 'C0GENERAL' });
ok('a registered channel that becomes shared is paused', team.getGroup('slack-C0GENERAL').paused === true && team.getGroup('slack-C0GENERAL').audience.shared === true);
channels.C0GENERAL.is_shared = false;
await C.onChannelEvent({ type: 'channel_unshared', channel: 'C0GENERAL' });
ok('...and resumes when unshared', !team.getGroup('slack-C0GENERAL').paused);

// the bot is removed / the channel archived
r = await C.onChannelEvent({ type: 'channel_left', channel: 'C0GENERAL' });
ok('the bot being removed from a channel unregisters it', r.did === 'removed' && !team.getGroup('slack-C0GENERAL'));

// rejection and the 24 h sweep
await C.onChannelEvent({ type: 'member_joined_channel', channel: 'C0PRIVATE', user: 'U0SELF', inviter: 'U0ANN0001' });
left.length = 0;
await C.rejectChannel('slack-C0PRIVATE');
ok('declining a request makes the bot leave', left.includes('C0PRIVATE') && C.pendingChannels().length === 0);
await C.onChannelEvent({ type: 'member_joined_channel', channel: 'C0PRIVATE', user: 'U0SELF' });
left.length = 0;
clock += 23 * 3600_000;
ok('a request younger than a day stays', (await C.sweepPending()) === 0 && left.length === 0);
clock += 2 * 3600_000;
ok('a request nobody answered in a day ends with the bot leaving', (await C.sweepPending()) === 1 && left.includes('C0PRIVATE') && C.pendingChannels().length === 0);

// approval of a shared channel is refused
await C.onChannelEvent({ type: 'member_joined_channel', channel: 'C0PRIVATE', user: 'U0SELF' });
channels.C0PRIVATE.is_ext_shared = true;
let threw = null; try { await C.approveChannel('slack-C0PRIVATE', { actor: 'stan@example.test' }); } catch (e) { threw = e; }
ok('a channel that turned shared cannot be approved, and is left', /shared/.test(threw?.message || '') && !team.getGroup('slack-C0PRIVATE') && left.includes('C0PRIVATE'));

// an unknown channel event
r = await C.onChannelEvent({ type: 'member_joined_channel', channel: 'C0UNKNOWN', user: 'U0ANN0001' });
ok('a join in a channel the bot is not registered in is ignored', r.did === 'ignored');

console.log(`slack-channels: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
