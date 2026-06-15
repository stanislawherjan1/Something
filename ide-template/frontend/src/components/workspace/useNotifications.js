import { useEffect, useState } from 'react';

/**
 * Subscribe to /api/notifications/stream (SSE). Returns the rolling list
 * of notifications received since mount, including the server-side ring
 * buffer (~50 entries) replayed by the wsapi `notification` event on
 * connect.
 *
 * Shape: [{ id, ts, kind, title, body, meta }, ...] — newest last.
 *
 * Module-level shared state: a single EventSource lives at the module
 * scope so EVERY consumer (NotificationToasts, NotificationsView,
 * Sidebar dot, ChatHeader dot, banner, …) reads from the same in-memory
 * cache. Without this, every view switch remounted its useNotifications
 * call, kicked off a fresh EventSource, and flashed the skeleton for
 * the few ms it took to receive `hello`. Now the cache is hot the
 * moment the workspace has loaded once: switching tabs is instant.
 *
 * EventSource auto-reconnects on transient drops (wsapi restart, proxy
 * timeout). On reconnect the server replays its ring buffer; the
 * de-dupe by id keeps the in-memory list clean.
 */

let sharedNotifications = [];
let sharedConnecting    = true;
const listeners         = new Set();
let started             = false;

function emit() {
  for (const fn of listeners) fn();
}

function ensureStarted() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const es = new EventSource('/api/notifications/stream');
  es.addEventListener('notification', (e) => {
    try {
      const n = JSON.parse(e.data);
      if (sharedNotifications.some((p) => p.id === n.id)) return;
      sharedNotifications = [...sharedNotifications, n];
      emit();
    } catch {
      // Bad payload — ignore.
    }
  });
  es.addEventListener('hello', () => {
    if (!sharedConnecting) return;
    sharedConnecting = false;
    emit();
  });
  es.onerror = () => {
    // Auto-reconnects. Silent.
  };
}

export default function useNotifications() {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    ensureStarted();
    const subscriber = () => setTick((t) => t + 1);
    listeners.add(subscriber);
    return () => {
      listeners.delete(subscriber);
    };
  }, []);

  // tick is just a re-render trigger; the actual data comes from the
  // module-level cache so a fresh mount sees whatever's already there.
  void tick;
  return { notifications: sharedNotifications, connecting: sharedConnecting };
}
