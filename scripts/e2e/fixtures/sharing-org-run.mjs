// Runs inside the container (sharing-org.sh pipes it in, after a line that sets
// `F`, the fixture): an invented company in a throwaway PROJECT_DIR, every case
// through the deployed router, notes pass and sharing gate. Prints one JSON line.
/* global F */
import { writeFileSync, mkdirSync } from 'node:fs';
const D = process.env.PROJECT_DIR, WS = process.env.WS || '/opt/ide/workspace-api';
mkdirSync(`${D}/memory`, { recursive: true });
writeFileSync(`${D}/memory/MISSION.md`, `# MISSION\n\n## About the company\n${F.company.map(l => `- ${l}`).join('\n')}\n`);
writeFileSync(`${D}/.allowed-emails.json`, JSON.stringify(F.team.map(m => ({ ...m, email: `${m.slug}@example.test`, addedAt: '2026-09-01T00:00:00Z' }))));
writeFileSync(`${D}/.team-config.json`, JSON.stringify({ teamMode: true }));
const R = await import(`${WS}/lib/memory-router.js`);
const S = await import(`${WS}/lib/memory-sharing.js`);
let org = null;
try { org = (await import(`${WS}/lib/memory-org.js`)).orgContext; } catch { /* a deployment that predates it */ }
const out = [];
for (const c of F.cases) {
  const m = F.team.find(t => t.slug === c.who), name = m.displayName, ts = new Date().toISOString();
  const routed = await R.route({ name, channel: 'web', ts, text: c.text, ...(org ? { org: org({ person: name }) } : {}) }).catch(e => ({ error: e.message }));
  const said = c.text.split('\n').filter(l => l.startsWith(`${name}:`)).join('\n');
  const n = await R.notes({ name, ts, text: c.text, attest: said, known: [], kinds: {}, exclude: [], max: 3, ...(org ? { org: org({ person: name }) } : {}) }).catch(e => ({ notes: [], error: e.message }));
  const facts = (n.notes || []).map(f => ({ title: f.title, outcome: routed.error ? 'private' : S.decide({ mode: m.sharing, fact: f, routed, rules: [], decided: new Map() }).outcome }));
  const got = facts.some(f => f.outcome === 'team') ? 'share' : facts.some(f => f.outcome === 'ask') ? 'ask' : 'private';
  out.push({ name: c.name, expect: c.expect, got, error: routed.error || n.error || null, facts });
}
console.log(JSON.stringify({ org: !!org, out }));
