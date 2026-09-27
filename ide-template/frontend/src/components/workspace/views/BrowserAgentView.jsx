import { useCallback, useState } from 'react';
import {
  AppWindow, Eye, MousePointerClick, MousePointer2, FileText, Download, Copy, Check, Zap, ShieldCheck,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useApi, invalidate } from '@/lib/useApi';
import EditorHeader from '../EditorHeader.jsx';
import { useBranding } from '../identity';
import useMe from '../useMe.js';
import { ActivateModal, RemoveDialog, ExperimentalTag, Tabs } from './IntegrationsDashboard.jsx';

/**
 * Browser agent — what the Chrome side-panel extension does, and how to
 * install it. The extension package is served from the workspace itself
 * (public/downloads, built by scripts/build-extension-zip.sh), so installing
 * needs nothing but this page.
 *
 * The optional Jev (TypeSafe) integration is set up here, not in the
 * Integrations marketplace (its catalog entry has `home: "browser-agent"`):
 * it only serves this agent. Connecting and removing it use the same windows
 * as every other integration.
 */
const ZIP_URL = `${(import.meta.env.BASE_URL || '/').replace(/\/+$/, '')}/downloads/something-chrome-extension.zip`;

export default function BrowserAgentView({ sidebarOpen }) {
  const { botDisplayName, botName, botAvatarUrl } = useBranding();
  const bot = botDisplayName || botName || 'Your assistant';
  const host = typeof window !== 'undefined' ? window.location.host : '';
  const [tab, setTab] = useState('overview');

  const { me } = useMe();
  const isAdmin = !!me?.isAdmin;
  const { data, reload: reloadApi } = useApi('/api/integrations');
  const jev = data?.integrations?.find(i => i.id === 'jev') || null;
  const autopilot = !!jev?.active;
  const [connecting, setConnecting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const reload = useCallback(() => { invalidate('/api/integrations'); return reloadApi(); }, [reloadApi]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={AppWindow} title="Browser agent" sidebarOpen={sidebarOpen} />

      <div className="flex-1 overflow-auto">
        <div className="flex max-w-2xl flex-col gap-6 px-6 pb-12 pt-2">
          <Tabs
            value={tab}
            onChange={setTab}
            items={[{ id: 'overview', label: 'Overview' }, { id: 'install', label: 'Install' }]}
          />

          {tab === 'overview' ? (
            <section className="flex flex-col gap-3">
              <BrowserMock bot={bot} avatar={botAvatarUrl} autopilot={autopilot} />
              <div className="flex flex-col gap-1.5 text-[13px] leading-relaxed text-muted-foreground/85">
                <p>{bot} in Chrome&apos;s side panel, next to any page.</p>
                <p className="flex items-start gap-2">
                  <Eye className="mt-[3px] size-3.5 shrink-0 text-foreground/65" strokeWidth={1.75} />
                  <span><span className="font-medium text-foreground/85">Look</span> — always on: it sees the page you&apos;re on whenever that helps.</span>
                </p>
                <p className="flex items-start gap-2">
                  <MousePointerClick className="mt-[3px] size-3.5 shrink-0 text-destructive/80" strokeWidth={1.75} />
                  <span>
                    <span className="font-medium text-foreground/85">Act</span> — your switch: it clicks and types for you, and stops the moment you switch it off.
                    {autopilot && ' With the Jev autopilot it finishes whole tasks by itself.'}
                  </span>
                </p>
              </div>
            </section>
          ) : (
            <>
              <section className="flex flex-col gap-3">
                <SectionTitle>The extension</SectionTitle>
                <ol className="flex flex-col gap-2.5">
                  <Step n={1}>
                    <span>Download the extension</span>
                    <a
                      href={ZIP_URL}
                      download
                      className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-background px-3 py-1.5 text-[12.5px] font-medium text-foreground/85 shadow-[0_1px_1px_rgba(0,0,0,0.03)] hover:bg-muted/40"
                    >
                      <Download className="size-3.5" strokeWidth={1.75} />
                      Download
                    </a>
                  </Step>
                  <Step n={2}>
                    <span>Unzip it on your Desktop and keep the folder there</span>
                  </Step>
                  <Step n={3}>
                    <span>Open</span>
                    <CopyChip text="chrome://extensions" />
                    <span>and turn on Developer mode</span>
                  </Step>
                  <Step n={4}>
                    <span>Click <b className="font-medium text-foreground/90">Load unpacked</b> and choose the folder</span>
                  </Step>
                  <Step n={5}>
                    <span>Pin it, open it, enter</span>
                    <CopyChip text={host} />
                  </Step>
                </ol>
              </section>

              {jev && (
                <section className="flex flex-col gap-3">
                  <SectionTitle>Faster with Jev <span className="font-normal normal-case tracking-normal">· optional</span></SectionTitle>
                  <JevCard
                    jev={jev}
                    isAdmin={isAdmin}
                    ready={!!data?.ready}
                    onConnect={() => setConnecting(true)}
                    onRemove={() => setRemoving(true)}
                  />
                </section>
              )}
            </>
          )}
        </div>
      </div>

      {connecting && jev && (
        <ActivateModal
          integration={jev}
          onClose={() => setConnecting(false)}
          onSuccess={() => { setConnecting(false); reload(); }}
        />
      )}
      {removing && jev && (
        <RemoveDialog
          integration={jev}
          onClose={() => setRemoving(false)}
          onSuccess={() => { setRemoving(false); reload(); }}
        />
      )}
    </div>
  );
}

// The optional Jev integration: what it adds (a speed comparison), where the
// page's text goes, and one action. Admins connect / disconnect; everyone else
// sees the state.
function JevCard({ jev, isAdmin, ready, onConnect, onRemove }) {
  const on = jev.active;
  return (
    <div className="flex flex-col gap-3.5 rounded-lg border border-border/60 bg-card p-4">
      <div className="flex items-start gap-3">
        <img src={jev.logo} alt="" className="size-9 shrink-0 rounded-lg object-cover ring-1 ring-foreground/10" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-foreground/90">
            Jev autopilot
            {on
              ? <span className="rounded-full bg-emerald-500/12 px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">On</span>
              : <ExperimentalTag />}
          </div>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground/85">
            {on ? 'Multi-step tasks run by themselves while Act is on.' : 'Finishes multi-step tasks for you — search, filters, forms.'}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 rounded-md border border-border/50 bg-background px-3 py-2.5">
        <SpeedRow label="Step by step" value="a few seconds a step" width="100%" />
        <SpeedRow label="With Jev" value="under 1 s" width="14%" strong />
      </div>

      <div className="flex items-start gap-1.5 text-[11.5px] text-muted-foreground/80">
        <ShieldCheck className="mt-px size-3.5 shrink-0" strokeWidth={1.75} />
        Page text goes to TypeSafe while it works. Password and payment fields never do.
      </div>

      {!isAdmin ? (
        on && <div className="text-[11.5px] text-muted-foreground/70">Set up by a workspace admin.</div>
      ) : on ? (
        <button
          type="button"
          onClick={onRemove}
          className="w-full rounded-md bg-muted/40 px-3 py-2 text-[12.5px] font-medium text-muted-foreground/80 transition-colors hover:bg-muted/55 hover:text-foreground/90"
        >
          Disconnect
        </button>
      ) : (
        <button
          type="button"
          onClick={onConnect}
          disabled={!ready}
          title={ready ? undefined : 'Integrations are not configured on this server.'}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-foreground px-3 py-2 text-[12.5px] font-medium text-background transition-all hover:opacity-95 active:scale-[0.98] disabled:opacity-40"
        >
          Connect Jev
        </button>
      )}
    </div>
  );
}

function SpeedRow({ label, value, width, strong = false }) {
  return (
    <div className={cn('grid grid-cols-[84px_1fr_auto] items-center gap-2.5 text-[11.5px]', strong ? 'font-medium text-foreground/85' : 'text-muted-foreground/80')}>
      <span>{label}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.06]">
        <span className={cn('block h-full rounded-full', strong ? 'bg-foreground/80' : 'bg-foreground/20')} style={{ width }} />
      </span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function SectionTitle({ children }) {
  return <h2 className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">{children}</h2>;
}

// An illustration, not a screenshot: a browser window whose page is a
// loading-skeleton, one control picked out the way Act picks it, and the side
// panel's chat next to it — the bot looking at the tab, shown as a tool pill.
function BrowserMock({ bot, avatar, autopilot = false }) {
  const bar = 'rounded bg-foreground/[0.07] animate-pulse';
  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-card shadow-[0_2px_12px_rgba(0,0,0,0.05)]">
      {/* window chrome */}
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-foreground/15" />
          <span className="size-2.5 rounded-full bg-foreground/15" />
          <span className="size-2.5 rounded-full bg-foreground/15" />
        </span>
        <span className="ml-2 flex h-5 flex-1 items-center rounded bg-muted/60 px-2 font-mono text-[10.5px] text-muted-foreground/70">
          store.example.com/orders
        </span>
      </div>
      <div className="flex min-h-[260px]">
        {/* the page */}
        <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
          <div className={cn(bar, 'h-3 w-2/5')} />
          <div className={cn(bar, 'h-2 w-4/5')} />
          <div className={cn(bar, 'h-2 w-3/5')} />
          <div className="mt-1 grid grid-cols-3 gap-2.5">
            <div className="h-16 rounded-md border border-border/60 bg-foreground/[0.03]" />
            <div className="relative h-16 rounded-md border-2 border-destructive/60 bg-destructive/[0.05]">
              <span className="absolute -left-1.5 -top-2 rounded bg-destructive/85 px-1 font-mono text-[9px] font-semibold text-background">e7</span>
              <MousePointer2 className="absolute bottom-1 right-2 size-5 fill-destructive/80 text-destructive/80" strokeWidth={1.5} />
            </div>
            <div className="h-16 rounded-md border border-border/60 bg-foreground/[0.03]" />
          </div>
          <div className={cn(bar, 'mt-1 h-2 w-full')} />
          <div className={cn(bar, 'h-2 w-11/12')} />
          <div className={cn(bar, 'h-2 w-2/3')} />
        </div>
        {/* the side panel */}
        <div className="flex w-[44%] max-w-[240px] shrink-0 flex-col border-l border-border/60 bg-background">
          <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
            {avatar
              ? <img src={avatar} alt="" className="size-5 rounded-full object-cover ring-1 ring-foreground/10" />
              : <span className="size-5 rounded-full bg-muted" />}
            <span className="truncate text-[12px] font-semibold text-foreground/90">{bot}</span>
          </div>
          <div className="flex flex-1 flex-col gap-2 p-3">
            <div className="self-end rounded-xl border border-border/60 bg-card px-2.5 py-1.5 text-[11px] text-foreground/85">
              Which orders are late?
            </div>
            <span className="inline-flex items-center gap-1 self-start text-[10px] text-muted-foreground/85">
              {autopilot ? <Zap className="size-2.5" strokeWidth={2} /> : <Eye className="size-2.5" strokeWidth={2} />}
              <span className="shimmer-text">{autopilot ? 'Autopilot · Clicking “Search”' : 'Reading the page'}</span>
            </span>
            <div className={cn(bar, 'h-1.5 w-11/12')} />
            <div className={cn(bar, 'h-1.5 w-4/5')} />
            <div className={cn(bar, 'h-1.5 w-3/5')} />
          </div>
          <div className="flex flex-col gap-1.5 p-2.5">
            <div className="flex items-center gap-1.5">
              <span className="inline-flex min-w-0 items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 text-[9.5px] text-foreground/70">
                <FileText className="size-2.5 shrink-0 opacity-65" strokeWidth={1.75} />
                <span className="truncate">Orders</span>
              </span>
              <span className="ml-auto inline-flex items-center gap-1">
                <MousePointerClick className="size-3 text-destructive/80" strokeWidth={1.75} />
                <span className="relative h-2.5 w-4 rounded-full bg-destructive/80">
                  <span className="absolute left-2 top-0.5 size-1.5 rounded-full bg-background" />
                </span>
              </span>
            </div>
            <div className="rounded-lg border border-border/50 bg-card px-2 py-1.5 text-[10.5px] text-muted-foreground/60">Ask anything</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Step({ n, children }) {
  return (
    <li className="flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-md border border-border/60 bg-card px-3 py-2.5 text-[13px] text-foreground/80">
      <span className="mr-1 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted/70 text-[11px] font-semibold text-foreground/70">{n}</span>
      {children}
    </li>
  );
}

function CopyChip({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1400); }
    catch { /* clipboard blocked: the text is still selectable */ }
  };
  return (
    <button
      type="button"
      onClick={copy}
      title="Copy"
      className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[12px] text-foreground/85 hover:bg-muted"
    >
      {text}
      {copied ? <Check className="size-3" strokeWidth={2} /> : <Copy className="size-3 opacity-60" strokeWidth={1.75} />}
    </button>
  );
}
