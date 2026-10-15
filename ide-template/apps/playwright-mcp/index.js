#!/usr/bin/env node
/**
 * Playwright MCP, started through mcp-runner so the browser runs as the mcp
 * user (uid 1002) — the one user allowed out through the open egress listener
 * (egress-proxy:3130; entrypoint's iptables owner rule). The flags are the
 * ones the bot's config used to carry directly; stdio is passed through, so
 * the CLI talks to the real server as before.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const BIN = ['/home/coder/.npm-global/bin/playwright-mcp', '/usr/local/bin/playwright-mcp'].find((p) => existsSync(p));
if (!BIN) { process.stderr.write('[playwright-mcp] the playwright-mcp launcher was not found\n'); process.exit(1); }

const args = [
  '--headless',
  '--browser', 'chrome',
  // The zygote sandbox needs user namespaces the container does not have;
  // the uid split is the boundary here.
  '--no-sandbox',
  '--user-data-dir', process.env.PLAYWRIGHT_USER_DATA_DIR || '/tmp/playwright-mcp-data',
  '--proxy-server', process.env.PLAYWRIGHT_PROXY || 'http://egress-proxy:3130',
  '--executable-path', process.env.PLAYWRIGHT_CHROME || '/opt/playwright-browsers/chromium-1223/chrome-linux64/chrome',
];
const child = spawn(BIN, args, { stdio: 'inherit', env: { ...process.env, HOME: '/home/mcp' } });
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { try { child.kill(sig); } catch {} });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on('error', (err) => { process.stderr.write(`[playwright-mcp] ${err.message}\n`); process.exit(1); });
