import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Loader2, ArrowRight, ArrowLeft, Check, AlertTriangle,
  Wand2, Upload, Building2, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBranding } from './workspace/identity';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const PRESET_AVATARS = Array.from({ length: 16 }, (_, i) => ({
  id: String(i + 1),
  url: `${BASE}/avatars/${i + 1}.png`,
}));

const PERSONALITY_AXES = [
  { key: 'warmth',      labelLow: 'Cool',     labelHigh: 'Warm',      hint: 'Pleasantries vs. directness' },
  { key: 'brevity',     labelLow: 'Verbose',  labelHigh: 'Terse',     hint: 'Depth vs. concision' },
  { key: 'formality',   labelLow: 'Casual',   labelHigh: 'Formal',    hint: 'Banter vs. boardroom' },
  { key: 'proactivity', labelLow: 'Reactive', labelHigh: 'Proactive', hint: 'Wait vs. surface ideas' },
  { key: 'humor',       labelLow: 'Dry',      labelHigh: 'Playful',   hint: 'Precise vs. light' },
];

const DEFAULT_PERSONALITY = {
  warmth: 60, brevity: 65, formality: 45, proactivity: 55, humor: 40,
};

export default function SetupWizard({ status, onComplete, mock = false }) {
  const { reload: reloadBranding } = useBranding();

  const initialStep = (() => {
    if (status?.missing?.includes('title'))       return 1;
    if (status?.missing?.includes('botName'))     return 2;
    if (status?.missing?.includes('claudeToken')) return 4;
    return 5;
  })();

  const [step, setStep]   = useState(initialStep);
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);

  const [title, setTitle]                             = useState(() => firstSet(status?.state?.title, ''));
  const [orgLogo, setOrgLogo]                         = useState(null);
  const [orgLogoPreview, setOrgLogoPreview]           = useState(null);
  const [botName, setBotName]                         = useState(() => firstSet(status?.state?.botName, ''));
  const [avatarIdx, setAvatarIdx]                     = useState(0);
  const [backstory, setBackstory]                     = useState('');
  const [personality, setPersonality]                 = useState(DEFAULT_PERSONALITY);
  const [token, setToken]                             = useState('');

  const fakeDelay = () => new Promise(r => setTimeout(r, 220));

  const refreshStatus = useCallback(async () => {
    if (mock) return { complete: true, missing: [], state: {} };
    const resp = await fetch('/api/setup/status');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }, [mock]);

  async function post(url, body) {
    setBusy(true); setError(null);
    try {
      if (mock) { await fakeDelay(); return { ok: true }; }
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      return data;
    } finally { setBusy(false); }
  }

  async function uploadFile(url, file) {
    setBusy(true); setError(null);
    try {
      if (mock) { await fakeDelay(); return { ok: true }; }
      const fd = new FormData();
      fd.append('avatar', file);
      const resp = await fetch(url, { method: 'POST', body: fd });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      return data;
    } finally { setBusy(false); }
  }

  async function nextFromStep1() {
    try {
      await post('/api/setup/branding', { title: title.trim() });
      if (orgLogo) await uploadFile('/api/setup/logo', orgLogo);
      reloadBranding(); setStep(2);
    } catch (err) { setError(err.message); }
  }

  async function nextFromStep2() {
    setStep(3);
  }

  async function nextFromStep3() {
    try {
      await post('/api/setup/branding', { botName: botName.trim(), backstory: backstory.trim(), personality });
      await post('/api/setup/avatar/preset', { preset: PRESET_AVATARS[avatarIdx].id });
      reloadBranding(); setStep(4);
    } catch (err) { setError(err.message); }
  }

  async function nextFromStep4() {
    if (!token.trim()) { setError('Paste the token from `claude setup-token`.'); return; }
    try {
      await post('/api/setup/token', { token: token.trim() });
      const s = await refreshStatus();
      if (s.complete) setStep(5);
      else setError(`Saved, but still missing: ${s.missing.join(', ')}.`);
    } catch (err) { setError(err.message); }
  }

  function pickFile(file, setFile, setPreview) {
    if (!file) { setFile(null); setPreview(null); return; }
    if (file.size > 2 * 1024 * 1024) { setError('File must be smaller than 2 MiB.'); return; }
    if (!/^image\/(png|jpe?g)$/i.test(file.type)) { setError('Must be a PNG or JPEG.'); return; }
    setError(null); setFile(file); setPreview(URL.createObjectURL(file));
  }

  // Revoke the logo preview's object URL when it's replaced or the wizard
  // unmounts — otherwise each re-pick (and the final preview) leaks a blob
  // until the page unloads. Cleanup runs with the prior value on every change.
  useEffect(() => {
    if (!orgLogoPreview || !orgLogoPreview.startsWith('blob:')) return undefined;
    return () => URL.revokeObjectURL(orgLogoPreview);
  }, [orgLogoPreview]);

  const activeAvatarUrl = PRESET_AVATARS[avatarIdx].url;

  return (
    <div
      className="flex h-screen w-screen items-center justify-center overflow-hidden bg-background p-8 text-foreground"
      style={{ fontFamily: '"Geist Variable","Geist",-apple-system,BlinkMacSystemFont,system-ui,sans-serif' }}
    >
      <div aria-hidden className="pointer-events-none fixed inset-0">
        <div className="absolute -top-48 left-1/3 size-[700px] rounded-full bg-[radial-gradient(closest-side,rgba(217,119,6,0.08),transparent_70%)]" />
      </div>

      <div className="relative w-[580px]">
        {step === 1 && (
          <Step1
            title={title} setTitle={setTitle}
            orgLogoPreview={orgLogoPreview}
            onPickLogo={(f) => pickFile(f, setOrgLogo, setOrgLogoPreview)}
            onNext={nextFromStep1} busy={busy} error={error}
            canNext={!!title.trim()}
          />
        )}
        {step === 2 && (
          <Step2Avatar
            botName={botName} setBotName={setBotName}
            avatarIdx={avatarIdx} setAvatarIdx={setAvatarIdx}
            activeAvatarUrl={activeAvatarUrl}
            onBack={() => setStep(1)} onNext={nextFromStep2} busy={busy} error={error}
            canNext={!!botName.trim()}
          />
        )}
        {step === 3 && (
          <Step3Character
            botName={botName} activeAvatarUrl={activeAvatarUrl}
            backstory={backstory} setBackstory={setBackstory}
            personality={personality} setPersonality={setPersonality}
            onBack={() => setStep(2)} onNext={nextFromStep3} busy={busy} error={error}
          />
        )}
        {step === 4 && (
          <Step4Token
            token={token} setToken={setToken}
            onBack={() => setStep(3)} onNext={nextFromStep4} busy={busy} error={error}
            canNext={!!token.trim()}
          />
        )}
        {step === 5 && (
          <Step5Done
            botName={botName} avatarUrl={activeAvatarUrl}
            orgLogoPreview={orgLogoPreview} title={title}
            onBack={() => setStep(4)}
            onDismiss={() => onComplete?.()}
          />
        )}
      </div>
    </div>
  );
}

