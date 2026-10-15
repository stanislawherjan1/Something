/**
 * The scope-guard hook keeps one member's turn out of another member's private
 * trees — users/<slug>, memory/users/<slug> and .team/users/<slug> — however
 * the path is spelled, and leaves the shared space and paths outside the
 * project alone. Runs the real hook the way Claude Code does (JSON on stdin,
 * exit 2 = blocked). Run: node lib/scope-guard.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = mkdtempSync(join(tmpdir(), 'scope-guard-'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 400)}` : ''}`); }
};
const HOOK = new URL('../../hooks/scope-guard.mjs', import.meta.url).pathname;
const run = (tool_name, tool_input, env = {}) => spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify({ tool_name, tool_input }),
  env: { ...process.env, PROJECT_DIR: ROOT, IDE_ACTOR_SLUG: 'ann', IDE_ACTOR_IS_ADMIN: '0', ...env },
  encoding: 'utf8',
}).status;
const read = (file_path, env) => run('Read', { file_path }, env);
const bash = (command, env) => run('Bash', { command }, env);

// ─── another member's trees are closed, however the path is written ─────────
ok('their chat history (.team/users) is closed', read(join(ROOT, '.team/users/bob/chats/x.jsonl')) === 2);
ok('...relative', read('.team/users/bob/routines.json') === 2);
ok('...with a leading ./', read('./.team/users/bob/routines.json') === 2);
ok('...from the shell', bash('cat .team/users/bob/chats/x.jsonl') === 2);
ok('their files are closed', read(join(ROOT, 'users/bob/notes.md')) === 2);
ok('...through a doubled slash', read(`${ROOT}//users/bob/notes.md`) === 2);
ok('...through a /./ segment', read(`${ROOT}/./users/bob/notes.md`) === 2);
ok('...through a .. detour', read(`${ROOT}/../${basename(ROOT)}/users/bob/notes.md`) === 2);
ok('...through a relative .. detour', read('Reports/../users/bob/notes.md') === 2);
ok('their memory is closed', read(join(ROOT, 'memory/users/bob/x.md')) === 2);

// ─── what the actor may use stays open ───────────────────────────────────────
ok('own chat history is open', read(join(ROOT, '.team/users/ann/chats/x.jsonl')) === 0);
ok('own files are open', read('users/ann/notes.md') === 0);
ok('shared files are open', read(join(ROOT, 'Reports/q3.md')) === 0);
ok('other dot-dirs in the project are shared', read(join(ROOT, '.attachments/t/1/a.png')) === 0);
ok('a path outside the project is not this hook\'s business', read('/etc/hosts') === 0);
ok('a sibling directory with the same prefix is outside the project', read(`${ROOT}2/users/bob/x.md`) === 0);
ok('the shell can still work in the shared space', bash('ls Reports && cat notes/plan.md') === 0);

// ─── a search over everything, and shell spellings of the whole tree ────────
ok('a grep with no root is refused (it would walk every tree)', run('Grep', { pattern: 'salary' }) === 2);
ok('...so is a glob with no literal prefix', run('Glob', { pattern: '**/*.md' }) === 2);
ok('a grep rooted in a shared folder is fine', run('Grep', { pattern: 'salary', path: join(ROOT, 'Reports') }) === 0);
ok('a glob with a shared prefix is fine', run('Glob', { pattern: 'Reports/**/*.md' }) === 0);
ok('a glob into own files is fine', run('Glob', { pattern: 'users/ann/**' }) === 0);
ok('a wildcard in the slug position is nobody\'s', bash('cat users/*/notes.md') === 2);
ok('the tree named bare is closed', bash('ls users') === 2);
ok('...and as a grep root', bash('grep -ri salary memory/users') === 2);
ok('...and as a cd target', bash('cd users; cat bob/notes.md') === 2);
ok('a word that merely contains it is not a path', bash('echo browsers users-guide.md && cat docs/users.md') === 0);

// ─── a group turn sees no private tree at all ────────────────────────────────
const group = { IDE_GROUP_CONTEXT: '1', IDE_ACTOR_SLUG: 'team' };
ok('group turn: no chat history', read('.team/users/ann/chats/x.jsonl', group) === 2);
ok('group turn: shared files stay open', read('Reports/q3.md', group) === 0);


