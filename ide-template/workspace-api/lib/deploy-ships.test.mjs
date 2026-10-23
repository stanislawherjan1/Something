/**
 * deploy.sh uploads some apps file by file (`ship apps/<app>/<file>`). A file
 * an app imports that is not on that list never reaches the server: the
 * reminder server once imported a new module, the deploy left it behind, and
 * every turn on the canary lost its reminder tools. For every app shipped file
 * by file, each relative import of a shipped file must be shipped too.
 *
 * Run: node lib/deploy-ships.test.mjs   (wired into `npm test`)
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const ROOT = new URL('../../', import.meta.url).pathname;
const deploy = readFileSync(join(ROOT, 'deploy.sh'), 'utf8');
const shipped = new Set([...deploy.matchAll(/^ship (apps\/[^\s]+)\s/gm)].map(m => m[1]));
const apps = new Set([...shipped].map(p => p.split('/').slice(0, 2).join('/')));
ok('deploy.sh ships apps file by file', shipped.size > 10, shipped.size);

const missing = [];
for (const file of shipped) {
  if (!/\.(m?js|cjs)$/.test(file)) continue;
  const abs = join(ROOT, file);
  if (!existsSync(abs)) { missing.push(`${file} (listed, not in the repo)`); continue; }
  const src = readFileSync(abs, 'utf8');
  const specs = [...src.matchAll(/(?:import\s[^'"]*?from\s*|import\(\s*|require\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)].map(m => m[1]);
  for (const spec of specs) {
    const target = normalize(join(dirname(file), spec));
    const app = target.split('/').slice(0, 2).join('/');
    if (!apps.has(app)) continue;            // another app or shared code, shipped its own way
    if (target.split('/')[1] === '_shared') continue;
    if (!shipped.has(target)) missing.push(`${file} imports ${spec} → ${target}`);
  }
}
ok('every relative import of a shipped app file is shipped too', missing.length === 0, missing);

console.log(`deploy-ships: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
