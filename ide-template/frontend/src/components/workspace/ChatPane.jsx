import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { readPanelCache } from '@/lib/panelCache';
import ChatHeader from './ChatHeader.jsx';
import ChatPanel from './ChatPanel.jsx';

/**
 * ChatPane — right column. Header (with session dropdown) + chat panel.
 *
 * Owns `activeSessionId`. On mount it picks the most-recent non-archived
 * session from /api/chat/sessions, or auto-creates one if the workspace
 * is fresh. ChatPanel mounts with key={sessionId} so each switch is a
 * clean remount.
 *
 * Session title is intentionally NOT tracked here — the top bar shows the
 * bot name, the session title lives in the dropdown row only.
 */
// extraFields / composerAccessory / onTurnDone pass straight through to ChatPanel
// (used only by the browser-extension embed).
export default function ChatPane({ onCollapse, onFileSelect, initialMessage, onInitialMessageConsumed, className, extraFields, composerAccessory, onTurnDone, showThemeMenu, freshAfterMs = 0 }) {
  // The extension panel reopens on the conversation it last showed, unless
  // that has gone stale; the lookup below confirms or replaces it.
  const [activeSessionId, setActiveSessionId] = useState(() => {
    const c = readPanelCache();
    if (!c?.sessionId) return null;
    return freshAfterMs > 0 && Date.now() - (c.lastAt || 0) > freshAfterMs ? null : c.sessionId;
  });
  // Until the lookup answers there is no "pick a chat" — nothing is decided yet.
  const [resolved, setResolved] = useState(false);

  // First mount: figure out which session to show. If the workspace has
  // no sessions yet, create one on the fly so the welcome-screen autosend
  // path always has somewhere to land (and so the user doesn't see an
  // empty "Pick a chat" state on first boot).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/chat/sessions');
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled) return;
        const sessions = data.sessions || [];
        // The backend orders sessions by pinned first, then lastMessageAt desc.
        // So the first non-archived entry IS the most recently touched one.
        const first = sessions.find(s => !s.archived) || sessions[0];
        // freshAfterMs (browser-extension panel): after a long enough pause,
        // open a new conversation instead of the last one. An empty last
        // conversation is reused rather than stacking another empty one.
        const stale = freshAfterMs > 0 && first && first.messageCount > 0
          && Date.now() - Date.parse(first.lastMessageAt || 0) > freshAfterMs;
        if (first && !stale) {
          setActiveSessionId(first.id);
          return;
        }
        // No sessions — create one. ChatPanel mounts with this id and
        // WelcomeScreen's initialMessage autosend has a real session to
        // POST to. Auto-title (Phase 5) will rename it from "New chat"
        // after the first user+assistant pair lands.
        const create = await fetch('/api/chat/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!create.ok || cancelled) return;
        const s = await create.json();
        setActiveSessionId(s.id);
      } catch { /* tolerate — UI falls back to the "Pick a chat" empty state */ }
      finally { if (!cancelled) setResolved(true); }
    })();
    return () => { cancelled = true; };
  }, [freshAfterMs]);

  // External callers (NotificationsView row clicks, NotificationToasts
  // click) dispatch `ide:chat-select-session` with { sessionId } in
  // detail to deep-link straight into a bot-originated session that
  // web_send_message just created. Listening here keeps the wiring out
  // of every consumer.
  useEffect(() => {
    const onExternal = (e) => {
      const sid = e.detail?.sessionId;
      if (typeof sid === 'string' && sid) setActiveSessionId(sid);
    };
    window.addEventListener('ide:chat-select-session', onExternal);
    return () => window.removeEventListener('ide:chat-select-session', onExternal);
  }, []);

  const onSelectSession = useCallback((id) => {
    if (id === null) {
      // The active session was deleted — find the next one to land on.
      (async () => {
        try {
          const r = await fetch('/api/chat/sessions');
          if (!r.ok) return;
          const data = await r.json();
          const next = (data.sessions || []).find(s => !s.archived);
          setActiveSessionId(next?.id || null);
        } catch { /* ignore */ }
      })();
      return;
    }
    setActiveSessionId(id);
  }, []);

  return (
    <aside className={cn("group flex min-h-0 flex-col border-l border-border bg-sidebar max-md:border-l-0", className)}>
      <div className="bg-background shrink-0 relative">
        <ChatHeader
          activeSessionId={activeSessionId}
          onSelectSession={onSelectSession}
          onCollapse={onCollapse}
          showThemeMenu={showThemeMenu}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {activeSessionId ? (
          <ChatPanel
            key={activeSessionId}
            sessionId={activeSessionId}
            onFileSelect={onFileSelect}
            initialMessage={initialMessage}
            onInitialMessageConsumed={onInitialMessageConsumed}
            extraFields={extraFields}
            composerAccessory={composerAccessory}
            onTurnDone={onTurnDone}
          />
        ) : resolved ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Pick a chat or create one.
          </div>
        ) : null}
      </div>
    </aside>
  );
}
