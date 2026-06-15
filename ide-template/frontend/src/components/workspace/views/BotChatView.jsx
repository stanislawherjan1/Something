import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import useNotifications from '../useNotifications.js';

/**
 * BotChatView — full-pane "chat with your bot" surface.
 *
 * Inbound (left bubbles): server-pushed events from /api/notifications/stream
 * via useNotifications. Kind 'bot' renders as an assistant bubble; kind
 * 'reminder' (or anything other than 'user') renders as a center system
 * line. The ring buffer on the server replays the last 50 entries on
 * connect so a fresh tab boots with recent context already loaded.
 *
 * Outbound (right bubbles): the user types into the input bar at the
 * bottom; on send the text POSTs to /api/bot/send and is optimistically
 * appended to the local thread. The wsapi spawns the setuid bot-relay
 * helper which tmux send-keys-s the message into the bot's persistent
 * Claude session with a [WEB_USER] prefix — the bot then replies via
 * web_send_message (per its memory-prefix routing rules) and the reply
 * arrives back through the SSE stream.
 *
 * This is the Phase 3 client surface for the WEB_CHAT_PUSH feature. Web
 * push is independent of the Telegram channel; users on TG-less clients
 * get a fully functional bot here. The toast overlay still runs at the
 * workspace root for events that fire while the user isn't on this view.
 */
export default function BotChatView({ sidebarOpen }) {
  const notifications = useNotifications();
  const [outgoing, setOutgoing] = useState([]);   // user messages (right bubble)
  const [pending, setPending]   = useState(false); // POST in-flight
  const [input, setInput]       = useState('');
  const [sendError, setSendError] = useState(null);
  const scrollerRef = useRef(null);
  const inputRef    = useRef(null);

  // Merge inbound notifications + outgoing user messages into one sorted
  // timeline. The ring buffer guarantees notifications carry an iso ts
  // string; outgoing messages get one stamped at send time client-side.
  const thread = useMemo(() => {
    const inbound = notifications.map((n) => ({
      id:   `in:${n.id}`,
      side: n.kind === 'bot' ? 'bot' : 'system',
      kind: n.kind,
      title: n.title || '',
      body:  n.body  || '',
      ts:   n.ts,
    }));
    const out = outgoing.map((o) => ({
      id:   `out:${o.id}`,
      side: o.failed ? 'user-failed' : 'user',
      title: '',
      body:  o.text,
      ts:   o.ts,
    }));
    return [...inbound, ...out].sort((a, b) =>
      (a.ts || '').localeCompare(b.ts || ''),
    );
  }, [notifications, outgoing]);

  // Auto-scroll to bottom on new message, but only if the user is
  // already near the bottom (so reviewing history isn't yanked).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 120) {
      el.scrollTop = el.scrollHeight;
    }
  }, [thread.length]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || pending) return;
    const id = `u_${Math.random().toString(36).slice(2, 10)}`;
    const ts = new Date().toISOString();
    setOutgoing((prev) => [...prev, { id, text, ts }]);
    setInput('');
    setSendError(null);
    setPending(true);
    try {
      const r = await fetch('/api/bot/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        const msg = data?.error || `wsapi ${r.status}`;
        setOutgoing((prev) =>
          prev.map((o) => (o.id === id ? { ...o, failed: true } : o)),
        );
        setSendError(msg);
      }
    } catch (err) {
      setOutgoing((prev) =>
        prev.map((o) => (o.id === id ? { ...o, failed: true } : o)),
      );
      setSendError(err.message);
    } finally {
      setPending(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [input, pending]);

  const onKey = useCallback(
    (e) => {
      // Enter sends. Shift+Enter inserts a newline (consistent with the
      // workspace chat).
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
    [send],
  );

  return (
    <div className={cn('flex h-full min-h-0 flex-col', sidebarOpen ? '' : 'pl-12')}>
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-background px-5 py-3">
        <div className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Bell className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">Bot</div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
            web channel · live
          </div>
        </div>
      </header>

      <div
        ref={scrollerRef}
        className="flex-1 overflow-y-auto px-5 py-6"
      >
        {thread.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-3">
            {thread.map((m) => (
              <Bubble key={m.id} m={m} />
            ))}
          </div>
        )}
      </div>

      {sendError ? (
        <div className="mx-auto w-full max-w-2xl px-5 pb-2 text-xs text-destructive">
          Could not send: {sendError}
        </div>
      ) : null}

      <div className="shrink-0 border-t border-border bg-background px-5 py-3">
        <div className="mx-auto flex max-w-2xl items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder="Napisz do bota…"
            rows={1}
            disabled={pending}
            className={cn(
              'flex-1 resize-none rounded-md border border-border bg-card px-3 py-2 text-sm',
              'placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring',
              'max-h-40',
            )}
            style={{ minHeight: '38px' }}
          />
          <button
            type="button"
            onClick={send}
            disabled={!input.trim() || pending}
            aria-label="Send"
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-md',
              'bg-primary text-primary-foreground transition-colors',
              'hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground/50',
            )}
          >
            <Send className="size-4" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}

function Bubble({ m }) {
  if (m.side === 'system') {
    return (
      <div className="flex justify-center py-2">
        <div className="rounded-md border border-dashed border-border bg-background px-3 py-1.5 text-xs text-muted-foreground">
          ⏰ {m.title || 'Reminder'}
          {m.body ? ` · ${m.body}` : ''}
          <span className="ml-2 opacity-60">{formatTs(m.ts)}</span>
        </div>
      </div>
    );
  }
  if (m.side === 'user' || m.side === 'user-failed') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%]">
          <div
            className={cn(
              'rounded-md px-3.5 py-2 text-sm leading-relaxed',
              m.side === 'user-failed'
                ? 'border border-destructive/40 bg-destructive/5 text-foreground'
                : 'bg-primary text-primary-foreground',
            )}
          >
            {m.body || m.title}
          </div>
          <div className="mt-0.5 text-right text-[10px] text-muted-foreground/70">
            {formatTs(m.ts)} {m.side === 'user-failed' ? '· failed' : ''}
          </div>
        </div>
      </div>
    );
  }
  // bot side
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%]">
        <div className="rounded-md border border-border bg-card px-3.5 py-2 text-sm leading-relaxed text-foreground">
          {m.title ? (
            <div className="mb-1 font-medium leading-snug">{m.title}</div>
          ) : null}
          {m.body ? (
            <div className="whitespace-pre-wrap text-foreground">{m.body}</div>
          ) : null}
        </div>
        <div className="mt-0.5 text-[10px] text-muted-foreground/70">
          BOT · {formatTs(m.ts)}
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center text-center text-muted-foreground">
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted">
        <Bell className="size-5" aria-hidden />
      </div>
      <div className="text-sm font-medium text-foreground">Cześć! Jestem twój bot.</div>
      <div className="mt-2 max-w-xs text-sm leading-relaxed">
        Powiedz co masz w głowie — przypomnienie, podsumowanie maila,
        wyszukanie czegoś w plikach. Pamiętam o czym rozmawialiśmy,
        działam w tle 24/7.
      </div>
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
