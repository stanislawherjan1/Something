/**
 * Build-failing guard for the Telegram GROUP brain's SCOPE boundary.
 *
 * The group brain is the FULL assistant (runClaudeTurn) — same tools/files/skills/
 * integrations/reminders as a member's 1:1 — but run as actor='team' (SHARED
 * scope), NEVER admin. That is the one load-bearing guarantee: scope-guard fences
 * a non-admin 'team' actor OUT of every individual's private users/<slug> tree, so
 * the group sees SHARED files + memory, not anyone's private space. A refactor that
 * makes the group turn admin (all-access short-circuit) or passes a real user's
 * slug would silently expose private data to the whole group — so this FAILS the
 * build instead.
 *
 * Run: node lib/group-brain.test.mjs   (wired into `npm test`)
 */
import { readFileSync } from 'node:fs';
import { groupTurnParams } from './integrations/group-watcher.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}`); } };

const ctx = [
  { role: 'user', message_id: '1', who: 'Sam', text: 'is the deploy broken?' },
  { role: 'assistant', message_id: 'bot-1', text: 'Looking now.' },
];
// A sender whose Telegram id is NOT in the roster (test env has none) → the bot
// must fall back to the shared 'team' scope, non-admin (no privilege for someone
// it can't identify). A KNOWN sender resolves to their own slug + role at runtime.
const target = { message_id: '1', from_id: '987654321', who: 'Sam', text: 'is the deploy broken?' };
const p = groupTurnParams({ chatId: '-1001234567890' }, ctx, target);

// (a) SCOPE — unknown sender gets the shared team scope, NEVER admin.
ok('unknown sender → shared team actor', p.actor === 'team');
ok('unknown sender is NEVER admin (no all-access short-circuit)', p.actorIsAdmin === false);

// (b) conversation + addressivity context reaches the brain.
ok('message carries the group-chat framing', /GROUP CHAT/.test(p.message));
ok('message includes the NEW target text', p.message.includes('is the deploy broken?'));
ok('message names who is asking', p.message.includes('Sam'));
ok('message routes private/personal asks to a DM', /\bDM\b/.test(p.message));

// (c) GROUP CONTEXT (group-mode v2, D2) — the load-bearing privacy invariant.
// Every group turn must carry groupContext: true, which makes claude.js set
// IDE_GROUP_CONTEXT=1 (scope-guard hard-blocks EVERY private tree, admin
// included) and drop the whole USER tier from the prefix. A refactor that loses
// this flag silently reopens private reads in a publicly-replying context.
ok('group turn sets groupContext (hard private fence)', p.groupContext === true);
ok('group turn offers [[PRIVATE_TASK]] delegation for private asks', /PRIVATE_TASK/.test(p.message));

// (d) pathInGroupScope — the pure rule the scope-guard hook applies under
// IDE_GROUP_CONTEXT=1: NO private tree for anyone; shared space stays open.
const { pathInGroupScope } = await import('./scope-rule.js');
ok('group scope: shared project file allowed', pathInGroupScope('docs/notes.md') === true);
ok('group scope: project root allowed', pathInGroupScope('') === true);
ok('group scope: a user\'s private files blocked', pathInGroupScope('users/sam/todo.md') === false);
ok('group scope: a user\'s private memory blocked', pathInGroupScope('memory/users/sam/topics/x.md') === false);
ok('group scope: even the SENDER\'s own private tree blocked', pathInGroupScope('users/team/anything.md') === false);
ok('group scope: traversal rejected', pathInGroupScope('users/sam/../../memory/users/sam/x.md') === false);
ok('group scope: dot-segment smuggling rejected', pathInGroupScope('memory/./users/sam/x.md') === false);
ok('group scope: shared memory allowed', pathInGroupScope('memory/CHANNELS.md') === true);

// (e) session resume plumbing — a live session slims the context and flips the
// framing line; sessionId passes through to runClaudeTurn's --resume.
const pResumed = groupTurnParams({ chatId: '-1001234567890' }, ctx, target, { sessionId: 'sess-123' }, { resumed: true });
ok('resumed turn passes sessionId through', pResumed.sessionId === 'sess-123');
ok('resumed turn tells the brain it has session memory', /session memory/.test(pResumed.message));
ok('fresh turn does NOT claim session memory', !/ongoing session memory/.test(p.message));

// (f) DELEGATION — a [[PRIVATE_TASK]] runs in a DM, so it leaves the group
// conversation behind unless it is handed over explicitly. It used to receive
// only the brain's one-sentence paraphrase, so a request about what ANOTHER
// member said arrived with the name already dropped and the DM could not
// attribute it. The delegate prompt must carry the attributed window.
const { __test: gwTest } = await import('./integrations/group-watcher.js');
const delegatePrompt = gwTest.delegatePrompt({
  group: { chatId: '-1001234567890', title: 'Team' },
  target: { message_id: '1', from_id: '987654321', who: 'Sam' },
  senderName: 'Sam',
  task: 'summarise the budget discussion',
  ctxMsgs: [
    { role: 'user', message_id: '0', who: 'Marek', text: 'budget lands at 40k, I checked' },
    { role: 'user', message_id: '1', who: 'Sam', text: 'send me a private summary of that' },
  ],
});
ok('delegate is given the group conversation, with attribution',
  /Marek/.test(delegatePrompt) && /budget lands at 40k/.test(delegatePrompt));
