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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
