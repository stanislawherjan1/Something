import { useState, useEffect, useRef } from 'react';
import {
  Hexagon, Check, Loader2,
  Bot, BookOpen, Key, X, CheckCircle2, AlertTriangle, ArrowRight,
  Lock, Upload, Brain, Clock, Wrench, Compass, Unplug,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import TileBanner from './TileBanner.jsx';
import AvatarTile, { PRESET_AVATARS } from './AvatarTile.jsx';
import StatusTag from './StatusTag.jsx';
import EditorHeader from '../EditorHeader.jsx';
import { useBranding, BrandedImage, BOT_FALLBACK } from '../identity';
import { useApi } from '@/lib/useApi';
import useMe from '../useMe.js';
import { useMemoryStatus } from '../useMemoryStatus.js';
import { Skeleton, SkeletonBannerTile } from '@/components/ui/Skeleton';
import { RestartingBanner, DoneBanner, RestartFailedBanner, runRestartPhases } from '../RestartBanners';
import { ActivateModal } from './IntegrationsDashboard.jsx';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

const labelCls = 'text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground/75';
const inputCls = cn(
  'w-full rounded border border-border/60 bg-background px-3.5 py-2.5 text-[13px] text-foreground outline-none',
  'transition-all focus:border-foreground/60 focus:ring-2 focus:ring-foreground/10',
);

// Shown in a modal footer in place of Save when the viewer isn't an admin.
function ReadOnlyNote() {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground/60">
      <Lock className="size-3" /> Read-only: admins manage AI settings
    </span>
  );
}

/* ─── Dashboard ─────────────────────────────────────────────────────────── */

