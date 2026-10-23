/**
 * What the reminder monitor hands to its delivery legs for a due reminder —
 * the node block of bot/reminder-monitor.sh, run on a temp reminders file.
 * A Slack-bound reminder keeps its channel (it used to become 'all' and never
 * reached Slack); in solo the recipients column is empty, so a planner duty
 * goes the operator's way instead of asking for a teammate turn that solo
 * always refuses (one went dead after four tries); in team mode it is kept.
 *
 * Run: node lib/reminder-monitor-due.test.mjs   (wired into `npm test`)
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };

const sh = readFileSync(new URL('../../bot/reminder-monitor.sh', import.meta.url), 'utf8');
const m = sh.match(/MESSAGES=\$\(node - "\$REMINDERS_FILE" "\$CHAT_ID" << 'NODEEOF'\n([\s\S]*?)\nNODEEOF/);
ok('the due-reminder block is found in the monitor', !!m);
const block = m ? m[1] : '';

const run = ({ teamMode, roster }) => {
  const dir = mkdtempSync(join(tmpdir(), 'monitor-due-'));
  writeFileSync(join(dir, '.team-config.json'), JSON.stringify(teamMode == null ? {} : { teamMode }));
  writeFileSync(join(dir, '.allowed-emails.json'), JSON.stringify(roster));
  const past = new Date(Date.now() - 60_000).toISOString();
  const file = join(dir, '.reminders.json');
  writeFileSync(file, JSON.stringify([
    { id: 'r_slack', title: 'Daily joke', due: past, status: 'pending', channel: 'slack', origin: 'planner', recipients: ['stan'], setBy: 'stan', repeat: 'none' },
    { id: 'r_tg', title: 'Call the printer', due: past, status: 'pending', channel: 'telegram', recipients: ['stan', 'mara'], setBy: 'stan', repeat: 'none' },
  ]));
  const r = spawnSync(process.execPath, ['-', file, '111'], { input: block, encoding: 'utf8', env: { ...process.env, PROJECT_DIR: dir } });
  const rows = String(r.stdout || '').split('\n').filter(Boolean).map(l => l.split('\x1f'));
  return { rows, err: r.stderr, byId: (id) => rows.find(c => c[0] === id) };
};

const one = [{ email: 'stan@example.test', slug: 'stan', role: 'admin' }];
const two = [...one, { email: 'mara@example.test', slug: 'mara', role: 'member' }];

let r = run({ teamMode: null, roster: one });
ok('both due reminders are handed over', r.rows.length === 2, { rows: r.rows, err: r.err.slice(0, 300) });
ok('a Slack-bound reminder keeps its channel', r.byId('r_slack')?.[1] === 'slack', r.byId('r_slack'));
ok('solo (one person): the recipients column is empty — the operator\'s path', r.byId('r_slack')?.[2] === '' && r.byId('r_tg')?.[2] === '', r.rows.map(c => c.slice(0, 3)));
ok('...and a planner duty still says it is one', r.byId('r_slack')?.[7] === '2', r.byId('r_slack'));

r = run({ teamMode: false, roster: two });
ok('team mode switched off, two on the roster: still solo', r.byId('r_tg')?.[2] === '', r.byId('r_tg'));

r = run({ teamMode: null, roster: two });
ok('team mode (two people): the recipients ride along', r.byId('r_tg')?.[2] === 'stan,mara' && r.byId('r_slack')?.[2] === 'stan', r.rows.map(c => c.slice(0, 3)));
r = run({ teamMode: true, roster: one });
ok('team mode switched on: kept even for one person', r.byId('r_slack')?.[2] === 'stan', r.byId('r_slack'));

console.log(`reminder-monitor-due: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
