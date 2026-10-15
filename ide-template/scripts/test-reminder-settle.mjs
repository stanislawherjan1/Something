/**
 * Guard for reminder delivery: a fired reminder must not be consumed until
 * something confirmed it left the box, and what happens to it afterwards must
 * keep the series honest.
 *
 * The monitor used to delete the record (or advance the repeat) in the same
 * pass that decided it was due — BEFORE any delivery was attempted. If both
 * routes to the brain were down, the occurrence was simply gone: no retry, no
 * record, nothing to notice. The script's own comment called
 * retry-instead-of-consume "the obvious next fix"; this is that fix, and this
 * test is what keeps it honest.
 *
 * The claim and settle programs are lifted out of the shell heredocs and run
 * exactly as the monitor runs them (`node - <file>`, program on stdin), and
 * the teammate fan-out function is run under bash against a stand-in wsapi,
 * so these assertions cover the shipped code rather than a copy of it.
 *
 * Run: node ide-template/scripts/test-reminder-settle.mjs
 */
import { writeFileSync, readFileSync, mkdtempSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';

const script = readFileSync(new URL('../bot/reminder-monitor.sh', import.meta.url), 'utf8');
const heredoc = (tag) => script.slice(script.indexOf(`<< '${tag}'\n`) + tag.length + 5, script.indexOf(`\n${tag}\n`));
const settle = heredoc('SETTLEEOF');
const claim = heredoc('NODEEOF');
const dir = mkdtempSync(join(tmpdir(), 'rem-'));
const file = join(dir, '.reminders.json');
const readFile = () => JSON.parse(readFileSync(file, 'utf8'));

// Settle: OK/FAIL ids plus the legs delivered this pass, as the loop hands them over.
const run = (reminders, ok, fail, legs = []) => {
  writeFileSync(file, JSON.stringify(reminders, null, 2));
  const out = execFileSync('node', ['-', file], {
    input: settle, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, OK_IDS: ok.join('\n'), FAIL_IDS: fail.join('\n'), DONE_LEGS: legs.join('\n') },
  });
  const lines = out.split('\n').filter(Boolean);
  return {
    file: readFile(),
    dead: lines.filter(l => l.startsWith('dead ')).map(l => l.slice(5)).join('\n'),
    missed: lines.filter(l => l.startsWith('missed ')).map(l => l.slice(7)).join('\n'),
  };
};
// Claim: returns the wire lines (one per claimed reminder, \x1f-separated columns).
const claimRun = (reminders) => {
  writeFileSync(file, JSON.stringify(reminders, null, 2));
  const out = execFileSync('node', ['-', file, '12345'], { input: claim, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  return { file: readFile(), wire: out.split('\n').filter(Boolean).map(l => l.split('\x1f')) };
};
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) pass++; else { fail++; console.log('  FAIL:', n, e ? JSON.stringify(e) : ''); } };

// ── settle ────────────────────────────────────────────────────────────────────
// one-shot delivered → tombstone, not deleted
let r = run([{ id: 'a', status: 'firing', attempts: 1, due: '2026-01-01T00:00:00Z', pendingNext: null }], ['a'], []);
ok('a delivered one-shot leaves a tombstone', r.file[0].status === 'sent' && !!r.file[0].settledAt, r.file[0]);

// repeat delivered → advances to the stashed next occurrence
r = run([{ id: 'b', status: 'firing', attempts: 1, due: '2026-01-01T00:00:00Z', retryAt: '2026-01-01T00:02:00Z', deliveredTo: ['operator'], pendingNext: { due: '2026-01-02T00:00:00Z', recur: null } }], ['b'], []);
ok('a delivered repeat advances', r.file[0].status === 'pending' && r.file[0].due === '2026-01-02T00:00:00Z', r.file[0]);
ok('...and its attempt counter resets', r.file[0].attempts === 0);
ok('...and the attempt-only fields are gone', !('retryAt' in r.file[0]) && !('deliveredTo' in r.file[0]) && !('pendingNext' in r.file[0]), r.file[0]);

// failed delivery → back to pending with a backoff, NOT consumed
r = run([{ id: 'c', status: 'firing', attempts: 1, due: '2026-01-01T00:00:00Z', pendingNext: null }], [], ['c']);
ok('a failed delivery survives and retries', r.file[0].status === 'pending', r.file[0]);
ok('...with the retry pushed into the future', Date.parse(r.file[0].retryAt) > Date.now(), r.file[0]);
ok('...while due stays where it was (the series anchor)', r.file[0].due === '2026-01-01T00:00:00Z', r.file[0]);