// ─── Shared primitives ────────────────────────────────────────────────────────

function ErrorBanner({ error }) {
  if (!error) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-[12px] text-destructive">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
      <span>{error}</span>
    </div>
  );
}

function NavRow({ onBack, onNext, nextLabel = 'Continue', busy, canNext = true }) {
  return (
    <div className={cn('flex items-center gap-3', onBack ? 'justify-between' : 'justify-end')}>
      {onBack && (
        <button type="button" onClick={onBack} disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors"
        >
          <ArrowLeft className="size-3.5" strokeWidth={2} /> Back
        </button>
      )}
      <button type="button" onClick={onNext} disabled={busy || !canNext}
        className="inline-flex items-center gap-2 rounded-lg bg-foreground px-5 py-2.5 text-[13px] font-semibold text-background shadow-[0_1px_2px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.06)] transition-all hover:bg-foreground/90 active:scale-[0.99] disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {nextLabel}
        {!busy && <ArrowRight className="size-3.5" strokeWidth={2.25} />}
      </button>
    </div>
  );
}

function Card({ children }) {
  return (
    <div className="flex h-[580px] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-[0_2px_4px_rgba(0,0,0,0.04),0_24px_60px_-20px_rgba(28,27,24,0.16)]">
      {children}
    </div>
  );
}

