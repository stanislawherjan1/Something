/**
 * The pieces a surface's screen is made of — Telegram and Slack share them,
 * so the two read as one design: the Team list's grid (every column as wide
 * as its widest cell, a hairline under every row, actions on the right), the
 * platform's StatusTag for every state, short setting rows with the
 * explanation on a portal tooltip, one pile for everyone in a room, and the
 * admin's link-by-id modal for a person.
 */
import { useState } from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { Check, Loader2, User, Lock, X, Trash2, Plus, Info, AlertTriangle, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ModalShell } from './IntegrationsDashboard.jsx';
import { TEAM_URL, labelCls, call, gcell } from './surface-screen-helpers.js';

/* ─── header, bottom bar, access ────────────────────────────────────────── */

// The state pill in the header: green when the surface is up, amber otherwise.
export function StatePill({ ok, icon: Icon, children, title }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider',
      ok ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-700 dark:text-amber-400')}>
      {Icon && <Icon className="size-2.5" strokeWidth={2.5} />}{children}
    </span>
  );
}

export function BottomBar({ label, children }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/60 bg-card/30 px-6 py-3">
      <span className="min-w-0 truncate text-[12px] font-medium text-muted-foreground/70">{label}</span>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function AccessDenied({ text }) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted/50"><Lock className="size-5 text-muted-foreground/70" /></div>
        <div className="text-[15px] font-semibold text-foreground/90">Admins only</div>
        <p className="text-[12.5px] leading-relaxed text-muted-foreground/70">{text}</p>
      </div>
    </div>
  );
}

export function ErrorLine({ err }) {
  if (!err) return null;
  return (
    <div className="flex items-start gap-2 rounded-[6px] border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} /><span>{err}</span>
    </div>
  );
}

/* ─── the list ──────────────────────────────────────────────────────────── */

// Five cells a row: who, state, one line, a pile, actions.
export function GridList({ children }) {
  return <ul className="grid grid-cols-[auto_auto_auto_minmax(0,1fr)_auto] items-center">{children}</ul>;
}
export function Line({ who, state, text, pile, actions }) {
  return (
    <li className="contents">
      <div className={cn(gcell, 'gap-3 pl-1')}>{who}</div>
      <div className={gcell}>{state}</div>
      <div className={gcell}><span className={cn('max-w-[260px] truncate text-[12.5px] text-muted-foreground/60', text?.mono && 'font-mono')}>{text?.mono ? text.value : text}</span></div>
      <div className={gcell}>{pile}</div>
      <div className={cn(gcell, 'justify-end pr-1')}>{actions}</div>
    </li>
  );
}
export function Name({ children }) { return <span className="whitespace-nowrap text-[14px] text-foreground/90">{children}</span>; }
export function EditButton({ onClick, label = 'Edit' }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label}
      className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground/70 hover:bg-muted/60 hover:text-foreground/90">
      <Pencil className="size-3.5" strokeWidth={1.75} />
    </button>
  );
}

/* ─── faces ─────────────────────────────────────────────────────────────── */

