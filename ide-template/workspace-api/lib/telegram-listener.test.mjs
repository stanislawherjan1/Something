// workspace-api reading Telegram itself (TELEGRAM_TRANSPORT=wsapi): what one
// update becomes. A DM from a roster person is a turn as them with typing and
// attachments; a stranger gets nothing and is noted; a group message is the
// watcher's payload; the bot added to a group registers it when a roster
// person added it; /restart drops the session. Plus the plain-text hygiene and
// the 4096 split every send goes through.
// Run: node lib/telegram-listener.test.mjs
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'tg-listener-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'tg-listener-store-'));
process.env.TELEGRAM_TRANSPORT = 'wsapi';
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'ann@example.test', role: 'admin', slug: 'ann', displayName: 'Ann', telegramChatId: '1001', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'bob@example.test', role: 'member', slug: 'bob', displayName: 'Bob', telegramChatId: '1002', addedAt: '2026-09-01T00:00:00Z' },
]));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const L = await import('./integrations/telegram-listener.js');
const S = await import('./integrations/telegram-sync.js');
const T = await import('./integrations/telegram-transport.js');

ok('the flag: wsapi', T.wsapiTransport() === true && T.telegramTransport() === 'wsapi');

// ─── the dispatcher, with fakes ──────────────────────────────────────────────
const calls = { send: [], typing: [], react: [], route: [], group: [], added: [], pending: [], reset: [] };
const self = { id: 777, username: 'orbis_bot' };
const d = L.createDispatcher({
  self: () => self,
  routeInbound: async (msg, opts) => { calls.route.push({ msg, opts }); return { ok: true, routed: true, reason: 'member turn', done: Promise.resolve({ delivered: true, reason: 'telegram' }) }; },
  send: async (chat, text) => { calls.send.push({ chat, text }); return { ok: true, messageId: 5 }; },
  sendFile: async () => ({ ok: true }),
  typing: async (chat) => { calls.typing.push(chat); return { ok: true }; },
  react: async (chat, mid, emoji) => { calls.react.push({ chat, mid, emoji }); return { ok: true }; },
  download: async (fileId) => ({ ok: true, buffer: Buffer.from(`bytes of ${fileId}`), ext: 'jpg' }),
  admins: async () => [{ status: 'creator', user: { id: 1001 } }],
  logInbound: () => {},
  saveAttachments: (thread, files) => files.map(f => ({ path: `.attachments/${thread}/${f.originalname}` })),
  resetSession: (slug, surface) => calls.reset.push({ slug, surface }),
  notePending: (p) => calls.pending.push(p),
  onGroup: (p) => calls.group.push(p),
  addGroup: (g) => calls.added.push(g),
  isAllowedGroup: () => false,
  ackReaction: () => '👀',
  log: () => {},
});

const msg = (over) => ({ message_id: 10, date: 1, chat: { id: 1001, type: 'private' }, from: { id: 1001, first_name: 'Ann' }, text: 'hello', ...over });

// A DM from the admin (the operator): a turn as them, like anyone's.
let r = await d({ update_id: 1, message: msg() });
ok('the operator\'s DM is a turn as them', r.did === 'routed' && r.slug === 'ann' && calls.route[0].msg.chat_id === '1001' && calls.route[0].msg.text === 'hello', r);
ok('...with the reply sent to the chat it came from', calls.route[0].opts.memberDmDeps.surface === 'telegram' && calls.route[0].opts.memberDmDeps.target === '1001');
ok('typing starts at once', calls.typing.includes('1001'));
ok('the ack reaction is set', calls.react.some(x => x.chat === '1001' && x.mid === 10 && x.emoji === '👀'));
await r.done;

// A member's photo-only DM: the file is fetched and named in the body.
r = await d({ update_id: 2, message: msg({ message_id: 11, chat: { id: 1002, type: 'private' }, from: { id: 1002, first_name: 'Bob' }, text: undefined, photo: [{ file_id: 'small' }, { file_id: 'big' }] }) });
ok('a photo with no text still reaches the person\'s turn, as an attachment', r.did === 'routed' && /\[Attachments — read these files to answer\]\n- \.attachments\/telegram-bob\/photo-11\.jpg/.test(calls.route[1].msg.text), calls.route[1].msg.text);
ok('…the largest size', calls.route[1].msg.text.includes('photo-11') && !calls.route[1].msg.text.includes('small'));
await r.done;

