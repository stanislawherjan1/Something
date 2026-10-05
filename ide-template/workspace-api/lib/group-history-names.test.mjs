/**
 * A group's durable history names a teammate as the roster does, not as their
 * Telegram profile does: memory files a group from that history, and a profile
 * called "s" filed the operator's own words under "s".
 * Run: node lib/group-history-names.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const ROOT = mkdtempSync(join(tmpdir(), 'group-names-'));
process.env.PROJECT_DIR = ROOT;
process.env.GROUP_WATCHER_OBSERVE_ONLY = '1';
mkdirSync(join(ROOT, 'memory'), { recursive: true });
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', telegramChatId: '1110001', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true, groups: { '-100777': { title: 'Team', addedAt: '2026-09-01T00:00:00Z', members: {} } } }));
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${n}${x !== undefined ? `\n        ${JSON.stringify(x).slice(0, 400)}` : ''}`); } };
const W = await import('./integrations/group-watcher.js');
W.routeGroupMessage({ chat_id: '-100777', message_id: '1', from_id: '1110001', from_name: 's', text: 'Flying to Taiwan on the 7th.' });
W.routeGroupMessage({ chat_id: '-100777', message_id: '2', from_id: '9990009', from_name: 'Zoë', text: 'Safe travels.' });
const rows = readFileSync(join(ROOT, '.group-watcher', '-100777-history.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
ok('a teammate is named as the roster names them', rows[0]?.who === 'Stan' && rows[0]?.from_id === '1110001', rows[0]);
ok('someone not on the roster keeps their profile name', rows[1]?.who === 'Zoë', rows[1]);
console.log(`group-history-names: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
