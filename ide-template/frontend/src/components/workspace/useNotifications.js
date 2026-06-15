import { useEffect, useState } from 'react';

/**
 * Subscribe to /api/notifications/stream (SSE). Returns the rolling list
 * of notifications received since mount, including the server-side ring
 * buffer (~50 entries) replayed by the wsapi `notification` event on
 * connect.
 *
 * Shape: [{ id, ts, kind, title, body, meta }, ...] — newest last.
 *
 * EventSource auto-reconnects on transient drops (wsapi restart, proxy
 * timeout). Phase 1 keeps notifications in memory only; closing the tab
 * loses unread state. Phase 2 adds desktop notification + persistence.
 *
 * Modelled after useFileWatcher.js — same EventSource shape, but listens
 * for a named `notification` event instead of the default `message`.
 */
export default function useNotifications() {
  const [notifications, setNotifications] = useState([]);
  const [connecting, setConnecting] = useState(true);

  useEffect(() => {
    const es = new EventSource('/api/notifications/stream');

    es.addEventListener('notification', (e) => {
      try {
        const n = JSON.parse(e.data);
        setNotifications((prev) => {
          // De-dupe by id — the server-side buffer replays on reconnect,
          // and we don't want the same reminder bubble twice after a
          // transient EventSource drop.
          if (prev.some((p) => p.id === n.id)) return prev;
          return [...prev, n];
        });
      } catch {
        // Bad payload — ignore. The next event will arrive normally.
      }
    });

    es.addEventListener('hello', () => {
      // Greeting confirms the stream is live → the SkeletonRow placeholders
      // on the inbox can come down.
      setConnecting(false);
    });

    es.onerror = () => {
      // EventSource auto-reconnects. Silent.
    };

    return () => es.close();
  }, []);

  return { notifications, connecting };
}
