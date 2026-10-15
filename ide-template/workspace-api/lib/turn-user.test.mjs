/**
 * A turn is started through turn-runner when the runner is there (the
 * container), directly otherwise (dev), and never carries the server's own
 * secrets in its environment — only the CLI's credential and the per-turn
 * identity values. Run: node lib/turn-user.test.mjs
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'turn-user-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'turn-user-store-'));
const RUNNER = join(ROOT, 'turn-runner');
process.env.TURN_RUNNER_BIN = RUNNER;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const { turnCommand, turnEnv } = await import('./claude.js');

let c = turnCommand(['-p', '--model', 'x']);
ok('without the runner the CLI is started directly', c.bin !== RUNNER && c.args.join(' ') === '-p --model x', c);
writeFileSync(RUNNER, '#!/bin/sh\n');
c = turnCommand(['-p', '--model', 'x']);
ok('with the runner, the runner is started with the slot first, then the same arguments', c.bin === RUNNER && c.args.join(' ') === 'solo -p --model x', c);
c = turnCommand(['-p'], '07');
ok('...the slot being the person\'s', c.args.join(' ') === '07 -p', c);

const env = turnEnv({
  PATH: '/usr/bin', HOME: '/home/coder', PROJECT_DIR: ROOT, WORKSPACE_API_PORT: '3001', NODE_ENV: 'production',
  CLAUDE_CODE_OAUTH_TOKEN: 'cli-credential', IDE_TURN_ID: 'turn-id', IDE_TAB_TOKEN: 'tab', IDE_ACTOR_SLUG: 'ann',
  SESSION_SECRET: 's', GOOGLE_CLIENT_SECRET: 'g', META_ACCESS_TOKEN: 'm', SHOPIFY_CLIENT_SECRET: 'sh', INTEGRATIONS_KEY: 'k',
  EMAIL_PASSWORD: 'p', SOME_API_KEY: 'a', PRIVATE_THING: 'x', MY_CREDENTIALS: 'c',
  CLAUDE_CONFIG_PATH: '/home/bot/.claude.json',
});
ok('the bot\'s config path does not reach the turn (its config is its own home\'s)', !('CLAUDE_CONFIG_PATH' in env));
ok('the CLI credential and the turn identity stay', env.CLAUDE_CODE_OAUTH_TOKEN === 'cli-credential' && env.IDE_TURN_ID === 'turn-id' && env.IDE_TAB_TOKEN === 'tab' && env.IDE_ACTOR_SLUG === 'ann');
ok('ordinary settings stay', env.PATH && env.HOME && env.PROJECT_DIR && env.WORKSPACE_API_PORT && env.NODE_ENV);
for (const k of ['SESSION_SECRET', 'GOOGLE_CLIENT_SECRET', 'META_ACCESS_TOKEN', 'SHOPIFY_CLIENT_SECRET', 'INTEGRATIONS_KEY', 'EMAIL_PASSWORD', 'SOME_API_KEY', 'PRIVATE_THING', 'MY_CREDENTIALS']) {
  ok(`${k} does not reach the turn`, !(k in env));
}

console.log(`turn-user: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