export function RoomAvatar({ icon: Icon }) {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted ring-1 ring-border/60">
      {Icon ? <Icon className="size-4 text-muted-foreground/70" strokeWidth={1.75} /> : null}
    </span>
  );
}
export function PersonAvatar({ name, avatar }) {
  const [errored, setErrored] = useState(false);
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  return (
    <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-[13px] font-semibold text-muted-foreground/80 ring-1 ring-border/60">
      {avatar && !errored ? <img src={avatar} alt="" className="size-full object-cover" onError={() => setErrored(true)} /> : initial}
    </span>
  );
}
export function MemberAvatar({ name, avatar }) {
  const [errored, setErrored] = useState(false);
  return (
    <span title={name || undefined} className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted ring-2 ring-card">
      {avatar && !errored
        ? <img src={avatar} alt="" className="size-full object-cover" onError={() => setErrored(true)} />
        : <User className="size-3 text-muted-foreground/40" strokeWidth={2} />}
    </span>
  );
}
export function MemberPile({ members, avatars }) {
  const shown = members.slice(0, 5);
  const extra = members.length - shown.length;
  return (
    <span className="flex items-center -space-x-1.5">
      {shown.map(([id, name]) => <MemberAvatar key={id} name={name} avatar={avatars?.[String(id)]} />)}
      {extra > 0 && <span className="z-10 flex size-6 items-center justify-center rounded-full bg-muted text-[9.5px] font-semibold text-muted-foreground/70 ring-2 ring-card">+{extra}</span>}
    </span>
  );
}
// Everyone in the room: teammates with their faces, anyone not on the team
// with an outline — the words on hover.
export function RoomPile({ members, outsiders = [], avatars }) {
  const ours = members.filter(([id]) => !outsiders.includes(id));
  return (
    <span className="flex items-center gap-2">
      <span className="flex items-center -space-x-1.5">
        {ours.slice(0, 6).map(([id, name]) => <MemberAvatar key={id} name={name} avatar={avatars?.[String(id)]} />)}
        {outsiders.slice(0, 4).map(id => (
          <Tip key={id} text="Not on the team">
            <span className="flex size-6 shrink-0 cursor-help items-center justify-center rounded-full bg-muted ring-2 ring-card">
              <span className="flex size-full items-center justify-center rounded-full ring-1 ring-inset ring-amber-500/80"><User className="size-3 text-muted-foreground/60" strokeWidth={2} /></span>
            </span>
          </Tip>
        ))}
      </span>
      {!ours.length && !outsiders.length && <span className="text-[12px] text-muted-foreground/55">Nobody seen yet</span>}
    </span>
  );
}

/* ─── modal pieces ──────────────────────────────────────────────────────── */

