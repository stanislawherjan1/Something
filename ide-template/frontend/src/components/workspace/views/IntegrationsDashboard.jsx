import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Plug, CheckCircle2, AlertTriangle, Lock, X, Loader2, ArrowRight, Trash2, Clock, Plus, ChevronDown, Download, Copy, Check as CheckIcon, HelpCircle, Settings as SettingsIcon, Search, Brain, Users, Sparkles, BrainCircuit, MessageSquareText, ShoppingBag, Store, CreditCard, Wallet, Landmark, Receipt, Megaphone, BarChart3, Mail, Video, Mic, NotebookPen, CalendarDays, FileText, ListTodo, KanbanSquare, CheckSquare, GitBranch, MessageCircle, Send, AtSign, PenLine, Image, Globe, Code2, Terminal, Database, Boxes, Puzzle, User, LayoutGrid, Eye, Info } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import TileBanner from './TileBanner.jsx';
import StatusTag from './StatusTag.jsx';
import EditorHeader from '../EditorHeader.jsx';
import { isRemoteMcpOauth, isOpenServer, openOAuthPopup } from './integrationConnect.js';
import { useIntegrationToasts, IntegrationToasts } from './integrationToasts.jsx';
import { Avatar } from './TeamDashboard.jsx';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@/components/ui/dropdown-menu';
import { useBranding, BrandedImage } from '../identity';
import { useApi, invalidate } from '@/lib/useApi';

import useMe from '../useMe.js';
import { SkeletonCardGrid } from '@/components/ui/Skeleton';
import { RestartingBanner, DoneBanner, RestartFailedBanner, runRestartPhases, RESTART_WINDOW_MS } from '../RestartBanners';
import { Plus as PlusIcon } from 'lucide-react';

/**
 * Substitute {{key}} occurrences in `text` with values from `vars`. Used to
 * personalise catalog step bodies (e.g. suggesting "{{botDisplayName}}" as
 * the Telegram bot's display name). Missing keys leave the placeholder
 * intact rather than throwing — the catalog can omit fields safely.
 */
