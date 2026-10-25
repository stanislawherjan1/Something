/**
 * The Telegram plugin patcher in bot/bot.sh, run the way bot.sh runs it, on a
 * small stand-in for the plugin's server.ts: patching a clean copy again and
 * again must leave exactly one /start handler, uncommented, and one copy of
 * each injected block. (A production bot once carried a copy whose /start line
 * had been commented out eleven times by older strips — the plugin did not
 * start and Telegram was silent for three days. bot.sh now restores the
 * image's clean source before every patch run; this guards the patcher
 * itself, and that a clean copy always patches the same way.) Needs python3; skipped without it.
 *
 * Run: node lib/telegram-plugin-patch.test.mjs   (wired into `npm test`)
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${String(extra).slice(0, 400)}` : ''}`); } };

if (spawnSync('python3', ['--version']).status !== 0) {
  console.log('telegram-plugin-patch: python3 not available, skipped');
  process.exit(0);
}

const botSh = readFileSync(new URL('../../bot/bot.sh', import.meta.url), 'utf8');
const m = botSh.match(/python3 - "\$PLUGIN_SERVER" <<'PYEOF'\n([\s\S]*?)\nPYEOF/);
ok('the patcher is found in bot.sh', !!m);
const dir = mkdtempSync(join(tmpdir(), 'tg-patch-'));
writeFileSync(join(dir, 'patch.py'), m ? m[1] : '');

// A stand-in with the anchors the patches look for (not the real plugin).
const stub = [
  "import { Bot } from 'grammy'",
  "const PID_FILE = '/tmp/x.pid'",
  'const bot = new Bot(TOKEN)',
  '',
  "bot.on('message', async ctx => { await handleInbound(ctx) })",
  '',
  '// Commands are DM-only.',
  '',
  "bot.command('start', async ctx => {",
  "  await ctx.reply('hello')",
  '})',
  '',
  "bot.command('help', async ctx => {",
  "  await ctx.reply('help')",
  '})',
  '',
  "bot.on('message:text', async ctx => { await handleInbound(ctx) })",
  '',
  'await bot.start({ onStart: () => {} })',
  '',
].join('\n');
const file = join(dir, 'server.ts');
writeFileSync(file, stub);

const run = () => spawnSync('python3', [join(dir, 'patch.py'), file], { encoding: 'utf8', env: { ...process.env, TELEGRAM_ADMIN_CHAT_ID: '1' } });
let r = run();
ok('the patcher runs', r.status === 0, r.stderr);
const once = readFileSync(file, 'utf8');
for (let i = 0; i < 4; i++) run();
const many = readFileSync(file, 'utf8');

const startLines = many.split('\n').filter(l => /bot\.command\(['"]start['"]/.test(l));
ok('after five runs there is exactly one /start handler', startLines.length === 1, startLines.join(' | '));
ok('...and it is not commented out', startLines.length === 1 && /^bot\.command\(/.test(startLines[0]), startLines[0]);
ok('the /restart block is injected once, not once per run', (many.match(/CC-BOT-PATCH: restart command v3/g) || []).length === 1);
// Re-patching an already patched copy moves the injected blocks around (their
// order is middleware order) and adds blank lines, which is why bot.sh patches
// the image's clean source on every start: a clean copy patches the same way.
writeFileSync(file, stub); run();
ok('a clean copy patches to the same result every time (what bot.sh does on each start)', readFileSync(file, 'utf8') === once);
let depth = 0, min = 0;
for (const c of many.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`|\/\/[^\n]*/g, '')) { if (c === '{') depth++; else if (c === '}') { depth--; min = Math.min(min, depth); } }
ok('braces still balance (no handler left without its head)', depth === 0 && min >= 0, `depth ${depth}, min ${min}`);

console.log(`telegram-plugin-patch: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
