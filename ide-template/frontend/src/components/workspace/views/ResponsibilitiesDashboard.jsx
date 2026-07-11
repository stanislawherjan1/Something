import { useEffect, useMemo, useState, createElement } from 'react';
import {
  Repeat, CheckCircle2, ChevronRight, X,
  Mail, CalendarClock, Clock, MessageCircle, Users, FileText, Receipt, DollarSign,
  ListChecks, Bell, RefreshCw, Search, Star, Megaphone, Activity, Shield, Rocket,
  Link as LinkIcon, BookOpen, TrendingUp, Eye, AlertTriangle, FolderOpen,
  Sun, CloudSun,
} from 'lucide-react';
import EditorHeader from '../EditorHeader.jsx';
import { useBranding, BrandedImage, BOT_FALLBACK } from '../identity';
import { useApi } from '@/lib/useApi';
import { SkeletonRow } from '@/components/ui/Skeleton';
import useMe from '../useMe.js';

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
  const bullets = (name) => (sections[name] || [])
    .map((l) => l.match(/^\s*[-*]\s+(.+?)\s*$/))
    .filter(Boolean)
    .map((m) => m[1].trim());

  const duties = (name) => bullets(name).map((raw) => {
    const retired = /^~~[\s\S]*~~$/.test(raw);
    let clean = raw.replace(/^~~|~~$/g, '').trim();
    let icon = null;
    const im = clean.match(/^\{([a-z0-9-]+)\}\s*/i);
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
  return {
    duties: [
      ...duties('responsibilities'),
      ...duties('duties'),
      ...duties('recurring duties'),
      ...duties('proactive watch'),
    ],
  };
}

// Section — matches the Reminders / Skills / Notifications vocabulary.
function Section({ title, children }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70">
        {title}
      </h2>
      {children}
    </section>
  );
}

// Icon in a micro container above a short name + a 2-line description preview,
// plus #tag pills. Click opens the full detail modal; a tag click filters.
function DutyTile({ duty, onOpen, onToggleTag, activeTags }) {
  const hasDesc = !!duty.description;
  return (
    <div
      className={`group relative rounded-md border border-border/60 bg-card px-4 py-3 transition-all duration-150 ${hasDesc ? 'cursor-pointer hover:border-foreground/15 hover:shadow-[0_2px_6px_rgba(0,0,0,0.035)]' : ''} ${duty.retired ? 'opacity-50' : ''}`}
      onClick={hasDesc ? () => onOpen(duty) : undefined}
      role={hasDesc ? 'button' : undefined}
      tabIndex={hasDesc ? 0 : undefined}
      onKeyDown={hasDesc ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(duty); } } : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex size-7 items-center justify-center rounded border border-border/50 bg-muted/35 text-[--color-ring]/80">
          {createElement(dutyIcon(duty.icon), { className: 'size-4', strokeWidth: 1.75 })}
        </div>
        {hasDesc && (
          <ChevronRight
            className="mt-1 size-4 shrink-0 text-muted-foreground/30 transition-all group-hover:translate-x-0.5 group-hover:text-muted-foreground/70"
            strokeWidth={2}
          />
        )}
      </div>
      <div className="mt-2.5">
        <span className={`block text-[13px] font-medium leading-snug text-foreground/90 ${duty.retired ? 'line-through' : ''}`}>
          {duty.title}
        </span>
        {hasDesc && (
          <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground/85">
            {duty.description}
          </p>
        )}
        {duty.tags.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1">
            {duty.tags.map((t) => (
              <button
                key={t}
                type="button"
                onClick={(e) => { e.stopPropagation(); onToggleTag(t); }}
                className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10.5px] font-medium leading-none transition-colors ${activeTags?.has(t) ? 'bg-muted/85 text-foreground ring-1 ring-foreground/25' : 'bg-muted/45 text-muted-foreground/80 hover:bg-muted/65 hover:text-foreground/85'}`}
                title={`Filter by #${t}`}
              >
                #{t}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Full detail — same overlay pattern the rest of the app uses (Esc / click-outside).
function DutyModal({ duty, onClose }) {
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-[3px] animate-[fade-in_0.12s_ease-out]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-md bg-background shadow-2xl">
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
            className="rounded-md p-1.5 text-muted-foreground/65 transition-colors hover:bg-muted/30 hover:text-foreground/85"
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
      </div>
    </div>
  );
}

function RoleView({ fileEventNonce }) {
  const { botDisplayName, botAvatarUrl } = useBranding();
  const { me } = useMe();
  const cardUrl = useMemo(() => cardUrlFor(me), [me]);
  const { data, loading, error, reload } = useApi(cardUrl);
  const [activeDuty, setActiveDuty] = useState(null);
  const [activeTags, setActiveTags] = useState(() => new Set());

  useEffect(() => { if (fileEventNonce) reload(); }, [fileEventNonce, reload]);

  const role = useMemo(() => parseRole(data?.content), [data]);
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

  return (
    <div className="h-full overflow-auto">
      <div className="flex flex-col gap-7 px-6 pb-12 pt-2">
        {/* First-person intro — avatar + message in ONE shared panel. */}
        <div className="flex items-center gap-4 rounded-lg border border-border/60 bg-card px-4 py-3.5">
          <BrandedImage
            src={botAvatarUrl}
            fallback={BOT_FALLBACK}
            alt=""
            className="size-16 shrink-0 rounded-full object-cover ring-1 ring-foreground/10"
          />
          <div className="min-w-0">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
              {botDisplayName}
            </div>
            <p className="text-[13.5px] leading-[1.6] text-foreground/80">
              These are my routines: the things I take care of for you, without being
              asked. Just tell me what to keep an eye on and I'll add it.
            </p>
          </div>
        </div>

        {isInitialLoad && (
          <div className="flex flex-col gap-2"><SkeletonRow /><SkeletonRow /></div>
        )}

        {realError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
            Couldn't load responsibilities: {realError}
          </div>
        )}

        {!isInitialLoad && !realError && role.duties.length === 0 && (
          <p className="text-[13px] leading-relaxed text-muted-foreground/80">
            No responsibilities recorded yet. Tell {botDisplayName} something like "from
            now on check email each morning" or "keep an eye on approaching deadlines"
            and it will keep it here.
          </p>
        )}

        {!isInitialLoad && !realError && role.duties.length > 0 && (
          <Section title="Responsibilities">
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
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {visibleDuties.map((d, i) => (
                <DutyTile key={i} duty={d} onOpen={setActiveDuty} onToggleTag={toggleTag} activeTags={activeTags} />
              ))}
            </div>
            {visibleDuties.length === 0 && (
              <p className="text-[12.5px] text-muted-foreground/70">
                Nothing tagged {[...activeTags].map((t) => `#${t}`).join(' + ')}.
              </p>
            )}
          </Section>
        )}

      </div>

      {activeDuty && <DutyModal duty={activeDuty} onClose={() => setActiveDuty(null)} />}
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
        <RoleView fileEventNonce={fileEventNonce} />
      </div>
    </div>
  );
}
