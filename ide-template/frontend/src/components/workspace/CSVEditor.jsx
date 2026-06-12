import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Table2, Hexagon, Plus, Trash2, ChevronUp, ChevronDown, ChevronsUpDown, MoreHorizontal } from 'lucide-react';
import Papa from 'papaparse';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  createColumnHelper,
  flexRender,
} from '@tanstack/react-table';
import { cn } from '@/lib/utils';
import EditorHeader from './EditorHeader.jsx';

const columnHelper = createColumnHelper();

/**
 * CSVEditor — TanStack-powered spreadsheet view for `.csv` files.
 *
 * Parallels MarkdownEditor's lifecycle (load → debounced save → watcher refresh
 * without clobbering dirty edits → external-update flash badge), so users get
 * the same affordances regardless of file type.
 *
 * Editing model:
 *   - Single-cell edit at a time. Double-click to enter, Enter/Tab/blur commits,
 *     Escape cancels.
 *   - Header cells are also editable (double-click); commits the rename and
 *     immediately schedules a save.
 *   - Add row / add column buttons at the end of the table.
 *   - Per-row trash icon shows on hover (leading column).
 *   - Per-column delete from the header three-dot menu.
 *
 * Sorting model:
 *   - Click a header to toggle asc/desc/clear. TanStack reorders the *display*
 *     of rows; the underlying `rows` array keeps insertion order so adds and
 *     deletes still target the original index.
 *   - Tracked via `row.id` (TanStack's row id defaults to the original index).
 */