function StepHeader({ stepLabel, title, subtitle }) {
  return (
    <div className="border-b border-border/60 bg-gradient-to-b from-muted/40 to-card px-8 py-7">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[--color-ring]">{stepLabel}</div>
      <h1 className="mt-2 text-[26px] font-semibold tracking-[-0.02em] text-foreground">{title}</h1>
      {subtitle && <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">{subtitle}</p>}
    </div>
  );
}

const inputCls = cn(
  'w-full rounded-xl border border-border bg-card px-3.5 py-2.5 text-[14px] text-foreground outline-none',
  'placeholder:text-muted-foreground/45 transition-all',
  'focus:border-[--color-ring]/50 focus:ring-2 focus:ring-[--color-ring]/12',
);

const labelCls = 'text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground';

const LOGO_GRADIENTS = [
  'from-yellow-200 to-amber-300',
  'from-amber-200 to-orange-300',
  'from-orange-200 to-amber-300',
  'from-yellow-200 to-orange-300',
  'from-amber-300 to-yellow-300',
];

function WorkspaceLogoOrInitial({ src, initial, size = 'md' }) {
  const gradientIdx = (initial?.charCodeAt(0) || 0) % LOGO_GRADIENTS.length;
  const gradient = LOGO_GRADIENTS[gradientIdx];
  const sm = size === 'sm';
  return (
    <div className={cn(
      'flex shrink-0 items-center justify-center overflow-hidden border border-border/60',
      sm ? 'size-9 rounded-lg' : 'size-16 rounded-xl shadow-sm border-border',
      src ? 'bg-card' : `bg-gradient-to-br ${gradient}`,
    )}>
      {src
        ? <img src={src} alt="" className="size-full object-contain p-1" />
        : <span className={cn('font-semibold text-foreground/60 select-none', sm ? 'text-[14px]' : 'text-[22px]')}>{initial}</span>
      }
    </div>
  );
}

// ─── Step 1: Workspace ────────────────────────────────────────────────────────

function Step1({ title, setTitle, orgLogoPreview, onPickLogo, onNext, busy, error, canNext }) {
  const logoInputRef = useRef(null);
  return (
    <Card>
      <StepHeader stepLabel="Step 1 of 4" title="Name your workspace"
        subtitle="Shown in the sidebar and browser tab. Change it any time from Settings." />
      <div className="flex-1 overflow-y-auto px-8 py-7">
        <div className="flex flex-col gap-6">
          <label className="flex flex-col gap-2">
            <span className={labelCls}>Workspace name</span>
            <input type="text" value={title} autoFocus
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && canNext && onNext()}
              placeholder="Acme · Globex · Initech"
              spellCheck={false} autoComplete="off" className={inputCls} />
          </label>
          <div className="flex flex-col gap-2">
            <span className={labelCls}>Organisation logo</span>
            <div onClick={() => logoInputRef.current?.click()}
              className={cn('group flex cursor-pointer items-center gap-3 rounded-xl border border-dashed px-4 py-3.5 transition-all',
                orgLogoPreview ? 'border-[--color-ring]/50 bg-[--color-ring]/5' : 'border-border hover:border-foreground/25 hover:bg-muted/50')}>
              {orgLogoPreview ? (
                <>
                  <img src={orgLogoPreview} alt="" className="size-10 rounded-lg object-contain" />
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[13px] font-medium text-foreground">Logo uploaded</span>
                    <button type="button" className="text-left text-[11.5px] text-[--color-ring] hover:underline"
                      onClick={(e) => { e.stopPropagation(); onPickLogo(null); }}>Remove</button>
                  </div>
                  <Check className="ml-auto size-4 text-[--color-ring]" strokeWidth={2.5} />
                </>
              ) : (
                <>
                  <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-muted/50">
                    <Building2 className="size-4 text-muted-foreground" strokeWidth={1.75} />
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[13px] font-medium text-muted-foreground group-hover:text-foreground transition-colors">Upload logo</span>
                    <span className="text-[11.5px] text-muted-foreground/55">PNG or JPEG, up to 2 MiB</span>
                  </div>
                  <Upload className="ml-auto size-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" strokeWidth={1.75} />
                </>
              )}
              <input ref={logoInputRef} type="file" accept="image/png,image/jpeg" className="hidden"
                onChange={(e) => onPickLogo(e.target.files?.[0] || null)} />
            </div>
          </div>
          <ErrorBanner error={error} />
        </div>
      </div>
      <div className="shrink-0 border-t border-border/60 px-8 py-5">
        <NavRow onNext={onNext} busy={busy} canNext={canNext} />
      </div>
    </Card>
  );
}

