/**
 * The Slack Web API client: a call is one POST with the token as a Bearer
 * header, `ok: false` throws with Slack's error code, a 429 waits out
 * Retry-After once, a long text is cut at paragraph boundaries into markdown
 * blocks, posts in one channel go out one at a time, the markdown block falls
 * back to plain text where it is refused, and a file download accepts only
 * Slack's own hosts. The transport is injected; no network.
 * Run: node lib/slack-api.test.mjs
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.PROJECT_DIR = mkdtempSync(join(tmpdir(), 'slack-api-'));
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'slack-api-store-'));
process.env.SLACK_PROXY_URL = '';   // no proxy in the test rig

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const api = await import('./integrations/slack-api.js');

// A fake transport: records every request, answers from a script.
const calls = [];
let script = [];
const reply = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body, arrayBuffer: async () => body,
});
api.configure({ fetch: async (url, init) => { calls.push({ url: String(url), init }); const next = script.shift(); return next || reply(200, { ok: true }); } });

// call()
script = [reply(200, { ok: true, user: { id: 'U1' } })];
let r = await api.call('users.info', { user: 'U1' }, { token: 'xoxb-test' });
ok('a call is one POST to slack.com/api/<method> as JSON with a Bearer token',
  calls[0].url === 'https://slack.com/api/users.info' && calls[0].init.method === 'POST'
  && calls[0].init.headers.Authorization === 'Bearer xoxb-test' && JSON.parse(calls[0].init.body).user === 'U1' && r.user.id === 'U1', calls[0]);

script = [reply(200, { ok: false, error: 'channel_not_found' })];
let threw = null; try { await api.call('chat.postMessage', {}, { token: 't' }); } catch (e) { threw = e; }
ok("ok:false throws a SlackError carrying Slack's code", threw instanceof api.SlackError && threw.code === 'channel_not_found' && threw.method === 'chat.postMessage');

threw = null; try { await api.call('auth.test', {}, { token: '' }); } catch (e) { threw = e; }
ok('no token → no_token, and no request is made', threw?.code === 'no_token' && calls.length === 2);

script = [reply(429, {}, { 'retry-after': '0' }), reply(200, { ok: true, retried: true })];
const t0 = Date.now();
r = await api.call('auth.test', {}, { token: 't' });
ok('a 429 is retried once after Retry-After', r.retried === true && calls.length === 4 && Date.now() - t0 < 2000);
script = [reply(429, {}, { 'retry-after': '0' }), reply(429, {}, { 'retry-after': '0' })];
threw = null; try { await api.call('auth.test', {}, { token: 't' }); } catch (e) { threw = e; }
ok('...and only once', threw?.code === 'http_429');

// splitText
ok('a short text is one piece', JSON.stringify(api.splitText('hello')) === '["hello"]' && api.splitText('').length === 0);
const para = 'x'.repeat(50);
const long = Array.from({ length: 6 }, (_, i) => `p${i} ${para}`).join('\n\n');
const pieces = api.splitText(long, 120);
ok('a long text is cut at paragraph boundaries, in order, nothing lost',
  pieces.length > 1 && pieces.every(p => p.length <= 120) && pieces.join('\n\n') === long, pieces.map(p => p.length));
const noBreaks = 'y'.repeat(300);
ok('a text with no boundaries is cut hard', api.splitText(noBreaks, 100).length === 3);

// messageBody
const body = api.messageBody('**hi**');
ok('a message is a markdown block with the same text as the fallback', body.text === '**hi**' && body.blocks[0].type === 'markdown' && body.blocks[0].text === '**hi**');

// postMessage: needs a token from the store → inject via the token option path by stubbing tokens through the store
const store = await import('./integrations/store.js');
const { isReady } = await import('./integrations/crypto.js');
if (isReady()) {
  store.activate('slack', { fields: { SLACK_BOT_TOKEN: 'xoxb-live', SLACK_APP_TOKEN: 'xapp-live' } }, { owner: 'stan', reach: 'workspace' });
  calls.length = 0;
  script = [reply(200, { ok: true, ts: '1.1' }), reply(200, { ok: true, ts: '1.2' })];
  const ts = await api.postMessage({ channel: 'C1', text: 'a\n\nb', thread_ts: '0.9' });
  ok('a post carries the thread and the markdown block, and returns the ts', ts.length === 1 && ts[0] === '1.1' && JSON.parse(calls[0].init.body).thread_ts === '0.9' && JSON.parse(calls[0].init.body).blocks[0].type === 'markdown');
  calls.length = 0;
  script = [reply(200, { ok: false, error: 'invalid_blocks' }), reply(200, { ok: true, ts: '2.1' })];
  const ts2 = await api.postMessage({ channel: 'C1', text: 'plain' });
  ok('a workspace that refuses the markdown block gets plain text', ts2[0] === '2.1' && !('blocks' in JSON.parse(calls[1].init.body)) && JSON.parse(calls[1].init.body).text === 'plain');
  calls.length = 0;
  script = [reply(200, { ok: true, ts: '3.1' }), reply(200, { ok: true, ts: '3.2' })];
  const t1 = Date.now();
  await Promise.all([api.postMessage({ channel: 'C2', text: 'one' }), api.postMessage({ channel: 'C2', text: 'two' })]);
  ok('two posts in one channel go out a second apart, in order', Date.now() - t1 >= 1000 && JSON.parse(calls[0].init.body).text === 'one' && JSON.parse(calls[1].init.body).text === 'two');
  calls.length = 0;
  script = [reply(200, { ok: false, error: 'already_reacted' })];
  const rr = await api.addReaction('C1', '1.1', 'eyes');
  ok('an already-present reaction is not an error', rr === null);
  calls.length = 0;
  script = [reply(200, { ok: true, upload_url: 'https://files.slack.com/upload/x', file_id: 'F1' }), reply(200, {}), reply(200, { ok: true, files: [{ id: 'F1' }] })];
  const fid = await api.uploadFile({ channel: 'C1', filename: 'a.txt', bytes: Buffer.from('hello'), thread_ts: '1.1' });
  ok('an upload is the three-step external upload, into the channel and thread', fid === 'F1' && calls[0].url.endsWith('files.getUploadURLExternal') && calls[1].url === 'https://files.slack.com/upload/x' && calls[2].url.endsWith('files.completeUploadExternal') && JSON.parse(calls[2].init.body).channel_id === 'C1' && JSON.parse(calls[2].init.body).thread_ts === '1.1');
  threw = null; try { await api.downloadFile('https://evil.example.com/x'); } catch (e) { threw = e; }
  ok('a download from a host that is not Slack is refused before any request', threw?.code === 'not_a_slack_url');
  calls.length = 0;
  script = [reply(200, Buffer.from('bytes').buffer, { 'content-length': '5' })];
  const buf = await api.downloadFile('https://files.slack.com/files-pri/T1-F1/a.txt');
  ok('a download sends the bot token and returns the bytes', calls[0].init.headers.Authorization === 'Bearer xoxb-live' && Buffer.isBuffer(buf));
  script = [reply(200, { ok: true, url: 'wss://wss-1.slack.com/link/?ticket=x' })];
  const url = await api.connectionsOpen();
  ok('the Socket Mode handshake uses the app-level token', url.startsWith('wss://') && calls.at(-1).init.headers.Authorization === 'Bearer xapp-live');
} else {
  console.log('  (store not ready in this rig — the store-backed checks were skipped)');
}

console.log(`slack-api: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
