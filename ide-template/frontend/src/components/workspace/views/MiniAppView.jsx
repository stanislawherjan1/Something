/**
 * MiniAppView — renders one AI-built mini app (sidebar tab) in the centre pane.
 *
 * Loads the spec from /api/miniapps/:id, resolves its data sources, and hands
 * the OpenUI Lang spec to the whitelisted component library renderer.
 *
 * Data sources (slice 1):
 *   - embedded snapshot: app.data[key] written by the agent at build time
 *   - live same-origin:  source "api:/api/..." fetched on open + on Refresh
 * Anything else is surfaced as a per-key error, never fetched — the widget
 * layer gets no outbound channel of its own (all data rides the session
 * cookie through wsapi, same as every dashboard).
 */

import { Component as ReactComponent, useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutGrid, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useApi } from '@/lib/useApi';
import { Renderer } from '@openuidev/react-lang';
import { miniappLibrary, MiniAppDataContext } from '@/lib/miniapp/library.jsx';
import EditorHeader from '../EditorHeader.jsx';
import { SkeletonLine } from '../SkeletonLoader.jsx';

// Only same-origin API paths may be fetched live. "api:" prefix is the spec
// convention; the path after it must start with /api/ (no absolute URLs).
function livePath(source) {
  if (typeof source !== 'string' || !source.startsWith('api:')) return null;
  const p = source.slice(4);
  return p.startsWith('/api/') && !p.includes('//') ? p : null;
}

export default function MiniAppView({ id, fileEventNonce, sidebarOpen }) {
  const { data: payload, error: loadError, loading, reload } = useApi(id ? `/api/miniapps/${encodeURIComponent(id)}` : null);
  const app = payload?.app || null;

  // Re-read the spec when the agent rewrites the file (chokidar → nonce).
  useEffect(() => { if (fileEventNonce) reload(); }, [fileEventNonce, reload]);

  const [live, setLive] = useState({ data: {}, errors: {}, fetching: false });
  // User-generated state (Form submits). Server copy arrives with the app;
  // appendState mutates optimistically with the server's authoritative echo.
  const [state, setState] = useState({});
  useEffect(() => { setState(payload?.state || {}); }, [payload]);

  const sources = useMemo(() => (Array.isArray(app?.dataSources) ? app.dataSources : []), [app]);

  // Button clicks ride the existing chat-prefill event with send:true — the
  // click IS the user's message; the bot (with its full tool belt) is the
  // app's backend.
  const sendToBot = useCallback((text) => {
    window.dispatchEvent(new CustomEvent('ide:chat-prefill', { detail: { text, send: true } }));
  }, []);

  const appendState = useCallback(async (key, entry) => {
    const resp = await fetch(`/api/miniapps/${encodeURIComponent(id)}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ op: 'append', key, entry }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    setState(data.state || {});
  }, [id]);

  const fetchLive = useCallback(async () => {
    const targets = sources.map(s => ({ key: s?.key, path: livePath(s?.source) })).filter(t => t.key);
    if (!targets.length) return;
    setLive(prev => ({ ...prev, fetching: true }));
    const data = {}, errors = {};
    await Promise.all(targets.map(async ({ key, path }) => {
      if (!path) {
        // Non-live source: embedded snapshot covers it; only flag unknown schemes.
        const src = sources.find(s => s?.key === key)?.source;
        if (src && !String(src).startsWith('embedded')) errors[key] = `Unsupported source: ${src}`;
        return;
      }
      try {
        const resp = await fetch(path, { credentials: 'include' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        data[key] = await resp.json();
      } catch (err) {
        errors[key] = err.message;
      }
    }));
    setLive({ data, errors, fetching: false });
  }, [sources]);

  useEffect(() => { fetchLive(); }, [fetchLive]);

  // Resolution order per key: user state ('state' sources) → live api fetch →
  // embedded snapshot. State also rides whole under data.state for ad-hoc use.
  const ctx = useMemo(() => {
    const data = { ...(app?.data || {}), ...live.data };
    for (const s of sources) {
      if (s?.source === 'state' && s?.key) data[s.key] = state[s.key] ?? [];
    }
    data.state = state;
    return {
      data,
      loading: live.fetching,
      errors: live.errors,
      appName: app?.name || app?.id || '',
      sendToBot,
      appendState,
    };
  }, [app, live, sources, state, sendToBot, appendState]);

  if (loading && !app) return <MiniAppSkeleton sidebarOpen={sidebarOpen} />;
  if (app?.status === 'building') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <EditorHeader icon={LayoutGrid} title={app.name || app.id} sidebarOpen={sidebarOpen} />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground/70">
          <RefreshCw className="size-6 animate-spin" strokeWidth={1.5} />
          <div className="text-[13.5px]">Building this app… it will appear here in a moment.</div>
        </div>
      </div>
    );
  }
  if (loadError || !app) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground/70">
        {loadError ? `Couldn't load this app: ${loadError}` : 'App not found — it may have been deleted.'}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={LayoutGrid} title={app.name || app.id} sidebarOpen={sidebarOpen} />
      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8">
          <div className="mb-4 flex items-center justify-end">
            <button
              type="button"
              onClick={fetchLive}
              disabled={live.fetching}
              className={cn(
                'flex items-center gap-1.5 rounded-md border border-border/55 bg-background px-2.5 py-1.5',
                'text-[12px] font-medium text-muted-foreground/75 transition-colors',
                'hover:bg-sidebar-accent/40 hover:text-foreground/85 disabled:opacity-50',
              )}
            >
              <RefreshCw className={cn('size-3.5', live.fetching && 'animate-spin')} strokeWidth={1.75} />
              Refresh
            </button>
          </div>
          <MiniAppDataContext.Provider value={ctx}>
            <RenderBoundary specKey={`${app.id}:${app.updated || ''}`}>
              <div className="flex flex-col gap-3">
                <Renderer response={app.spec || ''} library={miniappLibrary} isStreaming={false} />
              </div>
            </RenderBoundary>
          </MiniAppDataContext.Provider>
        </div>
      </div>
    </div>
  );
}

function MiniAppSkeleton({ sidebarOpen }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={LayoutGrid} title="…" sidebarOpen={sidebarOpen} />
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-8">
        <div className="grid grid-cols-2 gap-3">
          <div className="h-20 animate-pulse rounded-lg bg-muted/40" />
          <div className="h-20 animate-pulse rounded-lg bg-muted/40" />
        </div>
        <div className="mt-4 h-52 animate-pulse rounded-xl bg-muted/30" />
        <div className="mt-4 space-y-2.5">
          <SkeletonLine width="100%" height="13px" />
          <SkeletonLine width="92%" height="13px" />
          <SkeletonLine width="64%" height="13px" />
        </div>
      </div>
    </div>
  );
}

/**
 * A bad spec must never blank the workspace — catch render/parse crashes and
 * show a contained error instead. Keyed by spec version so a rewrite retries.
 */
class RenderBoundary extends ReactComponent {
  constructor(props) { super(props); this.state = { error: null, key: props.specKey }; }
  static getDerivedStateFromError(error) { return { error }; }
  static getDerivedStateFromProps(props, state) {
    return props.specKey !== state.key ? { error: null, key: props.specKey } : null;
  }
  render() {
    if (this.state.error) {
      return (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-[12.5px] text-destructive">
          This app's layout failed to render. Ask the assistant to rebuild it.
          <div className="mt-1 font-mono text-[11px] opacity-70">{String(this.state.error?.message || this.state.error)}</div>
        </div>
      );
    }
    return this.props.children;
  }
}
