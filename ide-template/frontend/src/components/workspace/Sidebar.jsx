import { useState, useCallback, useRef } from 'react';
import {
  ChevronRight, Hexagon, KanbanSquare, Images,
  Wrench, Plug, Repeat, UsersRound, Inbox, Search,
  FilePlus, FolderPlus,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import WorkspaceHeader from './WorkspaceHeader.jsx';
import FileTree from './FileTree.jsx';
import UserMenu from './UserMenu.jsx';
import DeleteConfirm from './dialogs/DeleteConfirm.jsx';
import MiniAppsList from './MiniAppsList.jsx';
import useNotifications from './useNotifications.js';
import useNotificationReadState from './useNotificationReadState.js';
import useMe from './useMe.js';

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
  // creating.parentPath = '' for the team root; me.personalRoot for the
  // personal-section root; or e.g. 'Knowledge base/Docs' for a subfolder
  // (right-click → New file/folder on that folder).
  const [creating,      setCreating]      = useState(null);   // { kind: 'file'|'folder', parentPath: string } | null
  const [opError,       setOpError]       = useState(null);
  const [optimisticEntry, setOptimisticEntry] = useState(null);
  // Whether the shared/team file root is empty — drives the always-visible
  // create actions in the section header (the empty-state arrow points at them).
  const [sharedEmpty,   setSharedEmpty]   = useState(false);
  const [expandedSections, setExpandedSections] = useState(() => {
    // Persist expanded/collapsed state in localStorage
    try {
      const saved = localStorage.getItem('sidebar-sections');
      const parsed = saved ? JSON.parse(saved) : null;
      return { shared: true, personal: true, miniapps: true, ...(parsed || {}) };
    } catch { return { shared: true, personal: true, miniapps: true }; }
  });
  // How many AI-built mini apps exist — 0 hides the whole section (header
  // included) so users without apps never see an empty group.
  const [miniAppCount, setMiniAppCount] = useState(0);
  const { me } = useMe();   // { email, slug, role, displayName, isAdmin, personalRoot }

  // Once a Files section has been expanded, keep its FileTree MOUNTED (just
  // hidden via CSS when collapsed) so collapsing+re-expanding doesn't re-fetch
  // and flash the skeleton every time. Lazy: not mounted until first opened.
  const everExpanded = useRef({ shared: false, personal: false });
  if (expandedSections.shared)   everExpanded.current.shared = true;
  if (expandedSections.personal) everExpanded.current.personal = true;

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

  const toggleSection = useCallback((section) => {
    setExpandedSections(prev => {
      const next = { ...prev, [section]: !prev[section] };
      localStorage.setItem('sidebar-sections', JSON.stringify(next));
      return next;
    });
  }, []);

  return (
    <aside className={cn("flex min-h-0 flex-col bg-sidebar text-sidebar-foreground border-r border-[--color-sidebar-border] overflow-visible", className)}>
      <WorkspaceHeader onCollapseSidebar={onCollapseSidebar} onHome={onHome} />
      <div className="h-px bg-[--color-sidebar-border]/70" />
      <Shortcuts selected={selected} onSelect={onSelect} />
      {opError && (
        <div className="mx-3 mb-1 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] leading-relaxed text-destructive">
          {opError}
        </div>
      )}
      <div className="scrollbar-hidden flex-1 overflow-x-hidden overflow-y-auto px-2 pb-3">
        {/* Team mode: shared "Workspace" files (the project root) and, when the
            user is identified, their private "Personal" files (users/<slug>/).
            The system-files toggle is admin-only — backend forces it off for
            everyone else (lib/file-scope.js). */}
        <FilesSectionHeader
          label={me?.teamMode ? 'Shared Files' : 'Files'}
          expanded={expandedSections.shared}
          onToggle={() => toggleSection('shared')}
          onNewFile={() => { if (!expandedSections.shared) toggleSection('shared'); setCreating({ kind: 'file', parentPath: '' }); }}
          onNewFolder={() => { if (!expandedSections.shared) toggleSection('shared'); setCreating({ kind: 'folder', parentPath: '' }); }}
          // Exception to the hover-only rule: when the root is empty, keep the
          // create actions visible so the empty-state arrow has a real target.
          forceActions={sharedEmpty && expandedSections.shared}
        />
        {everExpanded.current.shared && (
          <div className={cn(!expandedSections.shared && 'hidden')}>
            <FileTree
              rootPath=""
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
              onEmptyChange={setSharedEmpty}
            />
          </div>
        )}

        {/* AI-built mini apps — always mounted (the list drives miniAppCount,
            so a freshly built first app can reveal the section), but the
            header/body only show once at least one app exists. */}
        <div className={cn(miniAppCount === 0 && 'hidden')}>
          <FilesSectionHeader
            label="Your Mini Apps"
            expanded={expandedSections.miniapps}
            onToggle={() => toggleSection('miniapps')}
          />
        </div>
        <div className={cn((miniAppCount === 0 || !expandedSections.miniapps) && 'hidden')}>
          <MiniAppsList
            selected={selected}
            onSelect={onSelect}
            fileEventNonce={fileEventNonce}
            onCountChange={setMiniAppCount}
          />
        </div>

        {me?.personalRoot && (
          <>
            <FilesSectionHeader
              label="Your Files"
              expanded={expandedSections.personal}
              onToggle={() => toggleSection('personal')}
            />
            {everExpanded.current.personal && (
              <div className={cn(!expandedSections.personal && 'hidden')}>
                <FileTree
                  rootPath={me.personalRoot}
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
            )}
          </>
        )}
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
          onClick={() => onSelect({ path: '.claude/responsibilities', type: 'responsibilities' })}
          className={cn(
            'group relative flex w-full items-center gap-2.5 rounded-md pl-2.5 pr-9 transition-colors duration-150',
            'h-10 md:h-8 text-[14.5px] md:text-[13.5px]',
            selected?.type === 'responsibilities'
              ? 'bg-sidebar-accent font-medium text-foreground'
              : 'text-foreground/75 hover:bg-sidebar-accent/55 hover:text-foreground',
          )}
        >
          {selected?.type === 'responsibilities' && (
            <span className="pointer-events-none absolute inset-y-1.5 left-0 w-[2px] rounded-r-full bg-[--color-ring]" />
          )}
          <Repeat
            className={cn(
              'size-[15px] shrink-0 transition-colors',
              selected?.type === 'responsibilities' ? 'text-[--color-ring]' : 'text-foreground/55 group-hover:text-foreground/75',
            )}
            strokeWidth={1.75}
          />
          <span>Routines</span>
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
    key: 'search',
    label: 'Search',
    icon: Search,
    action: 'search',   // opens the command palette instead of selecting a view
    match: () => false,
  },
  {
    key: 'notifications',
    label: 'Notifications',
    icon: Inbox,
    target: { path: '.notifications', type: 'notifications' },
    match: (sel) => sel?.type === 'notifications',
  },
  {
    key: 'team',
    label: 'Team',
    icon: UsersRound,
    target: { path: '.claude/team', type: 'team' },
    match: (sel) => sel?.type === 'team',
  },
  {
    key: 'tasks',
    label: 'Tasks',
    icon: KanbanSquare,
    target: { path: 'Tasks.md', type: 'file' },
    match: (sel) => sel?.path === 'Tasks.md',
  },
  // Gallery hidden for now.
  // {
  //   key: 'gallery',
  //   label: 'Gallery',
  //   icon: Images,
  //   target: { path: 'generated', type: 'dir' },
  //   match: (sel) => sel?.path === 'generated' || sel?.path?.startsWith('generated/'),
  // },
];

