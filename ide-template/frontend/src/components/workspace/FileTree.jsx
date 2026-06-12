import { useEffect, useRef, useState, useCallback } from 'react';
import {
  ChevronRight, Folder, FolderOpen, Trash2, Pencil, Download,
  FilePlus, FolderPlus,
  FileText, FileCode2, File as FileIcon, Image as ImageIcon, Table2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { SkeletonFileRow } from './SkeletonLoader.jsx';
import { useBranding } from './identity.jsx';
import ContextMenu from './ContextMenu.jsx';
import InlineCreateRow from './InlineCreateRow.jsx';

/**
 * FileTree — lazy directory listing of ~/project/ via /api/files/tree.
 *
 *   - showHidden=true: include technical/build dirs (node_modules, .git, …)
 *   - fileEventNonce bumps when /api/files/watch emits a change → open dirs
 *     re-fetch their entries.
 *   - selected = { path, type } so EditorPane knows whether to render a
 *     file viewer or a folder view (Gallery, etc.).
 *   - onRequestDelete({ path, type }) — trash icon click; parent shows
 *     confirmation dialog and calls the DELETE.
 *   - onMove({ from, to }) — drag-drop handler. Folders + the root area are
 *     drop targets; FileTree doesn't call the API itself, just emits intent.
 *
 * `.claude/` and entries in FUNCTIONAL_PATHS are intentionally NOT shown
 * here — they live as dedicated sidebar shortcuts.
 */

export const FUNCTIONAL_PATHS = new Set(['Tasks.md', 'generated', '.reminders.json']);

const DRAG_MIME = 'application/x-workspace-path';

export default function FileTree({ selected, onSelect, onRequestDelete, onMove, onCreate, creating, onCreateSubmit, onCreateCancel, showHidden, fileEventNonce, isCreating, optimisticEntry }) {
  return (
    <div className="flex flex-col gap-px py-1">
      <DirNode
        path=""
        depth={0}
        initiallyOpen
        selected={selected}
        onSelect={onSelect}
        onRequestDelete={onRequestDelete}
        onMove={onMove}
        onCreate={onCreate}
        creating={creating}
        onCreateSubmit={onCreateSubmit}
        onCreateCancel={onCreateCancel}
        showHidden={showHidden}
        fileEventNonce={fileEventNonce}
        isCreating={isCreating}
        optimisticEntry={optimisticEntry}
      />
    </div>
  );
}

function DirNode({ path, depth, initiallyOpen = false, selected, onSelect, onRequestDelete, onMove, onCreate, creating, onCreateSubmit, onCreateCancel, showHidden, fileEventNonce, isCreating, optimisticEntry }) {
  const [open, setOpen] = useState(initiallyOpen);

  // Auto-open when a create starts inside us so the new InlineCreateRow is
  // actually visible. Cancelling/submitting clears `creating` upstream and
  // we stay in whatever state we were in.
  useEffect(() => {
    if (creating?.parentPath === path && !open) setOpen(true);
  }, [creating, path, open]);
  const [entries, setEntries] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const branding = useBranding();

  const isRoot = path === '';

  // Folders (and the root) are drop targets. We accept only our own
  // drag-data (custom MIME), so external file drops are ignored.
  const acceptsDrop = (e) => {
    if (!onMove) return false;
    return e.dataTransfer?.types?.includes(DRAG_MIME);
  };
  const onDragOver = (e) => {
    if (!acceptsDrop(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(true);
  };
  const onDragLeave = () => setDragOver(false);
  const onDrop = (e) => {
    setDragOver(false);
    if (!acceptsDrop(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const from = e.dataTransfer.getData(DRAG_MIME);
    if (!from) return;
    const fromName = from.split('/').pop();
    const to = path ? `${path}/${fromName}` : fromName;
    if (from === to) return;                                    // same parent — no-op
    if (path && (from === path || path.startsWith(from + '/'))) return;  // dropped folder onto itself
    onMove({ from, to });
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (path) params.set('path', path);
      if (showHidden) params.set('include_hidden', 'true');
      const url = '/api/files/tree' + (params.toString() ? '?' + params.toString() : '');
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setEntries(data.entries);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [path, showHidden]);

  useEffect(() => {
    if (open) load();
  }, [open, load, fileEventNonce]);

  const onRowClick = () => {
    setOpen(o => !o);
  };

  const onRowDoubleClick = () => {
    if (!isRoot) onSelect({ path, type: 'dir' });
  };

  let combinedEntries = entries ? [...entries] : [];
  if (optimisticEntry?.parentPath === path && entries !== null) {
    if (!combinedEntries.some(e => e.name === optimisticEntry.name)) {
      combinedEntries.push(optimisticEntry);
      combinedEntries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }
  }

  const visibleEntries = combinedEntries.filter(
    e => !(isRoot && FUNCTIONAL_PATHS.has(e.name))
  );

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        isRoot && 'min-h-full',
        dragOver && 'rounded-md ring-2 ring-[--color-ring]/45 ring-offset-1 ring-offset-sidebar bg-[--color-ring]/[0.06]',
      )}
    >
      {!isRoot && (
        <RowButton
          depth={depth}
          onClick={onRowClick}
          onDoubleClick={onRowDoubleClick}
          icon={open ? FolderOpen : Folder}
          label={basename(path)}
          chevron={open}
          selected={selected?.path === path}
          path={path}
          type="dir"
          onDelete={() => onRequestDelete?.({ path, type: 'dir' })}
          onRename={onMove ? (newName) => onMove({
            from: path,
            to: parentDir(path) ? `${parentDir(path)}/${newName}` : newName,
          }) : undefined}
          onNewFile={onCreate ? () => onCreate(path, 'file') : undefined}
          onNewFolder={onCreate ? () => onCreate(path, 'folder') : undefined}
          draggablePath={path}
        />
      )}
      {open && (
        <>
          {loading && entries === null && (
            <div className="flex flex-col gap-1.5 px-2 py-1">
              {[...Array(4)].map((_, i) => (
                <SkeletonFileRow key={i} depth={depth + 1} />
              ))}
            </div>
          )}
          {error && <Hint depth={depth + 1} error>Error: {error}</Hint>}
          {creating?.parentPath === path && (
            <InlineCreateRow
              kind={creating.kind}
              depth={depth + 1}
              onSubmit={({ kind, name }) => onCreateSubmit({ kind, name, parentPath: path })}
              onCancel={onCreateCancel}
            />
          )}
          {entries && visibleEntries.length === 0 && isRoot && creating?.parentPath !== path && (
            <EmptyWorkspaceHint
              botDisplayName={branding.botDisplayName}
              isCreating={isCreating}
            />
          )}
          {visibleEntries.map(e => {
            const fullPath = path ? `${path}/${e.name}` : e.name;
            return (
              <div key={e.name} className={cn("rounded-md", e.optimistic && "opacity-50 transition-opacity")}>
                {e.type === 'dir' ? (
                  <DirNode
                    path={fullPath}
                    depth={depth + 1}
                    selected={selected}
                    onSelect={onSelect}
                    onRequestDelete={onRequestDelete}
                    onMove={onMove}
                    onCreate={onCreate}
                    creating={creating}
                    onCreateSubmit={onCreateSubmit}
                    onCreateCancel={onCreateCancel}
                    optimisticEntry={optimisticEntry}
                    showHidden={showHidden}
                    fileEventNonce={fileEventNonce}
                  />
                ) : (
                  <FileRow
                    path={fullPath}
                    name={e.name}
                    depth={depth + 1}
                    technical={e.technical}
                    selected={selected?.path === fullPath}
                    onSelect={onSelect}
                    onDelete={() => onRequestDelete?.({ path: fullPath, type: 'file' })}
                    onRename={onMove ? (newName) => onMove({
                      from: fullPath,
                      to: path ? `${path}/${newName}` : newName,
                    }) : undefined}
                  />
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function FileRow({ path, name, depth, technical, selected, onSelect, onDelete, onRename }) {
  return (
    <RowButton
      depth={depth}
      onClick={() => onSelect({ path, type: 'file' })}
      icon={iconFor(name)}
      label={name}
      selected={selected}
      muted={technical}
      path={path}
      type="file"
      onDelete={onDelete}
      onRename={onRename}
      draggablePath={path}
    />
  );
}

function RowButton({ depth, onClick, onDoubleClick, icon: Icon, label, chevron, selected, muted, path, type, onDelete, onRename, onNewFile, onNewFolder, draggablePath }) {
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu]         = useState(null);  // { x, y } | null
  const [editing, setEditing]   = useState(false);
  // While rename is in flight we render the new name immediately. Cleared
  // once the parent re-fetches and remounts this row (file watcher SSE).
  // On error we drop it ourselves so the original name comes back.
  const [pendingLabel, setPendingLabel] = useState(null);
  const displayLabel = pendingLabel ?? label;

  const onDragStart = draggablePath ? (e) => {
    e.dataTransfer.setData(DRAG_MIME, draggablePath);
    e.dataTransfer.effectAllowed = 'move';
    setDragging(true);
  } : undefined;
  const onDragEnd = draggablePath ? () => setDragging(false) : undefined;

  const hasActions = onDelete || onRename || path;
  const onContextMenu = hasActions ? (e) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  } : undefined;

  const downloadHref = path ? `/api/files/download?path=${encodeURIComponent(path)}` : null;
  const triggerDownload = () => {
    if (!downloadHref) return;
    // Anchor + click is the cross-browser way to fire a download with a
    // sensible filename; fetch + blob would lose the server's
    // Content-Disposition. The element never enters the DOM tree visibly.
    const a = document.createElement('a');
    a.href = downloadHref;
    a.rel  = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const menuItems = [];
  if (onNewFile)   menuItems.push({ id: 'new-file',   label: 'New file',   icon: FilePlus,   onSelect: onNewFile });
  if (onNewFolder) menuItems.push({ id: 'new-folder', label: 'New folder', icon: FolderPlus, onSelect: onNewFolder });
  if (onRename)    menuItems.push({ id: 'rename',     label: 'Rename',     icon: Pencil,     onSelect: () => setEditing(true) });
  if (path)        menuItems.push({ id: 'download',   label: 'Download',   icon: Download,   onSelect: triggerDownload });
  if (onDelete) menuItems.push({ id: 'delete',   label: 'Delete',   icon: Trash2,   danger: true, onSelect: onDelete });

  return (
    <div
      draggable={!!draggablePath && !editing}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onContextMenu={onContextMenu}
      className={cn(
        'group relative flex items-center rounded-md',
        'transition-colors duration-150',
        'h-10 md:h-7',
        dragging && 'opacity-40',
        selected
          ? 'bg-sidebar-accent text-foreground'
          : muted
            ? 'hover:bg-sidebar-accent/40'
            : 'hover:bg-sidebar-accent/55',
      )}
    >
      {selected && (
        <span className="pointer-events-none absolute inset-y-1 left-0 w-[2px] rounded-r-full bg-[--color-ring]" />
      )}
      <button
        type="button"
        onClick={editing ? undefined : onClick}
        onDoubleClick={editing ? undefined : onDoubleClick}
        style={{ paddingLeft: `${10 + depth * 12}px` }}
        className={cn(
          // `min-w-0` is what lets the label inside actually truncate; without
          // it the flex item grows to its content size and the parent grows
          // a horizontal scrollbar instead. `pr-2 → group-hover:pr-9` reserves
          // trash room only on hover, so wide labels can use the full width
          // when no action is showing.
          'flex h-full min-w-0 flex-1 items-center gap-1.5 pr-2 transition-[padding] duration-150',
          onDelete && !editing && 'group-hover:pr-9 group-focus-within:pr-9',
          'text-[14.5px] md:text-[13px]',
          selected
            ? 'font-medium text-foreground'
            : muted
              ? 'text-muted-foreground/65'
              : 'text-foreground/82',
        )}
      >
        {chevron !== undefined ? (
          <ChevronRight
            className={cn(
              'size-3 shrink-0 text-muted-foreground/55 transition-transform duration-150',
              chevron && 'rotate-90',
            )}
            strokeWidth={2.25}
          />
        ) : (
          <span className="inline-block size-3 shrink-0" />
        )}
        <Icon
          className={cn(
            'size-[14px] shrink-0',
            selected ? 'text-foreground/85' : 'text-muted-foreground/75',
          )}
          strokeWidth={1.75}
        />
        {editing && onRename ? (
          <RenameInput
            initial={label}
            type={type}
            onSubmit={async (newName) => {
              setEditing(false);
              if (!newName || newName === label) return;
              setPendingLabel(newName);
              const ok = await onRename(newName);
              // ok === false means the move endpoint rejected. Drop the
              // optimistic label so the row snaps back to the real name.
              if (ok === false) setPendingLabel(null);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-left',
              pendingLabel && 'opacity-60',
            )}
          >
            {displayLabel}
          </span>
        )}
      </button>
      {onDelete && !editing && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="Delete"
          className={cn(
            'absolute right-1 flex size-5 items-center justify-center rounded',
            'opacity-0 transition-all duration-150',
            'hover:bg-destructive/10 hover:text-destructive',
            'group-hover:opacity-100 focus-visible:opacity-100',
            'text-muted-foreground/55',
          )}
        >
          <Trash2 className="size-[13px]" strokeWidth={1.75} />
        </button>
      )}
      {menu && menuItems.length > 0 && (
        <ContextMenu position={menu} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

/** Inline rename input — replaces the row's label until Enter/Esc/blur. */
function RenameInput({ initial, type, onSubmit, onCancel }) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // For files, pre-select just the stem so users can retype the name and
    // keep the extension. For folders + dotfiles, select everything.
    const dot = type === 'file' ? initial.lastIndexOf('.') : -1;
    if (dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [initial, type]);

  const submit = () => {
    const clean = value.trim();
    if (!clean || clean === initial) { onCancel(); return; }
    if (clean.includes('/') || clean.includes('\\')) { onCancel(); return; }
    onSubmit(clean);
  };
  const onKeyDown = (e) => {
    if (e.key === 'Enter')      { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={submit}
      onClick={(e) => e.stopPropagation()}
      className="h-5 min-w-0 flex-1 border-b border-foreground/20 bg-transparent px-0.5 text-left text-[13px] outline-none focus-visible:border-foreground/50"
    />
  );
}

function EmptyWorkspaceHint({ botDisplayName, isCreating }) {
  if (isCreating) return null;
  return (
    <div className="relative mt-20 pl-2.5 pr-4 flex flex-col items-start text-left w-full">
      {/* Solid graphite grey, thicker, and shorter hand-drawn arrow */}
      <div className="absolute -top-[65px] right-11 text-muted-foreground pointer-events-none">
        <svg width="60" height="60" viewBox="0 0 60 60" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M 15 50 C 35 50 50 35 50 10" />
          {/* Unified arrow head (grot) */}
          <path d="M 38 20 L 50 10 L 58 22" />
        </svg>
      </div>

      <div className="flex flex-col gap-1.5 max-w-[210px] relative z-10">
        <span className="text-[14px] font-semibold text-foreground/90 tracking-tight">
          Your workspace is empty
        </span>
        <p className="text-[12.5px] leading-relaxed text-muted-foreground/75">
          Start by adding a folder or a new note, or ask <span className="font-medium text-foreground/85">{botDisplayName || 'Assistant'}</span> for help.
        </p>
      </div>
    </div>
  );
}

function Hint({ children, depth = 0, error }) {
  return (
    <div
      style={{ paddingLeft: `${10 + depth * 12}px` }}
      className={cn(
        'py-1 text-[12px] italic',
        error ? 'text-destructive' : 'text-muted-foreground/55',
      )}
    >
      {children}
    </div>
  );
}

function basename(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function parentDir(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function iconFor(name) {
  const ext = name.toLowerCase().split('.').pop();
  if (['md', 'mdx', 'txt', 'rst'].includes(ext)) return FileText;
  if (['csv', 'tsv'].includes(ext)) return Table2;
  if (['js', 'jsx', 'ts', 'tsx', 'py', 'sh', 'json', 'yml', 'yaml', 'toml', 'css', 'html'].includes(ext)) return FileCode2;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return ImageIcon;
  return FileIcon;
}
