import { useEffect, useState } from 'react';
import { refetch } from '@/lib/useApi';

/**
 * Subscribe to /api/files/watch (SSE) and bump a nonce on every event batch.
 * Components that depend on file system state read the nonce in their useEffect
 * deps and re-fetch when it changes.
 *
 * The stream also carries `{ type: 'state', kind }` notices for state the
 * watcher cannot see as files — branding, the team roster, the integration
 * store. They carry no payload: the kind names what changed, and the URLs it
 * maps to are refetched through the same gates they always went through. That
 * is what stops a view showing the old value after the bot says it changed it.
 *
 * EventSource auto-reconnects on transient drops (workspace-api restart,
 * proxy timeout) so consumers don't need explicit reconnection logic.
 */
const STATE_URLS = {
  branding:     ['/api/branding'],
  team:         ['/api/team', '/api/me'],
  integrations: ['/api/integrations'],
};

export default function useFileWatcher() {
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const es = new EventSource('/api/files/watch');

    es.onmessage = (ev) => {
      // A malformed or empty frame still means "something moved" — bump and
      // move on rather than dropping the batch on the floor.
      let events = null;
      try { events = JSON.parse(ev.data)?.events; } catch { /* keep null */ }

      if (Array.isArray(events)) {
        const kinds = new Set(
          events.filter(e => e && e.type === 'state' && e.kind).map(e => e.kind),
        );
        for (const kind of kinds) {
          for (const url of STATE_URLS[kind] || []) refetch(url);
        }
      }

      setNonce(n => n + 1);
    };

    es.onerror = () => {
      // EventSource auto-reconnects; just log silently. If the server is
      // genuinely down, we'll keep retrying every few seconds — that's fine.
    };

    return () => es.close();
  }, []);

  return nonce;
}
