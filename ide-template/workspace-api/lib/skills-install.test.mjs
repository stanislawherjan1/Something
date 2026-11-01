// An integration's skills install when it is activated, whether their
// `requires:` names the catalog id (email-imap) or the MCP server's name
// (email) — the two installers used to disagree, so one kind was never installed.
// A copy still as shipped follows a newer release; an edited one is kept.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'skills-install-'));
const OPT = join(ROOT, 'optional');
process.env.PROJECT_DIR = join(ROOT, 'project');
process.env.OPTIONAL_SKILLS_DIR = OPT;
const skill = (name, requires) => {
  mkdirSync(join(OPT, name), { recursive: true });
  writeFileSync(join(OPT, name, 'SKILL.md'), `---\nname: ${name}\ndescription: test\nrequires: ${requires}\n---\nbody\n`);
};
skill('by-server-name', 'email');
skill('by-catalog-id', 'email-imap');
skill('someone-else', 'shopify');

let fail = 0;
const ok = (name, cond) => { if (!cond) { fail++; console.error('FAIL', name); } };
const { installOptionalSkill } = await import('./integrations/runtime.js');
const got = installOptionalSkill('email-imap');
const dest = (n) => existsSync(join(process.env.PROJECT_DIR, '.claude', 'skills', n, 'SKILL.md'));
ok('installs a skill that names the MCP server (email)', dest('by-server-name'));
ok('installs a skill that names the catalog id (email-imap)', dest('by-catalog-id'));
ok("doesn't install another integration's skill", !dest('someone-else'));
ok('reports both', got.includes('by-server-name') && got.includes('by-catalog-id'));

const SKILLS = join(process.env.PROJECT_DIR, '.claude', 'skills');
const read = (n) => readFileSync(join(SKILLS, n, 'SKILL.md'), 'utf8');
const ship = (name, body) => writeFileSync(join(OPT, name, 'SKILL.md'), `---\nname: ${name}\ndescription: test\nrequires: email\n---\n${body}\n`);

ok('a second pass changes nothing', installOptionalSkill('email-imap').length === 0);

ship('by-server-name', 'body v2');
ok('a copy still as shipped takes the new release', installOptionalSkill('email-imap').includes('by-server-name') && read('by-server-name').includes('body v2'));

writeFileSync(join(SKILLS, 'by-server-name', 'SKILL.md'), read('by-server-name') + 'my own note\n');
ship('by-server-name', 'body v3');
installOptionalSkill('email-imap');
ok('an edited copy is kept', read('by-server-name').includes('my own note') && !read('by-server-name').includes('body v3'));

// Copies made before they were tracked: unstamped is replaced with a backup,
// a stamped integration copy is replaced, a project skill of the name is kept.
skill('legacy-plain', 'email'); skill('legacy-stamped', 'email'); skill('legacy-project', 'email');
const legacy = (name, extra) => {
  mkdirSync(join(SKILLS, name), { recursive: true });
  writeFileSync(join(SKILLS, name, 'SKILL.md'), `---\nname: ${name}\n${extra}requires: email\n---\nold release\n`);
};
legacy('legacy-plain', ''); legacy('legacy-stamped', 'source: integration:email\n'); legacy('legacy-project', 'source: project\n');
installOptionalSkill('email-imap');
ok('an untracked copy is replaced', read('legacy-plain').includes('body') && !read('legacy-plain').includes('old release'));
const kept = join(process.env.PROJECT_DIR, '.claude', '.skills-replaced');
ok('…and the old one is kept aside', existsSync(kept) && readdirSync(kept).some(n => n.startsWith('legacy-plain-')
  && readFileSync(join(kept, n, 'SKILL.md'), 'utf8').includes('old release')));
ok('a stamped integration copy is replaced', !read('legacy-stamped').includes('old release'));
ok('a project skill of the same name is kept', read('legacy-project').includes('old release'));
ok('no staging folder is left behind', !readdirSync(SKILLS).some(n => n.endsWith('.staging')));

// A person's own connection: the copy names their server, and is refreshed too.
skill('mine', 'email');
writeFileSync(join(OPT, 'mine', 'SKILL.md'), '---\nname: mine\nrequires: email\n---\nuse mcp__email__send v1\n');
const own = () => readFileSync(join(process.env.PROJECT_DIR, 'users', 'ann', '.skills', 'mine', 'SKILL.md'), 'utf8');
installOptionalSkill('email-imap@ann');
ok("a person's copy names their own server", own().includes('mcp__email-mine__send v1'));
ok("…and a second pass leaves it", installOptionalSkill('email-imap@ann').length === 0);
writeFileSync(join(OPT, 'mine', 'SKILL.md'), '---\nname: mine\nrequires: email\n---\nuse mcp__email__send v2\n');
installOptionalSkill('email-imap@ann');
ok("a person's copy takes the new release", own().includes('mcp__email-mine__send v2'));

rmSync(ROOT, { recursive: true, force: true });
console.log(`skills-install: ${fail ? 'FAILED' : 'ok'}`);
process.exit(fail ? 1 : 0);
