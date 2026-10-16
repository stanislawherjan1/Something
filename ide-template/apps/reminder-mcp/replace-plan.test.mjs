/**
 * replace_plan, spoken to the real server over stdio as the bot does: the day's
 * plan is swapped in one step — a bad item changes nothing, the previous plan
 * of THIS person goes, nobody else's, and the person's own and the system's
 * reminders are never touched.
 *
 * Run: node apps/reminder-mcp/replace-plan.test.mjs   (needs `npm ci` in apps/reminder-mcp)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), 'replace-plan-'));
const FILE = join(DIR, '.reminders.json');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };

const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString();
const seed = [
  { id: 'r_old1', kind: 'user', origin: 'planner', title: 'Old brief', message: 'Old brief', due: inHours(1), repeat: 'none', status: 'pending', setBy: 'ola', recipients: ['ola'] },
  { id: 'r_old2', kind: 'user', origin: 'planner', title: 'Hourly inbox', message: 'Hourly inbox', due: inHours(2), repeat: 'custom', recur: { type: 'interval', every: 1, unit: 'hours' }, status: 'pending', setBy: 'ola', recipients: ['ola'] },
  { id: 'r_mine', kind: 'user', title: 'Call the dentist', message: 'Call the dentist', due: inHours(3), repeat: 'none', status: 'pending', setBy: 'ola', recipients: ['ola'] },
  { id: 'r_kai', kind: 'user', origin: 'planner', title: "Kai's brief", message: "Kai's brief", due: inHours(1), repeat: 'none', status: 'pending', setBy: 'kai', recipients: ['kai'] },
  { id: 'r_system_plan_day__ola', kind: 'system', title: 'Morning planning', message: '[PLAN_DAY_TRIGGER]', due: inHours(20), repeat: 'daily', status: 'pending', recipients: ['ola'] },
];
writeFileSync(FILE, JSON.stringify(seed, null, 2));
const ids = () => JSON.parse(readFileSync(FILE, 'utf8')).map((r) => r.id);

// A minimal MCP client over stdio, as the person "ola" in team mode.
const proc = spawn(process.execPath, [join(HERE, 'index.js')], {
  env: { ...process.env, REMINDERS_FILE: FILE, IDE_ACTOR_SLUG: 'ola', IDE_ACTOR_IS_ADMIN: '0', REMINDER_DEFAULT_CHANNEL: 'web' },
  stdio: ['pipe', 'pipe', 'inherit'],
});
let buf = '';
const waiting = new Map();
proc.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id != null && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  }
});
let seq = 0;
const rpc = (method, params) => new Promise((resolve) => { const id = ++seq; waiting.set(id, resolve); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const tool = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); return { error: !!r.result?.isError, text: r.result?.content?.[0]?.text || '' }; };

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const tools = await rpc('tools/list', {});
ok('the server offers replace_plan', tools.result.tools.some((t) => t.name === 'replace_plan'));

// A bad item (a time in the past) changes nothing at all.
let r = await tool('replace_plan', { reminders: [
  { title: 'Morning brief', due: inHours(1), urgency: 'ambient' },
  { title: 'Too late', due: new Date(Date.now() - 3 * 3600_000).toISOString() },
] });
ok('a plan with a bad item is refused', r.error && /nothing changed/i.test(r.text) && /Too late/.test(r.text), r.text);
ok('...and the previous plan is untouched', ['r_old1', 'r_old2', 'r_mine', 'r_kai', 'r_system_plan_day__ola'].every((id) => ids().includes(id)), ids());

// A good plan swaps hers, in one step.
r = await tool('replace_plan', { reminders: [
  { title: 'Morning brief', description: 'The day in two lines.', due: inHours(1), urgency: 'ambient' },
  { title: 'Inbox check', description: 'Silent unless something needs her.', due: inHours(1.5), recur: { type: 'interval', every: 1, unit: 'hours' } },
] });
const after = JSON.parse(readFileSync(FILE, 'utf8'));
ok('the new plan is written', !r.error && after.filter((x) => x.origin === 'planner' && x.recipients?.[0] === 'ola').length === 2, r.text);
ok("her previous plan is gone, the recurring duty included", !ids().includes('r_old1') && !ids().includes('r_old2'), ids());
ok('her own reminder stays', ids().includes('r_mine'));
ok("another person's plan stays", ids().includes('r_kai'));
ok('the system trigger stays', ids().includes('r_system_plan_day__ola'));
ok('every placed reminder is marked as the planner\'s', after.filter((x) => !seed.some((s) => s.id === x.id)).every((x) => x.origin === 'planner'));
ok('the answer says what was replaced', /2 placed, 2 from the previous plan removed/.test(r.text), r.text);

// Running it again replaces, never stacks.
r = await tool('replace_plan', { reminders: [{ title: 'Inbox check', due: inHours(1.5), recur: { type: 'interval', every: 1, unit: 'hours' } }] });
ok('a second run replaces, never stacks', JSON.parse(readFileSync(FILE, 'utf8')).filter((x) => x.origin === 'planner' && x.recipients?.[0] === 'ola').length === 1, r.text);

proc.kill();
console.log(`replace-plan: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
