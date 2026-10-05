import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Loader2, ArrowRight, ArrowLeft, Check, AlertTriangle,
  Wand2, Upload, Building2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBranding } from './workspace/identity';
import TileBanner from './workspace/views/TileBanner.jsx';
import AvatarTile, { PRESET_AVATARS } from './workspace/views/AvatarTile.jsx';



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
  // A picture of their own instead of a preset: { file, url } (object URL).
  const [customAvatar, setCustomAvatar]               = useState(null);
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
      if (customAvatar) await uploadFile('/api/setup/avatar', customAvatar.file);
      else await post('/api/setup/avatar/preset', { preset: PRESET_AVATARS[avatarIdx].id });
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

  // Revoke the custom picture's object URL when it's replaced or dropped.
  useEffect(() => () => { if (customAvatar) URL.revokeObjectURL(customAvatar.url); }, [customAvatar]);

  function pickAvatarFile(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setError('File must be smaller than 2 MiB.'); return; }
    if (!/^image\/(png|jpe?g)$/i.test(file.type)) { setError('Must be a PNG or JPEG.'); return; }
    setError(null);
    setCustomAvatar({ file, url: URL.createObjectURL(file) });
  }

  const activeAvatarUrl = customAvatar ? customAvatar.url : PRESET_AVATARS[avatarIdx].url;

  return (
    <div
      className="flex h-screen w-screen items-center justify-center overflow-hidden bg-background p-8 text-foreground"
      style={{ fontFamily: '"Geist Variable","Geist",-apple-system,BlinkMacSystemFont,system-ui,sans-serif' }}
    >
      <div className="relative w-[860px] max-w-full">
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
            avatarIdx={avatarIdx}
            onPickPreset={(i) => { setAvatarIdx(i); setCustomAvatar(null); }}
            customAvatar={customAvatar} onPickFile={pickAvatarFile}
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
    <div className="flex items-start gap-2 rounded-[6px] border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-[12px] text-destructive">
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
          className="inline-flex items-center gap-1.5 rounded-[6px] px-3 py-2 text-[12.5px] font-medium text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-50 transition-colors"
        >
          <ArrowLeft className="size-3.5" strokeWidth={2} /> Back
        </button>
      )}
      <button type="button" onClick={onNext} disabled={busy || !canNext}
        className="inline-flex items-center gap-2 rounded-[6px] bg-foreground px-4 py-2 text-[13px] font-medium text-background transition-all hover:bg-foreground/90 active:scale-[0.99] disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {nextLabel}
        {!busy && <ArrowRight className="size-3.5" strokeWidth={2.25} />}
      </button>
    </div>
  );
}

