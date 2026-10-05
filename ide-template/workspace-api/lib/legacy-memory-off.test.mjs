/**
 * Once a workspace has moved to memory v4 (the stamp in memory/_engine), the
 * old memory is off: the scope guard refuses to read what the wiki left behind,
 * the skill fence refuses the wiki's skills, and 0007 archives the leftovers at
 * boot. (The MCP's toolbox follows the same stamp; it needs its own node_modules
 * to start, so it is not spawned here.) Run: node lib/legacy-memory-off.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = mkdtempSync(join(tmpdir(), 'legacy-off-'));
const STORE = mkdtempSync(join(tmpdir(), 'legacy-off-store-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 400)}` : ''}`); }
};
const HOOKS = new URL('../../hooks/', import.meta.url).pathname;
const hook = (file, payload) => spawnSync(process.execPath, [join(HOOKS, file)], { input: JSON.stringify(payload), env: { ...process.env, PROJECT_DIR: ROOT }, encoding: 'utf8' });
const abs = (p) => join(ROOT, p);

mkdirSync(abs('memory/_engine/undo'), { recursive: true });
writeFileSync(abs('memory/_engine/undo/x.json'), '{}');
writeFileSync(abs('memory/USER_PROFILE.md'), '# USER_PROFILE\n');
writeFileSync(abs('.allowed-emails.json'), JSON.stringify([{ email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', addedAt: '2026-09-01T00:00:00Z' }]));

// ─── (a) the scope guard, before and after the move ──────────────────────────
let r = hook('scope-guard.mjs', { tool_name: 'Read', tool_input: { file_path: abs('memory/_engine/undo/x.json') } });
ok('(a) before the move the guard does not mind the engine dir', r.status === 0, r.stderr);
writeFileSync(abs('memory/_engine/.v4-migrated'), '{}');
r = hook('scope-guard.mjs', { tool_name: 'Read', tool_input: { file_path: abs('memory/_engine/undo/x.json') } });
ok('(a) after the move an old card version is not readable', r.status === 2 && /moved to the new memory/.test(r.stderr), r);
for (const p of ['memory/topics/x.md', 'memory/users/stan/concepts/y.md', 'memory/INDEX.md', 'memory/users/stan/INDEX.md', 'memory/users/stan/ledger/2026-09.jsonl', 'memory/users/stan/views/digest.json', 'memory/patterns/p.md']) {
  r = hook('scope-guard.mjs', { tool_name: 'Read', tool_input: { file_path: abs(p) } });
  ok(`(a) ...nor ${p}`, r.status === 2, r.stderr);
}
r = hook('scope-guard.mjs', { tool_name: 'Grep', tool_input: { pattern: 'x', path: abs('memory/_engine') } });
ok('(a) ...nor a grep over the engine dir', r.status === 2);
r = hook('scope-guard.mjs', { tool_name: 'Glob', tool_input: { pattern: 'memory/_engine/undo/**' } });
ok('(a) ...nor a glob into it', r.status === 2);
r = hook('scope-guard.mjs', { tool_name: 'Read', tool_input: { file_path: abs('memory/USER_PROFILE.md') } });
ok('(a) a card is not read as a file either — it is in the prefix', r.status === 2, r.stderr);
r = hook('scope-guard.mjs', { tool_name: 'Bash', tool_input: { command: 'ls -la memory/users && cat memory/RULES.md' } });
ok('(a) nor listed from the shell', r.status === 2 && /not a directory to read or list/.test(r.stderr), r.stderr);
r = hook('scope-guard.mjs', { tool_name: 'Bash', tool_input: { command: 'ls /home/coder/project/memory' } });
ok('(a) ...by absolute path too', r.status === 2);
r = hook('scope-guard.mjs', { tool_name: 'Bash', tool_input: { command: 'grep -r memory_search docs/ && echo in-memory' } });
ok('(a) a word that merely contains "memory" is not a path', r.status === 0, r.stderr);
r = hook('scope-guard.mjs', { tool_name: 'Read', tool_input: { file_path: abs('Reports/q3.md') } });
ok('(a) the rest of the project is untouched', r.status === 0, r.stderr);
r = hook('scope-guard.mjs', { tool_name: 'Edit', tool_input: { file_path: abs('memory/USER_PROFILE.md') } });
ok('(a) the write fence still holds', r.status === 2 && /memory_write/.test(r.stderr));

// ─── (b) the skill fence ─────────────────────────────────────────────────────
r = hook('skill-fence.mjs', { tool_name: 'Skill', tool_input: { skill: 'memory-cards' } });
ok('(b) the wiki\'s skills are fenced after the move', r.status === 2 && /moved to the new memory/.test(r.stderr), r);
r = hook('skill-fence.mjs', { tool_name: 'Skill', tool_input: { skill: 'taste-recall' } });
ok('(b) ...both of them', r.status === 2);
r = hook('skill-fence.mjs', { tool_name: 'Skill', tool_input: { skill: 'make-pdf' } });
ok('(b) other skills pass', r.status === 0, r.stderr);

// ─── (c) 0007: the leftovers are archived and gone, once ─────────────────────
for (const d of ['memory/topics', 'memory/concepts', 'memory/patterns', 'memory/users/stan/topics', 'memory/users/stan/patterns']) mkdirSync(abs(d), { recursive: true });
writeFileSync(abs('memory/topics/old-page.md'), '# old\n');
writeFileSync(abs('memory/patterns/p.md'), '# p\n');
writeFileSync(abs('memory/INDEX.md'), '# INDEX\n');
writeFileSync(abs('memory/users/stan/INDEX.md'), '# INDEX\n');
writeFileSync(abs('memory/users/stan/topics/t.md'), '# t\n');
writeFileSync(abs('memory/RULES.md'), '# RULES\n- Never deploy on Fridays.\n');
process.env.MEMORY_V4 = 'shadow';
const migrate = await import('./migrate.js');
let rep = await migrate.autoApply();
ok('(c) 0007 runs at boot once the stamp is there', rep.applied.includes('0007-retire-wiki-remnants'), rep);
for (const p of ['memory/_engine/undo', 'memory/topics', 'memory/concepts', 'memory/patterns', 'memory/INDEX.md', 'memory/users/stan/INDEX.md', 'memory/users/stan/topics', 'memory/users/stan/patterns']) {
  ok(`(c) ${p} is gone`, !existsSync(abs(p)));
}
ok('(c) what v4 reads is untouched', existsSync(abs('memory/RULES.md')) && existsSync(abs('memory/USER_PROFILE.md')) && existsSync(abs('memory/_engine/.v4-migrated')));
const archives = readdirSync(join(STORE, 'migrations')).filter(f => f.startsWith('0007-wiki-remnants-') && f.endsWith('.tar.gz'));
ok('(c) the leftovers are in one archive in the store', archives.length === 1, readdirSync(join(STORE, 'migrations')));
ok('(c) verify passes', (await migrate.verify('0007-retire-wiki-remnants')).ok);
rep = await migrate.autoApply();
ok('(c) a second boot is a no-op', !rep.applied.includes('0007-retire-wiki-remnants'), rep);

// ─── (d) a user tree nobody on the roster owns is archived at night ──────────
mkdirSync(abs('memory/users/ghost/ledger'), { recursive: true });
writeFileSync(abs('memory/users/ghost/USER_PROFILE.md'), '# USER_PROFILE\n- A member of one group, never a user.\n');
mkdirSync(abs('memory/users/stan/ledger'), { recursive: true });
const M = await import('./memory-maintenance.js');
const gone = M.archiveOrphanUsers();
ok('(d) the orphan tree is archived and removed, the roster\'s own stays', gone.includes('ghost') && !existsSync(abs('memory/users/ghost')) && existsSync(abs('memory/users/stan')), gone);
ok('(d) ...into the store, with the backups', readdirSync(join(STORE, 'migrations')).some(f => f.startsWith('orphan-users-')));
ok('(d) ...and logged without its content', /"op":"archive_orphans"/.test(readFileSync(abs('memory/_engine/v4-log.jsonl'), 'utf8')) && !/never a user/.test(readFileSync(abs('memory/_engine/v4-log.jsonl'), 'utf8')));
ok('(d) nothing to do is nothing done', M.archiveOrphanUsers().length === 0);

console.log(`legacy-memory-off: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
