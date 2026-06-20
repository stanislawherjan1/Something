import { useState, useEffect, useCallback, useMemo } from 'react';
import { Calendar, Repeat, Loader2, Trash2, X, Send, Globe, Clock, Bell, Users, User } from 'lucide-react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';
import EditorHeader from '../EditorHeader.jsx';
import { useBranding, BrandedImage, BOT_FALLBACK } from '../identity';
import { useApi } from '@/lib/useApi';
import { SkeletonRow } from '@/components/ui/Skeleton';

// Server-scoped reminder list (own + targeting-me + team-wide; never another
// member's). Replaces reading the raw .reminders.json via /api/files — which
// leaked every member's titles and let anyone rewrite the shared file.
const REMINDERS_URL = '/api/reminders';

/**
 * Resolve a reminder into { title, description } for display.
 *
 * Newer reminders (from the updated set_reminder MCP) carry explicit
 * `title` / `description` fields. Older ones only have `message`, often
 * shaped as "HEADING — body text" or with embedded newlines. This helper
 * gives the UI a uniform two-line structure either way.
 *
 * Split priority on legacy `message`:
 *   1. First newline                — the bot wrote a paragraph break
 *   2. " — " (em-dash with spaces)  — common bot pattern
 *   3. ": " after first capitalised word group
 *   4. fallback: whole string is the title, no description
 */
function displayParts(reminder) {
  const r = reminder || {};
  if (typeof r.title === 'string' && r.title.trim()) {
    return {
      title: r.title.trim(),
      description: typeof r.description === 'string' ? r.description.trim() : '',
    };
  }
  const msg = typeof r.message === 'string' ? r.message.trim() : '';
  if (!msg) return { title: '(no message)', description: '' };

  const splitOn = (sep) => {
    const ix = msg.indexOf(sep);
    if (ix < 1) return null;
    const t = msg.slice(0, ix).trim();
    const d = msg.slice(ix + sep.length).trim();
    if (!t || !d) return null;
    return { title: t, description: d };
  };

  return splitOn('\n')
      ?? splitOn(' — ')
      ?? splitOn(' – ')
      ?? splitOn(': ')
      ?? { title: msg, description: '' };
}

function ReminderHeading({ reminder }) {
  const { title, description } = displayParts(reminder);
  return (
    <>
      <div className="text-[13.5px] font-medium leading-snug text-foreground">
        {title}
      </div>
      {description && (
        <div className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-muted-foreground/85">
          {description}
        </div>
      )}
    </>
  );
}

/**
 * RemindersDashboard — horizontal-row layout matching the Skills dashboard
 * aesthetic (slim header, subtitle paragraph, sectioned list, hover-revealed
 * trash icon). Source of truth is project/.reminders.json which the
 * reminder-mcp owns; we read + write the file directly via /api/files so
 * the bot picks up changes on its next tick.
 */
