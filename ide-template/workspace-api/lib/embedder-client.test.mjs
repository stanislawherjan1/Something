/**
 * Guards for the embedder client: it forks the worker with nothing secret in its
 * environment, answers null (→ BM25) when the worker is missing, crashes or
 * hangs, backs off after a failure, and forks again after an idle exit.
 * The worker here is a stand-in script; the real one (apps/embedder) loads a
 * model and is checked on the deploy host.
 *
 * Run: node lib/embedder-client.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'embedder-'));
const FORKS = join(DIR, 'forks.log');
process.env.SESSION_SECRET = 'must-not-reach-the-worker';
process.env.EMBEDDER_TIMEOUT_MS = '1500';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${JSON.stringify(extra).slice(0, 400)}` : ''}`); }
};

const worker = (name, body) => {
  const p = join(DIR, `${name}.mjs`);
  writeFileSync(p, `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(FORKS)}, JSON.stringify({ name: ${JSON.stringify(name)}, secret: process.env.SESSION_SECRET || null }) + '\\n');
process.on('message', (m) => { ${body} });
`);
  return p;
};
const forks = () => (existsSync(FORKS) ? readFileSync(FORKS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

const E = await import('./embedder-client.js');

process.env.EMBEDDER_WORKER = join(DIR, 'missing.mjs');
ok('(a) no worker installed → null, search falls back to BM25', (await E.embed(['x'])) === null);
E._stopForTests();

process.env.EMBEDDER_WORKER = worker('good', "process.send({ id: m.id, vectors: m.texts.map(() => [0.6, 0.8]) }); if (m.texts[0] === 'bye') setTimeout(() => process.exit(0), 50);");
let v = await E.embed(['a', 'b'], 'query');
ok('(b) the worker answers', JSON.stringify(v) === '[[0.6,0.8],[0.6,0.8]]');
ok('(b) ...and was forked without the server\'s secrets', forks().length === 1 && forks()[0].secret === null, forks());
await E.embed(['c']);
ok('(b) one worker serves many calls', forks().length === 1);
await E.embed(['bye']);
await new Promise(r => setTimeout(r, 200));
v = await E.embed(['again']);
ok('(c) after an idle exit the next call forks it again', v && forks().length === 2);
E._stopForTests();

process.env.EMBEDDER_WORKER = worker('crash', 'process.exit(3);');
ok('(d) a crashing worker → null', (await E.embed(['x'])) === null);
const n = forks().length;
ok('(d) ...and is not forked again during the cooldown', (await E.embed(['y'])) === null && forks().length === n);
E._stopForTests();

process.env.EMBEDDER_WORKER = worker('hang', '/* never answers */');
const t0 = Date.now();
ok('(e) a hanging worker → null within the timeout', (await E.embed(['x'])) === null && Date.now() - t0 < 3000);
E._stopForTests();

console.log(`embedder-client: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
