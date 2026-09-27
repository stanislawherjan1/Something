/**
 * The Jev autopilot: one goal, many steps, on the user's browser tab.
 *
 * Spawns the runner (apps/jev-runner/runner.py — jev-ultrafast's policy, where
 * TypeSafe's Jev picks each operation and target, around our executor) through
 * the setuid wrapper /usr/local/bin/jev-runner, so that third-party code runs
 * as the mcp user like every integration's MCP — never as this process's user,
 * which can decrypt every integration's keys. The TypeSafe key is sent on the
 * runner's stdin (not in its environment). Its requests are answered by running
 * commands on the tab through routes/tab.js sendTabCommand, so every action
 * gets the same checks as the assistant's own tab_act and the extension's Act
 * limits on top.
 *
 *   runner → { op: 'observe' }          → exec({ op: 'observe' })               → { ok, state }
 *   runner → { op: 'act', id, text }    → exec({ op: 'act', target, text, raw }) → { ok, state }
 *   runner → { event: 'step', … }       → onStep(step)
 *   runner → { result: { status, detail } }
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// In the container: the setuid wrapper (fixed script, uid mcp). JEV_PYTHON is
// for local development and tests only: run the repo's runner directly.
const WRAPPER = '/usr/local/bin/jev-runner';
const DEV_RUNNER = join(dirname(fileURLToPath(import.meta.url)), '../../../apps/jev-runner/runner.py');
const RUN_TIMEOUT_MS = 120_000;
const MAX_ACTIONS = 40;

// No secret in the environment: the wrapper rebuilds it from its own
// allow-list (egress proxy settings, locale) anyway.
function runnerEnv() {
  const env = { PYTHONUNBUFFERED: '1' };
  for (const k of ['PATH', 'HOME', 'LANG', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
    'JEV_ULTRAFAST_DIR', 'TYPESAFE_MODEL', 'SSL_CERT_FILE']) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return env;
}

export function runAutopilot({ goal, values = {}, context = '', today = '', apiKey, exec, onStep = () => {}, onDecision = () => {}, maxActions = MAX_ACTIONS }) {
  const started = Date.now();
  const steps = [];
  let decisions = 0;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      resolve({ ...result, steps, decisions, ms: Date.now() - started });
    };

    const child = process.env.JEV_PYTHON
      ? spawn(process.env.JEV_PYTHON, [DEV_RUNNER], { env: runnerEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(WRAPPER, [], { env: runnerEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => finish({ status: 'timeout', detail: `Stopped after ${RUN_TIMEOUT_MS / 1000} s.` }), RUN_TIMEOUT_MS);
    const write = (obj) => { try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* closed */ } };
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString('utf8')).slice(-2000); });
    child.on('error', (err) => finish({ status: 'error', detail: `The autopilot could not start (${err.message}).` }));
    child.on('exit', (code) => finish({ status: 'error', detail: `The autopilot stopped unexpectedly (exit ${code}). ${stderr.trim().split('\n').pop() || ''}`.trim() }));

    // One request at a time: the runner waits for each answer.
    let buf = '';
    let queue = Promise.resolve();
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        queue = queue.then(() => handle(msg));
      }
    });

    async function handle(msg) {
      if (settled) return;
      if (msg.result) return finish(msg.result);
      if (msg.event === 'decision') {
        decisions += 1;
        onDecision(msg);
        return;
      }
      if (msg.event === 'step') {
        const step = { n: msg.n, kind: msg.kind, label: String(msg.label || '').slice(0, 120) };
        steps.push(step);
        onStep(step);
        return;
      }
      if (msg.op === 'observe') {
        const r = await exec({ op: 'observe' });
        return write(r.ok ? { ok: true, state: r.result?.state } : { ok: false, error: r.error });
      }
      if (msg.op === 'act') {
        const r = await exec({ op: 'act', target: String(msg.id || ''), text: typeof msg.text === 'string' ? msg.text : undefined, raw: true });
        return write(r.ok ? { ok: true, state: r.result?.state || null } : { ok: false, error: r.error });
      }
    }

    write({ goal, values, context, today, max_actions: maxActions, key: apiKey });
  });
}
