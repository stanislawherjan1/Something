/**
 * A room's transcript (.group-watcher/<room>-…) is the room's own: readable
 * by the room's turn and by a person in that room, by nobody else — the hook
 * says so to the model (the bot once confirmed, asked, that only its manners
 * stood in the way), and the pure rule behind it is the same one for Slack
 * and Telegram. The hook is run as the CLI runs it, on a temp project.
 *
 * Run: node lib/group-transcript-fence.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = mkdtempSync(join(tmpdir(), 'transcript-fence-'));
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };

writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', telegramChatId: '1110001', slackUserId: 'U0STAN0001', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'kasia@example.test', role: 'member', slug: 'kasia', displayName: 'Kasia', telegramChatId: '2220002', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true, groups: {
  '-100777': { title: 'Team', members: { 1110001: 'Stan' } },
  'slack-C0ROOM0001': { title: '#studio', members: { U0STAN0001: 'Stan' } },
} }));
mkdirSync(join(ROOT, '.group-watcher'), { recursive: true });

const HOOKS = new URL('../../hooks/', import.meta.url).pathname;
const hook = (payload, env = {}) => spawnSync(process.execPath, [join(HOOKS, 'scope-guard.mjs')], { input: JSON.stringify(payload), env: { ...process.env, PROJECT_DIR: ROOT, IDE_ACTOR_SLUG: '', IDE_GROUP_CONTEXT: '', IDE_GROUP_ID: '', ...env }, encoding: 'utf8' });
const read = (rel, env) => hook({ tool_name: 'Read', tool_input: { file_path: join(ROOT, rel) } }, env);
const bash = (cmd, env) => hook({ tool_name: 'Bash', tool_input: { command: cmd } }, env);
const T = '.group-watcher/-100777-history.jsonl', S = '.group-watcher/slack-C0ROOM0001-history.jsonl';

// ─── the pure rule ───────────────────────────────────────────────────────────
const R = await import('./scope-rule.js');
ok('a Telegram transcript names its room', R.transcriptRoomOf(T) === '-100777' && R.transcriptRoomOf('.group-watcher/-100777.jsonl') === '-100777' && R.transcriptRoomOf('.group-watcher/-100777-session.json') === '-100777');
ok('a Slack transcript and a thread session name theirs', R.transcriptRoomOf(S) === 'slack-C0ROOM0001' && R.transcriptRoomOf('.group-watcher/slack-C0ROOM0001-thread-1.2-session.json') === 'slack-C0ROOM0001');
ok('the directory itself is nobody\'s', R.transcriptRoomOf('.group-watcher') === '' && R.transcriptAllowed('.group-watcher', { isMember: () => true }) === false);
ok('a path outside it is not this rule\'s', R.transcriptRoomOf('notes/x.md') === null && R.transcriptAllowed('notes/x.md') === true);
ok('a room\'s turn reads its own room, no other', R.transcriptAllowed(T, { groupCtx: true, groupId: '-100777' }) === true && R.transcriptAllowed(S, { groupCtx: true, groupId: '-100777' }) === false && R.transcriptAllowed(T, { groupCtx: true, groupId: null }) === false);
ok('a person reads the rooms they are in', R.transcriptAllowed(T, { isMember: (r) => r === '-100777' }) === true && R.transcriptAllowed(S, { isMember: (r) => r === '-100777' }) === false);
ok('a traversal is refused', R.transcriptAllowed('.group-watcher/../.group-watcher/-100777-history.jsonl', { isMember: () => true }) === false);

// ─── the hook, as the CLI runs it ────────────────────────────────────────────
ok('a member of the room may read its transcript', read(T, { IDE_ACTOR_SLUG: 'stan' }).status === 0);
ok('...and of the Slack room, by their Slack id', read(S, { IDE_ACTOR_SLUG: 'stan' }).status === 0);
let r = read(T, { IDE_ACTOR_SLUG: 'kasia' });
ok('someone not in the room is blocked', r.status === 2 && /not in that room/.test(r.stderr), r.stderr);
ok('...told to call it the room\'s conversation, never a lack of access', /between the people in it/.test(r.stderr) && /never that you cannot see it/.test(r.stderr));
ok('...through the shell too', bash(`cat ${join(ROOT, T)}`, { IDE_ACTOR_SLUG: 'kasia' }).status === 2 && bash(`tail -n 50 .group-watcher/-100777-history.jsonl`, { IDE_ACTOR_SLUG: 'kasia' }).status === 2);
ok('...and the Slack room', read(S, { IDE_ACTOR_SLUG: 'kasia' }).status === 2);
ok('the room\'s own turn reads its transcript', read(T, { IDE_ACTOR_SLUG: 'stan', IDE_GROUP_CONTEXT: '1', IDE_GROUP_ID: '-100777' }).status === 0);
r = read(S, { IDE_ACTOR_SLUG: 'stan', IDE_GROUP_CONTEXT: '1', IDE_GROUP_ID: '-100777' });
ok('...and no other room\'s, whoever is speaking', r.status === 2 && /another room/.test(r.stderr), r.stderr);
ok('a group turn with no room id reads none', read(T, { IDE_ACTOR_SLUG: 'team', IDE_GROUP_CONTEXT: '1' }).status === 2);
ok('the directory listing is nobody\'s', read('.group-watcher', { IDE_ACTOR_SLUG: 'stan' }).status === 2);
ok('a shared file is untouched by this', read('notes/plan.md', { IDE_ACTOR_SLUG: 'kasia' }).status === 0);
ok('a slug-less turn (solo) is left alone', read(T, {}).status === 0);
writeFileSync(join(ROOT, '.team-config.json'), '{not json');
ok('an unreadable registry means nobody is a member', read(T, { IDE_ACTOR_SLUG: 'stan' }).status === 2);

console.log(`group-transcript-fence: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