// A document with a caption.
r = await d({ update_id: 3, message: msg({ message_id: 12, chat: { id: 1002, type: 'private' }, from: { id: 1002 }, text: undefined, caption: 'the invoice', document: { file_id: 'doc1', file_name: 'invoice.pdf', mime_type: 'application/pdf', file_size: 10 } }) });
ok('a document keeps its name and the caption is the text', /^the invoice\n\n\[Attachments/.test(calls.route[2].msg.text) && calls.route[2].msg.text.includes('invoice.pdf'), calls.route[2].msg.text);
await r.done;

// A stranger: nothing sent, noted for an admin.
const sendsBefore = calls.send.length;
r = await d({ update_id: 4, message: msg({ chat: { id: 5555, type: 'private' }, from: { id: 5555, first_name: 'Zed', username: 'zed' } }) });
ok('a stranger gets no reply and no turn', r.did === 'stranger' && calls.send.length === sendsBefore && calls.route.length === 3);
ok('…and is noted with their chat id for an admin', calls.pending.some(p => p.id === '5555' && p.username === 'zed'));

// /restart drops the session and says so.
r = await d({ update_id: 5, message: msg({ message_id: 13, text: '/restart' }) });
ok('/restart resets the person\'s Telegram session', r.did === 'restart' && calls.reset.some(x => x.slug === 'ann' && x.surface === 'telegram') && calls.send.some(x => x.chat === '1001' && /Starting over/.test(x.text)));

// The bot's own message, an edit, a channel post: ignored.
ok('the bot\'s own message is ignored', (await d({ update_id: 6, message: msg({ from: { id: 777 } }) })).did === 'ignored');
ok('a channel post is ignored', (await d({ update_id: 7, message: msg({ chat: { id: -100, type: 'channel' } }) })).did === 'ignored');

// A group message: the watcher's payload, as the plugin's diversion built it.
r = await d({ update_id: 8, message: {
  message_id: 20, chat: { id: -4001, type: 'supergroup', title: 'Orbis team' }, from: { id: 1002, first_name: 'Bob', last_name: 'B', username: 'bobb' },
  text: 'hey @orbis_bot look', entities: [{ type: 'mention', offset: 4, length: 10 }], reply_to_message: { message_id: 19, from: { id: 777 } },
  document: { file_id: 'd9', file_name: 'plan.pdf', mime_type: 'application/pdf', file_size: 99 },
} });
const g = calls.group[0];
ok('a group message goes to the watcher', r.did === 'group' && g && g.chat_id === '-4001' && g.chat_title === 'Orbis team' && g.message_id === 20 && g.text === 'hey @orbis_bot look', g);
ok('…with the sender, the mention and the reply-to-bot flags', g.from_id === '1002' && g.from_name === 'Bob B' && g.from_username === 'bobb' && g.is_mention === true && g.is_reply_to_bot === true && g.reply_to_message_id === 19, g);
ok('…and the attachment in the watcher\'s shape', g.attachment?.kind === 'document' && g.attachment.file_id === 'd9' && g.attachment.name === 'plan.pdf' && g.photo_file_id === null, g.attachment);
ok('a group photo is the largest size', L.groupPayload({ chat: { id: -1, type: 'group' }, photo: [{ file_id: 'a' }, { file_id: 'b' }] }, self).photo_file_id === 'b');
ok('a text mention of the bot by id counts', L.mentionsSelf({ text: 'Bot', entities: [{ type: 'text_mention', offset: 0, length: 3, user: { id: 777 } }] }, self));
ok('a group message with nothing to read is dropped', (await d({ update_id: 9, message: { message_id: 21, chat: { id: -4001, type: 'group' }, from: { id: 1002 }, new_chat_members: [] } })).did === 'ignored');

// Added to a group by a roster person: registered; by a stranger: not.
r = await d({ update_id: 10, my_chat_member: { chat: { id: -4002, type: 'supergroup', title: 'New room' }, from: { id: 1001 }, new_chat_member: { status: 'member', user: { id: 777 } } } });
ok('added to a group by the creator on the roster: registered', r.did === 'group-registered' && calls.added[0]?.chatId === '-4002' && calls.added[0].title === 'New room', r);
const d2 = L.createDispatcher({ self: () => self, admins: async () => [{ status: 'creator', user: { id: 9 } }], userByChatId: () => null, isAllowedGroup: () => false, addGroup: (g) => calls.added.push(g), log: () => {} });
r = await d2({ update_id: 11, my_chat_member: { chat: { id: -4003, type: 'group', title: 'Else' }, from: { id: 9 }, new_chat_member: { status: 'member', user: { id: 777 } } } });
ok('…by a stranger: not', r.did === 'group-ignored' && calls.added.length === 1);
ok('someone else joining is not about me', (await d({ update_id: 12, my_chat_member: { chat: { id: -4002 }, new_chat_member: { status: 'member', user: { id: 1 } } } })).did === 'ignored');

// ─── every send: plain text, in Telegram-sized pieces ────────────────────────
ok('Markdown and em dashes are stripped', S.stripTgMd('**Bold** and `code` — a [link](https://x.io)\n## Head') === 'Bold and code - a link (https://x.io)\nHead');
const long = Array.from({ length: 300 }, (_, i) => `line ${i} of a long reply that goes on`).join('\n');
const pieces = S.splitTelegram(long);
ok('a long reply is split under 4096 at line breaks', pieces.length >= 2 && pieces.every(p => p.length <= 4096 && !p.startsWith('\n')) && pieces.join('\n') === long, pieces.map(p => p.length));
ok('a short reply is one piece', S.splitTelegram('hi').length === 1);
ok('a wall with no breaks is cut hard', S.splitTelegram('x'.repeat(9000)).map(p => p.length).join(',') === '4096,4096,808');

// ─── the flag off: the listener stays off, the operator's DM is the brain's ──
process.env.TELEGRAM_TRANSPORT = 'plugin';
ok('with the plugin as transport the poll does not start', L.reconcile() === false && L.status().running === false);
process.env.TELEGRAM_TRANSPORT = 'wsapi';

console.log(`telegram-listener: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