// ─── Step 2: Avatar & Name ────────────────────────────────────────────────────

function Step2Avatar({ botName, setBotName, avatarIdx, setAvatarIdx, activeAvatarUrl, onBack, onNext, busy, error, canNext }) {
  const total = PRESET_AVATARS.length;
  return (
    <Card>
      <StepHeader stepLabel="Step 2 of 4" title="Choose an avatar"
        subtitle="This is what your team sees in the chat header." />
      <div className="flex-1 overflow-y-auto px-8 py-7">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col items-center gap-4">
            <div className="flex items-center gap-6">
              <button type="button" onClick={() => setAvatarIdx((avatarIdx - 1 + total) % total)}
                className="flex size-9 items-center justify-center rounded-full border border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
                <ChevronLeft className="size-4" strokeWidth={2} />
              </button>
              <div className="size-32 overflow-hidden rounded-2xl ring-2 ring-border shadow-[0_4px_20px_rgba(0,0,0,0.10)]">
                <img src={activeAvatarUrl} alt="" className="size-full object-cover" />
              </div>
              <button type="button" onClick={() => setAvatarIdx((avatarIdx + 1) % total)}
                className="flex size-9 items-center justify-center rounded-full border border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
                <ChevronRight className="size-4" strokeWidth={2} />
              </button>
            </div>
            <p className="text-[12px] text-muted-foreground">{avatarIdx + 1} / {total}</p>
          </div>
          <label className="flex flex-col gap-2">
            <span className={labelCls}>Assistant name</span>
            <input type="text" value={botName}
              onChange={(e) => setBotName(e.target.value.replace(/[^a-zA-Z0-9 _-]/g, ''))}
              placeholder="aria · atlas · luna" spellCheck={false} autoComplete="off" className={inputCls} />
            <p className="text-[11.5px] text-muted-foreground/70">
              {botName ? `Shows as "${botName}" in the chat header.` : 'Letters, digits, spaces, dashes allowed.'}
            </p>
          </label>
          <ErrorBanner error={error} />
        </div>
      </div>
      <div className="shrink-0 border-t border-border/60 px-8 py-5">
        <NavRow onBack={onBack} onNext={onNext} busy={busy} canNext={canNext} />
      </div>
    </Card>
  );
}

// ─── Step 3: Character ────────────────────────────────────────────────────────

