import { useMemo } from 'react';
import { Bell, BellOff, Inbox, Send, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import EditorHeader from '../EditorHeader.jsx';
import useNotifications from '../useNotifications.js';
import useDesktopNotifications from '../useDesktopNotifications.js';
import useNotificationReadState from '../useNotificationReadState.js';
import { SkeletonLine, SkeletonCircle } from '../SkeletonLoader.jsx';

/**
 * NotificationsView — inbox of server-pushed events from the bot.
 *
 * Each entry is a clickable row. Clicking dispatches an
 * `ide:chat-select-session` window event that ChatPane listens for,
 * switching the right-pane Assistant chat to the auto-created session
 * that contains the bot's full message. The click also marks the
 * notification as read, which removes it from the inbox here and clears
 * the Sidebar's unread dot.
 *
 * Layout mirrors RemindersDashboard for visual consistency: shared
 * EditorHeader on top (no subtitle, action chips on the right), and
 * each row is a flex card inside a divided container.
 */
export default function NotificationsView({ sidebarOpen }) {
  const { notifications, connecting } = useNotifications();
  const desktop = useDesktopNotifications(notifications);
  const { isRead, markRead } = useNotificationReadState();

  const items = useMemo(
    () =>
      [...notifications]
        .filter((n) => !isRead(n.id))
        .sort((a, b) => (b.ts || '').localeCompare(a.ts || '')),
    [notifications, isRead],
  );

  const onOpen = (n) => {
    if (n.meta?.session_id) {
      window.dispatchEvent(
        new CustomEvent('ide:chat-select-session', {
          detail: { sessionId: n.meta.session_id },
        }),
      );
    }
    markRead(n.id);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader
        icon={Inbox}
        title="Notifications"
        sidebarOpen={sidebarOpen}
        meta={<DesktopToggle desktop={desktop} />}
      />
      <div className="flex-1 overflow-auto">
        <div className="flex flex-col gap-7 px-6 pb-12 pt-2">
          {connecting && items.length === 0 ? (
            <div className="flex flex-col overflow-hidden rounded-lg border border-border/60 bg-card divide-y divide-border/50">
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </div>
          ) : items.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="flex flex-col overflow-hidden rounded-lg border border-border/60 bg-card divide-y divide-border/50">
              {items.map((n) => (
                <Row key={n.id} n={n} onOpen={() => onOpen(n)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ n, onOpen }) {
  const tone = toneFor(n.kind);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group flex w-full items-start gap-3.5 px-4 py-3.5 text-left transition-colors',
        'hover:bg-muted/20',
      )}
    >
      <div
        className={cn(
          'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full ring-1 ring-foreground/10',
          tone.bg,
          tone.fg,
        )}
      >
        <tone.Icon className="size-4" strokeWidth={1.75} aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        {n.title ? (
          <div className="truncate text-sm font-medium leading-snug text-foreground">{n.title}</div>
        ) : null}
        {n.body ? (
          <div className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground">{n.body}</div>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground/70">
          <span>{(n.kind || 'system').toUpperCase()}</span>
          <span className="text-muted-foreground/55">·</span>
          <span>{formatAbsolute(n.ts)}</span>
          {n.meta?.channel ? (
            <>
              <span className="text-muted-foreground/55">·</span>
              <ChannelInline channel={n.meta.channel} />
            </>
          ) : null}
        </div>
      </div>
    </button>
  );
}

function SkeletonRow() {
  return (
    <div className="flex items-start gap-3.5 px-4 py-3.5">
      <SkeletonCircle size="36px" />
      <div className="min-w-0 flex-1 space-y-2">
        <SkeletonLine width="60%" height="14px" />
        <SkeletonLine width="95%" height="13px" />
        <SkeletonLine width="35%" height="11px" />
      </div>
    </div>
  );
}

function DesktopToggle({ desktop }) {
  const { permission, enabled, requestPermission, setEnabled } = desktop;
  if (permission === 'unsupported') return null;
  if (permission === 'denied') {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1 text-[11px] text-muted-foreground"
        title="The browser is blocking desktop notifications for this site. Unblock in browser settings to enable."
      >
        <BellOff className="size-3.5" aria-hidden />
        Blocked
      </span>
    );
  }
  if (permission === 'default') {
    return (
      <button
        type="button"
        onClick={requestPermission}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-foreground',
          'transition-colors hover:bg-accent/40',
        )}
      >
        <Bell className="size-3.5" aria-hidden />
        Enable desktop popups
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEnabled(!enabled)}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors',
        enabled
          ? 'border-border bg-card text-foreground hover:bg-accent/40'
          : 'border-dashed border-border bg-background text-muted-foreground hover:text-foreground',
      )}
      aria-pressed={enabled}
    >
      {enabled ? <Bell className="size-3.5" aria-hidden /> : <BellOff className="size-3.5" aria-hidden />}
      Desktop popups {enabled ? 'on' : 'off'}
    </button>
  );
}

function ChannelInline({ channel }) {
  const c = (channel || 'all').toLowerCase();
  if (c === 'telegram') return <span className="inline-flex items-center gap-1.5"><Send  className="size-3" strokeWidth={1.75} /> Telegram</span>;
  if (c === 'web')      return <span className="inline-flex items-center gap-1.5"><Globe className="size-3" strokeWidth={1.75} /> Web</span>;
  return null;
}

function EmptyState() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center pt-10 text-center text-muted-foreground">
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted">
        <Inbox className="size-5" aria-hidden />
      </div>
      <div className="text-sm font-medium text-foreground">Nothing here yet.</div>
      <div className="mt-2 max-w-xs text-sm leading-relaxed">
        When the bot fires a reminder, finishes a skill, or processes a
        Telegram message, an entry lands here. Click one to open the
        conversation.
      </div>
    </div>
  );
}

function toneFor(kind) {
  switch (kind) {
    case 'bot':
      return { bg: 'bg-emerald-50 dark:bg-emerald-950/40', fg: 'text-emerald-700 dark:text-emerald-300', Icon: Bell };
    case 'reminder':
      return { bg: 'bg-amber-50 dark:bg-amber-950/40', fg: 'text-amber-700 dark:text-amber-300', Icon: Bell };
    default:
      return { bg: 'bg-muted', fg: 'text-muted-foreground', Icon: Bell };
  }
}

function formatAbsolute(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `today ${h}:${m}`;
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}.${month} ${h}:${m}`;
}
