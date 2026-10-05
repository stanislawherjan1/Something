// An integration's skills install when it is activated, whether their
// `requires:` names the catalog id (email-imap) or the MCP server's name
// (email) — the two installers used to disagree, so one kind was never installed.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
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
console.log(`skills-install: ${fail ? 'FAILED' : 'ok'}`);
process.exit(fail ? 1 : 0);
