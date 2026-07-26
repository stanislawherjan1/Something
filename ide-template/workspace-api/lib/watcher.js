/**
 * File system watcher (chokidar) + SSE pub/sub.
 *
 * One watcher per process for PROJECT_DIR, filtered by the same visibility
 * rules used for /api/files/tree. Events are batched in a 100 ms window and
 * fanned out to every subscribed SSE client on /api/files/watch.
 *
 * Heartbeats every 30 s prevent intermediaries (nginx idle timeout, etc.)
 * from killing long-lived streams.
 */

import chokidar from 'chokidar';
import { resolve, relative, sep } from 'node:path';
import { PROJECT_DIR } from './config.js';
import { isVisibleEntry } from './files.js';

const PROJECT_ABS = resolve(PROJECT_DIR);

/** Set<{ res }> — currently connected subscribers */
const subscribers = new Set();

let pending = [];
let flushTimer = null;

function queueEvent(type, abs) {
  let path = relative(PROJECT_ABS, abs).replace(/\\/g, '/');
  const leaf = path.split('/').pop();
  if (leaf && !isVisibleEntry(leaf)) return;
  pending.push({ type, path });
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 100);
}

function flush() {
  flushTimer = null;
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  const payload = `data: ${JSON.stringify({ events: batch })}\n\n`;
  for (const sub of subscribers) {
    try { sub.res.write(payload); } catch {}
  }
}

const watcher = chokidar.watch(PROJECT_ABS, {
  ignoreInitial: true,
  ignorePermissionErrors: true,
  persistent: true,
  ignored: (p) => {
    const rel = relative(PROJECT_ABS, p).replace(/\\/g, '/');
    // Always watch .claude/skills, .reminders.json and .tasks.json so the
    // Skills, Reminders and Tasks dashboards refresh without a full page
    // reload. Visibility in the file tree is gated separately in files.js —
    // watching doesn't expose content.
    if (rel === '.claude' || rel.startsWith('.claude/skills') || rel === '.reminders.json' || rel === '.tasks.json') return false;
    // Mini apps in TEAM mode live under users/<slug>/.claude/miniapps — the
    // '.claude' dot-dir would be ignored below, so chokidar never descends and
    // a freshly built app only shows up after a page reload. Whitelist the
    // personal .claude dir (to descend) + its miniapps subtree explicitly.
    if (/^users\/[^/]+\/\.claude$/.test(rel) || /^users\/[^/]+\/\.claude\/miniapps(\/|$)/.test(rel)) return false;
    const base = p.split(sep).pop();
    return base ? !isVisibleEntry(base) : false;
  },
});

watcher
  .on('add',       (p) => queueEvent('add',       p))
  .on('change',    (p) => queueEvent('change',    p))
  .on('unlink',    (p) => queueEvent('unlink',    p))
  .on('addDir',    (p) => queueEvent('addDir',    p))
  .on('unlinkDir', (p) => queueEvent('unlinkDir', p))
  .on('error',     (err) => process.stderr.write(`[watcher] ${err.message}\n`));

/** Attach an SSE response stream to receive events. Returns a detacher. */
export function subscribe(res) {
  const sub = { res };
  subscribers.add(sub);

  // Greeting + heartbeats keep proxies happy and let the client distinguish
  // "subscribed" from "still waiting for first message".
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  const heartbeat = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch {}
  }, 30_000);

  return () => {
    clearInterval(heartbeat);
    subscribers.delete(sub);
  };
}

/** Stop the watcher (used on SIGTERM/SIGINT for clean PM2 restart). */
export function stop() {
  return watcher.close();
}