export default function CSVEditor({ path, fileEventNonce, sidebarOpen }) {
  const [status, setStatus] = useState({ kind: 'loading' });
  const [savedAt, setSavedAt] = useState(null);
  const [externalUpdate, setExternalUpdate] = useState(false);
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [sorting, setSorting] = useState([]);
  // editingCell = { row: number | 'header', col: number } | null
  const [editingCell, setEditingCell] = useState(null);

  const dirtyRef    = useRef(false);
  const savingRef   = useRef(false);
  const remoteMtime = useRef(0);
  const saveTimer   = useRef(null);
  const lastSavedCsv = useRef('');
  const updateFlashTimer = useRef(null);
  const hasInitializedRef = useRef(false);
  const isInitialLoad = useRef(true);

  useEffect(() => () => {
    if (saveTimer.current)        clearTimeout(saveTimer.current);
    if (updateFlashTimer.current) clearTimeout(updateFlashTimer.current);
  }, []);

  // Load + watcher refresh.
  useEffect(() => {
    const abortCtrl = new AbortController();

    const loadFile = async () => {
      try {
        const resp = await fetch(`/api/files/read?path=${encodeURIComponent(path)}`, { signal: abortCtrl.signal });
        const data = await resp.json().catch(() => ({}));

        if (!resp.ok) {
          setStatus({ kind: 'error', error: data.error || `HTTP ${resp.status}` });
          return;
        }

        // Keep unsaved local edits on watcher refresh.
        if (!isInitialLoad.current && dirtyRef.current) {
          remoteMtime.current = data.mtime ?? 0;
          return;
        }

        const csv = data.content || '';
        const changed = csv !== lastSavedCsv.current;
        const wasInitialized = hasInitializedRef.current;

        const parsed = Papa.parse(csv, {
          skipEmptyLines: false,
        });
        if (abortCtrl.signal.aborted) return;

        const allRows = parsed.data;
        // First row is the header. Empty file → one empty header + zero rows.
        const headerRow = (allRows[0] || ['column-1']).map((h, i) => h || `column-${i + 1}`);
        const bodyRows  = allRows.slice(1).filter(r => Array.isArray(r) && r.length > 0);

        // Normalise: every row must have len === headers.length (pad with '').
        const normalised = bodyRows.map(r => {
          const out = [];
          for (let i = 0; i < headerRow.length; i++) out.push((r[i] ?? '').toString());
          return out;
        });

        setHeaders(headerRow);
        setRows(normalised);
        lastSavedCsv.current = csv;
        remoteMtime.current = data.mtime ?? 0;
        isInitialLoad.current = false;
        setStatus({ kind: 'ok' });

        if (wasInitialized && changed) {
          setExternalUpdate(true);
          if (updateFlashTimer.current) clearTimeout(updateFlashTimer.current);
          updateFlashTimer.current = setTimeout(() => setExternalUpdate(false), 2400);
        }

        hasInitializedRef.current = true;
      } catch (err) {
        if (!abortCtrl.signal.aborted) setStatus({ kind: 'error', error: err.message });
      }
    };

    isInitialLoad.current = true;
    hasInitializedRef.current = false;
    dirtyRef.current = false;
    setSavedAt(null);
    setExternalUpdate(false);
    setEditingCell(null);
    setStatus({ kind: 'loading' });
    if (updateFlashTimer.current) clearTimeout(updateFlashTimer.current);
    if (saveTimer.current)        clearTimeout(saveTimer.current);

    loadFile();
    return () => { abortCtrl.abort(); };
  }, [path, fileEventNonce]);

  // Serialise + schedule save. Reads from the next-state values directly so
  // we don't race the React state queue.
  const scheduleSave = useCallback((nextHeaders, nextRows) => {
    dirtyRef.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const csv = Papa.unparse({ fields: nextHeaders, data: nextRows });
      if (csv === lastSavedCsv.current) {
        dirtyRef.current = false;
        return;
      }
      save(csv);
    }, 600);
  }, []);

  async function save(csv) {
    if (savingRef.current) {
      saveTimer.current = setTimeout(() => save(csv), 200);
      return;
    }
    savingRef.current = true;
    try {
      const resp = await fetch('/api/files/write', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ path, content: csv }),
      });
      if (resp.ok) {
        const data = await resp.json();
        lastSavedCsv.current = csv;
        dirtyRef.current = false;
        remoteMtime.current = data.mtime ?? 0;
        setSavedAt(Date.now());
      } else {
        const err = await resp.json().catch(() => ({}));
        setStatus({ kind: 'error', error: err.error || `HTTP ${resp.status}` });
      }
    } catch (err) {
      setStatus({ kind: 'error', error: err.message });
    } finally {
      savingRef.current = false;
    }
  }

  // ─── Mutations ─────────────────────────────────────────────────────────
  const commitCell = useCallback((rowIdx, colIdx, value) => {
    setRows(prev => {
      if (prev[rowIdx]?.[colIdx] === value) return prev;          // no-op
      const next = prev.map((r, i) => i === rowIdx ? [...r] : r);
      next[rowIdx][colIdx] = value;
      scheduleSave(headers, next);
      return next;
    });
  }, [headers, scheduleSave]);

  const commitHeader = useCallback((colIdx, value) => {
    setHeaders(prev => {
      if (prev[colIdx] === value) return prev;
      const next = [...prev];
      next[colIdx] = value || `column-${colIdx + 1}`;             // never blank
      scheduleSave(next, rows);
      return next;
    });
  }, [rows, scheduleSave]);

  const addRow = useCallback(() => {
    setRows(prev => {
      const next = [...prev, headers.map(() => '')];
      scheduleSave(headers, next);
      return next;
    });
  }, [headers, scheduleSave]);

  const addColumn = useCallback(() => {
    const newColName = `column-${headers.length + 1}`;
    setHeaders(prev => {
      const nextHeaders = [...prev, newColName];
      setRows(prevRows => {
        const nextRows = prevRows.map(r => [...r, '']);
        scheduleSave(nextHeaders, nextRows);
        return nextRows;
      });
      return nextHeaders;
    });
  }, [headers.length, scheduleSave]);

  const removeRow = useCallback((rowIdx) => {
    setRows(prev => {
      const next = prev.filter((_, i) => i !== rowIdx);
      scheduleSave(headers, next);
      return next;
    });
  }, [headers, scheduleSave]);

  const removeColumn = useCallback((colIdx) => {
    if (headers.length <= 1) return;                              // keep at least 1
    setHeaders(prev => {
      const nextHeaders = prev.filter((_, i) => i !== colIdx);
      setRows(prevRows => {
        const nextRows = prevRows.map(r => r.filter((_, i) => i !== colIdx));
        scheduleSave(nextHeaders, nextRows);
        return nextRows;
      });
      return nextHeaders;
    });
  }, [headers.length, scheduleSave]);

  // ─── TanStack column defs ──────────────────────────────────────────────
  const columns = useMemo(() => headers.map((header, colIdx) =>
    columnHelper.accessor(
      (row) => row[colIdx] ?? '',
      {
        id: `col-${colIdx}`,
        header: () => (
          <HeaderCell
            value={header}
            colIdx={colIdx}
            isEditing={editingCell?.row === 'header' && editingCell?.col === colIdx}
            onStartEdit={() => setEditingCell({ row: 'header', col: colIdx })}
            onCommit={(v) => { commitHeader(colIdx, v); setEditingCell(null); }}
            onCancel={() => setEditingCell(null)}
            onDelete={() => removeColumn(colIdx)}
            canDelete={headers.length > 1}
          />
        ),
        cell: (info) => {
          const rowIdx = parseInt(info.row.id, 10);
          return (
            <BodyCell
              value={info.getValue()}
              isEditing={editingCell?.row === rowIdx && editingCell?.col === colIdx}
              onStartEdit={() => setEditingCell({ row: rowIdx, col: colIdx })}
              onCommit={(v) => { commitCell(rowIdx, colIdx, v); setEditingCell(null); }}
              onCancel={() => setEditingCell(null)}
            />
          );
        },
      }
    )
  ), [headers, editingCell, commitCell, commitHeader, removeColumn]);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel:  getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (_row, idx) => String(idx),
  });

  const meta =
    status.kind === 'error'   ? <span className="text-destructive">Error: {status.error}</span> :
    status.kind === 'loading' ? 'Loading…' :
    externalUpdate            ? <UpdatedBadge /> :
    dirtyRef.current          ? 'Saving…' :
    savedAt                   ? 'Saved' : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={Table2} title={path} meta={meta} sidebarOpen={sidebarOpen} />
      <div
        className={cn(
          '@container/editor flex-1 overflow-auto transition-shadow duration-700',
          externalUpdate && 'ring-2 ring-emerald-500/40 ring-inset bg-emerald-500/[0.03]',
        )}
      >
        {status.kind !== 'error' && status.kind !== 'loading' && (
          <div className="px-4 py-4">
            <div className="inline-block min-w-full rounded-md border border-border/60 bg-card">
              <table className="border-collapse text-[13px] tabular-nums">
                <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm">
                  {table.getHeaderGroups().map(headerGroup => (
                    <tr key={headerGroup.id}>
                      {/* Leading gutter for row numbers */}
                      <th className="w-10 border-b border-r border-border/60 bg-muted/30 px-2 py-1.5 text-[11px] font-medium text-muted-foreground/60">
                        #
                      </th>
                      {headerGroup.headers.map(header => (
                        <th
                          key={header.id}
                          className="group/h relative border-b border-r border-border/60 bg-muted/20 px-0 text-left"
                        >
                          <div
                            className="flex cursor-pointer select-none items-center gap-1 px-2.5 py-1.5 hover:bg-muted/40"
                            onClick={() => header.column.toggleSorting()}
                          >
                            <div className="flex-1 min-w-0">
                              {flexRender(header.column.columnDef.header, header.getContext())}
                            </div>
                            <SortIndicator state={header.column.getIsSorted()} />
                          </div>
                        </th>
                      ))}
                      {/* Add-column button */}
                      <th className="border-b border-border/60 bg-muted/10 px-1 py-1">
                        <button
                          type="button"
                          onClick={addColumn}
                          className="inline-flex size-6 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:bg-muted/50 hover:text-foreground/80"
                          title="Add column"
                        >
                          <Plus className="size-3.5" strokeWidth={2} />
                        </button>
                      </th>
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {table.getRowModel().rows.map(row => {
                    const rowIdx = parseInt(row.id, 10);
                    return (
                      <tr key={row.id} className="group/row">
                        <td className="w-10 border-b border-r border-border/60 bg-muted/10 px-2 py-1 text-right text-[11px] text-muted-foreground/50 align-top">
                          <div className="flex items-center justify-between gap-1">
                            <button
                              type="button"
                              onClick={() => removeRow(rowIdx)}
                              className="inline-flex size-4 items-center justify-center rounded text-muted-foreground/0 transition-colors hover:text-destructive group-hover/row:text-muted-foreground/40"
                              title="Delete row"
                            >
                              <Trash2 className="size-3" strokeWidth={1.75} />
                            </button>
                            <span>{rowIdx + 1}</span>
                          </div>
                        </td>
                        {row.getVisibleCells().map(cell => (
                          <td key={cell.id} className="border-b border-r border-border/60 align-top">
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        ))}
                        <td className="border-b border-border/60" />
                      </tr>
                    );
                  })}
                  {/* Add-row affordance */}
                  <tr>
                    <td colSpan={columns.length + 2} className="px-2 py-1">
                      <button
                        type="button"
                        onClick={addRow}
                        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted-foreground/60 transition-colors hover:bg-muted/40 hover:text-foreground/85"
                      >
                        <Plus className="size-3.5" strokeWidth={2} />
                        Add row
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SortIndicator({ state }) {
  if (state === 'asc')  return <ChevronUp className="size-3 text-foreground/70" strokeWidth={2.5} />;
  if (state === 'desc') return <ChevronDown className="size-3 text-foreground/70" strokeWidth={2.5} />;
  return <ChevronsUpDown className="size-3 text-muted-foreground/30 opacity-0 group-hover/h:opacity-100 transition-opacity" strokeWidth={2} />;
}

function HeaderCell({ value, colIdx, isEditing, onStartEdit, onCommit, onCancel, onDelete, canDelete }) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef(null);

  useEffect(() => { if (isEditing) { setDraft(value); inputRef.current?.focus(); inputRef.current?.select(); } }, [isEditing, value]);

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onCommit(draft.trim())}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onCommit(draft.trim()); }
          else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
        onClick={(e) => e.stopPropagation()}
        className="w-full bg-transparent text-[13px] font-semibold text-foreground/90 outline-none focus:ring-1 focus:ring-foreground/30 rounded px-0.5"
      />
    );
  }

  return (
    <div className="flex items-center gap-1 min-w-0">
      <span
        className="truncate font-semibold text-foreground/85"
        onDoubleClick={(e) => { e.stopPropagation(); onStartEdit(); }}
        title="Double-click to rename"
      >
        {value}
      </span>
      {canDelete && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="ml-auto inline-flex size-4 items-center justify-center rounded text-muted-foreground/0 transition-colors hover:text-destructive group-hover/h:text-muted-foreground/50"
          title="Delete column"
        >
          <Trash2 className="size-3" strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}

function BodyCell({ value, isEditing, onStartEdit, onCommit, onCancel }) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef(null);

  useEffect(() => { if (isEditing) { setDraft(value); inputRef.current?.focus(); inputRef.current?.select(); } }, [isEditing, value]);

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onCommit(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); onCommit(draft); }
          else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
        className="w-full bg-transparent px-2.5 py-1.5 text-[13px] text-foreground/90 outline-none focus:ring-1 focus:ring-foreground/30 rounded-sm"
      />
    );
  }

  return (
    <div
      onDoubleClick={onStartEdit}
      className="px-2.5 py-1.5 cursor-text hover:bg-muted/20 min-h-[28px]"
      title="Double-click to edit"
    >
      {value || <span className="text-muted-foreground/30">·</span>}
    </div>
  );
}

function UpdatedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
      <Hexagon className="size-3" strokeWidth={2} />
      Updated by AI
    </span>
  );
}
