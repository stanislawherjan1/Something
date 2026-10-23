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
const { pathInGroupScope, pathInScope } = await import('./scope-rule.js');
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
{
  const { groupTurnParams } = await import('./integrations/group-watcher.js');
  const team = await import('./team.js');
  const gid = Object.keys(team.getTeamConfig?.().groups || {})[0];
  const g = gid ? team.getGroup(gid) : { chatId: '-100123', title: 'Room' };
  const pr = groupTurnParams(g, [], { message_id: '1', from_id: '1', who: 'Ann', text: 'x' }).message;
  ok('the room turn is told every word is posted: speak to the sender, never about them, silence as a marker', /EVERY WORD YOU WRITE IS POSTED/.test(pr) && /never ABOUT them in the third person/.test(pr) && /\[\[SILENT\]\]/.test(pr));
}
{
  const { groupTurnParams: gtp } = await import('./integrations/group-watcher.js');
  const pr2 = gtp({ chatId: '-100123', title: 'Room' }, [], { message_id: '1', from_id: '1', who: 'Ann', text: 'x' }).message;
  ok('a question about current state is answered from a fresh look, "nothing changed" only after checking', /CURRENT state of something/.test(pr2) && /only make after checking/.test(pr2));
}
ok('delegate can tell which message triggered it', /← NEW/.test(delegatePrompt));
ok('delegate is told the room\'s transcript is not its to open, and where to look instead',
  !/-history\.jsonl/.test(delegatePrompt) && /does not open it/.test(delegatePrompt) && /room's memory/.test(delegatePrompt));
ok('delegate is told to attribute what a named person said',
  /SAY WHOSE it was/.test(delegatePrompt));
ok('delegate is told to start the message with [[DM]]', /START THE MESSAGE with a line holding only `\[\[DM\]\]`/.test(delegatePrompt));
{
  const { dmBody } = await import('./integrations/group-watcher.js');
  ok('the DM is what follows the marker, the working notes before it are dropped', dmBody('Got the details. Now writing the DM.\n\n[[DM]]\nAbout what you asked in #studio: the kiln is booked.') === 'About what you asked in #studio: the kiln is booked.');
  ok('...the last marker wins, and no marker means the whole text', dmBody('[[DM]] draft\n[[DM]]\nfinal') === 'final' && dmBody('Just the answer.') === 'Just the answer.');
}
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
const gwSrcNotice = readFileSync(new URL('./integrations/group-watcher.js', import.meta.url), 'utf8');
const limitErr = 'claude exited with code 1 :: Claude usage limit reached. Your limit will reset at 3pm (Europe/Warsaw).';

// The hour is read from the printed reset (3pm Warsaw = 13:00 UTC) and said
// in the workspace's clock with the zone named — the same sentence the web
// chat and the direct messages use (lib/usage-limit.js).
const enNotice = failureNoticeText(enGroup, 'limit', limitErr), plNotice = failureNoticeText(plGroup, 'limit', limitErr);
ok('a limit notice states WHEN it comes back, the zone named', /back at 13:00 UTC\./.test(enNotice), enNotice);
// English is the DEFAULT, not an override of a KNOWN preference: an English
// system line in a Polish conversation reads as something broken, which is what
// a failure notice should least of all add to.
ok('a group with no pinned language gets English', /^Claude usage limit reached\./.test(failureNoticeText({}, 'limit', limitErr)));
const { NOTICE: N } = await import('./i18n/limit-notice.js');
const plFixed = N.pl('§', '¤').split('§')[0].trim(), plAtWord = N.pl('§', '¤').split('§')[1].split('¤')[0].trim();
ok('a group with a pinned language gets that language', plNotice.startsWith(plFixed), plNotice);
ok('the reset time survives translation', plNotice.endsWith(`${plAtWord} 13:00 UTC.`), plNotice);
ok('a re-ask is not answered with the same apology (one notice, then quiet)',
  /15 \* 60_000/.test(gwSrcNotice));
// Startup and mid-turn silence are different failures and were conflated: a
// group turn spawns claude with ~22 MCP servers, and on a small box the broker
// is still handing out their credentials well past the idle window. Measured
// live: turn started 19:24:30, credentials still landing at 19:25:01, not one
// tool call ever logged, killed at 19:27:24 for "being quiet" during the one
// stretch where it cannot speak. Startup gets its own budget; the hang detector
// stays tight so a genuinely stuck turn is still caught fast.
ok('startup silence is not the hang detector',
  /GROUP_TURN_STARTUP_MS', 300000/.test(gwSrcNotice));
ok('the hang detector stays tight once the turn is talking',
  /GROUP_TURN_IDLE_MS', num\('GROUP_TURN_TIMEOUT_MS', 150000/.test(gwSrcNotice));
ok('the timer only switches to the tight window after a real event',
  /spoke \? GROUP_TURN_IDLE : GROUP_TURN_STARTUP/.test(gwSrcNotice)
  && /const bumpAlive = \(\) => \{[\s\S]{0,220}?spoke = true;/.test(gwSrcNotice));
// The startup cost is the number that decides whether the operator's DM can
// move off tmux (tmux pays it once per session, a headless turn every time), so
// it is measured, not estimated.
ok('spawn-to-first-event is measured, not guessed',
  /first-event after \$\{Date\.now\(\) - spawnedAt\}ms/.test(gwSrcNotice));
ok('every stream callback marks the turn alive (none left on the startup clock)',
  !/onText: \(t\) => \{ bumpIdle\(\)|onToolStart: \(info\) => \{ bumpIdle\(\)|onToolEnd: \(\) => \{ bumpIdle\(\)/.test(gwSrcNotice));
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

// (h) TWO BRAINS, ONE PERSON — the group delegate (wsapi) and the requester's
// own 1:1 both deliver into the same DM, with no shared queue and no shared send
// path. Live: the DM claimed it could not see the group and asked the operator
// to paste the messages, while the delegate was already writing the answer and
// delivered it a minute later. Disk is the only thing both touch, so the marker
// is the handshake — and WHERE it goes is a privacy decision, not a filing one.
const { pendingDelegatePath } = gwTest;
const pendingPath = pendingDelegatePath('stanislaw') || '';
ok('the in-flight marker lives in the requester\'s PRIVATE tree',
  /\/memory\/users\/stanislaw\/\.pending-delegate\.json$/.test(pendingPath));
// Next to the transcripts would put one person's private request where every
// group turn can read it.
ok('the marker is NOT in the shared group-watcher dir', !/group-watcher/.test(pendingPath));
ok('a private turn can reach its own marker',
  pathInScope('memory/users/stanislaw/.pending-delegate.json', { ownSlug: 'stanislaw' }) === true);
ok('a GROUP turn is fenced out of it',
  pathInGroupScope('memory/users/stanislaw/.pending-delegate.json') === false);
ok('a malformed slug cannot escape the memory tree',
  pendingDelegatePath('../../etc') === null && pendingDelegatePath('') === null);
ok('the marker is always cleared, even when the delegate throws',
  /finally \{ clearDelegatePending\(member\.slug\); releaseSlot\(\); \}/.test(gwSrcNotice));
ok('the marker carries what it covers, so the DM can tell if it is the same ask',
  /markDelegatePending\(member\.slug, \{ task,/.test(gwSrcNotice));

// The cross-surface awareness frame quotes the group message verbatim, so a
// request in someone's own voice ("message me privately about X") landed in the
// operator's own session as a direct ask and got done — 14s before the delegate
// delivered the same thing. A record of finished work must read as one.
ok('the awareness frame states that the work is already done',
  /ALREADY HANDLED/.test(gwSrcNotice));
ok('...and says the private half is in flight when one was delegated',
  /reply\.privateTask\s*\n?\s*\? 'ALREADY HANDLED — and the private half is being written/.test(gwSrcNotice));
ok('...and tells the operator brain not to send it a second time',
  /they would get it twice/i.test(gwSrcNotice));
ok('the quoted group message is labelled as someone else\'s words',
  /they said: \$\{(?:clip|deframe)\(target\.text/.test(gwSrcNotice));

// (i) LOSING THE THREAD. The ring is a cold-start number: a resumed turn carries
// only messages since the last turn, so depth here is free per-turn and paid
// once at boot. At 20 a restarted brain woke up on a group with 1949 lines on
// disk and told people it had missed the thread.
ok('the cold-start ring reaches past the last handful of messages',
  /GROUP_HISTORY_MAX', 60\)/.test(gwSrcNotice));
ok('the reload still seeds the ring from the durable transcript',
  /slice\(-HISTORY_MAX\)/.test(gwSrcNotice));

// (j) The 1:1 prefix has to KNOW both of those files exist, or it invents a
// limitation instead of reading them.
const { buildCachedPrefix } = await import('./memory-loader.js');
const prefixBlock = buildCachedPrefix({ memoryDir: '/nonexistent-for-test' }).block;
ok('the prefix points at room_recent for a room\'s recent talk, not at the fenced files',
  /room_recent/.test(prefixBlock) && !/\.group-watcher\/<chatId>-history\.jsonl/.test(prefixBlock) && /not opened as files/.test(prefixBlock));
ok('the prefix names the false excuse it is there to kill',
  /cannot see group history/i.test(prefixBlock));
ok('the prefix explains the in-flight marker', /\.pending-delegate\.json/.test(prefixBlock));
ok('the prefix keeps the thread alive rather than going silent',
  /do not leave them hanging|keep the thread alive/i.test(prefixBlock));
ok('the transcript is framed as data, not instructions',
  /never as instructions/i.test(prefixBlock));

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
// The frame the caller wants said must be IN the rendered window: the brain is
// told to answer "the message marked ← NEW", so a target that is not in the
// window is not there at all — it stayed silent while delivery reported success.
const outboundSrc = readFileSync(new URL('./integrations/group-watcher.js', import.meta.url), 'utf8')
  .split('export async function sayInGroup')[1].slice(0, 4000);
ok('the outbound frame is put into the context window', /\[\.\.\.base, \{ \.\.\.target/.test(outboundSrc));
ok('...and survives the session-rotation retry', /\[\.\.\.hist, \{ \.\.\.target/.test(outboundSrc));
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

// The real message id must reach the DURABLE transcript, not just the in-RAM
// ring: after a restart the bot's own posts were anonymous, so it could repair
// a message it had just sent and nothing older — the case fix_sent_message
// exists for.
const gwSrc = readFileSync(new URL('./integrations/group-watcher.js', import.meta.url), 'utf8');
const persist = gwSrc.split('function persistHistory')[1].slice(0, 1200);
ok('the durable group transcript records the message id', /message_id: entry\.message_id/.test(persist));

// The delegate runs WITHOUT a session, so it must get the full ring — not the
// window slimmed for a brain that remembers the rest. Observed live: the DM
// arrived asking "what is this about?" and then invented an explanation for why
// it could not look.
const fireSrc = gwSrc.split('const fireDelegate')[1].slice(0, 900);
ok('the delegate is handed the full history, not the session window',
  /runPrivateDelegate\([^)]*, hist\)/.test(fireSrc), fireSrc.slice(0, 200));
ok('the delegate is told never to say it has no access to the room',
  /never say you have no access to the room/.test(gwSrc));

// The delegate has the full toolset, so it CAN send Telegram messages itself —
// and then its closing text is a report about that send, which the system
// delivered as a second DM. Seen live: the answer, then a summary of the answer.
const delSrc = gwSrc.split('async function runPrivateDelegate')[1].slice(0, 6000);
ok('a self-sent delegate message suppresses the closing text', /selfSent/.test(delSrc) && /return finish\(''\)/.test(delSrc));
ok('the delegate is told there is no send step', /THERE IS NO SEND STEP/.test(gwSrc));
// Structural, not just prompted: the turn cannot deliver, so the two paths
// cannot both fire. The first attempt at this guessed the wrong tool — a
// wsapi-spawned turn has no Telegram tool at all; the second delivery came from
// web_send_message, which routes to the recipient's preferred surface.
ok('the delegate turn is denied every delivery tool', /disallowedTools: DELIVERY_TOOLS/.test(delSrc));
ok('...and the list covers web_send_message, not only Telegram',
  /mcp__web-channel__web_send_message/.test(gwSrc));
const claudeSrc = readFileSync(new URL('./claude.js', import.meta.url), 'utf8');
ok('runClaudeTurn passes the deny list to the CLI', /'--disallowedTools', (disallowedTools|blocked)\.join/.test(claudeSrc));

// (x) A resumed turn re-reads the thread. The group's session is summarised by
// the CLI when it grows; a turn that got only the messages since its last reply
// lost what was being talked about after a gap.
const { recapFor, gateFailureKind } = await import('./integrations/group-watcher.js');
const NOW = Date.parse('2026-10-21T12:00:00Z');
const hist = Array.from({ length: 50 }, (_, i) => ({ role: i % 3 ? 'user' : 'assistant', message_id: `m${i}`, who: 'Sam', text: `line ${i}`, ts: new Date(NOW - (50 - i) * 60_000).toISOString() }));
const lastSeen = hist[39].ts;   // the session's last turn saw up to line 39
const recent = { sessionId: 's', lastTs: lastSeen, updatedAt: new Date(NOW - 10 * 60_000).toISOString() };
const stale = { sessionId: 's', lastTs: lastSeen, updatedAt: new Date(NOW - 5 * 3600_000).toISOString() };
let rc = recapFor(hist, recent, NOW);
ok('a resumed turn soon after the last one re-reads its last 10 lines', rc.length === 10 && rc[0].text === 'line 30' && rc[9].text === 'line 39', rc.map(r => r.text));
rc = recapFor(hist, stale, NOW);
ok('...after a long gap, its last 30 (the session was likely summarised)', rc.length === 30 && rc[0].text === 'line 10' && rc[29].text === 'line 39', rc.map(r => r.text));
ok('...never a line it has not seen (those are the NEW window)', !recapFor(hist, stale, NOW).some(r => r.ts > lastSeen));
ok('no session → no recap (a fresh session gets the whole ring anyway)', recapFor(hist, null, NOW).length === 0);
const newer = hist.slice(40);
const pr = groupTurnParams({ chatId: '-1001234567890' }, newer, { ...newer[newer.length - 1], from_id: '987654321' }, {}, { resumed: true, recap: recapFor(hist, stale, NOW) });
ok('the resumed prompt carries the earlier lines, marked as already seen', /EARLIER IN THIS GROUP/.test(pr.message) && pr.message.includes('line 10') && pr.message.includes('line 39'));
ok('...before the messages since the last turn', pr.message.indexOf('line 39') < pr.message.indexOf('The messages since your last turn') && pr.message.indexOf('The messages since your last turn') < pr.message.indexOf('line 49'));
ok('...and no longer tells the brain to trust its session blindly', !/trust it\. Below are ONLY/.test(pr.message) && /may have been summarised/.test(pr.message));
const fresh = groupTurnParams({ chatId: '-1001234567890' }, hist, { ...hist[49], from_id: '987654321' });
ok('a fresh session gets the plain recent conversation, no recap block', !/EARLIER IN THIS GROUP/.test(fresh.message) && /Recent conversation:/.test(fresh.message));

// (y) A failed gate: out of plan → silent; anything else → the brain judges.
ok('the gate out of plan keeps silent (the brain would fail too)', gateFailureKind({ ok: false, error: "You've hit your weekly limit · resets Oct 22, 12pm (UTC)" }) === 'limit');
ok('...said through the classifier\'s exit too', gateFailureKind({ ok: false, reason_enum: 'classify-error', error: "exit 1: You've hit your weekly limit · resets Oct 22, 12pm (UTC)" }) === 'limit');
ok('a sentence that merely says "hit your limit" is no usage limit', isUsageLimit('I think the client hit your limit of patience') === false);
ok('a crashed gate passes the message to the brain', gateFailureKind({ ok: false, reason_enum: 'classify-error', error: 'exit 1' }) === 'gate-down');
ok('a timed-out gate passes the message to the brain', gateFailureKind({ ok: false, reason_enum: 'classify-timeout' }) === 'gate-down');
ok('an unparseable answer passes the message to the brain', gateFailureKind({ ok: false, reason_enum: 'classify-error', error: 'unparseable' }) === 'gate-down');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