export default function ClaudeDashboard({ fileEventNonce, sidebarOpen, onSelect }) {
  const [open, setOpen] = useState(null);

  // Branding comes from the global BrandingProvider (single fetch, cached).
  const branding = useBranding();

  // AI Settings is edit-by-admin; everyone else sees it read-only. The server
  // already 403s the writes — this gates the UI to match.
  const { me } = useMe();
  const isAdmin = !!me?.isAdmin;

  // Setup status (hasClaudeToken, claudeTokenSetAt, ...) — SWR-cached so
  // tab switches don't show a "loading" flash. Background revalidates on
  // each mount, mutations call invalidate('/api/setup/status') to refresh.
  const status = useApi('/api/setup/status');

  // Memory preview — how many of the 7 cards are seeded + cache floor state.
  // Cheap call (loader builds the prefix from disk; ≤ 30 KB markdown).
  const memory = useApi('/api/memory/prefix');
  const memoryStatus = useMemoryStatus();
  const v4Facts = useApi(memoryStatus.mode === 'on' ? '/api/memory/v4/facts?limit=1' : null);

  // Telegram — connection state (from the integrations catalog) + group count.
  const tg = useApi('/api/team/telegram-groups');
  const integrations = useApi('/api/integrations');
  const skills = useApi('/api/skills');

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
    logo: <TileBanner image={avatarUrl} mode="dark" lineArt seed="bot" />,
    label: botName || 'Bot',
    description: 'Avatar and display name for your assistant.',
    active: !!botName,
    alwaysOn: true,
    credential: null,
    activatedAt: null,
  };
  const instructionsTile = {
    id: 'instructions',
    logo: <TileBanner icon={Compass} seed="Compass" soft />,
    label: 'Instructions',
    description: 'Behaviour rules and persona defined in CLAUDE.md.',
    active: true,
    alwaysOn: true,
    credential: null,
    activatedAt: null,
  };
  const claudeTile = {
    id: 'claude',
    mark: `${BASE}/integrations/claude.svg`,
    logo: <TileBanner image={`${BASE}/integrations/claude.svg`} seed="claude" soft />,
    label: 'Claude',
    description: 'Anthropic API token for the Claude Code CLI.',
    active: hasToken,
    credential: hasToken ? '••••••••' : null,   // setup.status() doesn't expose the token's last4 (it's a long-lived secret), so we just signal "is set"
    activatedAt: tokenDate,
  };

  // Memory preview. Before memory v4 it counts the seeded cards and the cache
  // floor of the v3 prefix; with v4 collecting in the background it says so; on
  // v4 the prefix is small by design (the floor was a v3 measure — it is cached
  // together with the CLI's own system prompt) so the line counts what is
  // remembered instead.
  const memorySources = memory.data?.sources || [];
  const cardsPresent = memorySources.filter(s => s.present).length;
  const cardsTotal = memorySources.length;
  const tokensApprox = memory.data?.approxTokens || 0;
  const cacheReady = !!memory.data?.meetsCacheFloor;
  const memoryMode = memoryStatus.mode;
  const v3Line = cardsTotal
    ? `${cardsPresent}/${cardsTotal} cards · ~${tokensApprox.toLocaleString()} tokens · cache ${cacheReady ? 'ready' : 'below floor'}`
    : 'Knowledge cards, topics, and patterns: your bot\'s long-term memory.';
  const memoryDescription = memoryMode === 'on'
    ? `New memory · ${(v4Facts.data?.total ?? 0).toLocaleString()} facts from your conversations · ~${(Math.round(tokensApprox / 100) / 10).toLocaleString()}k tokens always loaded`
    : memoryMode === 'shadow'
      ? `${v3Line} · new memory collecting in the background`
      : v3Line;
  const memoryTile = {
    id: 'memory',
    logo: <TileBanner icon={Brain} seed="Brain" soft />,
    label: 'Memory',
    description: memoryDescription,
    active: true,
    alwaysOn: true,
    credential: null,
    activatedAt: null,
  };

  // Reminders — timed nudges + the bot's daily rituals. Sits next to Memory.
  const remindersTile = {
    id: 'reminders',
    logo: <TileBanner icon={Clock} seed="Clock" soft />,
    label: 'Reminders',
    description: 'Timed nudges plus the bot\'s daily rituals: planning, reflection, backups.',
    active: true,
    alwaysOn: true,
    credential: null,
    activatedAt: null,
  };

  // Skills and Integrations moved here from the sidebar.
  const skillCount = skills.data?.skills?.length || 0;
  const skillsTile = {
    id: 'skills',
    logo: <TileBanner icon={Wrench} seed="Wrench" soft />,
    label: 'Skills',
    description: skillCount ? `${skillCount} playbooks for recurring tasks` : 'Playbooks for recurring tasks.',
    active: true,
    alwaysOn: true,
    credential: null,
    activatedAt: null,
  };
  const activeIntegrations = (integrations.data?.integrations || []).filter(i => i.active).length;
  const integrationsTile = {
    id: 'integrations',
    logo: <TileBanner icon={Unplug} seed="Unplug" soft />,
    label: 'Integrations',
    description: activeIntegrations ? `${activeIntegrations} connected` : 'Connect the tools your assistant works with.',
    active: true,
    alwaysOn: true,
    credential: null,
    activatedAt: null,
  };

  // Telegram channel — registered groups + (later) token & per-user links.
  const tgCount = tg.data?.groups?.length || 0;
  const tgIntegration = (integrations.data?.integrations || []).find(i => i.id === 'telegram') || null;
  const tgConnected = !!tgIntegration?.active;
  const telegramTile = {
    id: 'telegram',
    mark: `${BASE}/integrations/telegram.svg`,
    logo: <TileBanner image={`${BASE}/integrations/telegram.svg`} mode="dark" seed="telegram" soft />,
    label: 'Telegram',
    description: tgConnected
      ? (tgCount ? `Active in ${tgCount} group${tgCount > 1 ? 's' : ''} · per-user links` : 'Channel connected · groups & per-user links')
      : 'The bot\'s Telegram channel: connect it to get started.',
    active: tgConnected,
    credential: tgConnected ? `••••${tgIntegration?.credentialSummary?.last4 || ''}` : null,
    activatedAt: tgConnected ? (tgIntegration?.activatedAt || null) : null,
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={Hexagon} title="AI Settings" sidebarOpen={sidebarOpen} />

      <div className="flex-1 overflow-auto">
        {/* The cards keep their width (as in the old two-column layout); only
            how many sit in a row changes with the space — four with the chat
            collapsed, fewer as it narrows, one full-width column on a phone. */}
        <div className="grid gap-3 px-6 pb-12 pt-2 [grid-template-columns:repeat(auto-fill,306px)] max-sm:grid-cols-1">
          {isInitialLoad ? (
            // First-ever mount, no cache yet — show skeletons rather than
            // a faked "Aria + stock avatar" placeholder.
            <>
              <SkeletonBannerTile />
              <SkeletonBannerTile />
              <SkeletonBannerTile />
              <SkeletonBannerTile />
            </>
          ) : (
            <>
              <SettingTile tile={botTile} onOpen={() => setOpen('bot')} canEdit={isAdmin} />
              <SettingTile tile={instructionsTile} onOpen={() => setOpen('instructions')} canEdit={isAdmin} />
              <SettingTile
                tile={memoryTile}
                onOpen={() => onSelect && onSelect({ path: 'memory', type: 'memory' })}
                canEdit={isAdmin}
              />
              <SettingTile
                tile={remindersTile}
                onOpen={() => onSelect && onSelect({ path: '.claude/reminders', type: 'reminders' })}
                canEdit={isAdmin}
              />
              <SettingTile
                tile={skillsTile}
                onOpen={() => onSelect && onSelect({ path: '.claude/skills', type: 'skills' })}
                canEdit={isAdmin}
              />
              <SettingTile
                tile={integrationsTile}
                onOpen={() => onSelect && onSelect({ path: '.claude/integrations', type: 'integrations' })}
                canEdit={isAdmin}
              />
              {/* Claude (API token) and Telegram expose credentials, so they're
                  admin-only — members see just the default-on tiles above. */}
              {isAdmin && (
                <>
                  <SettingTile tile={claudeTile} onOpen={() => setOpen('claude')} canEdit={isAdmin} />
                  <SettingTile
                    tile={telegramTile}
                    onOpen={() => tgConnected
                      ? onSelect && onSelect({ path: '.claude/telegram', type: 'telegram' })
                      : setOpen('telegram-setup')}
                    canEdit={isAdmin}
                  />
                </>
              )}
            </>
          )}
        </div>
      </div>

      {open === 'bot'          && <BotModal branding={branding} onClose={close} canEdit={isAdmin} />}
      {open === 'instructions' && <InstructionsModal fileEventNonce={fileEventNonce} onClose={close} canEdit={isAdmin} />}
      {open === 'claude'       && <ClaudeModal initialStatus={status.data?.state} onClose={close} canEdit={isAdmin} />}
      {open === 'telegram-setup' && tgIntegration && (
        <ActivateModal
          integration={tgIntegration}
          onClose={() => setOpen(null)}
          onSuccess={() => { setOpen(null); integrations.reload(); tg.reload(); }}
        />
      )}
    </div>
  );
}