// exhausted one-shot → parked as dead and surfaced, still not silently gone
r = run([{ id: 'd', status: 'firing', attempts: 5, title: 'call the client', due: '2026-01-01T00:00:00Z', pendingNext: null }], [], ['d']);
ok('an exhausted one-shot is parked, not lost', r.file[0].status === 'dead', r.file[0]);
ok('...and is surfaced to the operator', /call the client/.test(r.dead), r.dead);
ok('...and nothing is reported as missed', r.missed === '');

// exhausted REPEAT → skips this occurrence, series continues
r = run([{ id: 'f', status: 'firing', attempts: 5, title: 'hourly inbox check', due: '2026-01-01T10:00:00Z', settledAt: '2026-01-01T09:00:05Z',
  recur: { type: 'interval', every: 1, unit: 'hours' }, pendingNext: { due: '2026-01-01T11:00:00Z', recur: { type: 'interval', every: 1, unit: 'hours' } } }], [], ['f']);
ok('an exhausted repeat is NOT parked', r.file[0].status === 'pending', r.file[0]);
ok('...it moves on to the next occurrence', r.file[0].due === '2026-01-01T11:00:00Z' && r.file[0].attempts === 0, r.file[0]);
ok('...the miss is dated on the record', !!r.file[0].missedAt && !('pendingNext' in r.file[0]), r.file[0]);
ok('...settledAt still marks the last run that completed', r.file[0].settledAt === '2026-01-01T09:00:05Z', r.file[0]);
ok('...and the operator hears about the missed occurrence, not a parked series', /hourly inbox check/.test(r.missed) && r.dead === '', r);

// an unrelated in-flight claim is left alone
r = run([{ id: 'e', status: 'firing', attempts: 1, due: '2026-01-01T00:00:00Z' }], ['other'], []);
ok('a claim nobody settled stays claimed', r.file[0].status === 'firing');

// legs: a mixed reminder remembers which leg reached its recipients
r = run([{ id: 'g', status: 'firing', attempts: 1, due: '2026-01-01T00:00:00Z', recipients: ['op', 'ann'], pendingNext: null }], [], ['g'], ['g operator']);
ok('a failed mixed reminder keeps the leg that was delivered', JSON.stringify(r.file[0].deliveredTo) === '["operator"]', r.file[0]);
r = run([{ ...r.file[0], status: 'firing', attempts: 2 }], [], ['g'], ['g teammates']);
ok('...and merges the legs across attempts', JSON.stringify([...r.file[0].deliveredTo].sort()) === '["operator","teammates"]', r.file[0]);
r = run([{ ...r.file[0], status: 'firing', attempts: 3 }], ['g'], []);
ok('...until it is delivered, when the list is dropped', r.file[0].status === 'sent' && !('deliveredTo' in r.file[0]), r.file[0]);

// ── claim ─────────────────────────────────────────────────────────────────────
const HOUR = 3600_000;
const nowMs = Date.now();
const anchor = new Date(Math.floor(nowMs / HOUR) * HOUR - HOUR);   // the previous full hour
const hourly = { id: 'h', status: 'pending', title: 'hourly', due: anchor.toISOString(), recur: { type: 'interval', every: 1, unit: 'hours' } };

r = claimRun([hourly]);
ok('a due reminder is claimed', r.file[0].status === 'firing' && r.file[0].attempts === 1 && r.wire.length === 1, r.file[0]);
ok('...the next occurrence stays on the hour', (Date.parse(r.file[0].pendingNext.due) - anchor.getTime()) % HOUR === 0, r.file[0].pendingNext);

// a retry waits for retryAt, and the anchor does not drift
r = claimRun([{ ...hourly, retryAt: new Date(nowMs + 60_000).toISOString() }]);
ok('a retry is not claimed before retryAt', r.file[0].status === 'pending' && r.wire.length === 0, r.file[0]);
r = claimRun([{ ...hourly, attempts: 1, retryAt: new Date(nowMs - 1000).toISOString(), deliveredTo: ['operator'] }]);
ok('a retry is claimed once retryAt has passed', r.file[0].status === 'firing' && r.file[0].attempts === 2, r.file[0]);
ok('...retryAt is cleared by the claim', !('retryAt' in r.file[0]), r.file[0]);
ok('...and the next occurrence is still on the original grid', (Date.parse(r.file[0].pendingNext.due) - anchor.getTime()) % HOUR === 0, r.file[0].pendingNext);
ok('...and the delivered legs ride in the 10th wire column', r.wire[0][9] === 'operator' && r.wire[0][0] === 'h', r.wire[0]);

