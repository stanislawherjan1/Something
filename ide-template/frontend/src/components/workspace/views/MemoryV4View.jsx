import { useMemo, useState, useEffect, useCallback } from 'react';
import {
  Brain, Search, History, Lock, Users, MessageCircle, Mail, Globe, ChevronRight, Pencil,
  Trash2, EyeOff, Plus, User, Building2, FolderKanban, Hash, Clock, CalendarClock,
  Send, X, Check, CircleDot, Sparkles, Undo2, NotebookPen, Archive, Replace,
  CalendarDays, Plane, Flag, Hourglass, Package, Plug, SlidersHorizontal, Cable, BookOpen, ShieldCheck, Calendar, ListChecks, FileText, Layers, UserRound, Briefcase } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import TileBanner from './TileBanner.jsx';
import { TASK_COLUMNS, PeopleContext, Assignee, PriorityChip, shortDeadline } from './KanbanView.jsx';
import { logoUrl, Toggle } from './IntegrationsDashboard.jsx';
import EditorHeader from '../EditorHeader.jsx';
import { Button } from '@/components/ui/button';
import { useBranding } from '../identity';
import { useApi, refetch } from '@/lib/useApi';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/Skeleton';

/*
 * Memory (v4) — what the assistant remembers, for the signed-in person only:
 * short-term (right now + what it keeps track of), facts with the conversation
 * each came from, topics, preferences & rules, sharing, and the change log.
 * Everything comes from /api/memory/v4/* and shows only what this person could
 * read; the actions (hide, erase, share, remove a rule) touch only their own.
 */

export const API = '/api/memory/v4';

async function post(path, body) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.ok === false) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

