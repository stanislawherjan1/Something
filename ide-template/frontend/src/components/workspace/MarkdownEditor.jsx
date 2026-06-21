import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { FileText, Hexagon } from 'lucide-react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView, Decoration, ViewPlugin, MatchDecorator } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { cn } from '@/lib/utils';
import { looksLikePath, pathToSelection } from '@/lib/filePaths';
import EditorHeader from './EditorHeader.jsx';
import { useTheme } from '@/context/ThemeContext';

/**
 * MarkdownEditor — CodeMirror 6 editor for `.md` files.
 *
 * Why CM6 (replacing BlockNote): the document model IS the raw markdown string
 * — there is no block→markdown serialization, so `.md` files round-trip
 * BYTE-FOR-BYTE. Editing a bot-written file with frontmatter / raw HTML /
 * footnotes never reflows or mangles anything the user didn't touch. The
 * backend already writes the editor's output verbatim, so what gets saved is
 * exactly the bytes. One surface — no edit/preview toggle.
 *
 *   - Loads raw markdown via /api/files/read on mount
 *   - Live markdown syntax styling (headings, bold/italic, links, code, quotes)
 *   - File paths in the text are clickable (Cmd/Ctrl-click → open the file)
 *   - Debounced verbatim save to /api/files/write
 *   - Watcher events refresh only when the local buffer is clean
 */

// Markdown source styling — "pretty source": headings stand out, emphasis reads
// as emphasis, punctuation markers recede. Colours come from our CSS vars so it
// tracks light/dark automatically.
const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.5em', fontWeight: '700', lineHeight: '1.3' },
  { tag: t.heading2, fontSize: '1.3em', fontWeight: '700', lineHeight: '1.3' },
  { tag: t.heading3, fontSize: '1.15em', fontWeight: '600' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '600' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--color-ring)' },
  { tag: t.monospace, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.92em' },
  { tag: t.quote, color: 'var(--color-muted-foreground)', fontStyle: 'italic' },
  // Markdown punctuation (#, *, `, -, >, list bullets) recedes.
  { tag: [t.meta, t.processingInstruction, t.contentSeparator], color: 'color-mix(in srgb, var(--color-muted-foreground) 70%, transparent)' },
]);

// A token that looks like a workspace file path → a styled, Cmd/Ctrl-clickable
// mark. It decorates the UNDERLYING text, so it serializes for free (the file
// still contains the literal path).
const pathMatcher = new MatchDecorator({
  regexp: /(?:\/home\/coder\/project\/)?(?:[\w.\-]+\/)+[\w.\-]+\.[A-Za-z0-9]{1,8}/g,
  decoration: (m) =>
    looksLikePath(m[0])
      ? Decoration.mark({ class: 'cm-filepath', attributes: { 'data-filepath': m[0], title: 'Cmd/Ctrl-click to open' } })
      : null,
});
const filePathPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = pathMatcher.createDeco(view); }
    update(u) { if (u.docChanged || u.viewportChanged) this.decorations = pathMatcher.updateDeco(u, this.decorations); }
  },
  { decorations: (v) => v.decorations },
);

