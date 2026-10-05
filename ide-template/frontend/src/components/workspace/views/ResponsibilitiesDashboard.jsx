import { useEffect, useMemo, useState, createElement } from 'react';
import {
  Repeat, CheckCircle2, ChevronRight, X,
  Mail, CalendarClock, Clock, MessageCircle, Users, FileText, Receipt, DollarSign,
  ListChecks, Bell, RefreshCw, Search, Star, Megaphone, Activity, Shield, Rocket,
  Link as LinkIcon, BookOpen, TrendingUp, Eye, AlertTriangle, FolderOpen,
  Sun, CloudSun, Plus, Pencil, Trash2, Loader2,
} from 'lucide-react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import EditorHeader from '../EditorHeader.jsx';
import TileBanner from './TileBanner.jsx';
import { useBranding, BrandedImage, BOT_FALLBACK } from '../identity';
import { useApi, refetch } from '@/lib/useApi';
import { useNavigate } from 'react-router-dom';
import { Tabs, logoUrl, SearchField, ActivateModal } from './IntegrationsDashboard.jsx';
import { isRemoteMcpOauth, isOpenServer, openOAuthPopup } from './integrationConnect.js';
import { cn } from '@/lib/utils';
import { SkeletonList } from '@/components/ui/Skeleton';
import useMe from '../useMe.js';
import { useMemoryStatus } from '../useMemoryStatus.js';

// The RESPONSIBILITIES card (the bot's duties TOWARD this user) is per-user in team
// mode (memory/users/<slug>/), flat in solo. Resolve the current user's path from
// /api/me's personalRoot (`users/<slug>` in team, null in solo).
function cardUrlFor(me) {
  const p = me?.personalRoot
    ? `memory/${me.personalRoot}/RESPONSIBILITIES.md`
    : 'memory/RESPONSIBILITIES.md';
  return `/api/files/read?path=${encodeURIComponent(p)}`;
}

// Curated icon palette. The bot prefixes a duty with a {name} token in the card;
// we map it here. Synonyms point at the same icon so the bot has some latitude.
// Unknown / missing → the default CheckCircle2.
const ICON_MAP = {
  mail: Mail, inbox: Mail, email: Mail,
  calendar: CalendarClock, deadline: CalendarClock, schedule: CalendarClock, renewal: CalendarClock,
  clock: Clock, time: Clock, hourly: Clock,
  message: MessageCircle, thread: MessageCircle, chat: MessageCircle, followup: MessageCircle, reply: MessageCircle,
  users: Users, team: Users, meeting: Users, people: Users,
  file: FileText, document: FileText, report: FileText, notes: FileText, digest: FileText,
  receipt: Receipt, invoice: Receipt,
  money: DollarSign, finance: DollarSign, billing: DollarSign,
  tasks: ListChecks, board: ListChecks, checklist: ListChecks, todo: ListChecks,
  bell: Bell, reminder: Bell, alert: Bell,
  refresh: RefreshCw, sync: RefreshCw, reconcile: RefreshCw,
  search: Search, monitor: Search,
  star: Star, priority: Star, important: Star,
  megaphone: Megaphone, announce: Megaphone, broadcast: Megaphone,
  activity: Activity, status: Activity, pulse: Activity,
  shield: Shield, security: Shield,
  rocket: Rocket, ship: Rocket, deploy: Rocket, launch: Rocket, release: Rocket,
  link: LinkIcon,
  book: BookOpen, docs: BookOpen, read: BookOpen,
  trend: TrendingUp, growth: TrendingUp, metrics: TrendingUp, analytics: TrendingUp,
  watch: Eye, eye: Eye,
  warning: AlertTriangle, risk: AlertTriangle,
  folder: FolderOpen, files: FolderOpen,
  sun: Sun, weather: CloudSun, forecast: CloudSun,
  check: CheckCircle2, task: CheckCircle2, done: CheckCircle2,
};

function dutyIcon(name) {
  return (name && ICON_MAP[name]) || CheckCircle2;
}

// Drop the YAML frontmatter block (operational directives for the bot) and the
// HTML-comment example hints — the user should see the duties, not the plumbing.
function cardBody(md) {
  if (!md) return '';
  let out = md.replace(/^---\n[\s\S]*?\n---\n?/, '');
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  return out.trim();
}

