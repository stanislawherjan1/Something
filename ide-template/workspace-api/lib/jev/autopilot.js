/**
 * The Jev autopilot: one goal, many steps, on the user's browser tab.
 *
 * Spawns lib/jev/runner.py — jev-ultrafast's policy (TypeSafe's Jev picks
 * each operation and target) around our executor — and answers its requests
 * by running commands on the tab through routes/tab.js sendTabCommand, so every
 * action gets the same checks as the assistant's own tab_act, and the
 * extension's Act limits on top. The TypeSafe key is decrypted by the caller and
 * lives only in the runner's environment for the run.
 *
 *   runner → { op: 'observe' }          → exec({ op: 'observe' })               → { ok, state }
 *   runner → { op: 'act', id, text }    → exec({ op: 'act', target, text, raw }) → { ok, state }
 *   runner → { event: 'step', … }       → onStep(step)
 *   runner → { result: { status, detail } }
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'runner.py');
const PYTHON = process.env.JEV_PYTHON || 'python3';
const RUN_TIMEOUT_MS = 90_000;
const MAX_ACTIONS = 30;

// Only what the runner needs: its key, where the library is, and the egress
// proxy settings so api.typesafe.ai goes through the allow-list like
// everything else.
function runnerEnv(apiKey) {
  const env = { TYPESAFE_API_KEY: apiKey, PYTHONUNBUFFERED: '1' };
  for (const k of ['PATH', 'HOME', 'LANG', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
    'JEV_ULTRAFAST_DIR', 'TYPESAFE_MODEL', 'SSL_CERT_FILE']) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return env;
}

export function runAutopilot({ goal, values = {}, apiKey, exec, onStep = () => {}, maxActions = MAX_ACTIONS }) {
  const started = Date.now();
  const steps = [];
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      resolve({ ...result, steps, ms: Date.now() - started });
    };

    const child = spawn(PYTHON, [RUNNER], { env: runnerEnv(apiKey), stdio: ['pipe', 'pipe', 'pipe'] });
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

    write({ goal, values, max_actions: maxActions });
  });
}
