import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Plug, CheckCircle2, AlertTriangle, Lock, X, Loader2, ArrowRight, Trash2, Clock, Plus, ChevronDown, Download, Copy, Check as CheckIcon, HelpCircle, Settings as SettingsIcon, Search } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import EditorHeader from '../EditorHeader.jsx';
import { useBranding } from '../identity';
import { useApi, invalidate } from '@/lib/useApi';
import { SkeletonCardGrid } from '@/components/ui/Skeleton';
import { RestartingBanner, DoneBanner, RestartFailedBanner, runRestartPhases } from '../RestartBanners';

/**
 * Substitute {{key}} occurrences in `text` with values from `vars`. Used to
 * personalise catalog step bodies (e.g. suggesting "{{botDisplayName}}" as
 * the Telegram bot's display name). Missing keys leave the placeholder
 * intact rather than throwing — the catalog can omit fields safely.
 */
function interpolate(text, vars) {
  if (typeof text !== 'string') return text;
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) =>
    vars && vars[k] != null ? String(vars[k]) : m
  );
}

/**
 * Render a step body as markdown so catalog authors can use links, code,
 * lists and bold/italic without escaping HTML. Inline `code` gets a one-
 * click copy button — most steps include a hostname or env-var name the
 * user is meant to paste somewhere, and a copy button beats reach-for-
 * the-mouse selection for non-technical users.
 */
function StepBody({ body }) {
  return (
    <div className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground/90 [&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-0.5 [&_strong]:font-semibold [&_strong]:text-foreground/95">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-foreground underline decoration-foreground/35 underline-offset-[3px] transition-colors hover:decoration-foreground"
            >
              {children}
            </a>
          ),
          code: ({ inline, children }) => (
            inline ? <CopyableCode>{String(children).replace(/\n$/, '')}</CopyableCode>
                   : <code className="font-mono text-[12px]">{children}</code>
          ),
          pre: ({ children }) => <pre className="my-2 overflow-x-auto rounded-md border border-border/50 bg-muted/40 px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground/90">{children}</pre>,
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

function CopyableCode({ children }) {
  const [copied, setCopied] = useState(false);
  const text = String(children);
  const onCopy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* user denied */ }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? 'Copied' : 'Copy'}
      className="group/code mx-px inline-flex items-center gap-1 rounded border border-border/55 bg-muted/40 px-1.5 py-0 align-baseline font-mono text-[12px] text-foreground/90 transition-colors hover:border-foreground/30 hover:bg-muted/65"
    >
      {text}
      {copied
        ? <CheckIcon className="size-3 text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} />
        : <Copy className="size-3 text-muted-foreground/55 transition-colors group-hover/code:text-foreground/70" strokeWidth={1.75} />
      }
    </button>
  );
}

/**
 * Self-service integration activation.
 *
 *   GET  /api/integrations         → catalog + active state
 *   PUT  /api/integrations/:id     → activate (encrypted server-side)
 *   DEL  /api/integrations/:id     → wipe credentials + deactivate
 *
 * No edit by design: rotation = remove + activate again.
 *
 * Layout: responsive grid of brand tiles. Active first, then configurable
 * inactive, then "Coming soon" at the bottom.
 */
// Friendlier labels for the category chips. Catalog uses lowercase
// machine-readable values (`ai`, `marketing`, …); the UI gets a Capital-
// case display string. Keep this in sync with the categories actually
// used by integrations.catalog.json.
const CATEGORY_LABELS = {
  ai:           'AI',
  commerce:     'Commerce',
  marketing:    'Marketing',
  productivity: 'Productivity',
  messaging:    'Messaging',
  content:      'Content',
  dev:          'Dev',
  other:        'Other',
};

