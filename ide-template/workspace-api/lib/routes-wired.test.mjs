/**
 * Guard: a feature is not shipped until something can REACH it.
 *
 * This exists because of a real miss. lib/memory-sweep.js, sayInGroup() and the
 * Telegram repair helpers were all written, imported, tested and deployed —
 * while the three routes that expose them silently failed to get added. The
 * unit tests passed the whole time, because they assert on the lib functions
 * rather than on anything that can actually call them, so a fully working
 * feature shipped with no way in.
 *
 * These assertions are deliberately dumb: for each capability, the module
 * exists AND a route mounts it AND (where it runs on a timer) something pokes
 * it. Cheap, and it catches the exact failure that got past everything else.
 *
 * Run: node lib/routes-wired.test.mjs   (wired into `npm test`)
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${extra}` : ''}`); }
};

const internal = readFileSync(new URL('../routes/internal.js', import.meta.url), 'utf8');
const memory   = readFileSync(new URL('../routes/memory.js', import.meta.url), 'utf8');
const monitor  = readFileSync(new URL('../../bot/recent-snapshot-monitor.sh', import.meta.url), 'utf8');
const mcp      = readFileSync(new URL('../../apps/workspace-api-mcp/index.js', import.meta.url), 'utf8');

const route = (file, method, path) =>
  new RegExp(`router\\.${method}\\('${path.replace(/\//g, '\\/')}'`).test(file);

// The memory engine: the model writes through a tool, which posts to a route.
ok('memory_write tool exists', /name: 'memory_write'/.test(mcp));
ok('...and something serves it', route(internal, 'post', '/internal/memory-write'));
ok('memory_log tool exists', /name: 'memory_log'/.test(mcp));
ok('...and something serves it', route(internal, 'get', '/internal/memory-log'));

// The safety net runs on a timer, so it needs BOTH a route and a caller.
ok('the sweep is mounted', route(internal, 'post', '/internal/memory-sweep'));
ok('...and the monitor actually pokes it', /internal\/memory-sweep/.test(monitor));
ok('...and the module it calls exists', /from '\.\.\/lib\/memory-sweep\.js'/.test(internal));

// Group outbound + self-repair: reachable, or the bot still cannot speak first
// or clean up after itself.
ok('the group can be spoken into', route(internal, 'post', '/internal/group-say'));
ok('...via the group-watcher export', /sayInGroup/.test(internal));
ok('the bot can repair its own message', route(internal, 'post', '/internal/telegram-repair'));
ok('...and a tool reaches that route', /name: 'fix_sent_message'/.test(mcp) && /telegram-repair/.test(mcp));

// The write feed the dashboard reads.
ok('the memory change feed is mounted', route(memory, 'get', '/memory/changes'));
ok('undo is mounted', route(memory, 'post', '/memory/revert'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