function Shortcuts({ selected, onSelect }) {
  const { notifications } = useNotifications();
  const { isRead } = useNotificationReadState();
  const hasUnread = notifications.some((n) => !isRead(n.id));

  return (
    <div className="flex flex-col gap-0.5 px-2 pt-3 pb-1">
      {SHORTCUTS.map(item => {
        const active = item.match(selected);
        const Icon = item.icon;
        const showDot = item.key === 'notifications' && hasUnread && !active;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => item.action === 'search'
              ? window.dispatchEvent(new CustomEvent('ide:open-search'))
              : onSelect(item.target)}
            className={cn(
              'group relative flex items-center gap-2.5 rounded-md pl-2.5 pr-3 transition-colors duration-150',
              'h-10 md:h-8 text-[14.5px] md:text-[13.5px]',
              item.groupBreak && 'mt-3',
              active
                ? 'bg-sidebar-accent font-medium text-foreground'
                : 'text-foreground/75 hover:bg-sidebar-accent/55 hover:text-foreground',
            )}
          >
            {active && (
              <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-r-full bg-[--color-ring]" />
            )}
            <span className="relative shrink-0">
              <Icon
                className={cn(
                  'size-[15px] transition-colors',
                  active ? 'text-[--color-ring]' : 'text-foreground/55 group-hover:text-foreground/75',
                )}
                strokeWidth={1.75}
              />
              {showDot && (
                <span
                  className="absolute -right-1 -top-1 size-2 rounded-full bg-red-500 ring-2 ring-sidebar"
                  aria-label="Unread notifications"
                />
              )}
            </span>
            <span className="flex-1 text-left">{item.label}</span>
            {item.action === 'search' && (
              <kbd className="hidden rounded border border-border/55 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/60 md:inline-block">⌘K</kbd>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ─── Files toolbar ─────────────────────────────────────────────────────── */

// Section header for a file group (Workspace / Personal). New-file/folder
// buttons target this section's root. The system-files toggle is rendered only
// when onToggleHidden is supplied — the Sidebar passes it for the Workspace
// header and only to admins.
function FilesSectionHeader({ label, expanded, onToggle, onNewFile, onNewFolder, forceActions }) {
  // The create actions are deliberately NOT a hover affordance — they surface
  // ONLY in the empty-workspace scenario (forceActions), where the empty-state
  // arrow points right at them. Everywhere else, file/folder creation lives in
  // the row right-click menu.
  return (
    <div className="mt-3 flex h-9 items-center gap-0.5 rounded pr-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded pl-2.5 cursor-pointer hover:bg-sidebar-accent/30 transition-colors"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 transition-transform text-muted-foreground/50',
            expanded && 'rotate-90'
          )}
          strokeWidth={2}
        />
        <span className="select-none text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/65">
          {label}
        </span>
      </button>
      {forceActions && (
        <div className="flex shrink-0 items-center gap-0.5">
          {onNewFile && <SectionAction title="New file" icon={FilePlus} onClick={onNewFile} />}
          {onNewFolder && <SectionAction title="New folder" icon={FolderPlus} onClick={onNewFolder} />}
        </div>
      )}
    </div>
  );
}

function SectionAction({ title, icon: Icon, onClick }) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="flex size-6 items-center justify-center rounded-md text-muted-foreground/55 transition-colors hover:bg-sidebar-accent/55 hover:text-foreground/80"
    >
      <Icon className="size-[14px]" strokeWidth={1.75} />
    </button>
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