function Step3Character({ botName, backstory, setBackstory, personality, setPersonality, onBack, onNext, busy, error }) {
  const examples = [
    `${botName || 'Assistant'} is a research analyst: precise, allergic to fluff.`,
    `${botName || 'Assistant'} runs marketing ops. Speaks plainly, surfaces tradeoffs.`,
    `${botName || 'Assistant'} is a senior engineer. Skeptical, exact, pushes back.`,
  ];
  const [idx, setIdx] = useState(0);
  return (
    <Card>
      <StepHeader stepLabel="Step 3 of 4" title="Define their character"
        subtitle="Write a brief backstory and tune the personality. We'll turn this into a system prompt." />
      <div className="flex-1 overflow-y-auto px-8 py-7">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <span className={labelCls}>Backstory</span>
              <button type="button" onClick={() => setIdx((idx + 1) % examples.length)}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-[--color-ring] hover:text-[--color-ring]/80">
                <Wand2 className="size-3" strokeWidth={2} /> See an example
              </button>
            </div>
            <textarea value={backstory} onChange={(e) => setBackstory(e.target.value)}
              rows={3} maxLength={2000} placeholder={examples[idx]}
              className={cn(inputCls, 'resize-none leading-relaxed')} />
            <div className="flex justify-between">
              <p className="text-[11.5px] text-muted-foreground/70">A sentence or two, we'll write the assistant's brief.</p>
              <span className="text-[10.5px] tabular-nums text-muted-foreground/50">{backstory.length}/2000</span>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className={labelCls}>Personality</span>
            <div className="overflow-hidden rounded-xl border border-border divide-y divide-border/60">
              {PERSONALITY_AXES.map(axis => (
                <SliderRow key={axis.key} axis={axis} value={personality[axis.key]}
                  onChange={(v) => setPersonality(p => ({ ...p, [axis.key]: v }))} />
              ))}
            </div>
          </div>
          <ErrorBanner error={error} />
        </div>
      </div>
      <div className="shrink-0 border-t border-border/60 px-8 py-5">
        <NavRow onBack={onBack} onNext={onNext} busy={busy} />
      </div>
    </Card>
  );
}

function SliderRow({ axis, value, onChange }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="flex items-center gap-3 bg-card px-4 py-3">
      <span className="w-[80px] shrink-0 text-[12px] font-medium capitalize text-foreground/80">{axis.key}</span>
      <span className="w-12 shrink-0 text-right text-[10px] text-muted-foreground/55">{axis.labelLow}</span>
      <input type="range" min={0} max={100} step={1} value={pct}
        onChange={(e) => onChange(Number(e.target.value))}
        className="personality-slider flex-1" style={{ '--pct': `${pct}%` }} />
      <span className="w-12 shrink-0 text-[10px] text-muted-foreground/55">{axis.labelHigh}</span>
      <span className="w-6 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground/50">{pct}</span>
    </div>
  );
}

// ─── Step 4: Claude token ─────────────────────────────────────────────────────

function Step4Token({ token, setToken, onBack, onNext, busy, error, canNext }) {
  return (
    <Card>
      <StepHeader stepLabel="Step 4 of 4" title="Connect Claude"
        subtitle="Paste the OAuth token from Claude Code. It's stored encrypted on your server and never leaves it." />
      <div className="flex-1 overflow-y-auto px-8 py-7">
        <div className="flex flex-col gap-5">
          <label className="flex flex-col gap-2">
            <span className={labelCls}>OAuth token</span>
            <input type="password" value={token} autoFocus
              onChange={(e) => setToken(e.target.value)}
              placeholder="sk-ant-oat01-…" spellCheck={false} autoComplete="off"
              className={cn(inputCls, 'font-mono')} />
            <p className="text-[11.5px] text-muted-foreground/70">Stored encrypted. Never leaves your server.</p>
          </label>
          <div className="flex flex-col gap-1.5">
            <span className={labelCls}>How to get the token</span>
            <ol className="flex flex-col gap-0">
              <li className="flex items-start gap-3 py-2.5">
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-border text-[9px] font-semibold text-muted-foreground">1</span>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[13px] leading-relaxed text-muted-foreground">Open a terminal on your computer and run:</span>
                  <div className="rounded-lg border border-border bg-muted px-3 py-2">
                    <code className="font-mono text-[12.5px] tracking-tight text-foreground select-all">claude setup-token</code>
                  </div>
                  <span className="text-[11.5px] text-muted-foreground/60">No Claude Code yet? <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10.5px]">npm i -g @anthropic-ai/claude-code</code></span>
                </div>
              </li>
              <li className="flex items-start gap-3 py-2.5">
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-border text-[9px] font-semibold text-muted-foreground">2</span>
                <span className="text-[13px] leading-relaxed text-muted-foreground">A browser window opens: sign in with your Anthropic account.</span>
              </li>
              <li className="flex items-start gap-3 py-2.5">
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-border text-[9px] font-semibold text-muted-foreground">3</span>
                <span className="text-[13px] leading-relaxed text-muted-foreground">The terminal prints a token starting with <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10.5px]">sk-ant-oat01-</code>, paste it above.</span>
              </li>
            </ol>
          </div>
          <ErrorBanner error={error} />
        </div>
      </div>
      <div className="shrink-0 border-t border-border/60 px-8 py-5">
        <NavRow onBack={onBack} onNext={onNext} nextLabel={busy ? 'Saving…' : 'Finish setup'} busy={busy} canNext={canNext} />
      </div>
    </Card>
  );
}