// settle → claim round trip: after a failure the series anchor survives both passes
r = run([{ ...hourly, status: 'firing', attempts: 1, pendingNext: { due: new Date(anchor.getTime() + 2 * HOUR).toISOString(), recur: hourly.recur } }], [], ['h']);
r = claimRun([{ ...r.file[0], retryAt: new Date(nowMs - 1000).toISOString() }]);
ok('a failed-then-retried repeat keeps its grid', r.file[0].due === hourly.due && (Date.parse(r.file[0].pendingNext.due) - anchor.getTime()) % HOUR === 0, r.file[0]);

// the watermark: a repeat is told what it has already reported
r = claimRun([{ ...hourly, settledAt: '2026-01-01T09:00:05.000Z' }]);
ok('a repeat is told what it has already reported', /Only report what is new since 2026-01-01T09:00:05\.000Z/.test(r.wire[0][3]), r.wire[0][3]);
ok('...and nothing new means silence', /If nothing is new, say nothing/.test(r.wire[0][3]));
r = claimRun([{ ...hourly, settledAt: '2026-01-01T09:00:05.000Z', lastAttemptAt: '2026-01-01T09:30:00.000Z' }]);
ok('the boundary is the last SETTLE, not the last attempt', /since 2026-01-01T09:00:05/.test(r.wire[0][3]));
r = claimRun([{ id: 'o', status: 'pending', title: 'once', due: anchor.toISOString(), settledAt: '2026-01-01T09:00:05.000Z' }]);
ok('a one-shot gets no watermark (it has no previous run)', !/Only report what is new/.test(r.wire[0][3]), r.wire[0][3]);
r = claimRun([hourly]);
ok('a first run gets no watermark either (no settledAt yet)', !/Only report what is new/.test(r.wire[0][3]), r.wire[0][3]);

// ── the file cannot be read ───────────────────────────────────────────────────
writeFileSync(file, '[{"id": "x", "status": "pending"');
let res = spawnSync('node', ['-', file, '12345'], { input: claim, encoding: 'utf8' });
ok('claim: an unreadable file is said out loud (exit 3 + stderr)', res.status === 3 && /Cannot read .*no reminder fires until/.test(res.stderr), res);
ok('...and left exactly as it was', readFileSync(file, 'utf8') === '[{"id": "x", "status": "pending"');
res = spawnSync('node', ['-', file], { input: settle, encoding: 'utf8', env: { ...process.env, OK_IDS: 'x', FAIL_IDS: '' } });
ok('settle: an unreadable file is said out loud too', res.status === 3 && /Cannot read/.test(res.stderr), res);
ok('...and left exactly as it was', readFileSync(file, 'utf8') === '[{"id": "x", "status": "pending"');
ok('...with no lock left behind', !existsSync(file + '.lock'));
writeFileSync(file, '{"not": "a list"}');
res = spawnSync('node', ['-', file, '12345'], { input: claim, encoding: 'utf8' });
ok('claim: a non-list is refused the same way', res.status === 3 && readFileSync(file, 'utf8') === '{"not": "a list"}', res);

