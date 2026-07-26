/**
 * MiniAppsList — the "Your Mini Apps" sidebar section body.
 *
 * Lists AI-built apps from /api/miniapps. The section auto-refreshes on file
 * events (the agent's save_as_tab writes a spec file → chokidar → nonce), so
 * a freshly built app pops in without any manual reload.
 *
 * Row actions (hover, mirroring the file tree affordances):
 *   rename — pencil → inline input → PATCH /api/miniapps/:id
 *   delete — trash  → confirm dialog → DELETE /api/miniapps/:id
 */

import { useEffect, useState } from 'react';
import { LayoutGrid, Pencil, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useApi } from '@/lib/useApi';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription,
  AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';

const LIST_URL = '/api/miniapps';

export default function MiniAppsList({ selected, onSelect, fileEventNonce, onCountChange }) {
  const { data, reload } = useApi(LIST_URL);
  const apps = data?.apps || [];
  const [pendingDelete, setPendingDelete] = useState(null);   // app | null
  const [renaming, setRenaming] = useState(null);             // { id, value } | null
  const [error, setError] = useState(null);

  // New/removed spec files land as chokidar events — refetch the list.
  useEffect(() => { if (fileEventNonce) reload(); }, [fileEventNonce, reload]);
  // Parent hides the whole section (header included) when there are no apps.
  useEffect(() => { onCountChange?.(apps.length); }, [apps.length, onCountChange]);

  const doDelete = async (app) => {
    setPendingDelete(null);
    setError(null);
    try {
      const resp = await fetch(`${LIST_URL}/${encodeURIComponent(app.id)}`, { method: 'DELETE' });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        setError(err.error || `delete: HTTP ${resp.status}`);
        return;
      }
      if (selected?.type === 'miniapp' && selected?.path === app.id) onSelect(null);
      reload();
    } catch (err) {
      setError(err.message);
    }
  };

  const doRename = async () => {
    const { id, value } = renaming || {};
    setRenaming(null);
    const name = (value || '').trim();
    if (!id || !name) return;
    setError(null);
    try {
      const resp = await fetch(`${LIST_URL}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        setError(err.error || `rename: HTTP ${resp.status}`);
        return;
      }
      reload();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="flex flex-col gap-px pb-1">
      {error && (
        <div className="mx-1 mb-1 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] leading-relaxed text-destructive">
          {error}
        </div>
      )}
      {apps.map((app) => {
        const active = selected?.type === 'miniapp' && selected?.path === app.id;
        const isRenaming = renaming?.id === app.id;
        return (
          <div
            key={app.id}
            className={cn(
              'group relative flex items-center gap-2 rounded-md pl-2.5 pr-1.5 transition-colors duration-150',
              'h-9 md:h-7 text-[14px] md:text-[13px]',
              active
                ? 'bg-sidebar-accent font-medium text-foreground'
                : 'text-foreground/75 hover:bg-sidebar-accent/55 hover:text-foreground',
            )}
          >
            {active && (
              <span className="pointer-events-none absolute inset-y-1 left-0 w-[2px] rounded-r-full bg-[--color-ring]" />
            )}
            <LayoutGrid
              className={cn(
                'size-[14px] shrink-0 transition-colors',
                active ? 'text-[--color-ring]' : 'text-foreground/50 group-hover:text-foreground/70',
              )}
              strokeWidth={1.75}
            />
            {isRenaming ? (
              <input
                autoFocus
                value={renaming.value}
                onChange={(e) => setRenaming({ id: app.id, value: e.target.value })}
                onBlur={doRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') doRename();
                  if (e.key === 'Escape') setRenaming(null);
                }}
                className="min-w-0 flex-1 rounded border border-border/60 bg-background px-1 py-0.5 text-[12.5px] outline-none focus:border-[--color-ring]"
              />
            ) : (
              <button
                type="button"
                onClick={() => onSelect({ path: app.id, type: 'miniapp' })}
                className="min-w-0 flex-1 truncate text-left"
                title={app.name}
              >
                {app.name}
              </button>
            )}
            {!isRenaming && (
              <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                <RowAction title="Rename" icon={Pencil} onClick={() => setRenaming({ id: app.id, value: app.name })} />
                <RowAction title="Delete" icon={Trash2} danger onClick={() => setPendingDelete(app)} />
              </span>
            )}
          </div>
        );
      })}

      <AlertDialog open={!!pendingDelete} onOpenChange={(v) => { if (!v) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete mini app?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium text-foreground/85">{pendingDelete?.name}</span>
              {' '}will be removed from your sidebar permanently. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => doDelete(pendingDelete)}
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

function RowAction({ title, icon: Icon, onClick, danger }) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cn(
        'flex size-6 items-center justify-center rounded transition-colors',
        danger
          ? 'text-muted-foreground/55 hover:bg-destructive/10 hover:text-destructive'
          : 'text-muted-foreground/55 hover:bg-sidebar-accent hover:text-foreground/80',
      )}
    >
      <Icon className="size-[13px]" strokeWidth={1.75} />
    </button>
  );
}
