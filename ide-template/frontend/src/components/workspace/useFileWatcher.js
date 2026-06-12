import { useEffect, useState } from 'react';

/**
 * Subscribe to /api/files/watch (SSE) and bump a nonce on every event batch.
 * Components that depend on file system state read the nonce in their useEffect
 * deps and re-fetch when it changes.
 *
 * EventSource auto-reconnects on transient drops (workspace-api restart,
 * proxy timeout) so consumers don't need explicit reconnection logic.
 */
export default function useFileWatcher() {
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const es = new EventSource('/api/files/watch');
    es.onmessage = () => setNonce(n => n + 1);
    es.onerror = () => {
      // EventSource auto-reconnects; just log silently. If the server is
      // genuinely down, we'll keep retrying every few seconds — that's fine.
    };
    return () => es.close();
  }, []);

  return nonce;
}
