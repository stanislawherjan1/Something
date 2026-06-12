/**
 * Wrapper around the official github/github-mcp-server Go binary.
 *
 * Why a wrapper at all:
 *   1. Catalog's mcp.command/args is static — we can't conditionally append
 *      `--read-only` or `--toolsets` based on user-supplied fields.
 *   2. Phase-2 MCPs fetch credentials from the broker via UDS at startup
 *      (see apps/_shared/broker-client.js). The Go binary doesn't know how
 *      to do that. We call the broker here, populate process.env with the
 *      decrypted PAT, then exec the Go binary which reads
 *      GITHUB_PERSONAL_ACCESS_TOKEN from env like normal.
 *
 * The Go binary lives alongside this file at ./github-mcp-server (downloaded
 * in the Dockerfile, pinned to a release tag — see Dockerfile for version).
 *
 * Toggles:
 *   GITHUB_ALLOW_WRITE — "yes" enables write tools; anything else (or unset)
 *                       runs the server with --read-only. Read-only mode is
 *                       a hard security filter in the upstream server: write
 *                       tools are stripped even if a toolset enables them.
 *   GITHUB_TOOLSETS    — comma-separated toolset list (repos, issues,
 *                       pull_requests, actions, code_security, …). Defaults
 *                       to the upstream default if unset (context, issues,
 *                       pull_requests, repos, users).
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadCredentials } from '../_shared/broker-client.js';

const here = dirname(fileURLToPath(import.meta.url));
const BINARY = join(here, 'github-mcp-server');

try {
  await loadCredentials();
} catch (err) {
  process.stderr.write(`[github-mcp] broker call failed: ${err.message}\n`);
  process.exit(1);
}

if (!process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
  process.stderr.write('[github-mcp] GITHUB_PERSONAL_ACCESS_TOKEN missing after broker call — refusing to start\n');
  process.exit(1);
}

const args = ['stdio'];

const allowWrite = String(process.env.GITHUB_ALLOW_WRITE || '').toLowerCase() === 'yes';
if (!allowWrite) args.push('--read-only');

const toolsets = (process.env.GITHUB_TOOLSETS || '').trim();
if (toolsets) args.push('--toolsets', toolsets);

const child = spawn(BINARY, args, { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on('error', (err) => {
  process.stderr.write(`[github-mcp] failed to spawn ${BINARY}: ${err.message}\n`);
  process.exit(1);
});
