import { useEffect, useState } from 'react';
import { Bell, Calendar, Repeat, CheckCircle2, AlertCircle, Send, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import EditorHeader from '../EditorHeader.jsx';

/**
 * RemindersView — list of timed reminders managed by reminder-mcp.
 *
 * Reminders live at `~/project/.reminders.json`. Schema (from
 * ide-template/apps/reminder-mcp/index.js):
 *
 *   { id, message, due (ISO), repeat: 'none'|'daily'|'weekly',
 *     created (ISO), status: 'pending' | 'sent' | 'cancelled' }
 *
 * Polled every 30 s — the watcher filters out dot-prefixed paths so we can't
 * SSE-react to reminder changes. 30 s latency is acceptable; reminder-monitor
 * itself fires due reminders on a 60 s tick.
 */
export default function RemindersView({ sidebarOpen }) {
  const [state, setState] = useState({ status: 'loading' });
  // Telegram is the only delivery channel — without it, reminders fire
  // but there's nowhere to deliver them. We poll integration state to
  // know whether to dim the list and surface a setup banner.
  const [telegramActive, setTelegramActive] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    async function tick() {
      try {
        const [remindersResp, integrationsResp] = await Promise.all([
          fetch('/api/files/read?path=.reminders.json'),
          fetch('/api/integrations'),
        ]);
        if (cancelled) return;
        if (remindersResp.status === 404) {
          setState({ status: 'ok', reminders: [] });
        } else if (remindersResp.ok) {
          const data = await remindersResp.json();
          let parsed = [];
          try { parsed = JSON.parse(data.content); } catch { /* malformed → empty */ }
          if (!Array.isArray(parsed)) parsed = [];
          setState({ status: 'ok', reminders: parsed });
        } else {
          const err = await remindersResp.json().catch(() => ({}));
          setState({ status: 'error', error: err.error || `HTTP ${remindersResp.status}` });
        }
        if (integrationsResp.ok) {
          const ij = await integrationsResp.json();
          const tg = (ij.integrations || ij || []).find?.(x => x?.id === 'telegram');
          setTelegramActive(!!tg?.active);
        }
      } catch (err) {
        if (!cancelled) setState({ status: 'error', error: err.message });
      }
      if (!cancelled) timer = setTimeout(tick, 30_000);
    }
    tick();

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  const reminders = state.status === 'ok' ? state.reminders : [];

  // Group user vs system; sort each by status (pending first) then due/created.
  const sortFn = (a, b) => {
    const aPending = a.status === 'pending';
    const bPending = b.status === 'pending';
    if (aPending !== bPending) return aPending ? -1 : 1;
    if (aPending) return new Date(a.due) - new Date(b.due);
    return new Date(b.created || 0) - new Date(a.created || 0);
  };
  const userReminders   = reminders.filter(r => (r.kind || 'user') !== 'system').sort(sortFn);
  const systemReminders = reminders.filter(r => r.kind === 'system').sort(sortFn);

  const pending = userReminders.filter(r => r.status === 'pending');
  const past    = userReminders.filter(r => r.status !== 'pending');
  const systemPending = systemReminders.filter(r => r.status === 'pending');

  const totalPending = pending.length + systemPending.length;
  const meta = state.status === 'ok'
    ? `${totalPending} pending`
    : state.status === 'error'
      ? <span className="text-destructive">Error</span>
      : null;

  // Reminders fire via Telegram (bot's tmux session). Without an active
  // Telegram integration the timer still runs but there's no delivery
  // channel — entries are dimmed to make this obvious.
  const telegramOff = telegramActive === false;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={Bell} title="Reminders" meta={meta} sidebarOpen={sidebarOpen} />
      <div className="flex-1 overflow-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 pb-10 pt-2">
          {telegramOff && <TelegramBanner />}
          {!telegramOff && telegramActive && reminders.length > 0 && <DeliveryHint />}
          {state.status === 'loading' && <Skeleton />}
          {state.status === 'error'   && <ErrorBox>{state.error}</ErrorBox>}
          {state.status === 'ok' && reminders.length === 0 && (
            <Hint>No reminders yet. Ask the assistant to set one: say "remind me about X tomorrow at 9".</Hint>
          )}
          {pending.length > 0 && (
            <Section title="Pending">
              {pending.map(r => <Card key={r.id} reminder={r} dimmed={telegramOff} />)}
            </Section>
          )}
          {past.length > 0 && (
            <Section title="Past">
              {past.map(r => <Card key={r.id} reminder={r} faded dimmed={telegramOff} />)}
            </Section>
          )}
          {systemPending.length > 0 && (
            <Section title="System rituals" subtitle="Built-in weekly self-maintenance. Cancellable only via the Reminders panel below; the assistant won't remove these.">
              {systemPending.map(r => <Card key={r.id} reminder={r} dimmed={telegramOff} system />)}
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

function TelegramBanner() {
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
      <div className="flex items-start gap-2.5">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" strokeWidth={1.75} />
        <div className="flex-1">
          <div className="font-medium text-foreground/90">Reminders need Telegram to deliver</div>
          <div className="mt-0.5 text-[13px] text-muted-foreground/85">
            Reminders are sent through the Telegram bot. Telegram is currently <strong>not active</strong> for this workspace, so anything scheduled below will fire on time but has nowhere to land.
          </div>
          <a
            href="?view=integrations"
            className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2.5 py-1 text-[12px] font-medium text-foreground/85 transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            <Settings className="size-3" strokeWidth={2} />
            Set up Telegram
          </a>
        </div>
      </div>
    </div>
  );
}

function DeliveryHint() {
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted-foreground/70">
      <Send className="size-3" strokeWidth={1.75} />
      Reminders are delivered via Telegram when due.
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
        {title}
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

function Card({ reminder, faded }) {
  const due = new Date(reminder.due);
  const overdue = reminder.status === 'pending' && due < new Date();
  return (
    <div className={cn(
      'rounded-md border bg-background p-3 text-sm shadow-xs',
      faded && 'opacity-65',
    )}>
      <div className="flex items-start gap-2">
        <StatusIcon status={reminder.status} overdue={overdue} />
        <div className="min-w-0 flex-1">
          <div className={cn(
            'leading-snug',
            reminder.status !== 'pending' && 'line-through text-muted-foreground/80',
          )}>
            {reminder.message}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground/80">
            <span className={cn('inline-flex items-center gap-1', overdue && 'text-destructive')}>
              <Calendar className="size-3" strokeWidth={1.75} />
              {formatDue(due)}
            </span>
            {reminder.repeat && reminder.repeat !== 'none' && (
              <span className="inline-flex items-center gap-1">
                <Repeat className="size-3" strokeWidth={1.75} />
                {reminder.repeat}
              </span>
            )}
            <span className="text-muted-foreground/50">{reminder.id}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusIcon({ status, overdue }) {
  if (status === 'sent')      return <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" strokeWidth={1.75} />;
  if (status === 'cancelled') return <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60" strokeWidth={1.75} />;
  if (overdue)                return <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" strokeWidth={2} />;
  return <Bell className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" strokeWidth={1.75} />;
}

function formatDue(d) {
  if (isNaN(d.getTime())) return 'invalid date';
  // Show as YYYY-MM-DD HH:MM (local, since user reads locally)
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function Hint({ children }) {
  return (
    <div className="rounded-md border border-dashed bg-muted/20 px-4 py-3 text-sm text-muted-foreground/80">
      {children}
    </div>
  );
}

function ErrorBox({ children }) {
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      {children}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-2">
      {[0, 1, 2].map(i => <div key={i} className="h-14 animate-pulse rounded-md bg-muted/40" />)}
    </div>
  );
}
