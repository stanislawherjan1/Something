// The Marketplace catalog as the bot reads it: skills/default/routines/
// references/catalog.md, generated from routines.catalog.json so the skill can
// never offer a routine the catalog doesn't have. Regenerate after editing the
// catalog:  node lib/routines-reference.js   (the test fails when it's stale).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES } from './routines-catalog.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG = join(HERE, '..', 'routines.catalog.json');
const INTEGRATIONS = join(HERE, '..', 'integrations.catalog.json');
export const REFERENCE = join(HERE, '..', '..', 'skills', 'default', 'routines', 'references', 'catalog.md');


export function render() {
  const routines = JSON.parse(readFileSync(CATALOG, 'utf8')).routines;
  const label = Object.fromEntries(JSON.parse(readFileSync(INTEGRATIONS, 'utf8')).integrations.map(i => [i.id, i.label || i.id]));
  const needs = (r) => {
    const any = (r.requires || []).map(id => label[id] || id);
    const all = (r.requiresAll || []).map(id => label[id] || id);
    const parts = [];
    if (any.length) parts.push(any.join(' or '));
    if (all.length) parts.push(all.join(' and '));
    return parts.length ? parts.join(', plus ') : 'nothing';
  };
  const out = [
    '# Marketplace routines',
    '',
    '<!-- Generated from workspace-api/routines.catalog.json by lib/routines-reference.js — do not edit by hand. -->',
    '',
    'Every ready-made routine a person can add (the Marketplace tab of Routines, or `add_routine` with the id).',
    '**Needs** = the integration that must be connected first ("or" = any one of them).',
    'The summary is what to say to the person; the full instruction is what the planner runs once it is added.',
    '',
  ];
  for (const [cat, name] of CATEGORIES) {
    const list = routines.filter(r => r.category === cat);
    if (!list.length) continue;
    out.push(`## ${name}`, '');
    for (const r of list) {
      out.push(`- **${r.title}** — \`${r.id}\`${r.recommended ? ' · recommended' : ''} · needs: ${needs(r)}`);
      out.push(`  ${r.summary}`);
    }
    out.push('');
  }
  return out.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(REFERENCE, render());
  console.log(`wrote ${REFERENCE}`);
}
