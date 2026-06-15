import { useState, useCallback } from 'react';
import {
  Eye, EyeOff, Hexagon, KanbanSquare, Images,
  FilePlus, FolderPlus, Wrench, Plug, Bell, Users, Inbox,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import WorkspaceHeader from './WorkspaceHeader.jsx';
import FileTree from './FileTree.jsx';
import UserMenu from './UserMenu.jsx';
import DeleteConfirm from './dialogs/DeleteConfirm.jsx';
import InlineCreateRow from './InlineCreateRow.jsx';

/**
 * Sidebar — left column.
 *
 *   ┌ WorkspaceHeader (icon + brand)
 *   ├ Shortcuts (AI Settings, Tasks, Gallery — functional views)
 *   ├ Files toolbar (+file, +folder, eye toggle)
 *   ├ Inline create row (when creating a new file/folder)
 *   ├ FileTree (user files only — functional paths filtered out)
 *   └ UserMenu footer (avatar + dropdown)
 *
 * Reminders are surfaced inside the AI Settings dashboard, not as a top-level
 * shortcut here — the dashboard is the single hub for things the user
 * configures about the assistant.
 */
export default function Sidebar({
  selected, onSelect, onHome,
  showHidden, onToggleHidden,
  onCollapseSidebar,
  fileEventNonce,
  className
}) {
  const [pendingDelete, setPendingDelete] = useState(null);   // { path, type } | null
  // creating.parentPath = '' for root; or e.g. 'Knowledge base/Docs' to create
  // inside a subfolder (right-click → New file/folder on that folder).
  const [creating,      setCreating]      = useState(null);   // { kind: 'file'|'folder', parentPath: string } | null
  const [opError,       setOpError]       = useState(null);
  const [optimisticEntry, setOptimisticEntry] = useState(null);

  const handleDelete = useCallback(async ({ path }) => {
    setPendingDelete(null);
    setOpError(null);
    try {
      const resp = await fetch(`/api/files/delete?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        setOpError(err.error || `delete: HTTP ${resp.status}`);
        return;
      }
      if (selected?.path === path || selected?.path?.startsWith(path + '/')) {
        onSelect(null);
      }
    } catch (err) {
      setOpError(err.message);
    }
  }, [selected, onSelect]);

  const handleMove = useCallback(async ({ from, to }) => {
    setOpError(null);
    try {
      const resp = await fetch('/api/files/move', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ from, to }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        setOpError(err.error || `move: HTTP ${resp.status}`);
        return false;
      }
      if (selected?.path === from) onSelect({ ...selected, path: to });
      else if (selected?.path?.startsWith(from + '/')) {
        onSelect({ ...selected, path: to + selected.path.slice(from.length) });
      }
      return true;
    } catch (err) {
      setOpError(err.message);
      return false;
    }
  }, [selected, onSelect]);

  const handleCreate = useCallback(async ({ kind, name, parentPath }) => {
    setCreating(null);
    setOpError(null);
    const fullPath = parentPath ? `${parentPath}/${name}` : name;
    // Optimistic entry tagged with parentPath so the right DirNode picks
    // it up — empty string for root, e.g. 'Knowledge base' for a subfolder.
    setOptimisticEntry({
      name,
      type: kind === 'folder' ? 'dir' : 'file',
      parentPath: parentPath || '',
      optimistic: true,
    });
    try {
      const endpoint = kind === 'folder' ? '/api/files/mkdir' : '/api/files/create';
      const resp = await fetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ path: fullPath }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setOpError(data.error || `create: HTTP ${resp.status}`);
        return;
      }
      if (kind === 'file') onSelect({ path: data.path, type: 'file' });
    } catch (err) {
      setOpError(err.message);
    } finally {
      setTimeout(() => setOptimisticEntry(null), 2000);
    }
  }, [onSelect]);

  return (
    <aside className={cn("flex min-h-0 flex-col bg-sidebar text-sidebar-foreground border-r border-[--color-sidebar-border] overflow-visible", className)}>
      <WorkspaceHeader onCollapseSidebar={onCollapseSidebar} onHome={onHome} />
      <div className="h-px bg-[--color-sidebar-border]/70" />
      <Shortcuts selected={selected} onSelect={onSelect} />
      <SidebarToolbar
        showHidden={showHidden}
        onToggleHidden={onToggleHidden}
        onNewFile={() => setCreating({ kind: 'file', parentPath: '' })}
        onNewFolder={() => setCreating({ kind: 'folder', parentPath: '' })}
      />
      {opError && (
        <div className="mx-3 mb-1 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] leading-relaxed text-destructive">
          {opError}
        </div>
      )}
      <div className="scrollbar-hidden flex-1 overflow-x-hidden overflow-y-auto px-2 pb-3">
        {creating && creating.parentPath === '' && (
          <InlineCreateRow
            kind={creating.kind}
            depth={1}
            onSubmit={({ kind, name }) => handleCreate({ kind, name, parentPath: '' })}
            onCancel={() => setCreating(null)}
          />
        )}
        <FileTree
          selected={selected}
          onSelect={onSelect}
          onRequestDelete={setPendingDelete}
          onMove={handleMove}
          onCreate={(parentPath, kind) => setCreating({ kind, parentPath })}
          creating={creating}
          onCreateSubmit={handleCreate}
          onCreateCancel={() => setCreating(null)}
          showHidden={showHidden}
          fileEventNonce={fileEventNonce}
          isCreating={!!creating}
          optimisticEntry={optimisticEntry}
        />
      </div>
      <div className="h-px bg-[--color-sidebar-border]/70" />
      <div className="flex flex-col gap-0.5 px-2 py-2">
        <button
          type="button"
          onClick={() => onSelect({ path: '.claude', type: 'dashboard' })}
          className={cn(
            'group relative flex w-full items-center gap-2.5 rounded-md pl-2.5 pr-9 transition-colors duration-150',
            'h-10 md:h-8 text-[14.5px] md:text-[13.5px]',
            selected?.type === 'dashboard'
              ? 'bg-sidebar-accent font-medium text-foreground'
              : 'text-foreground/75 hover:bg-sidebar-accent/55 hover:text-foreground',
          )}
        >
          {selected?.type === 'dashboard' && (
            <span className="pointer-events-none absolute inset-y-1.5 left-0 w-[2px] rounded-r-full bg-[--color-ring]" />
          )}
          <Hexagon
            className={cn(
              'size-[15px] shrink-0 transition-colors',
              selected?.type === 'dashboard' ? 'text-[--color-ring]' : 'text-foreground/55 group-hover:text-foreground/75',
            )}
            strokeWidth={1.75}
          />
          <span>AI Settings</span>
        </button>
        <button
          type="button"
          onClick={() => onSelect({ path: '.claude/skills', type: 'skills' })}
          className={cn(
            'group relative flex w-full items-center gap-2.5 rounded-md pl-2.5 pr-9 transition-colors duration-150',
            'h-10 md:h-8 text-[14.5px] md:text-[13.5px]',
            selected?.type === 'skills'
              ? 'bg-sidebar-accent font-medium text-foreground'
              : 'text-foreground/75 hover:bg-sidebar-accent/55 hover:text-foreground',
          )}
        >
          {selected?.type === 'skills' && (
            <span className="pointer-events-none absolute inset-y-1.5 left-0 w-[2px] rounded-r-full bg-[--color-ring]" />
          )}
          <Wrench
            className={cn(
              'size-[15px] shrink-0 transition-colors',
              selected?.type === 'skills' ? 'text-[--color-ring]' : 'text-foreground/55 group-hover:text-foreground/75',
            )}
            strokeWidth={1.75}
          />
          <span>Skills</span>
        </button>
        <button
          type="button"
          onClick={() => onSelect({ path: '.claude/integrations', type: 'integrations' })}
          className={cn(
            'group relative flex w-full items-center gap-2.5 rounded-md pl-2.5 pr-9 transition-colors duration-150',
            'h-10 md:h-8 text-[14.5px] md:text-[13.5px]',
            selected?.type === 'integrations'
              ? 'bg-sidebar-accent font-medium text-foreground'
              : 'text-foreground/75 hover:bg-sidebar-accent/55 hover:text-foreground',
          )}
        >
          {selected?.type === 'integrations' && (
            <span className="pointer-events-none absolute inset-y-1.5 left-0 w-[2px] rounded-r-full bg-[--color-ring]" />
          )}
          <Plug
            className={cn(
              'size-[15px] shrink-0 transition-colors',
              selected?.type === 'integrations' ? 'text-[--color-ring]' : 'text-foreground/55 group-hover:text-foreground/75',
            )}
            strokeWidth={1.75}
          />
          <span>Integrations</span>
        </button>
        <button
          type="button"
          onClick={() => onSelect({ path: '.claude/team', type: 'team' })}
          className={cn(
            'group relative flex w-full items-center gap-2.5 rounded-md pl-2.5 pr-9 transition-colors duration-150',
            'h-10 md:h-8 text-[14.5px] md:text-[13.5px]',
            selected?.type === 'team'
              ? 'bg-sidebar-accent font-medium text-foreground'
              : 'text-foreground/75 hover:bg-sidebar-accent/55 hover:text-foreground',
          )}
        >
          {selected?.type === 'team' && (
            <span className="pointer-events-none absolute inset-y-1.5 left-0 w-[2px] rounded-r-full bg-[--color-ring]" />
          )}
          <Users
            className={cn(
              'size-[15px] shrink-0 transition-colors',
              selected?.type === 'team' ? 'text-[--color-ring]' : 'text-foreground/55 group-hover:text-foreground/75',
            )}
            strokeWidth={1.75}
          />
          <span>Team</span>
        </button>
      </div>
      <div className="p-2">
        <UserMenu />
      </div>

      <DeleteConfirm
        target={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={handleDelete}
      />
    </aside>
  );
}

/* ─── Functional shortcuts (top of sidebar) ─────────────────────────────── */

const SHORTCUTS = [
  {
    key: 'tasks',
    label: 'Tasks',
    icon: KanbanSquare,
    target: { path: 'Tasks.md', type: 'file' },
    match: (sel) => sel?.path === 'Tasks.md',
  },
  {
    key: 'notifications',
    label: 'Notifications',
    icon: Inbox,
    target: { path: '.notifications', type: 'notifications' },
    match: (sel) => sel?.type === 'notifications',
  },
  {
    key: 'reminders',
    label: 'Reminders',
    icon: Bell,
    target: { path: '.claude/reminders', type: 'reminders' },
    match: (sel) => sel?.type === 'reminders',
  },
  {
    key: 'gallery',
    label: 'Gallery',
    icon: Images,
    target: { path: 'generated', type: 'dir' },
    match: (sel) => sel?.path === 'generated' || sel?.path?.startsWith('generated/'),
  },
];

function Shortcuts({ selected, onSelect }) {
  return (
    <div className="flex flex-col gap-0.5 px-2 pt-2 pb-1">
      {SHORTCUTS.map(item => {
        const active = item.match(selected);
        const Icon = item.icon;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onSelect(item.target)}
            className={cn(
              'group relative flex items-center gap-2.5 rounded-md pl-2.5 pr-9 transition-colors duration-150',
              'h-10 md:h-8 text-[14.5px] md:text-[13.5px]',
              active
                ? 'bg-sidebar-accent font-medium text-foreground'
                : 'text-foreground/75 hover:bg-sidebar-accent/55 hover:text-foreground',
            )}
          >
            {active && (
              <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-r-full bg-[--color-ring]" />
            )}
            <Icon
              className={cn(
                'size-[15px] shrink-0 transition-colors',
                active ? 'text-[--color-ring]' : 'text-foreground/55 group-hover:text-foreground/75',
              )}
              strokeWidth={1.75}
            />
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ─── Files toolbar ─────────────────────────────────────────────────────── */

function SidebarToolbar({ showHidden, onToggleHidden, onNewFile, onNewFolder }) {
  const EyeIcon = showHidden ? EyeOff : Eye;
  return (
    <div className="flex items-center justify-between px-3 pt-3 max-md:pt-4 h-9 max-md:h-12">
      <span className="select-none text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/65">
        Files
      </span>
      <div className="flex items-center gap-0.5">
        <ToolbarButton onClick={onNewFile}   title="New note"   icon={FilePlus} />
        <ToolbarButton onClick={onNewFolder} title="New folder" icon={FolderPlus} />
        <ToolbarButton
          onClick={onToggleHidden}
          title={showHidden ? 'Hide technical files' : 'Show technical files'}
          icon={EyeIcon}
          active={showHidden}
        />
      </div>
    </div>
  );
}

function ToolbarButton({ onClick, title, icon: Icon, active }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'flex items-center justify-center rounded-md transition-colors duration-150',
        'size-8 md:size-6',
        active
          ? 'bg-sidebar-accent/70 text-foreground/85'
          : 'text-muted-foreground/55 hover:bg-sidebar-accent/55 hover:text-foreground/80',
      )}
    >
      <Icon className="size-4 md:size-[14px]" strokeWidth={1.75} />
    </button>
  );
}
