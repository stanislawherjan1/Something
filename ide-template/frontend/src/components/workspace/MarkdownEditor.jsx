import { useEffect, useRef, useState } from 'react';
import { FileText, Hexagon } from 'lucide-react';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import '@blocknote/shadcn/style.css';
import './markdown-editor.css';
import { cn } from '@/lib/utils';
import EditorHeader from './EditorHeader.jsx';
import { useTheme } from '@/context/ThemeContext';

// BlockNote ships its own light/dark themes — they don't inherit our CSS
// vars and the default dark is a near-black that clashes with the rest of
// the workspace. Define explicit themes that mirror our palette so the
// editor surface looks like every other panel.
// `selected` drives every highlight BlockNote renders for slash-menu pick,
// drag-handle column/row controls, and current-block side gutter. The
// previous value piped through --accent (Tailwind amber-600/500) which
// painted the inline table controls an obtrusive orange that clashed with
// the otherwise-neutral palette the rest of the workspace uses. Match
// `foreground` here (the same near-black we use for primary buttons), so
// selection reads as a strong but tonal accent instead of a brand-orange
// stripe.
const blockNoteTheme = {
  light: {
    colors: {
      editor:   { text: '#1c1b18', background: '#f7f6f2' },
      menu:     { text: '#1c1b18', background: '#ffffff' },
      tooltip:  { text: '#1c1b18', background: '#ffffff' },
      hovered:  { text: '#1c1b18', background: '#f0efea' },
      selected: { text: '#f7f6f2', background: '#1c1b18' },
      disabled: { text: '#9e9b96', background: '#f0efea' },
      shadow:   '#e8e7e2',
      border:   '#e8e7e2',
      sideMenu: '#6b6963',
    },
    borderRadius: 4,
    fontFamily: 'Inter, system-ui, sans-serif',
  },
  dark: {
    colors: {
      editor:   { text: '#ebebea', background: '#1b1b1a' },
      menu:     { text: '#ebebea', background: '#252524' },
      tooltip:  { text: '#ebebea', background: '#252524' },
      hovered:  { text: '#ebebea', background: '#303030' },
      selected: { text: '#1b1b1a', background: '#ebebea' },
      disabled: { text: '#787877', background: '#252524' },
      shadow:   '#181817',
      border:   '#303030',
      sideMenu: '#a8a8a7',
    },
    borderRadius: 4,
    fontFamily: 'Inter, system-ui, sans-serif',
  },
};

/**
 * MarkdownEditor — Notion-like block editor for `.md` files.
 *
 *   - Loads markdown via /api/files/read on mount
 *   - Renders blocks via BlockNote (built on TipTap/ProseMirror)
 *   - On every change: serialize → markdown → debounced PUT to /api/files/write
 *   - Watcher events refresh content only if local buffer is clean (no pending
 *     edits) — avoids clobbering the user's in-progress typing
 *
 * Save status badge sits in the header (Saving… / Saved / dirty), so the
 * user has visible feedback that edits hit disk.
 */
export default function MarkdownEditor({ path, fileEventNonce, sidebarOpen }) {
  const editor = useCreateBlockNote();
  const { resolvedTheme } = useTheme();
  const [status, setStatus] = useState({ kind: 'loading' });
  const [savedAt, setSavedAt] = useState(null);
  // Flash + "Updated" badge when the file changes externally (bot edit).
  // Cleared after 2.4 s so the user has time to register the change.
  const [externalUpdate, setExternalUpdate] = useState(false);
  const dirtyRef    = useRef(false);
  const savingRef   = useRef(false);
  const remoteMtime = useRef(0);
  const saveTimer   = useRef(null);
  const lastSavedMd = useRef('');
  const updateFlashTimer = useRef(null);
  const hasInitializedRef = useRef(false);
  const isInitialLoad = useRef(true);

  // Cleanup all timers on unmount so stale saves don't fire after navigation.
  useEffect(() => () => {
    if (saveTimer.current)        clearTimeout(saveTimer.current);
    if (updateFlashTimer.current) clearTimeout(updateFlashTimer.current);
  }, []);

  // Load file content into the editor (and on watcher events, if clean).
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

        // If we have unsaved local edits, don't clobber them on watcher refresh.
        if (!isInitialLoad.current && dirtyRef.current) {
          remoteMtime.current = data.mtime ?? 0;
          return;
        }

        const incoming = data.content || '';
        const changed = incoming !== lastSavedMd.current;
        const wasInitialized = hasInitializedRef.current;

        const blocks = await editor.tryParseMarkdownToBlocks(incoming);
        if (abortCtrl.signal.aborted) return;

        editor.replaceBlocks(editor.document, blocks);
        lastSavedMd.current = incoming;
        remoteMtime.current = data.mtime ?? 0;
        isInitialLoad.current = false;
        setStatus({ kind: 'ok' });

        // Flash only on watcher refresh, not on initial load
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

    // Reset state for new file path
    isInitialLoad.current = true;
    hasInitializedRef.current = false;
    dirtyRef.current = false;
    setSavedAt(null);
    setExternalUpdate(false);
    setStatus({ kind: 'loading' });
    if (updateFlashTimer.current) clearTimeout(updateFlashTimer.current);
    if (saveTimer.current)        clearTimeout(saveTimer.current);

    loadFile();

    return () => { abortCtrl.abort(); };
  }, [path, fileEventNonce]);

  // Debounced save on every change.
  useEffect(() => {
    if (status.kind !== 'ok') return;
    const off = editor.onChange(async () => {
      const md = await editor.blocksToMarkdownLossy(editor.document);
      if (md === lastSavedMd.current) return;          // no-op edit
      dirtyRef.current = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => save(md), 600);
    });
    return off;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.kind, editor]);

  async function save(md) {
    if (savingRef.current) {
      // Re-arm: queue another save once current finishes.
      saveTimer.current = setTimeout(() => save(md), 200);
      return;
    }
    savingRef.current = true;
    try {
      const resp = await fetch('/api/files/write', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ path, content: md }),
      });
      if (resp.ok) {
        const data = await resp.json();
        lastSavedMd.current = md;
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

  const meta =
    status.kind === 'error'   ? <span className="text-destructive">Error: {status.error}</span> :
    status.kind === 'loading' ? 'Loading…' :
    externalUpdate            ? <UpdatedBadge /> :
    dirtyRef.current          ? 'Saving…' :
    savedAt                   ? 'Saved' : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={FileText} title={path} meta={meta} sidebarOpen={sidebarOpen} />
      <div
        className={cn(
          '@container/editor flex-1 overflow-auto transition-shadow duration-700',
          externalUpdate && 'ring-2 ring-emerald-500/40 ring-inset bg-emerald-500/[0.03]',
        )}
      >
        {status.kind !== 'error' && (
          // Reading width scales with the actual centre-column width via a
          // container query — no prop drilling for sidebar/chat state. With
          // both side panels open the centre stays at the comfortable 3xl
          // (~768px). One panel closed widens to 4xl; both closed unlocks
          // 5xl so a full-screen markdown view stops feeling boxed-in.
          // Mobile (<640px): drop wrapper to px-0 so all horizontal space
          // goes to the BlockNote editor itself, which keeps just 8px of
          // its own gutter (see markdown-editor.css mobile override).
          <div className="mx-auto w-full max-w-3xl @5xl/editor:max-w-4xl @7xl/editor:max-w-5xl px-0 sm:px-2 pb-12 pt-2">
            <BlockNoteView editor={editor} theme={blockNoteTheme} data-theming-css-variables-demo data-color-scheme={resolvedTheme} />
          </div>
        )}
      </div>
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
