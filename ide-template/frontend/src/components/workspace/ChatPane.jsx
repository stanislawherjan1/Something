import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
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
export default function ChatPane({ onCollapse, onFileSelect, initialMessage, onInitialMessageConsumed, className }) {
  const [activeSessionId, setActiveSessionId] = useState(null);

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
        if (first) {
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
    })();
    return () => { cancelled = true; };
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
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Pick a chat or create one.
          </div>
        )}
      </div>
    </aside>
  );
}
