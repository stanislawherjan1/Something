/**
 * Guard for reminder delivery: a fired reminder must not be consumed until
 * something confirmed it left the box.
 *
 * The monitor used to delete the record (or advance the repeat) in the same
 * pass that decided it was due — BEFORE any delivery was attempted. If both
 * routes to the brain were down, the occurrence was simply gone: no retry, no
 * record, nothing to notice. The script's own comment called
 * retry-instead-of-consume "the obvious next fix"; this is that fix, and this
 * test is what keeps it honest.
 *
 * The settle program is lifted out of the shell heredoc and run exactly as the
 * monitor runs it (`node - <file>`, program on stdin), so these assertions
 * cover the shipped code rather than a copy of it.
 *
 * Run: node ide-template/scripts/test-reminder-settle.mjs
 */
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const script = readFileSync(new URL('../bot/reminder-monitor.sh', import.meta.url), 'utf8');
const settle = script.slice(script.indexOf("<< 'SETTLEEOF'\n") + 15, script.indexOf('\nSETTLEEOF'));
const dir = mkdtempSync(join(tmpdir(), 'rem-'));
const file = join(dir, '.reminders.json');
const run = (reminders, ok, fail) => {
  writeFileSync(file, JSON.stringify(reminders, null, 2));
  const out = execFileSync('node', ['-', file],
    { input: settle, env: { ...process.env, OK_IDS: ok.join('\n'), FAIL_IDS: fail.join('\n') }, encoding: 'utf8' });
  return { file: JSON.parse(readFileSync(file, 'utf8')), dead: out.trim() };
};
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) pass++; else { fail++; console.log('  FAIL:', n, e ? JSON.stringify(e) : ''); } };

// one-shot delivered → tombstone, not deleted
let r = run([{ id: 'a', status: 'firing', attempts: 1, due: '2026-01-01T00:00:00Z', pendingNext: null }], ['a'], []);
ok('a delivered one-shot leaves a tombstone', r.file[0].status === 'sent' && !!r.file[0].settledAt, r.file[0]);

// repeat delivered → advances to the stashed next occurrence
r = run([{ id: 'b', status: 'firing', attempts: 1, due: '2026-01-01T00:00:00Z', pendingNext: { due: '2026-01-02T00:00:00Z', recur: null } }], ['b'], []);
ok('a delivered repeat advances', r.file[0].status === 'pending' && r.file[0].due === '2026-01-02T00:00:00Z', r.file[0]);
ok('...and its attempt counter resets', r.file[0].attempts === 0);

// failed delivery → back to pending with a backoff, NOT consumed
r = run([{ id: 'c', status: 'firing', attempts: 1, due: '2026-01-01T00:00:00Z', pendingNext: null }], [], ['c']);
ok('a failed delivery survives and retries', r.file[0].status === 'pending', r.file[0]);
ok('...with the retry pushed into the future', Date.parse(r.file[0].due) > Date.now());

// exhausted → parked as dead and surfaced, still not silently gone
r = run([{ id: 'd', status: 'firing', attempts: 5, title: 'call the client', due: '2026-01-01T00:00:00Z', pendingNext: null }], [], ['d']);
ok('an exhausted reminder is parked, not lost', r.file[0].status === 'dead', r.file[0]);
ok('...and is surfaced to the operator', /call the client/.test(r.dead), r.dead);

// an unrelated in-flight claim is left alone
r = run([{ id: 'e', status: 'firing', attempts: 1, due: '2026-01-01T00:00:00Z' }], ['other'], []);
ok('a claim nobody settled stays claimed', r.file[0].status === 'firing');
// ── the watermark on the CLAIM side ──────────────────────────────────────────
// "Scan the inbox since the last check" had no state behind it: the phrase was
// in the message and nothing ever supplied a boundary, so an hourly ritual
// re-reported the same mail every hour. The monitor knows when the reminder last
// settled, so it must hand the model a real timestamp.
const claim = script.slice(script.indexOf('// Compose the wire-format message.'));
ok('a repeat is told what it has already reported',
  /Only report what is new since \$\{new Date\(lastRun\)\.toISOString\(\)\}/.test(claim));
ok('the boundary is the last SETTLE, not the last attempt',
  /Date\.parse\(r\.settledAt \|\| ''\)/.test(claim));
ok('a one-shot gets no watermark (it has no previous run)',
  /r\.recur \? Date\.parse/.test(claim));
ok('a first run gets no watermark either (no settledAt yet)',
  /Number\.isFinite\(lastRun\) && lastRun > 0 && lastRun < now/.test(claim));
ok('nothing new means silence, not a repeat of the last report',
  /If nothing is new, say nothing/.test(claim));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
