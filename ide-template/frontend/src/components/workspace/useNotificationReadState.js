import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'notifications.read';
const STORAGE_EVENT = 'notifications.read.changed';

function loadFromStorage() {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed);
  } catch {
    return new Set();
  }
}

function saveToStorage(set) {
  if (typeof window === 'undefined') return;
  // Bound the persisted set so a long-lived workspace doesn't grow it
  // forever — the server-side ring buffer is 50, so 500 is plenty of
  // headroom across many SSE re-connects.
  const arr = Array.from(set).slice(-500);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  window.dispatchEvent(new CustomEvent(STORAGE_EVENT));
}

/**
 * Per-tab read-state for SSE notifications. Reads / writes a Set of
 * notification ids to localStorage so the state survives page refresh,
 * and broadcasts updates via a window event so multiple consumers
 * (NotificationsView for the list filter, Sidebar for the unread dot)
 * stay in sync without prop drilling.
 *
 * Returns:
 *   isRead(id)     — boolean
 *   markRead(id)   — fire-and-forget
 *   markAllRead()  — given an array of ids, marks the full batch
 *   unreadCount(notifications) — convenience selector
 */
export default function useNotificationReadState() {
  const [readIds, setReadIds] = useState(loadFromStorage);

  // Subscribe to cross-component updates within this tab (custom event)
  // AND cross-tab updates (native storage event from another tab).
  useEffect(() => {
    const refresh = () => setReadIds(loadFromStorage());
    window.addEventListener(STORAGE_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(STORAGE_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const isRead = useCallback((id) => readIds.has(id), [readIds]);

  const markRead = useCallback((id) => {
    if (!id) return;
    const next = new Set(readIds);
    if (next.has(id)) return;
    next.add(id);
    saveToStorage(next);
    setReadIds(next);
  }, [readIds]);

  const markAllRead = useCallback((ids) => {
    if (!ids?.length) return;
    const next = new Set(readIds);
    let changed = false;
    for (const id of ids) {
      if (!next.has(id)) {
        next.add(id);
        changed = true;
      }
    }
    if (!changed) return;
    saveToStorage(next);
    setReadIds(next);
  }, [readIds]);

  return { isRead, markRead, markAllRead, readIds };
}
