/**
 * The sharing gate against its corpus (test-fixtures/sharing-corpus.json):
 * every line, in every mode, must get the outcome the corpus labels. A
 * change that moves a line fails here and shows in the fixture's diff.
 * Run: node lib/memory-sharing-corpus.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const S = await import('./memory-sharing.js');
const here = dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(readFileSync(join(here, '..', 'test-fixtures', 'sharing-corpus.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

ok('the corpus is big enough to mean something', cases.length >= 75, cases.length);
ok('...half of it lifestyle, half business', Math.abs(cases.filter(c => c.half === 'lifestyle').length - cases.filter(c => c.half === 'business').length) <= 4);
ok('...with every router verdict and every outcome present', ['shared', 'ask', 'private'].every(r => cases.some(c => c.router === r)) && ['team', 'ask', 'private'].every(o => cases.some(c => c.expect.auto === o)));

for (const c of cases) {
  // The router's transcript: the line lands where the corpus says it was read.
  const routed = { shared: c.router === 'shared' ? `Stan: ${c.line}` : '', ask: c.router === 'ask' ? `Stan: ${c.line}` : '', askQuestion: '' };
  const fact = { title: c.line.slice(0, 60), text: c.line, evidence: c.line, ...c.fact };
  for (const mode of ['ask', 'auto', 'never']) {
    const got = S.decide({ mode, fact, routed }).outcome;
    ok(`[${c.half}/${mode}] ${c.line}`, got === c.expect[mode], { want: c.expect[mode], got });
  }
}

console.log(`memory-sharing-corpus: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
