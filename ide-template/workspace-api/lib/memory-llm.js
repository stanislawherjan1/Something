/**
 * memory-llm — one structured call to a small model, for memory's background work
 * (routing, notes, reviews, the digest).
 *
 * Runs `claude -p` with no tools (unless a caller names built-in ones), no MCP
 * servers, no settings and no session, and
 * validates the answer against a JSON schema (`--json-schema` → `structured_output`,
 * available on the pinned CLI). The conversation text it reads is untrusted; with
 * no tools there is nothing an instruction inside it could make the call do.
 *
 * Tests swap the transport with `configureRunner`, so no suite ever calls a model.
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

import { CLAUDE_BIN } from './config.js';
import { hasClaudeToken, readClaudeToken } from './setup.js';

export const MEMORY_MODEL = process.env.MEMORY_V4_MODEL || 'claude-haiku-4-5-20251001';
// The one judgment that must not be cheap: whether a new note repeats, extends,
// corrects, supersedes or has nothing to do with a fact memory holds. It runs a
// few times a night and on memory_note, so a stronger model costs little.
export const DECIDE_MODEL = process.env.MEMORY_V4_DECIDE_MODEL || 'claude-sonnet-5-5';
const TIMEOUT_MS = Number(process.env.MEMORY_V4_LLM_TIMEOUT_MS) || 120_000;

let override = null;

/** Replace the transport (tests). `fn({system, user, schema, model}) → object`, or null to restore. */
export function configureRunner(fn) { override = fn; }

// `tools`: the built-in tools the call may use — none by default. Onboarding's
// look-up allows WebSearch alone (it runs on Anthropic's side; nothing else opens).
function viaCli({ system, user, schema, model, timeoutMs = TIMEOUT_MS, tools = [] }) {
  return new Promise((resolve, reject) => {
    // No auto-memory either: with cwd in /tmp the CLI kept a MEMORY.md there and
    // fed it to every call — someone else's notes in front of the sorter.
    const env = { ...process.env, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
    // Not for a call that may search: with it set, WebSearch's request goes out
    // with thinking disabled, the API refuses it (400) and the model reports
    // "nothing found" — a silent empty look-up.
    if (!tools.length) env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    if (!env.CLAUDE_CODE_OAUTH_TOKEN && hasClaudeToken()) {
      try { env.CLAUDE_CODE_OAUTH_TOKEN = readClaudeToken(); } catch { /* fall through */ }
    }
    let proc;
    try {
      proc = spawn(CLAUDE_BIN, [
        '-p', '--model', model, '--tools', tools.join(','), ...(tools.length ? ['--allowedTools', tools.join(',')] : []),
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--no-session-persistence', '--setting-sources', '', '--system-prompt', system,
        '--output-format', 'json', '--json-schema', JSON.stringify(schema),
      ], { stdio: ['pipe', 'pipe', 'pipe'], env, cwd: tmpdir() });
    } catch (err) { return reject(new Error(`spawn: ${err.message}`)); }
    let out = '', err = '', done = false;
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); try { proc.kill('SIGKILL'); } catch { /* gone */ } fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error('timeout'))), timeoutMs);
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { err += c; });
    proc.on('error', (e) => finish(() => reject(e)));
    proc.on('close', () => finish(() => {
      let d;
      try { d = JSON.parse(out); } catch { return reject(new Error(`unparseable output: ${out.slice(0, 200)} ${err.slice(0, 200)}`)); }
      if (d.is_error || d.structured_output == null) return reject(new Error(`model call failed: ${d.subtype || ''} ${String(d.result || '').slice(0, 200)}`));
      resolve(d.structured_output);
    }));
    proc.stdin.end(user);
  });
}

/**
 * One structured call; a failed call is retried once — but not a timeout:
 * a model that took the whole budget once takes it again, and the retry
 * doubled every wait (a note the assistant saved mid-turn once ran for five
 * minutes and the tool gave up). Throws when the attempts fail. How long a
 * call took is logged when it failed or was slow, so a slow night shows why.
 */
export async function runStructured({ system, user, schema, model = MEMORY_MODEL, timeoutMs, tools = [] }) {
  const call = override || viaCli;
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    try {
      const out = await call({ system, user, schema, model, timeoutMs, tools });
      const took = Date.now() - t0;
      if (took > SLOW_MS) process.stderr.write(`[memory-llm] slow: ${model} answered in ${Math.round(took / 1000)} s\n`);
      return out;
    } catch (e) {
      last = e;
      process.stderr.write(`[memory-llm] ${model} failed after ${Math.round((Date.now() - t0) / 1000)} s: ${e.message}${e.message === 'timeout' || attempt ? '' : ' — retrying once'}\n`);
      if (e.message === 'timeout') break;
    }
  }
  throw last;
}
const SLOW_MS = 30_000;
