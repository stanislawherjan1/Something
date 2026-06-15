import { useEffect, useState } from 'react';

const STORAGE_KEY = 'notifications.desktop.enabled';
const PREF_CHANGED_EVENT = 'notifications.desktop.changed';

/**
 * Hook that escalates server-pushed notifications to native browser
 * desktop popups via the Web Notifications API — but only while the tab
 * is open. (Closed-tab push needs Service Worker + Push API; that's the
 * future Phase 2b work in docs/future-plans/WEB_CHAT_PUSH.md.)
 *
 * State machine:
 *   - permission === 'default'                              → user hasn't decided. Show a Request button.
 *   - permission === 'granted' AND user pref === enabled    → fire Notification on every new event WHEN document.hidden.
 *   - permission === 'granted' AND user pref === disabled   → silent. Toggle re-enables.
 *   - permission === 'denied'                               → silent. Show "Blocked by browser" hint.
 *
 * Persistence: a single boolean in localStorage (independent of the
 * browser's permission grant — the user can grant permission for the
 * origin but choose to mute desktop popups here, and vice versa).
 */
export default function useDesktopNotifications(notifications) {
  const [permission, setPermission] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
  );
  const [enabled, setEnabled] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  });

  // Multiple hook instances (workspace shell + NotificationsView's
  // toggle UI) need to stay in sync — toggling in one place should
  // update both. Listen for the custom event the setEnabled emits AND
  // the native storage event so cross-tab changes also propagate.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const refresh = () => setEnabled(window.localStorage.getItem(STORAGE_KEY) === '1');
    window.addEventListener(PREF_CHANGED_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(PREF_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  // Fire a desktop popup for each new server-pushed notification while
  // the tab is not focused. Filter by id so we never double-fire on
  // ring-buffer replays after a reconnect.
  useEffect(() => {
    if (permission !== 'granted' || !enabled) return;
    if (typeof Notification === 'undefined') return;
    const seen = JSON.parse(window.sessionStorage.getItem('notifications.fired') || '[]');
    const seenSet = new Set(seen);
    let nextSeen = [...seen];
    for (const n of notifications) {
      if (seenSet.has(n.id)) continue;
      // Skip replays from the server-side ring buffer — they're not new.
      // Without this guard, every page refresh would pop a desktop popup
      // for every buffered event (toast already has the same guard).
      if (n.replay) {
        nextSeen.push(n.id);
        continue;
      }
      try {
        // Fire regardless of document visibility — modern browsers
        // surface desktop popups even when the tab is focused (with a
        // brief banner), and that matches the in-app toast behaviour
        // 1:1. The previous "only when hidden" gate confused users who
        // expected the popup to appear immediately.
        new Notification(n.title || 'Bot', {
          body: n.body || '',
          tag: n.id,
        });
      } catch {
        // Some browsers throw if called outside a user gesture or for
        // service-worker-only contexts — swallow, the bubble still
        // shows in-app via NotificationToasts.
      }
      nextSeen.push(n.id);
    }
    // Keep the dedupe list bounded — sessionStorage clears on tab
    // close, but within a long session we still don't want unbounded
    // growth as the server's ring buffer replays add up.
    if (nextSeen.length > 200) nextSeen = nextSeen.slice(-200);
    window.sessionStorage.setItem('notifications.fired', JSON.stringify(nextSeen));
  }, [notifications, permission, enabled]);

  const requestPermission = async () => {
    if (typeof Notification === 'undefined') return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    const result = await Notification.requestPermission();
    setPermission(result);
    if (result === 'granted') {
      window.localStorage.setItem(STORAGE_KEY, '1');
      setEnabled(true);
      window.dispatchEvent(new CustomEvent(PREF_CHANGED_EVENT));
    }
    return result;
  };

  const setEnabledFlag = (flag) => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, flag ? '1' : '0');
    setEnabled(!!flag);
    window.dispatchEvent(new CustomEvent(PREF_CHANGED_EVENT));
  };

  return { permission, enabled, requestPermission, setEnabled: setEnabledFlag };
}
