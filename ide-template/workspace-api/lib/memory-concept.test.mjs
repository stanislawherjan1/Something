/**
 * Guard for the emergent CONCEPT layer (reflect v2 semantics):
 *   - computeConceptHeat reads the memory/_reflect/ verdict PLUMBING (verdicts
 *     are not memory), counts DISTINCT threads per entity slug with a 30-day
 *     age decay, and never counts substance:noise verdicts.
 *   - buildMemoryGraph renders NO thread nodes at all; a slug whose decayed
 *     heat crosses CONCEPT_HEAT and has no page yet appears as a synthetic
 *     "emerging" concept node, and a real concepts/<slug>.md supersedes it.
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
mkdirSync(join(mem, '_reflect', 'threads'), { recursive: true });
mkdirSync(join(mem, 'concepts'), { recursive: true });
mkdirSync(join(mem, 'users', 'stan', '_reflect', 'threads'), { recursive: true });
mkdirSync(join(mem, 'users', 'stan', 'concepts'), { recursive: true });

const verdict = (entities, substance = 'durable') =>
  `---\ntitle: T\nsubstance: ${substance}\nconfidence: 0.8\nentities: [${entities.join(', ')}]\n---\n## Outcome\nx\n`;
// acme in 3 distinct threads (fresh files → decayed weight ≈1 each → heat ≈3).
// sam in 2. 'dup' twice in ONE thread → counts once. 'ghost' only in a NOISE
// verdict → must never heat.
writeFileSync(join(mem, '_reflect', 'threads', 't1.md'), verdict(['acme', 'sam', 'dup', 'dup']));
writeFileSync(join(mem, '_reflect', 'threads', 't2.md'), verdict(['acme']));
writeFileSync(join(mem, '_reflect', 'threads', 't3.md'), verdict(['acme', 'sam']));
writeFileSync(join(mem, '_reflect', 'threads', 't4-noise.md'), verdict(['ghost'], 'noise'));
// A shared card that [[acme]]-links — its edge must resolve to the concept node.
writeFileSync(join(mem, 'RULES.md'), `---\npurpose: rules\n---\n## Always\n- Sync with [[acme]].\n`);

const { buildMemoryGraph, computeConceptHeat } = await import('./memory-graph.js');

const near = (v, target, eps = 0.01) => Number.isFinite(v) && Math.abs(v - target) < eps;

// (1) heat — distinct per thread, decayed (fresh ≈ nominal), noise excluded
const heat = computeConceptHeat();
ok('heat: acme ≈ 3 distinct threads (decayed)', near(heat.acme, 3));
ok('heat: sam ≈ 2 distinct threads (decayed)', near(heat.sam, 2));
ok('heat: dup counted once per thread (≈1)', near(heat.dup, 1));
ok('heat: noise verdict never heats an entity', heat.ghost === undefined);

// (2) synthetic "emerging" node at/above threshold, none below; NO thread nodes ever
let g = buildMemoryGraph();
const concept = (id) => g.nodes.find(n => n.kind === 'concept' && n.id === id);
ok('graph renders no thread nodes (verdicts are plumbing)', !g.nodes.some(n => n.kind === 'thread'));
ok('acme (heat ≈3) → synthetic concept node', !!concept('acme') && concept('acme').synthetic === true);
ok('synthetic node carries heat', near(concept('acme')?.heat ?? 0, 3, 0.11));
ok('sam (heat ≈2) → NO node (below threshold)', !concept('sam'));
ok('dup (heat ≈1) → NO node', !concept('dup'));

// (3) the card's [[acme]] wiki edge RESOLVES against the synthetic node.
const acmeEdges = g.edges.filter(e => e.target === 'acme');
ok('card wiki edge resolves to emerging concept (no dangling)', acmeEdges.length === 1 && acmeEdges[0].source === 'rules');
ok('sam gets no edges (no node, below heat)', g.edges.filter(e => e.target === 'sam').length === 0);

// (4) a REAL concept page supersedes the placeholder (not synthetic, has relPath, no dup)
writeFileSync(join(mem, 'concepts', 'acme.md'), `---\ntitle: Acme\nkind: concept\npurpose: Acme.\n---\n## Claims\n- Renews in Q3.\n`);
g = buildMemoryGraph();
const acmeNodes = g.nodes.filter(n => n.kind === 'concept' && n.id === 'acme');
ok('real page → exactly one acme concept node (no dup)', acmeNodes.length === 1);
ok('real page → node is NOT synthetic', acmeNodes[0]?.synthetic !== true);
ok('real page → node has a relPath', acmeNodes[0]?.relPath === 'memory/concepts/acme.md');
ok('edges still resolve to the real page', g.edges.filter(e => e.target === 'acme').length >= 1);

// (5) private concept page is scoped to its owner, never shared
writeFileSync(join(mem, 'users', 'stan', 'concepts', 'jan.md'), `---\ntitle: Jan\nkind: concept\n---\n## Claims\n- Polish.\n`);
const gStan = buildMemoryGraph('stan');
const jan = gStan.nodes.find(n => n.kind === 'concept' && n.id === 'yours:jan');
ok('private concept enumerated for its owner', !!jan && jan.scope === 'yours');
const gOther = buildMemoryGraph('kasia');
ok("private concept NEVER visible to a different actor", !gOther.nodes.some(n => n.id === 'yours:jan'));

// (6) per-owner heat reads the owner's OWN _reflect tree
writeFileSync(join(mem, 'users', 'stan', '_reflect', 'threads', 'p1.md'), verdict(['piano']));
const stanHeat = computeConceptHeat('stan');
ok('per-owner heat from users/<slug>/_reflect', near(stanHeat.piano, 1));
ok('shared heat unaffected by private verdicts', computeConceptHeat().piano === undefined);

// (7) hard invariant — concepts/ is NEVER in the cached-prefix LOAD_ORDER
const { _internal } = await import('./memory-loader.js');
ok('concepts/ not in LOAD_ORDER', !_internal.LOAD_ORDER.some(x => /concept/i.test(x.id) || /concept/i.test(x.path)));

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