/* ─── Tile — mirrors IntegrationTile exactly ────────────────────────────── */

function SettingTile({ tile, onOpen, canEdit = true }) {
  const { logo, mark, label, description, active, credential, activatedAt, alwaysOn } = tile;
  // Only Claude + Telegram can be "not set up" (no token / not connected). The rest
  // are default-on: no active pill, and the button always reads "Configure".
  const configured = alwaysOn || active;
  const showPill = active && !alwaysOn;
  // Read-only viewers (non-admins) can only inspect — surface that as "View"
  // rather than "Configure"/"Set up". Only admins ever see the primary CTA.
  const needsSetup = canEdit && !configured;
  const ctaLabel = !canEdit ? 'View' : configured ? 'Configure' : 'Set up';

  return (
    <div className={cn(
      'group relative flex flex-col overflow-hidden rounded-[6px] border bg-card transition-all duration-150',
      'border-border/60 hover:border-foreground/15 hover:shadow-[0_2px_6px_rgba(0,0,0,0.035)]',
    )}>
      {/* Header — a full-width banner picturing the setting; status pill on it */}
      <div className="relative">
        {logo}
        {showPill && (
          <StatusTag tone="active" className="absolute right-3 top-3">Active</StatusTag>
        )}
      </div>
      <div className="h-3.5" />

      {/* Body */}
      <div className="flex flex-1 flex-col px-4">
        <div className="flex items-center gap-2">
          {/* A brand's own mark next to its name (Claude, Telegram). */}
          <span className="text-[14.5px] font-semibold text-foreground/90">{label}</span>
          {mark && <img src={mark} alt="" className="size-4 shrink-0 object-contain" />}
        </div>
        <div className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground/80">
          {description}
        </div>
        {active && credential && (
          <div className="mt-3 flex items-center gap-2 rounded-[6px] bg-muted/40 px-2.5 py-1.5">
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
            'inline-flex w-full items-center justify-center gap-1.5 rounded-[6px] px-3 py-1.5 text-[12.5px] font-medium transition-all active:scale-[0.98]',
            needsSetup
              ? 'bg-foreground text-background hover:opacity-95'
              : 'bg-muted/40 text-muted-foreground/75 hover:bg-muted/55 hover:text-foreground/90',
          )}
        >
          {ctaLabel}
          {needsSetup && <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" strokeWidth={2} />}
        </button>
      </div>
    </div>
  );
}

/* ─── Logo components ───────────────────────────────────────────────────── */

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
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop px-4"
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

/* ─── Avatar tile ───────────────────────────────────────────────────────── */

// One picture in the grid.
//
// The ring is `ring-ring`, not `ring-[--color-ring]`: the token lives in
// `@theme inline`, so Tailwind v4 generates a `ring-ring` utility for it and
// the v3 bracket shorthand resolves to nothing at all — which is why the first
// version of this drew no outline whatever, rather than a faint one.
//
// Selection is carried by the ring plus the unselected tiles stepping back in
// opacity. A border swap would shift the image a pixel on every click along a
// row; dimming what isn't chosen makes the chosen one obvious without a heavy
// outline fighting the pictures.
// `halftone`: show the picture as the same dot-grid halftone as the AI
// Settings banners — the presets read as one set, in the screens' style.

/* ─── Bot modal ─────────────────────────────────────────────────────────── */

function BotModal({ branding, onClose, canEdit = true }) {
  // Which preset the bot is wearing right now, or null when it wears something
  // else (an uploaded image, or the neutral fallback).
  const currentPresetIdx = (() => {
    const m = /\/avatars\/(\d+)\.png/.exec(branding?.botAvatarUrl || '');
    return m ? Number(m[1]) - 1 : null;
  })();

  const [botName, setBotName] = useState(branding?.botName || branding?.botDisplayName || '');
  // The picture chosen in THIS visit to the modal, or null for "leave it as it
  // is". That distinction matters: the old version always wrote a preset on
  // save, so renaming the bot silently replaced its picture with preset #1.
  // Harmless while presets were the only option; destructive the moment an
  // uploaded image can be the thing being overwritten.
  //   { kind: 'preset', idx } | { kind: 'custom', file, url }
  const [pick, setPick]   = useState(null);
  const [busy, setBusy]   = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  // Don't leak the preview's blob URL when the choice changes or the modal closes.
  useEffect(() => () => { if (pick?.kind === 'custom') URL.revokeObjectURL(pick.url); }, [pick]);

  // Mirrors the server's own checks (lib/branding.js saveAvatar): PNG or JPEG,
  // under 2 MiB. Checked here too so the user hears it before the upload.
  const pickFile = (file) => {
    if (!file) return;
    if (!/^image\/(png|jpe?g)$/i.test(file.type)) {
      setError('The picture must be a PNG or JPEG.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError('The picture must be under 2 MiB.');
      return;
    }
    setError(null);
    setPick((prev) => {
      if (prev?.kind === 'custom') URL.revokeObjectURL(prev.url);
      return { kind: 'custom', file, url: URL.createObjectURL(file) };
    });
  };

  const pickedFile = pick?.kind === 'custom' ? pick.file : null;

  // The bot's picture when it is NOT one of the presets — a freshly chosen file,
  // or an upload it already wears. Gets its own tile so "what it looks like now"
  // is never something the user has to infer.
  const ownPictureUrl = pick?.kind === 'custom'
    ? pick.url
    : (currentPresetIdx === null ? branding?.botAvatarUrl || null : null);

  // Which tile reads as chosen: this visit's pick, else what the bot wears.
  const selected = pick?.kind === 'preset' ? pick.idx
    : pick?.kind === 'custom' ? 'own'
      : (currentPresetIdx ?? 'own');

  const nameChanged = botName.trim() !== (branding?.botName || branding?.botDisplayName || '').trim();

  // The name and the picture are two separate writes, so say which one failed
  // rather than showing one error for both — and only write what the user
  // actually touched.
  const save = async () => {
    setBusy(true); setError(null); setSaved(false);

    const writes = [];
    if (nameChanged) {
      writes.push(['name', () => apiWrite('/api/branding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botName: botName.trim() }),
      })]);
    }
    if (pick?.kind === 'preset') {
      writes.push(['picture', () => apiWrite('/api/setup/avatar/preset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset: PRESET_AVATARS[pick.idx].id }),
      })]);
    } else if (pick?.kind === 'custom') {
      writes.push(['picture', () => {
        const fd = new FormData();
        fd.append('avatar', pick.file);
        // No Content-Type header — the browser has to set the multipart boundary.
        return apiWrite('/api/branding/avatar', { method: 'POST', body: fd });
      }]);
    }

    for (const [what, run] of writes) {
      const r = await run();
      if (!r.ok) {
        setError(writes.length > 1 ? `Couldn't save the ${what}: ${r.error}` : r.error);
        setBusy(false);
        return;
      }
    }

    await branding?.reload?.();
    setSaved(true); setBusy(false);
    setTimeout(() => { setSaved(false); onClose(); }, 1000);
  };

  return (
    <ModalShell onClose={onClose} ariaLabel="Bot settings">
      <div className="w-full max-w-md overflow-hidden modal-panel" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <h2 className="text-[14px] font-semibold text-foreground/90">Bot</h2>
          </div>
          <button type="button" onClick={onClose} className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground/85">
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex flex-col gap-6 px-5 py-6">
          <label className="flex flex-col gap-1.5">
            <span className={labelCls}>Name</span>
            <input type="text" value={botName}
              onChange={(e) => setBotName(e.target.value.replace(/[^a-zA-Z0-9 _-]/g, ''))}
              placeholder="ava · max · sol" spellCheck={false} autoComplete="off"
              className={inputCls} />
          </label>

          {/* Avatar — every option on screen at once, because a carousel hides
              fifteen of sixteen choices behind arrows and gives no way to tell
              whether the bot is even wearing a preset. */}
          <div className="flex flex-col gap-2.5">
            <span className={labelCls}>Picture</span>

            <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="hidden"
              onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />

            <div className="grid grid-cols-6 gap-2">
              {/* Your own picture comes first — the presets are the fallback,
                  not the starting point. */}
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                title="Upload a picture"
                aria-label="Upload a picture"
                className={cn(
                  'flex aspect-square items-center justify-center rounded-[6px] border border-dashed transition-all duration-150',
                  'border-border text-muted-foreground/55 hover:border-foreground/30 hover:bg-muted/40 hover:text-foreground/70',
                )}
              >
                <Upload className="size-3.5" strokeWidth={2} />
              </button>

              {/* The bot's own picture, when it isn't one of the presets: an
                  upload, either already saved or chosen a moment ago. */}
              {ownPictureUrl && (
                <AvatarTile
                  src={ownPictureUrl}
                  selected={selected === 'own'}
                  onClick={() => setPick(pickedFile ? pick : null)}
                  label="Your picture"
                />
              )}

              {PRESET_AVATARS.map((a, i) => (
                <AvatarTile
                  key={a.id}
                  src={a.url}
                  selected={selected === i}
                  onClick={() => setPick({ kind: 'preset', idx: i })}
                  label={`Picture ${i + 1}`}
                  halftone
                />
              ))}

            </div>

            <span className="text-[11px] text-muted-foreground/60">
              {pickedFile
                ? `${pickedFile.name} — saved when you press Save.`
                : 'PNG or JPEG, up to 2 MiB.'}
            </span>
          </div>

          {error && <ErrorRow>{error}</ErrorRow>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/40 bg-muted/20 px-5 py-3">
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded-[6px] px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90 disabled:opacity-50">
            Cancel
          </button>
          {canEdit ? (
            <button type="button" onClick={save} disabled={busy || !botName.trim()}
              className="inline-flex items-center gap-1.5 rounded-[6px] bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:bg-foreground/85 disabled:opacity-50">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : saved ? <Check className="size-3.5" strokeWidth={2.5} />
                : null}
              {busy ? 'Saving…' : saved ? 'Saved' : 'Save'}
            </button>
          ) : <ReadOnlyNote />}
        </div>
      </div>
    </ModalShell>
  );
}

