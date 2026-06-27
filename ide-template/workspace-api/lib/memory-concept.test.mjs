/**
 * Guard for the emergent CONCEPT layer (docs/memory-evolution-plan.md):
 *   - computeConceptHeat counts DISTINCT verdict threads per entity slug.
 *   - buildMemoryGraph synthesises a placeholder concept node once a slug
 *     crosses CONCEPT_HEAT, so verdict `entities:` edges RESOLVE instead of
 *     dangling — and a real concepts/<slug>.md page supersedes the placeholder.
 *   - concepts/ is NEVER in the cached-prefix LOAD_ORDER (hard invariant — an
 *     accreting page in the prefix would bust the prompt cache every few writes).
 *   - a private concept page is scoped to its owner ('yours'), never shared.
 *
 * Run: node lib/memory-concept.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}`); } };

const root = mkdtempSync(join(tmpdir(), 'concept-test-'));
process.env.PROJECT_DIR = root;
process.env.REFLECT_CONCEPT_HEAT = '3';
const mem = join(root, 'memory');
mkdirSync(join(mem, 'threads'), { recursive: true });
mkdirSync(join(mem, 'concepts'), { recursive: true });
mkdirSync(join(mem, 'users', 'stan', 'threads'), { recursive: true });
mkdirSync(join(mem, 'users', 'stan', 'concepts'), { recursive: true });

const verdict = (entities) => `---\ntitle: T\nconfidence: 0.8\nentities: [${entities.join(', ')}]\n---\n## Outcome\nx\n`;
// acme in 3 distinct shared threads (heat 3). sam in 2 (heat 2). 'dup' twice in ONE thread → counts once.
writeFileSync(join(mem, 'threads', 't1.md'), verdict(['acme', 'sam', 'dup', 'dup']));
writeFileSync(join(mem, 'threads', 't2.md'), verdict(['acme']));
writeFileSync(join(mem, 'threads', 't3.md'), verdict(['acme', 'sam']));
// A shared card that [[acme]]-links — its edge must resolve to the concept node.
writeFileSync(join(mem, 'RULES.md'), `---\npurpose: rules\n---\n## Always\n- Sync with [[acme]].\n`);

const { buildMemoryGraph, computeConceptHeat } = await import('./memory-graph.js');

// (1) heat — distinct per thread
const heat = computeConceptHeat();
ok('heat: acme = 3 distinct threads', heat.acme === 3);
ok('heat: sam = 2 distinct threads', heat.sam === 2);
ok('heat: dup counted once per thread (=1)', heat.dup === 1);

// (2) synthetic placeholder at/above threshold, none below
let g = buildMemoryGraph();
const concept = (id) => g.nodes.find(n => n.kind === 'concept' && n.id === id);
ok('acme (heat 3) → synthetic concept node', !!concept('acme') && concept('acme').synthetic === true);
ok('synthetic node carries heat', concept('acme')?.heat === 3);
ok('sam (heat 2) → NO node (below threshold)', !concept('sam'));
ok('dup (heat 1) → NO node', !concept('dup'));

// (3) edges to acme RESOLVE (previously dangled). Expect 3 thread edges + 1 card edge.
const acmeEdges = g.edges.filter(e => e.target === 'acme');
ok('verdict + card edges resolve to acme concept (no dangling)', acmeEdges.length === 4);
ok('sam edges dangle (no node, below heat) → 0 edges', g.edges.filter(e => e.target === 'sam').length === 0);

// (4) a REAL concept page supersedes the placeholder (not synthetic, has relPath, no dup)
writeFileSync(join(mem, 'concepts', 'acme.md'), `---\ntitle: Acme\nkind: concept\npurpose: Acme.\n---\n## Claims\n- Renews in Q3.\n`);
g = buildMemoryGraph();
const acmeNodes = g.nodes.filter(n => n.kind === 'concept' && n.id === 'acme');
ok('real page → exactly one acme concept node (no dup)', acmeNodes.length === 1);
ok('real page → node is NOT synthetic', acmeNodes[0]?.synthetic !== true);
ok('real page → node has a relPath', acmeNodes[0]?.relPath === 'memory/concepts/acme.md');
ok('edges still resolve to the real page', g.edges.filter(e => e.target === 'acme').length === 4);

// (5) private concept page is scoped to its owner, never shared
writeFileSync(join(mem, 'users', 'stan', 'concepts', 'jan.md'), `---\ntitle: Jan\nkind: concept\n---\n## Claims\n- Polish.\n`);
const gStan = buildMemoryGraph('stan');
const jan = gStan.nodes.find(n => n.kind === 'concept' && n.id === 'yours:jan');
ok('private concept enumerated for its owner', !!jan && jan.scope === 'yours');
const gOther = buildMemoryGraph('kasia');
ok("private concept NEVER visible to a different actor", !gOther.nodes.some(n => n.id === 'yours:jan'));

// (6) hard invariant — concepts/ is NEVER in the cached-prefix LOAD_ORDER
const { _internal } = await import('./memory-loader.js');
ok('concepts/ not in LOAD_ORDER', !_internal.LOAD_ORDER.some(x => /concept/i.test(x.id) || /concept/i.test(x.path)));

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