export default function RemindersDashboard({ fileEventNonce, sidebarOpen }) {
  const { botDisplayName } = useBranding();
  // /api/files/read returns 404 when the file doesn't exist yet — useApi
  // surfaces that as `error: "HTTP 404"`. We treat it as "no reminders" to
  // avoid showing an error banner for a perfectly normal empty state.
  const { data, loading, error, reload: reloadApi } = useApi(REMINDERS_URL);
  const [deleting, setDeleting] = useState(null);

  // Refresh on file watcher event (bot wrote .reminders.json) or every 30 s.
  // We DON'T invalidate the cache here — that would flip loading=true and
  // make the dashboard skeleton-flash every revalidation. reload() runs a
  // silent background fetch instead; useApi merges fresh data on completion
  // without clearing the previously-rendered list. Diagnosed 2026-06-15
  // when the inbox started flickering once the periodic poll fired.
  useEffect(() => {
    if (fileEventNonce) reloadApi();
  }, [fileEventNonce, reloadApi]);

  useEffect(() => {
    const t = setInterval(() => { reloadApi(); }, 30_000);
    return () => clearInterval(t);
  }, [reloadApi]);

  const load = useCallback(() => reloadApi(), [reloadApi]);

  const isInitialLoad = loading && !data;

  // The scoped endpoint returns { reminders, names, me }. `names` is slug→
  // displayName for recipient badges; `me` is the current user's slug (what
  // counts as "yours"). Solo → me is null and every reminder is shown.
  const all = useMemo(() => {
    const list = Array.isArray(data?.reminders) ? data.reminders : [];
    return list.slice().sort((a, b) => new Date(a.due) - new Date(b.due));
  }, [data]);
  const names = data?.names || {};
  const me = data?.me || null;

  // Split system rituals (baseline weekly self-maintenance the bootstrap
  // seeded — bot-managed, not user-cancellable from chat) from user-created
  // reminders. Display them in separate sections so the user knows which
  // ones they can/should mess with.
  const userReminders   = useMemo(() => all.filter(r => (r.kind || 'user') !== 'system'), [all]);
  const systemReminders = useMemo(() => all.filter(r => r.kind === 'system'), [all]);

  // 404 is fine — file just doesn't exist yet. Other errors are real.
  const realError = error && !error.includes('404') ? error : null;

  return (
    <TooltipPrimitive.Provider delayDuration={200} skipDelayDuration={400}>
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={Clock} title="Reminders" sidebarOpen={sidebarOpen} />

      <div className="flex-1 overflow-auto">
        {!isInitialLoad && !realError && all.length === 0 ? (
          <RemindersEmptyState />
        ) : (
          <div className="flex flex-col gap-7 px-6 pb-12 pt-2">
            {isInitialLoad && (
              <div className="flex flex-col gap-2">
                <SkeletonRow />
                <SkeletonRow />
              </div>
            )}

            {realError && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
                Couldn't load reminders: {realError}
              </div>
            )}

            {!isInitialLoad && !realError && (
              <>
                {/* User-created reminders — what the bot has been asked to schedule */}
                <Section
                  title="Your reminders"
                  subtitle={`Timed nudges ${botDisplayName} has scheduled. Each fires on its own channel — Telegram, the web UI, or both — even when no chat session is active. Ask ${botDisplayName} to schedule new ones; clear out anything stale from here.`}
                >
                  {userReminders.length === 0 ? (
                    <EmptyHint>
                      No personal reminders yet. Try "remind me about X tomorrow at 9".
                    </EmptyHint>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {userReminders.map(r => (
                        <ReminderRow
                          key={r.id}
                          reminder={r}
                          names={names}
                          me={me}
                          onDelete={() => setDeleting(r)}
                        />
                      ))}
                    </div>
                  )}
                </Section>

                {/* System rituals — bootstrap-seeded weekly self-maintenance.
                    Whole section dimmed (opacity-65) so it reads as
                    background machinery, not user-facing inbox. Hovering a
                    row brings it back to full opacity. */}
                {systemReminders.length > 0 && (
                  <div className="opacity-65 transition-opacity hover:opacity-100">
                    <Section
                      title="System rituals"
                      subtitle={`Built-in self-maintenance — ${botDisplayName} runs these to keep the workspace clean and the memory index fresh, then reports to Telegram. Platform-managed; not deletable.`}
                    >
                      <div className="flex flex-col gap-2">
                        {systemReminders.map(r => (
                          <SystemReminderRow key={r.id} reminder={r} />
                        ))}
                      </div>
                    </Section>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {deleting && (
        <DeleteReminderModal
          reminder={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => { setDeleting(null); load(); }}
        />
      )}
    </div>
    </TooltipPrimitive.Provider>
  );
}

// ─── Empty State ──────────────────────────────────────────────────────────

function RemindersEmptyState() {
  const { botDisplayName } = useBranding();
  const botName = botDisplayName || 'Assistant';
  return (
    <div className="flex h-full items-center justify-center px-6 py-16">
      <div className="flex max-w-[320px] flex-col items-center gap-3 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground/50">
          <Clock className="size-6" strokeWidth={1.75} />
        </div>
        <h2 className="text-[14px] font-semibold tracking-tight text-foreground/85">No reminders yet</h2>
        <p className="text-[13px] leading-relaxed text-muted-foreground/75">
          Ask <span className="font-medium text-foreground/85">{botName}</span> something like "remind me to follow up with Anna tomorrow at 9", or "set a reminder to delete unnecessary files".
        </p>
      </div>
    </div>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────

// Small per-element hover tooltip (Radix, portaled so the list's overflow
// doesn't clip it). Wrap a SINGLE element; `label` is THAT element's detail.
function InfoTip({ label, side = 'top', children }) {
  if (label == null || label === '') return children;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={10}
          className="z-50 max-w-[18rem] rounded-md border border-border/60 bg-popover px-2.5 py-1.5 text-[11.5px] leading-snug text-popover-foreground shadow-md"
        >
          {label}
          <TooltipPrimitive.Arrow className="fill-popover" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

// Who a reminder is for. Nothing for a plain self-reminder; a "Team" pill for a
// team-wide one; name chips for specific teammates; a muted "from <setter>" when
// someone else scheduled it for you.
function RecipientBadge({ reminder, names = {}, me = null }) {
  const rc = Array.isArray(reminder.recipients) ? reminder.recipients : null;
  const setBy = reminder.setBy || null;
  const fromOther = setBy && me && setBy !== me ? (names[setBy] || setBy) : null;

  let audience = null;            // 'team' | string[] of other recipients
  if (rc) {
    if (rc.includes('*everyone*')) audience = 'team';
    else {
      const others = rc.filter(s => s !== me);
      if (others.length) audience = others.map(s => names[s] || s);
    }
  }
  if (!fromOther && !audience) return null;

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {audience === 'team' && (
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/80">
          <Users className="size-2.5" strokeWidth={2} /> Team
        </span>
      )}
      {Array.isArray(audience) && (
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/80">
          <User className="size-2.5" strokeWidth={2} />
          {audience.slice(0, 2).join(', ')}{audience.length > 2 ? ` +${audience.length - 2}` : ''}
        </span>
      )}
      {fromOther && (
        <span className="text-[10px] italic text-muted-foreground/55">from {fromOther}</span>
      )}
    </span>
  );
}

function ReminderRow({ reminder, names = {}, me = null, onDelete }) {
  const [open, setOpen] = useState(false);
  const due = new Date(reminder.due);
  const overdue = due < new Date();
  const { title, description } = displayParts(reminder);
  const recurLabel = formatRecurrence(reminder);
  const channel = (reminder.channel || 'all').toLowerCase();
  const toggle = () => setOpen((o) => !o);

  return (
    <div className="group overflow-hidden rounded-md border border-border/60 bg-card">
      <div className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/20">
        {/* Click the task (avatar + title + repeat badge) to reveal the description. */}
        <div
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onClick={toggle}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground/70">
            <Bell className="size-3.5" strokeWidth={1.75} />
          </span>
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <span className="min-w-0 truncate text-[13.5px] font-medium leading-snug text-foreground">
              {title}
            </span>
            {/* Repeat badge right after the title. */}
            {recurLabel && (
              <InfoTip label={recurLabel}>
                <span className="inline-flex shrink-0 text-foreground/45">
                  <Repeat className="size-3" strokeWidth={1.75} />
                </span>
              </InfoTip>
            )}
            {/* Who it's for — Team / teammate chips, + "from <setter>" when a
                teammate scheduled it for you. Nothing for a plain self-reminder. */}
            <RecipientBadge reminder={reminder} names={names} me={me} />
          </div>
        </div>

        {/* Right meta — time then channel. */}
        <span className="flex shrink-0 items-center gap-5 text-[11.5px] text-muted-foreground/70">
          <InfoTip label={formatAbsolute(due)}>
            <span className={cn('inline-flex cursor-default items-center gap-1.5 font-medium', overdue ? 'text-destructive' : 'text-foreground/75')}>
              <Calendar className="size-3" strokeWidth={1.75} />
              {formatDue(due)}
            </span>
          </InfoTip>
          <InfoTip label={channelTitle(channel)}>
            <span className="inline-flex cursor-default">
              <ChannelIcon channel={reminder.channel} />
            </span>
          </InfoTip>
        </span>

        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="ml-2 shrink-0 rounded-md p-1.5 text-muted-foreground/40 transition-colors duration-150 hover:bg-destructive/[0.08] hover:text-destructive"
            aria-label="Delete reminder"
            title="Delete reminder"
          >
            <Trash2 className="size-3.5" strokeWidth={1.75} />
          </button>
        )}
      </div>

      {/* Click-to-reveal description, aligned under the title. */}
      {open && (
        <div className="-mt-0.5 pb-3 pl-[3.5rem] pr-4">
          {description ? (
            <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted-foreground/85">
              {description}
            </p>
          ) : (
            <p className="text-[12.5px] italic text-muted-foreground/45">No description.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Section + helpers ────────────────────────────────────────────────────

function Section({ title, subtitle, children }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70">
        {title}
      </h2>
      {subtitle && (
        <p className="text-[13px] leading-relaxed text-muted-foreground/80">
          {subtitle}
        </p>
      )}
      {children}
    </section>
  );
}

function EmptyHint({ children }) {
  return (
    <div className="rounded-md border border-dashed border-border/60 bg-muted/15 px-4 py-3 text-[13px] text-muted-foreground/75">
      {children}
    </div>
  );
}

// ─── System reminder row (read-only) ──────────────────────────────────────
//
// Visually identical to ReminderRow except: no trash button (system rituals
// can't be deleted from chat or UI — they're platform-managed) and no extra
// "system" tag (the section heading + dimmed opacity already convey that).

function SystemReminderRow({ reminder }) {
  // System rituals are platform-managed — same compact, expandable row, just
  // no delete affordance (omitting onDelete hides the trash button).
  return <ReminderRow reminder={reminder} />;
}

// ─── Delete modal ──────────────────────────────────────────────────────────

function DeleteReminderModal({ reminder, onClose, onDeleted }) {
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
      // Guarded cancel — server enforces ownership (member: own only; admin:
      // any; system protected). Replaces rewriting the whole shared file via
      // /api/files/write, which let any member nuke/retarget others'.
      const resp = await fetch('/api/reminders/cancel', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id: reminder.id }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      onDeleted();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const due = new Date(reminder.due);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Delete reminder"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-[3px] animate-[fade-in_0.12s_ease-out]"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-lg bg-background shadow-2xl">
        <div className="flex items-start gap-3.5 px-6 py-5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
            <Trash2 className="size-4 text-destructive" strokeWidth={2} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-foreground">Delete reminder?</div>
            <div className="mt-1 text-[13px] leading-relaxed text-muted-foreground/85">
              <span className="font-medium text-foreground/80">"{displayParts(reminder).title}"</span>
              {' '}— due {formatAbsolute(due)}. This can't be undone.
            </div>
            {error && (
              <div className="mt-3 rounded border border-destructive/25 bg-destructive/[0.04] px-2.5 py-1.5 text-[12px] text-destructive">
                {error}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md p-1 text-muted-foreground/65 transition-colors hover:bg-muted/30 hover:text-foreground/85 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border/50 bg-muted/15 px-6 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded px-3.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground/85 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded bg-destructive px-4 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-95 disabled:opacity-50"
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

// "in 2h" / "5m ago" / "now". Used as the prominent leading time chip.
function formatDue(due) {
  const now = new Date();
  const diff = due - now;
  const abs = Math.abs(diff);
  const min = Math.floor(abs / 60_000);
  const hr  = Math.floor(min / 60);
  const day = Math.floor(hr / 24);

  const part = day > 0 ? `${day}d` : hr > 0 ? `${hr}h` : `${min}m`;
  if (diff < 0) return `${part} ago`;
  if (min < 1)  return 'now';
  return `in ${part}`;
}

// "Tue, May 4 · 11:00 (Europe/Warsaw)". Same locale as the user's browser,
// timezone label spelled out so there's no doubt — reminder.due is UTC.
function formatAbsolute(due) {
  if (Number.isNaN(due.getTime())) return '';
  const date = due.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    year: due.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
  const time = due.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  let tz = '';
  try {
    tz = Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(due)
      .find(p => p.type === 'timeZoneName')?.value || '';
  } catch {}
  return tz ? `${date} · ${time} ${tz}` : `${date} · ${time}`;
}

// Expand "daily"/"weekly" into something with the actual time of day so the
// user sees what to expect, e.g. "every day at 11:00", "every Tuesday at 11:00".
function formatRepeat(repeat, due) {
  const r = (repeat || '').toLowerCase();
  if (r === 'none' || !r) return '';
  if (Number.isNaN(due?.getTime())) return r;
  const time = due.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (r === 'daily')  return `every day at ${time}`;
  if (r === 'weekly') {
    const wd = due.toLocaleDateString(undefined, { weekday: 'long' });
    return `every ${wd} at ${time}`;
  }
  return r;
}

// Human label for a reminder's recurrence. Prefers the structured `recur`
// object (interval / weekly / monthly + until/count); falls back to the legacy
// `repeat` string. Returns '' for one-shot reminders so the caller hides the
// badge. recur times are stored UTC — labelled as such to avoid ambiguity.
function formatRecurrence(reminder) {
  const rec = reminder?.recur;
  if (rec && typeof rec === 'object' && rec.type) {
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    let s;
    if (rec.type === 'interval') {
      const n = rec.every || 1;
      s = n === 1 ? `every ${String(rec.unit || '').replace(/s$/, '')}` : `every ${n} ${rec.unit}`;
    } else if (rec.type === 'weekly') {
      s = `${(rec.days || []).map(cap).join('/')} at ${rec.at} UTC`;
    } else if (rec.type === 'monthly') {
      s = `monthly · day ${rec.day} at ${rec.at} UTC`;
    } else {
      s = 'recurring';
    }
    if (rec.until) {
      const u = new Date(rec.until);
      if (!Number.isNaN(u.getTime())) s += ` · until ${u.toLocaleDateString()}`;
    }
    if (rec.count) s += ` · ${rec.count}×`;
    return s;
  }
  return formatRepeat(reminder?.repeat, new Date(reminder?.due));
}

// Per-reminder delivery surface. Compact inline label that sits in the
// same metadata row as the due-date / repeat info: "Channel: <icon>".
// Telegram uses a paper-plane glyph (closest mark-recognisable lucide
// shape — the upstream brand mark would need an SVG import). Web uses a
// globe. "Both" stacks the two side by side.
// Compact channel glyph(s) only — used inline on the slim title row. The
// labelled "Channel: …" variant (ChannelInline) lives in the expanded detail.
function ChannelIcon({ channel }) {
  const c = (channel || 'all').toLowerCase();
  return (
    <span className="inline-flex items-center text-muted-foreground/65">
      {c === 'telegram' && <Send className="size-3" strokeWidth={1.75} aria-label="Telegram" />}
      {c === 'web' && <Globe className="size-3" strokeWidth={1.75} aria-label="Web UI" />}
      {(c === 'all' || (c !== 'telegram' && c !== 'web')) && (
        <span className="inline-flex items-center gap-1.5">
          <Send className="size-3" strokeWidth={1.75} aria-label="Telegram" />
          <Globe className="size-3" strokeWidth={1.75} aria-label="Web UI" />
        </span>
      )}
    </span>
  );
}

function ChannelInline({ channel }) {
  const c = (channel || 'all').toLowerCase();
  return (
    <span className="inline-flex items-center gap-1.5 text-foreground/70" title={channelTitle(c)}>
      <span className="text-muted-foreground/70">Channel:</span>
      {c === 'telegram' && <Send className="size-3" strokeWidth={1.75} aria-label="Telegram" />}
      {c === 'web' && <Globe className="size-3" strokeWidth={1.75} aria-label="Web UI" />}
      {(c === 'all' || (c !== 'telegram' && c !== 'web')) && (
        <span className="inline-flex items-center gap-0.5">
          <Send  className="size-3" strokeWidth={1.75} aria-label="Telegram" />
          <span className="text-muted-foreground/55">+</span>
          <Globe className="size-3" strokeWidth={1.75} aria-label="Web UI" />
        </span>
      )}
    </span>
  );
}

function channelTitle(c) {
  if (c === 'telegram') return 'Fires on Telegram';
  if (c === 'web')      return 'Fires in the web UI';
  return 'Fires on both surfaces';
}
