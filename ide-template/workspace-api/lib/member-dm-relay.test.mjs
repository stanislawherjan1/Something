/**
 * A DM turn that passes a message on to someone else still answers the person
 * who asked; one that sends the answer to the person themselves is not doubled.
 * The CLI is faked: it streams a web_send_message call, its arguments in
 * pieces (as the real stream does), then a closing line.
 *
 * Run: node lib/member-dm-relay.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'dm-relay-'));
process.env.PROJECT_DIR = ROOT;
process.env.MEMORY_V4 = 'off';
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'tom@example.test', role: 'admin', slug: 'tom', displayName: 'Tom', addedAt: '2026-09-01T00:00:00Z' },
]));
const FAKE = join(ROOT, 'fake-claude.mjs');
writeFileSync(FAKE, `#!/usr/bin/env node
let buf = '';
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => {
  const out = (event) => process.stdout.write(JSON.stringify({ type: 'stream_event', event }) + '\\n');
  const args = buf.includes('tell Tom') ? '{"recipient":"tom","body":"Ann is off on Friday."}' : '{"body":"Here it is.","channel":"slack"}';
  out({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'mcp__web-channel__web_send_message', input: {} } });
  for (let i = 0; i < args.length; i += 7) out({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args.slice(i, i + 7) } });
  out({ type: 'content_block_stop', index: 0 });
  out({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  out({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Told Tom you are off on Friday.' } });
  out({ type: 'content_block_stop', index: 1 });
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'fake', result: '' }) + '\\n');
});
`);
chmodSync(FAKE, 0o755);
process.env.CLAUDE_BIN = FAKE;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };

const { runClaudeTurn } = await import('./claude.js');
const inputs = [];
await new Promise((resolve) => runClaudeTurn({ actor: 'ann', message: 'tell Tom I am off', onText() {}, onToolStart() {}, onToolEnd() {}, onImage() {},
  onToolInput: (x) => inputs.push(x), onError: resolve, onDone: resolve }));
ok('a tool call\'s arguments arrive whole, once they have streamed in', inputs.length === 1 && inputs[0].input.recipient === 'tom' && inputs[0].input.body === 'Ann is off on Friday.', inputs);

const { answerMemberDm } = await import('./integrations/member-dm.js');
const ann = { slug: 'ann', displayName: 'Ann', role: 'member' };
const sent = [];
const send = async (target, text) => { sent.push(text); return { ok: true }; };
let r = await answerMemberDm(ann, 'tell Tom I am off on Friday', { surface: 'slack', target: 'D1', send });
ok('a message passed on to someone else is confirmed to the person who asked', r.delivered === true && sent.at(-1) === 'Told Tom you are off on Friday.', { r, sent });
sent.length = 0;
r = await answerMemberDm(ann, 'send it to me on Slack', { surface: 'slack', target: 'D1', send });
ok('...while an answer the model sent to the person itself is not sent twice', r.reason === 'sent by the model' && sent.length === 0, { r, sent });

console.log(`member-dm-relay: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