// The same tile family as the sign-in page (6px, hairline, no drop shadow),
// laid out wide: a soft halftone banner down the left (the sign-in wave;
// rings once it's done), the step on the right. Fixed height, so the steps
// don't jump; the side banner keeps short steps from looking empty.
function Card({ children, banner = 'wave' }) {
  return (
    <div className="flex h-[540px] overflow-hidden rounded-[6px] border border-border/60 bg-card">
      <TileBanner abstract={banner} seed="setup" soft className="!h-full w-[240px] shrink-0 border-r border-border/60 max-md:hidden" />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

// The step as four short bars, the title and one line of context.
function StepHeader({ step, title, subtitle }) {
  return (
    <div className="shrink-0">
      <div className="px-8 pb-5 pt-7">
        {step ? (
          <div className="flex items-center gap-2.5">
            <div className="flex gap-1" aria-hidden>
              {[1, 2, 3, 4].map((n) => (
                <span key={n} className={cn('h-[3px] w-5 rounded-full', n <= step ? 'bg-foreground/75' : 'bg-foreground/[0.12]')} />
              ))}
            </div>
            <span className="text-[12px] text-muted-foreground/75">Step {step} of 4</span>
          </div>
        ) : (
          <div className="text-[12px] text-muted-foreground/75">All set</div>
        )}
        <h1 className="mt-2.5 text-[20px] font-semibold tracking-[-0.015em] text-foreground/90">{title}</h1>
        {subtitle && <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground/80">{subtitle}</p>}
      </div>
    </div>
  );
}

const inputCls = cn(
  'w-full rounded-[6px] border border-border/60 bg-card px-3 py-2 text-[13.5px] text-foreground outline-none',
  'placeholder:text-muted-foreground/45 transition-colors',
  'focus:border-foreground/35',
);

const labelCls = 'text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground/75';

function WorkspaceLogoOrInitial({ src, initial, size = 'md' }) {
  const sm = size === 'sm';
  return (
    <div className={cn(
      'flex shrink-0 items-center justify-center overflow-hidden rounded-[6px] bg-[#f1efea] ring-1 ring-foreground/10 dark:bg-[#2a2826]',
      sm ? 'size-9' : 'size-16',
    )}>
      {src
        ? <img src={src} alt="" className="size-full bg-card object-contain p-1" />
        : <span className={cn('select-none font-medium text-foreground/80', sm ? 'text-[14px]' : 'text-[22px]')}>{initial}</span>
      }
    </div>
  );
}

// ─── Step 1: Workspace ────────────────────────────────────────────────────────

function Step1({ title, setTitle, orgLogoPreview, onPickLogo, onNext, busy, error, canNext }) {
  const logoInputRef = useRef(null);
  return (
    <Card>
      <StepHeader step={1} title="Name your workspace"
        subtitle="Shown in the sidebar and browser tab. Change it any time from Settings." />
      <div className="flex-1 overflow-y-auto px-8 pb-6 pt-1">
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
              className={cn('group flex cursor-pointer items-center gap-3 rounded-[6px] border px-3.5 py-3 transition-colors',
                orgLogoPreview ? 'border-border/60' : 'border-dashed border-border/80 hover:border-foreground/30')}>
              {orgLogoPreview ? (
                <>
                  <img src={orgLogoPreview} alt="" className="size-10 rounded-[6px] object-contain ring-1 ring-foreground/10" />
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[13px] font-medium text-foreground">Logo uploaded</span>
                    <button type="button" className="text-left text-[11.5px] text-muted-foreground/80 hover:text-foreground hover:underline"
                      onClick={(e) => { e.stopPropagation(); onPickLogo(null); }}>Remove</button>
                  </div>
                  <Check className="ml-auto size-4 text-foreground/70" strokeWidth={2.25} />
                </>
              ) : (
                <>
                  <div className="flex size-10 items-center justify-center rounded-[6px] bg-[#f1efea] ring-1 ring-foreground/10 dark:bg-[#2a2826]">
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
      <div className="shrink-0 border-t border-border/60 px-8 py-4">
        <NavRow onNext={onNext} busy={busy} canNext={canNext} />
      </div>
    </Card>
  );
}

// ─── Step 2: Avatar & Name ────────────────────────────────────────────────────

function Step2Avatar({ botName, setBotName, avatarIdx, onPickPreset, customAvatar, onPickFile, onBack, onNext, busy, error, canNext }) {
  const fileRef = useRef(null);
  return (
    <Card>
      <StepHeader step={2} title="Choose an avatar"
        subtitle="This is what your team sees in the chat header." />
      <div className="flex-1 overflow-y-auto px-8 pb-6 pt-1">
        <div className="flex flex-col gap-6">
          {/* Every picture at once, as in AI Settings: the presets, then your own at the end. */}
          <div className="flex flex-col gap-2.5">
            <span className={labelCls}>Picture</span>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="hidden"
              onChange={(e) => { onPickFile(e.target.files?.[0]); e.target.value = ''; }} />
            <div className="grid grid-cols-9 gap-2">
              {PRESET_AVATARS.map((a, i) => (
                <AvatarTile key={a.id} src={a.url} halftone label={`Picture ${i + 1}`}
                  selected={!customAvatar && avatarIdx === i}
                  onClick={() => onPickPreset(i)} />
              ))}
              {customAvatar && (
                <AvatarTile src={customAvatar.url} selected onClick={() => {}} label="Your picture" />
              )}
              <button type="button" onClick={() => fileRef.current?.click()}
                title="Upload a picture" aria-label="Upload a picture"
                className="flex aspect-square items-center justify-center rounded-[6px] border border-dashed border-border text-muted-foreground/55 transition-colors hover:border-foreground/30 hover:text-foreground/70">
                <Upload className="size-3.5" strokeWidth={2} />
              </button>
            </div>
            <span className="text-[11px] text-muted-foreground/60">
              {customAvatar ? customAvatar.file.name : 'Or upload your own: PNG or JPEG, up to 2 MiB.'}
            </span>
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
      <div className="shrink-0 border-t border-border/60 px-8 py-4">
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
      <StepHeader step={3} title="Define their character"
        subtitle="Write a brief backstory and tune the personality. We'll turn this into a system prompt." />
      <div className="flex-1 overflow-y-auto px-8 pb-6 pt-1">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <span className={labelCls}>Backstory</span>
              <button type="button" onClick={() => setIdx((idx + 1) % examples.length)}
                className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground/80 transition-colors hover:text-foreground">
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
            <div className="overflow-hidden rounded-[6px] border border-border/60 divide-y divide-border/60">
              {PERSONALITY_AXES.map(axis => (
                <SliderRow key={axis.key} axis={axis} value={personality[axis.key]}
                  onChange={(v) => setPersonality(p => ({ ...p, [axis.key]: v }))} />
              ))}
            </div>
          </div>
          <ErrorBanner error={error} />
        </div>
      </div>
      <div className="shrink-0 border-t border-border/60 px-8 py-4">
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
      <StepHeader step={4} title="Connect Claude"
        subtitle="Paste the OAuth token from Claude Code. It's stored encrypted on your server and never leaves it." />
      <div className="flex-1 overflow-y-auto px-8 pb-6 pt-1">
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
                  <div className="rounded-[6px] border border-border/60 bg-muted/50 px-3 py-2">
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
      <div className="shrink-0 border-t border-border/60 px-8 py-4">
        <NavRow onBack={onBack} onNext={onNext} nextLabel={busy ? 'Saving…' : 'Finish setup'} busy={busy} canNext={canNext} />
      </div>
    </Card>
  );
}

// ─── Step 5: Done ─────────────────────────────────────────────────────────────

function Step5Done({ botName, avatarUrl, orgLogoPreview, title, onBack, onDismiss }) {
  return (
    <Card banner="rings">
      <StepHeader title={`${title || 'Your workspace'} is ready.`}
        subtitle={`${botName || 'Your assistant'} has their brief and is waiting in chat.`} />

      <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-8 pb-6 pt-1">
        <div className="flex items-center gap-3">
          {/* Workspace */}
          <div className="flex items-center gap-2.5 rounded-[6px] border border-border/60 px-3 py-2">
            <WorkspaceLogoOrInitial src={orgLogoPreview} initial={(title || 'W').charAt(0).toUpperCase()} size="sm" />
            <div className="flex flex-col gap-0">
              <span className="text-[12.5px] font-medium text-foreground leading-tight">{title || 'Workspace'}</span>
              <span className="text-[11px] text-muted-foreground/60">Workspace</span>
            </div>
          </div>

          {/* Connector */}
          <div className="flex shrink-0 items-center gap-1">
            <div className="h-px w-4 bg-foreground/25" />
            <div className="size-1.5 rounded-full bg-foreground/25" />
            <div className="h-px w-4 bg-foreground/25" />
          </div>

          {/* Assistant */}
          <div className="flex items-center gap-2.5 rounded-[6px] border border-border/60 px-3 py-2">
            <div className="relative size-9 shrink-0 overflow-hidden rounded-full ring-1 ring-foreground/10">
              <TileBanner image={avatarUrl} mode="dark" center plain step={1.7} scale={1} seed="bot" paper className="!absolute inset-0 !h-full" />
            </div>
            <div className="flex flex-col gap-0">
              <span className="text-[12.5px] font-medium text-foreground leading-tight">{botName || 'Assistant'}</span>
              <span className="text-[11px] text-muted-foreground/60">Assistant</span>
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
                <Check className="size-3 text-foreground/70" strokeWidth={2.5} />
                <span className="text-[12.5px] font-medium text-foreground">{value}</span>
              </div>
            </div>
          ))}
        </div>

        <p className="text-[11.5px] text-muted-foreground/60">You can adjust branding, avatar and skills anytime from Settings.</p>
      </div>

      <div className="shrink-0 border-t border-border/60 px-8 py-4">
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