/* ─── Instructions modal ────────────────────────────────────────────────── */

function InstructionsModal({ fileEventNonce, onClose, canEdit = true }) {
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
        className="flex w-full max-w-2xl flex-col overflow-hidden modal-panel"
        style={{ height: '70vh' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <div>
              <h2 className="text-[14px] font-semibold text-foreground/90">Instructions</h2>
              <div className="font-mono text-[11px] text-muted-foreground/55">{path}</div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {dirty && <span className="text-[11.5px] text-muted-foreground/55">Unsaved</span>}
            <button type="button" onClick={onClose} className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground/85">
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
              className="rounded-[6px] px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90">
              Close
            </button>
            {canEdit ? (
              <button type="button" onClick={save} disabled={!dirty || saving}
                className="inline-flex items-center gap-1.5 rounded-[6px] bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:bg-foreground/85 disabled:opacity-50">
                {saving ? <Loader2 className="size-3.5 animate-spin" />
                : null}
                {saving ? 'Saving…' : 'Save'}
              </button>
            ) : <ReadOnlyNote />}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

/* ─── Claude token modal ────────────────────────────────────────────────── */

function ClaudeModal({ initialStatus, onClose, canEdit = true }) {
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
      <div className="w-full max-w-md overflow-hidden modal-panel" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <h2 className="text-[14px] font-semibold text-foreground/90">Claude</h2>
          </div>
          <button type="button" onClick={onClose} className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground/85">
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>

        {showView ? (
          /* ─── ACTIVE VIEW: status card + Replace/Remove ─── */
          <div className="flex flex-col gap-4 px-5 py-5">
            <div className="flex items-center gap-3 rounded-[6px] border border-emerald-500/25 bg-emerald-500/[0.06] px-4 py-3">
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
              <div className="flex items-center gap-2 rounded-[6px] border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[12.5px] text-amber-700 dark:text-amber-400">
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
            {canEdit ? (
              <button type="button" onClick={remove} disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-[12.5px] font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50">
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" strokeWidth={2} />}
                Remove
              </button>
            ) : <ReadOnlyNote />}
            <div className="flex items-center gap-2">
              <button type="button" onClick={onClose}
                className="rounded-[6px] px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90">
                Close
              </button>
              {canEdit && (
                <button type="button" onClick={() => setMode('edit')}
                  className="inline-flex items-center gap-1.5 rounded-[6px] bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:bg-foreground/85">
                  Replace
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2 border-t border-border/40 bg-muted/20 px-5 py-3">
            <button type="button" onClick={isActive ? () => setMode('view') : onClose}
              className="rounded-[6px] px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90">
              Cancel
            </button>
            {canEdit ? (
              <button type="button" onClick={save} disabled={busy || !token.trim()}
                className="inline-flex items-center gap-1.5 rounded-[6px] bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:bg-foreground/85 disabled:opacity-50">
                {phase === 'saving' || phase === 'restarting'
                  ? <Loader2 className="size-3.5 animate-spin" />
                  : phase === 'done'
                    ? <Check className="size-3.5" strokeWidth={2.5} />
                : null}
                {phase === 'saving'
                  ? 'Saving…'
                  : phase === 'restarting'
                    ? 'Restarting bot…'
                    : phase === 'done'
                      ? (restartFailed ? 'Saved' : 'Done')
                      : 'Save'}
              </button>
            ) : <ReadOnlyNote />}
          </div>
        )}
      </div>
    </ModalShell>
  );
}

/* ─── Shared ─────────────────────────────────────────────────────────────── */

function ErrorRow({ children }) {
  return (
    <div className="flex items-start gap-2 rounded-[6px] border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
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