/* A memory is text, never rendered markdown — card lines that became records carry "**Name**" and "[[links]]". */
export const plain = (s) => String(s || '')
  .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/`([^`]+)`/g, '$1')
  .replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

/* ────────────────────────────── dates ────────────────────────────── */

const DAY = 86400_000;
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
export function dayLabel(ts) {
  const t = new Date(ts);
  const diff = Math.round((startOfDay(Date.now()) - startOfDay(t)) / DAY);
  const hm = t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (diff === 0) return `Today ${hm}`;
  if (diff === 1) return `Yesterday ${hm}`;
  return t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export function groupLabel(ts) {
  const t = new Date(ts);
  const diff = Math.round((startOfDay(Date.now()) - startOfDay(t)) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'This week';
  return t.toLocaleDateString(undefined, { month: 'long', year: t.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
export const shortDate = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
export const daysUntil = (iso) => Math.round((startOfDay(`${iso}T12:00:00`) - startOfDay(Date.now())) / DAY);

// "Right now": a status reads as its title with what it is about and its day;
// the full sentence the memory holds opens on click. A status without a title
// (written before titles existed) shows its sentence on one line instead.
export const NOW_ICON = { meeting: CalendarDays, travel: Plane, deadline: Flag, waiting: Hourglass, stock: Package };
const NOW_GROUPS = ['Today', 'This week', 'Later', 'Ongoing'];
export function nowGroupOf(n) {
  // A wait with no day yet is ongoing, not "later".
  if (!n.when && !n.expires) return 'Ongoing';
  const d = daysUntil((n.when || n.expires).slice(0, 10));
  return d <= 0 ? 'Today' : d <= 7 ? 'This week' : 'Later';
}
export function nowWhen(n) {
  const iso = n.when || n.expires;
  if (!iso) return '';
  const day = (x) => new Date(`${x.slice(0, 10)}T12:00:00`);
  const d = daysUntil(iso.slice(0, 10));
  const wd = (x) => (daysUntil(x.slice(0, 10)) === 0 ? 'Today' : daysUntil(x.slice(0, 10)) === 1 ? 'Tomorrow'
    : daysUntil(x.slice(0, 10)) < 7 ? day(x).toLocaleDateString(undefined, { weekday: 'short' }) : shortDate(x));
  const time = iso.length > 10 ? ` ${iso.slice(11, 16)}` : '';
  if (n.until && n.until !== iso.slice(0, 10)) return `${wd(iso)} – ${wd(n.until)}`;
  if (n.when) return `${wd(iso)}${time}`;
  return d <= 0 ? 'until today' : `until ${wd(iso)}`;
}

export function NowList({ now }) {
  const [open, setOpen] = useState(null);
  const groups = NOW_GROUPS.map((g) => [g, now.filter((n) => nowGroupOf(n) === g)]).filter(([, xs]) => xs.length);
  return (
    <div className="overflow-hidden rounded-[6px] border border-border/60 bg-card">
      {groups.map(([g, xs]) => (
        <div key={g}>
          <div className="border-b border-border/30 bg-muted/20 px-4 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">{g}</div>
          {xs.map((n) => {
            const key = `${n.recordId}:${n.text}`;
            const isOpen = open === key;
            const Icon = NOW_ICON[n.about] || CalendarClock;
            const due = n.about === 'deadline' && !!(n.when || n.expires) && daysUntil((n.when || n.expires).slice(0, 10)) <= 0;
            const alsoIn = (n.alsoIn || []).map((s) => (s.startsWith('group:') ? 'a group' : s === 'shared' ? 'the team' : 'private'));
            return (
              <button key={key} type="button" onClick={() => setOpen(isOpen ? null : key)}
                className="flex w-full items-start gap-3 border-b border-border/30 px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-muted/20">
                <span className="flex h-5 w-6 shrink-0 items-center justify-center rounded-[5px] bg-muted/50 text-muted-foreground/70">
                  <Icon className="size-3.5" strokeWidth={1.75} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={cn('min-w-0 text-[13px] leading-5 text-foreground/90', n.title ? 'truncate font-medium' : (isOpen ? '' : 'truncate'))}>{n.title || n.text}</span>
                    {n.sources > 1 && <span className="shrink-0 rounded-full bg-muted/60 px-1.5 text-[10.5px] text-muted-foreground/75">{n.sources} sources</span>}
                    {alsoIn.length > 0 && <span className="shrink-0 rounded-full bg-muted/60 px-1.5 text-[10.5px] text-muted-foreground/75">also in {alsoIn.join(', ')}</span>}
                    {due && <span className="shrink-0 rounded-[5px] bg-blue-600/[0.07] px-1.5 py-[3px] text-[10.5px] font-medium leading-none text-blue-700 ring-1 ring-inset ring-blue-600/[0.28] dark:text-blue-300">due today</span>}
                  </span>
                  {isOpen && n.title && <span className="mt-1 block text-[12.5px] leading-relaxed text-muted-foreground/85">{n.text}</span>}
                </span>
                <span className={cn('shrink-0 text-[11.5px] leading-5 tabular-nums', nowGroupOf(n) === 'Today' ? 'font-medium text-foreground/75' : 'text-muted-foreground/60')}>{nowWhen(n)}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ────────────────────────────── small pieces ────────────────────────────── */

export function Section({ title, right, children }) {
  return (
    <section className="flex flex-col gap-2.5">
      {/* One fixed height for the heading row, with or without a note on the
          right, so every section's card starts at the same line. */}
      <div className="flex h-5 items-center justify-between gap-3">
        <h2 className="shrink-0 whitespace-nowrap text-[11px] font-semibold uppercase leading-none tracking-[0.1em] text-muted-foreground/70">{title}</h2>
        {right && <div className="hidden leading-none sm:flex sm:items-center">{right}</div>}
      </div>
      {children}
    </section>
  );
}

// The lists' outline while they load: a few ruled rows, date then text.
/** The banner tiles while they load: a quiet banner block with a chip, two lines and a meta line. */
export function LoadingTiles({ count = 6, min = 250 }) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col overflow-hidden rounded-[6px] border border-border/60 bg-card">
          <div className="flex h-14 items-center bg-muted/40 px-4">
            <Skeleton className="h-7 rounded-[6px] bg-background/70" style={{ width: `${44 + ((i * 13) % 30)}%` }} />
          </div>
          <div className="flex flex-col gap-2 px-4 py-3">
            <Skeleton className="h-3" style={{ width: `${70 + ((i * 11) % 25)}%` }} />
            <Skeleton className="h-3" style={{ width: `${40 + ((i * 17) % 30)}%` }} />
            <Skeleton className="mt-2 h-2.5 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Short-term memory while it loads, in its own shape: the Right now list, then the tiles. */
function LoadingOverview() {
  return (
    <div className="flex flex-col gap-7">
      <LoadingSection rows={4} />
      <div className="flex flex-col gap-2.5">
        <div className="flex h-5 items-center"><Skeleton className="h-2.5 w-44" /></div>
        <LoadingTiles count={4} />
      </div>
    </div>
  );
}

export function LoadingRows({ count = 6 }) {
  return (
    <div className="overflow-hidden rounded-[6px] border border-border/60">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center gap-6 border-b border-border/50 px-5 py-3.5 last:border-b-0">
          <Skeleton className="h-3 w-16 shrink-0" />
          <Skeleton className="h-3.5" style={{ width: `${46 + ((i * 17) % 34)}%` }} />
        </div>
      ))}
    </div>
  );
}

export function Empty({ children }) {
  return <div className="rounded-[6px] border border-dashed border-border/60 px-4 py-4 text-[12.5px] text-muted-foreground/70">{children}</div>;
}

export const STATE_DOT = { active: 'bg-blue-600', paused: 'bg-background ring-2 ring-inset ring-blue-600', closed: 'bg-muted-foreground/30' };
const SRC_ICON = { telegram: MessageCircle, web: Globe, group: Users, email: Mail, note: NotebookPen, review: ListChecks, migration: Archive };
const SRC_LABEL = { telegram: 'Telegram conversation', web: 'web chat', group: 'team group', email: 'inbox check', note: 'saved note', review: 'daily review', migration: 'earlier memory', integration: 'meeting notes' };

/** The icon of the integration a fact came from, after its title. */
function SourceIcon({ integration, className }) {
  if (!integration?.logo) return null;
  return <img src={logoUrl(integration.logo)} alt={integration.label} title={`From ${integration.label}${integration.title ? ` · ${integration.title}` : ''}`} className={cn('inline-block size-3.5 shrink-0 object-contain align-[-2.5px]', className)} />;
}
export const KIND_ICON = { person: UserRound, company: Briefcase, project: FolderKanban, topic: Hash };

/* A checkbox in the page's own tones — the native one is a white box in dark mode. */
function Tick({ checked, onChange, label, className }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={label} onClick={onChange}
      className={cn('flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
        checked ? 'border-foreground/80 bg-foreground text-background' : 'border-border bg-transparent hover:border-foreground/40', className)}>
      {checked && <Check className="size-3" strokeWidth={3} />}
    </button>
  );
}

// Tag tones: neutral hairline by default; the kinds keep their colour.
// One accent, and only for STATE (corrected, replaced, no longer true, due):
// what kind of thing a fact is stays in neutral ink, like every other tag.
const PILL_TONE = {
  accent: 'bg-blue-600/[0.07] text-blue-700 ring-blue-600/[0.28] dark:text-blue-300',
};

export function Pill({ children, className, tone }) {
  return (
    // One neutral tag style, like the role badges: a hairline, no fill, no colour.
    <span className={cn('inline-flex items-center gap-1 rounded-[5px] px-1.5 py-[3px] text-[10.5px] font-medium leading-none ring-1 ring-inset', PILL_TONE[tone] || 'text-muted-foreground/80 ring-foreground/[0.12]', className)}>
      {children}
    </span>
  );
}

export function ScopePill({ scope }) {
  if (scope === 'private') return <Pill><Lock className="size-2.5" strokeWidth={2.25} />Private</Pill>;
  if (scope === 'group') return <Pill><Users className="size-2.5" strokeWidth={2.25} />Group</Pill>;
  return <Pill><Users className="size-2.5" strokeWidth={2.25} />Shared</Pill>;
}

export function TabBar({ value, onChange, tabs }) {
  return (
    <div className="flex items-end justify-between gap-4 border-b border-border/50">
      <div className="-mb-px flex items-end gap-5 overflow-x-auto [scrollbar-width:none] sm:mb-0 sm:gap-6 sm:overflow-visible [&::-webkit-scrollbar]:hidden">
        {tabs.map(([v, label, count]) => (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            className={cn('-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 pb-2.5 text-[13px] font-medium transition-colors',
              value === v ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground/70 hover:text-foreground/85')}
          >
            {label}
            {count != null && count > 0 && <span className="text-[11.5px] tabular-nums text-muted-foreground/55">{count}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function FilterLinks({ value, onChange, options }) {
  return (
    <div className="flex items-center gap-2.5 text-[12px]">
      {options.map(([v, label]) => (
        <button key={v} type="button" onClick={() => onChange(v)}
          className={cn('whitespace-nowrap transition-colors', value === v ? 'font-medium text-foreground' : 'text-muted-foreground/65 hover:text-foreground/85')}>
          {label}
        </button>
      ))}
    </div>
  );
}

function ToggleLink({ on, onChange, icon, children }) {
  const Icon = icon;
  return (
    <button type="button" onClick={() => onChange(!on)}
      className={cn('inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] transition-colors',
        on ? 'font-medium text-foreground' : 'text-muted-foreground/65 hover:text-foreground/85')}>
      <Icon className="size-3.5" strokeWidth={1.75} />{children}
    </button>
  );
}

/** An inline one-line input with Save / Cancel — for adding a rule or a profile line. */
function AddLine({ placeholder, initial = '', onSave, onCancel }) {
  const [text, setText] = useState(initial);
  const [err, setErr] = useState(null);
  const save = async () => {
    if (!text.trim()) return;
    try { await onSave(text.trim()); } catch (e) { setErr(e.message); }
  };
  return (
    <div className="flex flex-col gap-1.5 px-4 py-2.5">
      <div className="flex items-center gap-2">
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onCancel(); }}
          className="h-7 min-w-0 flex-1 rounded-[6px] border border-border/55 bg-background px-2 text-[12.5px] outline-none focus:border-foreground/40" />
        <Button size="xs" onClick={save}><Check />Save</Button>
        <Button variant="ghost" size="xs" onClick={onCancel}>Cancel</Button>
      </div>
      {err && <p className="text-[11.5px] text-destructive">{err}</p>}
    </div>
  );
}

/* ────────────────────────────── short-term memory ────────────────────────────── */

export const STATE_ORDER = { active: 0, paused: 1, closed: 2 };

function Overview() {
  const { botDisplayName } = useBranding();
  const { data, loading } = useApi(`${API}/overview`);
  if (loading && !data) return <LoadingOverview />;
  const now = data?.now || [];
  const digest = [...(data?.digest?.items || [])].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
  const at = data?.digest?.at;
  const rightNow = (
    <Section title="Right now">
      {now.length ? <NowList now={now} /> : <Empty>Nothing time-bound right now.</Empty>}
    </Section>
  );
  // What is in motion: a tile each, with its own banner and its state on it,
  // as the AI settings and integrations tiles are drawn; a tile opens to the line.
  const tracking = (
    <Section
      title="What I'm keeping track of"
      right={at && <span className="text-[11.5px] text-muted-foreground/55">Refreshed {dayLabel(at).toLowerCase()} · used by {botDisplayName} to plan</span>}
    >
      {digest.length ? (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
          {digest.map((d) => <TrackTile key={d.name} d={d} />)}
        </div>
      ) : <Empty>The list is built overnight from your conversations — it will appear after the first night.</Empty>}
    </Section>
  );
  return (
    <div className="flex flex-col gap-7">
      {rightNow}
      {tracking}
    </div>
  );
}

const TRACK_STATE = { active: 'Active', paused: 'Paused', closed: 'Closed' };
function TrackTile({ d }) {
  const [open, setOpen] = useState(false);
  return (
    <button type="button" onClick={() => setOpen(!open)} className={cn('flex flex-col overflow-hidden rounded-[6px] border border-border/60 bg-card text-left transition-all hover:border-foreground/20 hover:shadow-[0_2px_10px_rgba(0,0,0,0.05)]', d.state === 'closed' && 'opacity-60')}>
      <div className="relative h-14 overflow-hidden">
        <TileBanner icon={Layers} seed={`digest-${d.name}`} soft className="!absolute inset-0 h-full" />
        <div className="relative flex h-14 items-center px-4">
          <span className="inline-flex items-center gap-2 rounded-[6px] border border-border/60 bg-background/90 px-3 py-1.5 text-[12.5px] text-foreground/90 backdrop-blur">
            <span className={cn('size-1.5 rounded-full', STATE_DOT[d.state])} />{TRACK_STATE[d.state] || d.state}
            {d.date && <span className="tabular-nums text-muted-foreground/60">· {shortDate(d.date)}</span>}
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-1 px-4 py-3">
        <span className="text-[13.5px] font-medium leading-snug text-foreground/90">{d.name}</span>
        <span className={cn('text-[12.5px] leading-snug text-muted-foreground/80', !open && 'line-clamp-2')}>{d.line}</span>
      </div>
    </button>
  );
}

/* ────────────────────────────── facts ────────────────────────────── */

/**
 * A fact's task, the way the board shows a card: the title, then who, by
 * when and how urgent, with the column it sits in as a tag.
 */
export function TaskOfFact({ task, onOpen }) {
  const done = task.status === 'done';
  const column = TASK_COLUMNS.find((c) => c.key === task.status)?.name || task.status;
  const people = task.owner ? { [task.owner]: { name: task.ownerName || task.owner, avatar: task.ownerAvatar || null } } : {};
  return (
    <PeopleContext.Provider value={people}>
      <button type="button" onClick={onOpen} className={cn('mt-4 block w-full rounded-[6px] border border-border/55 bg-card p-3.5 text-left transition-all duration-150 hover:border-foreground/15 hover:shadow-[0_2px_8px_rgba(0,0,0,0.04)]', done && 'opacity-70')}>
        <div className="flex items-start justify-between gap-3">
          <span className={cn('text-[14px] leading-snug', done ? 'text-muted-foreground/70 line-through' : 'text-foreground/90')}>{task.title}</span>
          <span className={cn('inline-flex shrink-0 items-center rounded-[5px] px-1.5 py-px text-[11px] font-medium leading-[18px] ring-1 ring-inset', task.status === 'in_progress' ? 'text-foreground/85 ring-foreground/25' : 'text-muted-foreground/70 ring-foreground/[0.1]')}>{column}</span>
        </div>
        {(task.owner || task.priority || task.deadline) && (
          <div className="mt-3 flex items-center gap-2.5 text-[11.5px] text-muted-foreground/75">
            <Assignee owner={task.owner} />
            {task.deadline && <span className="inline-flex items-center gap-1 tabular-nums"><Calendar className="size-[12px]" strokeWidth={1.75} />{shortDeadline(task.deadline)}</span>}
            {task.priority && <PriorityChip value={task.priority} />}
          </div>
        )}
      </button>
    </PeopleContext.Provider>
  );
}

export function FactPills({ f }) {
  return (
    <>

      {f.kind === 'status' && !f.past && f.expires && <Pill><Clock className="size-2.5" strokeWidth={2.25} />until {shortDate(f.expires)}</Pill>}
      {/* The same fact said again later adds a source instead of a second line. */}
      {f.sources > 1 && <Pill>{f.sources} sources</Pill>}
      {!f.past && f.updates?.length > 0 && <Pill tone="accent"><Replace className="size-2.5" strokeWidth={2.25} />updated {shortDate(f.updates[f.updates.length - 1].ts)}</Pill>}
      {!f.past && f.history?.some((h) => h.why === 'superseded') && <Pill tone="accent"><Replace className="size-2.5" strokeWidth={2.25} />supersedes {f.history.filter((h) => h.why === 'superseded').length} earlier</Pill>}
      {f.past && f.superseded && f.supersededWhy === 'superseded' && <Pill tone="accent"><Replace className="size-2.5" strokeWidth={2.25} />no longer true</Pill>}
      {f.past && f.superseded && f.supersededWhy !== 'superseded' && <Pill tone="accent"><Replace className="size-2.5" strokeWidth={2.25} />replaced {shortDate(f.superseded)}</Pill>}
      {f.past && !f.superseded && f.ended && <Pill>past · ended {shortDate(f.ended)}</Pill>}
      {f.past && !f.superseded && !f.ended && <Pill>past · ended {shortDate(f.expires)}</Pill>}
      {f.kind === 'preference' && <Pill>preference</Pill>}
      {f.kind === 'routine' && <Pill>routine</Pill>}
      {f.review && <Pill>reviewed</Pill>}
      {f.via && <ViaGlyph via={f.via} />}
      {f.scope !== 'private' && <ScopePill scope={f.scope} />}
    </>
  );
}

// Where the fact was said: the web chat, Telegram or Slack — a small mark, the words on hover.
const VIA_BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
function ViaGlyph({ via }) {
  const label = via === 'slack' ? 'Said on Slack' : via === 'telegram' ? 'Said on Telegram' : 'Said in the web chat';
  return (
    <span title={label} className="inline-flex size-4 shrink-0 items-center justify-center opacity-60" aria-label={label}>
      {via === 'web' ? <Globe className="size-3" strokeWidth={1.75} /> : <img src={`${VIA_BASE}/integrations/${via}.svg`} alt="" className="size-3 object-contain grayscale" />}
    </span>
  );
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The conversation a fact came from: the message with its evidence highlighted, one before it muted. */
function Transcript({ recordId, evidence }) {
  const { botDisplayName } = useBranding();
  const { data, loading, error } = useApi(`${API}/records/${encodeURIComponent(recordId)}`);
  if (loading && !data) return <p className="text-[12px] text-muted-foreground/60">Loading…</p>;
  if (error || !data?.messages) return <p className="text-[12px] text-muted-foreground/60">The conversation is no longer available.</p>;
  const msgs = data.messages;
  const ev = norm(evidence);
  let hit = ev ? msgs.findIndex((m) => norm(m.text).includes(ev)) : -1;
  if (hit < 0 && ev) hit = msgs.findIndex((m) => ev.split(' ').filter((w) => w.length > 3).every((w) => norm(m.text).includes(w)));
  const shown = hit >= 0 ? msgs.slice(Math.max(0, hit - 1), hit + 1) : msgs.slice(0, 6);
  const mt = data.meeting;
  return (
    <div className="flex flex-col gap-2.5">
      {mt && (
        <div className="mb-1 rounded-[5px] border border-border/50 bg-muted/25 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground/80">
          <div className="text-foreground/85">{mt.title || 'Meeting'}{mt.kind === 'transcript' ? ` · transcript${mt.of > 1 ? ` (part ${mt.part} of ${mt.of})` : ''}` : ' · notes'}</div>
          {mt.participants?.length > 0 && <div>With {mt.participants.join(', ')}</div>}
          {mt.url && /^https?:\/\//i.test(mt.url) && <a href={mt.url} target="_blank" rel="noreferrer" className="underline decoration-border hover:text-foreground/85">Open in {mt.integration?.label || 'the service'}</a>}
        </div>
      )}
      {shown.map((m, i) => {
        const isEv = hit >= 0 && msgs.indexOf(m) === hit;
        return (
          <div key={i} className={cn(hit >= 0 && !isEv && 'opacity-60')}>
            {m.who && <div className="mb-0.5 text-[11px] font-medium text-muted-foreground/70">{m.who === 'Assistant' ? botDisplayName : m.who}</div>}
            <p className={cn('whitespace-pre-line text-[12.5px] leading-relaxed',
              isEv ? '-mx-2 rounded-[5px] bg-foreground/[0.045] px-2 py-1 text-foreground/90' : 'text-muted-foreground/85')}>
              {plain(m.text)}
            </p>
          </div>
        );
      })}
    </div>
  );
}

export function FactRow({ f, open, onToggle, onChanged, selecting = false, picked = false, onPick }) {
  const SrcIcon = SRC_ICON[f.source] || MessageCircle;
  const navigate = useNavigate();
  const [confirmErase, setConfirmErase] = useState(false);
  const [source, setSource] = useState(false);
  const [err, setErr] = useState(null);
  const act = async (op) => {
    setErr(null);
    try { await post(`/records/${encodeURIComponent(f.recordId)}/${op}`); onChanged(); } catch (e) { setErr(e.message); throw e; }
  };
  const fact = async (op) => {
    setErr(null);
    try { await post('/facts/bulk', { op, ids: [f.id] }); onChanged(); } catch (e) { setErr(e.message); throw e; }
  };
  return (
    <div className={cn('group border-b border-border/30 last:border-b-0', open && 'bg-muted/25')}>
      <div className="flex items-start sm:items-center">
      {selecting && (
        <span className="flex w-9 shrink-0 items-center justify-center self-stretch">
          {f.mine
            ? <Tick label="Select this fact" checked={picked} onChange={() => onPick(f.id)} />
            : <span className="size-3.5" />}
        </span>
      )}
      <button type="button" onClick={onToggle} className={cn('flex min-w-0 flex-1 items-start gap-3 py-2.5 pr-4 text-left sm:items-center sm:py-2', selecting ? 'pl-0' : 'pl-4')}>
        <ChevronRight className={cn('mt-0.5 size-3.5 shrink-0 text-muted-foreground/35 transition-transform sm:mt-0', open && 'rotate-90 text-muted-foreground/70')} strokeWidth={2} />
        <span className="hidden w-24 shrink-0 text-[11.5px] tabular-nums text-muted-foreground/60 sm:block">{f.undated ? `by ${dayLabel(f.ts)}` : dayLabel(f.ts)}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-1.5 sm:block">
          {/* A titled fact reads as its one-line title over its description (one
              line here, in full when opened); a fact written before titles shows
              its sentence alone, as before. */}
          {f.title ? (
            // `block`: an inline span never truncates — on a wide screen the
            // title ran under the pills beside it.
            <span className={cn('block truncate text-[13px] font-medium leading-5 text-foreground/90', f.past && 'text-muted-foreground/60', f.supersededWhy === 'superseded' && 'line-through decoration-muted-foreground/50')}>{f.title}{f.integration && <SourceIcon integration={f.integration} className="ml-1.5" />}</span>
          ) : (
            <span className={cn('line-clamp-2 text-[12.5px] leading-snug text-foreground/85 sm:block sm:truncate', f.past && 'text-muted-foreground/60', f.supersededWhy === 'superseded' && 'line-through decoration-muted-foreground/50')}>{plain(f.text)}{f.integration && <SourceIcon integration={f.integration} className="ml-1.5" />}</span>
          )}
          <span className="flex flex-wrap items-center gap-1.5 sm:hidden">
            <span className="text-[11px] tabular-nums text-muted-foreground/60">{f.undated ? `by ${dayLabel(f.ts)}` : dayLabel(f.ts)}</span>
            <FactPills f={f} />
          </span>
        </span>
        <span className="hidden shrink-0 items-center gap-1.5 sm:flex"><FactPills f={f} /></span>
      </button>
      </div>
      {open && (
        <div className="border-t border-border/40 px-4 pb-3 pt-4 sm:pl-[52px]">
          {/* Open: the description, the fact's timeline when it has one, then a bottom bar with the actions. */}
          {f.title && <p className="text-[13px] leading-relaxed text-foreground/85">{plain(f.text)}</p>}
          {f.past && f.supersededByTitle && (
            <p className="mt-2 text-[12px] text-muted-foreground/70">{f.supersededWhy === 'superseded' ? 'No longer true — now: ' : 'Replaced by: '}<span className="text-foreground/80">{f.supersededByTitle}</span></p>
          )}
          {/* The fact's own timeline, the way a topic's reads: what was said first, what
              replaced it, what was corrected later. Shown only when there is more than the description. */}
          {(f.history?.length > 0 || f.updates?.length > 0) && (
            <ol className="relative mb-1 mt-5 border-l border-border/60 pl-6">
              {[...(f.history || []).map((h) => ({ ts: h.ts, until: h.until || null, text: h.text, gone: h.why === 'superseded', kind: 'version' })),
                ...(f.updates || []).map((u) => ({ ts: u.ts, text: u.text, kind: 'update' }))]
                .sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : x.kind === 'version' ? -1 : 1))
                .map((e, i) => (
                  <li key={i} className="relative pb-5 last:pb-1">
                    <span className={cn('absolute -left-[29px] top-[7px] size-2 rounded-full ring-2 ring-background', e.kind === 'update' ? 'bg-background ring-2 ring-inset ring-blue-600' : e.kind === 'current' ? 'bg-blue-600' : 'bg-muted-foreground/30')} />
                    <div className="mb-1 text-[11px] tabular-nums text-muted-foreground/60">{dayLabel(e.ts)}{e.kind === 'update' && <> · update</>}{e.kind === 'version' && <> · {e.gone ? 'no longer true' : 'earlier version'}{e.until && <> · until {dayLabel(e.until)}</>}</>}</div>
                    <p className={cn('text-[13px] leading-relaxed', e.kind === 'version' ? 'text-muted-foreground/70' : 'text-foreground/85', e.gone && 'line-through decoration-muted-foreground/40')}>{plain(e.text)}</p>
                  </li>
                ))}
            </ol>
          )}
          {/* The task this fact produced, drawn as the board draws it; it opens there. */}
          {f.task && <TaskOfFact task={f.task} onOpen={() => navigate('/tasks')} />}
          {/* The notes and write-ups the conversation produced: each opens in the editor; a removed one says so. */}
          {f.files?.length > 0 && (
            <div className="mt-4 flex flex-col gap-1.5">
              {f.files.map((x) => (
                <button key={x.path} type="button" disabled={!x.exists} onClick={() => navigate(`/files/${x.path.split('/').map(encodeURIComponent).join('/')}`)}
                  className={cn('inline-flex max-w-full items-center gap-2 self-start rounded-[6px] border border-border/55 bg-card px-3 py-2 text-left text-[12.5px] transition-colors', x.exists ? 'text-foreground/85 hover:border-foreground/30' : 'text-muted-foreground/55')}>
                  <FileText className="size-3.5 shrink-0 text-muted-foreground/70" strokeWidth={1.75} />
                  <span className="truncate">{x.path}</span>
                  {!x.exists && <span className="shrink-0 text-[11px] text-muted-foreground/55">· gone</span>}
                </button>
              ))}
            </div>
          )}
          {/* Three quiet actions. Erase (this fact alone) confirms in a modal, like deleting a routine;
              erasing the whole conversation lives where the conversation is shown (See source). */}
          <div className="-mx-4 mt-4 flex flex-wrap items-center gap-0.5 border-t border-border/40 px-2 pt-2 sm:-ml-[52px] sm:pl-[44px] sm:pr-3">
            {f.recordId && <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground" onClick={() => setSource(true)}><SrcIcon />See source</Button>}
            {f.mine && (<>
              <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground" onClick={() => fact('hide')}><EyeOff />Hide</Button>
              {!f.review && f.scope === 'shared' && f.owned && <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground" onClick={() => act('hide')}><Lock />Make private</Button>}
              <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground hover:text-destructive" onClick={() => setConfirmErase(true)}><Trash2 />Erase</Button>
            </>)}
          </div>
          {confirmErase && <EraseModal title={`Erase "${f.title || 'this fact'}"?`} body="This fact is gone for good and is not learned again from the same words. The conversation it came from stays, with its other facts." onClose={() => setConfirmErase(false)} onConfirm={() => fact('erase')} />}
          {err && <p className="mt-1.5 text-[11.5px] text-destructive">{err}</p>}
          {source && <SourceModal f={f} onClose={() => setSource(false)} onEraseConversation={f.mine && !f.review ? () => { setSource(false); act('erase'); } : null} />}
        </div>
      )}
    </div>
  );
}


/** One confirm for erasing, in the same shape as deleting a routine or a skill: what goes, and that it is for good. */
function EraseModal({ title, body, label = 'Erase', onClose, onConfirm }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);
  const go = async () => {
    setBusy(true); setError(null);
    try { await onConfirm(); onClose(); } catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <div role="dialog" aria-modal="true" aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop px-4 animate-[fade-in_0.12s_ease-out]"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="w-full max-w-md overflow-hidden modal-panel">
        <div className="flex items-start gap-3.5 px-6 py-5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
            <Trash2 className="size-4 text-destructive" strokeWidth={2} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-foreground">{title}</div>
            <div className="mt-1 text-[13px] leading-relaxed text-muted-foreground/85">{body}</div>
            {error && <div className="mt-3 rounded border border-destructive/25 bg-destructive/[0.04] px-2.5 py-1.5 text-[12px] text-destructive">{error}</div>}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border/50 bg-muted/15 px-6 py-3">
          <button type="button" onClick={onClose} disabled={busy} className="rounded px-3.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground/85 disabled:opacity-50">Cancel</button>
          <button type="button" onClick={go} disabled={busy} className="inline-flex items-center gap-1.5 rounded bg-destructive px-4 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-95 disabled:opacity-50">{label}</button>
        </div>
      </div>
    </div>
  );
}

/** The conversation a fact came from, with the line it rests on highlighted. */
function SourceModal({ f, onClose, onEraseConversation = null }) {
  const SrcIcon = SRC_ICON[f.source] || MessageCircle;
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !confirm) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden modal-panel">
        <div className="flex items-start gap-3 border-b border-border/40 px-6 py-4">
          <div className="flex size-8 shrink-0 items-center justify-center rounded border border-border/50 bg-muted/35 text-[--color-ring]/80">
            <SrcIcon className="size-[18px]" strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold text-foreground/90">{f.title || 'Source'}</div>
            {f.integration ? (
              <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground/70"><SourceIcon integration={{ ...f.integration, title: null }} /><span className="truncate">From {f.integration.label}{f.integration.title ? ` · ${f.integration.title}` : ''} · {dayLabel(f.said || f.ts)}</span></div>
            ) : (
              <div className="text-[12px] text-muted-foreground/70">From {f.source === 'review' ? 'the' : 'your'} {SRC_LABEL[f.source] || 'conversation'} · {dayLabel(f.said || f.ts)}</div>
            )}
          </div>
          <Button variant="ghost" size="xs" onClick={onClose} aria-label="Close"><X /></Button>
        </div>
        <div className="overflow-y-auto px-6 py-4">
          <Transcript recordId={f.recordId} evidence={f.evidence} />
        </div>
        {/* The one place to erase the conversation itself: where it is being read. */}
        {onEraseConversation && (
          <div className="flex items-center justify-end border-t border-border/40 px-6 py-3">
            <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive" onClick={() => setConfirm(true)}><Trash2 />Erase this conversation…</Button>
          </div>
        )}
        {confirm && <EraseModal title="Erase this conversation?" body="Its record and every fact from it are gone for good, and none of it is learned again from the same words." onClose={() => setConfirm(false)} onConfirm={onEraseConversation} />}
      </div>
    </div>
  );
}

function SearchResults({ query }) {
  const { botDisplayName } = useBranding();
  const [q, setQ] = useState(query);
  useEffect(() => { const t = setTimeout(() => setQ(query), 350); return () => clearTimeout(t); }, [query]);
  const { data, loading, reload } = useApi(q ? `${API}/search?q=${encodeURIComponent(q)}` : null);
  const [openId, setOpenId] = useState(null);
  const [excerpts, setExcerpts] = useState(false);
  const topics = data?.topics || [];
  const facts = data?.facts || [];
  const hits = data?.hits || [];
  const nothing = !loading && data && !topics.length && !facts.length && !hits.length;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 rounded-[6px] border border-blue-600/20 bg-blue-600/[0.04] px-3 py-2 text-[12px] text-foreground/80">
        <Sparkles className="size-3.5 text-blue-600 dark:text-blue-400" strokeWidth={1.75} />
        Topics and facts about <span className="font-medium">“{query}”</span>, best match first — and below, what {botDisplayName} would recall if you asked.
      </div>
      {loading && !data ? <Empty>Searching…</Empty> : nothing ? <Empty>Nothing in memory matches that.</Empty> : (
        <>
          {topics.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {topics.map((t) => {
                const Icon = KIND_ICON[t.kind] || Hash;
                return (
                  <span key={t.key} className="inline-flex items-center gap-1.5 rounded-[6px] border border-border/60 bg-card px-2.5 py-1.5 text-[12.5px] text-foreground/85">
                    <Icon className="size-3.5 text-[--color-ring]/80" strokeWidth={1.75} />
                    <span className="font-medium">{t.name}</span>
                    {t.aliases?.length > 0 && <span className="text-muted-foreground/65">also {t.aliases.join(', ')}</span>}
                    <span className="text-muted-foreground/55">· {t.n}</span>
                  </span>
                );
              })}
            </div>
          )}
          {facts.length > 0 && (
            <div className="overflow-hidden rounded-[6px] border border-border/60 bg-card">
              {facts.map((f) => <FactRow key={f.id} f={f} open={openId === f.id} onToggle={() => setOpenId(openId === f.id ? null : f.id)} onChanged={reload} />)}
            </div>
          )}
          {hits.length > 0 && (
            <div className="overflow-hidden rounded-[6px] border border-border/60 bg-card">
              <button type="button" onClick={() => setExcerpts(!excerpts)} className="flex w-full items-center justify-between px-4 py-2.5 text-left text-[12.5px] text-muted-foreground/80 hover:text-foreground/85">
                <span>Conversation excerpts {botDisplayName} would recall · {hits.length} of {data.total}</span>
                <span className="text-[11px]">{excerpts ? 'Hide' : 'Show'}</span>
              </button>
              {excerpts && hits.map((h) => (
                <div key={h.id} className="border-t border-border/30 px-4 py-2.5">
                  <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground/65">
                    <span className="tabular-nums">{dayLabel(h.ts)}</span><span>·</span><span>{SRC_LABEL[h.source] || h.source}</span>
                    {h.scope !== 'private' && <ScopePill scope={h.scope} />}
                  </div>
                  {h.messages.slice(0, 3).map((m, i) => (
                    <p key={i} className="line-clamp-2 text-[12.5px] leading-snug text-foreground/85">
                      {m.who && <span className="font-medium text-muted-foreground/80">{m.who === 'Assistant' ? botDisplayName : m.who}: </span>}{m.text}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FactsTab({ scope, history, filters }) {
  const url = `${API}/facts?history=1&limit=500`;
  const { data, loading, reload } = useApi(url);
  const [openId, setOpenId] = useState(null);
  // Many at once: pick facts, then hide or erase them together. A row is one
  // fact; the conversation it came from stays, with its other facts.
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState(() => new Set());
  const [confirmErase, setConfirmErase] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const changed = useCallback(() => { reload(); refetch(`${API}/privacy`); }, [reload]);
  const inScope = (data?.items || []).filter((f) => scope === 'all' || f.scope === scope || (scope === 'shared' && f.scope === 'group'));
  const rows = inScope.filter((f) => history || !f.past);
  const pastCount = inScope.filter((f) => f.past).length;
  const selectable = rows.filter((f) => f.mine).map((f) => f.id);
  const allPicked = selectable.length > 0 && selectable.every((id) => picked.has(id));
  const pick = (id) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const stop = () => { setSelecting(false); setPicked(new Set()); setConfirmErase(false); setErr(null); };
  // A filter change ends the selection: what was picked may no longer be on the screen.
  useEffect(() => { setSelecting(false); setPicked(new Set()); setConfirmErase(false); }, [scope, history]);
  const bulk = async (op) => {
    setBusy(true); setErr(null);
    try { await post('/facts/bulk', { op, ids: [...picked] }); stop(); changed(); refetch(`${API}/topics`); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const link = 'whitespace-nowrap text-[12px] text-muted-foreground/65 transition-colors hover:text-foreground/85 disabled:opacity-40 disabled:hover:text-muted-foreground/65';
  const header = (
    <div className="flex min-h-5 flex-wrap items-center gap-x-4 gap-y-2 leading-5">
      {filters}
      {selectable.length > 0 && (
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
          {!selecting ? <button type="button" className={link} onClick={() => setSelecting(true)}>Select…</button> : (
            <>
              <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground/75">
                <Tick label="Select all" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(selectable))} />
                All {selectable.length}
              </span>
              <span className="text-[12px] tabular-nums text-muted-foreground/55">{picked.size} selected</span>
              <button type="button" className={link} disabled={!picked.size || busy} onClick={() => bulk('hide')}>Hide</button>
              {!confirmErase
                ? <button type="button" className={cn(link, 'hover:text-destructive')} disabled={!picked.size || busy} onClick={() => setConfirmErase(true)}>Erase…</button>
                : (
                  <span className="flex items-center gap-2 text-[12px]">
                    <span className="text-muted-foreground/75">Erase {picked.size} fact{picked.size === 1 ? '' : 's'} for good?</span>
                    <button type="button" className="font-medium text-destructive" disabled={busy} onClick={() => bulk('erase')}>Erase</button>
                    <button type="button" className={link} onClick={() => setConfirmErase(false)}>Cancel</button>
                  </span>
                )}
              <button type="button" className={cn(link, 'font-medium text-foreground/85')} onClick={stop}>Done</button>
            </>
          )}
        </div>
      )}
      {err && <p className="w-full text-[11.5px] text-destructive">{err}</p>}
    </div>
  );
  if (loading && !data) return <div className="flex flex-col gap-2.5">{header}<LoadingRows /></div>;
  if (!rows.length) return <div className="flex flex-col gap-2.5">{header}<Empty>No facts yet. They are written from your conversations when a conversation ends.</Empty></div>;
  const groups = [...new Set(rows.map((f) => groupLabel(f.ts)))];
  return (
    <div className="flex flex-col gap-2.5">
      {header}
      <div className="overflow-hidden rounded-[6px] border border-border/60 bg-card">
        {groups.map((g) => (
          <div key={g}>
            <div className="border-b border-border/30 bg-muted/20 px-4 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">{g}</div>
            {rows.filter((f) => groupLabel(f.ts) === g).map((f) => (
              <FactRow key={f.id} f={f} open={openId === f.id} onToggle={() => setOpenId(openId === f.id ? null : f.id)} onChanged={changed}
                selecting={selecting} picked={picked.has(f.id)} onPick={pick} />
            ))}
          </div>
        ))}
        <div className="px-4 py-2.5 text-center text-[12px] text-muted-foreground/65">
          {rows.length} fact{rows.length === 1 ? '' : 's'} · newest first
          {!history && pastCount > 0 && <> · {pastCount} past &amp; superseded not shown</>}
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────── topics + timeline ────────────────────────────── */

const TOPIC_KIND_LABEL = { person: 'Person', company: 'Company', project: 'Project', topic: 'Topic' };
export function TopicTile({ t, onOpen }) {
  const Icon = KIND_ICON[t.kind] || Hash;
  // A banner like the AI settings tiles, the name on it — what the topic is
  // matters more than what kind it is; kind, state and how much is known below.
  return (
    <button type="button" onClick={() => onOpen(t)} className={cn('flex flex-col overflow-hidden rounded-[6px] border border-border/60 bg-card text-left transition-all hover:border-foreground/20 hover:shadow-[0_2px_10px_rgba(0,0,0,0.05)]', t.state === 'closed' && 'opacity-60')}>
      <div className="relative h-14 overflow-hidden">
        <TileBanner icon={Icon} seed={`topic-${t.key}`} soft className="!absolute inset-0 h-full" />
        <div className="relative flex h-14 items-center px-4">
          <span className="inline-flex max-w-full items-center gap-2 rounded-[6px] border border-border/60 bg-background/90 px-3 py-1.5 backdrop-blur">
            <Icon className="size-3.5 shrink-0 text-muted-foreground/70" strokeWidth={1.75} />
            <span className="truncate text-[14px] font-semibold text-foreground/90">{t.name}</span>
          </span>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-1.5 px-4 py-3">
        <span className="line-clamp-2 text-[12.5px] leading-snug text-muted-foreground/80">{plain(t.who || t.line) || 'Comes up in your conversations.'}</span>
        <span className="mt-auto pt-2 text-[11.5px] text-muted-foreground/55">{TOPIC_KIND_LABEL[t.kind] || 'Topic'}{t.state ? ` · ${t.state}` : ''} · {t.n} memories · last mentioned {dayLabel(t.last).replace(/ \d{1,2}:\d{2}.*$/, '')}</span>
      </div>
    </button>
  );
}

/** One timeline entry. */
function TimelineItem({ it, onChanged }) {
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState(null);
  // A line is a fact (hidden or erased on its own) or, for a record that gave
  // none, the record itself.
  const act = async (op) => {
    setErr(null);
    try {
      if (it.factId) await post('/facts/bulk', { op, ids: [it.factId] });
      else await post(`/records/${encodeURIComponent(it.recordId)}/${op}`);
      onChanged?.();
    } catch (e) { setErr(e.message); }
  };
  return (
    <li className="relative pb-4 last:pb-0">
      <span className={cn('absolute -left-[25px] top-1.5 size-2 rounded-full ring-2 ring-background', it.kind === 'status' ? 'bg-blue-600' : 'bg-muted-foreground/40')} />
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] tabular-nums text-muted-foreground/60">{it.undated ? `by ${dayLabel(it.ts)}` : dayLabel(it.ts)}{it.scope !== 'private' && <> · {it.scope}</>}</div>
          <p className={cn('text-[13px] leading-snug', it.past ? 'text-muted-foreground/60' : 'text-foreground/85', it.supersededWhy === 'superseded' && 'line-through decoration-muted-foreground/40')}>{plain(it.text)}</p>
          {it.updates?.map((u, i) => <p key={i} className="mt-1 text-[12.5px] leading-snug text-foreground/80"><span className="mr-2 text-[11px] tabular-nums text-muted-foreground/60">Update · {shortDate(u.ts)}</span>{plain(u.text)}</p>)}
        </div>
        {/* The same quiet controls as a fact row: icons only until hovered, so the line stays readable. */}
        {it.mine && !confirm && (
          <span className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity hover:opacity-100 focus-within:opacity-100">
            <Button variant="ghost" size="xs" title="Hide this memory" aria-label="Hide" onClick={() => act('hide')}><EyeOff /></Button>
            <Button variant="ghost" size="xs" title="Erase from memory…" aria-label="Erase" className="hover:text-destructive" onClick={() => setConfirm(true)}><Trash2 /></Button>
          </span>
        )}
      </div>
      {confirm && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[11.5px] text-muted-foreground/75">Erase this memory for good?</span>
          <Button variant="destructive" size="xs" onClick={() => act('erase')}>Erase</Button>
          <Button variant="ghost" size="xs" onClick={() => setConfirm(false)}>Cancel</Button>
        </div>
      )}
      {err && <p className="text-[11.5px] text-destructive">{err}</p>}
    </li>
  );
}

/**
 * Who / what a topic is: the line built overnight from this viewer's own
 * records (with the record it comes from), editable by hand — after which new
 * information arrives as a suggestion to take or decline, never a silent
 * overwrite.
 */
function WhoLine({ topicKey, who, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState(null);
  const save = async (body) => {
    setErr(null);
    try { await post(`/topics/${encodeURIComponent(topicKey)}/who`, body); setEditing(false); onChanged(); } catch (e) { setErr(e.message); }
  };
  if (editing) {
    return (
      <div className="-mx-4 rounded-[6px] border border-border/50 bg-muted/20">
        <AddLine placeholder="Who or what this is, in one line" initial={who?.line || ''} onSave={(line) => save({ line })} onCancel={() => setEditing(false)} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="group flex items-start gap-2">
        <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-foreground/90">
          {who?.line || <span className="text-muted-foreground/60">No description yet — it is written overnight from your conversations, or you can add one.</span>}
        </p>
        <button type="button" onClick={() => setEditing(true)} title="Edit" className="mt-0.5 shrink-0 text-muted-foreground/45 transition-colors hover:text-foreground/80">
          <Pencil className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>
      {who?.line && (
        <p className="text-[11px] text-muted-foreground/55">
          {who.edited ? 'Your wording' : `As of ${who.updatedAt ? dayLabel(who.updatedAt).toLowerCase() : 'recently'}`}
          {!who.edited && who.evidence && <> · from “{who.evidence}”</>}
        </p>
      )}
      {who?.suggested && (
        <div className="flex flex-col gap-1.5 rounded-[6px] border border-blue-600/20 bg-blue-600/[0.04] px-3 py-2">
          <p className="text-[12.5px] leading-snug text-foreground/85"><span className="font-medium">New since your wording:</span> {who.suggested.line}</p>
          <div className="flex items-center gap-1.5">
            <Button size="xs" onClick={() => save({ takeSuggestion: true })}><Check />Use this</Button>
            <Button variant="ghost" size="xs" onClick={() => save({ declineSuggestion: true })}>Keep mine</Button>
          </div>
        </div>
      )}
      {err && <p className="text-[11.5px] text-destructive">{err}</p>}
    </div>
  );
}

/** "Same person?" for a bare first name that could be one of the full names shown. */
function MergeLine({ topic, candidates, onChanged }) {
  const [err, setErr] = useState(null);
  const decide = async (into, same) => {
    setErr(null);
    try { await post('/topics/alias', { from: topic.name, into, same }); onChanged(); } catch (e) { setErr(e.message); }
  };
  if (!candidates.length) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-[6px] border border-border/60 bg-muted/25 px-3 py-2">
      {candidates.map((c) => (
        <div key={c.key} className="flex flex-wrap items-center gap-2 text-[12.5px] text-foreground/85">
          <span className="min-w-0 flex-1">Is <span className="font-medium">{topic.name}</span> the same as <span className="font-medium">{c.name}</span>?</span>
          <Button variant="outline" size="xs" onClick={() => decide(c.name, true)}><Check />Same</Button>
          <Button variant="ghost" size="xs" onClick={() => decide(c.name, false)}>Different</Button>
        </div>
      ))}
      {err && <p className="text-[11.5px] text-destructive">{err}</p>}
    </div>
  );
}

export function TimelineModal({ topic, candidates, onClose, onChanged }) {
  const [all, setAll] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [err, setErr] = useState(null);
  const url = `${API}/topics/${encodeURIComponent(topic.key)}/timeline${all ? '?all=1' : ''}`;
  const { data, loading, reload } = useApi(url);
  const changed = useCallback(() => { reload(); refetch(`${API}/topics`); onChanged?.(); }, [reload, onChanged]);
  // Removing a topic takes the name off the tab; the memories stay. Undo lives in Changes.
  const remove = async () => {
    setErr(null);
    try { await post(`/topics/${encodeURIComponent(topic.key)}/dismiss`); refetch(`${API}/topics`); onChanged?.(); onClose(); } catch (e) { setErr(e.message); }
  };
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const Icon = KIND_ICON[topic.kind] || Hash;
  const first = data?.first || [];
  const items = data?.items || [];
  const hidden = Math.max(0, (data?.total || 0) - first.length - items.length);
  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden modal-panel">
        <div className="flex items-start gap-3 border-b border-border/40 px-6 py-4">
          <div className="flex size-8 shrink-0 items-center justify-center rounded border border-border/50 bg-muted/35 text-[--color-ring]/80">
            <Icon className="size-[18px]" strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-foreground/90">{topic.name}</div>
            <div className="text-[12px] text-muted-foreground/70">
              {topic.n} memories · from your conversations
              {topic.aliases?.length > 0 && <> · also “{topic.aliases.join('”, “')}”</>}
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-[6px] p-1.5 text-muted-foreground/65 hover:bg-muted/30 hover:text-foreground/85" aria-label="Close">
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-6 py-4">
          {loading && !data ? <p className="text-[12.5px] text-muted-foreground/65">Loading…</p> : (
            <>
              <WhoLine topicKey={topic.key} who={data?.who} onChanged={changed} />
              <MergeLine topic={topic} candidates={candidates} onChanged={() => { changed(); onClose(); }} />
              {items.length > 0 && (
                <section>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70">{all ? 'Everything, newest first' : 'Newest first'}</h3>
                  <ol className="relative border-l border-border/60 pl-5">{items.map((it) => <TimelineItem key={it.factId || it.recordId} it={it} onChanged={changed} />)}</ol>
                </section>
              )}
              {(hidden > 0 || all) && (
                <button type="button" onClick={() => setAll(!all)} className="self-start text-[12px] text-muted-foreground/70 underline-offset-2 hover:text-foreground/85 hover:underline">
                  {all ? 'Show latest only' : `Show all ${data.total} mentions`}
                </button>
              )}
              {/* Where the name came from: context, so it sits under what you opened the card for. */}
              {first.length > 0 && (
                <section className="border-t border-border/40 pt-4">
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70">How it came up</h3>
                  <ol className="relative border-l border-border/60 pl-5">{first.map((it) => <TimelineItem key={it.factId || it.recordId} it={it} onChanged={changed} />)}</ol>
                </section>
              )}
            </>
          )}
        </div>
        {/* Sticky footer, outside the scroll: the one action about the topic itself. */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border/40 px-6 py-3">
          {!confirmRemove ? (
            <Button variant="ghost" size="sm" className="text-muted-foreground/70 hover:text-destructive" onClick={() => setConfirmRemove(true)}><Trash2 />Remove this topic</Button>
          ) : (
            <>
              <span className="min-w-0 flex-1 text-[12px] text-muted-foreground/80">Remove “{topic.name}” from Topics? The memories stay; the name stops making a tile. Undo from Changes.</span>
              <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>Cancel</Button>
              <Button variant="destructive" size="sm" onClick={remove}>Remove</Button>
            </>
          )}
          {err && <p className="w-full text-[11.5px] text-destructive">{err}</p>}
        </div>
      </div>
    </div>
  );
}

function TopicsTab({ kind }) {
  const { data, loading, reload } = useApi(`${API}/topics`);
  const [open, setOpen] = useState(null);
  if (loading && !data) return <LoadingTiles count={8} min={280} />;
  const all = data?.items || [];
  const list = all.filter((t) => kind === 'all' || t.kind === kind);
  if (!list.length) return <Empty>Topics appear once a name comes up in at least two conversations.</Empty>;
  // A one-word topic next to full names starting with it: the server does not
  // merge on its own when there is more than one; the owner is asked instead.
  const candidatesFor = (t) => (t.name.includes(' ') ? [] : all.filter((o) => o.key !== t.key && o.name.includes(' ') && o.name.toLowerCase().startsWith(`${t.name.toLowerCase()} `)));
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
        {list.map((t) => <TopicTile key={t.key} t={t} onOpen={setOpen} />)}
      </div>
      {open && <TimelineModal topic={open} candidates={candidatesFor(open)} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

/* ────────────────────────────── preferences & rules ────────────────────────────── */

function PrefCard({ title, scope, lines, kb, budgetKb, onRemove, onAdd, addLabel = 'Add', footer }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex flex-col rounded-[6px] border border-border/60 bg-card">
      <div className="flex items-center gap-2 border-b border-border/40 px-4 py-3">
        <span className="text-[13px] font-semibold text-foreground/90">{title}</span>
        <ScopePill scope={scope} />
        <span className="ml-auto hidden text-[11px] text-muted-foreground/55 sm:inline">always in my context</span>
      </div>
      {lines.length ? (
        <ul className="flex-1 divide-y divide-border/25">
          {lines.map((l) => (
            <li key={l.key || l.text} className="group flex items-start gap-2 px-4 py-2">
              <CircleDot className="mt-1 size-2.5 shrink-0 text-muted-foreground/40" strokeWidth={2.5} />
              <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-foreground/85">{l.text}</span>
              {l.date && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/50">{shortDate(l.date)}</span>}
              {onRemove && (
                <button type="button" onClick={() => onRemove(l)} title="Remove"
                  className="mt-0.5 shrink-0 text-muted-foreground/0 transition-colors hover:text-destructive group-hover:text-muted-foreground/60">
                  <X className="size-3.5" strokeWidth={1.75} />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : <p className="px-4 py-3 text-[12.5px] text-muted-foreground/60">Nothing yet.</p>}
      {adding && <AddLine placeholder={addLabel} onCancel={() => setAdding(false)} onSave={async (t) => { await onAdd(t); setAdding(false); }} />}
      <div className="flex items-center gap-3 border-t border-border/40 px-4 py-2.5">
        {onAdd && !adding ? <Button variant="ghost" size="xs" onClick={() => setAdding(true)}><Plus />Add</Button> : <span />}
        {footer}
        {budgetKb != null && (
          <div className="ml-auto flex items-center gap-2">
            <div className="h-1 w-24 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-foreground/35" style={{ width: `${Math.min(100, (kb / budgetKb) * 100)}%` }} />
            </div>
            <span className="text-[10.5px] tabular-nums text-muted-foreground/60">{kb} / {budgetKb} KB</span>
          </div>
        )}
      </div>
    </div>
  );
}

function PrefsTab() {
  const { botDisplayName } = useBranding();
  const { data, loading, reload } = useApi(`${API}/prefs`);
  if (loading && !data) return <LoadingRows />;
  if (!data) return <Empty>Could not load.</Empty>;
  const card = (c) => async (text) => { await post('/prefs', { card: c, op: 'add', text }); reload(); };
  const removeCard = async (l) => { await post('/prefs', { op: 'remove', card: 'USER_PROFILE', text: l.text }).catch(() => {}); reload(); };
  return (
    <div className="flex flex-col gap-4">
      <PrefCard title="About you" scope="private" lines={data.about.lines.map((t) => ({ text: t }))} kb={data.about.kb} budgetKb={data.about.budgetKb}
        onAdd={card('USER_PROFILE')} onRemove={removeCard} addLabel="A fact about you, e.g. your role or timezone" />
      <PrefCard title="How you like things" scope="private"
        lines={[...data.likes.lines.map((t) => ({ text: t, card: true })), ...data.rules.map((r) => ({ text: r.text, date: r.date, rule: true, key: `rule:${r.text}` }))]}
        kb={data.likes.kb} budgetKb={data.likes.budgetKb}
        onAdd={async (text) => { await post('/rules', { text }); reload(); }}
        onRemove={async (l) => {
          if (l.rule) await post('/rules', { text: l.text, retired: true });
          else await post('/prefs', { op: 'remove', card: 'USER_PREFERENCES', text: l.text }).catch(() => {});
          reload();
        }}
        addLabel={`A standing rule for ${botDisplayName}, e.g. “short answers in chat”`} />
      {data.company && (
        <PrefCard title="About the company" scope="shared" lines={data.company.lines.map((t) => ({ text: t }))} kb={data.company.kb} budgetKb={data.company.budgetKb}
          onAdd={data.company.editable ? card('MISSION') : undefined}
          onRemove={data.company.editable ? async (l) => { try { await post('/prefs', { op: 'remove', card: 'MISSION', text: l.text }); } catch (e) { window.alert?.(`Could not remove the line: ${e.message}`); } reload(); } : undefined}
          addLabel="What the company does, for whom, how"
          footer={!data.company.editable && <span className="text-[11px] text-muted-foreground/55">Admins keep this card</span>} />
      )}
      <PrefCard title="Team rules" scope="shared" lines={data.team.lines.map((t) => ({ text: t }))} kb={data.team.kb} budgetKb={data.team.budgetKb}
        footer={!data.team.editable && <span className="text-[11px] text-muted-foreground/55">Admins change team rules</span>} />
      <div className="rounded-[6px] border border-dashed border-border/60 px-4 py-3 text-[12px] leading-relaxed text-muted-foreground/75">
        Routines — the things I do for you on a schedule — live in <span className="font-medium text-foreground/85">Routines</span>, not in memory.
      </div>
    </div>
  );
}

/* ────────────────────────────── sources ────────────────────────────── */

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function lastRunLine(s) {
  if (!s.lastRun) return 'Not read yet';
  if (s.lastError) return `Last try ${dayLabel(s.lastRun)}: ${s.lastError}`;
  return `Last read ${dayLabel(s.lastRun)} · ${plural(s.lastItems || 0, 'meeting')}, ${plural(s.lastFacts || 0, 'fact')}`;
}

/**
 * What feeds memory besides conversations: the person's connected
 * integrations that can (a meeting notetaker), each with its switch and its
 * last night. The same switch sits on the integration's card.
 */
function SourcesTab() {
  const navigate = useNavigate();
  const { data, loading, reload } = useApi(`${API}/sources`);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const flip = async (s) => {
    setBusy(s.id); setErr(null);
    try { await post(`/sources/${encodeURIComponent(s.key || s.id)}`, { on: !s.on }); reload(); } catch (e) { setErr(e.message); } finally { setBusy(null); }
  };
  if (loading && !data) return <LoadingColumns left={[4]} right={[3]} />;
  const items = data?.items || [];
  const hour = String(data?.hour ?? 2).padStart(2, '0');
  const feeds = (
      <div className="flex flex-col rounded-[6px] border border-border/60 bg-card">
        <div className="flex items-center gap-2 border-b border-border/40 px-4 py-3">
          <span className="text-[13px] font-semibold text-foreground/90">What feeds my memory</span>
          <ScopePill scope="private" />
          <span className="ml-auto hidden text-[11px] text-muted-foreground/55 sm:inline">each night at {hour}:00, your time</span>
        </div>
        <ul className="divide-y divide-border/25">
          {(data?.builtin || []).map((b) => {
            const Icon = SRC_ICON[b.id] || MessageCircle;
            return (
              <li key={b.id} className="flex items-center gap-3 px-4 py-3">
                <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/70"><Icon className="size-4" strokeWidth={1.75} /></span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-foreground/90">{b.label}</div>
                  <div className="text-[12px] text-muted-foreground/70">{b.what}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground/55">{b.records ? `Last day · ${plural(b.records, 'conversation')}, ${plural(b.facts, 'fact')}` : 'Nothing new in the last day'}</div>
                </div>
                <span className="text-[11px] text-muted-foreground/55">always on</span>
              </li>
            );
          })}
        </ul>
        {items.length ? (
          <ul className="divide-y divide-border/25 border-t border-border/25">
            {items.map((s) => (
              <li key={s.key || s.id} className="flex items-center gap-3 px-4 py-3">
                <img src={logoUrl(s.logo)} alt="" className={cn('size-5 shrink-0 object-contain', !s.on && 'opacity-50 grayscale')} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13px] font-medium text-foreground/90">{s.label}{!s.on && <Pill>off</Pill>}</div>
                  <div className="text-[12px] text-muted-foreground/70">{s.what}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground/55">{lastRunLine(s)}</div>
                </div>
                <Toggle small on={s.on} busy={busy === s.id} label={`Feed memory from ${s.label}`} onClick={() => flip(s)} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-[12.5px] text-muted-foreground/60">Nothing connected yet that can feed memory.</p>
        )}
      </div>
  );
  const could = (data?.available || []).length > 0 && (
        <div className="flex flex-col rounded-[6px] border border-border/60 bg-card">
          <div className="flex items-center gap-2 border-b border-border/40 px-4 py-3">
            <span className="text-[13px] font-semibold text-foreground/90">Could feed my memory</span>
            <span className="ml-auto hidden text-[11px] text-muted-foreground/55 sm:inline">not connected yet</span>
          </div>
          <ul className="divide-y divide-border/25">
            {data.available.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-4 py-2.5">
                <img src={logoUrl(a.logo)} alt="" className="size-5 shrink-0 object-contain opacity-60 grayscale" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-foreground/85">{a.label}</div>
                  <div className="text-[12px] text-muted-foreground/65">{a.what}</div>
                </div>
                <Button variant="ghost" size="xs" onClick={() => navigate(`/integrations?tab=marketplace&category=${encodeURIComponent(a.kind)}`)}><Plug />Connect</Button>
              </li>
            ))}
          </ul>
        </div>
  );
  return (
    <div className="flex flex-col gap-4">
      {err && <p className="text-[12px] text-destructive">{err}</p>}
      <Columns left={feeds} right={could || null} narrow={<>{feeds}{could}</>} />
    </div>
  );
}

/* ────────────────────────────── privacy ────────────────────────────── */

/** The facts a record holds, one per line — what the person actually sees of a record. */
function FactLines({ facts, muted }) {
  return (
    <ul className={cn('flex flex-col gap-0.5 text-[13px] leading-snug', muted ? 'text-muted-foreground/85' : 'text-foreground/85')}>
      {facts.map((t, i) => <li key={i} className="flex gap-2"><span className="select-none text-muted-foreground/45">·</span><span className="min-w-0">{plain(t)}</span></li>)}
    </ul>
  );
}

/* ────────────────────────────── sharing ────────────────────────────── */

const MODES = [
  ['ask', 'Ask me first', 'Work facts from your private chats wait here until you say so.'],
  ['auto', 'Share work facts by itself', 'Facts about projects, companies and the team’s work go to the team. Anything about you or another person still asks.'],
  ['never', 'Never by itself', 'Nothing crosses unless you share it by hand.'],
];

const COLUMN_MIN = 240 + 230 + 48;   // text + actions + padding and gaps, in px
const COLUMN_GAP = 28;               // the gutter between the two columns (gap-7)

/**
 * True while the node is at least `min` px wide — the panel's own width, not
 * the window's. Takes the node itself (from a callback ref), so it attaches
 * when the element appears, not only on the first render.
 */
function useWide(node, min) {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setWide(e.contentRect.width >= min));
    ro.observe(node);
    return () => ro.disconnect();
  }, [node, min]);
  return wide;
}

/**
 * Two real columns when the panel is wide enough for a row in each (see
 * COLUMN_MIN), one column in `narrow` order otherwise. Real columns, not grid
 * rows, so a shorter column never waits for the taller one.
 */
export function Columns({ left, right, narrow }) {
  const [box, setBox] = useState(null);
  const wide = useWide(box, COLUMN_MIN * 2 + COLUMN_GAP);
  return (
    <div ref={setBox} className="flex flex-col gap-7">
      {wide ? (
        <div className="grid grid-cols-2 items-start gap-7" style={{ columnGap: COLUMN_GAP }}>
          <div className="flex flex-col gap-7">{left}</div>
          <div className="flex flex-col gap-7">{right}</div>
        </div>
      ) : narrow}
    </div>
  );
}

/** A section while it loads: the heading's line, then ruled rows. */
function LoadingSection({ rows = 5 }) {
  return (
    <div className="flex flex-col gap-2.5">
      <Skeleton className="h-2.5 w-36" />
      <LoadingRows count={rows} />
    </div>
  );
}

/** The two-column tabs load in their own shape: `left`/`right` are the row counts per section. */
export function LoadingColumns({ left = [5], right = [6] }) {
  const col = (ns) => ns.map((n, i) => <LoadingSection key={i} rows={n} />);
  return <Columns left={col(left)} right={col(right)} narrow={col([...left, ...right])} />;
}

/** The person's choice of what reaches the team by itself: three rows, one ticked. */
function ModeCard({ mode, onChange }) {
  return (
    <div className="overflow-hidden rounded-[6px] border border-border/60 bg-card">
      {MODES.map(([v, label, hint]) => (
        <button key={v} type="button" role="radio" aria-checked={mode === v} onClick={() => mode !== v && onChange(v)}
          className={cn('flex w-full items-start gap-3 border-b border-border/30 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/30', mode === v && 'bg-muted/25')}>
          <span className={cn('mt-[3px] flex size-4 shrink-0 items-center justify-center rounded-full border', mode === v ? 'border-foreground/80' : 'border-border')}>
            {mode === v && <span className="size-2 rounded-full bg-foreground" />}
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-medium leading-5 text-foreground/90">{label}</span>
            <span className="block text-[12px] leading-snug text-muted-foreground/70">{hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** The first few rows of a list, the rest behind "See N more" at the card's foot. */
function Fold({ items, limit = 5, children }) {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, limit);
  return (
    <>
      {shown.map(children)}
      {items.length > limit && (
        <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-center gap-1 border-t border-border/30 px-4 py-2 text-[12px] text-muted-foreground/70 hover:bg-muted/30 hover:text-foreground">
          {open ? 'Show less' : `See ${items.length - limit} more`}
        </button>
      )}
    </>
  );
}

/** One fact as a row: its title over its sentence, the pills, then the actions on the right. */
function ShareRow({ f, source, ts, children, muted = false }) {
  return (
    <div className="flex flex-col items-start gap-2.5 border-b border-border/30 px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        {f.title
          ? <p className={cn('text-[13px] font-medium leading-5', muted ? 'text-muted-foreground/80' : 'text-foreground/90')}>{f.title}</p>
          : null}
        <p className={cn('text-[12.5px] leading-snug', f.title ? 'text-muted-foreground/80' : muted ? 'text-muted-foreground/80' : 'text-foreground/85')}>{plain(f.text)}</p>
        <p className="mt-1 whitespace-nowrap text-[11px] text-muted-foreground/55">{source ? `from your ${SRC_LABEL[source] || 'conversation'} · ` : ''}{dayLabel(ts)}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

/**
 * Sharing — what from this person's private chats reaches the team, and how.
 * Their mode, the facts waiting for their answer, the facts they shared (each
 * one a row, takeable back), the rules they set, then hidden and erased.
 */
function SharingTab() {
  const { data, loading, reload } = useApi(`${API}/privacy`);
  const [err, setErr] = useState(null);
  const [undo, setUndo] = useState(null);   // { id, title } of the fact just made private
  const run = async (fn) => { setErr(null); try { await fn(); reload(); refetch(`${API}/facts?history=1&limit=500`); } catch (e) { setErr(e.message); } };
  if (loading && !data) return <LoadingColumns left={[3, 3]} right={[6]} />;
  if (!data) return <Empty>Could not load.</Empty>;
  const asks = data.asks || [];
  const rules = data.rules || [];
  const subjectOf = (a) => a.fact?.subject && !a.aboutPerson ? a.fact.subject : null;
  const settings = (
    <>
      {/* Solo workspace: there is no team to share with; the mode and the lists are noise. */}
      {data.teamMode && (
        <>
          <Section title="What reaches the team by itself">
            <ModeCard mode={data.mode || 'ask'} onChange={(mode) => run(() => post('/sharing/mode', { mode }))} />
          </Section>
          {/* The standing rules the person set from a question ("and always for Vellmark"), beside the mode they refine. */}
          <Section title="Your rules">
            {rules.length ? (
              <div className="overflow-hidden rounded-[6px] border border-border/60 bg-card">
                {rules.map((r) => (
                  <div key={r.subject} className="flex items-center gap-4 border-b border-border/30 px-4 py-3 last:border-b-0">
                    <p className="min-w-0 flex-1 text-[13px] leading-5 text-foreground/85">{r.decision === 'share' ? 'Always share work facts about ' : 'Keep everything about '}<span className="font-medium">{r.subject}</span>{r.decision === 'share' ? '' : ' private'}</p>
                    <Button variant="ghost" size="xs" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => run(() => post('/sharing/rules/clear', { subject: r.subject }))}><X />Remove</Button>
                  </div>
                ))}
              </div>
            ) : <Empty>No rules yet. Answer a question with “always for …” and it appears here.</Empty>}
          </Section>
        </>
      )}

    </>
  );
  const waiting = (
    <>
      <Section title={`Waiting for your OK · ${asks.length}`}
        right={asks.length > 1
          ? <span className="flex items-center gap-1">
              <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground" onClick={() => run(() => post('/asks/batch', { ids: asks.map((a) => a.id), decision: 'share' }))}><Send />Share all</Button>
              <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground" onClick={() => run(() => post('/asks/batch', { ids: asks.map((a) => a.id), decision: 'keep' }))}><Lock />Keep all</Button>
            </span>
          : <span className="text-[11.5px] text-muted-foreground/55">Stays private until you decide</span>}>
        {asks.length ? (
          <div className="overflow-hidden rounded-[6px] border border-border/60 bg-card">
            <Fold items={asks}>{(a) => (
              <ShareRow key={a.id} f={a.fact ? { ...a.fact, aboutPerson: a.aboutPerson } : { text: a.text }} reason={a.reason} source={a.source} ts={a.ts}>
                {/* The two answers keep every row's action column the same width; the
                    standing rule ("and always for this subject") is a quiet line under them. */}
                <span className="flex flex-col items-end gap-1">
                  <span className="flex items-center gap-1.5">
                    <Button variant="outline" size="sm" onClick={() => run(() => post(`/asks/${a.id}`, { decision: 'share' }))}><Send />Share</Button>
                    <Button variant="ghost" size="sm" onClick={() => run(() => post(`/asks/${a.id}`, { decision: 'keep' }))}><Lock />Keep private</Button>
                  </span>
                  {subjectOf(a) && (
                    <button type="button" className="max-w-[240px] truncate text-[11.5px] text-muted-foreground/60 hover:text-foreground hover:underline" title={`Share this, and every work fact about ${subjectOf(a)} from now on`}
                      onClick={() => run(() => post(`/asks/${a.id}`, { decision: 'share', rememberSubject: true }))}>Share, and always for {subjectOf(a)}</button>
                  )}
                </span>
              </ShareRow>
            )}</Fold>
          </div>
        ) : <Empty>Nothing waiting.</Empty>}
      </Section>

    </>
  );
  const sharedList = (whole) => (
    <>
      {data.teamMode && (
        <Section title="Shared with the team" right={<span className="text-[11.5px] text-muted-foreground/55">Last 60 days</span>}>
          {undo && (
            <div className="flex items-center justify-between gap-3 rounded-[6px] border border-border/60 bg-muted/30 px-4 py-2 text-[12.5px]">
              <span className="min-w-0 truncate text-foreground/85">Made private: {undo.title}</span>
              <Button variant="ghost" size="xs" className="shrink-0" onClick={() => run(async () => { await post(`/shared/${undo.id}/restore`); setUndo(null); })}><Undo2 />Undo</Button>
            </div>
          )}
          {data.sharedFromMe.length ? (
            <div className="overflow-hidden rounded-[6px] border border-border/60 bg-card">
              {/* In its own column the list runs whole; in one column it folds like the rest. */}
              <Fold items={data.sharedFromMe} limit={whole ? Infinity : 5}>{(x) => (
                <ShareRow key={x.id} f={x} source={x.source} ts={x.ts}>
                  <Button variant="outline" size="sm" onClick={() => run(async () => { await post(`/shared/${x.id}/withdraw`); setUndo({ id: x.id, title: x.title || plain(x.text).slice(0, 60) }); })}><Lock />Make private</Button>
                </ShareRow>
              )}</Fold>
            </div>
          ) : <Empty>Nothing shared from your private chats recently.</Empty>}
        </Section>
      )}

    </>
  );
  const hidden = (
    <>
      {data.hidden.length > 0 && (
        <Section title="Hidden">
          <div className="overflow-hidden rounded-[6px] border border-border/60 bg-card">
            <Fold items={data.hidden}>{(h) => (
              <div key={h.id} className="flex flex-col items-start gap-2.5 border-b border-border/30 px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-4">
                <div className="min-w-0 flex-1">
                  {h.facts?.length
                    ? <FactLines facts={h.facts} muted />
                    : <p className="line-clamp-2 text-[13px] leading-snug text-muted-foreground/85">{h.text}</p>}
                  <p className="mt-1 text-[11.5px] text-muted-foreground/55">Erased for good on {shortDate(h.eraseOn)} unless you restore it</p>
                </div>
                <Button variant="outline" size="sm" className="shrink-0" onClick={() => run(() => post(`/records/${h.id}/unhide`))}><Undo2 />Restore</Button>
              </div>
            )}</Fold>
          </div>
        </Section>
      )}

    </>
  );
  const erased = (
    <>
      <Section title="Erased">
        {data.erased.length ? (
          <div className="overflow-hidden rounded-[6px] border border-border/60 bg-card">
            <Fold items={data.erased}>{(r, i) => (
              <div key={i} className="flex items-center gap-4 border-b border-border/30 px-4 py-3 last:border-b-0">
                <EyeOff className="hidden size-3.5 shrink-0 text-muted-foreground/55 sm:block" strokeWidth={1.75} />
                <p className="min-w-0 flex-1 text-[13px] text-muted-foreground/80">{r.removed} record{r.removed === 1 ? '' : 's'} erased by {r.by}; nothing about {r.removed === 1 ? 'it' : 'them'} is kept.</p>
                <span className="shrink-0 text-[11.5px] text-muted-foreground/55">{dayLabel(r.ts)}</span>
              </div>
            )}</Fold>
          </div>
        ) : <Empty>Nothing erased.</Empty>}
      </Section>
    </>
  );
  return (
    <div className="flex flex-col gap-7">
      {err && <p className="text-[12px] text-destructive">{err}</p>}
      {/* Everything the person sets and answers on the left; what the team has
          from them — usually the longest list — on the right, whole. */}
      {data.teamMode
        ? <Columns left={<>{settings}{waiting}{hidden}{erased}</>} right={sharedList(true)} narrow={<>{settings}{waiting}{sharedList(false)}{hidden}{erased}</>} />
        : <>{waiting}{hidden}{erased}</>}
    </div>
  );
}
/* ────────────────────────────── changes ────────────────────────────── */

const CHANGE_ICON = { file: MessageCircle, share: Send, keep_private: Lock, note: NotebookPen, hide: EyeOff, unhide: Undo2, redact: Trash2, review: ListChecks, dismiss_topic: Trash2, restore_topic: Undo2, hide_fact: EyeOff, unhide_fact: Undo2, erase_fact: Trash2, alias: Replace };

/**
 * What happened to memory — the v4 event feed (conversations remembered,
 * shares, hides, erasures, reviews), followed by the engine's own write log for
 * the cards that still go through it.
 */
function ChangesTab() {
  const { data, loading, reload } = useApi(`${API}/changes`);
  const [err, setErr] = useState(null);
  const undo = async (c) => {
    setErr(null);
    try {
      if (c.undo === 'restore_topic') await post(`/topics/${encodeURIComponent(c.topicKey)}/restore`);
      else if (c.undo === 'unhide_fact') await post('/facts/unhide', { ids: c.factIds || [] });
      else await post(`/records/${encodeURIComponent(c.recordId)}/${c.undo}`);
      reload(); refetch(`${API}/privacy`); refetch(`${API}/topics`);
    } catch (e) { setErr(e.message); }
  };
  const items = data?.items || [];
  // One log: what happened to memory (remembered, shared, hidden, erased…).
  // The old engine's card log used to sit beside it as "Card changes" — every
  // entry from before the v4 migration, nothing the person could act on.
  return (
    <div className="flex flex-col gap-4">
      {err && <p className="text-[12px] text-destructive">{err}</p>}
      {loading && !data ? <LoadingRows /> : items.length ? (
        <div className="overflow-hidden rounded-[6px] border border-border/60 bg-card">
          {items.map((c, i) => {
            const Icon = CHANGE_ICON[c.op] || CircleDot;
            return (
              <div key={i} className="flex items-start gap-3 border-b border-border/30 px-4 py-2.5 last:border-b-0">
                <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/55" strokeWidth={1.75} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
                    <span className="font-medium text-foreground/90">{c.label}</span>
                    {c.detail && <span className="text-muted-foreground/75">{c.detail}</span>}
                    {c.scope !== 'private' && <ScopePill scope={c.scope} />}
                  </div>
                  {c.preview && <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-muted-foreground/85">{c.preview}</p>}
                  <p className="mt-0.5 text-[11px] text-muted-foreground/55">{dayLabel(c.ts)}{c.by && c.by !== 'you' && <> · by {c.by}</>}{c.source && <> · {SRC_LABEL[c.source] || c.source}</>}</p>
                </div>
                {c.undo && <Button variant="outline" size="xs" className="shrink-0" onClick={() => undo(c)}><Undo2 />Undo</Button>}
              </div>
            );
          })}
        </div>
      ) : <Empty>Nothing yet. Conversations are remembered when they end.</Empty>}
    </div>
  );
}

/* ────────────────────────────── the view ────────────────────────────── */

export default function MemoryV4View({ sidebarOpen }) {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  // "privacy" was the tab's earlier name; links to it still open Sharing.
  const [tab, setTab] = useState((params.get('tab') || (params.get('q') ? 'facts' : 'short')).replace(/^privacy$/, 'sharing'));
  const [query, setQuery] = useState(params.get('q') || '');
  const [scope, setScope] = useState('all');
  const [history, setHistory] = useState(false);
  const [kind, setKind] = useState('all');
  const facts = useApi(`${API}/facts?history=1&limit=500`).data;
  const topics = useApi(`${API}/topics`).data;
  const privacy = useApi(`${API}/privacy`).data;
  const sourcesTab = useApi(`${API}/sources`).data;

  const meta = (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" strokeWidth={1.75} />
      <input
        value={query}
        onChange={(e) => { setQuery(e.target.value); if (e.target.value && tab !== 'facts') setTab('facts'); }}
        placeholder="Ask what I remember…"
        className="h-7 w-40 rounded-[6px] border border-border/55 bg-background pl-7 pr-2 text-[12.5px] text-foreground outline-none transition-colors focus:border-foreground/40 sm:w-64"
      />
    </div>
  );

  // The pages, split in two: what is remembered, and how.
  const MAIN = [
    ['short', 'Short-term memory'],
    ['facts', 'Facts', facts?.items ? facts.items.filter((f) => !f.past).length : undefined],   // what the tab shows by default: past ones sit behind the toggle
    ['topics', 'Topics', topics?.items?.length],
  ];
  const MORE = [
    ['sources', 'Sources', undefined, Cable],
    ['prefs', 'Preferences & rules', undefined, BookOpen],
    ...(privacy?.teamMode === false ? [] : [['sharing', 'Sharing', privacy?.asks?.length, ShieldCheck]]),
    ['changes', 'Changes', undefined, History],
  ];
  const inMore = MORE.some(([id]) => id === tab);

  const body = (
    <>
      {tab === 'short' && <Overview />}
      {tab === 'facts' && (query ? <SearchResults query={query} /> : (
        (() => { const filters = (
          <>
            <FilterLinks value={scope} onChange={setScope} options={[['all', 'All'], ['shared', 'Shared'], ['private', 'Only mine']]} />
            <span className="h-3.5 w-px bg-border" />
            <ToggleLink on={history} onChange={setHistory} icon={History}>Past &amp; superseded</ToggleLink>
          </>
        ); return <FactsTab scope={scope} history={history} filters={filters} />; })()
      ))}
      {/* Each main tab opens the same way: a 20px first row (a section's
          heading, or the filters), then its card 10px below. */}
      {tab === 'topics' && (
        <div className="flex flex-col gap-2.5">
          <div className="flex min-h-5 flex-wrap items-center gap-x-4 gap-y-2 leading-5">
            <FilterLinks value={kind} onChange={setKind} options={[['all', 'All'], ['project', 'Projects'], ['person', 'People'], ['company', 'Companies'], ['topic', 'Topics']]} />
          </div>
          <TopicsTab kind={kind} />
        </div>
      )}
      {tab === 'prefs' && <PrefsTab />}
      {tab === 'sources' && <SourcesTab />}
      {tab === 'sharing' && <SharingTab />}
      {tab === 'changes' && <ChangesTab />}
    </>
  );

  const iconLink = ([id, label, count, Icon]) => (
    <button key={id} type="button" onClick={() => setTab(id)} aria-label={label} className={cn('group/nav relative flex size-8 items-center justify-center rounded-[6px] transition-colors', tab === id ? 'bg-muted/70 text-foreground' : 'text-muted-foreground/65 hover:bg-muted/40 hover:text-foreground/85')}>
      <span role="tooltip" className="pointer-events-none absolute right-0 top-full z-30 mt-1.5 hidden w-max rounded bg-popover px-2.5 py-1.5 text-[12px] font-normal leading-none text-popover-foreground/90 shadow-md ring-1 ring-foreground/10 group-hover/nav:block">{label}</span>
      <Icon className="size-4" strokeWidth={1.75} />
      {id === 'sharing' && count ? <span className="absolute right-1 top-1 size-1.5 rounded-full bg-red-500" aria-label="Questions wait" /> : null}
    </button>
  );

  // Three tabs for what is remembered; the pages about how, as quiet icons on the right.
  const navEl = (
    <div className="relative">
      <TabBar value={inMore ? null : tab} onChange={setTab} tabs={MAIN} />
      <div className="absolute bottom-1 right-0 flex items-center gap-1">{MORE.map(iconLink)}</div>
    </div>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <EditorHeader icon={Brain} title="Memory" meta={meta} sidebarOpen={sidebarOpen} />
      {/* The navigation is a still row under the header, like the header itself, while the page scrolls. */}
      <div className="shrink-0 px-4 pt-2 sm:px-6">{navEl}</div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex flex-col gap-6 px-4 pb-12 pt-4 sm:px-6">
          {body}
        </div>
      </div>
    </div>
  );
}
