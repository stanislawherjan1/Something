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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
