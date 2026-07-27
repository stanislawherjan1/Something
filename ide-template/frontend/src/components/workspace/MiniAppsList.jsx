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
import {
  LayoutGrid, Pencil, Trash2, Loader2,
  ShoppingCart, TrendingUp, Calendar, CheckSquare, Mail, Users, Package,
  DollarSign, CloudSun, Globe, Zap, Heart, Star, ListTodo, BarChart3, Clock,
} from 'lucide-react';

// Curated icon set the AI picks from (save_as_tab `icon` arg). Names are
// kebab-case lucide ids; anything unknown falls back to LayoutGrid.
const ICONS = {
  'layout-grid': LayoutGrid,
  'shopping-cart': ShoppingCart,
  'trending-up': TrendingUp,
  'bar-chart': BarChart3,
  'calendar': Calendar,
  'check-square': CheckSquare,
  'list-todo': ListTodo,
  'mail': Mail,
  'users': Users,
  'package': Package,
  'dollar-sign': DollarSign,
  'cloud-sun': CloudSun,
  'globe': Globe,
  'zap': Zap,
  'heart': Heart,
  'star': Star,
  'clock': Clock,
};
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
  // Ghost "Building app…" row — driven by ChatPanel the instant a
  // start_tab/save_as_tab tool call begins, i.e. BEFORE any file exists for
  // the watcher to see. Set of in-flight chip ids; non-empty → ghost shows.
  const [buildingChips, setBuildingChips] = useState(() => new Set());

  useEffect(() => {
    const onBuilding = (e) => {
      const { chipId, active } = e?.detail || {};
      if (!chipId) return;
      setBuildingChips((prev) => {
        const next = new Set(prev);
        if (active) next.add(chipId); else next.delete(chipId);
        return next;
      });
    };
    window.addEventListener('ide:miniapp-building', onBuilding);
    return () => window.removeEventListener('ide:miniapp-building', onBuilding);
  }, []);

  // Ghost is redundant once a real placeholder row (status:building) exists.
  const showGhost = buildingChips.size > 0 && !apps.some(a => a.status === 'building');

  // New/removed spec files land as chokidar events — refetch the list.
  useEffect(() => { if (fileEventNonce) reload(); }, [fileEventNonce, reload]);
  // Parent hides the whole section (header included) when there are no apps.
  // The ghost counts — the section must reveal itself for a first-ever build.
  useEffect(() => {
    onCountChange?.(apps.length + (showGhost ? 1 : 0));
  }, [apps.length, showGhost, onCountChange]);

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
      {showGhost && (
        <div className={cn(
          'group relative flex items-center gap-2.5 rounded-md pl-2.5 pr-1.5',
          'h-10 md:h-8 text-[14.5px] md:text-[13.5px] text-foreground/55',
        )}>
          <Loader2 className="size-[15px] shrink-0 animate-spin text-[--color-ring]" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate italic">Building app…</span>
        </div>
      )}
      {apps.map((app) => {
        const active = selected?.type === 'miniapp' && selected?.path === app.id;
        const building = app.status === 'building';
        const Icon = building ? Loader2 : (ICONS[app.icon] || LayoutGrid);
        // Strict null check — `renaming?.id === app.id` would be TRUE for a
        // row with an undefined id when renaming is null (undefined ===
        // undefined), rendering the input with `renaming.value` → crash.
        const isRenamingRow = renaming != null && renaming.id === app.id;
        return (
          <div
            key={app.id}
            className={cn(
              // Mirror the Shortcuts rows (Team/Tasks) exactly — same height,
              // type scale, icon size and active-bar metrics, so Mini Apps
              // reads as one system with the rest of the sidebar.
              'group relative flex items-center gap-2.5 rounded-md pl-2.5 pr-1.5 transition-colors duration-150',
              'h-10 md:h-8 text-[14.5px] md:text-[13.5px]',
              active
                ? 'bg-sidebar-accent font-medium text-foreground'
                : 'text-foreground/75 hover:bg-sidebar-accent/55 hover:text-foreground',
            )}
          >
            {active && (
              <span className="pointer-events-none absolute inset-y-1.5 left-0 w-[2px] rounded-r-full bg-[--color-ring]" />
            )}
            <Icon
              className={cn(
                'size-[15px] shrink-0 transition-colors',
                building && 'animate-spin text-[--color-ring]',
                !building && (active ? 'text-[--color-ring]' : 'text-foreground/55 group-hover:text-foreground/75'),
              )}
              strokeWidth={1.75}
            />
            {isRenamingRow ? (
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
                className={cn('min-w-0 flex-1 truncate text-left', building && 'text-foreground/55 italic')}
                title={building ? `${app.name} — building…` : app.name}
              >
                {app.name}
              </button>
            )}
            {!isRenamingRow && (
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