// Parse the card into a single flat list of responsibilities. Each bullet is
// `{icon} **Title** — description #tags` (icon token + short bold title +
// description prose carrying the frequency / condition + inline #tags).
function parseRole(md) {
  const body = cardBody(md);
  const sections = {};
  let cur = null;
  for (const line of body.split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { cur = h[1].trim().toLowerCase(); sections[cur] = []; continue; }
    if (cur) sections[cur].push(line);
  }
  // A duty is normally `- {icon} **Title** — description #tags`. Accept it
  // without the leading marker too: the card is written by the model, and a
  // missing `-` used to make the entry vanish from this view with no trace,
  // which reads as "the bot never saved it" and sends everyone hunting the
  // wrong bug. A bold title is signal enough that the line is a duty.
  const DUTY_LINE = /^\s*(?:[-*]\s+)?((?:\{[a-z0-9-]+\}|[a-z0-9-]+)?\s*\*\*.+)$/i;
  const unparsed = [];
  const bullets = (name) => (sections[name] || []).reduce((acc, l) => {
    const line = l.trim();
    if (!line) return acc;
    const m = line.match(DUTY_LINE);
    if (m) acc.push(m[1].trim());
    else unparsed.push(line);
    return acc;
  }, []);

  const duties = (name) => bullets(name).map((raw) => {
    const retired = /^~~[\s\S]*~~$/.test(raw);
    let clean = raw.replace(/^~~|~~$/g, '').trim();
    let icon = null;
    // `{mail} **…**` is the spec; `mail **…**` is what the model writes when it
    // drops the braces. Both name the same icon.
    const im = clean.match(/^\{([a-z0-9-]+)\}\s*/i) || clean.match(/^([a-z0-9-]+)\s+(?=\*\*)/i);
    if (im) { icon = im[1].toLowerCase(); clean = clean.slice(im[0].length); }
    const bold = clean.match(/^\*\*(.+?)\*\*\s*([\s\S]*)$/);
    const title = bold ? bold[1].trim() : clean;
    let description = bold ? bold[2].replace(/^[—–:-]\s*/, '').trim() : '';
    const tags = [];
    description = description.replace(/#([\w-]+)/g, (_m, t) => { tags.push(t.toLowerCase()); return ''; }).replace(/\s{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
    return { title, description, icon, tags, retired };
  });

  // One flat list — the "Responsibilities" section, merged with the older
  // two-section format (Recurring duties / Proactive watch) so existing cards
  // still render. ("Boundaries" is deliberately NOT read — it's a fixed policy
  // the bot keeps in the card; this UI only ever shows the responsibilities list.)
  const all = [
    ...duties('responsibilities'),
    ...duties('duties'),
    ...duties('recurring duties'),
    ...duties('proactive watch'),
  ];
  // Anything in those sections this parser could not read. Returned rather than
  // dropped: an empty list with lines sitting in the file is the failure mode
  // that cost a user three rounds of "it's broken" / "no it isn't".
  return { duties: all, unparsed };
}

/**
 * Lines on the duties card (or in routines.json) the routine grammar cannot
 * read. Before memory v4 the only way out was asking the bot to rewrite them;
 * with v4 the owner places each one: it was a fact (→ memory) or it is a routine
 * (→ give it a title). Nothing is dropped either way.
 */
function UnparsedLines({ lines, v4, botDisplayName, onChanged }) {
  const [titling, setTitling] = useState(null);   // the line being given a title
  const [title, setTitle] = useState('');
  const [err, setErr] = useState(null);
  const place = async (line, as) => {
    setErr(null);
    try {
      const r = await fetch('/api/routines/unparsed', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line, as, title }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.ok === false) throw new Error(d.error || `HTTP ${r.status}`);
      setTitling(null); setTitle('');
      onChanged?.();
    } catch (e) { setErr(e.message); }
  };
  const [open, setOpen] = useState(false);
  // Quiet by default: one muted line; the details only when asked for.
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="inline-flex w-fit items-center gap-1.5 text-[12px] text-muted-foreground/70 transition-colors hover:text-foreground/85">
        <span className="size-1.5 rounded-full bg-amber-500/80" aria-hidden />
        {lines.length === 1 ? '1 line needs a look' : `${lines.length} lines need a look`}
        <ChevronRight className="size-3" strokeWidth={2} />
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-2 text-[12.5px] text-muted-foreground/80">
      <button type="button" onClick={() => setOpen(false)}
        className="inline-flex w-fit items-center gap-1.5 text-[12px] text-muted-foreground/70 transition-colors hover:text-foreground/85">
        <span className="size-1.5 rounded-full bg-amber-500/80" aria-hidden />
        {lines.length === 1 ? 'A line that is not a routine yet' : `${lines.length} lines that are not routines yet`}
        <ChevronRight className="size-3 rotate-90" strokeWidth={2} />
      </button>
      <p className="max-w-2xl">
        {v4
          ? 'Say what each one is: a fact about you goes to memory; a routine gets a title.'
          : <>Nothing was lost — ask {botDisplayName} to turn {lines.length === 1 ? 'it' : 'them'} into a routine.</>}
      </p>
      <ul className="flex flex-col gap-1.5">
        {lines.map((l) => (
          <li key={l} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
            <span className="min-w-0 flex-1 truncate border-l-2 border-border pl-2.5 text-foreground/75">{l.replace(/^[-*]\s+/, '')}</span>
            {v4 && titling !== l && (
              <span className="flex shrink-0 items-center gap-1.5">
                <button type="button" onClick={() => place(l, 'memory')} className="rounded-[6px] border border-border/60 bg-background px-2 py-1 text-[12px] hover:border-foreground/30">It's a fact → memory</button>
                <button type="button" onClick={() => { setTitling(l); setTitle(''); }} className="rounded-[6px] border border-border/60 bg-background px-2 py-1 text-[12px] hover:border-foreground/30">Make it a routine</button>
              </span>
            )}
            {v4 && titling === l && (
              <span className="flex shrink-0 items-center gap-1.5">
                <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short title" onKeyDown={(e) => { if (e.key === 'Enter') place(l, 'routine'); if (e.key === 'Escape') setTitling(null); }}
                  className="h-7 w-40 rounded-[6px] border border-border/55 bg-background px-2 text-[12px] outline-none focus:border-foreground/40" />
                <button type="button" onClick={() => place(l, 'routine')} className="rounded-[6px] bg-foreground px-2 py-1 text-[12px] text-background">Save</button>
                <button type="button" onClick={() => setTitling(null)} className="px-1 text-[12px] text-muted-foreground">Cancel</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {err && <p className="mt-1.5 text-[12px] text-destructive">{err}</p>}
    </div>
  );
}

// Section — matches the Reminders / Skills / Notifications vocabulary.
function Section({ title, children }) {
  return (
    <section className="flex flex-col gap-2.5">
      {title && (
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70">
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

// One routine as a tile with a side banner: a narrow halftone column of its
// icon on the left (each drawn from its own title, so no two look alike), the
// title with the integrations it uses and what it does; below, Open on the
// left, Edit and Delete on the right (Delete asks in a modal, like Skills').
function DutyTile({ duty, onOpen, onEdit, onDelete, integrations = [] }) {
  const quiet = 'inline-flex items-center gap-1 rounded-[6px] px-2 py-1 text-[12px] font-medium transition-colors';
  return (
    <div className="group relative flex min-h-[124px] overflow-hidden rounded-[6px] border border-border/60 bg-card transition-all duration-150 hover:border-foreground/15 hover:shadow-[0_2px_6px_rgba(0,0,0,0.035)]">
      <button type="button" onClick={() => onOpen(duty)} aria-label={`Open ${duty.title}`} className="relative w-[92px] shrink-0 border-r border-border/50">
        <TileBanner icon={dutyIcon(duty.icon)} seed={duty.title} soft center scale={0.62} className="!absolute inset-0 !h-full" />
      </button>
      <div className="flex min-w-0 flex-1 flex-col px-4 pb-2.5 pt-3.5">
        <button type="button" onClick={() => onOpen(duty)} className="min-w-0 text-left">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[14px] font-semibold text-foreground/90">{duty.title}</span>
            {/* On a routine of yours: only what is connected — it says what the routine runs on, not what it could. */}
            <LogoRow integrations={integrations.filter((i) => i.connected)} />
          </div>
          {(duty.summary || duty.description) && (
            <div className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground/80">{duty.summary || duty.description}</div>
          )}
        </button>
        <div className="mt-auto flex items-center gap-1 pt-2.5">
          <button type="button" onClick={() => onOpen(duty)} className={cn(quiet, '-ml-2 mr-auto text-muted-foreground/80 hover:bg-muted/45 hover:text-foreground/90')}>Open</button>
          {duty.id && (
            <>
              <button type="button" onClick={() => onEdit?.(duty)} aria-label="Edit" title="Edit"
                className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground/60 transition-colors hover:bg-muted/45 hover:text-foreground/85">
                <Pencil className="size-3.5" strokeWidth={1.75} />
              </button>
              <button type="button" onClick={() => onDelete?.(duty)} aria-label="Delete" title="Delete"
                className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive">
                <Trash2 className="size-3.5" strokeWidth={1.75} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DutyRow({ duty, onOpen, onToggleTag, activeTags }) {
  return (
    <li
      role="button"
      tabIndex={0}
      onClick={() => onOpen(duty)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(duty); } }}
      className={`group flex cursor-pointer items-center gap-4 px-2 py-4 transition-colors hover:bg-muted/30 ${duty.retired ? 'opacity-50' : ''}`}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-[6px] border border-border/70">
        {createElement(dutyIcon(duty.icon), { className: 'size-4 text-muted-foreground/85', strokeWidth: 1.8 })}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`truncate text-[14.5px] font-medium text-foreground/90 ${duty.retired ? 'line-through' : ''}`}>{duty.title}</span>
          {duty.tags.length > 0 && (
            <div className="flex shrink-0 items-center gap-1">
              {duty.tags.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onToggleTag(t); }}
                  className={`inline-flex items-center rounded-[6px] px-1.5 py-0.5 text-[10.5px] font-medium leading-none transition-colors ${activeTags?.has(t) ? 'bg-muted/85 text-foreground ring-1 ring-foreground/25' : 'bg-muted/45 text-muted-foreground/80 hover:bg-muted/65 hover:text-foreground/85'}`}
                  title={`Filter by #${t}`}
                >
                  #{t}
                </button>
              ))}
            </div>
          )}
        </div>
        {duty.description && (
          <div className="mt-0.5 truncate text-[13px] text-muted-foreground/75">{duty.description}</div>
        )}
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground/30 transition-all group-hover:translate-x-0.5 group-hover:text-muted-foreground/70" strokeWidth={2} />
    </li>
  );
}

// Full detail — same overlay pattern the rest of the app uses (Esc / click-outside).
function DutyModal({ duty, onClose, onEdit, onDelete }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={duty.title}
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop px-4 animate-[fade-in_0.12s_ease-out]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden modal-panel">
        <div className="flex items-start gap-3 border-b border-border/40 px-6 py-4">
          <div className="flex size-8 shrink-0 items-center justify-center rounded border border-border/50 bg-muted/35 text-[--color-ring]/80">
            {createElement(dutyIcon(duty.icon), { className: 'size-[18px]', strokeWidth: 1.75 })}
          </div>
          <div className={`min-w-0 flex-1 self-center text-[15px] font-semibold leading-snug text-foreground/90 ${duty.retired ? 'line-through' : ''}`}>
            {duty.title}
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
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {duty.description ? (
            <p className="text-[13.5px] leading-[1.7] text-foreground/80">{duty.description}</p>
          ) : (
            <p className="text-[13px] italic text-muted-foreground/60">No extra detail recorded.</p>
          )}
          {duty.tags.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-1">
              {duty.tags.map((t) => (
                <span key={t} className="inline-flex items-center rounded bg-muted/45 px-1.5 py-0.5 text-[10.5px] font-medium leading-none text-muted-foreground/80">
                  #{t}
                </span>
              ))}
            </div>
          )}
        </div>
        {/* Routines kept as data (memory v4) can be changed here; a card can't. */}
        {duty.id && (
          <div className="flex items-center gap-2 border-t border-border/40 bg-muted/20 px-6 py-3">
            <button type="button" onClick={onDelete}
              className="mr-auto inline-flex items-center gap-1.5 rounded-[6px] px-2 py-1.5 text-[12.5px] font-medium text-muted-foreground/75 hover:bg-destructive/10 hover:text-destructive">
              <Trash2 className="size-3.5" strokeWidth={1.75} /> Delete
            </button>
            <button type="button" onClick={onEdit}
              className="inline-flex items-center gap-1.5 rounded-[6px] bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:bg-foreground/85">
              <Pencil className="size-3.5" strokeWidth={1.75} /> Edit
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Same as Skills' delete confirmation: one routine, what happens, Cancel / Delete.
function DeleteRoutineModal({ duty, onClose, onDeleted }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose, busy]);
  const remove = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/routines/${encodeURIComponent(duty.id)}`, { method: 'DELETE', credentials: 'same-origin' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onDeleted();
    } catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <div role="dialog" aria-modal="true" aria-label={`Delete routine: ${duty.title}`}
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop px-4 animate-[fade-in_0.12s_ease-out]"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="w-full max-w-md overflow-hidden modal-panel">
        <div className="flex items-start gap-3.5 px-6 py-5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
            <Trash2 className="size-4 text-destructive" strokeWidth={2} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-foreground">Delete {duty.title}?</div>
            <div className="mt-1 text-[13px] leading-relaxed text-muted-foreground/85">
              The planner stops scheduling it from tomorrow. It stays in the history, and a Marketplace routine can be added again.
            </div>
            {error && (
              <div className="mt-3 rounded border border-destructive/25 bg-destructive/[0.04] px-2.5 py-1.5 text-[12px] text-destructive">{error}</div>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border/50 bg-muted/15 px-6 py-3">
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded px-3.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground/85 disabled:opacity-50">
            Cancel
          </button>
          <button type="button" onClick={remove} disabled={busy}
            className="inline-flex items-center gap-1.5 rounded bg-destructive px-4 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-95 disabled:opacity-50">
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// Same as Skills' "Add skill" tile: a dashed, centred call to add one.
function AddRoutineTile({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex h-full min-h-[124px] w-full flex-col items-center justify-center gap-2 rounded-[6px] border border-dashed border-border/70 bg-muted/15 px-4 py-4 text-muted-foreground/70 transition-all hover:border-foreground/25 hover:bg-muted/30 hover:text-foreground/85"
    >
      <div className="flex size-12 shrink-0 items-center justify-center rounded-[6px] bg-background ring-1 ring-border/60 transition-colors group-hover:ring-foreground/20">
        <Plus className="size-5" strokeWidth={1.75} />
      </div>
      <div className="text-[13.5px] font-medium">Add routine</div>
      <div className="text-[11.5px] text-muted-foreground/65">Something to take care of on its own</div>
    </button>
  );
}

// The icons a person can pick for their own routine (one per look; ICON_MAP
// keeps the synonyms for what the bot writes).
const PICKABLE_ICONS = ['check', 'mail', 'calendar', 'clock', 'message', 'users', 'file', 'receipt', 'money', 'tasks',
  'bell', 'refresh', 'search', 'star', 'megaphone', 'activity', 'shield', 'rocket', 'book', 'trend', 'watch', 'warning', 'folder', 'sun'];

/**
 * New routine / edit one. Title and what to do are required: the planner works
 * from the instruction, so it has to say what to check, where, and how often.
 */
function RoutineFormModal({ duty, onClose, onSaved }) {
  const editing = !!duty?.id;
  const [title, setTitle] = useState(duty?.title || '');
  const [description, setDescription] = useState(duty?.description || '');
  const [icon, setIcon] = useState(duty?.icon && ICON_MAP[duty.icon] ? duty.icon : 'check');
  const [tags, setTags] = useState((duty?.tags || []).map((t) => `#${t}`).join(' '));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const missingTitle = !title.trim();
  const missingWhat = !description.trim();
  const save = async (e) => {
    e.preventDefault();
    setTouched(true);
    if (missingTitle || missingWhat) return;
    setBusy(true); setErr(null);
    try {
      const body = { title: title.trim(), description: description.trim(), icon, tags: tags.split(/[\s,]+/).map((t) => t.replace(/^#/, '')).filter(Boolean) };
      const r = await fetch(editing ? `/api/routines/${encodeURIComponent(duty.id)}` : '/api/routines', {
        method: editing ? 'PATCH' : 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      onSaved(j.routine);
    } catch (e2) { setErr(e2.message); setBusy(false); }
  };

  const field = 'w-full rounded-[6px] border bg-background px-3 py-2 text-[13.5px] text-foreground/90 outline-none transition-colors focus:border-foreground/35';
  const label = 'text-[12px] font-medium text-foreground/80';
  return (
    <div role="dialog" aria-modal="true" aria-label={editing ? 'Edit routine' : 'New routine'}
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop px-4 animate-[fade-in_0.12s_ease-out]"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form onSubmit={save} className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden modal-panel">
        <div className="flex items-center justify-between gap-4 border-b border-border/40 px-6 py-4">
          <h2 className="text-[15px] font-semibold text-foreground/90">{editing ? 'Edit routine' : 'New routine'}</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close"
            className="rounded-[6px] p-1.5 text-muted-foreground/65 transition-colors hover:bg-muted/30 hover:text-foreground/85">
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
          <label className="flex flex-col gap-1.5">
            <span className={label}>Title</span>
            <input autoFocus value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Watch the inbox"
              className={cn(field, touched && missingTitle ? 'border-destructive/60' : 'border-border/60')} />
            {touched && missingTitle && <span className="text-[11.5px] text-destructive">Give it a short title.</span>}
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={label}>What to do</span>
            <textarea value={description} maxLength={2000} rows={5} onChange={(e) => setDescription(e.target.value)}
              placeholder="Every hour on workdays, check new email and message me only when a client replies or something is time-sensitive."
              className={cn(field, 'resize-none leading-relaxed', touched && missingWhat ? 'border-destructive/60' : 'border-border/60')} />
            {touched && missingWhat
              ? <span className="text-[11.5px] text-destructive">Say what to do — the planner works from this.</span>
              : <span className="text-[11.5px] text-muted-foreground/65">What to check and where, how often, and when to tell you.</span>}
          </label>
          <div className="flex flex-col gap-1.5">
            <span className={label}>Icon</span>
            <div className="flex flex-wrap gap-1.5">
              {PICKABLE_ICONS.map((k) => (
                <button key={k} type="button" onClick={() => setIcon(k)} aria-label={k} aria-pressed={icon === k}
                  className={cn('flex size-8 items-center justify-center rounded-[6px] border transition-colors',
                    icon === k ? 'border-foreground/40 bg-muted/50 text-foreground' : 'border-border/60 text-muted-foreground/70 hover:text-foreground/85')}>
                  {createElement(ICON_MAP[k], { className: 'size-4', strokeWidth: 1.8 })}
                </button>
              ))}
            </div>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className={label}>Tags <span className="font-normal text-muted-foreground/60">· optional</span></span>
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="#email #daily"
              className={cn(field, 'border-border/60')} />
          </label>
          {err && <p className="text-[12.5px] text-destructive">{err}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border/40 bg-muted/20 px-6 py-3">
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded-[6px] px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/85 hover:bg-muted/45 hover:text-foreground/90 disabled:opacity-50">
            Cancel
          </button>
          <button type="submit" disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-[6px] bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition-colors hover:bg-foreground/85 disabled:opacity-50">
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {editing ? 'Save' : 'Add routine'}
          </button>
        </div>
      </form>
    </div>
  );
}

function RoleView({ fileEventNonce }) {
  const { botDisplayName } = useBranding();
  const { me } = useMe();
  // With memory v4 on, routines are data of their own (routines.json via
  // /api/routines); before it, the RESPONSIBILITIES card. Wait for the status so
  // neither source flashes before the other.
  const memory = useMemoryStatus();
  const v4 = memory.mode === 'on';
  const cardUrl = useMemo(() => cardUrlFor(me), [me]);
  const { data, loading, error, reload } = useApi(memory.loaded ? (v4 ? '/api/routines' : cardUrl) : null);
  const [activeDuty, setActiveDuty] = useState(null);
  const [editing, setEditing] = useState(null);   // {} = new, a duty = edit it
  const [deleting, setDeleting] = useState(null);
  const [activeTags, setActiveTags] = useState(() => new Set());
  // Your routines | Marketplace (v4 only — the catalog adds to routines.json).
  const [tab, setTab] = useState(() => {
    try { return localStorage.getItem('routines.tab') === 'marketplace' ? 'marketplace' : 'mine'; } catch { return 'mine'; }
  });
  const pickTab = (t) => { setTab(t); try { localStorage.setItem('routines.tab', t); } catch { /* private mode */ } };

  useEffect(() => { if (fileEventNonce) reload(); }, [fileEventNonce, reload]);

  const role = useMemo(() => (v4
    ? {
        duties: (data?.routines || []).filter((r) => !r.retired)
          .map((r) => ({ id: r.id, catalogId: r.catalogId, title: r.title, summary: r.summary || '', description: r.description, icon: r.icon, tags: r.tags || [], retired: false })),
        unparsed: data?.unparsed || [],
      }
    : parseRole(data?.content)), [data, v4]);
  // The integrations a routine works with: a Marketplace routine's, by its
  // catalog id; any other routine's, by a tag that is an integration's id
  // (#shopify) — the bot tags what it uses.
  const catalog = useApi(v4 ? '/api/routines/catalog' : null);
  const integrationsOf = useMemo(() => {
    const byId = Object.fromEntries((catalog.data?.integrations || []).map((i) => [i.id, i]));
    const fromCatalog = {};
    for (const g of catalog.data?.groups || []) for (const r of g.routines) fromCatalog[r.id] = r.integrations || [];
    return (d) => [...new Set([...(fromCatalog[d.catalogId] || []), ...d.tags.filter((t) => byId[t])])].map((id) => byId[id]).filter(Boolean);
  }, [catalog.data]);
  const isInitialLoad = loading && !data;
  const realError = error && !error.includes('404') ? error : null;

  const toggleTag = (t) => setActiveTags((prev) => {
    const next = new Set(prev);
    if (next.has(t)) next.delete(t); else next.add(t);
    return next;
  });
  const visibleDuties = activeTags.size === 0
    ? role.duties
    : role.duties.filter((d) => [...activeTags].every((t) => d.tags.includes(t)));

  const tabs = v4 && (
      <Tabs
        value={tab}
        onChange={pickTab}
        items={[
          { id: 'mine', label: 'Your routines', count: isInitialLoad ? null : role.duties.length },
          { id: 'marketplace', label: 'Marketplace' },
        ]}
      />
  );
  const modals = (
    <>
      {activeDuty && (
        <DutyModal duty={activeDuty} onClose={() => setActiveDuty(null)}
          onEdit={() => { setEditing(activeDuty); setActiveDuty(null); }}
          onDelete={() => { setDeleting(activeDuty); setActiveDuty(null); }} />
      )}
      {deleting && (
        <DeleteRoutineModal duty={deleting} onClose={() => setDeleting(null)}
          onDeleted={() => { setDeleting(null); setActiveDuty(null); reload(); refetch('/api/routines/catalog'); }} />
      )}
      {editing && (
        <RoutineFormModal duty={editing.id ? editing : null} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); refetch('/api/routines/catalog'); }} />
      )}
    </>
  );

  // The Marketplace keeps its own full-height layout: the switch, the search and
  // the filter list stay put; only the list (and a long filter list) scroll.
  if (v4 && tab === 'marketplace') {
    return (
      <div className="flex h-full min-h-0 flex-col gap-5 px-6 pt-2">
        {tabs}
        <RoutinesMarketplace onChanged={reload} />
        {modals}
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="flex min-h-full flex-col gap-5 px-6 pb-12 pt-2">
        {tabs && <div className="sticky top-0 z-10 -mx-6 -mt-2 bg-background px-6 pb-2 pt-2">{tabs}</div>}
        {(<>
        {isInitialLoad && (
          <SkeletonList count={4} />
        )}


        {realError && (
          <div className="rounded-[6px] border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
            Couldn't load responsibilities: {realError}
          </div>
        )}


        {/* Same empty screen as Notifications: a title and one line. */}
        {!isInitialLoad && !realError && role.duties.length === 0 && (
          <div className="flex flex-1 items-center justify-center px-6 py-16">
            <div className="flex max-w-[320px] flex-col items-center gap-3 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground/50">
                <Repeat className="size-6" strokeWidth={1.75} />
              </div>
              <h2 className="text-[14px] font-semibold tracking-tight text-foreground/85">Nothing on autopilot yet</h2>
              <p className="text-[13px] leading-relaxed text-muted-foreground/75">
                Tell {botDisplayName} in the chat what to take care of, add one of your own, or pick one from the Marketplace.
              </p>
              {v4 && (
                <div className="mt-1 flex items-center gap-2">
                  <button type="button" onClick={() => pickTab('marketplace')}
                    className="rounded-[6px] bg-foreground/[0.09] px-3 py-1.5 text-[12.5px] font-medium text-foreground/90 transition-colors hover:bg-foreground/[0.14]">
                    Browse the Marketplace
                  </button>
                  <button type="button" onClick={() => setEditing({})}
                    className="inline-flex items-center gap-1 rounded-[6px] px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/80 transition-colors hover:bg-foreground/[0.05] hover:text-foreground/90">
                    <Plus className="size-3.5" strokeWidth={2} /> Add your own
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {!isInitialLoad && !realError && role.duties.length > 0 && (
          <Section>
            {activeTags.size > 0 && (
              <div className="-mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground/70">
                <span>Filtered by</span>
                {[...activeTags].map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleTag(t)}
                    className="inline-flex items-center gap-1 rounded bg-muted/70 px-1.5 py-0.5 text-[10.5px] font-medium text-foreground ring-1 ring-foreground/20 transition-colors hover:bg-muted"
                  >
                    #{t}<X className="size-3" strokeWidth={2.5} />
                  </button>
                ))}
                <button type="button" onClick={() => setActiveTags(new Set())} className="ml-1 underline underline-offset-2 hover:text-foreground/85">
                  clear
                </button>
              </div>
            )}
            {/* Your routines as tiles, the same as the Marketplace's. */}
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,306px)] max-sm:grid-cols-1">
              {visibleDuties.map((d, i) => <DutyTile key={d.id || i} duty={d} onOpen={setActiveDuty} onEdit={setEditing} onDelete={setDeleting} integrations={integrationsOf(d)} />)}
              {v4 && <AddRoutineTile onClick={() => setEditing({})} />}
            </div>
            {visibleDuties.length === 0 && (
              <p className="text-[12.5px] text-muted-foreground/70">
                Nothing tagged {[...activeTags].map((t) => `#${t}`).join(' + ')}.
              </p>
            )}
          </Section>
        )}

        {/* Lines the routine grammar could not read: a quiet note at the end. */}
        {!isInitialLoad && role.unparsed?.length > 0 && (
          <UnparsedLines lines={role.unparsed} v4={v4} botDisplayName={botDisplayName} onChanged={reload} />
        )}
        </>)}
      </div>

      {modals}
    </div>
  );
}

/**
 * Routines — the bot's responsibilities card (memory/RESPONSIBILITIES.md): one flat
 * list of what it's on the hook for. Each is `{icon} **Title** — description #tags`;
 * tiles show a 2-line preview (click → detail modal), tags filter the list. The
 * suggestions-only boundary is a fixed footer, not card content. Same visual
 * vocabulary as Reminders / Skills / Notifications.
 */
export default function ResponsibilitiesDashboard({ fileEventNonce, sidebarOpen }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={Repeat} title="Routines" sidebarOpen={sidebarOpen} />
      <div className="min-h-0 flex-1 overflow-hidden">
        <TooltipPrimitive.Provider delayDuration={200} skipDelayDuration={400}>
          <RoleView fileEventNonce={fileEventNonce} />
        </TooltipPrimitive.Provider>
      </div>
    </div>
  );
}

// ─── Marketplace ─────────────────────────────────────────────────────────────

/**
 * Ready-made routines (GET /api/routines/catalog), built for a long catalog:
 * one search over titles, text, tags and integration names; a filter list
 * (All / Ready to add / Added, categories, integrations — connected first,
 * the rest greyed); compact rows that open to the full instruction. Add writes
 * an ordinary routine the planner runs like any other; a routine whose
 * integration isn't connected offers Connect instead.
 */
function RoutinesMarketplace({ onChanged }) {
  const { botDisplayName } = useBranding();
  const { data, loading, error, reload } = useApi('/api/routines/catalog');
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('recommended');
  const [open, setOpen] = useState(null);
  const [connecting, setConnecting] = useState(null);   // the integration whose install modal is open
  const navigate = useNavigate();
  const { me } = useMe();
  const isAdmin = me?.role === 'admin';
  // The full integration records — what the install modal needs.
  const integrationsQ = useApi(isAdmin ? '/api/integrations' : null);
  const afterConnect = () => { integrationsQ.reload?.(); reload(); refetch('/api/integrations'); };
  // The same three ways in as on Integrations: a one-click integration goes
  // straight to the provider's sign-in popup, an open server switches on with
  // no questions, and only one that needs keys opens the install modal.
  const connect = (id) => {
    const integ = (integrationsQ.data?.integrations || []).find((i) => i.id === id);
    if (!integ) { navigate('/integrations'); return; }
    if (isRemoteMcpOauth(integ)) { openOAuthPopup(integ, afterConnect); return; }
    if (isOpenServer(integ)) {
      fetch(`/api/integrations/${encodeURIComponent(integ.id)}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: {} }),
      }).then(async (r) => {
        if (!r.ok) setErr((await r.json().catch(() => ({}))).error || `Couldn't connect ${integ.label || integ.id}.`);
        afterConnect();
      }).catch(() => setErr("Couldn't reach the server."));
      return;
    }
    setConnecting(integ);
  };
  // The sign-in popup reports back when it finishes: the routine unlocks at once.
  useEffect(() => {
    const onMessage = (e) => {
      if (e.origin !== window.location.origin || e.data?.type !== 'integration-oauth') return;
      if (!e.data.ok) setErr("That integration didn't connect. Try again.");
      afterConnect();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  });

  const groups = data?.groups || [];
  const categories = data?.categories || [];
  const catLabel = useMemo(() => Object.fromEntries(categories.map((c) => [c.id, c.label])), [categories]);
  const integList = data?.integrations || [];
  const integById = useMemo(() => Object.fromEntries(integList.map((i) => [i.id, i])), [integList]);
  const all = useMemo(() => groups.flatMap((g) => g.routines.map((r) => ({ ...r, group: g }))), [groups]);

  const counts = useMemo(() => {
    const c = { all: all.length, ready: 0, added: 0, recommended: 0 };
    for (const r of all) {
      if (r.available && !r.added) c.ready++;
      if (r.added) c.added++;
      if (r.recommended) c.recommended++;
      c[`cat:${r.category}`] = (c[`cat:${r.category}`] || 0) + 1;
      for (const id of r.integrations || []) c[`int:${id}`] = (c[`int:${id}`] || 0) + 1;
    }
    return c;
  }, [all]);

  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = all.filter((r) => {
      // A search looks through everything, whichever filter is on.
      if (filter === 'recommended' && !words.length && !r.recommended) return false;
      if (filter === 'ready' && !(r.available && !r.added)) return false;
      if (filter === 'added' && !r.added) return false;
      if (filter.startsWith('cat:') && r.category !== filter.slice(4)) return false;
      if (filter.startsWith('int:') && !(r.integrations || []).includes(filter.slice(4))) return false;
      if (!words.length) return true;
      const hay = [r.title, r.summary, r.description, catLabel[r.category], ...(r.tags || []), ...(r.integrations || []).map((id) => integById[id]?.label || id)].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    // Recommended: the ones you can add right now first.
    return filter === 'recommended' ? [...list].sort((a, b) => Number(b.available) - Number(a.available)) : list;
  }, [all, filter, q, catLabel, integById]);

  const act = async (entry) => {
    setBusy(entry.id); setErr(null);
    try {
      const r = await fetch(`/api/routines/catalog/${encodeURIComponent(entry.id)}`, { method: entry.added ? 'DELETE' : 'POST', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await Promise.all([reload(), onChanged?.(), refetch('/api/routines')]);
    } catch (e) { setErr(e.message); } finally { setBusy(null); }
  };

  if (loading && !data) return <div className="min-h-0 flex-1 overflow-y-auto"><SkeletonList count={6} /></div>;
  if (error && !data) return <p className="text-[13px] text-destructive">Couldn't load the Marketplace: {error}</p>;

  const Item = ({ id, label, logo, dim }) => (
    <button type="button" onClick={() => setFilter(id)}
      className={cn('flex w-full items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-[13px] transition-colors max-md:w-auto max-md:shrink-0',
        filter === id ? 'bg-foreground/[0.07] font-medium text-foreground' : 'text-foreground/75 hover:bg-foreground/[0.04] hover:text-foreground',
        dim && filter !== id && 'text-muted-foreground/60')}>
      {logo && <img src={logoUrl(logo)} alt="" className={cn('size-3.5 shrink-0 object-contain', dim && 'opacity-50 grayscale')} />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground/55">{counts[id] || 0}</span>
    </button>
  );
  const Heading = ({ children }) => <div className="mt-4 px-2.5 pb-1 text-[11px] font-medium text-muted-foreground/60 max-md:hidden">{children}</div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <div className="shrink-0">
        <SearchField value={q} onChange={setQ} placeholder="Search routines, tags or integrations…" label="Search routines" />
      </div>

      <div className="flex min-h-0 flex-1 gap-6 max-md:flex-col max-md:gap-3">
        <nav className="w-[220px] shrink-0 scrollbar-hidden overflow-y-auto pb-8 max-md:flex max-md:w-full max-md:gap-1 max-md:overflow-x-auto max-md:pb-0">
          <Item id="recommended" label="Recommended" />
          <Item id="ready" label="Ready to add" />
          <Item id="added" label="Added" />
          <Item id="all" label="All routines" />
          <Heading>Categories</Heading>
          {categories.filter((c) => counts[`cat:${c.id}`]).map((c) => <Item key={c.id} id={`cat:${c.id}`} label={c.label} />)}
          <Heading>Integrations</Heading>
          {integList.map((g) => <Item key={g.id} id={`int:${g.id}`} label={g.label} logo={g.logo} dim={!g.connected} />)}
        </nav>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pb-12">
          {err && <p className="mb-2 text-[12.5px] text-destructive">{err}</p>}
          {shown.length === 0 ? (
            <div className="rounded-[6px] border border-dashed border-border/70 px-4 py-4 text-[12.5px] text-muted-foreground/70">
              Nothing matches{q ? ` "${q}"` : ''}. Try another word, or ask {botDisplayName} in the chat for the routine you have in mind.
            </div>
          ) : (
            <ul className="divide-y divide-border/60 border-y border-border/60">
              {shown.map((r) => (
                <MarketRow key={r.id} entry={r} integById={integById} catLabel={catLabel[r.category]} open={open === r.id}
                  onToggle={() => setOpen(open === r.id ? null : r.id)} busy={busy === r.id}
                  onAct={() => act(r)} onConnect={isAdmin ? connect : null} />
              ))}
            </ul>
          )}
        </div>
      </div>
      {connecting && (
        <ActivateModal
          integration={connecting}
          onClose={() => setConnecting(null)}
          onSuccess={() => { setConnecting(null); integrationsQ.reload?.(); reload(); refetch('/api/integrations'); }}
        />
      )}
    </div>
  );
}

// The integrations a routine works with, as logos after its title: at most
// three (connected ones first), then "+N" whose tooltip names the rest — a
// routine that takes any of seven notetakers must not wear seven logos.
const LOGOS_SHOWN = 3;
function LogoRow({ integrations = [], max = LOGOS_SHOWN }) {
  const all = integrations.filter((i) => i.logo).sort((a, b) => Number(!!b.connected) - Number(!!a.connected));
  const shown = all.slice(0, max);
  const rest = all.slice(max);
  if (!all.length) return null;
  return (
    <>
      {shown.map((i) => (
        <LogoTip key={i.id} label={i.connected ? i.label : `${i.label} · not connected`}>
          <img src={logoUrl(i.logo)} alt={i.label} className={cn('size-3.5 shrink-0 object-contain', !i.connected && 'opacity-60 grayscale')} />
        </LogoTip>
      ))}
      {rest.length > 0 && (
        <LogoTip label={rest.map((i) => (i.connected ? i.label : `${i.label} · not connected`)).join(', ')}>
          <span className="shrink-0 rounded-[4px] bg-muted px-1 text-[10.5px] font-medium leading-4 text-muted-foreground">+{rest.length}</span>
        </LogoTip>
      )}
    </>
  );
}

// An integration's name over its logo — the same tooltip as Reminders' avatars.
function LogoTip({ label, children }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content side="top" sideOffset={6} collisionPadding={10}
          className="z-50 max-w-[18rem] rounded-[6px] border border-border/60 bg-popover px-2.5 py-1.5 text-[11.5px] leading-snug text-popover-foreground shadow-md">
          {label}
          <TooltipPrimitive.Arrow className="fill-popover" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

function MarketRow({ entry, integById, catLabel, open, onToggle, busy, onAct, onConnect }) {
  const btn = 'inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-[6px] px-2.5 text-[12px] font-medium transition-colors disabled:opacity-50';
  const works = (entry.integrations || []).map((id) => integById[id] || { id, label: id });
  // Locked: name what to connect — one integration, or "Connect" when any of several would do.
  const missing = works.filter((i) => !i.connected);
  const connectLabel = missing.length === 1 ? `Connect ${missing[0].label}` : 'Connect';
  // Any of several would do: Connect first lays them out to pick from.
  const [picking, setPicking] = useState(false);
  return (
    <li className={cn('flex flex-col gap-2 px-2 py-3', !entry.available && 'opacity-[0.72]')}>
      <div className="flex items-center gap-3">
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-[6px] border border-border/70">
            {createElement(dutyIcon(entry.icon), { className: 'size-4 text-muted-foreground/85', strokeWidth: 1.8 })}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[14px] font-medium text-foreground/90">{entry.title}</span>
              <LogoRow integrations={works} />
            </div>
            <div className="truncate text-[12.5px] text-muted-foreground/75">{entry.summary}</div>
          </div>
        </button>
        {!entry.available && !onConnect ? (
          <span className="shrink-0 text-[11.5px] text-muted-foreground/60" title={`Needs ${missing.map((i) => i.label).join(' or ')}`}>
            Needs {missing.length === 1 ? missing[0].label : 'an integration'} · ask an admin
          </span>
        ) : !entry.available ? (
          <button type="button" onClick={() => (missing.length === 1 ? onConnect(missing[0].id) : setPicking(!picking))}
            title={`Needs ${missing.map((i) => i.label).join(' or ')}`} aria-expanded={missing.length > 1 ? picking : undefined}
            className={cn(btn, 'border border-border/70 text-muted-foreground/80 hover:border-foreground/30 hover:text-foreground', picking && 'border-foreground/30 text-foreground')}>
            {connectLabel}
          </button>
        ) : entry.added ? (
          <button type="button" disabled={busy} onClick={onAct} aria-label={`Remove ${entry.title}`}
            className={cn(btn, 'group/act text-emerald-700 hover:bg-destructive/[0.08] hover:text-destructive dark:text-emerald-400')}>
            <CheckCircle2 className="size-3.5 group-hover/act:hidden" strokeWidth={2.25} />
            <span className="group-hover/act:hidden">Added</span>
            <span className="hidden group-hover/act:inline">Remove</span>
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={onAct}
            className={cn(btn, 'bg-muted/40 text-muted-foreground/80 hover:bg-muted/55 hover:text-foreground/90')}>
            Add
          </button>
        )}
      </div>
      {picking && !entry.available && (
        <div className="ml-11 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[12px] text-muted-foreground/70">Connect one:</span>
          {missing.map((i) => (
            <button key={i.id} type="button" onClick={() => { setPicking(false); onConnect(i.id); }}
              className={cn(btn, 'border border-border/70 text-foreground/80 hover:border-foreground/30 hover:text-foreground')}>
              {i.logo && <img src={logoUrl(i.logo)} alt="" className="mr-0.5 size-3.5 object-contain" />}
              {i.label}
            </button>
          ))}
        </div>
      )}
      {open && (
        <div className="ml-11 flex flex-col gap-2 pb-1">
          <p className="text-[12.5px] leading-relaxed text-foreground/75">{entry.description}</p>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground/60">
            {catLabel && <span>{catLabel}</span>}
            {works.length > 0 && <span>· works with {works.map((i) => i.label).join(', ')}</span>}
          </div>
        </div>
      )}
    </li>
  );
}