// ── settle honours the shared lock ────────────────────────────────────────────
// Another writer holds the lock, adds a reminder and lets go; settle must see
// the addition (it read inside the lock) rather than write over it.
{
  writeFileSync(file, JSON.stringify([{ id: 's', status: 'firing', attempts: 1, due: '2026-01-01T00:00:00Z', pendingNext: null }]));
  writeFileSync(file + '.lock', '');
  const other = spawn('node', ['-e', `
    const fs = require('fs'); const [file] = process.argv.slice(1);
    setTimeout(() => {
      const list = JSON.parse(fs.readFileSync(file, 'utf8'));
      list.push({ id: 'added-under-lock', status: 'pending', due: '2030-01-01T00:00:00Z' });
      fs.writeFileSync(file, JSON.stringify(list));
      fs.unlinkSync(file + '.lock');
    }, 400);`, file]);
  const t0 = Date.now();
  res = spawnSync('node', ['-', file], { input: settle, encoding: 'utf8', env: { ...process.env, OK_IDS: 's', FAIL_IDS: '' } });
  const after = readFile();
  ok('settle waits for the lock holder', Date.now() - t0 >= 350, Date.now() - t0);
  ok('...and keeps what the holder wrote', after.some(x => x.id === 'added-under-lock') && after.find(x => x.id === 's').status === 'sent', after);
  ok('...and releases the lock', !existsSync(file + '.lock'));
  other.kill();
}
{
  // A lock whose holder died long ago is broken, not waited for.
  writeFileSync(file, JSON.stringify([{ id: 't', status: 'firing', attempts: 1, due: '2026-01-01T00:00:00Z', pendingNext: null }]));
  writeFileSync(file + '.lock', '');
  const old = (Date.now() - 120_000) / 1000;
  utimesSync(file + '.lock', old, old);
  const t0 = Date.now();
  spawnSync('node', ['-', file], { input: settle, encoding: 'utf8', env: { ...process.env, OK_IDS: 't', FAIL_IDS: '' } });
  ok('a stale lock does not hold settle up', Date.now() - t0 < 3000 && readFile()[0].status === 'sent' && !existsSync(file + '.lock'));
}

// ── invoke_turn_teammates reports what did not start ─────────────────────────
// A stand-in wsapi: ann's turn starts (202 + started), bob's fails (500), a
// solo box answers 200 skipped. The shipped bash function is run as-is.
{
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const j = JSON.parse(body || '{}');
      seen.push({ actor: j.actor, turn: req.headers['x-ide-turn'], deliver: j.deliver });
      if (j.actor === 'ann') { res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, started: 'ann' })); }
      else if (j.actor === 'solo') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, skipped: 'solo' })); }
      else { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'boom' })); }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const fn = script.slice(script.indexOf('\ninvoke_turn_teammates() {'), script.indexOf('\n}\n', script.indexOf('\ninvoke_turn_teammates() {')) + 3);
  const prelude = `log() { echo "$*" >&2; }
turn_header() { printf 'X-IDE-Turn: test-token'; }
operator_in_set() { [ "$1" = "op" ]; }
WSAPI_PORT=${port}
`;
  // Asynchronous on purpose: the stand-in server lives in this process and
  // has to keep answering while bash runs.
  const call = (...args) => new Promise((resolve) => {
    const p = spawn('bash', ['-c', `${prelude}${fn}\ninvoke_turn_teammates "$@"`, 'bash', ...args]);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (rc) => resolve({ rc, err }));
  });
  const bashOk = spawnSync('bash', ['-n', '-c', fn]).status === 0;
  if (!bashOk) console.log('  (bash cannot parse the extracted function here; fan-out checks skipped)');
  if (bashOk) {
    ok('one teammate whose turn started → 0', (await call('ann', 'do the thing', '2', 'all', 'T', 'now')).rc === 0);
    ok('...with the monitor token on the call and the deliver block for a planner duty',
      seen[0]?.turn === 'test-token' && seen[0]?.deliver?.title === 'T', seen[0]);
    ok('a teammate whose turn did not start → non-zero', (await call('bob', 'x', '1')).rc !== 0);
    seen.length = 0;
    const mixed = await call('ann,bob', 'x', '1');
    ok('one failure among several → non-zero, every slug still tried', mixed.rc !== 0 && seen.map(s => s.actor).sort().join() === 'ann,bob', { mixed, seen });
    ok('...and the failed slug is named in the log', /bob/.test(mixed.err) && /did not start/.test(mixed.err), mixed.err);
    ok('a solo "skipped" answer is not a started turn', (await call('solo', 'x', '1')).rc !== 0);
    seen.length = 0;
    ok('the operator is skipped (fire_operator runs their leg)', (await call('op,ann', 'x', '1')).rc === 0 && seen.map(s => s.actor).join() === 'ann', seen);
    seen.length = 0;
    ok('everyone → nothing to do here, not a failure', (await call('*everyone*', 'x', '1')).rc === 0 && seen.length === 0);
    server.close();
    const down = await call('ann', 'x', '1');
    ok('wsapi unreachable → non-zero', down.rc !== 0 && /unreachable/.test(down.err), down);
  } else server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
