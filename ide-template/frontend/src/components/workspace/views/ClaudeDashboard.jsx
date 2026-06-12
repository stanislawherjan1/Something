import { useState, useEffect, useRef } from 'react';
import {
  Hexagon, ChevronLeft, ChevronRight, Save, Check, Loader2,
  Bot, BookOpen, Key, X, CheckCircle2, AlertTriangle, ArrowRight,
  Brain,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import EditorHeader from '../EditorHeader.jsx';
import { useBranding, BrandedImage, BOT_FALLBACK } from '../identity';
import { useApi } from '@/lib/useApi';
import { Skeleton, SkeletonTile } from '@/components/ui/Skeleton';
import { RestartingBanner, DoneBanner, RestartFailedBanner, runRestartPhases } from '../RestartBanners';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const PRESET_AVATARS = Array.from({ length: 16 }, (_, i) => ({
  id: String(i + 1),
  url: `${BASE}/avatars/${i + 1}.png`,
}));

const labelCls = 'text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground/75';
const inputCls = cn(
  'w-full rounded border border-border/60 bg-background px-3.5 py-2.5 text-[13px] text-foreground outline-none',
  'transition-all focus:border-foreground/60 focus:ring-2 focus:ring-foreground/10',
);

/* ─── Dashboard ─────────────────────────────────────────────────────────── */

export default function ClaudeDashboard({ fileEventNonce, sidebarOpen, onSelect }) {
  const [open, setOpen] = useState(null);

  // Branding comes from the global BrandingProvider (single fetch, cached).
  const branding = useBranding();

  // Setup status (hasClaudeToken, claudeTokenSetAt, ...) — SWR-cached so
  // tab switches don't show a "loading" flash. Background revalidates on
  // each mount, mutations call invalidate('/api/setup/status') to refresh.
  const status = useApi('/api/setup/status');

  // Memory preview — how many of the 7 cards are seeded + cache floor state.
  // Cheap call (loader builds the prefix from disk; ≤ 30 KB markdown).
  const memory = useApi('/api/memory/prefix');

  // True only on first ever mount before the first fetch lands. Subsequent
  // tab switches reuse the cached state and skip the skeleton.
  const isInitialLoad = !branding.loaded || (status.loading && !status.data);

  const close = () => {
    setOpen(null);
    status.reload();
    branding.reload();
  };

  const avatarUrl = branding.botAvatarUrl;
  const botName   = branding.botDisplayName || branding.botName;
  const hasToken  = status.data?.state?.hasClaudeToken;
  const tokenDate = status.data?.state?.claudeTokenSetAt;

  const botTile = {
    id: 'bot',
    logo: <BotLogo src={avatarUrl} />,
    label: botName || 'Bot',
    description: 'Avatar and display name for your assistant.',
    active: !!botName,
    credential: null,
    activatedAt: null,
  };
  const instructionsTile = {
    id: 'instructions',
    logo: <IconLogo icon={BookOpen} />,
    label: 'Instructions',
    description: 'Behaviour rules and persona defined in CLAUDE.md.',
    active: false,
    credential: null,
    activatedAt: null,
  };
  const claudeTile = {
    id: 'claude',
    logo: <AnthropicLogoBox />,
    label: 'Claude',
    description: 'Anthropic API token for the Claude Code CLI.',
    active: hasToken,
    credential: hasToken ? '••••••••' : null,   // setup.status() doesn't expose the token's last4 (it's a long-lived secret), so we just signal "is set"
    activatedAt: tokenDate,
  };

  // Memory preview — count seeded cards + show cache-floor status.
  const memorySources = memory.data?.sources || [];
  const cardsPresent = memorySources.filter(s => s.present).length;
  const cardsTotal = memorySources.length;
  const tokensApprox = memory.data?.approxTokens || 0;
  const cacheReady = !!memory.data?.meetsCacheFloor;
  const memoryDescription = cardsTotal
    ? `${cardsPresent}/${cardsTotal} cards · ~${tokensApprox.toLocaleString()} tokens · cache ${cacheReady ? 'ready' : 'below floor'}`
    : 'Knowledge cards, topics, and patterns — your bot\'s long-term memory.';
  const memoryTile = {
    id: 'memory',
    logo: <IconLogo icon={Brain} />,
    label: 'Memory',
    description: memoryDescription,
    active: cardsPresent > 0,
    credential: null,
    activatedAt: null,
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={Hexagon} title="AI Settings" sidebarOpen={sidebarOpen} />

      <div className="flex-1 overflow-auto">
        <div className="flex max-w-2xl flex-col gap-3 px-6 pb-12 pt-2">
          {isInitialLoad ? (
            // First-ever mount, no cache yet — show skeletons rather than
            // a faked "Aria + stock avatar" placeholder.
            <>
              <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
                <SkeletonTile />
                <SkeletonTile />
              </div>
              <SkeletonTile />
            </>
          ) : (
            <>
              <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
                <SettingTile tile={botTile} onOpen={() => setOpen('bot')} />
                <SettingTile tile={instructionsTile} onOpen={() => setOpen('instructions')} />
              </div>
              <SettingTile
                tile={memoryTile}
                onOpen={() => onSelect && onSelect({ path: 'memory', type: 'memory' })}
              />
              <SettingTile tile={claudeTile} onOpen={() => setOpen('claude')} />
            </>
          )}
        </div>
      </div>

      {open === 'bot'          && <BotModal branding={branding} onClose={close} />}
      {open === 'instructions' && <InstructionsModal fileEventNonce={fileEventNonce} onClose={close} />}
      {open === 'claude'       && <ClaudeModal initialStatus={status.data?.state} onClose={close} />}
    </div>
  );
}

/* ─── Tile — mirrors IntegrationTile exactly ────────────────────────────── */

function SettingTile({ tile, onOpen }) {
  const { logo, label, description, active, credential, activatedAt } = tile;

  return (
    <div className={cn(
      'group relative flex flex-col rounded-xl border bg-card transition-all duration-150',
      'border-border/60 hover:border-foreground/15 hover:shadow-[0_2px_6px_rgba(0,0,0,0.035)]',
    )}>
      {/* Header — logo + status pill */}
      <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3">
        {logo}
        {active && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="size-2.5" strokeWidth={2.5} />
            Active
          </span>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col px-4">
        <div className="text-[14.5px] font-semibold text-foreground/90">{label}</div>
        <div className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground/80">
          {description}
        </div>
        {active && credential && (
          <div className="mt-3 flex items-center gap-2 rounded-md bg-muted/40 px-2.5 py-1.5">
            <span className="font-mono text-[11.5px] text-foreground/70">{credential}</span>
            {activatedAt && (
              <>
                <span className="text-[11px] text-muted-foreground/60">·</span>
                <span className="text-[11px] text-muted-foreground/70">
                  set {formatRelative(new Date(activatedAt))}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 pb-4 pt-3.5">
        <button
          type="button"
          onClick={onOpen}
          className={cn(
            'inline-flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-all active:scale-[0.98]',
            active
              ? 'bg-muted/40 text-muted-foreground/75 hover:bg-muted/55 hover:text-foreground/90'
              : 'bg-foreground text-background hover:opacity-95',
          )}
        >
          {active ? 'Configure' : 'Set up'}
          {!active && <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" strokeWidth={2} />}
        </button>
      </div>
    </div>
  );
}

/* ─── Logo components ───────────────────────────────────────────────────── */

function BotLogo({ src }) {
  const [errored, setErrored] = useState(false);
  return (
    <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-card shadow-[inset_0_0_0_1px_rgba(0,0,0,0.05)] ring-1 ring-black/[0.04]">
      {errored
        ? <Bot className="size-6 text-muted-foreground/50" strokeWidth={1.5} />
        : <img src={src} alt="" onError={() => setErrored(true)} className="size-full object-cover" />
      }
    </div>
  );
}

function IconLogo({ icon: Icon }) {
  return (
    <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-card shadow-[inset_0_0_0_1px_rgba(0,0,0,0.05)] ring-1 ring-black/[0.04]">
      <Icon className="size-6 text-muted-foreground/55" strokeWidth={1.5} />
    </div>
  );
}

function AnthropicLogoBox() {
  return (
    <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-card shadow-[inset_0_0_0_1px_rgba(0,0,0,0.05)] ring-1 ring-black/[0.04]">
      <img src={`${BASE}/integrations/claude.svg`} alt="" className="size-7 object-contain" />
    </div>
  );
}

function AnthropicMark({ className }) {
  return (
    <img src={`${BASE}/integrations/claude.svg`} alt="" className={cn('object-contain', className)} />
  );
}

/* ─── Modal shell — copied from TeamDashboard ───────────────────────────── */

function ModalShell({ children, onClose, ariaLabel }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-[3px]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {children}
    </div>
  );
}

/* ─── API wrapper — mocks success when backend unreachable (Vite dev) ─── */

async function apiWrite(url, opts = {}) {
  try {
    const r = await fetch(url, opts);
    if (r.ok) return { ok: true };
    // 404 = route not registered (running Vite dev without workspace-api).
    // Pretend it worked so the local UI flow stays usable.
    if (r.status === 404) return { ok: true, mock: true };
    const data = await r.json().catch(() => ({}));
    return { ok: false, error: data.error || `HTTP ${r.status}` };
  } catch {
    // Network failure (workspace-api not running) — treat as mock.
    return { ok: true, mock: true };
  }
}

/* ─── Bot modal ─────────────────────────────────────────────────────────── */

function BotModal({ branding, onClose }) {
  const initialIdx = (() => {
    const url = branding?.botAvatarUrl;
    if (!url) return 0;
    const m = url.match(/\/avatars\/(\d+)\.png/);
    return m ? Number(m[1]) - 1 : 0;
  })();
  const [botName, setBotName]     = useState(branding?.botName || branding?.botDisplayName || '');
  const [avatarIdx, setAvatarIdx] = useState(initialIdx);
  const [busy, setBusy]   = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const total = PRESET_AVATARS.length;

  const save = async () => {
    setBusy(true); setError(null); setSaved(false);
    const r1 = await apiWrite('/api/branding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botName: botName.trim() }),
    });
    if (!r1.ok) { setError(r1.error); setBusy(false); return; }
    const r2 = await apiWrite('/api/setup/avatar/preset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: PRESET_AVATARS[avatarIdx].id }),
    });
    if (!r2.ok) { setError(r2.error); setBusy(false); return; }
    setSaved(true); setBusy(false);
    setTimeout(() => { setSaved(false); onClose(); }, 1000);
  };

  return (
    <ModalShell onClose={onClose} ariaLabel="Bot settings">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-border/60 bg-background shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Bot className="size-4 text-foreground/75" strokeWidth={1.75} />
            <h2 className="text-[14px] font-semibold text-foreground/90">Bot</h2>
          </div>
          <button type="button" onClick={onClose} className="flex size-7 items-center justify-center rounded-md text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground/85">
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex flex-col gap-6 px-5 py-6">
          {/* Avatar — centred carousel */}
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-4">
              <button type="button" onClick={() => setAvatarIdx((avatarIdx - 1 + total) % total)}
                className="flex size-8 items-center justify-center rounded-full border border-border/55 bg-background text-muted-foreground/70 hover:bg-muted/40 transition-colors">
                <ChevronLeft className="size-4" strokeWidth={2} />
              </button>
              <div className="size-20 overflow-hidden rounded-2xl border border-border/50 shadow-sm">
                <img src={PRESET_AVATARS[avatarIdx].url} alt="" className="size-full object-cover" />
              </div>
              <button type="button" onClick={() => setAvatarIdx((avatarIdx + 1) % total)}
                className="flex size-8 items-center justify-center rounded-full border border-border/55 bg-background text-muted-foreground/70 hover:bg-muted/40 transition-colors">
                <ChevronRight className="size-4" strokeWidth={2} />
              </button>
            </div>
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground/55">{avatarIdx + 1} / {total}</span>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className={labelCls}>Name</span>
            <input type="text" value={botName}
              onChange={(e) => setBotName(e.target.value.replace(/[^a-zA-Z0-9 _-]/g, ''))}
              placeholder="aria · max · luna" spellCheck={false} autoComplete="off"
              className={inputCls} />
          </label>

          {error && <ErrorRow>{error}</ErrorRow>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/40 bg-muted/20 px-5 py-3">
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded-md px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90 disabled:opacity-50">
            Cancel
          </button>
          <button type="button" onClick={save} disabled={busy || !botName.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:bg-foreground/85 disabled:opacity-50">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : saved ? <Check className="size-3.5" strokeWidth={2.5} /> : <Save className="size-3.5" strokeWidth={2} />}
            {busy ? 'Saving…' : saved ? 'Saved' : 'Save'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

/* ─── Instructions modal ────────────────────────────────────────────────── */

function InstructionsModal({ fileEventNonce, onClose }) {
  const [path, setPath]         = useState('.claude/CLAUDE.md');
  const [content, setContent]   = useState('');
  const [original, setOriginal] = useState('');
  const [loadStatus, setLoadStatus] = useState('loading');
  const [error, setError]       = useState(null);
  const [saving, setSaving]     = useState(false);
  const dirty = content !== original;
  const isFirstLoad = useRef(true);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  useEffect(() => {
    let cancelled = false;
    const initial = isFirstLoad.current;
    (async () => {
      for (const p of ['.claude/CLAUDE.md', 'CLAUDE.md']) {
        const r = await fetch(`/api/files/read?path=${encodeURIComponent(p)}`);
        if (cancelled) return;
        if (r.ok) {
          const data = await r.json().catch(() => ({}));
          const c = typeof data.content === 'string' ? data.content : '';
          setPath(p);
          // External refetch must not clobber unsaved edits in the textarea.
          if (initial || !dirtyRef.current) { setContent(c); setOriginal(c); }
          else setOriginal(c);
          setLoadStatus('ok');
          isFirstLoad.current = false;
          return;
        }
      }
      // Neither path exists yet — start with an empty editor; save will create the file.
      if (!cancelled) {
        if (initial) { setContent(''); setOriginal(''); }
        setLoadStatus('ok');
        isFirstLoad.current = false;
      }
    })();
    return () => { cancelled = true; };
  }, [fileEventNonce]);

  const save = async () => {
    setSaving(true); setError(null);
    const r = await apiWrite('/api/files/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    });
    if (!r.ok) setError(r.error);
    else setOriginal(content);
    setSaving(false);
  };

  return (
    <ModalShell onClose={onClose} ariaLabel="Edit instructions">
      <div
        className="flex w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border/60 bg-background shadow-xl"
        style={{ height: '70vh' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <BookOpen className="size-4 text-foreground/75" strokeWidth={1.75} />
            <div>
              <h2 className="text-[14px] font-semibold text-foreground/90">Instructions</h2>
              <div className="font-mono text-[11px] text-muted-foreground/55">{path}</div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {dirty && <span className="text-[11.5px] text-muted-foreground/55">Unsaved</span>}
            <button type="button" onClick={onClose} className="flex size-7 items-center justify-center rounded-md text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground/85">
              <X className="size-3.5" strokeWidth={1.75} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-hidden">
          {loadStatus === 'loading' ? (
            <div className="flex h-full flex-col gap-2.5 px-5 py-4" aria-busy="true" aria-live="polite">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-5/6" />
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-3/5" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ) : (
            <textarea
              value={content}
              onChange={(e) => { setContent(e.target.value); setError(null); }}
              className="size-full resize-none border-0 bg-transparent px-5 py-4 outline-none font-mono text-[13px] leading-[1.65] text-foreground/90"
              spellCheck={false}
            />
          )}
        </div>

        {error && (
          <div className="border-t border-destructive/30 bg-destructive/5 px-5 py-2 text-[12px] text-destructive">{error}</div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-border/40 bg-muted/20 px-5 py-3">
          <span className="text-[11px] text-muted-foreground/55">
            {loadStatus === 'loading' ? '' : `${content.length} chars`}
          </span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose}
              className="rounded-md px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90">
              Close
            </button>
            <button type="button" onClick={save} disabled={!dirty || saving}
              className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:bg-foreground/85 disabled:opacity-50">
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" strokeWidth={2} />}
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

/* ─── Claude token modal ────────────────────────────────────────────────── */

function ClaudeModal({ initialStatus, onClose }) {
  // Active view shows status + Remove button. Replace mode is opt-in: the
  // "Replace token" button switches the modal into the form view, mirroring
  // how IntegrationsDashboard handles credential rotation (remove → activate).
  const [status, setStatus]     = useState(initialStatus || null);
  const [mode, setMode]         = useState(initialStatus?.hasClaudeToken ? 'view' : 'edit');
  const [token, setToken]       = useState('');
  // phase: 'idle' | 'saving' | 'restarting' | 'done'
  //   saving     — POST/DELETE in flight (~200ms)
  //   restarting — API ok'd, bot is cycling (~10-15s). Show progress
  //                so the operator doesn't think the click silently failed.
  //   done       — restart window elapsed; brief check before transition.
  const [phase, setPhase]       = useState('idle');
  // restartFailed — true when the API saved creds but couldn't signal the
  // bot (signal file missing → bot never started, or pre-watcher image).
  // We still treat the save as a success but warn the operator that a
  // container restart is needed for the new token to take effect.
  const [restartFailed, setRestartFailed] = useState(false);
  const [error, setError]       = useState(null);

  const busy = phase !== 'idle';

  useEffect(() => {
    fetch('/api/setup/status').then(r => r.ok ? r.json() : null).then(d => {
      if (!d) return;
      setStatus(d.state);
      // Don't yank the user out of the form they're already filling in.
      if (mode === 'view' && !d.state?.hasClaudeToken) setMode('edit');
    });
  }, [phase === 'done']);

  const save = async () => {
    if (!token.trim()) return;
    setPhase('saving'); setError(null); setRestartFailed(false);
    const r = await apiWrite('/api/setup/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token.trim() }),
    });
    if (!r.ok) { setError(r.error); setPhase('idle'); return; }
    // Mock-mode: API isn't there, but locally pretend the token stuck.
    if (r.mock) {
      setStatus({ hasClaudeToken: true, claudeTokenSetAt: new Date().toISOString() });
    }
    setToken('');
    await runRestartPhases({ response: r, setPhase, setRestartFailed });
    setPhase('idle');
    setMode('view');
  };

  const remove = async () => {
    setPhase('saving'); setError(null); setRestartFailed(false);
    const r = await apiWrite('/api/setup/token', { method: 'DELETE' });
    if (!r.ok) { setError(r.error); setPhase('idle'); return; }
    if (r.mock) {
      setStatus({ hasClaudeToken: false, claudeTokenSetAt: null });
    } else {
      const s = await fetch('/api/setup/status').then(x => x.ok ? x.json() : null).catch(() => null);
      if (s) setStatus(s.state);
    }
    await runRestartPhases({ response: r, setPhase, setRestartFailed });
    setMode('edit');
    setPhase('idle');
  };

  const isActive = status?.hasClaudeToken;
  const showView = mode === 'view' && isActive;

  return (
    <ModalShell onClose={onClose} ariaLabel="Claude token">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-border/60 bg-background shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <AnthropicMark className="size-4" />
            <h2 className="text-[14px] font-semibold text-foreground/90">Claude</h2>
          </div>
          <button type="button" onClick={onClose} className="flex size-7 items-center justify-center rounded-md text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground/85">
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>

        {showView ? (
          /* ─── ACTIVE VIEW: status card + Replace/Remove ─── */
          <div className="flex flex-col gap-4 px-5 py-5">
            <div className="flex items-center gap-3 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.06] px-4 py-3">
              <CheckCircle2 className="size-4 shrink-0 text-emerald-600" strokeWidth={2} />
              <div className="flex-1">
                <div className="text-[13px] font-medium text-foreground/90">Token active</div>
                <div className="text-[12px] text-muted-foreground/75">
                  Set on {new Date(status.claudeTokenSetAt).toLocaleDateString()} · stored encrypted
                </div>
              </div>
            </div>

            <p className="text-[12.5px] leading-relaxed text-muted-foreground/75">
              The Claude Code CLI uses this token for every assistant turn.
              To rotate it, remove the current one and set up a new one.
            </p>

            {phase === 'restarting' && (
              <RestartingBanner />
            )}
            {phase === 'done' && !restartFailed && (
              <DoneBanner />
            )}
            {restartFailed && (
              <RestartFailedBanner />
            )}
            {error && <ErrorRow>{error}</ErrorRow>}
          </div>
        ) : (
          /* ─── EDIT VIEW: form + how-to ─── */
          <div className="flex flex-col gap-5 px-5 py-5">
            {isActive && phase === 'idle' && (
              <div className="flex items-center gap-2 rounded-md border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[12.5px] text-amber-700 dark:text-amber-400">
                <AlertTriangle className="size-3.5 shrink-0" strokeWidth={2} />
                <span>Replacing will overwrite the current token.</span>
              </div>
            )}

            {phase === 'restarting' && <RestartingBanner />}
            {phase === 'done' && !restartFailed && <DoneBanner />}
            {restartFailed && <RestartFailedBanner />}

            <label className="flex flex-col gap-1.5">
              <span className={labelCls}>{isActive ? 'New setup token' : 'Setup token'}</span>
              <input type="password" value={token} onChange={(e) => setToken(e.target.value)}
                placeholder="sk-ant-oat01-…" spellCheck={false} autoComplete="off"
                className={cn(inputCls, 'font-mono')} />
              <span className="text-[11.5px] text-muted-foreground/55">Stored encrypted. Never leaves your server.</span>
            </label>

            <div className="flex flex-col gap-1">
              <span className={labelCls}>How to get a token</span>
              <ol className="mt-1 flex flex-col">
                {[
                  <>Run <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">claude setup-token</code> in a terminal.</>,
                  'Sign in with your Anthropic account in the browser that opens.',
                  <>Copy the token starting with <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10.5px]">sk-ant-oat01-</code> and paste above.</>,
                ].map((body, i) => (
                  <li key={i} className="flex items-start gap-2.5 py-1.5">
                    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-border text-[9px] font-semibold text-muted-foreground">{i + 1}</span>
                    <span className="text-[12.5px] leading-relaxed text-muted-foreground">{body}</span>
                  </li>
                ))}
              </ol>
            </div>

            {error && <ErrorRow>{error}</ErrorRow>}
          </div>
        )}

        {showView ? (
          <div className="flex items-center justify-between gap-2 border-t border-border/40 bg-muted/20 px-5 py-3">
            <button type="button" onClick={remove} disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" strokeWidth={2} />}
              Remove
            </button>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onClose}
                className="rounded-md px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90">
                Close
              </button>
              <button type="button" onClick={() => setMode('edit')}
                className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:bg-foreground/85">
                Replace
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2 border-t border-border/40 bg-muted/20 px-5 py-3">
            <button type="button" onClick={isActive ? () => setMode('view') : onClose}
              className="rounded-md px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90">
              Cancel
            </button>
            <button type="button" onClick={save} disabled={busy || !token.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:bg-foreground/85 disabled:opacity-50">
              {phase === 'saving' || phase === 'restarting'
                ? <Loader2 className="size-3.5 animate-spin" />
                : phase === 'done'
                  ? <Check className="size-3.5" strokeWidth={2.5} />
                  : <Save className="size-3.5" strokeWidth={2} />}
              {phase === 'saving'
                ? 'Saving…'
                : phase === 'restarting'
                  ? 'Restarting bot…'
                  : phase === 'done'
                    ? (restartFailed ? 'Saved' : 'Done')
                    : 'Save'}
            </button>
          </div>
        )}
      </div>
    </ModalShell>
  );
}

/* ─── Shared ─────────────────────────────────────────────────────────────── */

function ErrorRow({ children }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
      <span>{children}</span>
    </div>
  );
}

function formatRelative(date) {
  const diff = Date.now() - date.getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return date.toLocaleDateString();
}
