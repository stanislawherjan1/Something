import { useState, useEffect } from 'react';
import { FileText } from 'lucide-react';
import EditorHeader from './EditorHeader.jsx';

/**
 * FileViewer — fetches and renders a file's content in the center pane.
 *
 * Iteration 2: plain <pre> view. Markdown rendering and BlockNote editor
 * land in iteration 2.5 / 3 — for now we just need to see the file.
 */
export default function FileViewer({ path, fileEventNonce, sidebarOpen }) {
  const [state, setState] = useState({ status: 'idle' });

  // Re-fetch when the path changes OR when the watcher fires an event (the
  // bot may have edited the open file).
  useEffect(() => {
    if (!path) { setState({ status: 'idle' }); return; }
    const abortCtrl = new AbortController();
    setState({ status: 'loading' });

    fetch(`/api/files/read?path=${encodeURIComponent(path)}`, { signal: abortCtrl.signal })
      .then(async (resp) => {
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          setState({ status: 'error', error: data.error || `HTTP ${resp.status}` });
        } else {
          setState({ status: 'ok', content: data.content, size: data.size });
        }
      })
      .catch((err) => {
        if (!abortCtrl.signal.aborted) setState({ status: 'error', error: err.message });
      });

    return () => { abortCtrl.abort(); };
  }, [path, fileEventNonce]);

  if (!path) return <EmptyState />;
  if (state.status === 'loading') return <Centered>Loading…</Centered>;
  if (state.status === 'error') return <Centered error>Error: {state.error}</Centered>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={FileText} title={path} meta={formatBytes(state.size)} sidebarOpen={sidebarOpen} />
      <div className="flex-1 overflow-auto">
        <pre className="whitespace-pre-wrap break-words px-4 pb-6 font-mono text-sm leading-relaxed text-foreground/90">
          {state.content}
        </pre>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center px-12 py-16">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <h2 className="text-lg font-semibold tracking-tight">Nothing open</h2>
        <p className="text-sm leading-relaxed text-muted-foreground/70">
          Pick a file from the sidebar.
        </p>
      </div>
    </div>
  );
}

function Centered({ children, error }) {
  return (
    <div className={`flex h-full items-center justify-center text-sm ${error ? 'text-destructive' : 'text-muted-foreground/70'}`}>
      {children}
    </div>
  );
}

function formatBytes(n) {
  if (typeof n !== 'number') return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
