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
import { readFileSync, existsSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${extra}` : ''}`); }
};

const internal = readFileSync(new URL('../routes/internal.js', import.meta.url), 'utf8');
const memory   = readFileSync(new URL('../routes/memory.js', import.meta.url), 'utf8');
const monitor  = readFileSync(new URL('../../bot/recent-snapshot-monitor.sh', import.meta.url), 'utf8');
const mcp      = readFileSync(new URL('../../apps/workspace-api-mcp/index.js', import.meta.url), 'utf8');
const tab      = readFileSync(new URL('../routes/tab.js', import.meta.url), 'utf8');
const claude   = readFileSync(new URL('./claude.js', import.meta.url), 'utf8');
const chat     = readFileSync(new URL('../routes/chat.js', import.meta.url), 'utf8');
const memV4    = readFileSync(new URL('../routes/memory-v4.js', import.meta.url), 'utf8');
const deploySh = readFileSync(new URL('../../deploy.sh', import.meta.url), 'utf8');
const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
const index    = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const migRoutes = readFileSync(new URL('../routes/migrations.js', import.meta.url), 'utf8');

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
ok('the v4 consolidator is mounted', route(internal, 'post', '/internal/memory/consolidate'));
ok('...and the monitor pokes it too', /internal\/memory\/consolidate/.test(monitor));

// Memory v4 tools: each one listed, served, and hidden until v4 reading is on.
for (const [tool, method, path] of [['memory_search', 'get', '/internal/memory/v4/search'], ['memory_timeline', 'get', '/internal/memory/v4/timeline'], ['memory_note', 'post', '/internal/memory/v4/note'], ['memory_forget', 'post', '/internal/memory/v4/forget']]) {
  ok(`${tool} tool exists`, new RegExp(`name: '${tool}'`).test(mcp));
  ok(`...and something serves it`, route(memV4, method, path));
}
ok('the v4 router is mounted', /app\.use\('\/api', memoryV4Router\(\)\)/.test(index));
for (const [method, path] of [['get', '/memory/v4/changes'], ['get', '/memory/v4/topics/:key/timeline'], ['post', '/memory/v4/topics/:key/who']]) {
  ok(`memory screen: ${method.toUpperCase()} ${path} is served`, route(memV4, method, path));
}
// What the image needs and deploy.sh must upload — a missing directory here
// boots an image with no migrations and no embedder, and nothing says so.
ok('deploy.sh uploads the migrations', /mirror_dir workspace-api\/migrations/.test(deploySh));
ok('deploy.sh uploads the migrate CLI', /mirror_dir workspace-api\/bin/.test(deploySh));
ok('deploy.sh uploads the embedder worker', /apps\/embedder\/worker\.mjs/.test(deploySh));
ok('the image installs the embedder and its model', /COPY apps\/embedder/.test(dockerfile) && /COPY models \/opt\/ide\/models/.test(dockerfile));
ok('the migrations router is mounted', /app\.use\('\/api', migrationsRouter\(\)\)/.test(index));
for (const [method, path] of [['get', '/migrations/status'], ['post', '/migrations/:id/start'], ['get', '/migrations/:id/job'], ['get', '/memory/backup']]) {
  ok(`migrations: ${method.toUpperCase()} ${path} is served`, route(migRoutes, method, path));
}
ok('the Routines screen can place an unparsed line', route(memV4, 'post', '/routines/unparsed'));
ok('the card sort migration ships', existsSync(new URL('../migrations/0006-cards-v4.mjs', import.meta.url)));
ok('memory v4 maintenance is started at boot', /startMemoryMaintenance\(\)/.test(index));
ok('the v4 tools are offered only with MEMORY_V4=read|on', /MEMORY_V4_TOOLS && !PAGE_TURN \? V4_TOOLS/.test(mcp));

// Group outbound + self-repair: reachable, or the bot still cannot speak first
// or clean up after itself.
ok('the group can be spoken into', route(internal, 'post', '/internal/group-say'));
ok('...via the group-watcher export', /sayInGroup/.test(internal));
ok('the bot can repair its own message', route(internal, 'post', '/internal/telegram-repair'));
ok('...and a tool reaches that route', /name: 'fix_sent_message'/.test(mcp) && /telegram-repair/.test(mcp));

// The write feed the dashboard reads.
ok('the memory change feed is mounted', route(memory, 'get', '/memory/changes'));
ok('undo is mounted', route(memory, 'post', '/memory/revert'));

// The browser panel's hand-off to the integrations: the tool, the route behind
// it, the flag that lists the tool in an Act turn, and the record it reads.
ok('use_integrations tool exists', /name: 'use_integrations'/.test(mcp));
ok('...and something serves it', route(tab, 'post', '/internal/tab-handoff'));
ok('...and a page turn is flagged so the tool is listed', /IDE_PAGE_TURN = '1'/.test(claude));
ok('the extension\'s command key is served', route(tab, 'post', '/tab/panel-key'));
ok('...and every command is signed with it', /sig: signCommand\(slug, cmd\)/.test(tab));
ok('...and the panel turn hands it the user\'s message and the tab', /openTabTurn\(req\.chatActor, \{[\s\S]*?message,[\s\S]*?url:/.test(chat));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
