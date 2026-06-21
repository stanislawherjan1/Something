import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, FileText, CornerDownLeft, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * SearchPalette — a Notion / cmd-K style overlay to search the workspace by file
 * NAME or text CONTENT. Hits GET /api/files/search (which only ever returns
 * files the user can open). Keyboard: ↑/↓ move, Enter opens, Esc closes.
 * Selecting a result navigates to the file via `onSelect({ path, type:'file' })`.
 */
export default function SearchPalette({ onClose, onSelect }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Lock background scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Debounced search.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); setLoading(false); return; }
    setLoading(true);
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/files/search?q=${encodeURIComponent(term)}`);
        const d = await r.json().catch(() => ({}));
        if (cancelled) return;
        setResults(Array.isArray(d.results) ? d.results : []);
        setActive(0);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 220);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);

  const choose = useCallback((item) => {
    if (!item) return;
    onSelect({ path: item.path, type: 'file' });
    onClose();
  }, [onSelect, onClose]);

  // Keep the active row in view as the user arrows through.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown')      { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter')     { e.preventDefault(); choose(results[active]); }
    else if (e.key === 'Escape')    { e.preventDefault(); onClose(); }
  };

  const term = q.trim();

  return (
    <div
      className="fixed inset-0 z-[120] flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-[2px] animate-[fade-in_0.12s_ease-out]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search files"
        className="w-full max-w-xl overflow-hidden rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-border/50 px-4">
          <Search className="size-4 shrink-0 text-muted-foreground/55" strokeWidth={1.75} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search files by name or content…"
            className="h-12 w-full bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground/50"
          />
          {loading && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground/50" />}
          <kbd className="shrink-0 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/70">esc</kbd>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1.5">
          {term.length < 2 ? (
            <Hint>Type at least 2 characters to search.</Hint>
          ) : loading && results.length === 0 ? (
            <Hint>Searching…</Hint>
          ) : results.length === 0 ? (
            <Hint>No matches for “{term}”.</Hint>
          ) : (
            results.map((r, i) => (
              <ResultRow
                key={r.path + ':' + i}
                idx={i}
                result={r}
                active={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(r)}
              />
            ))
          )}
        </div>

        {results.length > 0 && (
          <div className="flex items-center gap-3 border-t border-border/50 px-4 py-2 text-[10.5px] text-muted-foreground/60">
            <span className="inline-flex items-center gap-1"><CornerDownLeft className="size-3" strokeWidth={1.75} /> open</span>
            <span>↑↓ navigate</span>
            <span className="ml-auto">{results.length} result{results.length === 1 ? '' : 's'}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Hint({ children }) {
  return <div className="px-4 py-8 text-center text-[12.5px] text-muted-foreground/60">{children}</div>;
}

function ResultRow({ result, idx, active, onMouseEnter, onClick }) {
  const dir = result.path.includes('/') ? result.path.slice(0, result.path.lastIndexOf('/')) : '';
  return (
    <button
      type="button"
      data-idx={idx}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-2.5 px-4 py-2 text-left transition-colors',
        active ? 'bg-foreground/[0.06]' : 'hover:bg-foreground/[0.035]',
      )}
    >
      <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground/55" strokeWidth={1.75} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[13px] font-medium text-foreground/90">{result.name}</span>
          {dir && <span className="truncate text-[11px] text-muted-foreground/55">{dir}</span>}
        </div>
        {result.snippet && (
          <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground/70">
            {result.line ? <span className="text-muted-foreground/45">L{result.line} · </span> : null}
            {result.snippet}
          </div>
        )}
      </div>
    </button>
  );
}
