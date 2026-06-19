/**
 * Server-pushed notifications — pub/sub + small ring buffer.
 *
 * Loopback callers (reminder-monitor.sh via web-notify.sh, future skill
 * hooks, telegram-inbound mirror) POST to /api/internal/notify, which
 * fans out to every connected /api/notifications/stream SSE client.
 *
 * The buffer lets a tab that opens AFTER a notification fired still see
 * the recent ones — workspace-api stays single-user-per-container in v1,
 * so a global ring buffer is enough. Persistence across workspace-api
 * restart is out of scope for Phase 1.
 *
 * Modelled after lib/watcher.js — same SSE shape, same heartbeat cadence.
 */

import { randomUUID } from 'node:crypto';

const BUFFER_LIMIT = 50;

/** Set<{ res }> — currently connected SSE subscribers. */
const subscribers = new Set();

/** Most recent notifications, oldest first. Capped at BUFFER_LIMIT. */
const recent = [];

function writeEvent(res, name, data) {
  try {
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Subscriber's socket is gone; the close handler will detach it.
  }
}

/** Does a notification target this viewer? A notification with no `recipient`
 *  is GLOBAL (team-wide / legacy single-user) and reaches everyone. One WITH a
 *  recipient slug is PRIVATE to that teammate (B3 inter-user relay) — it reaches
 *  ONLY them: not the sender, not other admins.
 *
 *  Note we deliberately do NOT grant admins a view of targeted relays. Admin
 *  "sees everything" is a FILE-access rule (the operator maintains the
 *  workspace); a private message between two teammates is not the operator's to
 *  receive. It also fixed a real bug: the sender (usually the admin) got an echo
 *  toast of the very message they just relayed, on top of the in-chat
 *  confirmation — both surfaces lit up for one outgoing message. */
function visibleTo(n, viewerSlug) {
  if (!n.recipient) return true;            // global notification → everyone
  return !!viewerSlug && n.recipient === viewerSlug;
}

/**
 * Attach an SSE response stream. Replays the buffered notifications on
 * connect so a freshly opened tab sees what it just missed. Returns a
 * detacher to call on req close. `viewer` ({ slug, isAdmin }) scopes which
 * notifications this subscriber receives: global ones always, recipient-
 * targeted ones only if they're the recipient (or an admin).
 */
export function subscribe(res, viewer = {}) {
  const sub = { res, slug: viewer.slug || null, isAdmin: !!viewer.isAdmin };
  subscribers.add(sub);

  writeEvent(res, 'hello', { ok: true, replay: recent.length });
  // Buffered events are flagged so the client distinguishes them from
  // live arrivals — keeps the toast surface from re-popping the same
  // reminder on every page refresh, while NotificationsView still
  // renders the full backlog.
  for (const n of recent) {
    if (visibleTo(n, sub.slug)) writeEvent(res, 'notification', { ...n, replay: true });
  }

  const heartbeat = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch {}
  }, 30_000);

  return () => {
    clearInterval(heartbeat);
    subscribers.delete(sub);
  };
}

/**
 * Fan out a notification to every connected client and store it in the
 * ring buffer. Caller-supplied id is honoured so the same logical event
 * isn't re-stored if it gets re-posted; otherwise a server-side uuid is
 * generated. Returns the stored object.
 */
export function publish(input) {
  const now = new Date().toISOString();
  const incomingId = typeof input?.id === 'string' && input.id ? input.id : null;
  if (incomingId && recent.some(n => n.id === incomingId)) {
    return recent.find(n => n.id === incomingId);
  }
  const n = {
    id: incomingId || `n_${randomUUID().slice(0, 8)}`,
    ts: now,
    kind: typeof input?.kind === 'string' ? input.kind : 'system',
    title: typeof input?.title === 'string' ? input.title : '',
    body: typeof input?.body === 'string' ? input.body : '',
    meta: input?.meta && typeof input.meta === 'object' ? input.meta : {},
    // B3: a notification targeted at one teammate (their slug). null/absent =
    // global (legacy single-user + team-wide). Only the recipient (+ admins)
    // receive a targeted one — see visibleTo().
    recipient: typeof input?.recipient === 'string' && input.recipient ? input.recipient : null,
  };
  recent.push(n);
  while (recent.length > BUFFER_LIMIT) recent.shift();
  for (const sub of subscribers) {
    if (visibleTo(n, sub.slug)) writeEvent(sub.res, 'notification', n);
  }
  return n;
}

/** Test helper / introspection — current buffer length. */
export function _size() {
  return { subscribers: subscribers.size, buffered: recent.length };
}