export default function MarkdownEditor({ path, fileEventNonce, sidebarOpen, onSelect }) {
  const { resolvedTheme } = useTheme();
  const [doc, setDoc] = useState('');
  const [status, setStatus] = useState({ kind: 'loading' });
  const [savedAt, setSavedAt] = useState(null);
  const [externalUpdate, setExternalUpdate] = useState(false);

  const dirtyRef    = useRef(false);
  const savingRef   = useRef(false);
  const remoteMtime = useRef(0);
  const saveTimer   = useRef(null);
  const lastSavedMd = useRef('');
  const flashTimer  = useRef(null);
  const initializedRef = useRef(false);
  const isInitialLoad  = useRef(true);
  const onSelectRef = useRef(onSelect);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  // Load file content (initial + on watcher events when the buffer is clean).
  useEffect(() => {
    const abort = new AbortController();
    const loadFile = async () => {
      try {
        const resp = await fetch(`/api/files/read?path=${encodeURIComponent(path)}`, { signal: abort.signal });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) { setStatus({ kind: 'error', error: data.error || `HTTP ${resp.status}` }); return; }
        // Don't clobber unsaved local edits on a watcher refresh.
        if (!isInitialLoad.current && dirtyRef.current) { remoteMtime.current = data.mtime ?? 0; return; }
        const incoming = data.content || '';
        const changed = incoming !== lastSavedMd.current;
        const wasInitialized = initializedRef.current;
        if (abort.signal.aborted) return;
        setDoc(incoming);
        lastSavedMd.current = incoming;
        remoteMtime.current = data.mtime ?? 0;
        isInitialLoad.current = false;
        setStatus({ kind: 'ok' });
        if (wasInitialized && changed) {
          setExternalUpdate(true);
          if (flashTimer.current) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setExternalUpdate(false), 2400);
        }
        initializedRef.current = true;
      } catch (err) {
        if (!abort.signal.aborted) setStatus({ kind: 'error', error: err.message });
      }
    };

    isInitialLoad.current = true;
    initializedRef.current = false;
    dirtyRef.current = false;
    setSavedAt(null);
    setExternalUpdate(false);
    setStatus({ kind: 'loading' });
    if (flashTimer.current) clearTimeout(flashTimer.current);
    if (saveTimer.current)  clearTimeout(saveTimer.current);
    loadFile();
    return () => abort.abort();
  }, [path, fileEventNonce]);

  const save = useCallback(async (md) => {
    if (savingRef.current) { saveTimer.current = setTimeout(() => save(md), 200); return; }
    savingRef.current = true;
    try {
      const resp = await fetch('/api/files/write', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content: md }),
      });
      if (resp.ok) {
        const data = await resp.json().catch(() => ({}));
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
  }, [path]);

  const onChange = useCallback((value) => {
    setDoc(value);
    if (value === lastSavedMd.current) return;   // no-op (e.g. external load echo)
    dirtyRef.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save(value), 600);
  }, [save]);

  // Editor extensions; rebuilt when the colour scheme flips so the theme's
  // `dark` flag stays correct.
  const extensions = useMemo(() => [
    markdown({ base: markdownLanguage }),
    EditorView.lineWrapping,
    syntaxHighlighting(mdHighlight),
    filePathPlugin,
    EditorView.domEventHandlers({
      mousedown: (e) => {
        const el = e.target?.closest?.('.cm-filepath');
        if (el && (e.metaKey || e.ctrlKey)) {
          const p = el.getAttribute('data-filepath');
          if (p) { onSelectRef.current?.(pathToSelection(p)); e.preventDefault(); return true; }
        }
        return false;
      },
    }),
    EditorView.theme({
      '&': { backgroundColor: 'transparent', color: 'var(--color-foreground)', fontSize: '14px' },
      '&.cm-focused': { outline: 'none' },
      '.cm-content': {
        fontFamily: 'Inter, system-ui, sans-serif',
        lineHeight: '1.7',
        padding: '4px 0 64px',
        caretColor: 'var(--color-foreground)',
        maxWidth: '100%',
      },
      '.cm-scroller': { fontFamily: 'inherit', overflow: 'auto' },
      '.cm-line': { padding: '0' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-foreground)' },
      '.cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--color-foreground) 12%, transparent) !important' },
      '&.cm-focused .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--color-foreground) 14%, transparent) !important' },
      '.cm-filepath': {
        color: 'var(--color-ring)',
        textDecoration: 'underline',
        textDecorationColor: 'color-mix(in srgb, var(--color-ring) 35%, transparent)',
        textUnderlineOffset: '2px',
        cursor: 'pointer',
      },
      '.cm-filepath:hover': { textDecorationColor: 'var(--color-ring)' },
      '.cm-gutters': { display: 'none' },
    }, { dark: resolvedTheme === 'dark' }),
  ], [resolvedTheme]);

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
          '@container/editor flex-1 min-h-0 overflow-hidden transition-shadow duration-700',
          externalUpdate && 'ring-2 ring-emerald-500/40 ring-inset bg-emerald-500/[0.03]',
        )}
      >
        {status.kind !== 'error' && (
          <div className="mx-auto h-full w-full max-w-3xl @5xl/editor:max-w-4xl @7xl/editor:max-w-5xl px-3 sm:px-4">
            <CodeMirror
              value={doc}
              onChange={onChange}
              extensions={extensions}
              theme="none"
              height="100%"
              basicSetup={{
                lineNumbers: false,
                foldGutter: false,
                highlightActiveLine: false,
                highlightActiveLineGutter: false,
                autocompletion: false,
                bracketMatching: false,
              }}
              className="h-full text-[14px]"
            />
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
