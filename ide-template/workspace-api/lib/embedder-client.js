/**
 * embedder-client — vectors from the embedder worker (apps/embedder), or nothing.
 *
 * The worker is forked from workspace-api on first use, so it runs as the same
 * user without a wrapper of its own, but in its own process: an out-of-memory or
 * a native crash in the model ends the worker, never the API. It gets a minimal
 * environment (no keys, no session secret — it only ever sees text the API
 * already holds) and talks over the fork's IPC channel, so there is no socket
 * file to guard. It exits by itself after 30 idle minutes; the next call forks
 * it again.
 *
 * When it is missing, crashed or slow, callers get `null` and search runs on
 * BM25 alone — measured on LongMemEval as 0.75 against 0.80 hybrid: degraded,
 * never broken. After a failure it is not retried for a minute, so a broken
 * install costs one attempt per minute, not one per turn.
 */
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';

const WORKER = () => process.env.EMBEDDER_WORKER || '/opt/ide/apps/embedder/worker.mjs';
const TIMEOUT_MS = Number(process.env.EMBEDDER_TIMEOUT_MS) || 60_000;   // the first call loads the model
const COOLDOWN_MS = 60_000;

let override = null;          // tests inject an embed function here
let child = null;
let seq = 0;
let downUntil = 0;
const pending = new Map();   // id → { resolve, timer }

/** Replace the transport (tests). `fn(texts, mode) → Promise<number[][]>`, or null to restore. */
export function configureEmbedder(fn) { override = fn; downUntil = 0; }

function settleAll() {
  for (const p of pending.values()) { clearTimeout(p.timer); p.resolve(null); }
  pending.clear();
}

function start() {
  const path = WORKER();
  if (!existsSync(path)) { downUntil = Date.now() + 10 * COOLDOWN_MS; return null; }
  const c = fork(path, [], {
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: process.env.HOME || '/tmp',
      NODE_ENV: 'production',
      EMBEDDER_MODEL_DIR: process.env.EMBEDDER_MODEL_DIR || '/opt/ide/models',
      ...(process.env.EMBEDDER_IDLE_MS ? { EMBEDDER_IDLE_MS: process.env.EMBEDDER_IDLE_MS } : {}),
    },
    execArgv: ['--max-old-space-size=512'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  c.stderr?.on('data', (d) => process.stderr.write(`[embedder] ${String(d).slice(0, 500)}`));
  c.on('message', (m) => {
    const p = pending.get(m?.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    p.resolve(Array.isArray(m.vectors) ? m.vectors : null);
  });
  const gone = (code) => {
    if (child === c) child = null;
    settleAll();
    if (code) downUntil = Date.now() + COOLDOWN_MS;   // a crash, not the idle exit
  };
  c.on('exit', gone);
  c.on('error', () => gone(1));
  return c;
}

function viaWorker(texts, mode) {
  if (!child) child = start();
  if (!child) return Promise.resolve(null);
  const c = child;
  return new Promise((resolve) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
      downUntil = Date.now() + COOLDOWN_MS;
      try { c.kill('SIGKILL'); } catch { /* gone */ }
    }, TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    try { c.send({ id, mode, texts }); } catch { pending.delete(id); clearTimeout(timer); resolve(null); }
  });
}

/** Embed texts; `null` when the embedder is unavailable. */
export async function embed(texts, mode = 'passage') {
  if (!texts.length) return [];
  if (override) {
    try { return await override(texts, mode); } catch { return null; }
  }
  if (Date.now() < downUntil) return null;
  const v = await viaWorker(texts, mode);
  if (!v || v.length !== texts.length) { downUntil = Date.now() + COOLDOWN_MS; return null; }
  return v;
}

/** The model the vectors come from — stored with them, so a model change re-embeds. */
export const EMBEDDER_MODEL = 'multilingual-e5-small@761b726-q8';

export function _stopForTests() { if (child) { try { child.kill(); } catch { /* gone */ } child = null; } settleAll(); downUntil = 0; }
