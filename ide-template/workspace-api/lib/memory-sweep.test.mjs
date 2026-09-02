/**
 * Guards for the memory safety net.
 *
 * What it exists to stop: the bot is ambient in a group and says nothing to most
 * messages, so two people can settle a decision, the bot can correctly stay out
 * of it, and the fact reaches no memory at all. The live model cannot cover that
 * case — a silent turn writes nothing, and most group traffic never wakes it.
 *
 * What it must NOT become: the background pipeline that was deleted. It may only
 * add; the scope of what it writes is decided in CODE by the kind of
 * conversation, never by the model; and it must not re-sweep the same quiet
 * window.
 *
 * Run: node lib/memory-sweep.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'mem-sweep-'));
process.env.PROJECT_DIR = ROOT;
process.env.TELEGRAM_LOG_PATH = join(ROOT, 'telegram.jsonl');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}`); }
};

const sweep = await import('./memory-sweep.js');

// A conversation that fell quiet 30 minutes ago.
const QUIET = Date.now() - 30 * 60_000;
const aged = (p) => utimesSync(p, new Date(QUIET), new Date(QUIET));

// The sweep only looks at REGISTERED groups — an unregistered chat the bot was
// added to must not have its transcript mined. Register one for the test.
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({
  teamMode: true,
  groups: { '-1001234': { title: 'Team', addedAt: '2026-09-01T00:00:00Z' } },
}));

mkdirSync(join(ROOT, '.group-watcher'), { recursive: true });
mkdirSync(join(ROOT, '.team', 'users', 'sam', 'chats'), { recursive: true });
mkdirSync(join(ROOT, 'memory', '_engine'), { recursive: true });

const groupLog = join(ROOT, '.group-watcher', '-1001234-history.jsonl');
writeFileSync(groupLog, [
  JSON.stringify({ ts: '2026-09-02T10:00:00Z', role: 'user', who: 'Marek', text: 'budget approved at 40k' }),
  JSON.stringify({ ts: '2026-09-02T10:01:00Z', role: 'user', who: 'Kasia', text: 'noted' }),
  JSON.stringify({ ts: '2026-09-02T10:02:00Z', role: 'user', who: 'Marek', text: 'starting Monday' }),
].join('\n') + '\n');
aged(groupLog);

const webLog = join(ROOT, '.team', 'users', 'sam', 'chats', 's1.jsonl');
writeFileSync(webLog, [
  JSON.stringify({ ts: '2026-09-02T09:00:00Z', role: 'user', text: 'hello' }),
  JSON.stringify({ ts: '2026-09-02T09:01:00Z', role: 'assistant', text: 'hi' }),
  JSON.stringify({ ts: '2026-09-02T09:02:00Z', role: 'user', text: 'ok' }),
].join('\n') + '\n');
aged(webLog);

// ─── (a) the sources a quiet moment produces ─────────────────────────────────
let sources = sweep.idleSources();
const kinds = sources.map(s => s.kind);
ok('a quiet GROUP is a sweep source — the case nothing else covers', kinds.includes('group'), kinds);
ok('a quiet web conversation is a source too', kinds.includes('web'), kinds);
ok('a group source carries no owner (group content is team-wide)',
  sources.find(s => s.kind === 'group')?.owner === null);

// An unregistered chat must never be mined, however chatty it is.
writeFileSync(join(ROOT, '.group-watcher', '-9999999-history.jsonl'),
  JSON.stringify({ ts: '2026-09-02T10:00:00Z', role: 'user', who: 'X', text: 'private club talk' }) + '\n');
aged(join(ROOT, '.group-watcher', '-9999999-history.jsonl'));
ok('an UNREGISTERED group is never swept',
  !sweep.idleSources().some(s => s.id === 'group:-9999999'));

// A conversation still in progress must be left alone: sweeping mid-thread
// would read half a decision.
writeFileSync(groupLog, readFileSync(groupLog, 'utf8') + JSON.stringify({ ts: 'now', role: 'user', who: 'Marek', text: 'one more thing' }) + '\n');
ok('a LIVE conversation is not swept', !sweep.idleSources().some(s => s.kind === 'group'));
aged(groupLog);

// ─── (b) the gate's durable flag orders the queue, never gates it ────────────
writeFileSync(join(ROOT, '.group-watcher', '-1001234-durable'), String(Date.now()));
sources = sweep.idleSources();
ok('a group the gate flagged as durable is looked at first', sources[0]?.kind === 'group', sources.map(s => s.id));
ok('...but an unflagged conversation is still in the queue, not dropped',
  sources.some(s => s.kind === 'web'));

// ─── (c) one quiet window gets one pass ─────────────────────────────────────
writeFileSync(join(ROOT, 'memory', '_engine', '.swept.json'),
  JSON.stringify(Object.fromEntries(sources.map(s => [s.id, s.mtime]))));
ok('an already-swept window is not swept again', sweep.idleSources().length === 0);
writeFileSync(join(ROOT, 'memory', '_engine', '.swept.json'), '{}');

// ─── (d) the kill switch ────────────────────────────────────────────────────
const before = process.env.MEMORY_SWEEP;
process.env.MEMORY_SWEEP = '0';
const off = await (await import('./memory-sweep.js?off=1')).sweepIdle();
ok('MEMORY_SWEEP=0 turns the whole thing off', off.skipped === 'disabled', off);
if (before === undefined) delete process.env.MEMORY_SWEEP; else process.env.MEMORY_SWEEP = before;

// ─── (e) the contract with the engine ───────────────────────────────────────
// The sweep reads a transcript AFTER the fact. It is the worst possible basis
// for overwriting a claim somebody made deliberately, so it may only ever add.
const src = readFileSync(new URL('./memory-sweep.js', import.meta.url), 'utf8');
ok('the sweep never supersedes or retires', !/\bsupersede\s*\(|\bretire\s*\(/.test(src));
ok('the sweep writes only through the engine', /from '\.\/memory-engine\.js'/.test(src));
ok('scope is decided in code from the conversation kind, not by the model',
  /src\.kind === 'group' \? 'shared'/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
