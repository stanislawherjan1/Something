import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Inbox } from 'lucide-react';
import { cn } from '@/lib/utils';
import useNotifications from '../useNotifications.js';

/**
 * NotificationsView — compact list of every server-pushed event the user
 * has received in this workspace. Backed by /api/notifications/stream
 * (same source as the toast overlay + BotChatView), so the server-side
 * ring buffer replays the last ~50 entries on connect.
 *
 * Rows are click-targets: clicking a notification navigates to /bot
 * where the full thread (this notification + the bot's reply, if any)
 * lives. Future polish: pass a ?focus=<id> param and have BotChatView
 * scroll + briefly highlight that bubble.
 *
 * Distinct from the toast: toast is ephemeral and only shows what
 * happened recently. This view is the durable archive — "what did the
 * bot do while I was away".
 */
export default function NotificationsView({ sidebarOpen }) {
  const notifications = useNotifications();
  const navigate = useNavigate();

  // Newest first.
  const items = useMemo(
    () => [...notifications].sort((a, b) => (b.ts || '').localeCompare(a.ts || '')),
    [notifications],
  );

  return (
    <div className={cn('flex h-full min-h-0 flex-col', sidebarOpen ? '' : 'pl-12')}>
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-background px-5 py-3">
        <div className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Inbox className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">Notifications</div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
            {items.length} event{items.length === 1 ? '' : 's'} · click to open the conversation
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        {items.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-2">
            {items.map((n) => (
              <Row key={n.id} n={n} onOpen={() => navigate('/bot')} />
            ))}
          </div>
        )}
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
        'group flex w-full items-start gap-3 rounded-md border border-border bg-card px-4 py-3 text-left',
        'transition-colors hover:bg-accent/40',
      )}
    >
      <div
        className={cn(
          'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md',
          tone.bg, tone.fg,
        )}
      >
        <tone.Icon className="size-3.5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        {n.title ? (
          <div className="truncate text-sm font-medium leading-snug text-foreground">{n.title}</div>
        ) : null}
        {n.body ? (
          <div className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground">{n.body}</div>
        ) : null}
        <div className="mt-2 flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground/70">
          <span>{n.kind || 'system'}</span>
          <span>·</span>
          <span>{formatAbsoluteTs(n.ts)}</span>
        </div>
      </div>
    </button>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center text-center text-muted-foreground">
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted">
        <Inbox className="size-5" aria-hidden />
      </div>
      <div className="text-sm font-medium text-foreground">Nic się jeszcze nie wydarzyło.</div>
      <div className="mt-2 max-w-xs text-sm leading-relaxed">
        Gdy bot odbije się o reminder, wykona skill, albo dostanie wiadomość
        z Telegrama — pojawi się tu wpis. Klik otworzy rozmowę.
      </div>
    </div>
  );
}

function toneFor(kind) {
  switch (kind) {
    case 'bot':
      return { bg: 'bg-emerald-100 dark:bg-emerald-950/40', fg: 'text-emerald-700 dark:text-emerald-300', Icon: Bell };
    case 'reminder':
      return { bg: 'bg-amber-100 dark:bg-amber-950/40', fg: 'text-amber-700 dark:text-amber-300', Icon: Bell };
    default:
      return { bg: 'bg-muted', fg: 'text-muted-foreground', Icon: Bell };
  }
}

function formatAbsoluteTs(iso) {
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
