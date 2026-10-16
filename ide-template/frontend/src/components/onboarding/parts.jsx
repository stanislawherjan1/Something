// The pieces onboarding is built from: found lines, the setting-up screen, the
// starter plan's rows, the team's connections. Data and actions come in as props;
// the screens (Onboarding.jsx) decide what to do with them.
import { createElement, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Pencil, X, ChevronDown, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Logo, logoUrl } from '../workspace/views/IntegrationsDashboard.jsx';
import { dutyIcon } from '../workspace/views/ResponsibilitiesDashboard.jsx';
import { labelCls } from '../SetupWizard.jsx';

export function IconBtn({ children, label, onClick }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick}
      className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground">
      {children}
    </button>
  );
}

export function SmallBtn({ children, primary, onClick, disabled }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
        primary ? 'bg-foreground text-background hover:bg-foreground/90' : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground')}>
      {children}
    </button>
  );
}

export function SectionTitle({ children, right }) {
  return (
    <div className="mb-1 mt-5 flex items-center justify-between first:mt-0">
      <span className={labelCls}>{children}</span>
      {right}
    </div>
  );
}

// Light tabs: text with a line under the one that's open. Sits on the header's line.
export function TextTabs({ value, onChange, items }) {
  return (
    <div role="tablist" className="flex gap-5">
      {items.map((it) => (
        <button key={it.id} type="button" role="tab" aria-selected={it.id === value} onClick={() => onChange(it.id)}
          className={cn('-mb-px border-b-[1.5px] pb-2 text-[13px] font-medium transition-colors',
            it.id === value ? 'border-foreground/80 text-foreground/90' : 'border-transparent text-muted-foreground/70 hover:text-foreground/85')}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

// Where a line came from: the site's favicon when we have it (the company's own,
// fetched with its pages), its initial otherwise; the address on hover.
export function SourceIcon({ url, favicon }) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { host = String(url || '').replace(/^https?:\/\//, '').split('/')[0]; }
  const hue = [...host].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <span className="group/src relative -top-px ml-1.5 inline-flex items-center align-middle">
      {favicon
        ? <img src={favicon} alt="" className="size-3 rounded-[3px] object-contain" />
        : <span className="flex size-3 items-center justify-center rounded-[3px] text-[7.5px] font-semibold uppercase leading-none text-white" style={{ background: `hsl(${hue} 30% 48%)` }}>{host[0]}</span>}
      <span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 hidden w-max max-w-[340px] -translate-x-1/2 rounded bg-popover px-2.5 py-1.5 text-[12px] font-normal leading-snug text-popover-foreground/90 shadow-md ring-1 ring-foreground/10 group-hover/src:block">{url}</span>
    </span>
  );
}

/**
 * A found line, as a plain sentence. Edit in place (nothing moves), remove.
 * `onChange(text)` / `onRemove()` report up, so what is confirmed is what is shown.
 */
export function FoundLine({ text, src, favicon, onChange, onRemove }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!editing || !ref.current) return;
    const el = ref.current; el.focus();
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  }, [editing]);
  const save = () => { const t = ref.current?.textContent.trim(); if (t && t !== text) onChange?.(t); else if (ref.current) ref.current.textContent = text; setEditing(false); };
  const cancel = () => { if (ref.current) ref.current.textContent = text; setEditing(false); };
  return (
    <li className="group relative flex items-start py-2.5 pr-16">
      <p className="flex-1 text-[13.5px] leading-relaxed text-foreground/85">
        <span ref={ref} contentEditable={editing} suppressContentEditableWarning spellCheck={false}
          onClick={() => !editing && setEditing(true)} onBlur={() => editing && save()}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') { e.preventDefault(); cancel(); } }}
          className="cursor-text outline-none">{text}</span>
        {src && !editing && <SourceIcon url={src} favicon={favicon} />}
      </p>
      {/* mousedown keeps the focus in the text, so the click decides, not the blur */}
      <span onMouseDown={(e) => editing && e.preventDefault()}
        className={cn('absolute right-0 top-1/2 flex -translate-y-1/2 gap-0.5 transition-opacity', editing ? 'opacity-100' : 'opacity-60 group-hover:opacity-100')}>
        {editing ? (
          <>
            <IconBtn label="Save" onClick={save}><Check className="size-3.5" strokeWidth={2} /></IconBtn>
            <IconBtn label="Cancel" onClick={cancel}><X className="size-3.5" strokeWidth={1.75} /></IconBtn>
          </>
        ) : (
          <>
            <IconBtn label="Edit" onClick={() => setEditing(true)}><Pencil className="size-3.5" strokeWidth={1.75} /></IconBtn>
            <IconBtn label="Remove" onClick={onRemove}><X className="size-3.5" strokeWidth={1.75} /></IconBtn>
          </>
        )}
      </span>
    </li>
  );
}

/** The tools a website gave away, as pills. */
export function ToolPills({ tools }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tools.map((t) => (
        <span key={t.id} title={t.seen}
          className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card py-[3px] pl-[3px] pr-2.5 text-[12px] font-medium text-foreground/80">
          <span className="flex size-[18px] items-center justify-center rounded-full bg-white ring-1 ring-black/[0.05]">
            {t.logo ? <img src={logoUrl(t.logo)} alt="" className="size-3 object-contain" /> : null}
          </span>
          {t.label || t.id}
        </span>
      ))}
    </div>
  );
}

