import { useState, useEffect, useCallback, useMemo } from 'react';
import { Calendar, Repeat, Loader2, Trash2, X, Send, Globe, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import EditorHeader from '../EditorHeader.jsx';
import { useBranding, BrandedImage, BOT_FALLBACK } from '../identity';
import { useApi } from '@/lib/useApi';
import { SkeletonRow } from '@/components/ui/Skeleton';

const REMINDERS_FILE = '.reminders.json';
const REMINDERS_URL  = `/api/files/read?path=${encodeURIComponent(REMINDERS_FILE)}`;

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

  const isInitialLoad = loading && !data && !(error && error.includes('404'));

  // Parse reminders out of the raw file contents we got from /api/files/read.
  // The file might not exist yet (404 → empty list) or be malformed (we
  // ignore bad JSON to avoid a crashing UI).
  const all = useMemo(() => {
    if (!data?.content) return [];
    try {
      const parsed = JSON.parse(data.content);
      if (!Array.isArray(parsed)) return [];
      return parsed.slice().sort((a, b) => new Date(a.due) - new Date(b.due));
    } catch {
      return [];
    }
  }, [data]);

  // Split system rituals (baseline weekly self-maintenance the bootstrap
  // seeded — bot-managed, not user-cancellable from chat) from user-created
  // reminders. Display them in separate sections so the user knows which
  // ones they can/should mess with.
  const userReminders   = useMemo(() => all.filter(r => (r.kind || 'user') !== 'system'), [all]);
  const systemReminders = useMemo(() => all.filter(r => r.kind === 'system'), [all]);

  // 404 is fine — file just doesn't exist yet. Other errors are real.
  const realError = error && !error.includes('404') ? error : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={Clock} title="Reminders" sidebarOpen={sidebarOpen} />

      <div className="flex-1 overflow-auto">
        {!isInitialLoad && !realError && all.length === 0 ? (
          <RemindersEmptyState />
        ) : (
          <div className="flex flex-col gap-7 px-6 pb-12 pt-2">
            {isInitialLoad && (
              <div className="flex flex-col rounded-lg border border-border/60 bg-card divide-y divide-border/50 overflow-hidden">
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
                  subtitle={`Timed nudges ${botDisplayName} has set for itself. Fires on Telegram even when no chat session is active. Ask ${botDisplayName} to schedule new ones; clear out anything stale from here.`}
                >
                  {userReminders.length === 0 ? (
                    <EmptyHint>
                      No personal reminders yet. Try "remind me about X tomorrow at 9".
                    </EmptyHint>
                  ) : (
                    <div className="flex flex-col rounded-lg border border-border/60 bg-card divide-y divide-border/50 overflow-hidden">
                      {userReminders.map(r => (
                        <ReminderRow
                          key={r.id}
                          reminder={r}
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
                      subtitle={`Built-in weekly self-maintenance — ${botDisplayName} runs these to keep the workspace clean and the memory index fresh. Platform-managed; not deletable.`}
                    >
                      <div className="flex flex-col rounded-lg border border-border/60 bg-card divide-y divide-border/50 overflow-hidden">
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
          allReminders={all}
          onClose={() => setDeleting(null)}
          onDeleted={() => { setDeleting(null); load(); }}
        />
      )}
    </div>
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

function ReminderRow({ reminder, onDelete }) {
  const { botAvatarUrl } = useBranding();
  const due = new Date(reminder.due);
  const overdue = due < new Date();

  return (
    <div className="group flex items-start gap-3.5 px-4 py-3.5 transition-colors hover:bg-muted/20">
      {/* Bot avatar — every reminder is something the bot scheduled for
          itself, so the avatar makes the ownership obvious at a glance. */}
      <BrandedImage
        src={botAvatarUrl}
        fallback={BOT_FALLBACK}
        alt=""
        className="mt-0.5 size-9 shrink-0 rounded-full object-cover ring-1 ring-foreground/10"
      />

      <div className="min-w-0 flex-1">
        <ReminderHeading reminder={reminder} />

        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground/70">
          <span className={cn('inline-flex items-center gap-1.5 font-medium', overdue ? 'text-destructive' : 'text-foreground/75')}>
            <Calendar className="size-3" strokeWidth={1.75} />
            {formatDue(due)}
          </span>
          <span className="text-muted-foreground/55">·</span>
          <span className="text-muted-foreground/70">{formatAbsolute(due)}</span>
          {reminder.repeat && reminder.repeat !== 'none' && (
            <>
              <span className="text-muted-foreground/55">·</span>
              <span className="inline-flex items-center gap-1.5 text-foreground/70">
                <Repeat className="size-3" strokeWidth={1.75} />
                {formatRepeat(reminder.repeat, due)}
              </span>
            </>
          )}
          <span className="text-muted-foreground/55">·</span>
          <ChannelInline channel={reminder.channel} />
        </div>
      </div>

      <button
        type="button"
        onClick={onDelete}
        className="mt-0.5 rounded-md p-1.5 text-muted-foreground/60 opacity-0 transition-all duration-150 hover:bg-destructive/[0.08] hover:text-destructive group-hover:opacity-100 focus:opacity-100"
        aria-label="Delete reminder"
        title="Delete reminder"
      >
        <Trash2 className="size-3.5" strokeWidth={1.75} />
      </button>
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
  const { botAvatarUrl } = useBranding();
  const due = new Date(reminder.due);
  const overdue = due < new Date();

  return (
    <div className="flex items-start gap-3.5 px-4 py-3.5 transition-colors hover:bg-muted/15">
      <BrandedImage
        src={botAvatarUrl}
        fallback={BOT_FALLBACK}
        alt=""
        className="mt-0.5 size-9 shrink-0 rounded-full object-cover ring-1 ring-foreground/10"
      />

      <div className="min-w-0 flex-1">
        <ReminderHeading reminder={reminder} />

        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground/70">
          <span className={cn('inline-flex items-center gap-1.5 font-medium', overdue ? 'text-destructive' : 'text-foreground/75')}>
            <Calendar className="size-3" strokeWidth={1.75} />
            {formatDue(due)}
          </span>
          <span className="text-muted-foreground/55">·</span>
          <span className="text-muted-foreground/70">{formatAbsolute(due)}</span>
          {reminder.repeat && reminder.repeat !== 'none' && (
            <>
              <span className="text-muted-foreground/55">·</span>
              <span className="inline-flex items-center gap-1.5 text-foreground/70">
                <Repeat className="size-3" strokeWidth={1.75} />
                {formatRepeat(reminder.repeat, due)}
              </span>
            </>
          )}
          <span className="text-muted-foreground/55">·</span>
          <ChannelInline channel={reminder.channel} />
        </div>
      </div>
    </div>
  );
}

// ─── Delete modal ──────────────────────────────────────────────────────────

function DeleteReminderModal({ reminder, allReminders, onClose, onDeleted }) {
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
      const next = (allReminders || []).filter(r => r.id !== reminder.id);
      const resp = await fetch('/api/files/write', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ path: REMINDERS_FILE, content: JSON.stringify(next, null, 2) }),
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

// Per-reminder delivery surface. Compact inline label that sits in the
// same metadata row as the due-date / repeat info: "Channel: <icon>".
// Telegram uses a paper-plane glyph (closest mark-recognisable lucide
// shape — the upstream brand mark would need an SVG import). Web uses a
// globe. "Both" stacks the two side by side.
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