export default function IntegrationsDashboard({ sidebarOpen }) {
  const { botDisplayName } = useBranding();
  const { data, loading, error, reload: reloadApi } = useApi('/api/integrations');
  // `?activate=<integration-id>` opens the activation modal — works for
  // deep links + browser-back closes the modal + the bot's first-mention
  // capability surfacing can deep-link to "click here to set up Shopify".
  const [searchParams, setSearchParams] = useSearchParams();
  const activateId = searchParams.get('activate');
  const [activating, setActivating] = useState(null);
  const [removing, setRemoving]     = useState(null);
  const [settingsFor, setSettingsFor] = useState(null);

  // Telegram is configured in AI Settings (its own tile), not here — exclude it
  // from the Integrations catalog so it isn't set up in two places.
  const integrations = useMemo(() => (data?.integrations || []).filter(i => i.id !== 'telegram'), [data]);
  // Sync URL → activating state. When ?activate=<id> changes, find the
  // matching integration tile and open the activation modal on it.
  useEffect(() => {
    if (!activateId) { setActivating(null); return; }
    const match = integrations.find(i => i.id === activateId);
    if (match) setActivating(match);
  }, [activateId, integrations]);

  const openActivate = useCallback((integration) => {
    const next = new URLSearchParams(searchParams);
    next.set('activate', integration.id);
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  const closeActivate = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('activate');
    setSearchParams(next);
    setActivating(null);
  }, [searchParams, setSearchParams]);

  // Tab switches reuse cached data (skeleton only on the very first mount).
  // Mutations (activate/remove) call `reload()` to refresh; the cache is
  // shared across all `useApi('/api/integrations')` mounts via the module-
  // level Map, so any open dashboard tab updates in lockstep.
  const reload = useCallback(() => {
    invalidate('/api/integrations');
    return reloadApi();
  }, [reloadApi]);

  // First-ever mount with no cache hit → skeleton. Subsequent tab switches
  // have data immediately and revalidate silently in the background.
  const isInitialLoad = loading && !data;

  // Active is a filter view; Marketplace is the full catalog (active items
  // included, just rendered with their Active pill on the tile). Lets the
  // operator see at-a-glance "how much of Marketing do I have" without
  // having to mentally subtract the Active tab from the catalog.
  const active   = integrations.filter(i => i.active);
  const catalog  = useMemo(() => integrations, [integrations]);
  const ready    = data?.ready;

  // Auto-flip the default tab: fresh deploys land on Marketplace (no
  // active integrations to show), existing deploys land on Active. Only
  // runs on the first load that resolves integrations — after that we
  // respect whatever the operator clicked.
  const initialTabSet = useRef(false);
  useEffect(() => {
    if (initialTabSet.current) return;
    if (!data) return;
    initialTabSet.current = true;
    setTab(active.length === 0 ? 'marketplace' : 'active');
  }, [data, active.length]);

  // Marketplace state — search + category filter for the Available pane.
  const [query, setQuery]       = useState('');
  const [category, setCategory] = useState('all');  // 'all' | 'recommended' | <category-id>
  // Top-level tab — Active vs Marketplace. Default to Marketplace when
  // the operator has no active integrations yet (nothing else to show);
  // otherwise land on Active so they see their current setup first.
  const [tab, setTab] = useState('active');  // 'active' | 'marketplace'

  // Category facets: walk the catalog list, group by `category`, count.
  // Order is fixed so the chip row doesn't reshuffle as users activate/
  // remove things; categories that have no catalog items are dropped.
  const facets = useMemo(() => {
    const counts = new Map();
    for (const i of catalog) {
      const c = i.category || 'other';
      counts.set(c, (counts.get(c) || 0) + 1);
    }
    const ordered = ['ai', 'commerce', 'marketing', 'productivity', 'dev', 'messaging', 'content', 'other'];
    const items = [{ id: 'all', label: 'All', count: catalog.length }];
    for (const c of ordered) {
      const n = counts.get(c);
      if (n) items.push({ id: c, label: CATEGORY_LABELS[c] || c, count: n });
    }
    return items;
  }, [catalog]);

  // Filter + sort the catalog list. Search hits label + description, case-
  // insensitive. Sort puts comingSoon last; otherwise alpha by label.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog
      .filter(i => {
        if (category !== 'all' && (i.category || 'other') !== category) return false;
        if (!q) return true;
        return (
          (i.label || '').toLowerCase().includes(q) ||
          (i.description || '').toLowerCase().includes(q) ||
          (i.id || '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const cs = Number(!!a.comingSoon) - Number(!!b.comingSoon);
        if (cs !== 0) return cs;
        return (a.label || '').localeCompare(b.label || '');
      });
  }, [catalog, query, category]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader
        icon={Plug}
        title="Integrations"
        sidebarOpen={sidebarOpen}
      />

      <div className="flex-1 overflow-auto">
        <div className="flex flex-col gap-5 px-6 pb-12 pt-2">
          <p className="max-w-2xl text-[13.5px] leading-relaxed text-muted-foreground/85">
            Connect external services so the assistant can use them on your behalf. In case of any questions, message {botDisplayName}.
          </p>
          {isInitialLoad && <SkeletonCardGrid count={6} />}

          {error && !data && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
              Couldn't load integrations: {error}
            </div>
          )}

          {data && !ready && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3.5">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" strokeWidth={1.75} />
              <div className="text-[13px] text-foreground/85">
                <div className="font-medium">Integrations are not configured on this server.</div>
                <div className="mt-0.5 text-muted-foreground">
                  Ask your admin to mount the encryption key. Until then you can browse the catalog but can't activate anything.
                </div>
              </div>
            </div>
          )}

          {data && (active.length > 0 || catalog.length > 0) && (
            <>
              {/* Top-level tabs — Active vs Marketplace. Render both at all
                  times so we don't lose state (search query / category) on
                  switch; hide the inactive panel via `hidden` instead of
                  unmounting it. */}
              <Tabs
                value={tab}
                onChange={setTab}
                items={[
                  { id: 'active',      label: 'Active',      count: active.length },
                  { id: 'marketplace', label: 'Marketplace', count: catalog.length },
                ]}
              />

              <div className={cn(tab !== 'active' && 'hidden')}>
                {active.length > 0 ? (
                  <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,320px))]">
                    {active.map((integration) => (
                      <motion.div key={integration.id} layout transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}>
                        <IntegrationTile
                          integration={integration}
                          ready={ready}
                          onActivate={() => openActivate(integration)}
                          onRemove={() => setRemoving(integration)}
                          onSettings={() => setSettingsFor(integration)}
                        />
                      </motion.div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2 rounded-xl border border-border/40 bg-muted/15 px-6 py-12 text-center">
                    <Plug className="size-6 text-muted-foreground/45" strokeWidth={1.5} />
                    <div className="text-[13.5px] font-medium text-foreground/85">No active integrations yet</div>
                    <p className="max-w-sm text-[12.5px] text-muted-foreground/75">
                      Browse the Marketplace and activate the ones you'd like your coworker to use.
                    </p>
                    <button
                      type="button"
                      onClick={() => setTab('marketplace')}
                      className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition-opacity hover:opacity-95"
                    >
                      Open Marketplace
                      <ArrowRight className="size-3.5" strokeWidth={2} />
                    </button>
                  </div>
                )}
              </div>

              <div className={cn(tab !== 'marketplace' && 'hidden')}>
                <Marketplace
                  facets={facets}
                  category={category}
                  onCategory={setCategory}
                  query={query}
                  onQuery={setQuery}
                  items={filtered}
                  totalAvailable={catalog.length}
                  ready={ready}
                  onActivate={openActivate}
                  onRemove={(i) => setRemoving(i)}
                  onSettings={(i) => setSettingsFor(i)}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {activating && (
        <ActivateModal
          integration={activating}
          onClose={closeActivate}
          onSuccess={() => {
            // ActivateModal already drove the restart inline through the
            // runRestartPhases helper, so we just close + refresh here.
            closeActivate();
            reload();
          }}
        />
      )}

      {removing && (
        <RemoveDialog
          integration={removing}
          onClose={() => setRemoving(null)}
          onSuccess={() => { setRemoving(null); reload(); }}
        />
      )}

      {settingsFor && (
        <SettingsModal
          integration={settingsFor}
          onClose={() => setSettingsFor(null)}
          onSuccess={() => { setSettingsFor(null); reload(); }}
        />
      )}
    </div>
  );
}

// ─── Tabs ─────────────────────────────────────────────────────────────────

/**
 * Pill-style top-level tabs (Active | Marketplace). Selected tab uses
 * --foreground fill so it matches the rest of the workspace's neutral
 * palette — no brand-accent stripe. Counts in muted pills next to label.
 */
