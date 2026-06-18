import { useEffect, useMemo, useRef, useState, useCallback, lazy, Suspense } from 'react';
import { Brain, Search, Eye, Link as LinkIcon, FileText, ShieldAlert, Hash, AlertCircle, X, Loader2, Lock, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import EditorHeader from '../EditorHeader.jsx';
import { useBranding } from '../identity';

/**
 * MemoryDashboard — interactive graph of `project/memory/` (P3.03).
 *
 * Renders the LLM-wiki layer (INDEX + cards + topics/) as an Obsidian-style
 * force-directed graph. Each node is one .md file; edges are [[wiki-links]]
 * (strong) plus bare-name mentions (thin, toggleable).
 *
 * Click a node → opens the file in EditorPane. Hover → tooltip with the
 * file's first 200 chars. Drag → reposition. Search box highlights matches.
 *
 * The graph data comes from /api/memory/graph (lib/memory-graph.js). We
 * lazy-load `react-force-graph-2d` so the ~150 kB three-spring bundle only
 * ships when this view is opened.
 */

// Lazy so the graph runtime isn't in the main bundle.
const ForceGraph2D = lazy(() => import('react-force-graph-2d'));

// Monochrome theme-aware palette. White-family in light mode (index pure
// white, cards + topics are pre-blended solids approximating white at
// 50% / 25% opacity over the light bg — so they read as progressively
// more washed-out). Black-family in dark mode (mirror — index pure
// black, cards + topics increasingly blended toward the dark bg). A
// subtle stroke gives each node definition even when the fill blends
// heavily with the bg.
const LIGHT_PALETTE = {
  index: { fill: '#fefdfa', stroke: 'rgba(40,35,28,0.55)', label: 'INDEX' }, // off-white, faint warm
  card:  { fill: '#f2f0ea', stroke: 'rgba(40,35,28,0.26)', label: 'Card'  }, // soft warm gray-100
  topic: { fill: '#e4e0d6', stroke: 'rgba(40,35,28,0.18)', label: 'Topic' }, // soft warm gray-200
};
const DARK_PALETTE = {
  index: { fill: '#0e0d0c', stroke: 'rgba(232,228,218,0.55)', label: 'INDEX' }, // near-black, faint warm
  card:  { fill: '#1a1917', stroke: 'rgba(232,228,218,0.26)', label: 'Card'  }, // soft warm dark
  topic: { fill: '#26241f', stroke: 'rgba(232,228,218,0.18)', label: 'Topic' }, // soft warm darker
};

const NODE_RADIUS = { index: 9, card: 6.5, topic: 4.5 };

export default function MemoryDashboard({ sidebarOpen, onSelect }) {
  const { botDisplayName } = useBranding();
  const [graph, setGraph] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [showBare, setShowBare] = useState(true);
  const [scopeFilter, setScopeFilter] = useState('all');   // 'all' | 'shared' | 'yours' (team mode)
  const [hover, setHover] = useState(null);
  const [activeNode, setActiveNode] = useState(null);
  const containerRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const graphRef = useRef(null);

  // Theme — pick label colour + node palette against the workspace's CSS
  // var values. NODE_COLOURS switches palette on light/dark; both render
  // monochrome (INDEX = solid contrast, Card = surface fill, Topic = 50%).
  const [isDark, setIsDark] = useState(() =>
    typeof window !== 'undefined' && document.documentElement.classList.contains('dark'),
  );
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  const NODE_COLOURS = isDark ? DARK_PALETTE : LIGHT_PALETTE;

  // Fetch graph.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/memory/graph')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data => { if (!cancelled) { setGraph(data); setError(null); } })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []);

  // Track container size — the force-graph needs explicit pixel width/height.
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // True when this workspace has any per-user ('yours') nodes — i.e. team mode.
  // The Shared/Yours filter + legend only appear then.
  const hasYours = useMemo(() => !!graph?.nodes?.some(n => n.scope === 'yours'), [graph]);

  // Filter by scope (Shared/Yours) + the wiki-only toggle, and apply the
  // search-highlight set. Edges whose endpoints got filtered out are dropped so
  // the force layout doesn't choke on dangling links.
  const { displayed, matchSet } = useMemo(() => {
    if (!graph) return { displayed: null, matchSet: new Set() };
    let nodes = graph.nodes;
    if (scopeFilter !== 'all') nodes = nodes.filter(n => (n.scope || 'shared') === scopeFilter);
    const nodeIds = new Set(nodes.map(n => n.id));
    const edges = (showBare ? graph.edges : graph.edges.filter(e => e.kind === 'wiki'))
      .filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));
    const q = query.trim().toLowerCase();
    const matches = new Set();
    if (q) {
      for (const n of nodes) {
        if (n.id.includes(q) || (n.name || '').toLowerCase().includes(q) || (n.preview || '').toLowerCase().includes(q)) {
          matches.add(n.id);
        }
      }
    }
    return { displayed: { nodes, links: edges }, matchSet: matches };
  }, [graph, query, showBare, scopeFilter]);

  const onNodeClick = useCallback((node) => {
    if (node) setActiveNode(node);
  }, []);

  const drawNode = useCallback((node, ctx, globalScale) => {
    const colour = NODE_COLOURS[node.kind] || NODE_COLOURS.topic;
    const radius = NODE_RADIUS[node.kind] || 5;
    const isMatch = matchSet.size > 0 && matchSet.has(node.id);
    const dimmed = matchSet.size > 0 && !isMatch;

    // Halo on matched nodes — helps the eye lock on after typing a query.
    if (isMatch) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius + 4, 0, 2 * Math.PI, false);
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = colour.fill;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
    ctx.fillStyle = dimmed ? '#94a3b8' : colour.fill;
    ctx.globalAlpha = dimmed ? 0.4 : 1;
    ctx.fill();
    ctx.lineWidth = 1.25 / globalScale;
    ctx.strokeStyle = dimmed ? '#475569' : colour.stroke;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // 'Yours' (per-user, private) nodes get a coloured accent ring so they
    // stand out from the shared team memory at a glance.
    if (node.scope === 'yours') {
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius + 2.5, 0, 2 * Math.PI, false);
      ctx.lineWidth = 1.5 / globalScale;
      ctx.strokeStyle = dimmed ? 'rgba(56,189,248,0.35)' : (isDark ? '#38bdf8' : '#0284c7');
      ctx.stroke();
    }

    // Label — only at high zoom to avoid clutter at the default view.
    const showLabel = globalScale > 1.6 || node.kind === 'index' || matchSet.has(node.id);
    if (showLabel) {
      const fontSize = Math.max(2, 11 / globalScale);
      ctx.font = `${fontSize}px Geist, system-ui, sans-serif`;
      ctx.fillStyle = isDark ? 'rgba(226,232,240,0.92)' : 'rgba(15,23,42,0.92)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const label = node.id;
      ctx.fillText(label, node.x, node.y + radius + 2.5);
    }
  }, [matchSet, isDark]);

  const linkColour = useCallback((link) => {
    // Warm-neutral grays for edges — faintly off the slate-blue side, but
    // not actual brown. Recedes from the nodes so the eye follows shapes
    // first, then connections.
    return link.kind === 'wiki'
      ? (isDark ? 'rgba(170,165,155,0.50)' : 'rgba(95,90,80,0.50)')
      : (isDark ? 'rgba(170,165,155,0.18)' : 'rgba(115,110,100,0.22)');
  }, [isDark]);

  const linkWidth = useCallback((link) => link.kind === 'wiki' ? 1.4 : 0.6, []);

  const ready = graph !== null;
  // Reflect what's actually on screen (after the Shared/Yours + wiki filters),
  // so the count matches the rendered graph.
  const counts = useMemo(() => {
    const d = displayed;
    if (!d) return { nodes: 0, edges: 0, wiki: 0, bare: 0 };
    return {
      nodes: d.nodes.length,
      edges: d.links.length,
      wiki: d.links.filter(e => e.kind === 'wiki').length,
      bare: d.links.filter(e => e.kind === 'bare').length,
    };
  }, [displayed]);

  const searchInput = (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/55" strokeWidth={1.75} />
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search memory"
        className="h-7 w-56 rounded-md border border-border/55 bg-background pl-7 pr-2 text-[12.5px] text-foreground outline-none transition-colors focus:border-foreground/40"
      />
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader
        icon={Brain}
        title="Memory"
        meta={searchInput}
        sidebarOpen={sidebarOpen}
      />

      <div ref={containerRef} className="relative flex-1 min-h-0 overflow-hidden bg-muted/20">
        {error && (
          <div className="absolute inset-x-4 top-4 z-10 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-[12.5px] text-destructive shadow-sm">
            <AlertCircle className="mt-px size-3.5 shrink-0" strokeWidth={1.75} />
            <span>Couldn't load memory graph: {error}</span>
          </div>
        )}

        {!ready && !error && (
          <div className="flex h-full items-center justify-center text-[12.5px] text-muted-foreground/65">
            Building the graph…
          </div>
        )}

        {ready && graph.nodes.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <Brain className="size-8 text-muted-foreground/40" strokeWidth={1.5} />
            <p className="max-w-md text-[13px] text-muted-foreground/75">
              No memory files yet. Once <span className="font-medium text-foreground/85">{botDisplayName || 'the bot'}</span> writes
              to the seven cards or creates a topic page under <code className="rounded bg-muted/55 px-1 py-px text-[11.5px]">memory/topics/</code>,
              they'll appear here as a graph.
            </p>
          </div>
        )}

        {ready && graph.nodes.length > 0 && size.w > 0 && (
          <Suspense fallback={null}>
            <ForceGraph2D
              ref={graphRef}
              graphData={displayed}
              width={size.w}
              height={size.h}
              nodeRelSize={4}
              nodeCanvasObject={drawNode}
              nodeCanvasObjectMode={() => 'replace'}
              nodePointerAreaPaint={(node, color, ctx) => {
                const r = (NODE_RADIUS[node.kind] || 5) + 3;
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(node.x, node.y, r, 0, 2 * Math.PI, false);
                ctx.fill();
              }}
              linkColor={linkColour}
              linkWidth={linkWidth}
              linkDirectionalArrowLength={3}
              linkDirectionalArrowRelPos={1}
              linkDirectionalArrowColor={linkColour}
              cooldownTicks={120}
              onNodeClick={onNodeClick}
              onNodeHover={setHover}
              backgroundColor="rgba(0,0,0,0)"
            />
          </Suspense>
        )}

        {hover && (
          <HoverPreview node={hover} />
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/45 bg-background/60 px-5 py-2.5">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowBare(s => !s)}
            title={showBare ? 'Hide bare-name links (only [[wiki]] edges)' : 'Show bare-name links'}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] font-medium transition-colors',
              showBare
                ? 'border-border/55 bg-card/70 text-foreground/85 hover:bg-card'
                : 'border-border/55 bg-foreground/8 text-foreground hover:bg-foreground/12',
            )}
          >
            <Eye className="size-3" strokeWidth={1.75} />
            {showBare ? 'All edges' : 'Wiki only'}
          </button>
          {hasYours && (
            <div className="inline-flex items-center overflow-hidden rounded-md border border-border/55 text-[11px] font-medium">
              {[['all', 'All'], ['shared', '🌐 Shared'], ['yours', '👤 Yours']].map(([s, label]) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScopeFilter(s)}
                  className={cn(
                    'px-2 py-1 transition-colors',
                    scopeFilter === s
                      ? 'bg-foreground/10 text-foreground'
                      : 'text-muted-foreground/70 hover:bg-foreground/5',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {ready && (
            <span className="text-[11px] text-muted-foreground/65">
              {counts.nodes} nodes · {counts.wiki} links
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70">
          <Legend fill={NODE_COLOURS.index.fill} stroke={NODE_COLOURS.index.stroke} label="INDEX" />
          <Legend fill={NODE_COLOURS.card.fill}  stroke={NODE_COLOURS.card.stroke}  label="Card"  />
          <Legend fill={NODE_COLOURS.topic.fill} stroke={NODE_COLOURS.topic.stroke} label="Topic" />
          {hasYours && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-background/80 px-2 py-[3px] text-[10.5px] font-medium text-foreground/75">
              <span className="inline-block size-2 rounded-full" style={{ boxShadow: 'inset 0 0 0 1.5px #0284c7' }} />
              Yours
            </span>
          )}
        </div>
      </div>

      {activeNode && (
        <MemoryCardModal node={activeNode} onClose={() => setActiveNode(null)} />
      )}
    </div>
  );
}

function Legend({ fill, stroke, label }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-background/80 px-2 py-[3px] text-[10.5px] font-medium text-foreground/75"
    >
      <span
        className="inline-block size-2 rounded-full"
        style={{ background: fill, boxShadow: stroke ? `inset 0 0 0 1px ${stroke}` : undefined }}
      />
      {label}
    </span>
  );
}

const KIND_LABEL = { index: 'Index', card: 'Card', topic: 'Topic' };

// Curated one-line "what this card is for" descriptions — same role as a
// skill's frontmatter `description:` field. Used by the hover tooltip
// instead of raw markdown body so the panel reads as a "this is what
// lives here" surface, not a markdown note.
//
// Keyed by basename (case-insensitive). Topics + unknown cards fall back
// to the auto-stripped preview.
const CARD_DESCRIPTIONS = {
  INDEX:              'The wiki root. One-line summaries of every card + topic, plus a navigation rule of thumb.',
  USER_PROFILE:       'Stable facts about the user — role, location, languages, schedule, current focus.',
  USER_PREFERENCES:   'Soft preferences — tone, channels, formatting, working style.',
  USER_RELATIONSHIPS: 'People in the user’s life. One section per person, pointer to a topic page when deep context exists.',
  USER_REFLECTIONS:   'The user’s own self-introspection entries, dated. Newer on top.',
  RULES:              'Hard "never / always" rules. Override preferences when in conflict.',
  AGENT_IDENTITY:     'The agent’s voice, mood, defaults. What it leans into vs. what it flags.',
  AGENT_TOOLS:        'Per-tool gotchas + activation notes for the integrations active in this workspace.',
  RECENT_WEB:         'Rolling snapshot of the last ≈50 web-chat messages. Auto-maintained on idle + chat reset.',
  RECENT_TELEGRAM:    'Rolling snapshot of the last ≈50 Telegram exchanges. Auto-maintained when the bot is idle.',
};

function describeNode(node) {
  // Priority:
  //  1. node.purpose — the file's own YAML frontmatter `purpose:` line.
  //     Curator-authored, exact, kept fresh by whoever edited the card.
  //  2. CARD_DESCRIPTIONS — hard-coded fallback for canonical cards on
  //     fresh workspaces where the template hasn't been rewritten.
  //  3. cleanPreview — stripped body opening, last-resort for topics /
  //     patterns / threads that lack a `purpose:` field by design.
  const baseName = (node.name || node.id || '').toUpperCase().replace(/\.MD$/, '');
  return node.purpose || CARD_DESCRIPTIONS[baseName] || cleanPreview(node.preview);
}

/**
 * Strip markdown noise from a card body so the hover tooltip reads as
 * prose: YAML frontmatter, HTML comments, header markers, list bullets,
 * inline code, bold/italic, wiki + markdown links. Whitespace collapsed.
 *
 * Templates ship with frontmatter + `# Card name` + HTML comment scaffolding
 * (~30% noise on a fresh card). Stripping makes the 200-char preview show
 * actual content instead of `--- name: USER_PROFILE purpose: ... ---`.
 */
function cleanPreview(text) {
  if (!text) return '';
  let t = String(text);
  if (t.startsWith('---')) {
    const end = t.indexOf('\n---', 3);
    if (end > -1) t = t.slice(end + 4);
  }
  return t
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function HoverPreview({ node }) {
  const Icon = node.kind === 'index' ? Hash : node.kind === 'card' ? ShieldAlert : FileText;
  // Same priority chain as describeNode — purpose first, then the cleaned
  // body opening as fallback. Keeps the hover tile consistent with the
  // modal header so users see the same label in both surfaces.
  const cleaned = describeNode(node);
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 max-w-sm rounded-md border border-border/55 bg-popover/95 px-4 py-3 text-popover-foreground shadow-lg backdrop-blur-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="size-3.5 shrink-0 text-muted-foreground/65" strokeWidth={1.75} />
          <span className="truncate text-[13px] font-semibold text-foreground/90">{node.id}</span>
        </div>
        <span className="shrink-0 rounded-full border border-border/55 bg-background/80 px-1.5 py-[2px] text-[9.5px] font-medium uppercase tracking-wider text-muted-foreground/75">
          {KIND_LABEL[node.kind] || node.kind}
        </span>
      </div>
      <p className="mt-2 line-clamp-3 text-[12.5px] leading-relaxed text-foreground/75">
        {cleaned || <em className="text-muted-foreground/55">(empty)</em>}
      </p>
      <p className="mt-2.5 truncate text-[10.5px] text-muted-foreground/55">{node.relPath}</p>
    </div>
  );
}

function MemoryCardModal({ node, onClose }) {
  const Icon = node.kind === 'index' ? Hash : node.kind === 'card' ? ShieldAlert : FileText;
  const description = describeNode(node);
  const isAutoMaintained = /^RECENT_/i.test(node.name || node.id || '');

  const [content, setContent] = useState('');
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    const url = `/api/files/read?path=${encodeURIComponent(node.relPath)}`;
    fetch(url)
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) { setStatus('error'); setError(data.error || `HTTP ${r.status}`); return; }
        const body = typeof data.content === 'string' ? data.content : '';
        if (!body) {
          // Surface so an empty card body is visibly distinct from a fetch
          // that silently returned `{}`. Helps debug `/api/files/read`
          // shape regressions without opening DevTools.
          // eslint-disable-next-line no-console
          console.warn('[MemoryCardModal] empty content from', url, '— response shape:', data);
        }
        setContent(body);
        setStatus('ok');
      })
      .catch(err => { if (!cancelled) { setStatus('error'); setError(err.message); } });
    return () => { cancelled = true; };
  }, [node.relPath]);

  // Esc to close + lock body scroll.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prevOverflow; };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Memory: ${node.name || node.id}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-[3px] animate-[fade-in_0.12s_ease-out]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative flex max-h-[94vh] w-full max-w-4xl flex-col overflow-hidden rounded-md bg-background shadow-2xl">
        {/* Header — icon + name + kind pill + close */}
        <div className="flex items-center gap-3 border-b border-border/40 px-6 py-3.5">
          <Icon className="size-4 shrink-0 text-muted-foreground/70" strokeWidth={1.75} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14.5px] font-semibold text-foreground/90">{node.name || node.id}</div>
            {description && (
              <div className="truncate text-[12px] text-muted-foreground/75">{description}</div>
            )}
          </div>
          {node.scope === 'yours' && (
            <span className="shrink-0 rounded-full border border-sky-500/40 bg-sky-500/10 px-1.5 py-[2px] text-[9.5px] font-medium uppercase tracking-wider text-sky-600 dark:text-sky-400">
              Yours
            </span>
          )}
          <span className="shrink-0 rounded-full border border-border/55 bg-background/80 px-1.5 py-[2px] text-[9.5px] font-medium uppercase tracking-wider text-muted-foreground/75">
            {KIND_LABEL[node.kind] || node.kind}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground/65 transition-colors hover:bg-muted/30 hover:text-foreground/85"
            aria-label="Close"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </div>

        {/* Body — read-only content area */}
        <div className="flex-1 overflow-y-auto bg-background">
          {status === 'loading' && (
            <div className="flex h-full items-center justify-center gap-2 py-16 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          )}
          {status === 'error' && (
            <div className="flex h-full items-center justify-center px-8 py-16 text-center">
              <div className="flex max-w-md items-start gap-2 rounded-md border border-destructive/25 bg-destructive/[0.04] px-3.5 py-2.5 text-[12.5px] text-destructive">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
                <span>{error}</span>
              </div>
            </div>
          )}
          {status === 'ok' && (
            <div className="mx-auto min-h-full w-full max-w-3xl px-8 py-7">
              {isAutoMaintained && (
                <div className="mb-5 flex items-start gap-2 rounded-md border border-border/50 bg-muted/30 px-3.5 py-2 text-[12px] text-muted-foreground/85">
                  <Lock className="mt-0.5 size-3 shrink-0 text-muted-foreground/60" strokeWidth={2} />
                  <span>Auto-maintained — refreshed by workspace-api on idle and chat reset. Hand-edits get overwritten on the next snapshot tick.</span>
                </div>
              )}
              {content ? (
                <pre
                  className="block max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.7] tracking-[-0.005em] text-foreground/85"
                >
                  {content}
                </pre>
              ) : (
                <div className="rounded-md border border-dashed border-border/55 bg-muted/15 px-5 py-6 text-[12.5px] leading-relaxed text-muted-foreground/80">
                  <div className="font-medium text-foreground/80">Card body is empty.</div>
                  <div className="mt-1">
                    The file at <span className="font-mono text-[11.5px]">{node.relPath}</span> contains nothing past its frontmatter, or the read returned no content.
                    {node.preview && (
                      <>
                        {' '}Graph preview snippet for reference:
                        <div className="mt-2 rounded bg-background/60 px-3 py-2 font-mono text-[11.5px] text-foreground/70">{node.preview}</div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer — path + close shortcut hint */}
        <div className="flex items-center gap-2 border-t border-border/40 bg-background px-6 py-3">
          <span className="truncate text-[11.5px] text-muted-foreground/60">
            <span className="font-mono">{node.relPath}</span>
            <span className="mx-2 text-muted-foreground/40">·</span>
            close with <kbd className="rounded bg-muted/60 px-1 py-px font-mono text-[10.5px]">Esc</kbd>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded px-4 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground/85"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