// ─── Step 5: Done ─────────────────────────────────────────────────────────────

function Step5Done({ botName, avatarUrl, orgLogoPreview, title, onBack, onDismiss }) {
  return (
    <Card>
      <div className="shrink-0 border-b border-border/60 bg-gradient-to-b from-muted/40 to-card px-8 py-7">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[--color-ring]">All set</div>
        <h1 className="mt-2 text-[26px] font-semibold tracking-[-0.02em] text-foreground">
          {title || 'Your workspace'} is ready.
        </h1>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">
          {botName || 'Your assistant'} has their brief and is waiting in chat.
        </p>
      </div>

      <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-8 py-7">
        <div className="flex items-center gap-3">
          {/* Workspace */}
          <div className="flex items-center gap-2.5 rounded-xl border border-border/70 bg-muted/20 px-3.5 py-2.5">
            <WorkspaceLogoOrInitial src={orgLogoPreview} initial={(title || 'W').charAt(0).toUpperCase()} size="sm" />
            <div className="flex flex-col gap-0">
              <span className="text-[12.5px] font-medium text-foreground leading-tight">{title || 'Workspace'}</span>
              <span className="text-[10px] text-muted-foreground/50 uppercase tracking-[0.09em]">Workspace</span>
            </div>
          </div>

          {/* Connector */}
          <div className="flex shrink-0 items-center gap-1">
            <div className="h-px w-4 bg-foreground/25" />
            <div className="size-1.5 rounded-full bg-foreground/25" />
            <div className="h-px w-4 bg-foreground/25" />
          </div>

          {/* Assistant */}
          <div className="flex items-center gap-2.5 rounded-xl border border-border/70 bg-muted/20 px-3.5 py-2.5">
            <div className="size-9 shrink-0 overflow-hidden rounded-lg border border-border/60 bg-muted">
              <img src={avatarUrl} alt="" className="size-full object-cover" />
            </div>
            <div className="flex flex-col gap-0">
              <span className="text-[12.5px] font-medium text-foreground leading-tight">{botName || 'Assistant'}</span>
              <span className="text-[10px] text-muted-foreground/50 uppercase tracking-[0.09em]">Assistant</span>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {[
            { label: 'Workspace name', value: title || '—' },
            { label: 'Claude token', value: 'Saved & encrypted' },
            { label: 'Personality', value: 'Configured' },
          ].map(({ label, value }) => (
            <div key={label} className="flex items-center justify-between py-1.5 border-b border-border/40 last:border-0">
              <span className="text-[12.5px] text-muted-foreground">{label}</span>
              <div className="flex items-center gap-1.5">
                <Check className="size-3 text-[--color-ring]" strokeWidth={2.5} />
                <span className="text-[12.5px] font-medium text-foreground">{value}</span>
              </div>
            </div>
          ))}
        </div>

        <p className="text-[11.5px] text-muted-foreground/60">You can adjust branding, avatar and skills anytime from Settings.</p>
      </div>

      <div className="shrink-0 border-t border-border/60 px-8 py-5">
        <NavRow onBack={onBack} onNext={onDismiss} nextLabel="Open workspace" />
      </div>
    </Card>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function firstSet(value, fallback) {
  if (typeof value === 'string' && value.trim() && value !== 'Workspace' && value !== 'assistant') return value;
  return fallback;
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
