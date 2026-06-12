import { useCallback, useRef, useState } from 'react';
import { PanelRightClose, ArrowLeft, Plus, History } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBranding } from './identity';
import SpinningAvatar from './SpinningAvatar.jsx';
import ChatSessionDropdown from './ChatSessionDropdown.jsx';
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
}) {
  const { botDisplayName } = useBranding();
  const [dropdownOpen,   setDropdownOpen]   = useState(false);
  const [pendingDelete,  setPendingDelete]  = useState(null);
  const [refreshNonce,   setRefreshNonce]   = useState(0);
  const historyBtnRef = useRef(null);

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
      const r = await fetch(`/api/chat/sessions/${target.id}`, { method: 'DELETE' });
      if (!r.ok) return;
      setRefreshNonce(n => n + 1);   // makes dropdown re-pull /api/chat/sessions
      if (target.id === activeSessionId) onSelectSession?.(null);
    } catch { /* surface via dropdown error path on its next refetch */ }
  }, [pendingDelete, activeSessionId, onSelectSession]);

  return (
    <div className="relative flex h-14 shrink-0 items-center gap-2 px-4 max-md:px-2">
      <button
        type="button"
        onClick={onCollapse}
        className="md:hidden flex items-center justify-center p-2 -ml-1 text-muted-foreground/80 hover:text-foreground rounded-full hover:bg-muted/50"
      >
        <ArrowLeft className="size-5" strokeWidth={1.75} />
      </button>

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

        <button
          ref={historyBtnRef}
          type="button"
          onClick={() => setDropdownOpen(o => !o)}
          title="Chat history"
          aria-expanded={dropdownOpen}
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-md',
            'text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground/85',
            dropdownOpen && 'bg-muted/40 text-foreground/85',
          )}
        >
          <History className="size-4" strokeWidth={1.85} />
        </button>

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
      </div>

      <ChatSessionDropdown
        open={dropdownOpen}
        onClose={() => setDropdownOpen(false)}
        anchorRef={historyBtnRef}
        activeSessionId={activeSessionId}
        onSelect={(id) => onSelectSession?.(id)}
        onRequestDelete={onRequestDelete}
        refreshNonce={refreshNonce}
      />

      <AlertDialog open={!!pendingDelete} onOpenChange={(v) => { if (!v) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete chat?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium text-foreground/85">
                {pendingDelete?.title || 'Untitled chat'}
              </span>
              {' '}will be archived. You can find it for 30 days before it's removed permanently.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
