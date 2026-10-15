/**
 * The scope-guard hook against many ways of naming another person's tree in
 * a shell command. The shapes the hook promises to catch (a path at a word
 * boundary: plain, quoted, after a redirect or an operator, absolute, with
 * ./, a wildcard in the slug's place, the bare tree, memory/) must be refused;
 * the person's own and the shared space must pass. Shapes the hook calls
 * best-effort (a variable, a tilde, a substitution, a cd then a relative name)
 * are reported, not failed — the per-person uid is the hard wall for those.
 * Run: node lib/scope-guard-shell-fuzz.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = mkdtempSync(join(tmpdir(), 'shell-fuzz-'));
// A workspace that has moved to the new memory: memory/ is fenced for everyone.
mkdirSync(join(ROOT, 'memory', '_engine'), { recursive: true });
writeFileSync(join(ROOT, 'memory', '_engine', '.v4-migrated'), '');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 300)}` : ''}`); } };
const HOOK = new URL('../../hooks/scope-guard.mjs', import.meta.url).pathname;
const bash = (command, env = {}) => spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
  env: { ...process.env, PROJECT_DIR: ROOT, IDE_ACTOR_SLUG: 'ann', IDE_ACTOR_IS_ADMIN: '0', ...env },
  encoding: 'utf8',
}).status;

const P = ['users/bob/notes.md', 'memory/users/bob/ledger/2026-10.jsonl', '.team/users/bob/chats/x.jsonl'];
const MUST = [];
for (const p of P) {
  MUST.push(`cat ${p}`, `cat "${p}"`, `cat '${p}'`, `cat ./${p}`, `cat /home/coder/project/${p}`, `head -n 5 ${p}`, `tail ${p}`, `less ${p}`, `wc -l ${p}`,
    `grep -n secret ${p}`, `sed -n 1,5p ${p}`, `awk '{print}' ${p}`, `cp ${p} /tmp/x`, `mv ${p} /tmp/x`, `cat < ${p}`, `echo hi > ${p}`, `echo hi >> ${p}`,
    `ls -la ${p}`, `stat ${p}`, `file ${p}`, `cat ${p} | head`, `cat x; cat ${p}`, `cat x && cat ${p}`, `cat x || cat ${p}`, `(cat ${p})`, `cat \`echo\` ${p}`,
    `python3 -c "print(open('${p}').read())"`, `node -e "require('fs').readFileSync('${p}')"`, `tar czf /tmp/x.tgz ${p}`, `zip /tmp/x.zip ${p}`, `rsync -a ${p} /tmp/`,
    `cat x:${p}`, `FILE=${p}`, `cat $(echo ${p})`, `xargs cat <<< ${p}`, `diff ${p} x`, `strings ${p}`, `base64 ${p}`, `od -c ${p}`, `vim ${p}`, `git log -- ${p}`);
}
MUST.push('ls users', 'ls users/', 'ls -la users', 'cd users', 'find users -type f', 'grep -r x users/', 'du -sh users', 'tree users', 'ls memory/users', 'ls .team/users',
  'cat users/*/notes.md', 'cat users/b*/notes.md', 'cat users/?ob/notes.md', 'cat users/{bob,eve}/notes.md', 'ls memory', 'cat memory/RULES.md', 'find memory -name "*.md"',
  'tar czf /tmp/all.tgz users', 'rsync -a users/ /tmp/u/', 'zip -r /tmp/u.zip users', 'cp -r users /tmp/', 'cat users/bob/../bob/notes.md', 'cat Reports/../users/bob/notes.md');
for (const c of MUST) ok(`refused: ${c}`, bash(c) === 2, bash(c));

const OWN = ['cat users/ann/notes.md', 'ls users/ann', 'cat memory/users/ann/x.md'.replace('memory/users/ann/x.md', 'users/ann/x.md'), 'cat .team/users/ann/routines.json', 'ls Reports', 'cat Reports/q3.md', 'grep -r pilot Reports/', 'echo hello', 'git status', 'ls', 'pwd', 'cat README.md', 'curl https://example.com/users/1', 'ls Clients/users-guide.md', 'cat "Notes/our users.md"'];
for (const c of OWN) ok(`allowed: ${c}`, bash(c) === 0, bash(c));

// Best-effort shapes: reported, the uid wall holds them.
const SOFT = ['cat ~/project/users/bob/notes.md', 'cat $HOME/project/users/bob/notes.md', 'D=users; cat $D/bob/notes.md', 'cd users && cat bob/notes.md', 'cd users/bob; cat notes.md', 'cat "$(printf users)/bob/notes.md"', "cat us'e'rs/bob/notes.md", 'cat users\\/bob/notes.md', 'p=bob; cat users/$p/notes.md', 'find . -path "*bob*" -exec cat {} \;', 'grep -r secret .', 'cat ../project/users/bob/notes.md'];
const slipped = SOFT.filter(c => bash(c) !== 2);
console.log(`  note: ${slipped.length}/${SOFT.length} best-effort shapes pass the hook (the uid wall is the guarantee):`);
for (const c of slipped) console.log(`        ${c}`);

console.log(`scope-guard-shell-fuzz: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
