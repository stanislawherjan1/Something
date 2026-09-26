import { useCallback, useRef, useState } from 'react';
import { PanelRightClose, ArrowLeft, Plus, History, Sun, Moon } from 'lucide-react';
import { useTheme } from '@/context/ThemeContext';
import { ThemeMenuSection } from './ThemeMenu';
import { cn } from '@/lib/utils';
import { useBranding } from './identity';
import SpinningAvatar from './SpinningAvatar.jsx';
import ChatSessionDropdown from './ChatSessionDropdown.jsx';
import useNotifications from './useNotifications.js';
import useNotificationReadState from './useNotificationReadState.js';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription,
  AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';

/**
 * Chat header — Claude-Code-style layout.
 *
 * Layout (left → right):
 *   avatar | bot name | … | + (new) | clock (history dropdown) | collapse
 *
 * Owns the delete-confirm AlertDialog so it persists outside the dropdown's
 * lifecycle (a click on the dialog action lands outside the dropdown
 * container, which would otherwise close the dropdown and unmount the
 * dialog mid-click — the original bug).
 */
export default function ChatHeader({
  activeSessionId, onSelectSession,
  onCollapse,
  showThemeMenu = false,
}) {
  const { botDisplayName } = useBranding();
  const [dropdownOpen,   setDropdownOpen]   = useState(false);
  const [pendingDelete,  setPendingDelete]  = useState(null);
  const [refreshNonce,   setRefreshNonce]   = useState(0);
  const historyBtnRef = useRef(null);

  // Unread bot-originated notifications carry their target chat session
  // in meta.session_id. We surface them as a red dot on the history
  // button (so the user knows there are unread sessions even when the
  // dropdown is closed) plus pass the unread-id set into the dropdown
  // so each unread row gets its own dot.
  const { notifications } = useNotifications();
  const { isRead } = useNotificationReadState();
  const unreadSessionIds = new Set(
    notifications.filter((n) => !isRead(n.id) && n.meta?.session_id).map((n) => n.meta.session_id),
  );
  const hasUnreadSessions = unreadSessionIds.size > 0;

  const createNew = async () => {
    try {
      const r = await fetch('/api/chat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!r.ok) return;
      const s = await r.json();
      onSelectSession?.(s.id);
    } catch { /* no-op — dropdown still lets the user retry */ }
  };

  const onRequestDelete = useCallback((target) => {
    setPendingDelete(target);
  }, []);

  const confirmDelete = useCallback(async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    try {
      // "Clear all chats": every conversation goes, a fresh one takes its place.
      if (target.all) {
        const r = await fetch('/api/chat/sessions', { method: 'DELETE' });
        if (!r.ok) return;
        setRefreshNonce(n => n + 1);
        await createNew();
        return;
      }
      const r = await fetch(`/api/chat/sessions/${target.id}`, { method: 'DELETE' });
      if (!r.ok) return;
      setRefreshNonce(n => n + 1);   // makes dropdown re-pull /api/chat/sessions
      if (target.id === activeSessionId) onSelectSession?.(null);
    } catch { /* surface via dropdown error path on its next refetch */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- createNew only calls onSelectSession
  }, [pendingDelete, activeSessionId, onSelectSession]);

  return (
    <div className="relative flex h-14 shrink-0 items-center gap-2 px-4 max-md:px-2">
      {/* No collapse target (the browser extension's panel) → no back / collapse buttons. */}
      {onCollapse && (
        <button
          type="button"
          onClick={onCollapse}
          className="md:hidden flex items-center justify-center p-2 -ml-1 text-muted-foreground/80 hover:text-foreground rounded-full hover:bg-muted/50"
        >
          <ArrowLeft className="size-5" strokeWidth={1.75} />
        </button>
      )}

      <SpinningAvatar size={9} />

      <div className="min-w-0">
        <div className="truncate text-[15.5px] font-semibold leading-tight tracking-[-0.01em] text-foreground">
          {botDisplayName}
        </div>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={createNew}
          title="New chat"
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-md',
            'text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground/85',
          )}
        >
          <Plus className="size-4" strokeWidth={2} />
        </button>

        {showThemeMenu && <ThemeButton />}

        <button
          ref={historyBtnRef}
          type="button"
          onClick={() => setDropdownOpen(o => !o)}
          title="Chat history"
          aria-expanded={dropdownOpen}
          className={cn(
            'relative flex size-7 shrink-0 items-center justify-center rounded-md',
            'text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground/85',
            dropdownOpen && 'bg-muted/40 text-foreground/85',
          )}
        >
          <History className="size-4" strokeWidth={1.85} />
          {hasUnreadSessions && (
            <span
              aria-label="Unread sessions"
              className="absolute right-1 top-1 size-1.5 rounded-full bg-red-500 ring-2 ring-background"
            />
          )}
        </button>

{onCollapse && (
        <button
          type="button"
          onClick={onCollapse}
          title="Collapse chat"
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-md',
            'text-muted-foreground/65 transition-colors duration-150',
            'hover:bg-sidebar/60 hover:text-foreground/80',
            'max-md:hidden'
          )}
        >
          <PanelRightClose className="size-[15px]" strokeWidth={1.75} />
        </button>
        )}
      </div>

      <ChatSessionDropdown
        open={dropdownOpen}
        onClose={() => setDropdownOpen(false)}
        anchorRef={historyBtnRef}
        activeSessionId={activeSessionId}
        onSelect={(id) => onSelectSession?.(id)}
        onRequestDelete={onRequestDelete}
        refreshNonce={refreshNonce}
        unreadSessionIds={unreadSessionIds}
      />

      <AlertDialog open={!!pendingDelete} onOpenChange={(v) => { if (!v) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingDelete?.all ? 'Clear all chats?' : 'Delete chat?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.all ? (
                <>All your chats will be archived. You can find them for 30 days before they're removed permanently.</>
              ) : (
                <>
                  <span className="font-medium text-foreground/85">
                    {pendingDelete?.title || 'Untitled chat'}
                  </span>
                  {' '}will be archived. You can find it for 30 days before it's removed permanently.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {pendingDelete?.all ? 'Clear all' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// Light / Dark / System, for the browser-extension panel where the user menu
// (which normally holds this) is not shown. Same items and popover styling.
function ThemeButton() {
  const [open, setOpen] = useState(false);
  const { resolvedTheme } = useTheme();
  const Icon = resolvedTheme === 'dark' ? Moon : Sun;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title="Theme"
        aria-expanded={open}
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-md',
          'text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground/85',
          open && 'bg-muted/40 text-foreground/85',
        )}
      >
        <Icon className="size-4" strokeWidth={1.85} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 w-44 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
            <ThemeMenuSection />
          </div>
        </>
      )}
    </div>
  );
}
