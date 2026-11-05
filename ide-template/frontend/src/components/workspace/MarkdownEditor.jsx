import { useEffect, useRef, useState } from 'react';
import { FileText, Hexagon, LockKeyhole } from 'lucide-react';
import {
  useCreateBlockNote,
  FormattingToolbarController,
  FilePanelController,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
} from '@blocknote/react';
import { filterSuggestionItems } from '@blocknote/core/extensions';
import { BlockNoteView } from '@blocknote/shadcn';
import '@blocknote/shadcn/style.css';
import './markdown-editor.css';
import EditorToolbar from './EditorToolbar.jsx';
import EditorFilePanel from './EditorFilePanel.jsx';
import EditorSlashMenu from './EditorSlashMenu.jsx';
import EditorHeader from './EditorHeader.jsx';
import { TextSelection } from 'prosemirror-state';
import { markdownSchema } from '@/lib/md-blocks/schema.js';
import { load, snapshot, resnapshot, serialize, afterSave, merge, applyOps, changedIds } from '@/lib/md-blocks/doc.js';
import ShareButton from './ShareButton.jsx';
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
    borderRadius: 6,
    fontFamily: '"Geist Variable", "Geist", -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif',
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
    borderRadius: 6,
    fontFamily: '"Geist Variable", "Geist", -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif',
  },
};

/**
 * MarkdownEditor — Notion-like block editor for `.md` files.
 *
 * The file on disk is the truth; the editor is a view over it.
 *   - lib/md-blocks turns the markdown into one top-level block per unit of
 *     the source and back. A block nobody touched is written back as its own
 *     bytes, so opening a file and editing one paragraph changes one paragraph
 *     on disk (the bot's next edit still matches, a diff stays small).
 *     Anything without a block (HTML, footnotes, …) is a raw block, kept.
 *   - Saves are debounced and versioned: a write that finds the file changed
 *     meanwhile (the bot, a teammate) gets theirs back, merges, and writes
 *     again. Nothing is overwritten unseen.
 *   - A change on disk is merged in as it happens, block by block: parts only
 *     they changed are applied as patches (the caret stays where it is), parts
 *     only you changed stay, a part you both changed keeps yours and offers
 *     theirs above the page.
 */
