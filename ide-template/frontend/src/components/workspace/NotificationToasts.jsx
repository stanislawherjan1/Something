import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import useNotifications from './useNotifications.js';

const VISIBLE_MS = 8_000;
// Show only the newest live notification as a bubble next to the avatar.
// Older ones still live in the Notifications inbox; users open the chat
// (or that view) to see the rest.
const STACK_LIMIT = 1;

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
export default function NotificationToasts({ chatOpen = false }) {
  const { notifications } = useNotifications();
  const [dismissed, setDismissed] = useState(() => new Set());

  // When the chat is expanded, the bubble would just visually duplicate
  // what the chat history dropdown already shows (each notification is
  // its own session entry). Suppress here; the inbox view remains the
  // canonical archive.
  const hidden = chatOpen;

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

  if (hidden || !visible.length) return null;

  return (
    <div
      // Toasts dock under the floating bot avatar (top-right) so each new
      // event reads as a speech bubble emanating from the bot. Avatar
      // itself lives at `top-5 right-5` (or top-[68px] when the Telegram
      // banner is showing) at size-12 — we leave ~72px of clearance for
      // the avatar circle + its drop-shadow before the first bubble.
      className="pointer-events-none fixed top-[88px] right-5 z-50 flex w-[22rem] max-w-[calc(100vw-2.5rem)] flex-col gap-3"
      aria-live="polite"
      aria-atomic="false"
    >
      <AnimatePresence initial={false}>
        {visible.map((n, index) => (
          <motion.div
            key={n.id}
            layout
            initial={{ opacity: 0, y: -12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
            className={cn(
              'group pointer-events-auto relative rounded-md border border-border bg-card shadow-lg',
              'flex gap-4 px-5 py-4 text-sm',
              // Very subtle solid colour shift on hover — neutral-50 is one
              // step off white, dark:neutral-900 one step off the dark card.
              // No opacity blending; the tail mirrors via group-hover.
              n.meta?.session_id ? 'cursor-pointer transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-900' : '',
            )}
            onClick={() => {
              if (!n.meta?.session_id) return;
              window.dispatchEvent(new CustomEvent('ide:chat-select-session', {
                detail: { sessionId: n.meta.session_id },
              }));
              setDismissed((prev) => {
                const next = new Set(prev);
                next.add(n.id);
                return next;
              });
            }}
          >
            {/* Speech-bubble tail on the topmost bubble — visually
                connects the stack to the floating avatar above it. */}
            {index === 0 && (
              <span className="pointer-events-none absolute -top-[7px] right-4 size-3 rotate-45 border-l border-t border-border bg-card transition-colors group-hover:bg-neutral-50 dark:group-hover:bg-neutral-900" />
            )}
            <div className="min-w-0 flex-1">
              {n.title ? (
                <div className="truncate font-medium leading-snug text-foreground">{n.title}</div>
              ) : null}
              {n.body ? (
                <div className="mt-1.5 line-clamp-3 leading-relaxed text-muted-foreground">{n.body}</div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setDismissed((prev) => {
                  const next = new Set(prev);
                  next.add(n.id);
                  return next;
                });
              }}
              className="-mr-1 -mt-1 shrink-0 self-start rounded p-1.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
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

