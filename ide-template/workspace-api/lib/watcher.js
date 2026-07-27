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
  // Personal mini-app files (users/<slug>/.claude/miniapps/*) pass even
  // though their leaf may be dot-prefixed — they're the reason the users/
  // corridor exists. Everything else keeps the visibility gate.
  const miniapp = /^users\/[^/]+\/\.claude\/miniapps\//.test(path) || path.startsWith('.claude/miniapps/');
  if (!miniapp && leaf && !isVisibleEntry(leaf)) return;
  // Events under users/<slug>/ are PRIVATE: even filenames are metadata
  // (which apps a teammate has). Tag with the owner slug; flush() delivers
  // them only to that user's own SSE streams.
  const owner = path.match(/^users\/([^/]+)\//)?.[1] || null;
  pending.push({ type, path, owner });
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 100);
}

function flush() {
  flushTimer = null;
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  for (const sub of subscribers) {
    // Owner-scoped delivery. Admins get no special pass — mirrors
    // scope-rule: private trees are private from everyone via product
    // surfaces, the raw DB stays the only escape hatch.
    const events = batch
      .filter(e => !e.owner || e.owner === sub.slug)
      .map(({ owner, ...e }) => e);
    if (events.length === 0) continue;
    try { sub.res.write(`data: ${JSON.stringify({ events })}\n\n`); } catch {}
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
    // Mini apps in TEAM mode live under users/<slug>/.claude/miniapps. The
    // 'users' dir is SOFT_HIDDEN, so the default gate below would stop the
    // traversal at users/ itself and no event would ever fire for a freshly
    // built app (the "tab only appears after a reload" bug). Carve a NARROW
    // corridor: descend users → <slug> → .claude → miniapps/** and keep
    // every other personal path dark — nothing outside miniapps is watched,
    // and queueEvent tags miniapp events with their owner so other users'
    // SSE streams never see them.
    if (rel === 'users'
      || /^users\/[^/]+$/.test(rel)
      || /^users\/[^/]+\/\.claude$/.test(rel)
      || /^users\/[^/]+\/\.claude\/miniapps(\/|$)/.test(rel)) return false;
    if (rel.startsWith('users/')) return true;   // rest of users/** stays dark
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

/**
 * Attach an SSE response stream to receive events. Returns a detacher.
 * `scope.slug` (from actorScope) gates delivery of users/<slug>/ events —
 * a subscriber only ever receives their own private-tree events.
 */
export function subscribe(res, scope = {}) {
  const sub = { res, slug: scope.slug || null };
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