export default function MarkdownEditor({ path, fileEventNonce, sidebarOpen }) {
  const editor = useCreateBlockNote({
    schema: markdownSchema,
    // A markdown table always has a header row; cell colours and merged cells
    // have no markdown form.
    tables: { headers: true, splitCells: false, cellBackgroundColor: false, cellTextColor: false },
  });
  const { resolvedTheme } = useTheme();
  const [status, setStatus] = useState({ kind: 'loading' });
  const [locked, setLocked] = useState(null);
  const [slowSave, setSlowSave] = useState(false);
  const [externalUpdate, setExternalUpdate] = useState(false);
  const [conflicts, setConflicts] = useState([]);

  const docRef = useRef(null);            // lib/md-blocks state: which block came from which bytes
  const versionRef = useRef(null);        // the file version the editor is in sync with
  const frontmatterRef = useRef('');      // kept verbatim, never shown (memory cards rely on it)
  const lockedRef = useRef(null);
  const applyingRef = useRef(false);      // our own edits to the editor are not the person's
  const savingRef = useRef(false);
  const saveAgainRef = useRef(false);
  const checkAgainRef = useRef(false);
  const saveTimer = useRef(null);
  const slowTimer = useRef(null);
  const flashTimer = useRef(null);
  const surfaceRef = useRef(null);
  const pathRef = useRef(path);
  const seenNonce = useRef(fileEventNonce);
  const retryRef = useRef(0);             // failed saves in a row, for the back-off
  // What the person did, as opposed to what happened to the document. A save
  // only ever follows an edit of theirs: a change with no key, click, paste or
  // drop behind it (BlockNote settling a table, a hot reload, our own merge) is
  // never written. `editSeq` counts their edits; a save clears the flag only if
  // none came in while it was on its way.
  const inputAtRef = useRef(0);           // last key / pointer / paste / drop in the editor
  const editedRef = useRef(false);
  const editSeqRef = useRef(0);
  const ownerRef = useRef(null);          // the editor instance the file state belongs to
  const deferRef = useRef(null);
  const loadAtRef = useRef(0);            // when the file was loaded into the editor

  // Dev builds only: the editor and its file state, for debugging in the console.
  if (import.meta.env.DEV && typeof window !== 'undefined') window.__md = { editor, docRef, versionRef, serialize };

  // The file state is only good for the editor it was loaded into (a remount or
  // a hot reload makes a new, empty one).
  const ours = () => !!docRef.current && ownerRef.current === editor;
  const isDirty = () => ours() && editedRef.current && serialize(docRef.current, editor.document).body !== docRef.current.source;

  // After BlockNote has settled blocks we put in (it fills in table cells and
  // defaults on its own, a tick later), that settled form is the untouched one.
  // A key pressed just before (its text lands a moment later) leaves the
  // blocks as they are: that text is the person's, not part of disk's version.
  const settle = (ids) => {
    const at = Date.now();
    requestAnimationFrame(() => setTimeout(() => {
      if (!ours() || inputAtRef.current > at - 500) return;
      if (ids) resnapshot(docRef.current, editor.document, ids);
      else snapshot(docRef.current, editor.document, false);
    }, 0));
  };

  // Run edits on the editor that are not the person's typing: no save, and no
  // entry in their undo history (Ctrl+Z undoes what they did, not the bot).
  const quietly = (fn) => {
    applyingRef.current = true;
    try {
      try { editor.transact((tr) => { tr.setMeta('addToHistory', false); fn(); }); }
      catch { fn(); }
    } finally { applyingRef.current = false; }
  };

  // Where the caret is, as (block id, offset inside that block), so it can be
  // put back after a change from disk rewrote blocks around it or the block it
  // is in: ProseMirror would map it to the edge of the replaced content, and
  // the next keystroke would land in the block after.
  const caretSave = () => {
    const view = editor.prosemirrorView;
    if (!view?.hasFocus?.()) return null;
    const { anchor, head } = view.state.selection;
    const at = (pos) => {
      const $p = view.state.doc.resolve(pos);
      for (let d = $p.depth; d > 0; d--) {
        const n = $p.node(d);
        if (n.type.name === 'blockContainer') return { id: n.attrs.id, off: pos - $p.before(d) };
      }
      return null;
    };
    const a = at(anchor);
    return a ? { a, h: at(head) || a } : null;
  };
  const caretRestore = (saved) => {
    if (!saved) return;
    const view = editor.prosemirrorView;
    const doc = view.state.doc;
    const find = ({ id, off }) => {
      let res = null;
      doc.descendants((n, pos) => {
        if (res !== null) return false;
        if (n.type.name !== 'blockContainer' || n.attrs.id !== id) return true;
        const content = n.firstChild;                       // the block's own content, before its children
        res = Math.max(pos + 2, Math.min(pos + off, pos + 1 + (content?.nodeSize ?? 2) - 1));
        return false;
      });
      return res;
    };
    const a = find(saved.a);
    if (a === null) return;
    const h = find(saved.h) ?? a;
    try {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, a, h)).setMeta('addToHistory', false));
    } catch { /* the block changed shape: leave the caret where ProseMirror put it */ }
  };

  const flash = (ids) => {
    if (!ids.length) return;
    requestAnimationFrame(() => {
      const root = surfaceRef.current;
      if (!root) return;
      const els = ids.flatMap(id => [...root.querySelectorAll(`.bn-block-outer[data-id="${CSS.escape(id)}"]`)]);
      for (const el of els) el.classList.add('md-flash');
      setTimeout(() => { for (const el of els) el.classList.remove('md-flash'); }, 1600);
    });
    setExternalUpdate(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setExternalUpdate(false), 2400);
  };

  // Fold the file as it is on disk now into the editor.
  const takeRemote = (content, version) => {
    const { frontmatter, body } = splitFrontmatter(content || '');
    frontmatterRef.current = frontmatter;
    versionRef.current = version;
    if (!ours()) return;
    const doc = docRef.current;
    if (body === doc.source) return;
    // Disk already says exactly what the editor says (our own write, sent on
    // the way out of an earlier page): that is the new base, nothing to merge.
    const mine = serialize(doc, editor.document);
    if (mine.body === body) { docRef.current = afterSave(doc, mine.body, mine.layout); return; }
    const m = merge(doc, editor.document, body);
    const caret = caretSave();
    quietly(() => applyOps(editor, m.ops));
    caretRestore(caret);
    docRef.current = snapshot(m.state, editor.document);
    const changed = changedIds(m.ops);
    settle(changed);
    flash(changed);
    if (m.conflicts.length) setConflicts(prev => [...prev, ...m.conflicts.map(c => ({ ...c, key: `${Date.now()}-${Math.random()}` }))]);
    if (isDirty()) scheduleSave(0);
  };

  const scheduleSave = (delay = 500) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { saveTimer.current = null; save(); }, delay);
  };

  async function save() {
    if (lockedRef.current || !ours() || !editedRef.current) return;
    if (savingRef.current) { saveAgainRef.current = true; return; }
    const forPath = pathRef.current;
    const seq = editSeqRef.current;
    const { body, layout } = serialize(docRef.current, editor.document);
    if (body === docRef.current.source) { editedRef.current = false; return; }
    savingRef.current = true;
    if (slowTimer.current) clearTimeout(slowTimer.current);
    slowTimer.current = setTimeout(() => setSlowSave(true), 1500);
    try {
      const resp = await fetch('/api/files/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: forPath, content: frontmatterRef.current + body, baseVersion: versionRef.current ?? undefined }),
      });
      const data = await resp.json().catch(() => ({}));
      if (pathRef.current !== forPath) return;
      if (resp.ok) {
        docRef.current = afterSave(docRef.current, body, layout);
        versionRef.current = data.version ?? versionRef.current;
        if (editSeqRef.current === seq) editedRef.current = false;
        retryRef.current = 0;
        setStatus({ kind: 'ok' });
      } else if (resp.status === 409 && data.error === 'changed') {
        takeRemote(data.content, data.version);         // merges, and saves again if still needed
      } else if (resp.status === 409) {
        setStatus({ kind: 'error', error: 'This file was deleted. Your text is still here; copy it before leaving.' });
      } else if (resp.status >= 500) {
        retryLater();
      } else {
        setStatus({ kind: 'error', error: data.error || `Not saved (HTTP ${resp.status})` });
      }
    } catch {
      retryLater();
    } finally {
      savingRef.current = false;
      if (slowTimer.current) clearTimeout(slowTimer.current);
      setSlowSave(false);
      if (saveAgainRef.current) { saveAgainRef.current = false; scheduleSave(0); }
      if (checkAgainRef.current) { checkAgainRef.current = false; checkRemote(); }
    }
  }

  // The server or the network is away: keep the text, try again with a
  // growing pause (2 s … 30 s), and say so only while it lasts.
  function retryLater() {
    retryRef.current += 1;
    setStatus({ kind: 'error', error: 'Not saved yet: no connection. Trying again…' });
    scheduleSave(Math.min(30_000, 2000 * 2 ** (retryRef.current - 1)));
  }

  async function checkRemote() {
    if (!ours()) return;
    if (savingRef.current) { checkAgainRef.current = true; return; }
    // While the person is typing, a change from disk waits for a pause: a
    // write of theirs is versioned, so waiting never loses anything.
    const quiet = Date.now() - inputAtRef.current;
    if (quiet < 1200) {
      if (!deferRef.current) deferRef.current = setTimeout(() => { deferRef.current = null; checkRemote(); }, 1200 - quiet);
      return;
    }
    const forPath = pathRef.current;
    try {
      const resp = await fetch(`/api/files/read?path=${encodeURIComponent(forPath)}`);
      if (!resp.ok || pathRef.current !== forPath) return;
      const data = await resp.json();
      setLocked(data.locked || null);
      lockedRef.current = data.locked || null;
      if (savingRef.current) { checkAgainRef.current = true; return; }
      if (data.version && data.version === versionRef.current) return;
      takeRemote(data.content, data.version);
    } catch { /* the next event tries again */ }
  }

  // Open a file.
  useEffect(() => {
    pathRef.current = path;
    const abort = new AbortController();
    docRef.current = null;
    ownerRef.current = null;
    versionRef.current = null;
    editedRef.current = false;
    setStatus({ kind: 'loading' });
    setConflicts([]);
    setExternalUpdate(false);
    (async () => {
      try {
        const resp = await fetch(`/api/files/read?path=${encodeURIComponent(path)}`, { signal: abort.signal });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) { setStatus({ kind: 'error', error: data.error || `HTTP ${resp.status}` }); return; }
        setLocked(data.locked || null);
        lockedRef.current = data.locked || null;
        const { frontmatter, body } = splitFrontmatter(data.content || '');
        frontmatterRef.current = frontmatter;
        const { state, blocks } = load(body);
        quietly(() => editor.replaceBlocks(editor.document, blocks.length ? blocks : [{ type: 'paragraph' }]));
        docRef.current = snapshot(state, editor.document);
        ownerRef.current = editor;
        loadAtRef.current = Date.now();
        versionRef.current = data.version ?? null;
        settle(null);
        setStatus({ kind: 'ok' });
      } catch (err) {
        if (!abort.signal.aborted) setStatus({ kind: 'error', error: err.message });
      }
    })();
    return () => {
      abort.abort();
      // Leaving the file with an edit not yet saved: send it on the way out.
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      if (deferRef.current) { clearTimeout(deferRef.current); deferRef.current = null; }
      const doc = docRef.current;
      if (doc && ownerRef.current === editor && editedRef.current && !lockedRef.current) {
        const { body } = serialize(doc, editor.document);
        if (body !== doc.source) {
          fetch('/api/files/write', {
            method: 'POST', keepalive: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, content: frontmatterRef.current + body, baseVersion: versionRef.current ?? undefined }),
          }).catch(() => {});
        }
      }
    };
  }, [path]);

  // Something changed on disk (any file): see whether it is this one.
  useEffect(() => {
    if (seenNonce.current === fileEventNonce) return;
    seenNonce.current = fileEventNonce;
    checkRemote();
  }, [fileEventNonce]);

  useEffect(() => () => {
    for (const t of [saveTimer, slowTimer, flashTimer, deferRef]) if (t.current) clearTimeout(t.current);
  }, []);

  // The tab closes or goes away with an edit still waiting for its debounce:
  // send it now, with keepalive so the request outlives the page.
  useEffect(() => {
    const flush = () => {
      const doc = docRef.current;
      if (!doc || ownerRef.current !== editor || !editedRef.current || lockedRef.current || savingRef.current) return;
      const { body } = serialize(doc, editor.document);
      if (body === doc.source) return;
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      fetch('/api/files/write', {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: pathRef.current, content: frontmatterRef.current + body, baseVersion: versionRef.current ?? undefined }),
      }).catch(() => {});
    };
    // Hidden, not gone: an ordinary save, so the editor learns the new version.
    const onHide = () => {
      if (document.visibilityState !== 'hidden' || !saveTimer.current) return;
      clearTimeout(saveTimer.current); saveTimer.current = null;
      save();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => { window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', onHide); };
  }, [editor]);

  // A change counts as the person's only with an input of theirs in the last
  // few seconds, after the file was loaded (the click that opened it never
  // counts). Listened for on the whole page: BlockNote's toolbar, menus and
  // table handles live outside the editor's own element.
  useEffect(() => {
    const note = () => { inputAtRef.current = Date.now(); };
    const kinds = ['keydown', 'pointerdown', 'paste', 'drop', 'cut'];
    for (const k of kinds) document.addEventListener(k, note, true);
    return () => { for (const k of kinds) document.removeEventListener(k, note, true); };
  }, []);

  const onChange = () => {
    if (applyingRef.current || !ours() || lockedRef.current) return;
    const at = inputAtRef.current;
    if (at <= loadAtRef.current || Date.now() - at > 3000) return;
    editedRef.current = true;
    editSeqRef.current += 1;
    scheduleSave();
  };
  const noteInput = () => { inputAtRef.current = Date.now(); };

  const takeTheirs = (c) => {
    const { blocks } = load(c.theirs);
    const ids = c.mineIds.filter(id => editor.document.some(b => b.id === id));
    noteInput();                           // a click of theirs: this edit is theirs to save
    if (ids.length) editor.replaceBlocks(ids, blocks);
    else if (blocks.length) editor.insertBlocks(blocks, editor.document[editor.document.length - 1].id, 'after');
    setConflicts(prev => prev.filter(x => x.key !== c.key));
  };

  const saveState =
    status.kind === 'error'   ? <span className="text-destructive">{status.error}</span> :
    status.kind === 'loading' ? 'Loading…' :
    locked                    ? <span className="inline-flex items-center gap-1.5 text-muted-foreground/75"><LockKeyhole className="size-3.5" strokeWidth={1.75} />Locked by {locked.byName}</span> :
    externalUpdate            ? <UpdatedBadge /> :
    slowSave                  ? <span className="text-muted-foreground/75">Saving…</span> : null;
  const meta = (
    <span className="inline-flex items-center gap-3">
      {saveState}
      {status.kind !== 'error' && status.kind !== 'loading' && <ShareButton path={path} />}
    </span>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={FileText} title={path} meta={meta} sidebarOpen={sidebarOpen} />
      <div ref={surfaceRef} className="@container/editor flex-1 overflow-auto">
        {status.kind !== 'error' || docRef.current ? (
          // Reading width scales with the actual centre-column width via a
          // container query — no prop drilling for sidebar/chat state. With
          // both side panels open the centre stays at the comfortable 3xl
          // (~768px). One panel closed widens to 4xl; both closed unlocks
          // 5xl so a full-screen markdown view stops feeling boxed-in.
          // Mobile (<640px): drop wrapper to px-0 so all horizontal space
          // goes to the BlockNote editor itself, which keeps just 8px of
          // its own gutter (see markdown-editor.css mobile override).
          <div className="mx-auto w-full max-w-3xl @5xl/editor:max-w-4xl @7xl/editor:max-w-5xl px-0 sm:px-2 pb-12 pt-5">
            {conflicts.map(c => (
              <ConflictNotice key={c.key} conflict={c} onUseTheirs={() => takeTheirs(c)}
                onDismiss={() => setConflicts(prev => prev.filter(x => x.key !== c.key))} />
            ))}
            <BlockNoteView
              editor={editor}
              editable={!locked}
              onChange={onChange}
              theme={blockNoteTheme}
              data-theming-css-variables-demo
              data-color-scheme={resolvedTheme}
              formattingToolbar={false}
              filePanel={false}
              slashMenu={false}
            >
              {/* Custom selection toolbar + embed panel + slash menu, all built
                  from our own design-system primitives instead of @blocknote/shadcn. */}
              <FormattingToolbarController formattingToolbar={EditorToolbar} />
              <FilePanelController filePanel={EditorFilePanel} />
              <SuggestionMenuController
                triggerCharacter="/"
                suggestionMenuComponent={EditorSlashMenu}
                getItems={async (query) =>
                  filterSuggestionItems(getDefaultReactSlashMenuItems(editor), query)
                }
              />
            </BlockNoteView>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// A part of the page both sides changed: the editor kept the person's
// version; theirs is one click away.
function ConflictNotice({ conflict, onUseTheirs, onDismiss }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-3 mb-3 rounded-[6px] border border-border/60 bg-muted/20 px-3 py-2 text-[13px] sm:mx-[54px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-foreground/85">This part changed while you were editing it. Your version is kept.</span>
        <span className="ml-auto inline-flex items-center gap-3">
          <button type="button" className="rounded-[6px] px-2 py-0.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90" onClick={() => setOpen(o => !o)}>{open ? 'Hide theirs' : 'Show theirs'}</button>
          <button type="button" className="rounded-[6px] px-2 py-0.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90" onClick={onUseTheirs}>Use theirs</button>
          <button type="button" className="rounded-[6px] px-2 py-0.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90" onClick={onDismiss}>Dismiss</button>
        </span>
      </div>
      {open && (
        <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-background/70 p-2 font-mono text-[12px] text-foreground/80">{conflict.theirs || '(they removed it)'}</pre>
      )}
    </div>
  );
}

// Split a leading YAML frontmatter block off the top of a markdown file.
// Only matches when the file STARTS with `---` on its own line and has a
// matching closing `---` line. Returns the frontmatter (including its trailing
// newline) and the remaining body. No frontmatter → ('', wholeText).
function splitFrontmatter(text) {
  const m = /^(---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$))/.exec(text);
  if (!m) return { frontmatter: '', body: text };
  return { frontmatter: m[1], body: text.slice(m[1].length) };
}

function UpdatedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
      <Hexagon className="size-3" strokeWidth={2} />
      Updated
    </span>
  );
}
