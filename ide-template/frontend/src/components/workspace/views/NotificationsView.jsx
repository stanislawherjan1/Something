import { useMemo } from 'react';
import BotPicture from '../BotPicture.jsx';
import { useNavigate } from 'react-router-dom';
import { Bell, BellOff, Check, Inbox } from 'lucide-react';
import { cn } from '@/lib/utils';
import EditorHeader from '../EditorHeader.jsx';
import useNotifications from '../useNotifications.js';
import useDesktopNotifications from '../useDesktopNotifications.js';
import useNotificationReadState from '../useNotificationReadState.js';
import { SkeletonLine, SkeletonCircle } from '../SkeletonLoader.jsx';
import { useBranding, BrandedImage, BOT_FALLBACK } from '../identity.jsx';

/**
 * NotificationsView — inbox of server-pushed events from the bot.
 *
 * Each entry is a clickable row. Clicking dispatches an
 * `ide:chat-select-session` window event that ChatPane listens for,
 * switching the right-pane Assistant chat to the auto-created session
 * that contains the bot's full message. The click also marks the
 * notification as read: its red dot goes, the row turns quieter (it stays
 * on the list), and the Sidebar's unread dot clears with the last one.
 *
 * Layout mirrors RemindersDashboard for visual consistency: shared
 * EditorHeader on top (no subtitle, action chips on the right), and
 * each row is a flex card inside a divided container.
 */
export default function NotificationsView({ sidebarOpen }) {
  const { notifications, connecting } = useNotifications();
  const desktop = useDesktopNotifications(notifications);
  const { isRead, markRead, markAllRead } = useNotificationReadState();
  const navigate = useNavigate();

  // Read notifications stay on the list, quieter; new ones carry a red dot.
  // Without the read ones there is nothing to tell the new ones apart from.
  const items = useMemo(
    () => [...notifications].sort((a, b) => (b.ts || '').localeCompare(a.ts || '')),
    [notifications],
  );
  const unread = items.filter((n) => !isRead(n.id));

  const onOpen = (n) => {
    // A memory-write notification opens the memory page; a session notification
    // opens that chat. Either way it's then marked read (loses its red dot).
    if (n.kind === 'memory') {
      navigate('/memory');
    } else if (n.meta?.session_id) {
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
        meta={(
          <div className="inline-flex items-center gap-2">
            <DesktopToggle desktop={desktop} />
            {unread.length > 0 && (
              <button
                type="button"
                onClick={() => markAllRead(unread.map((n) => n.id))}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-[6px] border border-border/60 bg-card px-2.5 py-1',
                  'text-[11.5px] text-muted-foreground/80 transition-colors',
                  'hover:bg-muted/40 hover:text-foreground',
                )}
              >
                <Check className="size-3.5" strokeWidth={2} aria-hidden />
                Mark all as read
              </button>
            )}
          </div>
        )}
      />
      <div className="flex flex-1 flex-col overflow-auto">
        <div className="flex min-h-full flex-1 flex-col gap-7 px-6 pb-12 pt-5">
          {connecting && items.length === 0 ? (
            <div className="flex flex-col divide-y divide-border/60 border-y border-border/60">
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </div>
          ) : items.length === 0 ? (
            <EmptyState />
          ) : (
            // One list on hairlines, like Tasks and Routines — not a stack of cards.
            <div className="flex flex-col divide-y divide-border/60 border-y border-border/60">
              {items.map((n) => (
                <Row key={n.id} n={n} unread={!isRead(n.id)} onOpen={() => onOpen(n)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ n, unread, onOpen }) {
  const { botAvatarUrl } = useBranding();
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-start gap-3 px-2 py-3.5 text-left transition-colors hover:bg-muted/30"
    >
      <span className="relative shrink-0">
        <BotPicture className={cn('size-8 rounded-full ring-1 ring-foreground/10', !unread && 'opacity-60')} />
        {unread && (
          <span aria-label="New" className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-red-500 ring-2 ring-background" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        {n.title ? (
          <div className={cn('line-clamp-2 text-[13px] leading-snug', unread ? 'font-medium text-foreground/90' : 'text-foreground/60')}>
            {n.title}
          </div>
        ) : null}
        {n.body ? (
          <div className={cn('mt-0.5 line-clamp-2 text-[12.5px] leading-relaxed', unread ? 'text-muted-foreground/80' : 'text-muted-foreground/55')}>
            {n.body}
          </div>
        ) : null}
      </div>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/55">
        {formatAbsolute(n.ts)}
      </span>
    </button>
  );
}

function SkeletonRow() {
  return (
    <div className="flex items-start gap-3 px-2 py-3.5">
      <SkeletonCircle size="32px" />
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
        className="inline-flex items-center gap-1.5 rounded-[6px] border border-border bg-muted px-2.5 py-1 text-[11px] text-muted-foreground"
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
          'inline-flex items-center gap-1.5 rounded-[6px] border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-foreground',
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
      role="switch"
      aria-checked={enabled}
      onClick={() => setEnabled(!enabled)}
      title={enabled ? 'Click to disable desktop notifications' : 'Click to allow desktop notifications'}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[6px] border px-2.5 py-1 text-[11.5px] transition-colors',
        enabled
          ? 'border-border/70 bg-card text-foreground/85 hover:bg-muted/40'
          : 'border-dashed border-border/60 bg-background text-muted-foreground/75 hover:text-foreground/85',
      )}
    >
      {enabled
        ? <Bell    className="size-3.5" strokeWidth={2} aria-hidden />
        : <BellOff className="size-3.5" strokeWidth={2} aria-hidden />}
      Desktop notifications
    </button>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center px-6 py-16">
      <div className="flex max-w-[320px] flex-col items-center gap-3 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground/50">
          <Inbox className="size-6" strokeWidth={1.75} />
        </div>
        <h2 className="text-[14px] font-semibold tracking-tight text-foreground/85">Nothing here yet</h2>
        <p className="text-[13px] leading-relaxed text-muted-foreground/75">
          Reminders, skill results and messages from your bot land here.
        </p>
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