function Tabs({ value, onChange, items }) {
  return (
    <div role="tablist" className="inline-flex items-center gap-1 self-start rounded-lg border border-border/55 bg-muted/40 p-1">
      {items.map((it) => {
        const isActive = it.id === value;
        return (
          <button
            key={it.id}
            role="tab"
            type="button"
            aria-selected={isActive}
            onClick={() => onChange(it.id)}
            className={cn(
              'inline-flex items-center gap-2 rounded-md px-3.5 py-1.5 text-[13px] font-medium transition-colors',
              isActive
                ? 'bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.05)]'
                : 'text-muted-foreground/80 hover:text-foreground/90',
            )}
          >
            <span>{it.label}</span>
            <span className={cn(
              'rounded-full px-1.5 text-[10.5px] font-medium tabular-nums',
              isActive ? 'bg-muted/55 text-muted-foreground' : 'bg-background/70 text-muted-foreground/75',
            )}>
              {it.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Marketplace (Available section: search + category chips + grid) ─────

function Marketplace({
  facets, category, onCategory, query, onQuery,
  items, ready, onActivate, onRemove, onSettings,
}) {
  const filtered = items.length;
  // The filter context for the empty-state message — distinguish "no
  // results for search" from "no items in this category" from "nothing
  // catalog at all" so the operator gets a useful next step.
  const filterContext = query.trim()
    ? { kind: 'search',   value: query.trim() }
    : category !== 'all'
      ? { kind: 'category', value: facets.find(f => f.id === category)?.label || category }
      : null;

  return (
    <div className="flex flex-col gap-4">
      {/* Search input — keyboard-focus highlight via foreground ring so it
          matches the rest of the workspace inputs (no brand-accent ring). */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/55" strokeWidth={1.75} />
        <input
          type="text"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search integrations…"
          aria-label="Search integrations"
          className="w-full rounded-lg border border-border/60 bg-background py-2.5 pl-9 pr-9 text-[13.5px] text-foreground outline-none transition-colors focus:border-foreground/40 focus:ring-2 focus:ring-foreground/10"
        />
        {query && (
          <button
            type="button"
            onClick={() => onQuery('')}
            title="Clear search"
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground/55 transition-colors hover:bg-muted/40 hover:text-foreground/80"
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        )}
      </div>

      {/* Category chips — match the SkillsDashboard tag-filter bar exactly
          (rounded-md, border-foreground/45 on active, muted background).
          Subtle "this is selected" instead of a heavy black pill. */}
      <div className="flex flex-wrap items-center gap-2">
        {facets.map((f) => {
          const isActive = category === f.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => onCategory(f.id)}
              aria-pressed={isActive}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11.5px] font-medium leading-none transition-colors',
                isActive
                  ? 'border-foreground/45 bg-muted/70 text-foreground hover:bg-muted/85'
                  : 'border-border/55 bg-card text-foreground/80 hover:border-foreground/30 hover:bg-muted/40',
              )}
            >
              <span className="leading-none">{f.label}</span>
              <span className={cn('leading-none text-[10.5px] tabular-nums', isActive ? 'text-muted-foreground/85' : 'text-muted-foreground/65')}>
                {f.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Result grid OR empty state */}
      {filtered > 0 ? (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,320px))]">
          {items.map((integration) => (
            <motion.div key={integration.id} layout transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}>
              <IntegrationTile
                integration={integration}
                ready={ready}
                onActivate={() => onActivate(integration)}
                onRemove={() => onRemove(integration)}
                onSettings={() => onSettings(integration)}
              />
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-border/40 bg-muted/15 px-6 py-10 text-center">
          <Search className="size-6 text-muted-foreground/45" strokeWidth={1.5} />
          <div className="text-[13.5px] font-medium text-foreground/85">
            {filterContext?.kind === 'search'
              ? <>No integrations match "{filterContext.value}"</>
              : filterContext?.kind === 'category'
                ? <>No integrations in {filterContext.value}</>
                : 'Nothing in the marketplace yet'}
          </div>
          {filterContext && (
            <button
              type="button"
              onClick={() => { onQuery(''); onCategory('all'); }}
              className="mt-1 inline-flex items-center gap-1 rounded-md border border-border/55 bg-background px-3 py-1.5 text-[12.5px] text-foreground/80 transition-colors hover:bg-muted/40"
            >
              Show all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Tile ──────────────────────────────────────────────────────────────────

function IntegrationTile({ integration, ready, onActivate, onRemove, onSettings }) {
  const isActive     = integration.active;
  const isComingSoon = !!integration.comingSoon;
  const cantActivate = !ready && !isActive && !isComingSoon;
  const hasSettings  = isActive && (integration.fields || []).some(f => f.globalForMulti);

  return (
    <div className={cn(
      'group relative flex flex-col rounded-xl border bg-card transition-all duration-150',
      isActive       ? 'border-border/60 hover:border-foreground/15 hover:shadow-[0_2px_6px_rgba(0,0,0,0.035)]' :
      isComingSoon   ? 'border-border/40' :
      cantActivate   ? 'border-border/40' :
                       'border-border/60 hover:border-foreground/15 hover:shadow-[0_2px_6px_rgba(0,0,0,0.035)]',
    )}>
      {/* Header — logo + status pill */}
      <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3">
        <Logo src={integration.logo} alt={integration.label} dim={isComingSoon || cantActivate} />
        {isActive && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="size-2.5" strokeWidth={2.5} />
            Active
          </span>
        )}
        {isComingSoon && (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/80">
            <Clock className="size-2.5" strokeWidth={2.5} />
            Soon
          </span>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col px-4">
        <div className="text-[14.5px] font-semibold text-foreground/90">{integration.label}</div>
        <div className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground/80">
          {isComingSoon ? (integration.comingSoonReason || integration.description) : integration.description}
        </div>

        {isActive && (
          <div className="mt-3 flex items-center gap-2 rounded-md bg-muted/40 px-2.5 py-1.5">
            {integration.multi ? (
              <span className="text-[11.5px] text-foreground/75">
                {(integration.itemCount ?? 0)} {(integration.itemLabel || 'item').toLowerCase()}{(integration.itemCount ?? 0) === 1 ? '' : 's'}
              </span>
            ) : (
              <span className="font-mono text-[11.5px] text-foreground/70">
                {'••••'}{integration.credentialSummary?.last4 || ''}
              </span>
            )}
            <span className="text-[11px] text-muted-foreground/60">·</span>
            <span className="text-[11px] text-muted-foreground/70">
              {integration.activatedAt ? `activated ${formatRelative(new Date(integration.activatedAt))}` : 'stored'}
            </span>
          </div>
        )}
      </div>

      {/* Footer — action */}
      <div className="px-4 pb-4 pt-3.5">
        {isActive ? (
          <div className="flex items-center gap-2">
            {hasSettings && (
              <button
                type="button"
                onClick={onSettings}
                title="Settings"
                aria-label="Settings"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/40 text-muted-foreground/75 transition-colors hover:bg-muted/55 hover:text-foreground/90"
              >
                <SettingsIcon className="size-3.5" strokeWidth={1.75} />
              </button>
            )}
            <button
              type="button"
              onClick={onRemove}
              className="inline-flex flex-1 items-center justify-center rounded-md bg-muted/40 px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/75 transition-colors hover:bg-muted/55 hover:text-foreground/90"
            >
              Remove
            </button>
          </div>
        ) : isComingSoon ? (
          <button
            type="button"
            disabled
            className="inline-flex w-full cursor-not-allowed items-center justify-center gap-1.5 rounded-md border border-border/40 bg-muted/30 px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/55"
          >
            Coming soon
          </button>
        ) : cantActivate ? (
          <button
            type="button"
            disabled
            className="inline-flex w-full cursor-not-allowed items-center justify-center gap-1.5 rounded-md border border-border/40 bg-muted/30 px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/55"
          >
            <Lock className="size-3.5" strokeWidth={1.75} />
            Encryption not configured
          </button>
        ) : (
          <button
            type="button"
            onClick={onActivate}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition-all hover:opacity-95 active:scale-[0.98]"
          >
            Activate
            <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  );
}

// Catalog returns paths like "/integrations/grok.svg". The frontend is served
// from import.meta.env.BASE_URL ("/app/" in this app), so absolute paths from
// the catalog need to be re-rooted to that base, otherwise we 404.
function logoUrl(src) {
  if (!src) return null;
  if (/^https?:/.test(src)) return src;
  const base = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
  return `${base}${src.startsWith('/') ? src : '/' + src}`;
}

function Logo({ src, alt, dim }) {
  const [errored, setErrored] = useState(false);
  const url = logoUrl(src);
  // Logo tile is always a solid-white square in both themes. The brand
  // SVGs (Trello, Shopify, Grok, X, generic envelope, etc.) are designed
  // assuming a white backdrop, so we keep that fixed instead of fading
  // the tile in dark mode — full contrast on every glyph.
  return (
    <div
      className={cn(
        'flex size-12 shrink-0 items-center justify-center rounded-lg bg-white shadow-[inset_0_0_0_1px_rgba(0,0,0,0.05)] ring-1 ring-black/[0.04]',
        dim && 'opacity-50 grayscale',
      )}
    >
      {(!url || errored) ? (
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/65">
          {alt?.slice(0, 2)}
        </span>
      ) : (
        <img
          src={url}
          alt=""
          onError={() => setErrored(true)}
          className="size-7 object-contain"
        />
      )}
    </div>
  );
}

// ─── Field input (shared by single + multi forms) ──────────────────────────

function FieldInput({ field, value, onChange, disabled, inputId }) {
  const common = {
    id: inputId,
    autoComplete: 'off',
    spellCheck: false,
    placeholder: field.placeholder || '',
    value: value || '',
    onChange: (e) => onChange(e.target.value),
    disabled,
  };
  const inputCls = 'rounded border border-border/60 bg-background px-3.5 py-2.5 font-mono text-[13px] text-foreground outline-none transition-all focus:border-foreground/60 focus:ring-2 focus:ring-foreground/10 disabled:opacity-60';

  if (field.type === 'storage-state-json') {
    return (
      <StorageStateField
        field={field}
        value={value}
        onChange={onChange}
        disabled={disabled}
        inputId={inputId}
      />
    );
  }

  if (field.type === 'docs-comments-browser-login') {
    return (
      <DocsCommentsBrowserLoginField
        field={field}
        value={value}
        onChange={onChange}
        disabled={disabled}
        inputId={inputId}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={inputId} className="text-[13px] font-medium text-foreground/85">
        {field.label}
      </label>
      {field.type === 'json' ? (
        <textarea
          {...common}
          rows={8}
          className="resize-y rounded border border-border/60 bg-background px-3.5 py-2.5 font-mono text-[12px] leading-relaxed text-foreground outline-none transition-all focus:border-foreground/60 focus:ring-2 focus:ring-foreground/10 disabled:opacity-60"
        />
      ) : field.type === 'select' ? (
        <select
          id={inputId}
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="rounded border border-border/60 bg-background px-3.5 py-2.5 text-[13px] text-foreground outline-none transition-all focus:border-foreground/60 focus:ring-2 focus:ring-foreground/10 disabled:opacity-60"
        >
          {(field.options || []).map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      ) : (
        <input
          {...common}
          type={field.type === 'secret' ? 'password' : 'text'}
          className={inputCls}
        />
      )}
      {field.helper && (
        <div className="text-[11.5px] text-muted-foreground/70">{field.helper}</div>
      )}
    </div>
  );
}

/**
 * Specialised input for Playwright `storageState` JSON paste. Validates
 * shape client-side BEFORE the form is submittable, surfaces a preview
 * of how many cookies / origins parse cleanly, and supports drop-zone
 * for a JSON file from the operator's exporter.
 *
 * The backend re-validates AND filters cookies down to a domain whitelist
 * before encryption (see lib/integrations/storage-state.js) — this UI
 * preview is purely UX, not a security boundary.
 */
function StorageStateField({ field, value, onChange, disabled, inputId }) {
  const [dragOver, setDragOver] = useState(false);
  // Live-parsed summary of the current paste. `null` = empty input,
  // string = error message, object = { cookies, origins } counts.
  const parsed = useMemo(() => {
    if (!value || typeof value !== 'string' || value.trim() === '') return null;
    try {
      const obj = JSON.parse(value);
      if (Array.isArray(obj)) return { shape: 'cookies-array', cookies: obj.length, origins: 0 };
      if (obj && Array.isArray(obj.cookies)) {
        return {
          shape:   'storage-state',
          cookies: obj.cookies.length,
          origins: Array.isArray(obj.origins) ? obj.origins.length : 0,
        };
      }
      return 'Unrecognised shape — expected {cookies, origins} object or a cookies array.';
    } catch (err) {
      return `Invalid JSON: ${err.message}`;
    }
  }, [value]);

  const isError = typeof parsed === 'string';
  const isOk    = parsed && typeof parsed === 'object';

  const onDrop = useCallback(async (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      onChange(text);
    } catch (err) {
      // Shouldn't happen for plain JSON files; show error in the parsed
      // summary by surfacing invalid text rather than an alert.
      onChange(`(failed to read ${file.name}: ${err.message})`);
    }
  }, [onChange]);

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={inputId} className="text-[13px] font-medium text-foreground/85">
        {field.label}
      </label>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          'relative rounded border-2 border-dashed transition-colors',
          dragOver
            ? 'border-foreground/60 bg-foreground/[0.04]'
            : 'border-border/55',
        )}
      >
        <textarea
          id={inputId}
          autoComplete="off"
          spellCheck={false}
          placeholder={field.placeholder || '[ { "name": "SID", "domain": ".google.com", ... }, ... ]\n\nor a full Playwright storageState object.'}
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          rows={10}
          className="block w-full resize-y rounded bg-background px-3.5 py-2.5 font-mono text-[11.5px] leading-relaxed text-foreground outline-none disabled:opacity-60"
        />
        {!value && (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-[11px] text-muted-foreground/55">
            …or drop a .json file here
          </div>
        )}
      </div>
      {isError && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/[0.05] px-3 py-2 text-[12px] text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
          <span>{parsed}</span>
        </div>
      )}
      {isOk && (
        <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/[0.05] px-3 py-2 text-[12px] text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
          <span>
            Parsed: {parsed.cookies} cookie{parsed.cookies === 1 ? '' : 's'}, {parsed.origins} origin{parsed.origins === 1 ? '' : 's'}. Backend will filter to the allowed-domain set before saving.
          </span>
        </div>
      )}
      {field.helper && (
        <div className="text-[11.5px] text-muted-foreground/70">{field.helper}</div>
      )}
    </div>
  );
}

/**
 * Docs Comments interactive Google-login field. Renders a "Connect to Google"
 * button that pops a modal hosting an embedded noVNC client. The user logs
 * into Google inside the container's Chromium; the session lives in a
 * persistent profile dir that the docs-comments MCP later reuses via
 * launchPersistentContext.
 *
 * The field's stored value is just a boolean-ish "ok" string — actual
 * session lives in /var/wsapi-store/docs-comments-profile/ on the server. We
 * set value="ok" once the user clicks Done in the login modal so the
 * standard form submit treats the integration as configured.
 */
function DocsCommentsBrowserLoginField({ field, value, onChange, disabled, inputId }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);          // connect-start in flight
  const [vncUrl, setVncUrl] = useState(null);
  const [error, setError] = useState(null);
  const [iframeLoading, setIframeLoading] = useState(true);
  // Live session validity from the keep-alive probe (GET /status sessionValid):
  // true = refreshed, false = EXPIRED (needs interactive re-login), null = unknown
  // (no probe yet). "Connected ✓" alone lies — the saved value stays 'ok' even
  // after Google expires the browser session. This surfaces the real state.
  const [sessionValid, setSessionValid] = useState(null);

  useEffect(() => {
    if (value !== 'ok') { setSessionValid(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/integrations/docs-comments/status', { credentials: 'include' });
        const d = await r.json().catch(() => ({}));
        if (!cancelled) setSessionValid(typeof d.sessionValid === 'boolean' ? d.sessionValid : null);
      } catch { if (!cancelled) setSessionValid(null); }
    })();
    return () => { cancelled = true; };
  }, [value]);

  // The backend returns terse codes; turn them into something the operator can act on.
  const friendlyError = (msg) => {
    if (!msg) return "Couldn't start the sign-in browser. Click Connect to try again.";
    if (String(msg).includes('browser_failed_to_start'))
      return "The sign-in browser didn't come up in time. Click Connect to try again.";
    return String(msg);
  };

  const startConnect = async () => {
    setBusy(true);
    setError(null);
    setIframeLoading(true);
    try {
      // connect-start now blocks until the embedded browser is actually
      // reachable, so by the time this resolves the iframe will load cleanly.
      const res = await fetch('/api/integrations/docs-comments/connect-start', {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.vncUrl) throw new Error(data?.error || `HTTP ${res.status}`);
      setVncUrl(data.vncUrl);
      setOpen(true);
    } catch (err) {
      setError(friendlyError(err.message || String(err)));
    } finally {
      setBusy(false);
    }
  };

  // Tear the server-side session down (graceful — lets chromium flush the
  // profile). Used by both Done and Cancel so we never leave a stuck stack.
  const endSession = async () => {
    try {
      await fetch('/api/integrations/docs-comments/connect-done', {
        method: 'POST',
        credentials: 'include',
      });
    } catch { /* best effort */ }
  };

  const onDone = async () => {
    setBusy(true);
    await endSession();
    setOpen(false);
    setVncUrl(null);
    onChange('ok');
    setSessionValid(true);   // just logged in — clear any stale "expired" until the next probe
    setBusy(false);
  };

  const onCancel = async () => {
    setBusy(true);
    await endSession();
    setOpen(false);
    setVncUrl(null);
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={inputId} className="text-[13px] font-medium text-foreground/85">
        {field.label}
      </label>
      <div className="flex items-center gap-3">
        <button
          id={inputId}
          type="button"
          onClick={startConnect}
          disabled={disabled || busy}
          className="rounded border border-foreground/15 bg-foreground px-4 py-2 text-[13px] font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-60"
        >
          {busy ? 'Starting…' : value === 'ok' ? 'Reconnect to Google' : 'Connect to Google'}
        </button>
        {!busy && value === 'ok' && sessionValid === false && (
          <span className="text-[12px] font-medium text-amber-600/90 dark:text-amber-400/90">⚠ Session expired — click Reconnect</span>
        )}
        {!busy && value === 'ok' && sessionValid !== false && (
          <span className="text-[12px] font-medium text-emerald-600/90 dark:text-emerald-400/90">Connected ✓</span>
        )}
        {!busy && value !== 'ok' && (
          <span className="text-[12px] text-muted-foreground/70">Not connected</span>
        )}
      </div>
      {error && (
        <div className="flex items-center gap-2 rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-500/90">
          <span>{error}</span>
          <button type="button" onClick={startConnect} className="font-medium underline underline-offset-2 hover:no-underline">
            Retry
          </button>
        </div>
      )}
      {field.helper && (
        <div className="text-[11.5px] text-muted-foreground/70">{field.helper}</div>
      )}

      {open && vncUrl && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4">
          <div className="flex h-[88vh] w-[92vw] max-w-[1400px] flex-col overflow-hidden rounded-lg border border-border/40 bg-background shadow-2xl">
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border/40 px-4 py-3">
              <div>
                <div className="text-[13px] font-medium text-foreground/85">Sign in to Google</div>
                <div className="mt-0.5 text-[11.5px] text-muted-foreground/70">
                  Use the account the bot should comment as — 2FA and security keys work. Once the page shows you're signed in, click <b>Done</b>. The session is saved on the server; nothing leaves it.
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={busy}
                  className="rounded border border-border/60 px-3 py-1.5 text-[12px] text-foreground/80 transition-colors hover:bg-foreground/5 disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={onDone}
                  disabled={busy}
                  className="rounded border border-foreground/15 bg-foreground px-3 py-1.5 text-[12px] font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-60"
                >
                  Done — I'm signed in
                </button>
              </div>
            </div>
            <div className="relative grow">
              {iframeLoading && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-foreground/20 border-t-foreground/70" />
                  <div className="text-[12px] text-muted-foreground/80">Starting secure browser…</div>
                </div>
              )}
              <iframe
                title="Docs Comments browser login"
                src={vncUrl}
                onLoad={() => setIframeLoading(false)}
                className="h-full w-full border-0 bg-background"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Activate Modal ────────────────────────────────────────────────────────

export function ActivateModal({ integration, onClose, onSuccess }) {
  const branding = useBranding();
  // Step interpolation context — supports {{botDisplayName}}, {{botName}},
  // {{title}}, {{botAvatarUrl}}, {{logoUrl}}, {{iconUrl}} in step.title /
  // step.body / step.downloads[].{label,url,filename}.
  const stepVars = {
    botDisplayName: branding.botDisplayName,
    botName:        branding.botName,
    botAvatarUrl:   branding.botAvatarUrl,
    logoUrl:        branding.logoUrl,
    iconUrl:        branding.iconUrl,
    title:          branding.title,
  };

  const isMulti = !!integration.multi;
  const itemLabel = integration.itemLabel || 'Item';
  // For `multi` integrations, fields flagged `globalForMulti` are rendered
  // once at the top of the modal and the same value is copy-pasted into
  // every item's record at submit time. Keeps "workspace-level trust"
  // settings (e.g. "Allow sending email") visually distinct from
  // per-account credentials, without changing the on-disk shape.
  // Permission-style fields (`globalForMulti: true`) live in their own panel
  // at the top of the modal — applies to both multi (where one toggle is
  // copy-pasted into every account) AND single integrations like Google
  // Workspace (where it's just a workspace-level switch). Without lifting
  // them out, single integrations would render the toggle as a regular
  // dropdown form field, which is what we hand the user with the credential
  // inputs and reads as confusing UI.
  const globalFields  = (integration.fields || []).filter(f => f.globalForMulti);
  const perItemFields = (integration.fields || []).filter(f => !f.globalForMulti);
  // Browser-login integrations (e.g. Docs Comments) activate themselves through
  // their own Connect → Done flow (connect-start pre-activates server-side).
  // There is no separate "Activate" step — the field IS the whole form. We
  // detect it here so we can hide the redundant footer button and auto-finalise
  // when the field reports it's signed in.
  const browserLoginField = !integration.multi
    ? perItemFields.find(f => typeof f.type === 'string' && f.type.endsWith('browser-login'))
    : null;
  const [globalVals, setGlobalVals] = useState(() =>
    Object.fromEntries(globalFields.map(f => [f.name, f.default ?? ''])));

  // Build a blank set of values from catalog defaults. For `multi`, only
  // the per-item field set is initialised here — global fields live in
  // their own state above.
  const blankItem = () =>
    Object.fromEntries(perItemFields.map(f => [f.name, f.default ?? '']));

  // Single integration: values is one object. Multi: array of objects.
  const [items, setItems] = useState(() => isMulti ? [blankItem()] : null);
  const [single, setSingle] = useState(() => isMulti ? null : blankItem());
  // Accordion: index of the currently expanded item, or -1 to collapse all.
  const [expandedIdx, setExpandedIdx] = useState(0);
  // phase: 'idle' | 'saving' | 'restarting' | 'done'. See RestartBanners.jsx
  // for the shape; same state machine across ClaudeDashboard + every
  // integration modal so operators learn one save-then-restart shape.
  const [phase, setPhase] = useState('idle');
  const [restartFailed, setRestartFailed] = useState(false);
  const [error, setError] = useState(null);
  const busy = phase !== 'idle';

  const updateItem = (i, patch) => setItems(prev =>
    prev.map((x, idx) => idx === i ? { ...x, ...patch } : x),
  );
  const addItem = () => {
    setItems(prev => {
      const next = [...prev, blankItem()];
      // Expand the freshly-added item, collapsing whatever was open.
      setExpandedIdx(next.length - 1);
      return next;
    });
  };
  const removeItem = (i) => {
    setItems(prev => {
      const next = prev.filter((_, idx) => idx !== i);
      // If we removed the expanded one (or one before it), keep expansion sane.
      setExpandedIdx(curr => {
        if (next.length === 0) return -1;
        if (curr === i)  return Math.max(0, i - 1);
        if (curr > i)    return curr - 1;
        return curr;
      });
      return next;
    });
  };
  const toggleExpand = (i) => setExpandedIdx(curr => curr === i ? -1 : i);

  // showIf evaluator — needs the values it should check against (per-item).
  const isVisibleIn = (field, vals) => {
    if (!field.showIf) return true;
    return Object.entries(field.showIf).every(([k, v]) => vals[k] === v);
  };

  const itemFilled = (vals) => perItemFields.every(
    f => f.optional || !isVisibleIn(f, vals) || (vals[f.name] || '').trim().length > 0,
  );
  // Global multi-fields are always present (defaults come from catalog), so
  // they never block submit. Just gate on the per-item rows / single body.
  const allFilled = isMulti ? items.every(itemFilled) : itemFilled(single);

  const submit = async (e) => {
    e?.preventDefault();
    setError(null);
    setRestartFailed(false);
    setPhase('saving');
    try {
      // For multi integrations, fold global field values into every item
      // record. For single integrations, merge them into the single fields
      // object (Google Workspace's permission toggle ships alongside the
      // OAuth creds in one record). The store receives a uniform shape
      // either way; the UI just spared the user from a second form.
      const body = isMulti
        ? { items: items.map(v => ({ fields: { ...v, ...globalVals } })) }
        : { fields: { ...single, ...globalVals } };
      const resp = await fetch(`/api/integrations/${encodeURIComponent(integration.id)}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      await runRestartPhases({ response: data, setPhase, setRestartFailed });
      onSuccess();
    } catch (err) {
      setError(err.message);
      setPhase('idle');
    }
  };

  // Browser-login: when the field flips to "ok" (operator clicked Done — I'm
  // signed in), finish the activation automatically. connect-start already
  // marked it active server-side; submit() here is the now-idempotent PUT that
  // syncs the MCP + restarts the bot, then closes the modal. No separate
  // "Activate" click → no "already active" confusion.
  useEffect(() => {
    if (browserLoginField && phase === 'idle' && single?.[browserLoginField.name] === 'ok') {
      submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [single, browserLoginField, phase]);

  return (
    <ModalShell onClose={onClose} ariaLabel={`Activate ${integration.label}`}>
      <form onSubmit={submit} className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-background shadow-2xl">
        {/* Header — logo + title only, no description */}
        <div className="flex items-center gap-3.5 border-b border-border/50 px-8 py-5">
          <Logo src={integration.logo} alt={integration.label} />
          <div className="min-w-0 flex-1 text-[17px] font-semibold text-foreground">
            Activate {integration.label}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground/65 transition-colors hover:bg-muted/30 hover:text-foreground/85"
            aria-label="Close"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </div>

        {/* Body — two columns: instructions on left (sticky), form on right (independently scrollable). */}
        <div className="grid flex-1 overflow-y-auto md:grid-cols-2 md:overflow-hidden">
          {/* Left column — stepped instructions */}
          {integration.steps?.length > 0 && (
            <div className="bg-muted/20 px-8 py-7 md:overflow-y-auto md:border-r md:border-border/40">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                How to get your key
              </div>
              <ol className="mt-5 flex flex-col">
                {integration.steps.map((step, i) => {
                  const isLast = i === integration.steps.length - 1;
                  return (
                    <li key={i} className="relative flex gap-4 pb-6 last:pb-0">
                      {!isLast && (
                        <span className="absolute left-3 top-7 bottom-0 w-px bg-border/70" aria-hidden />
                      )}
                      <div className="z-10 flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-[11px] font-semibold text-background ring-4 ring-muted/20">
                        {i + 1}
                      </div>
                      <div className="min-w-0 flex-1 pt-0.5">
                        <div className="text-[14px] font-medium text-foreground/90">{interpolate(step.title, stepVars)}</div>
                        <StepBody body={interpolate(step.body, stepVars)} />
                        {Array.isArray(step.downloads) && step.downloads.length > 0 && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {step.downloads.map((d, j) => {
                              const url = interpolate(d.url, stepVars);
                              const filename = interpolate(d.filename || '', stepVars);
                              return (
                                <a
                                  key={j}
                                  href={url}
                                  download={filename || true}
                                  className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-background px-3 py-1.5 text-[12px] font-medium text-foreground/85 transition-all hover:border-foreground/30 hover:bg-muted/30 hover:text-foreground active:scale-[0.99]"
                                >
                                  <Download className="size-3.5" strokeWidth={1.75} />
                                  {interpolate(d.label, stepVars)}
                                </a>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>

              {/* Escape hatch when the steps aren't enough — drops a help
                  prompt into the chat composer (NOT auto-sent). User can
                  refine before sending. The prompt explicitly tells the
                  bot NOT to ask for any keys/secrets in chat — those
                  belong only in the form on the right. */}
              <button
                type="button"
                onClick={() => {
                  const stepsBlock = (integration.steps || []).map((s, i) => {
                    const title = interpolate(s.title, stepVars);
                    const body  = interpolate(s.body,  stepVars);
                    return `## ${i + 1}. ${title}\n\n${body}`;
                  }).join('\n\n');
                  const prompt =
`I'm activating the **${integration.label}** integration. Walk me through it step by step — these are the instructions from the activation form:

${stepsBlock}

Please guide me through these one at a time. Ask whatever you need about my account / company / setup to help me move forward.

Important: do NOT ask me to paste any keys, tokens, or passwords into chat. I'll put those directly into the form on the right side of the workspace. You only help me find them and understand what each field means.`;
                  window.dispatchEvent(new CustomEvent('ide:chat-prefill', { detail: { text: prompt } }));
                  onClose();
                }}
                className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border/60 bg-background px-3 py-2.5 text-[12.5px] font-medium text-foreground/85 transition-all hover:border-foreground/30 hover:bg-muted/30 active:scale-[0.99]"
              >
                <HelpCircle className="size-3.5" strokeWidth={1.75} />
                Ask {branding.botDisplayName} for help
              </button>
              <div className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground/65">
                Drops a help prompt in the chat. Keys still go in the form on the right — never paste them in chat.
              </div>
            </div>
          )}

          {/* Right column — credentials form */}
          <div className="flex flex-col gap-5 border-t border-border/40 px-8 py-7 md:overflow-y-auto md:border-t-0">
            {globalFields.length > 0 && (
              <PermissionsPanel fields={globalFields} values={globalVals} onChange={setGlobalVals} disabled={busy} />
            )}

            <div className="flex items-center justify-between">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                Credentials
              </div>
              {isMulti && (
                <div className="text-[11px] text-muted-foreground/70">
                  {items.length} {items.length === 1 ? itemLabel.toLowerCase() : `${itemLabel.toLowerCase()}s`}
                </div>
              )}
            </div>

            {isMulti ? (
              <div className="flex flex-col gap-2.5">
                {items.map((vals, idx) => {
                  const expanded = idx === expandedIdx;
                  const summary = itemSummary(vals, integration.fields);
                  const canRemove = items.length > (integration.minItems || 1);
                  return (
                    <div key={idx} className="overflow-hidden rounded border border-border/50 bg-background">
                      <button
                        type="button"
                        onClick={() => toggleExpand(idx)}
                        className={cn(
                          'flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors',
                          expanded ? 'bg-muted/25' : 'bg-muted/10 hover:bg-muted/20',
                        )}
                      >
                        <ChevronDown
                          className={cn('size-3.5 shrink-0 text-muted-foreground/70 transition-transform', expanded ? '' : '-rotate-90')}
                          strokeWidth={2}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-[12px] font-medium text-foreground/85">
                            {itemLabel} {idx + 1}
                          </div>
                          {summary && !expanded && (
                            <div className="truncate text-[11.5px] text-muted-foreground/75">{summary}</div>
                          )}
                        </div>
                        {canRemove && (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => { e.stopPropagation(); if (!busy) removeItem(idx); }}
                            onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !busy) { e.stopPropagation(); removeItem(idx); } }}
                            className="rounded p-1 text-muted-foreground/65 transition-colors hover:bg-muted/30 hover:text-destructive"
                            aria-label={`Remove ${itemLabel} ${idx + 1}`}
                          >
                            <Trash2 className="size-3.5" strokeWidth={1.75} />
                          </span>
                        )}
                      </button>
                      {expanded && (
                        <div className="flex flex-col gap-3.5 border-t border-border/40 px-3.5 py-3.5">
                          {perItemFields.filter(f => isVisibleIn(f, vals)).map(field => (
                            <FieldInput
                              key={field.name}
                              field={field}
                              value={vals[field.name] || ''}
                              onChange={(v) => updateItem(idx, { [field.name]: v })}
                              disabled={busy}
                              inputId={`f-${idx}-${field.name}`}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                <button
                  type="button"
                  onClick={addItem}
                  disabled={busy}
                  className="inline-flex items-center justify-center gap-1.5 rounded border border-dashed border-border/70 bg-background px-3 py-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:border-foreground/40 hover:bg-muted/20 hover:text-foreground/85"
                >
                  <Plus className="size-3.5" strokeWidth={2} />
                  Add another {itemLabel.toLowerCase()}
                </button>
              </div>
            ) : (
              perItemFields.filter(f => isVisibleIn(f, single)).map(field => (
                <FieldInput
                  key={field.name}
                  field={field}
                  value={single[field.name] || ''}
                  onChange={(v) => setSingle(s => ({ ...s, [field.name]: v }))}
                  disabled={busy}
                  inputId={`f-${field.name}`}
                />
              ))
            )}

            {error && (
              <div className="flex items-start gap-2 rounded border border-destructive/25 bg-destructive/[0.04] px-3.5 py-2.5 text-[12.5px] text-destructive">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
                <span>{error}</span>
              </div>
            )}

            <div className="mt-auto flex items-start gap-2 rounded bg-muted/30 px-3.5 py-3 text-[11.5px] leading-relaxed text-muted-foreground/85">
              <Lock className="mt-0.5 size-3 shrink-0 text-muted-foreground/55" strokeWidth={2} />
              <span>
                Stored encrypted on the server (AES-256-GCM). After activation only the last 4 characters are visible. To rotate, remove and activate again.
              </span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-3 border-t border-border/50 bg-background px-8 py-4">
          {phase === 'restarting' && <RestartingBanner />}
          {phase === 'done' && !restartFailed && <DoneBanner />}
          {restartFailed && <RestartFailedBanner />}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded px-4 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground/85 disabled:opacity-50"
            >
              Cancel
            </button>
            {browserLoginField ? (
              // No separate Activate button — the Connect → Done flow above
              // activates it. Just reflect progress / nudge the user.
              busy ? (
                <span className="inline-flex items-center gap-1.5 px-2 py-2 text-[13px] font-medium text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  {phase === 'restarting' ? 'Restarting bot…' : 'Finishing…'}
                </span>
              ) : (
                <span className="px-2 py-2 text-[12px] text-muted-foreground/70">
                  Click <b>Connect to Google</b> above, sign in, then <b>Done</b>.
                </span>
              )
            ) : (
              <button
                type="submit"
                disabled={busy || !allFilled}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded px-6 py-2 text-[13px] font-medium transition-all',
                  busy || !allFilled
                    ? 'cursor-not-allowed bg-muted text-muted-foreground/60'
                    : 'bg-foreground text-background hover:opacity-95 active:scale-[0.98]',
                )}
              >
                {(phase === 'saving' || phase === 'restarting') && <Loader2 className="size-3.5 animate-spin" />}
                {phase === 'saving'
                  ? 'Activating…'
                  : phase === 'restarting'
                    ? 'Restarting bot…'
                    : phase === 'done'
                      ? (restartFailed ? 'Saved' : 'Done')
                      : 'Activate'}
              </button>
            )}
          </div>
        </div>
      </form>
    </ModalShell>
  );
}

// ─── Settings Modal ────────────────────────────────────────────────────────

/**
 * Settings modal — pinned to the gear button on active tiles. Lets the user
 * flip the workspace-level Permissions toggles without having to Remove +
 * Activate again (which would lose all credentials and force them to
 * re-paste the IMAP password etc.).
 *
 * MVP scope: only the global / Permissions fields are editable here. To
 * rotate per-account credentials the user still goes through Remove +
 * Activate. That's the deliberate trade-off — the audit log keeps a clean
 * record of credential lifecycle, while ergonomic toggles become free.
 */
function SettingsModal({ integration, onClose, onSuccess }) {
  const globalFields = (integration.fields || []).filter(f => f.globalForMulti);

  const initial = globalFields.reduce((acc, f) => {
    acc[f.name] = integration.globalFieldValues?.[f.name] ?? f.default ?? '';
    return acc;
  }, {});
  const [values, setValues] = useState(initial);
  const [phase, setPhase] = useState('idle');
  const [restartFailed, setRestartFailed] = useState(false);
  const [error, setError] = useState(null);
  const busy = phase !== 'idle';

  const save = async (e) => {
    e?.preventDefault();
    setError(null);
    setRestartFailed(false);
    setPhase('saving');
    try {
      const body = integration.multi
        ? { globalFields: values }
        : { fields: values };
      const resp = await fetch(`/api/integrations/${encodeURIComponent(integration.id)}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      await runRestartPhases({ response: data, setPhase, setRestartFailed });
      onSuccess();
    } catch (err) {
      setError(err.message);
      setPhase('idle');
    }
  };

  return (
    <ModalShell onClose={onClose} ariaLabel={`${integration.label} settings`}>
      <form onSubmit={save} className="flex w-full max-w-lg flex-col overflow-hidden rounded-lg bg-background shadow-2xl">
        <div className="flex items-center gap-3.5 border-b border-border/50 px-7 py-5">
          <Logo src={integration.logo} alt={integration.label} />
          <div className="min-w-0 flex-1 text-[16px] font-semibold text-foreground">
            {integration.label} · Settings
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground/65 transition-colors hover:bg-muted/30 hover:text-foreground/85"
            aria-label="Close"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-7 py-6">
          {globalFields.length === 0 ? (
            <div className="text-[13px] leading-relaxed text-muted-foreground/85">
              Nothing configurable here yet. To rotate credentials, remove the integration and activate again.
            </div>
          ) : (
            <PermissionsPanel fields={globalFields} values={values} onChange={setValues} disabled={busy} />
          )}

          {error && (
            <div className="flex items-start gap-2 rounded border border-destructive/25 bg-destructive/[0.04] px-3.5 py-2.5 text-[12.5px] text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-border/50 bg-background px-7 py-4">
          {phase === 'restarting' && <RestartingBanner />}
          {phase === 'done' && !restartFailed && <DoneBanner />}
          {restartFailed && <RestartFailedBanner />}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded px-4 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground/85 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || globalFields.length === 0}
              className={cn(
                'inline-flex items-center gap-1.5 rounded px-6 py-2 text-[13px] font-medium transition-all',
                busy || globalFields.length === 0
                  ? 'cursor-not-allowed bg-muted text-muted-foreground/60'
                  : 'bg-foreground text-background hover:opacity-95 active:scale-[0.98]',
              )}
            >
              {(phase === 'saving' || phase === 'restarting') && <Loader2 className="size-3.5 animate-spin" />}
              {phase === 'saving'
                ? 'Saving…'
                : phase === 'restarting'
                  ? 'Restarting bot…'
                  : phase === 'done'
                    ? (restartFailed ? 'Saved' : 'Done')
                    : 'Save'}
            </button>
          </div>
        </div>
      </form>
    </ModalShell>
  );
}

// ─── Remove Dialog ─────────────────────────────────────────────────────────

/**
 * "Permissions" panel — pinned to the top of the credentials column on
 * `multi` integrations that have any `globalForMulti` field. Renders each
 * permission as an inline iOS-style toggle (for select fields with two
 * options) or a regular FieldInput (anything else), so the workspace-
 * level decisions are visible immediately rather than tucked under a
 * collapsible. The single value is propagated to every item at submit.
 */
function PermissionsPanel({ fields, values, onChange, disabled }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/50 bg-muted/15 px-4 py-3.5">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        Permissions
      </div>
      <div className="flex flex-col gap-3">
        {fields.map(field => (
          <PermissionRow
            key={field.name}
            field={field}
            value={values[field.name] ?? field.default ?? ''}
            onChange={(v) => onChange(prev => ({ ...prev, [field.name]: v }))}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  );
}

function PermissionRow({ field, value, onChange, disabled }) {
  // For select-with-two-options (the canonical Yes/No toggle case), render
  // an iOS-style switch instead of a dropdown — much clearer at a glance.
  const isBoolToggle =
    field.type === 'select' &&
    Array.isArray(field.options) &&
    field.options.length === 2 &&
    field.options.some(o => o.value === 'yes') &&
    field.options.some(o => o.value === 'no');

  if (isBoolToggle) {
    const on = String(value).toLowerCase() === 'yes';
    return (
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-foreground/90">{field.label}</div>
          {field.helper && (
            <div className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground/75">{field.helper}</div>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={field.label}
          disabled={disabled}
          onClick={() => onChange(on ? 'no' : 'yes')}
          className={cn(
            'mt-0.5 relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
            on ? 'bg-emerald-500' : 'bg-muted',
          )}
        >
          <span className={cn(
            'inline-block size-4 rounded-full bg-white shadow transition-transform',
            on ? 'translate-x-[18px]' : 'translate-x-0.5',
          )} />
        </button>
      </div>
    );
  }

  // Fallback for any other field type — render the standard FieldInput,
  // matched to the panel's tighter spacing.
  return (
    <FieldInput
      field={field}
      value={value}
      onChange={onChange}
      disabled={disabled}
      inputId={`global-${field.name}`}
    />
  );
}

// `title`/`body`/`confirmLabel`/`busyLabel`/`doneLabel` are optional copy
// overrides — defaults keep the Integrations "Remove" wording; AI-Settings
// Telegram reuses this dialog with "Disconnect" wording.
export function RemoveDialog({ integration, onClose, onSuccess, title, body, confirmLabel, busyLabel, doneLabel }) {
  const [phase, setPhase] = useState('idle');
  const [restartFailed, setRestartFailed] = useState(false);
  const [error, setError] = useState(null);
  const busy = phase !== 'idle';

  const remove = async () => {
    setError(null);
    setRestartFailed(false);
    setPhase('saving');
    try {
      const resp = await fetch(`/api/integrations/${encodeURIComponent(integration.id)}`, { method: 'DELETE' });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      await runRestartPhases({ response: data, setPhase, setRestartFailed });
      onSuccess();
    } catch (err) {
      setError(err.message);
      setPhase('idle');
    }
  };

  return (
    <ModalShell onClose={onClose} ariaLabel={`Remove ${integration.label}`}>
      <div className="w-full max-w-lg overflow-hidden rounded-lg bg-background shadow-2xl">
        <div className="flex items-start gap-4 px-7 py-7">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-destructive/10">
            <Trash2 className="size-4 text-destructive" strokeWidth={2} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-semibold text-foreground">{title || `Remove ${integration.label}?`}</div>
            <div className="mt-2 text-[13px] leading-relaxed text-muted-foreground/85">
              {body || "This deactivates the integration and erases the stored credentials. To use it again, you'll need to enter a new key."}
            </div>
            {error && (
              <div className="mt-4 rounded border border-destructive/25 bg-destructive/[0.04] px-3 py-2 text-[12px] text-destructive">
                {error}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-border/50 bg-muted/20 px-7 py-4">
          {phase === 'restarting' && <RestartingBanner />}
          {phase === 'done' && !restartFailed && <DoneBanner />}
          {restartFailed && <RestartFailedBanner />}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded px-4 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground/85 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded bg-destructive px-5 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-95 disabled:opacity-50"
            >
              {(phase === 'saving' || phase === 'restarting') && <Loader2 className="size-3.5 animate-spin" />}
              {phase === 'saving'
                ? (busyLabel || 'Removing…')
                : phase === 'restarting'
                  ? 'Restarting bot…'
                  : phase === 'done'
                    ? (restartFailed ? (doneLabel || 'Removed') : 'Done')
                    : (confirmLabel || 'Remove')}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

// ─── Modal shell ───────────────────────────────────────────────────────────

export function ModalShell({ children, onClose, ariaLabel }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    // Lock body scroll while modal is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-[3px] animate-[fade-in_0.12s_ease-out]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {children}
    </div>
  );
}

// Build a one-line summary for a collapsed accordion item — picks an
// "address-y" field if there is one (email user, store domain, ad account)
// else falls back to the first non-secret value the user typed.
function itemSummary(vals, fields) {
  if (!vals) return '';
  const PRIMARY_KEYS = ['EMAIL_USER', 'SHOPIFY_STORE_DOMAIN', 'META_AD_ACCOUNT_ID', 'GA4_PROPERTY_ID'];
  for (const k of PRIMARY_KEYS) {
    if (typeof vals[k] === 'string' && vals[k].trim()) return vals[k].trim();
  }
  for (const f of (fields || [])) {
    if (f.type === 'secret') continue;
    const v = vals[f.name];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function formatRelative(date) {
  const diff = Date.now() - date.getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return date.toLocaleDateString();
}