export function interpolate(text, vars) {
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
export function StepBody({ body }) {
  return (
    <div className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground/90 [&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-0.5 [&_strong]:font-medium [&_strong]:text-foreground/70">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-foreground/85 underline decoration-foreground/25 underline-offset-[3px] transition-colors hover:text-foreground hover:decoration-foreground/60"
            >
              {children}
            </a>
          ),
          code: ({ inline, children }) => (
            inline ? <CopyableCode>{String(children).replace(/\n$/, '')}</CopyableCode>
                   : <code className="font-mono text-[12px]">{children}</code>
          ),
          pre: ({ children }) => <pre className="my-2 overflow-x-auto rounded-[6px] border border-border/50 bg-muted/40 px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground/90">{children}</pre>,
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
// Anything served by a provider-hosted MCP — OAuth or open — is "one-click"
// in the marketplace: nothing to paste either way.
const isOneClick = (integration) => integration?.mcp?.type === 'http';

// What a category looks like on its marketplace banner: a few icons drawn as
// the halftone, the same way an active tile draws its logo.
const CATEGORY_ICONS = {
  ai:           [Sparkles, BrainCircuit, MessageSquareText],
  commerce:     [ShoppingBag, Store, CreditCard],
  finance:      [Wallet, Landmark, Receipt],
  marketing:    [Megaphone, BarChart3, Mail],
  meetings:     [Video, Mic, NotebookPen],
  productivity: [CalendarDays, FileText, ListTodo],
  tasks:        [KanbanSquare, CheckSquare, GitBranch],
  messaging:    [MessageCircle, Send, AtSign],
  content:      [PenLine, Image, Globe],
  dev:          [Code2, Terminal, Database],
  other:        [Plug, Boxes, Puzzle],
};

const CATEGORY_LABELS = {
  ai:           'AI',
  commerce:     'Commerce',
  finance:      'Finance',
  marketing:    'Marketing',
  meetings:     'Meetings',
  productivity: 'Productivity',
  tasks:        'Tasks & projects',
  messaging:    'Messaging',
  content:      'Content',
  dev:          'Dev',
  other:        'Other',
};

export default function IntegrationsDashboard({ sidebarOpen }) {
  const { botDisplayName } = useBranding();
  // Integrations are admin-managed; everyone else sees them read-only (the
  // server 403s the writes — this gates the UI to match).
  const { me } = useMe();
  const isAdmin = !!me?.isAdmin;
  // Solo is a team of one: no Team / Yours split, no access to choose.
  const solo = me?.teamMode === false;
  const { data, loading, error, reload: reloadApi } = useApi('/api/integrations');
  // Which connected integrations feed this person's memory (Memory → Sources).
  const { data: sourcesData, reload: reloadSources } = useApi('/api/memory/v4/sources');
  const memorySources = sourcesData?.items || [];
  const setMemorySource = async (id, on) => {
    try {
      await fetch(`/api/memory/v4/sources/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ on }) });
    } finally { reloadSources(); }
  };
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
  // Telegram and Slack have screens of their own under AI Settings.
  const integrations = useMemo(() => (data?.integrations || []).filter(i => i.id !== 'telegram' && i.id !== 'slack'), [data]);
  // Sync URL → activating state. When ?activate=<id> changes, find the
  // matching integration tile and open the activation modal on it.
  // Remote-MCP OAuth entries have no modal — a deep link can't open their
  // popup either (no user gesture → popup blocker), so just drop the param
  // and let the user click Connect on the highlighted tile.
  useEffect(() => {
    if (!activateId) { setActivating(null); return; }
    const match = integrations.find(i => i.id === activateId);
    if (!match || !(isAdmin || match.canConnectPersonal)) return;   // a member adds their own only
    if (isRemoteMcpOauth(match)) {
      const next = new URLSearchParams(searchParams);
      next.delete('activate');
      setSearchParams(next, { replace: true });
      return;
    }
    setActivating(match);
  }, [activateId, integrations, isAdmin, searchParams, setSearchParams]);

  // Mutations (activate/remove) call `reload()` to refresh; the shared cache
  // means any open dashboard tab updates in lockstep. Declared before
  // openActivate so the open-server direct-activate can use it (no TDZ).
  const reload = useCallback(() => {
    invalidate('/api/integrations');
    return reloadApi();
  }, [reloadApi]);

  // Lightweight local toasts — immediate feedback for one-click/open activations
  // so the user always knows what happened (the SSE toast stream is for
  // server-pushed events, too heavy for a click confirmation).
  const { toasts, pushToast, pushRestartToast, pushActivationToast, dismissToast } = useIntegrationToasts(botDisplayName);

  // Adding: one-click and open servers ask whose the connection is first
  // (ConnectChoiceModal); a key-based one asks inside its own form.
  const [connectChoice, setConnectChoice] = useState(null);
  const openActivate = useCallback((integration) => {
    if (isRemoteMcpOauth(integration) || isOpenServer(integration)) {
      if (isAdmin && !solo) { setConnectChoice(integration); return; }
      if (solo) {
        startOneClick(integration, { reach: 'workspace', access: 'write' }, reload)
          .then((d) => { if (d !== null) { pushActivationToast(integration, !!d?.restarting); reload(); } })
          .catch((err) => pushToast(`Could not connect: ${err.message}`, 'error', { logo: integration.logo, label: integration.label }));
        return;
      }
      // A member gets their own account only — nothing to ask, go straight there.
      startOneClick(integration, { reach: 'personal', access: 'write' }, reload)
        .then((d) => { if (d !== null) { pushActivationToast(integration, !!d?.restarting); reload(); } })
        .catch((err) => pushToast(`Could not connect: ${err.message}`, 'error', { logo: integration.logo, label: integration.label }));
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.set('activate', integration.id);
    setSearchParams(next);
  }, [searchParams, setSearchParams, isAdmin, solo, reload, pushActivationToast, pushToast]);

  const closeActivate = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('activate');
    setSearchParams(next);
    setActivating(null);
  }, [searchParams, setSearchParams]);

  // The OAuth popup's landing page postMessages us when the flow finishes
  // (oauthResultPage in routes/integrations.js) — flip the tile to Active and
  // toast the result. NO window 'focus' listener: that fired reload() on every
  // tab switch, which is what made the page refresh for no reason.
  useEffect(() => {
    const onMessage = (e) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type !== 'integration-oauth') return;
      const integ = integrations.find(i => i.id === e.data.id);
      const label = integ?.label || 'Integration';
      if (e.data.ok) pushActivationToast(integ || { label, logo: null }, true);
      else pushToast('Could not connect. Try again.', 'error', { logo: integ?.logo, label });
      reload();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [reload, pushToast, pushActivationToast, integrations]);

  // First-ever mount with no cache hit → skeleton. Subsequent tab switches
  // have data immediately and revalidate silently in the background.
  const isInitialLoad = loading && !data;

  // Active is a filter view; Marketplace is the full catalog (active items
  // included, just rendered with their Active pill on the tile). Lets the
  // operator see at-a-glance "how much of Marketing do I have" without
  // having to mentally subtract the Active tab from the catalog.
  const active   = integrations.filter(i => i.active);
  // Two shelves: Team (connected for everyone) and Yours (your own accounts).
  // A service connected both ways is on both, with its own line on each.
  const mine     = integrations.filter(i => i.mine?.active);
  // Solo: everything connected, the workspace's and the owner's own, in one list.
  const connected = integrations.filter(i => i.active || i.mine?.active);
  // Entries with a `home` elsewhere (set up on another page) are
  // set up there; the marketplace lists them only once they are active.
  const catalog  = useMemo(() => integrations.filter(i => !i.home || i.active), [integrations]);
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
    // The URL's tab wins; otherwise the first shelf with something on it.
    if (['marketplace', 'mine', 'team'].includes(searchParams.get('tab'))) return;
    setTab(solo ? (connected.length ? 'team' : 'marketplace') : active.length ? 'team' : mine.length ? 'mine' : 'marketplace');
  }, [data, active.length, mine.length]);

  // Marketplace state — search + category filter for the Available pane.
  const [query, setQuery]       = useState('');
  const [category, setCategory] = useState('all');  // 'all' | 'recommended' | <category-id>
  // Top-level tab — Active vs Marketplace. Default to Marketplace when
  // the operator has no active integrations yet (nothing else to show);
  // otherwise land on Active so they see their current setup first.
  // `?tab=marketplace&category=meetings` opens the Marketplace on a category (Memory → Sources links here).
  // 'team' (connected for everyone) | 'mine' (your own accounts) | 'marketplace'
  const [tab, setTab] = useState(['marketplace', 'mine', 'team'].includes(searchParams.get('tab')) ? searchParams.get('tab') : 'team');

  // Category facets: walk the catalog list, group by `category`, count.
  // Order is fixed so the chip row doesn't reshuffle as users activate/
  // remove things; categories that have no catalog items are dropped.
  const facets = useMemo(() => {
    const counts = new Map();
    for (const i of catalog) {
      const c = i.category || 'other';
      counts.set(c, (counts.get(c) || 0) + 1);
    }
    // Alphabetical by display label; "Other" always last.
    const cats = [...counts.keys()].sort((a, b) => {
      if (a === 'other') return 1;
      if (b === 'other') return -1;
      return (CATEGORY_LABELS[a] || a).localeCompare(CATEGORY_LABELS[b] || b);
    });
    const items = [{ id: 'all', label: 'All', count: catalog.length }];
    for (const c of cats) items.push({ id: c, label: CATEGORY_LABELS[c] || c, count: counts.get(c) });
    return items;
  }, [catalog]);

  // Filter + sort the catalog list. Search hits label + description, case-
  // insensitive. Sort puts comingSoon last; otherwise alpha by label.
  // Search-only filter — the marketplace groups the result into category
  // sections, so there's no category chip to filter by anymore.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog
      .filter(i => {
        if (!q) return true;
        return (
          (i.label || '').toLowerCase().includes(q) ||
          (i.tagline || '').toLowerCase().includes(q) ||
          (i.description || '').toLowerCase().includes(q) ||
          (i.id || '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const cs = Number(!!a.comingSoon) - Number(!!b.comingSoon);
        if (cs !== 0) return cs;
        return (a.label || '').localeCompare(b.label || '');
      });
  }, [catalog, query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader
        icon={Plug}
        title="Integrations"
        sidebarOpen={sidebarOpen}
      />
      {/* The tabs are a row of their own under the header — still, like it, while the grid scrolls. */}
      {data && (active.length > 0 || catalog.length > 0) && (
        <div className="shrink-0 px-6 pb-3 pt-1">
                  <Tabs
                    value={tab}
                    onChange={setTab}
                    items={[
                      ...(solo ? [{ id: 'team', count: connected.length, label: 'Connected' }] : [
                        { id: 'team', count: active.length, label: 'Team' },
                        { id: 'mine', count: mine.length, label: 'Yours' },
                      ]),
                      { id: 'marketplace', count: catalog.length, label: 'Marketplace' },
                    ]}
                  />
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <div className="flex flex-col gap-5 px-6 pb-12 pt-2">
          {isInitialLoad && <SkeletonCardGrid count={6} width={320} banner />}

          {error && !data && (
            <div className="rounded-[6px] border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
              Couldn't load integrations: {error}
            </div>
          )}

          {data && !ready && (
            <div className="flex items-start gap-3 rounded-[6px] border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3.5">
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

              {(solo ? [['team', connected]] : [['team', active], ['mine', mine]]).map(([shelf, items]) => (
                <div key={shelf} className={cn(tab !== shelf && 'hidden')}>
                  {items.length > 0 ? (
                    <div className="grid gap-3 grid-cols-[repeat(auto-fill,320px)] max-sm:grid-cols-1">
                      {items.map((integration) => (
                        <motion.div key={`${shelf}-${integration.id}`} layout transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}>
                          <IntegrationTile
                            integration={integration}
                            shelf={solo ? (integration.active ? 'team' : 'mine') : shelf}
                            solo={solo}
                            ready={ready}
                            canManage={shelf === 'team' ? isAdmin : true}
                            memorySource={shelf === 'mine' || isAdmin ? (memorySources.find((s) => s.id === integration.id) || null) : null}
                            onMemorySource={(on) => setMemorySource(integration.id, on)}
                            onActivate={() => openActivate(integration)}
                            onRemove={() => setRemoving(integration)}
                            onSettings={() => setSettingsFor(integration)}
                          />
                        </motion.div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex min-h-[calc(100dvh-14rem)] flex-col items-center justify-center gap-2 rounded-[6px] border border-border/40 bg-muted/15 px-6 py-12 text-center">
                      <Plug className="size-6 text-muted-foreground/45" strokeWidth={1.5} />
                      <div className="text-[13.5px] font-medium text-foreground/85">{solo ? 'Nothing connected yet' : shelf === 'team' ? 'Nothing connected for the team yet' : 'Nothing of your own yet'}</div>
                      <p className="max-w-sm text-[12.5px] text-muted-foreground/75">
                        {shelf === 'team'
                          ? (isAdmin ? 'Browse the Marketplace and connect the services the whole team should use.' : 'An admin connects services for the team; they show up here.')
                          : 'A notetaker, a calendar or a task board from the Marketplace — used in your conversations only.'}
                      </p>
                      <button type="button" onClick={() => setTab('marketplace')} className="mt-2 inline-flex items-center gap-1.5 rounded-[6px] border border-border/55 bg-background px-3 py-1.5 text-[12.5px] text-foreground/80 transition-colors hover:bg-muted/40">
                        Open the Marketplace
                        <ArrowRight className="size-3.5" strokeWidth={2} />
                      </button>
                    </div>
                  )}
                </div>
              ))}

              <div className={cn(tab !== 'marketplace' && 'hidden')}>
                <Marketplace
                  facets={facets}
                  query={query}
                  onQuery={setQuery}
                  items={filtered}
                  ready={ready}
                  canManage={isAdmin}
                  onActivate={openActivate}
                  onRemove={(i) => setRemoving(i)}
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
          onSuccess={(data) => {
            const integ = activating;
            closeActivate();
            pushActivationToast(integ, !!data?.restarting);
            reload();
          }}
        />
      )}

      {removing && (
        <RemoveDialog
          integration={removing}
          onClose={() => setRemoving(null)}
          onSuccess={(data) => {
            const integ = removing;
            setRemoving(null);
            pushActivationToast(integ, !!data?.restarting, 'remove');
            reload();
          }}
        />
      )}

      {settingsFor && (
        <SettingsModal
          integration={settingsFor}
          onClose={() => setSettingsFor(null)}
          onSuccess={() => { setSettingsFor(null); reload(); }}
        />
      )}

      {/* Dev-only toast simulator — top so it never covers the marketplace.
          Stripped from production builds via import.meta.env.DEV. */}
      {import.meta.env.DEV && (
        <div className="fixed left-3 top-3 z-[80] flex max-w-[calc(100vw-1.5rem)] flex-wrap items-center gap-1.5 rounded-[6px] border border-border/60 bg-card/95 px-2 py-1.5 shadow-lg backdrop-blur">
          <span className="px-1 text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground/55">Toast preview · dev</span>
          {[
            ['install bar', () => pushActivationToast({ logo: '/integrations/notion.svg', label: 'Notion' }, true, 'install')],
            ['remove bar', () => pushActivationToast({ logo: '/integrations/notion.svg', label: 'Notion' }, true, 'remove')],
            ['✓ ok', () => pushToast('Notion connected', 'ok', { logo: '/integrations/notion.svg', label: 'Notion' })],
            ['⟳ restart', () => pushRestartToast()],
            ['✕ error', () => pushToast('Could not connect. Try again.', 'error', { logo: '/integrations/notion.svg', label: 'Notion' })],
            // The service page's own messages: a test, a saved setting, the team's access, a person's connection.
            ['test ok', () => pushToast('Test passed: the provider accepted the sign-in.', 'ok', { logo: '/integrations/notion.svg', label: 'Notion' })],
            ['test fail', () => pushToast('Test failed: the sign-in has expired. Reconnect.', 'error', { logo: '/integrations/notion.svg', label: 'Notion' })],
            ['saved', () => pushToast('Changes saved', 'ok', { logo: '/integrations/github.svg', label: 'GitHub' })],
            ['read-only', () => pushToast('Read-only for the team', 'ok', { logo: '/integrations/notion.svg', label: 'Notion' })],
            ['write on', () => pushToast('Read and write for the team', 'ok', { logo: '/integrations/notion.svg', label: 'Notion' })],
            ['person off', () => pushToast("Ann's own Notion disconnected", 'neutral', { logo: '/integrations/notion.svg', label: 'Notion' })],
          ].map(([label, fn]) => (
            <button
              key={label}
              type="button"
              onClick={fn}
              className="rounded-[6px] border border-border/60 bg-background px-2 py-1 text-[11px] font-medium text-foreground/75 transition-colors hover:border-foreground/30 hover:bg-muted/40"
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Island dock — the single home for EVERY integration message. Docked
          bottom-centre, slides up. Activation rows carry a logo + install/remove
          check on the left and the bot-restart status + progress line on the
          right; error/ok/progress rows share the same shell with a status icon
          and message. Nothing renders in a corner — one consistent surface. */}
      {connectChoice && (
        <ConnectChoiceModal integration={connectChoice} isAdmin={isAdmin} onClose={() => setConnectChoice(null)}
          onPopupClosed={reload}
          onSuccess={(d) => { setConnectChoice(null); pushActivationToast(connectChoice, !!d?.restarting); reload(); }} />
      )}
      <IntegrationToasts toasts={toasts} botDisplayName={botDisplayName} dismissToast={dismissToast} />
    </div>
  );
}

// ─── Tabs ─────────────────────────────────────────────────────────────────

/**
 * Pill-style top-level tabs (Active | Marketplace). Selected tab uses
 * --foreground fill so it matches the rest of the workspace's neutral
 * palette — no brand-accent stripe. Counts in muted pills next to label.
 */
export function Tabs({ value, onChange, items }) {
  return (
    <div role="tablist" className="inline-flex items-center gap-1 self-start rounded-[6px] border border-border/55 bg-muted/40 p-1">
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
              'inline-flex items-center gap-2 rounded-[6px] px-3.5 py-1.5 text-[13px] font-medium transition-colors',
              isActive
                ? 'bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.05)]'
                : 'text-muted-foreground/80 hover:text-foreground/90',
            )}
          >
            <span>{it.label}</span>
            {it.count != null && (
              <span className={cn(
                'rounded-full px-1.5 text-[10.5px] font-medium tabular-nums',
                isActive ? 'bg-muted/55 text-muted-foreground' : 'bg-background/70 text-muted-foreground/75',
              )}>
                {it.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── Search field (shared with the Routines Marketplace) ──────────────────

/** The marketplace search box: icon, text, a clear button. Focus uses the
 *  foreground ring like the rest of the workspace inputs. */
export function SearchField({ value, onChange, placeholder, label }) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/55" strokeWidth={1.75} />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="w-full rounded-[6px] border border-border/60 bg-background py-2.5 pl-9 pr-9 text-[13.5px] text-foreground outline-none transition-colors focus:border-foreground/40 focus:ring-2 focus:ring-foreground/10"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          title="Clear search"
          aria-label="Clear search"
          className="absolute right-2.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-[6px] text-muted-foreground/55 transition-colors hover:bg-muted/40 hover:text-foreground/80"
        >
          <X className="size-3.5" strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}

// ─── Marketplace (Available section: search + category chips + grid) ─────

function Marketplace({
  facets, query, onQuery,
  items, ready, canManage, onActivate, onRemove,
}) {
  // `?category=<id>` (Memory → Sources' "Connect") scrolls to that section once the list is in.
  const [params] = useSearchParams();
  const wanted = params.get('category');
  useEffect(() => {
    if (!wanted || !items.length) return;
    const el = document.getElementById(`category-${wanted}`);
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [wanted, items.length]);
  // One grid with the Active tab's 306 px columns: the search field and the
  // category headers span it, so both tabs share the same right edge.
  return (
    <div className="grid gap-x-3 gap-y-2.5 grid-cols-[repeat(auto-fill,320px)] max-sm:grid-cols-1">
      <div className="col-span-full mb-1.5">
        <SearchField value={query} onChange={onQuery} placeholder="Search integrations…" label="Search integrations" />
      </div>

      {/* Grouped into category sections (header + 2-col grid), ordered by the
          facet order. Replaces the top filter chips — you scroll by category. */}
      {items.length > 0 ? (
        facets.filter(f => f.id !== 'all').map((f, idx) => {
          const group = items.filter(i => (i.category || 'other') === f.id);
          if (!group.length) return null;
          return [
            // Each category: its name, then a low, light banner under it — the
            // halftone of an active tile, drawn from the category's own icons.
            <div key={`h-${f.id}`} id={`category-${f.id}`} className={cn('col-span-full relative flex h-16 items-center gap-2 overflow-hidden rounded-[6px] border border-border/50 px-4 scroll-mt-4', idx > 0 && 'mt-3.5')}>
              <TileBanner icon={(CATEGORY_ICONS[f.id] || CATEGORY_ICONS.other)[0]} seed={`category-${f.id}`} scale={1.8} soft className="!absolute inset-0 h-full" />
              <span className="relative text-[11px] font-semibold uppercase tracking-wider text-foreground/80">{f.label}</span>
              <span className="relative text-[10.5px] tabular-nums text-muted-foreground/60">{group.length}</span>
            </div>,
            ...group.map((integration) => (
              <motion.div key={integration.id} layout transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}>
                <CompactTile
                  integration={integration}
                  ready={ready}
                  canManage={canManage}
                  onActivate={() => onActivate(integration)}
                  onRemove={() => onRemove(integration)}
                />
              </motion.div>
            )),
          ];
        })
      ) : (
        <div className="col-span-full flex flex-col items-center gap-2 rounded-[6px] border border-border/40 bg-muted/15 px-6 py-10 text-center">
          <Search className="size-6 text-muted-foreground/45" strokeWidth={1.5} />
          <div className="text-[13.5px] font-medium text-foreground/85">
            {query.trim() ? <>No integrations match "{query.trim()}"</> : 'Nothing in the marketplace yet'}
          </div>
          {query.trim() && (
            <button
              type="button"
              onClick={() => onQuery('')}
              className="mt-1 inline-flex items-center gap-1 rounded-[6px] border border-border/55 bg-background px-3 py-1.5 text-[12.5px] text-foreground/80 transition-colors hover:bg-muted/40"
            >
              Clear search
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Tile ──────────────────────────────────────────────────────────────────

// Compact horizontal row for the Marketplace grid — logo + name (+ inline
// Beta/Active/Soon tag) + one-line description + a round action button. Denser
// than the card so far more fits at once.
function CompactTile({ integration, ready, canManage: canManageProp = true, onActivate, onRemove }) {
  // A member may add a personal-capable service for themselves.
  const canManage = canManageProp || (!!integration.canConnectPersonal && !integration.mine?.active);
  const isActive     = integration.active;
  const isComingSoon = !!integration.comingSoon;
  const cantActivate = !ready && !isActive && !isComingSoon;
  const desc         = integration.tagline || integration.description;
  // Same quiet button as the tiles' footers, shrunk to fit a row.
  const btn = 'inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-[6px] px-2.5 text-[12px] font-medium transition-colors';
  const idle = 'inline-flex size-7 shrink-0 items-center justify-center text-muted-foreground/40';

  return (
    <div className={cn(
      'group flex items-center gap-3 rounded-[6px] border bg-card px-3.5 py-2.5 transition-colors',
      (isComingSoon || cantActivate) ? 'border-border/40' : 'border-border/50 hover:border-border',
    )}>
      <Logo src={integration.logo} alt={integration.label} fill={!!integration.logoFill} dim={isComingSoon || cantActivate} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13.5px] font-semibold text-foreground/90">{integration.label}</span>
          {integration.experimental && <ExperimentalTag />}
          {isComingSoon && <StatusTag tone="soon" className="shrink-0">Soon</StatusTag>}
        </div>
        <div className="truncate text-[12px] leading-snug text-muted-foreground/80">
          {isComingSoon ? (integration.comingSoonReason || desc) : desc}
        </div>
      </div>

      {!canManage   ? <span className={idle} title="Connected by an admin for the team" />
       : isComingSoon ? <span className={idle}><Clock className="size-3.5" strokeWidth={1.75} /></span>
       : cantActivate ? <span className={idle} title="Encryption not configured"><Lock className="size-3.5" strokeWidth={1.75} /></span>
       : isActive     ? (
          // "Added" at rest; on hover the same button offers to remove it.
          <button type="button" onClick={onRemove} aria-label={`Remove ${integration.label}`}
            className={cn(btn, 'group/act text-emerald-700 hover:bg-destructive/[0.08] hover:text-destructive dark:text-emerald-400')}>
            <CheckIcon className="size-3.5 group-hover/act:hidden" strokeWidth={2.25} />
            <span className="group-hover/act:hidden">Added</span>
            <span className="hidden group-hover/act:inline">Remove</span>
          </button>
        ) : (
          <button type="button" onClick={onActivate}
            className={cn(btn, 'bg-muted/40 text-muted-foreground/80 hover:bg-muted/55 hover:text-foreground/90')}>
            Add
          </button>
        )}
    </div>
  );
}

/**
 * Who has a service, at the name's height: the organisation's mark when it is
 * connected for the whole workspace, and the faces of the people who
 * connected their own account — the viewer first. Hovering any of it opens a
 * small card that says exactly that: for whom, connected by whom. Nothing
 * when nobody has it. Both marks at once is normal: a workspace connection
 * and someone's own of the same service live side by side.
 */
/** The organisation's square mark, as the sidebar draws it. */
export function OrgMark({ orgIcon, className }) {
  return (
    <span className={cn('flex shrink-0 items-center justify-center overflow-hidden rounded-[2px] border border-border/60 bg-background', className)}>
      {orgIcon ? <BrandedImage src={orgIcon} alt="" className="size-full object-contain" /> : <Users className="size-3 text-muted-foreground/75" strokeWidth={2} />}
    </span>
  );
}

export function WhoHasIt({ integration, me }) {
  const branding = useBranding();
  const people = [...(integration.activeFor || [])];
  if (integration.mine?.active && me && !people.some(p => p.slug === me.slug)) people.unshift({ slug: me.slug, name: me.displayName || 'You', avatarUrl: me.avatarUrl || null, you: true });
  const ws = integration.active ? integration.connectedBy : null;
  if (!ws && !people.length) return null;
  const orgIcon = branding.iconUrl || branding.logoUrl;
  const title = [ws ? `Whole team · ${integration.access === 'read' ? 'read-only' : 'read & write'}` : null, ...people.map(p => `${p.you ? 'You' : p.name} · own`)].filter(Boolean).join('\n');
  return (
    <div className="flex shrink-0 items-center" title={title} aria-label={title}>
      {ws && <OrgMark orgIcon={orgIcon} className="mr-1.5 size-5" />}
      {people.length > 0 && (
        <span className="flex items-center -space-x-1.5">
          {people.slice(0, 3).map((p) => <Avatar key={p.slug} name={p.name} avatarUrl={p.avatarUrl} className="size-5 text-[9px] ring-2 ring-card" />)}
          {people.length > 3 && <span className="flex size-5 items-center justify-center rounded-full bg-muted/60 text-[9px] font-medium text-muted-foreground/80 ring-2 ring-card">+{people.length - 3}</span>}
        </span>
      )}
    </div>
  );
}

function IntegrationTile({ integration, shelf = 'team', solo = false, ready, canManage = true, showStatus = true, memorySource = null, onMemorySource = null, onActivate, onRemove, onSettings }) {
  const navigate = useNavigate();
  const { me } = useMe();
  const branding = useBranding();
  const isActive     = shelf === 'mine' ? !!integration.mine?.active : integration.active;
  // A member's team tile has nothing to do: no footer at all (unless the
  // service feeds their memory, whose switch is theirs).
  const quiet        = !canManage && shelf === 'team' && isActive && !memorySource;
  const page         = `/integrations/${encodeURIComponent(integration.id)}?tab=${shelf === 'mine' ? 'me' : 'team'}`;
  const isComingSoon = !!integration.comingSoon;
  const cantActivate = !ready && !isActive && !isComingSoon;
  const hasSettings  = isActive && (integration.fields || []).some(f => f.globalForMulti);

  return (
    <div className={cn(
      'group relative flex flex-col overflow-hidden rounded-[6px] border bg-card transition-all duration-150',
      isActive       ? 'border-border/60 hover:border-foreground/15 hover:shadow-[0_2px_6px_rgba(0,0,0,0.035)]' :
      isComingSoon   ? 'border-border/40' :
      cantActivate   ? 'border-border/40' :
                       'border-border/60 hover:border-foreground/15 hover:shadow-[0_2px_6px_rgba(0,0,0,0.035)]',
    )}>
      {/* Header — logo + status pills. An active integration gets the same
          technical banner as the AI Settings tiles (a halftone of its own
          logo), with the real logo in its box on top of it. */}
      <div className={cn(
        'relative flex items-start justify-between gap-3 px-4',
        isActive ? 'h-24 items-center pt-0 pb-0' : 'pt-4 pb-3',
      )}>
        {isActive && (
          <TileBanner image={logoUrl(integration.logo)} seed={integration.id} soft className="!absolute inset-0 h-full" />
        )}
        <div className="relative">
          <Logo src={integration.logo} alt={integration.label} fill={!!integration.logoFill} dim={isComingSoon || cantActivate} />
        </div>
        <div className={cn('relative flex items-center gap-1.5', isActive && 'self-start pt-3')}>
          {integration.experimental && <ExperimentalTag />}
          {isActive && (
            <StatusTag tone="active">Active</StatusTag>
          )}
          {/* Beside Active, for whom: the organisation's mark and "for team", or your avatar and "for you". */}
          {isActive && !solo && (
            <StatusTag tone="plain" className="text-foreground/80">
              {shelf === 'mine'
                ? <Avatar name={me?.displayName || me?.email} email={me?.email} avatarUrl={me?.avatarUrl} className="!size-[11px] text-[7px]" />
                : <OrgMark orgIcon={branding.iconUrl || branding.logoUrl} className="size-[11px] rounded-[2px]" />}
              {shelf === 'mine' ? 'Yours' : 'Team'}
            </StatusTag>
          )}
          {isComingSoon && (
            <StatusTag tone="soon">Soon</StatusTag>
          )}
        </div>
      </div>

      {isActive && <div className="h-3.5" />}
      {/* Body */}
      <div className={cn('flex flex-1 flex-col px-4', quiet && 'pb-4')}>
        <div className="min-w-0 truncate text-[14.5px] font-semibold text-foreground/90">{integration.label}</div>
        <div className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground/80">
          {isComingSoon ? (integration.comingSoonReason || integration.description) : integration.description}
        </div>

        {isActive && showStatus && canManage && (
          <div className="mt-3 flex items-center gap-2 rounded-[6px] bg-muted/40 px-2.5 py-1.5">
            {shelf === 'mine' ? (
              integration.multi
                ? <span className="text-[11.5px] text-foreground/75">{(integration.mine?.itemCount ?? 0)} {(integration.itemLabel || 'item').toLowerCase()}{(integration.mine?.itemCount ?? 0) === 1 ? '' : 's'}</span>
                : <span className="font-mono text-[11.5px] text-foreground/70">{'••••'}{integration.mine?.summary?.last4 || ''}</span>
            ) : integration.multi ? (
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
              {(shelf === 'mine' ? integration.mine?.activatedAt : integration.activatedAt) ? `activated ${formatRelative(new Date(shelf === 'mine' ? integration.mine.activatedAt : integration.activatedAt))}` : 'stored'}
            </span>
          </div>
        )}
      </div>

      {/* Footer — action (read-only for non-admins) */}
      {!quiet && <div className="px-4 pb-4 pt-3.5">
        {!canManage ? (
          <div className="flex items-center gap-2">
          {shelf === 'team' && isActive ? (
            null
          ) : integration.canConnectPersonal && !isComingSoon ? (
            <button
              type="button"
              onClick={() => (integration.mine?.active ? navigate(`/integrations/${encodeURIComponent(integration.id)}?tab=me`) : onActivate?.())}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-[6px] bg-muted/40 px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/75 transition-colors hover:bg-muted/55 hover:text-foreground/90"
            >
              {integration.mine?.active ? 'Manage' : 'Connect for me'}
              <ArrowRight className="size-3.5" strokeWidth={2} />
            </button>
          ) : (
          <button
            type="button" disabled
            className="inline-flex w-full cursor-default items-center justify-center gap-1.5 rounded-[6px] border border-border/40 bg-muted/20 px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/55"
          >
            {isComingSoon ? 'Coming soon' : 'Team only'}
          </button>
          )}
          {isActive && memorySource && (
            <div className="flex h-8 shrink-0 items-center gap-2 rounded-[6px] bg-muted/40 px-2.5" title={memorySource.on ? 'Feeds memory nightly' : 'Not feeding memory'}>
              <Brain className={cn('size-3.5', memorySource.on ? 'text-foreground/80' : 'text-muted-foreground/50')} strokeWidth={1.75} />
              <Toggle small on={memorySource.on} label={`Feed memory from ${integration.label}`} onClick={() => onMemorySource?.(!memorySource.on)} />
            </div>
          )}
          </div>
        ) : isActive && integration.home === 'browser-agent' ? (
          // Set up and managed where it is used (the Browser agent page).
          <button
            type="button"
            onClick={() => navigate('/browser-agent')}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-[6px] bg-muted/40 px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/75 transition-colors hover:bg-muted/55 hover:text-foreground/90"
          >
            Manage on Browser agent
            <ArrowRight className="size-3.5" strokeWidth={2} />
          </button>
        ) : isActive ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate(page)}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[6px] bg-muted/40 px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/75 transition-colors hover:bg-muted/55 hover:text-foreground/90"
            >
              Manage
              <ArrowRight className="size-3.5" strokeWidth={2} />
            </button>
            {/* A source of memory (a meeting notetaker): the same switch as on
                Memory → Sources — each person's own, so not admin-gated. */}
            {memorySource && (
              <div className="flex h-8 shrink-0 items-center gap-2 rounded-[6px] bg-muted/40 px-2.5" title={memorySource.on ? 'Feeds memory nightly' : 'Not feeding memory'}>
                <Brain className={cn('size-3.5', memorySource.on ? 'text-foreground/80' : 'text-muted-foreground/50')} strokeWidth={1.75} />
                <Toggle small on={memorySource.on} label={`Feed memory from ${integration.label}`} onClick={() => onMemorySource?.(!memorySource.on)} />
              </div>
            )}
          </div>
        ) : isComingSoon ? (
          <button
            type="button"
            disabled
            className="inline-flex w-full cursor-not-allowed items-center justify-center gap-1.5 rounded-[6px] border border-border/40 bg-muted/30 px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/55"
          >
            Coming soon
          </button>
        ) : cantActivate ? (
          <button
            type="button"
            disabled
            className="inline-flex w-full cursor-not-allowed items-center justify-center gap-1.5 rounded-[6px] border border-border/40 bg-muted/30 px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/55"
          >
            <Lock className="size-3.5" strokeWidth={1.75} />
            Encryption not configured
          </button>
        ) : (
          <button
            type="button"
            onClick={onActivate}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-[6px] bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition-all hover:opacity-95 active:scale-[0.98]"
          >
            {isOneClick(integration) ? 'One-click connect' : 'Connect'}
            <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" strokeWidth={2} />
          </button>
        )}
      </div>}
    </div>
  );
}

/** A quiet on/off switch (the Team page's), small for a row inside a card. */
export function Toggle({ on, busy = false, small = false, label, onClick }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label} disabled={busy} onClick={onClick}
      className={cn('relative inline-flex shrink-0 items-center rounded-full transition-colors disabled:opacity-50', small ? 'h-5 w-9' : 'h-6 w-11', on ? 'bg-foreground' : 'bg-muted-foreground/30')}
    >
      <span className={cn('inline-block transform rounded-full bg-background shadow-sm transition-transform', small ? 'size-4' : 'size-5', on ? (small ? 'translate-x-[18px]' : 'translate-x-[22px]') : 'translate-x-0.5')} />
    </button>
  );
}

// Catalog returns paths like "/integrations/grok.svg". The frontend is served
// from import.meta.env.BASE_URL ("/app/" in this app), so absolute paths from
// the catalog need to be re-rooted to that base, otherwise we 404.
export function logoUrl(src) {
  if (!src) return null;
  if (/^https?:/.test(src)) return src;
  const base = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
  return `${base}${src.startsWith('/') ? src : '/' + src}`;
}

// `fill`: the logo is a full square app icon with its own background (the
// catalog's `logoFill`) — it covers the tile instead of sitting on white.
export function Logo({ src, alt, dim, fill = false, size = 'size-12', imgSize = 'size-7' }) {
  const [errored, setErrored] = useState(false);
  const url = logoUrl(src);
  // Logo tile is always a solid-white square in both themes. The brand
  // SVGs (Trello, Shopify, Grok, X, generic envelope, etc.) are designed
  // assuming a white backdrop, so we keep that fixed instead of fading
  // the tile in dark mode — full contrast on every glyph.
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-[6px] bg-white shadow-[inset_0_0_0_1px_rgba(0,0,0,0.05)] ring-1 ring-black/[0.04]',
        size,
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
          className={cn(fill ? 'size-full object-cover' : cn('object-contain', imgSize))}
        />
      )}
    </div>
  );
}

// ─── Field input (shared by single + multi forms) ──────────────────────────

/** A small (i) beside a label; the text shows on hover. */
export function InfoTip({ text, className }) {
  if (!text) return null;
  return (
    <span className={cn('group relative inline-flex items-center', className)}>
      <Info className="size-3.5 text-muted-foreground/55 transition-colors group-hover:text-foreground/80" strokeWidth={2} aria-label={text} />
      <span role="tooltip" className="pointer-events-none absolute left-0 top-full z-30 mt-1.5 hidden w-max max-w-[340px] rounded bg-popover px-3 py-2 text-[12px] font-normal leading-snug text-popover-foreground/90 shadow-md ring-1 ring-foreground/10 group-hover:block">{text}</span>
    </span>
  );
}

/** A field's name, with its hint as an info tip beside it rather than a line under the input. */
function FieldLabel({ inputId, field }) {
  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={inputId} className="text-[13px] font-medium text-foreground/85">{field.label}</label>
      <InfoTip text={field.helper} />
    </div>
  );
}

export function FieldInput({ field, value, onChange, disabled, inputId }) {
  const common = {
    id: inputId,
    autoComplete: 'off',
    spellCheck: false,
    placeholder: field.placeholder || '',
    value: value || '',
    onChange: (e) => onChange(e.target.value),
    // A stored secret shows masked (••••abcd): focusing it selects the whole of it,
    // so typing or pasting replaces it instead of landing next to the dots.
    onFocus: (e) => { if (String(e.target.value || '').includes('\u2022')) e.target.select?.(); },
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
      <FieldLabel inputId={inputId} field={field} />
      {field.type === 'json' ? (
        <textarea
          {...common}
          rows={8}
          className="resize-y rounded border border-border/60 bg-background px-3.5 py-2.5 font-mono text-[12px] leading-relaxed text-foreground outline-none transition-all focus:border-foreground/60 focus:ring-2 focus:ring-foreground/10 disabled:opacity-60"
        />
      ) : field.type === 'select' ? (
        <Pick id={inputId} value={value || field.default || ''} options={(field.options || []).map(opt => ({ value: opt.value, label: opt.label }))} onChange={onChange} disabled={disabled} />
      ) : (
        <input
          {...common}
          type={field.type === 'secret' ? 'password' : 'text'}
          className={inputCls}
        />
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
      return 'Unrecognised shape: expected {cookies, origins} object or a cookies array.';
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
      <FieldLabel inputId={inputId} field={field} />
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
        <div className="flex items-start gap-2 rounded-[6px] border border-destructive/30 bg-destructive/[0.05] px-3 py-2 text-[12px] text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
          <span>{parsed}</span>
        </div>
      )}
      {isOk && (
        <div className="flex items-start gap-2 rounded-[6px] border border-emerald-500/30 bg-emerald-500/[0.05] px-3 py-2 text-[12px] text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
          <span>
            Parsed: {parsed.cookies} cookie{parsed.cookies === 1 ? '' : 's'}, {parsed.origins} origin{parsed.origins === 1 ? '' : 's'}. Backend will filter to the allowed-domain set before saving.
          </span>
        </div>
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
      <FieldLabel inputId={inputId} field={field} />
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
          <span className="text-[12px] font-medium text-amber-600/90 dark:text-amber-400/90">⚠ Session expired: click Reconnect</span>
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

      {open && vncUrl && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center modal-backdrop p-4">
          <div className="flex h-[88vh] w-[92vw] max-w-[1400px] flex-col overflow-hidden modal-panel">
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border/40 px-4 py-3">
              <div>
                <div className="text-[13px] font-medium text-foreground/85">Sign in to Google</div>
                <div className="mt-0.5 text-[11.5px] text-muted-foreground/70">
                  Use the account the bot should comment as; 2FA and security keys work. Once the page shows you're signed in, click <b>Done</b>. The session is saved on the server; nothing leaves it.
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
                  Done, I'm signed in
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

/**
 * Who a new connection is for — asked in the add flow. An admin picks the
 * whole team (then read-only or read and write) or just themselves; a member
 * gets their own only, so sees the line but no choice. Workspace-only
 * services (catalog without `personal`) offer the team alone.
 */
/** One of our dropdowns in the form's input style: an icon + label trigger, options with icons. */
export function Pick({ id, value, options, onChange, disabled }) {
  const current = options.find(o => o.value === value) || options[0];
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button id={id} type="button" disabled={disabled} className="flex min-w-0 flex-1 items-center gap-2.5 rounded border border-border/60 bg-background px-3.5 py-2.5 text-left text-[13px] text-foreground outline-none transition-all focus-visible:border-foreground/60 focus-visible:ring-2 focus-visible:ring-foreground/10 data-[state=open]:border-foreground/60 disabled:opacity-60">
          {current.icon}
          <span className="min-w-0 flex-1 truncate">{current.label}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground/70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="rounded p-1">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map(o => (
            <DropdownMenuRadioItem key={o.value} value={o.value} disabled={o.disabled} title={o.title} className="rounded-[3px] text-[13px]">
              {o.icon}
              <span>{o.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ReachChoice({ integration, isAdmin, reach, access, onReach, onAccess, disabled }) {
  const { me: viewer } = useMe();
  // Solo: one person, nothing to choose. A channel (Telegram) is always the
  // whole team's, reading and sending: nothing to choose either.
  if (viewer?.teamMode === false || integration?.teamWide) return null;
  const { iconUrl, logoUrl } = useBranding();
  const { me } = useMe();
  const canPersonal = !!integration.personal;
  const meMark = <Avatar name={me?.displayName || me?.email} email={me?.email} avatarUrl={me?.avatarUrl} className="!size-4 text-[8px]" />;
  const whom = [
    ...(isAdmin ? [{ value: 'workspace', label: 'The whole team', icon: <OrgMark orgIcon={iconUrl || logoUrl} className="size-4" /> }] : []),
    { value: 'personal', label: isAdmin ? 'Just me' : 'Just you', icon: meMark, disabled: isAdmin && !canPersonal, title: isAdmin && !canPersonal ? 'Not available for this service' : undefined },
  ];
  const rights = [
    { value: 'read', label: 'Read only', icon: <Eye className="size-4 text-muted-foreground/80" strokeWidth={1.9} /> },
    { value: 'write', label: 'Read and write', icon: <PenLine className="size-4 text-muted-foreground/80" strokeWidth={1.9} /> },
  ];
  // After the credentials: an ACCESS row — for whom, and (for the team) what the bot may do.
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">Access</div>
      <div className="flex items-center gap-3">
        <Pick id="reach" value={isAdmin ? reach : 'personal'} options={whom} onChange={onReach} disabled={disabled || !isAdmin} />
        {isAdmin && reach === 'workspace' && <Pick id="access" value={access} options={rights} onChange={onAccess} disabled={disabled} />}
      </div>
    </div>
  );
}

/** The query a new connection's request carries: whose it is and, for the team, the access. */
export const reachQuery = (reach, access) => (reach === 'personal' ? '?reach=personal' : `?access=${access}`);

/**
 * The one-click add flow: the same choice, then the provider's sign-in (or a
 * plain Connect for an open server). The sign-in opens from the click itself,
 * or popup blockers eat it.
 */
/**
 * Start a one-click connection: the provider's sign-in (popup, or the page
 * itself when popups are blocked) — resolves null — or, for an open server,
 * the activation itself — resolves the server's answer. Throws on failure.
 */
export async function startOneClick(integration, { reach, access }, onPopupClosed) {
  if (isRemoteMcpOauth(integration)) {
    const ok = openOAuthPopup(integration, onPopupClosed, { reach, access });
    if (!ok) window.location.assign(`/api/integrations/${encodeURIComponent(integration.id)}/oauth/start${reachQuery(reach, access)}`);
    return null;
  }
  const resp = await fetch(`/api/integrations/${encodeURIComponent(integration.id)}${reachQuery(reach, access)}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: {} }) });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

export function ConnectChoiceModal({ integration, isAdmin, onClose, onSuccess, onPopupClosed }) {
  const [reach, setReach] = useState(isAdmin ? 'workspace' : 'personal');
  const [access, setAccess] = useState(integration.teamWide ? 'write' : 'read');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const oauth = isRemoteMcpOauth(integration);
  const go = async () => {
    setError(null);
    setBusy(true);
    try {
      const data = await startOneClick(integration, { reach, access }, onPopupClosed);
      if (data === null) { onClose(); return; }
      onSuccess(data, reach);
    } catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <ModalShell onClose={onClose} ariaLabel={`Connect ${integration.label}`}>
      <div className="w-full max-w-xl overflow-hidden modal-panel">
        <div className="flex items-center gap-3 border-b border-border/50 px-6 py-4">
          <Logo src={integration.logo} alt={integration.label} fill={!!integration.logoFill} size="size-9" imgSize="size-5" />
          <div className="text-[15px] font-semibold text-foreground">Connect {integration.label}</div>
        </div>
        <div className="flex flex-col gap-5 px-6 py-5">
          <ReachChoice integration={integration} isAdmin={isAdmin} reach={reach} access={access} onReach={setReach} onAccess={setAccess} disabled={busy} />
          {error && <div className="rounded-[6px] border border-destructive/25 bg-destructive/[0.05] px-3 py-2 text-[12px] text-destructive">{error}</div>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border/50 px-6 py-3">
          <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-[6px] px-3.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground/85 disabled:opacity-50">Cancel</button>
          <button type="button" onClick={go} disabled={busy} className="inline-flex items-center gap-1.5 rounded-[6px] bg-foreground px-3.5 py-1.5 text-[13px] font-medium text-background transition-all hover:opacity-95 disabled:opacity-50">
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {oauth ? `Sign in to ${integration.label}` : 'Connect'}
          </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

export function ActivateModal({ integration, onClose, onSuccess }) {
  const { me } = useMe();
  const isAdmin = !!me?.isAdmin;
  // Solo is a team of one: no Team / Yours split, no access to choose.
  const solo = me?.teamMode === false;
  const [reach, setReach] = useState(isAdmin ? 'workspace' : 'personal');
  const [access, setAccess] = useState(integration.teamWide ? 'write' : 'read');
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
      const resp = await fetch(`/api/integrations/${encodeURIComponent(integration.id)}${reachQuery(reach, solo ? 'write' : access)}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      // Close immediately; the dashboard shows "connected" + the restart
      // progress toast (unified with one-click/open flows).
      onSuccess(data);
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

  // The escape hatch when the steps aren't enough — drops a help prompt into
  // the chat composer (NOT auto-sent). The prompt tells the bot NOT to ask for
  // keys in chat — those belong only in the form.
  const askForHelp = () => {
    const stepsBlock = (integration.steps || []).map((s, i) => {
      const title = interpolate(s.title, stepVars);
      const body  = interpolate(s.body,  stepVars);
      return `## ${i + 1}. ${title}\n\n${body}`;
    }).join('\n\n');
    const prompt =
`I'm activating the **${integration.label}** integration. Walk me through it step by step. These are the instructions from the activation form:

${stepsBlock}

Please guide me through these one at a time. Ask whatever you need about my account / company / setup to help me move forward.

Important: do NOT ask me to paste any keys, tokens, or passwords into chat. I'll put those directly into the form in the workspace. You only help me find them and understand what each field means.`;
    window.dispatchEvent(new CustomEvent('ide:chat-prefill', { detail: { text: prompt } }));
    onClose();
  };

  return (
    <ModalShell onClose={onClose} ariaLabel={`Activate ${integration.label}`}>
      <form onSubmit={submit} className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden modal-panel">
        {/* Header — logo + title only, no description */}
        <div className="flex items-center gap-3.5 border-b border-border/50 px-8 py-5">
          <Logo src={integration.logo} alt={integration.label} fill={!!integration.logoFill} size="size-10" imgSize="size-6" />
          <div className="min-w-0 flex-1 text-[17px] font-semibold text-foreground">
            Connect {integration.label}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] p-1.5 text-muted-foreground/65 transition-colors hover:bg-muted/30 hover:text-foreground/85"
            aria-label="Close"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </div>

        {/* Body — two columns: the how-to on the left, the form on the right (each scrolls on its own). */}
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
                    <li key={i} className={cn('flex gap-3 py-3.5', !isLast && 'border-b border-border/50', i === 0 && 'pt-0')}>
                      {/* A quiet step number — the title carries the step, not a black badge. */}
                      <div className="w-5 shrink-0 pt-px text-[13px] tabular-nums text-muted-foreground/45">
                        {i + 1}.
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13.5px] font-medium text-foreground/85">{interpolate(step.title, stepVars)}</div>
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
                                  className="inline-flex items-center gap-1.5 rounded-[6px] border border-border/70 bg-background px-3 py-1.5 text-[12px] font-medium text-foreground/85 transition-all hover:border-foreground/30 hover:bg-muted/30 hover:text-foreground active:scale-[0.99]"
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

            <div className="pt-3">
              <ReachChoice integration={integration} isAdmin={isAdmin} reach={reach} access={access} onReach={setReach} onAccess={setAccess} disabled={busy} />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-3 border-t border-border/50 bg-background px-8 py-4">
          {phase === 'restarting' && <RestartingBanner />}
          {phase === 'done' && !restartFailed && <DoneBanner />}
          {restartFailed && <RestartFailedBanner />}
          <div className="flex items-center justify-between gap-3">
            <div>
              {integration.steps?.length > 0 && (
                <button type="button" onClick={askForHelp} title="Drops a help prompt in the chat. Keys still go in the form, never in chat." className="inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground/85">
                  <HelpCircle className="size-3.5" strokeWidth={1.75} />
                  Ask {branding.botDisplayName} for help
                </button>
              )}
            </div>
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
                      : 'Connect'}
              </button>
            )}
            </div>
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
export function SettingsModal({ integration, onClose, onSuccess }) {
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
      <form onSubmit={save} className="flex w-full max-w-lg flex-col overflow-hidden modal-panel">
        <div className="flex items-center gap-3.5 border-b border-border/50 px-7 py-5">
          <Logo src={integration.logo} alt={integration.label} fill={!!integration.logoFill} />
          <div className="min-w-0 flex-1 text-[16px] font-semibold text-foreground">
            {integration.label} · Settings
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] p-1.5 text-muted-foreground/65 transition-colors hover:bg-muted/30 hover:text-foreground/85"
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
    <div className="flex flex-col gap-3 rounded-[6px] border border-border/50 bg-muted/15 px-4 py-3.5">
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
export function RemoveDialog({ integration, onClose, onSuccess, title, body, confirmLabel, busyLabel, query = '' }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const remove = async () => {
    setError(null);
    setBusy(true);
    try {
      // `query`: a person's own connection (`?reach=personal`), else the workspace's.
      const resp = await fetch(`/api/integrations/${encodeURIComponent(integration.id)}${query}`, { method: 'DELETE' });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      // Close immediately; the dashboard toasts the result + restart progress.
      onSuccess(data);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={onClose} ariaLabel={`Remove ${integration.label}`}>
      <div className="w-full max-w-md overflow-hidden modal-panel">
        <div className="px-6 py-5">
          <div className="text-[15px] font-semibold text-foreground">{title || `Remove ${integration.label}?`}</div>
          <div className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground/80">
            {body || "This deactivates the integration and erases its stored credentials. You can reconnect it any time."}
          </div>
          {error && (
            <div className="mt-3 rounded-[6px] border border-destructive/25 bg-destructive/[0.05] px-3 py-2 text-[12px] text-destructive">
              {error}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border/50 px-6 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-[6px] px-3.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground/85 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-[6px] border border-destructive/25 bg-destructive/10 px-3.5 py-1.5 text-[13px] font-medium text-destructive transition-colors hover:bg-destructive/[0.16] disabled:opacity-50"
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {busy ? (busyLabel || 'Removing…') : (confirmLabel || 'Remove')}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ─── Modal shell ───────────────────────────────────────────────────────────

// Neutral tag for integrations that are early and may change (quieter than Beta).
export function ExperimentalTag({ className }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded-full bg-foreground/[0.07] px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-muted-foreground', className)}>
      Experimental
    </span>
  );
}

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
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop px-4 animate-[fade-in_0.12s_ease-out]"
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

export function formatRelative(date) {
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
