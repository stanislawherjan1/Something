import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bell, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import useNotifications from './useNotifications.js';

const VISIBLE_MS = 8_000;
const STACK_LIMIT = 4;

/**
 * NotificationToasts — bottom-right overlay stack for server-pushed
 * notifications (reminders, system events, future skill-completion
 * pings). Phase 1 of WEB_CHAT_PUSH: just an in-page surface, no desktop
 * Notification API yet, no per-channel filtering, no Bot Chat thread
 * yet. Those land on follow-up branches.
 *
 * Mounts globally inside WorkspacePage so the toast surface is
 * available regardless of which view is active. Subscribes once via
 * useNotifications() and renders the tail of the stream as a small
 * dismissible stack.
 *
 * Toasts auto-dismiss after 8s OR on manual close. A notification can
 * still be re-shown from the server-side ring buffer on tab reopen, but
 * once dismissed in-session it stays dismissed until a new id arrives.
 */
export default function NotificationToasts() {
  const notifications = useNotifications();
  const [dismissed, setDismissed] = useState(() => new Set());

  // Drop any auto-dismissals after VISIBLE_MS by adding their id into the
  // dismissed set. The actual fade-out is handled by AnimatePresence;
  // we just stop including them in the visible list.
  useEffect(() => {
    const fresh = notifications.filter(
      (n) => !n.replay && !dismissed.has(n.id),
    );
    if (!fresh.length) return;
    const timers = fresh.slice(-STACK_LIMIT).map((n) =>
      setTimeout(() => {
        setDismissed((prev) => {
          const next = new Set(prev);
          next.add(n.id);
          return next;
        });
      }, VISIBLE_MS),
    );
    return () => timers.forEach(clearTimeout);
  }, [notifications, dismissed]);

  const visible = notifications
    .filter((n) => !n.replay)             // live arrivals only — never pop a toast for a ring-buffer replay
    .filter((n) => !dismissed.has(n.id))
    .slice(-STACK_LIMIT);

  if (!visible.length) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-6 right-6 z-50 flex w-[22rem] max-w-[calc(100vw-3rem)] flex-col gap-3"
      aria-live="polite"
      aria-atomic="false"
    >
      <AnimatePresence initial={false}>
        {visible.map((n) => (
          <motion.div
            key={n.id}
            layout
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
            className={cn(
              'pointer-events-auto rounded-md border border-border bg-card shadow-lg',
              'flex gap-4 px-5 py-4 text-sm',
            )}
          >
            <Bell className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              {n.title ? (
                <div className="truncate font-medium leading-snug text-foreground">{n.title}</div>
              ) : null}
              {n.body ? (
                <div className="mt-1.5 line-clamp-3 leading-relaxed text-muted-foreground">{n.body}</div>
              ) : null}
              <div className="mt-3 text-[11px] uppercase tracking-wide text-muted-foreground/70">
                {n.kind || 'system'} · {formatTs(n.ts)}
              </div>
            </div>
            <button
              type="button"
              onClick={() =>
                setDismissed((prev) => {
                  const next = new Set(prev);
                  next.add(n.id);
                  return next;
                })
              }
              className="-mr-1 shrink-0 rounded p-1.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
              aria-label="Dismiss"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function formatTs(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}
