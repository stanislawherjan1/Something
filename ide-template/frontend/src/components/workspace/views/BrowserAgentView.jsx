import { useState } from 'react';
import {
  AppWindow, Eye, MousePointerClick, MousePointer2, FileText, Download, Copy, Check,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import EditorHeader from '../EditorHeader.jsx';
import { useBranding } from '../identity';

/**
 * Browser agent — what the Chrome side-panel extension does, and how to
 * install it. The extension package is served from the workspace itself
 * (public/downloads, built by scripts/build-extension-zip.sh), so installing
 * needs nothing but this page.
 */
const ZIP_URL = `${(import.meta.env.BASE_URL || '/').replace(/\/+$/, '')}/downloads/something-chrome-extension.zip`;

export default function BrowserAgentView({ sidebarOpen }) {
  const { botDisplayName, botName, botAvatarUrl } = useBranding();
  const bot = botDisplayName || botName || 'Your assistant';
  const host = typeof window !== 'undefined' ? window.location.host : '';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={AppWindow} title="Browser agent" sidebarOpen={sidebarOpen} />

      <div className="flex-1 overflow-auto">
        <div className="flex max-w-2xl flex-col gap-8 px-6 pb-12 pt-2">
          {/* How it works */}
          <section className="flex flex-col gap-3">
            <SectionTitle>How it works</SectionTitle>
            <BrowserMock bot={bot} avatar={botAvatarUrl} />
            <div className="flex flex-col gap-1.5 text-[13px] leading-relaxed text-muted-foreground/85">
              <p>{bot} in Chrome&apos;s side panel, next to any page.</p>
              <p className="flex items-start gap-2">
                <Eye className="mt-[3px] size-3.5 shrink-0 text-foreground/65" strokeWidth={1.75} />
                <span><span className="font-medium text-foreground/85">Look</span> — always on: it sees the page you&apos;re on whenever that helps.</span>
              </p>
              <p className="flex items-start gap-2">
                <MousePointerClick className="mt-[3px] size-3.5 shrink-0 text-destructive/80" strokeWidth={1.75} />
                <span><span className="font-medium text-foreground/85">Act</span> — your switch: it clicks and types for you on that site, and stops the moment you switch it off.</span>
              </p>
            </div>
          </section>

          {/* Install */}
          <section className="flex flex-col gap-3">
            <SectionTitle>Install</SectionTitle>
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
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }) {
  return <h2 className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">{children}</h2>;
}

// An illustration, not a screenshot: a browser window whose page is a
// loading-skeleton, one control picked out the way Act picks it, and the side
// panel's chat next to it — the bot looking at the tab, shown as a tool pill.
function BrowserMock({ bot, avatar }) {
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
            <span className="inline-flex items-center gap-1 self-start rounded-full bg-muted/60 px-2 py-0.5 text-[10px] text-muted-foreground/85">
              <Eye className="size-2.5" strokeWidth={2} />
              Looking at the tab
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