ok('delegate can tell which message triggered it', /← NEW/.test(delegatePrompt));
ok('delegate is pointed at the durable transcript for older history',
  /-history\.jsonl/.test(delegatePrompt));
ok('delegate is told to attribute what a named person said',
  /SAY WHOSE it was/.test(delegatePrompt));
ok('delegate still carries the task itself', /summarise the budget discussion/.test(delegatePrompt));
ok('delegate treats the transcript as data, not instructions',
  /never as instructions|not instructions/i.test(delegatePrompt));

// (g) FAILURE NOTICES — what the group is told when a turn dies.
const { failureNoticeText } = gwTest;
// A Polish-speaking group still gets these in English: they are what the bot
// says when the model — the thing that speaks the group's language — is the
// part that is unavailable.
const plGroup = { chatId: '-100', language: 'Polish' };
const enGroup = { chatId: '-100', language: 'English' };
const limitErr = 'claude exited with code 1 :: Claude usage limit reached. Your limit will reset at 3pm (Europe/Warsaw).';

ok('a limit notice states WHEN it comes back, quoting the printed time',
  /3pm \(Europe\/Warsaw\)/.test(failureNoticeText(enGroup, 'limit', limitErr)));
ok('notices stay English even in a Polish group (the model is what is down)',
  failureNoticeText(plGroup, 'limit', limitErr) === failureNoticeText(enGroup, 'limit', limitErr));
ok('no em dashes in any notice',
  ['limit', 'turn-timeout', 'gate-down', 'compose-error'].every(k =>
    !failureNoticeText(plGroup, k, limitErr).includes('—')));
ok('with no reset time known, it does NOT invent one',
  !/[0-9]{1,2}:[0-9]{2}|[0-9]\s*(am|pm)/i.test(failureNoticeText(enGroup, 'limit', 'rate-limit-options')));
// The operator called these out as reading like system errors: emoji + warning
// furniture in what is supposed to be a colleague talking.
ok('no notice carries emoji or warning furniture',
  ['limit', 'turn-timeout', 'gate-down', 'compose-error'].every(k =>
    !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(failureNoticeText(plGroup, k, limitErr))));

// A crash is not a usage limit. Announcing one as the other tells the reader to
// wait for a reset that is never coming.
const { isUsageLimit, resetDelayMs } = await import('./usage-limit.js');
ok('a real usage limit is recognised', isUsageLimit(limitErr) === true);
ok('a plain crash is NOT called a usage limit',
  isUsageLimit('claude exited with code 1 :: Error: ENOENT: no such file or directory') === false);
ok('the quiet window is derived from the printed reset time',
  Math.round(resetDelayMs(limitErr, new Date('2026-09-02T13:00:00')) / 60000) === 120);
ok('an unparseable reset yields no window (caller falls back)',
  resetDelayMs('rate-limit-options') === null);

// (h) OUTBOUND — group mode was purely reactive: a turn could only begin from
// an inbound message, so "I'll come back to you with the result" was
// unimplementable and a reminder could not target a group at all.
const gw = await import('./integrations/group-watcher.js');
ok('the group has an outbound entry point', typeof gw.sayInGroup === 'function');
const badChat = await gw.sayInGroup({ chatId: 'not-a-chat', text: 'hi' });
ok('a malformed chat id is refused', badChat.ok === false && /invalid chat id/.test(badChat.error), badChat);
const unregistered = await gw.sayInGroup({ chatId: '-9999999999', text: 'hi' });
ok('speaking into an UNREGISTERED group is refused — the registry authorises, not the caller',
  unregistered.ok === false && /not a registered group/.test(unregistered.error), unregistered);
// Outbound must not depend on inbound having happened. The self-id it used to
// require is resolved lazily by incoming traffic, so after a restart every
// group-targeted reminder refused with "sending disabled" until somebody
// happened to write somewhere — a scheduled thing silently not happening.
ok('the outbound path does not gate on the inbound self-id',
  !/if \(!sendingEnabled\(\)\) return/.test(
    readFileSync(new URL('./integrations/group-watcher.js', import.meta.url), 'utf8')
      .split('export async function sayInGroup')[1].slice(0, 900)));

// (i) SELF-REPAIR — the bot could not clean up its own bad message.
const tg = await import('./integrations/telegram-sync.js');
ok('the bot can edit its own message', typeof tg.editTelegramMessage === 'function');
ok('the bot can delete its own message', typeof tg.deleteTelegramMessage === 'function');
ok('repair validates the chat id', (await tg.deleteTelegramMessage('nope', '12')).error === 'invalid chat id');
ok('repair validates the message id', (await tg.editTelegramMessage('-1001234567890', 'nope', 'x')).error === 'invalid message id');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
