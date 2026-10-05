// The routines skill's catalog reference is generated from routines.catalog.json;
// a catalog change without regenerating it would let the bot offer a routine
// that isn't there (or miss a new one).
import { readFileSync } from 'node:fs';
import { render, REFERENCE } from './routines-reference.js';

const catalog = JSON.parse(readFileSync(new URL('../routines.catalog.json', import.meta.url), 'utf8')).routines;
const ref = readFileSync(REFERENCE, 'utf8');
let fail = 0;
const ok = (name, cond) => { if (!cond) { fail++; console.error('FAIL', name); } };
ok('reference is up to date (run: node lib/routines-reference.js)', ref === render());
ok('every catalog routine is in the reference by id', catalog.every(r => ref.includes(`\`${r.id}\``)));
console.log(`routines-reference: ${fail ? 'FAILED' : 'ok'}`);
process.exit(fail ? 1 : 0);
