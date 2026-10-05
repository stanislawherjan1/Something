#!/usr/bin/env node
// One-off: give facts written before titles existed a title (and, for a status,
// what it is about and when it happens). Adds metadata only — a note's text
// never changes. Idempotent: notes that already have a title are skipped.
//
//   node bin/title-notes.mjs            → writes the titles
//   node bin/title-notes.mjs --dry-run  → prints what it would write
//
// Run inside the container as the workspace-api user, with PROJECT_DIR set.
// A script started by hand lacks the server's environment: without the store
// path the Claude token isn't found, every model call fails, and the decisions
// silently fall back to "unrelated". Set it, then check the model answers.
import { existsSync as _exists } from 'node:fs';
if (!process.env.WSAPI_STORE_DIR && _exists('/var/wsapi-store')) process.env.WSAPI_STORE_DIR = '/var/wsapi-store';
const { titleUntitled } = await import('../lib/memory-titles.js');
const { runStructured } = await import('../lib/memory-llm.js');
const ledger = await import('../lib/memory-ledger.js');

try {
  await runStructured({ system: 'Answer as JSON.', user: 'Say ok.', schema: { type: 'object', properties: { ok: { type: 'string' } }, required: ['ok'] }, timeoutMs: 60_000 });
} catch (e) {
  console.error(`The model isn't answering (${e.message}). Nothing was done — fix that first (is the Claude token set, and WSAPI_STORE_DIR right?).`);
  process.exit(1);
}

// --dry-run kept for muscle memory: titling is metadata-only and idempotent,
// so the dry run just reports how many notes lack a title.
if (process.argv.includes('--dry-run')) {
  const facts = await import('../lib/memory-facts.js');
  for (const scope of ledger.allScopes()) {
    const n = facts.all(scope).filter(f => f.text && !f.hidden && !f.replacedBy && !f.title).length;
    console.log(`${scope}: ${n} untitled facts`);
  }
  process.exit(0);
}
const counts = await titleUntitled(ledger.allScopes(), { log: console.error });
for (const [scope, n] of Object.entries(counts)) console.log(`${scope}: ${n} notes titled`);
console.log(`done: ${Object.values(counts).reduce((a, b) => a + b, 0)}`);