// ─── locks: an admin's read-only marks on the shared space ──────────────────
mkdirSync(join(ROOT, '.team'), { recursive: true });
mkdirSync(join(ROOT, 'Plans'), { recursive: true });
writeFileSync(join(ROOT, 'Plans', 'q4.md'), 'q4');
writeFileSync(join(ROOT, 'Locked.md'), 'locked');
writeFileSync(join(ROOT, '.team', 'locks.json'), JSON.stringify({ Plans: { by: 'stan', at: 't' }, 'Locked.md': { by: 'stan', at: 't' }, 'Gone.md': { by: 'stan', at: 't' } }));
const write = (file_path, env) => run('Write', { file_path, content: 'x' }, env);
const edit = (file_path, env) => run('Edit', { file_path, old_string: 'a', new_string: 'b' }, env);
ok('a member cannot write a locked file', write(join(ROOT, 'Locked.md')) === 2);
ok('...nor edit under a locked folder', edit('Plans/q4.md') === 2);
ok('...nor create under it', write(join(ROOT, 'Plans/new.md')) === 2);
ok('...but can read it', read(join(ROOT, 'Plans/q4.md')) === 0 && read('Locked.md') === 0);
ok('an unlocked shared file is still theirs to write', write(join(ROOT, 'Reports/q3.md')) === 0);
ok('a stale lock (path gone) blocks nothing', write(join(ROOT, 'Gone.md')) === 0);
ok('an admin is refused under a lock as well', write(join(ROOT, 'Locked.md'), { IDE_ACTOR_IS_ADMIN: '1' }) === 2 && edit('Plans/q4.md', { IDE_ACTOR_IS_ADMIN: '1' }) === 2);
ok('...and the operator\'s brain without a slug (solo) too', write(join(ROOT, 'Locked.md'), { IDE_ACTOR_SLUG: '', IDE_ACTOR_IS_ADMIN: '1' }) === 2);
ok('a group turn as well', write(join(ROOT, 'Locked.md'), { IDE_GROUP_CONTEXT: '1', IDE_ACTOR_IS_ADMIN: '1' }) === 2);
ok('the shell: a redirect into a locked file is refused', bash('echo hi > Locked.md') === 2);
ok('...an append under a locked folder', bash('echo hi >> Plans/q4.md') === 2);
ok('...rm, mv, cp, sed -i, tee, touch of a locked path', ['rm Locked.md', 'mv Plans/q4.md Plans/q5.md', 'cp a.md Plans/', 'sed -i s/a/b/ Locked.md', 'cat x | tee Locked.md', 'touch Plans/new.md'].every(c => bash(c) === 2));
ok('...with the absolute path too', bash(`rm ${join(ROOT, 'Locked.md')}`) === 2);
ok('...while reading a locked path is fine', bash('cat Locked.md; grep x Plans/q4.md; ls Plans') === 0);
ok('...and a look-alike name is not it', bash('echo hi > Plans2/x.md; echo > Locked.md.bak') === 0);
ok('...the admin\'s shell is refused too', bash('echo hi > Locked.md', { IDE_ACTOR_IS_ADMIN: '1' }) === 2);
ok('...and after the unlock everyone writes again', (writeFileSync(join(ROOT, '.team', 'locks.json'), '{}'), bash('echo hi > Locked.md')) === 0);
rmSync(join(ROOT, '.team', 'locks.json'));


// ─── read-only team integrations: the write tools are refused ───────────────
writeFileSync(join(ROOT, '.team', 'integration-access.json'), JSON.stringify({ notion: 'read', trello: 'read' }));
const mcp = (tool_name, env) => run(tool_name, { query: 'x' }, env);
ok('a read tool of a read-only server passes', mcp('mcp__notion__notion-search') === 0 && mcp('mcp__notion__notion-fetch') === 0);
ok('a write tool of a read-only server is refused', mcp('mcp__notion__notion-create-pages') === 2 && mcp('mcp__notion__notion-update-page') === 2 && mcp('mcp__trello__add_card_to_list') === 2);
ok('...for an admin\'s turn and the brain too', mcp('mcp__notion__notion-create-pages', { IDE_ACTOR_IS_ADMIN: '1' }) === 2 && mcp('mcp__notion__notion-create-pages', { IDE_ACTOR_SLUG: '', IDE_ACTOR_IS_ADMIN: '1' }) === 2);
ok('a server that is read and write is untouched', mcp('mcp__linear__create_issue') === 0);
ok('a person\'s own connection of the same service is theirs to write', mcp('mcp__notion-mine__notion-create-pages') === 0);
rmSync(join(ROOT, '.team', 'integration-access.json'));
// ─── the team's skills and instructions: an admin's ──────────────────────────
const writeTo = (file_path, env) => run('Write', { file_path, content: 'x' }, env);
ok('a member cannot write a team skill', writeTo(join(ROOT, '.claude/skills/new/SKILL.md')) === 2);
ok('...nor edit the team\'s instructions', run('Edit', { file_path: '.claude/CLAUDE.md', old_string: 'a', new_string: 'b' }) === 2);
ok('...through ./ either', writeTo('./.claude/skills/x/SKILL.md') === 2);
ok('a member writes a skill of their own', writeTo(join(ROOT, 'users/ann/.skills/mine/SKILL.md')) === 0);
ok('...but not in another person\'s skills', writeTo(join(ROOT, 'users/bob/.skills/x/SKILL.md')) === 2);
ok('an admin writes a team skill', writeTo(join(ROOT, '.claude/skills/new/SKILL.md'), { IDE_ACTOR_IS_ADMIN: '1' }) === 0);
ok('a group turn writes no team skill, even an admin\'s', writeTo(join(ROOT, '.claude/skills/new/SKILL.md'), { IDE_ACTOR_IS_ADMIN: '1', IDE_GROUP_CONTEXT: '1' }) === 2);
ok('a solo turn (no actor flag) writes team skills as before', writeTo(join(ROOT, '.claude/skills/new/SKILL.md'), { IDE_ACTOR_SLUG: '', IDE_ACTOR_IS_ADMIN: '' }) === 0);
ok('other files under .claude are not affected', writeTo(join(ROOT, '.claude/notes.md')) === 0);

console.log(`scope-guard: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
