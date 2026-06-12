import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, Edit3, Trash2, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * ChatSessionDropdown — Claude-Code-style sessions popover.
 *
 * Triggered from the ChatHeader title click. Renders:
 *   - search input at the top (always visible, focuses on open)
 *   - scrollable list of sessions: title + relative time + inline pencil/trash on hover
 *   - "+ New chat" button as a sticky first item
 *
 * Deliberately minimal vs the earlier ChatGPT-style ChatSidebar:
 *   - no permanent rail eating horizontal space
 *   - no pinned/archived sections (backend still supports them; UI defers to v2)
 *   - no 3-dot popover — pencil + trash inline only
 *   - no Local/Web tabs (we only have local sessions)
 */
export default function ChatSessionDropdown({
  open, onClose, activeSessionId, onSelect, anchorRef,
  onRequestDelete,
  refreshNonce = 0,
}) {
  const [sessions, setSessions] = useState([]);
  const [search,   setSearch]   = useState('');
  const [renamingId, setRenamingId] = useState(null);
  const [renameText, setRenameText] = useState('');
  const [error,    setError]    = useState(null);
  const searchInputRef = useRef(null);
  const containerRef   = useRef(null);

  const refetch = useCallback(async () => {
    try {
      const r = await fetch('/api/chat/sessions');
      if (!r.ok) throw new Error(`GET sessions ${r.status}`);
      const data = await r.json();
      setSessions(data.sessions || []);
      setError(null);
    } catch (err) { setError(err.message); }
  }, []);

  // Refetch on open + 30s background refresh while open (auto-title finishing).
  useEffect(() => {
    if (!open) return;
    refetch();
    const t = setInterval(refetch, 30_000);
    return () => clearInterval(t);
  }, [open, refetch]);

  // Parent (ChatHeader) bumps refreshNonce when it wants the dropdown to
  // re-pull the manifest — used after a delete so the row disappears
  // immediately instead of waiting for the 30s poll.
  useEffect(() => {
    if (refreshNonce > 0) refetch();
  }, [refreshNonce, refetch]);

  // Focus search on open.
  useEffect(() => {
    if (open) searchInputRef.current?.focus();
  }, [open]);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (!(e.target instanceof Node)) return;
      if (containerRef.current?.contains(e.target)) return;
      if (anchorRef?.current?.contains(e.target)) return;   // header trigger toggles itself
      onClose?.();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown',   onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown',   onKey);
    };
  }, [open, onClose, anchorRef]);

  // Auto-focus the rename input.
  useEffect(() => {
    if (renamingId) {
      const el = document.querySelector(`[data-rename-input="${renamingId}"]`);
      el?.focus();
      el?.select?.();
    }
  }, [renamingId]);

  const createNew = useCallback(async () => {
    try {
      const r = await fetch('/api/chat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error(`POST sessions ${r.status}`);
      const s = await r.json();
      await refetch();
      onSelect(s.id);
      onClose?.();
    } catch (err) { setError(err.message); }
  }, [refetch, onSelect, onClose]);

  const renameCommit = useCallback(async (id, nextTitle) => {
    const title = (nextTitle || '').trim();
    if (!title) { setRenamingId(null); return; }
    try {
      const r = await fetch(`/api/chat/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!r.ok) throw new Error(`PATCH ${r.status}`);
      await refetch();
    } catch (err) { setError(err.message); }
    setRenamingId(null);
  }, [refetch]);

  // Delete is owned by ChatHeader — it persists the AlertDialog outside the
  // dropdown so the dialog survives a dropdown close.

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sessions
      .filter(s => !s.archived)
      .filter(s => !q || (s.title || '').toLowerCase().includes(q));
  }, [sessions, search]);

  if (!open) return null;

  return (
    <div
      ref={containerRef}
      className="absolute inset-x-2 top-full z-30 mt-1 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
      data-testid="session-dropdown"
    >
      {/* Search header */}
      <div className="flex items-center gap-2 rounded-md px-3 py-1.5">
        <Search size={14} className="shrink-0 text-muted-foreground/65" />
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Search sessions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="grow bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/70"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            className="text-muted-foreground/65 hover:text-foreground/85"
            aria-label="Clear search"
          >
            <X size={14} />
          </button>
        )}
      </div>

      <div className="my-1 border-t border-border/40" />

      {/* + New chat — same shape as a list row, primary-feel via icon */}
      <button
        type="button"
        onClick={createNew}
        className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium text-foreground/85 hover:bg-muted/40 transition-colors text-left"
      >
        <Plus className="size-4 text-muted-foreground/65 shrink-0" strokeWidth={1.75} />
        <span className="flex-1">New chat</span>
      </button>

      {error && (
        <div className="mx-1 my-1 rounded-md bg-red-500/10 px-3 py-1.5 text-[12px] text-red-600">
          {error}
        </div>
      )}

      <div className="px-3 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        Recent
      </div>

      {/* Sessions list */}
      <ul className="max-h-[55vh] overflow-y-auto">
        {filtered.length === 0 && (
          <li className="px-3 py-3 text-center text-[12px] text-muted-foreground/75">
            {search ? `No matches for "${search}"` : 'No chats yet.'}
          </li>
        )}
        {filtered.map(s => (
          <li
            key={s.id}
            className={cn(
              "group/row flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 transition-colors",
              s.id === activeSessionId
                ? "bg-muted/40"
                : "hover:bg-muted/40",
            )}
            onClick={() => {
              if (renamingId === s.id) return;
              onSelect(s.id);
              onClose?.();
            }}
            data-testid="session-row"
          >
            <div className="min-w-0 grow">
              {renamingId === s.id ? (
                <input
                  data-rename-input={s.id}
                  type="text"
                  value={renameText}
                  onChange={(e) => setRenameText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') renameCommit(s.id, renameText);
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                  onBlur={() => renameCommit(s.id, renameText)}
                  onClick={(e) => e.stopPropagation()}
                  className="w-full bg-background rounded px-1 text-[13px] outline-none ring-1 ring-primary"
                />
              ) : (
                <div className={cn(
                  "truncate text-[13px] text-foreground/85",
                  s.id === activeSessionId && "font-medium text-foreground",
                )}>
                  {s.title || 'Untitled'}
                </div>
              )}
            </div>

            <span className="shrink-0 text-[11px] text-muted-foreground/70">
              {relTime(s.lastMessageAt)}
            </span>

            {/* Inline actions — visible only on hover or for the active row */}
            {renamingId !== s.id && (
              <div className={cn(
                "flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity",
                "group-hover/row:opacity-100",
                s.id === activeSessionId && "opacity-100",
              )}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenamingId(s.id);
                    setRenameText(s.title || '');
                  }}
                  className="rounded p-1 text-muted-foreground/65 hover:bg-background hover:text-foreground/85"
                  aria-label="Rename"
                  title="Rename"
                >
                  <Edit3 size={13} />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRequestDelete?.({ id: s.id, title: s.title });
                  }}
                  className="rounded p-1 text-muted-foreground/65 hover:bg-red-500/10 hover:text-red-600"
                  aria-label="Delete"
                  title="Delete"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function relTime(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const diff = Date.now() - t;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