/** Between the token and the results: the stages, as the server reports them. */
export function Building({ stages }) {
  return (
    <div className="flex flex-1 flex-col justify-center px-12">
      <h1 className="text-[20px] font-semibold tracking-[-0.015em] text-foreground/90">Setting things up</h1>
      <p className="mt-1 text-[13px] text-muted-foreground/80">This takes a moment.</p>
      <ul className="mt-8 space-y-3.5">
        {stages.map((s) => (
          <li key={s.id} className={cn('flex items-center gap-3 text-[13.5px] transition-colors', s.state === 'waiting' ? 'text-muted-foreground/45' : 'text-foreground/85')}>
            <span className="flex size-4 items-center justify-center">
              {s.state === 'done' ? <Check className="size-4 text-foreground/80" strokeWidth={2.25} />
                : s.state === 'running' ? <Loader2 className="size-4 animate-spin text-foreground/60" strokeWidth={2} />
                : s.state === 'failed' ? <X className="size-4 text-destructive/80" strokeWidth={2.25} />
                : <span className="size-1.5 rounded-full bg-foreground/20" />}
            </span>
            {s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

// What "Use another …" calls each kind of tool.
const KIND_NAME = { notetaker: 'notetaker', booking: 'calendar', tasks: 'task app', docs: 'workspace', issues: 'tracker', payments: 'payments tool', newsletter: 'newsletter tool', site: 'site builder' };

// The alternatives, drawn above everything (no card or bar clips it); opens
// upwards when there is no room below.
function AltMenu({ anchor, items, onPick }) {
  const r = anchor?.getBoundingClientRect();
  if (!r) return null;
  const height = Math.min(items.length * 34 + 8, 260);
  const below = window.innerHeight - r.bottom - 12;
  const up = below < height && r.top > below;
  return (
    <div onClick={(e) => e.stopPropagation()}
      style={{ position: 'fixed', left: r.left, ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }), maxHeight: 260 }}
      className="z-[60] w-[200px] overflow-y-auto rounded-[6px] border border-border/60 bg-card p-1 shadow-[0_12px_32px_-14px_rgba(0,0,0,0.3)]">
      {items.map((o) => (
        <button key={o.id} type="button" onClick={() => onPick(o)}
          className="flex w-full items-center gap-2.5 rounded-[4px] px-2 py-1.5 text-left text-[12.5px] text-foreground/85 hover:bg-foreground/[0.05]">
          <img src={logoUrl(o.logo)} alt="" className="size-4 object-contain" />{o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * One integration in the plan. `onConnect(id)` opens the provider's sign-in and
 * resolves true once connected, false when it wasn't. Alternatives of the same
 * kind can replace the suggested one before connecting.
 */
export function PlanIntegration({ item: first, onConnect }) {
  const [state, setState] = useState('idle'); // idle → connecting → done | failed
  const [item, setItem] = useState(first);
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const others = [first, ...(first.alternatives || [])].filter((x) => x.id !== item.id);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);
  const connect = async () => {
    setState('connecting');
    try { setState((await onConnect?.(item.id)) ? 'done' : 'idle'); } catch { setState('failed'); }
  };
  return (
    <div className="flex items-center gap-3 py-2.5">
      <Logo src={item.logo} alt={item.label} size="size-9" imgSize="size-5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium leading-[18px] text-foreground/90">{item.label}</span>
          {first.alternatives?.length > 0 && state !== 'done' && state !== 'connecting' && (
            <span>
              <button ref={btn} type="button" onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
                className="inline-flex items-baseline gap-0.5 text-[11.5px] leading-[18px] text-muted-foreground/70 hover:text-foreground/85">
                Use another {KIND_NAME[first.kind] || 'tool'} <ChevronDown className="size-3 translate-y-[2px] self-center" strokeWidth={2} />
              </button>
              {open && createPortal(<AltMenu anchor={btn.current} items={others} onPick={(o) => { setItem({ ...o, why: first.why }); setOpen(false); }} />, document.body)}
            </span>
          )}
        </div>
        <div className="text-[12px] leading-snug text-muted-foreground/80">{first.why}</div>
        {state === 'failed' && <div className="mt-1 text-[12px] text-destructive">That didn't connect. Try again.</div>}
      </div>
      {state === 'done'
        ? <span className="inline-flex items-center gap-1 text-[12px] text-emerald-700 dark:text-emerald-400"><Check className="size-3.5" strokeWidth={2.25} />Connected</span>
        : state === 'connecting'
          ? <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />Connecting…</span>
          : <SmallBtn primary onClick={connect}>Connect</SmallBtn>}
    </div>
  );
}

/** One routine in the plan. `onAdd(id)` adds it; resolves true when it was added. */
// A routine that needs an app is added only once that app is connected: until
// then its Add is off and the line says what to connect first.
export function PlanRoutine({ item, onAdd, ready = true }) {
  const [state, setState] = useState(item.state === 'added' ? 'added' : 'idle');
  const add = async () => {
    setState('adding');
    try { setState((await onAdd?.(item.id)) || 'idle'); } catch { setState('failed'); }
  };
  const waiting = !ready && state !== 'added';
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-[6px] bg-foreground/[0.05] text-foreground/70', waiting && 'opacity-55')}>
        {createElement(typeof item.icon === 'string' || !item.icon ? dutyIcon(item.icon) : item.icon, { className: 'size-4', strokeWidth: 1.75 })}
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn('text-[13px] font-medium text-foreground/90', waiting && 'text-foreground/60')}>{item.title}</div>
        <div className="text-[12px] leading-snug text-muted-foreground/80">
          {item.why}
          {waiting && <span className="text-muted-foreground/60"> · connect {item.needsLabel || 'its app'} first</span>}
        </div>
        {state === 'failed' && <div className="mt-1 text-[12px] text-destructive">Couldn't add it. Try again.</div>}
      </div>
      {state === 'added'
        ? <span className="inline-flex items-center gap-1 text-[12px] text-emerald-700 dark:text-emerald-400"><Check className="size-3.5" strokeWidth={2.25} />Added</span>
        : <SmallBtn onClick={add} disabled={waiting || state === 'adding'}>{state === 'adding' ? 'Adding…' : 'Add'}</SmallBtn>}
    </div>
  );
}

// What the team already connected: three logos and three names, the rest as "+N"
// and "and N more" (the same N), the full list on hover.
export function TeamConnections({ tools, botName }) {
  if (!tools?.length) return null;
  const shown = tools.slice(0, 3);
  const rest = tools.length - shown.length;
  const names = tools.map((t) => t.label);
  const sentence = names.length <= 3
    ? names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
  return (
    <div title={names.join(', ')} className="mb-6 flex items-center gap-3 rounded-[6px] bg-foreground/[0.035] px-3.5 py-3">
      <div className="flex shrink-0">
        {shown.map((t, i) => (
          <span key={t.id} className={cn('flex size-7 items-center justify-center rounded-full bg-white ring-2 ring-[#f6f5f2] dark:ring-[#262523]', i > 0 && '-ml-2')}>
            <img src={logoUrl(t.logo)} alt="" className="size-4 object-contain" />
          </span>
        ))}
        {rest > 0 && <span className="-ml-2 flex size-7 items-center justify-center rounded-full bg-foreground/[0.08] text-[10.5px] font-semibold text-foreground/70 ring-2 ring-[#f6f5f2] dark:ring-[#262523]">+{rest}</span>}
      </div>
      <p className="text-[12.5px] leading-snug text-foreground/75">Your team already connected {sentence}. {botName || 'Your coworker'} uses them for you too.</p>
    </div>
  );
}

// While the plan is being picked: the plan's own shape, shimmering, and a line
// that says what is going on.
const PICKING = ['Reading what you told me…', 'Going through the integrations…', 'Matching routines to your day…'];
export function PlanSkeleton() {
  const [i, setI] = useState(0);
  useEffect(() => { const t = setInterval(() => setI((n) => (n + 1) % PICKING.length), 1800); return () => clearInterval(t); }, []);
  const row = (k) => (
    <div key={k} className="flex items-center gap-3 py-2.5">
      <div className="onb-shimmer size-9 shrink-0 rounded-[6px]" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="onb-shimmer h-3 w-1/3 rounded" />
        <div className="onb-shimmer h-2.5 w-3/4 rounded" />
      </div>
      <div className="onb-shimmer h-7 w-16 shrink-0 rounded-[6px]" />
    </div>
  );
  return (
    <div>
      <style>{`.onb-shimmer{background:linear-gradient(90deg,color-mix(in oklab,var(--foreground) 5%,transparent) 0%,color-mix(in oklab,var(--foreground) 10%,transparent) 50%,color-mix(in oklab,var(--foreground) 5%,transparent) 100%);background-size:200% 100%;animation:onbShimmer 1.4s ease-in-out infinite}@keyframes onbShimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}`}</style>
      <div className="mb-3 flex items-center gap-2 text-[12.5px] text-muted-foreground/80">
        <Loader2 className="size-3.5 animate-spin" strokeWidth={2} />
        <span key={i} style={{ animation: 'onbIn .35s ease-out' }}>{PICKING[i]}</span>
      </div>
      <div className="divide-y divide-border/50">{[0, 1, 2].map(row)}</div>
      <div className="mt-5 divide-y divide-border/50">{[3, 4].map(row)}</div>
    </div>
  );
}