// The portal tooltip the Responsibilities screen uses: it is not clipped by a modal.
export function Tip({ text, children }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content side="top" sideOffset={6} collisionPadding={10}
          className="z-[60] max-w-[18rem] rounded-[6px] border border-border/60 bg-popover px-2.5 py-1.5 text-[11.5px] font-normal leading-snug text-popover-foreground shadow-md">
          {text}<TooltipPrimitive.Arrow className="fill-popover" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
export function Switch({ on, onToggle }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={onToggle}
      className={cn('relative h-5 w-9 shrink-0 rounded-full transition-colors', on ? 'bg-foreground' : 'bg-muted-foreground/30')}>
      <span className={cn('absolute top-0.5 size-4 rounded-full bg-background transition-all', on ? 'left-[18px]' : 'left-0.5')} />
    </button>
  );
}
// One setting: a short label with the explanation on hover, the control on the right.
export function ModalRow({ label, tip, children }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-foreground/90">
        {label}
        {tip && <Tip text={tip}><span className="inline-flex cursor-help text-muted-foreground/55 hover:text-foreground/80"><Info className="size-3.5" strokeWidth={2} aria-label={tip} /></span></Tip>}
      </span>
      <span className="flex shrink-0 items-center gap-2">{children}</span>
    </div>
  );
}
// A modal: header with a face and a title, setting rows in one card, a footer
// with the destructive action left and Cancel / Save right.
export function SettingsModal({ avatar, title, sub, onClose, onSave, saving, danger, dangerLabel, dangerBusyLabel, onDanger, busy, err, children }) {
  return (
    <ModalShell onClose={onClose} ariaLabel={`Settings for ${title}`}>
      <div className="w-full max-w-md overflow-hidden modal-panel" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            {avatar}
            <div className="min-w-0">
              <h2 className="truncate text-[14px] font-semibold text-foreground/90">{title}</h2>
              {sub && <div className="font-mono text-[11px] text-muted-foreground/60">{sub}</div>}
            </div>
          </div>
          <button type="button" onClick={onClose} className="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground/85">
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>
        <TooltipPrimitive.Provider delayDuration={200} skipDelayDuration={400}>
          <div className="px-5 py-4">
            <div className="divide-y divide-border/50 rounded-[6px] border border-border/60 bg-card">{children}</div>
            <ErrorLine err={err} />
          </div>
        </TooltipPrimitive.Provider>
        <div className="flex items-center justify-between gap-2 border-t border-border/40 bg-muted/20 px-5 py-3">
          {danger ? (
            <button type="button" onClick={onDanger} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-[12.5px] font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50">
              <Trash2 className="size-3.5" strokeWidth={1.75} /> {busy === 'danger' ? dangerBusyLabel : dangerLabel}
            </button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} disabled={!!busy} className="rounded-[6px] px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90 disabled:opacity-50">Cancel</button>
            {onSave && (
              <button type="button" onClick={onSave} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded-[6px] bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:bg-foreground/85 disabled:opacity-50">
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" strokeWidth={2} />}{saving ? 'Saving…' : 'Save'}
              </button>
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

/* ─── a person's link to a surface, by id (admins) ─────────────────────── */

// Link / Edit → a modal with one id field. `field` is the roster field the
// PATCH sets (telegramChatId, slackUserId); `pinned` says why it cannot change.
export function LinkIdButton({ person, field, value, what, placeholder, hint, pinned, onChanged }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState(value || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const name = person.displayName || person.slug || person.email;
  const submit = async (clear = false) => {
    setBusy(true); setErr('');
    try {
      await call(`${TEAM_URL}/${encodeURIComponent(person.email)}`, { method: 'PATCH', body: JSON.stringify({ [field]: clear ? '' : id.trim() }) });
      setOpen(false); onChanged();
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <>
      <button type="button" onClick={() => { setId(value || ''); setOpen(true); }}
        className={cn('shrink-0 rounded-[6px] px-2.5 py-1 text-[12px] font-medium', value
          ? 'text-muted-foreground/70 hover:bg-muted/50 hover:text-foreground/90'
          : 'inline-flex items-center gap-1.5 border border-border/60 bg-background text-foreground/80 transition-colors hover:border-foreground/25 hover:bg-muted/40')}>
        {value ? 'Edit' : <><Plus className="size-3" strokeWidth={2} /> Link</>}
      </button>
      {open && (
        <ModalShell onClose={() => setOpen(false)} ariaLabel={`${what} for ${name}`}>
          <div className="w-full max-w-md overflow-hidden modal-panel" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-3.5">
              <div className="flex min-w-0 items-center gap-3">
                <PersonAvatar name={name} avatar={person.avatarUrl} />
                <div className="min-w-0">
                  <h2 className="truncate text-[14px] font-semibold text-foreground/90">{name}</h2>
                  <div className="text-[11.5px] text-muted-foreground/65">{value ? `Edit ${what}` : what}</div>
                </div>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground/85"><X className="size-3.5" strokeWidth={1.75} /></button>
            </div>
            <div className="flex flex-col gap-3 px-5 py-5">
              <label className="flex flex-col gap-1.5">
                <span className={labelCls}>{placeholder.label}</span>
                <input value={id} autoFocus onChange={e => setId(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && id.trim() && !busy) submit(); }}
                  placeholder={placeholder.example} spellCheck={false} autoComplete="off" disabled={!!pinned}
                  className="w-full rounded border border-border/60 bg-background px-3 py-2 font-mono text-[13px] text-foreground outline-none transition-all focus:border-foreground/60 focus:ring-2 focus:ring-foreground/10 disabled:opacity-60" />
                <span className="text-[11.5px] text-muted-foreground/55">{pinned || hint}</span>
              </label>
              <ErrorLine err={err} />
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-border/40 bg-muted/20 px-5 py-3">
              {value && !pinned ? (
                <button type="button" onClick={() => submit(true)} disabled={busy} className="inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-[12.5px] font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"><Trash2 className="size-3.5" strokeWidth={1.75} /> Unlink</button>
              ) : <span />}
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setOpen(false)} disabled={busy} className="rounded-[6px] px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90 disabled:opacity-50">Cancel</button>
                {!pinned && (
                  <button type="button" onClick={() => submit()} disabled={busy || !id.trim()} className="inline-flex items-center gap-1.5 rounded-[6px] bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:bg-foreground/85 disabled:opacity-50">
                    {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" strokeWidth={2} />}{busy ? 'Saving…' : 'Save'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </ModalShell>
      )}
    </>
  );
}
