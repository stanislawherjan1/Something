/**
 * bot-inject — fire a pre-composed literal line into the operator bot's tmux
 * session via the setuid monitor-runner + bot-relay.sh (BOT_INJECT_LITERAL
 * mode). This is the SAME proven primitive reminders use (tmux send-keys -l),
 * so a teammate relay can be surfaced to the operator's brain IN ITS LIVE
 * CONTEXT — framed, attributed, thread-keyed — instead of arriving as a flat
 * Telegram message the identity-blind brain has to reconstruct intent from.
 *
 * Never rejects: resolves { injected, code, reason }. code 2 = bot tmux offline
 * (the caller's raw Telegram send already delivered the durable copy, so this is
 * a non-fatal enhancement that simply didn't apply this time).
 */

import { spawn } from 'node:child_process';

const RUNNER = '/usr/local/bin/monitor-runner';
const SCRIPT = '/opt/ide/bot-relay.sh';

export function injectBotFrame(literal, { timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const text = String(literal == null ? '' : literal);
    if (!text.trim()) return resolve({ injected: false, code: -1, reason: 'empty' });

    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };

    let child;
    try {
      child = spawn(RUNNER, [SCRIPT], {
        env: { ...process.env, BOT_INJECT_LITERAL: text },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (err) {
      return finish({ injected: false, code: -1, reason: err.message });
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ injected: false, code: -1, reason: 'timeout' });
    }, timeoutMs);

    let stderr = '';
    child.stderr?.on('data', (c) => { stderr += c.toString(); });
    child.on('error', (err) => { clearTimeout(timer); finish({ injected: false, code: -1, reason: err.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ injected: code === 0, code, reason: stderr.trim().slice(0, 200) });
    });
  });
}
