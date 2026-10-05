import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Brain, X, Check, Loader2, Archive, Repeat, History, Lock, Download, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useMemoryStatus, MEMORY_MIGRATION } from './useMemoryStatus.js';
import { cn } from '@/lib/utils';

/*
 * Moving to the new memory (memory v4) — the upgrade bar, the note in the old
 * Memory view, and the review modal. The modal is the review: "Start migration"
 * plans and applies the move on the server (routes/migrations.js, the same code
 * as the operator's CLI). There is no way back in the product: the old memory
 * leaves at the move, and each person can download their own copy of it.
 */

const DISMISS_KEY = 'memory-migration:dismissed';
const MotionDiv = motion.div;

function downloadBackup() {
  const a = document.createElement('a');
  a.href = '/api/memory/backup';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ─────────────────────────── top-of-page bar ─────────────────────────── */

export function MigrationBanner({ onReview }) {
  const { available, admin, migrated } = useMemoryStatus();
  const [dismissed, setDismissed] = useState(() => {
    try { return window.sessionStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  });
  const show = admin && available && !dismissed;
  const dismiss = () => {
    setDismissed(true);
    try { window.sessionStorage.setItem(DISMISS_KEY, '1'); } catch { /* the bar just comes back next time */ }
  };
  // Desktop only, like the Telegram bars: on a phone the chat fills the screen
  // and a bar on top would sit over its header (and its back button).
  return (
    <AnimatePresence>
      {show && (
        <MotionDiv
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="z-[60] shrink-0 border-b border-[--color-sidebar-border] bg-background max-md:hidden"
        >
          <div className="flex h-12 items-center justify-between gap-4 px-4">
            <div className="flex min-w-0 items-center gap-2.5">
              <Brain className="size-4 shrink-0 text-foreground/70" strokeWidth={1.75} />
              <p className="truncate text-[13px] text-foreground/80">
                {!migrated ? (
                  <><span className="font-semibold text-foreground">A new memory is available.</span><span className="max-sm:hidden"> Faster, and it keeps what matters.</span></>
                ) : (
                  <><span className="font-semibold text-foreground">Your memory cards can be tidied.</span><span className="max-sm:hidden"> Facts and projects move to memory; the profile keeps what lasts.</span></>
                )}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={onReview}
                className="rounded-[6px] bg-foreground/[0.09] px-3 py-1.5 text-[12px] font-medium text-foreground/90 transition-colors hover:bg-foreground/[0.14]"
              >
                Review
              </button>
              <button
                type="button"
                onClick={dismiss}
                title="Not now"
                className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground/60 transition-colors hover:bg-muted/50 hover:text-foreground/80"
              >
                <X className="size-3.5" strokeWidth={1.75} />
              </button>
            </div>
          </div>
        </MotionDiv>
      )}
    </AnimatePresence>
  );
}

/* ─────────────────────── strip inside the old Memory view ─────────────────────── */

export function LegacyMemoryNotice({ onReview }) {
  const { available, admin } = useMemoryStatus();
  if (!available) return null;
  return (
    <div className="mx-6 mb-3 flex items-center gap-3 rounded-[6px] border border-border/60 px-4 py-2.5 text-[12.5px] text-foreground/85">
      <Brain className="size-4 shrink-0 text-foreground/70" strokeWidth={1.75} />
      <span className="min-w-0 flex-1">
        This is the <span className="font-medium">legacy memory</span>. A new version is available — nothing changes until {admin ? 'you start it' : 'an admin starts it'}.
      </span>
      {admin && <Button variant="outline" size="xs" onClick={onReview}>Review</Button>}
    </div>
  );
}

/* ─────────────────────────────── the review modal ─────────────────────────────── */

// Steps by migration: the move and the card sort do different things, and a
// step's label should say what is actually happening.
const STEPS_BY_ID = {
  [MEMORY_MIGRATION]: [
    { id: 'plan', label: 'Prepare the move' },
    { id: 'backup', label: 'Back up the current memory' },
    { id: 'apply', label: 'Move your memory and routines into the new one' },
    { id: 'verify', label: 'Check that everything arrived' },
  ],
  '0006-cards-v4': [
    { id: 'plan', label: 'Sort every line of your cards and remembered facts' },
    { id: 'backup', label: 'Back up the current memory' },
    { id: 'apply', label: 'Rewrite the cards, file the facts, fold what is past' },
    { id: 'verify', label: 'Check that everything arrived' },
  ],
};
const stepsFor = (id) => STEPS_BY_ID[id] || STEPS_BY_ID[MEMORY_MIGRATION];

const STALL_MS = 3 * 60_000;
const STUCK_MS = 10 * 60_000;

/** "about 4 min left" from the rate of the batches done so far — measured, not guessed. */
function eta(progress, startedAt) {
  if (!progress?.total || !progress.done) return null;
  const elapsed = Date.now() - Date.parse(startedAt);
  const perUnit = elapsed / progress.done;
  const left = Math.round((perUnit * (progress.total - progress.done)) / 60_000);
  return left <= 0 ? 'under a minute left' : left === 1 ? 'about a minute left' : `about ${left} min left`;
}

function Row({ icon, children }) {
  const Icon = icon;
  return (
    <li className="flex items-start gap-2.5">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-[--color-ring]/80" strokeWidth={1.9} />
      <span className="text-[13px] leading-relaxed text-foreground/85">{children}</span>
    </li>
  );
}

function ReviewBody({ pending }) {
  const isMove = !pending || pending.id === MEMORY_MIGRATION;
  return (
    <div className="flex flex-col gap-5">
      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70">What changes</h3>
        {isMove ? (
          <ul className="flex flex-col gap-2">
            <Row icon={History}>Your assistant remembers from your <b className="font-medium">actual conversations</b>, with dates — it looks things up when you ask instead of carrying everything in every message.</Row>
            <Row icon={Repeat}>Routines move to the <b className="font-medium">Routines</b> page, as a list of their own.</Row>
            <Row icon={Lock}>Private stays private: each person's memory stays in their own space; shared memory stays shared.</Row>
          </ul>
        ) : (
          <ul className="flex flex-col gap-2">
            <Row icon={History}><b className="font-medium">{pending.title}</b></Row>
            {pending.summary && <Row icon={Repeat}>{pending.summary}</Row>}
          </ul>
        )}
      </section>

      <section className="rounded-[6px] border border-border/60 bg-muted/25 px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <Archive className="size-3.5 shrink-0 text-muted-foreground/60" strokeWidth={1.9} />
          <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-foreground/85">Your current memory is backed up first, then replaced.</span>
          <Button variant="outline" size="xs" onClick={downloadBackup}><Download />Download backup</Button>
        </div>
      </section>
    </div>
  );
}

function RunningBody({ step, progress, startedAt, migrationId, onCancel, now }) {
  const STEPS = stepsFor(migrationId);
  const at = Math.max(0, STEPS.findIndex((s) => s.id === step));
  const sinceProgress = progress?.at ? now - Date.parse(progress.at) : now - Date.parse(startedAt);
  const stalled = sinceProgress > STALL_MS;
  const stuck = sinceProgress > STUCK_MS;
  const canCancel = step === 'plan';   // nothing is written before the backup
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] leading-relaxed text-foreground/80">You can close this window — it continues in the background.</p>
      <ol className="flex flex-col gap-2.5">
        {STEPS.map((s, i) => {
          const state = i < at ? 'done' : i === at ? 'active' : 'todo';
          return (
            <li key={s.id} className="flex items-center gap-3">
              <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border',
                state === 'done' && 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
                state === 'active' && 'border-[--color-ring]/40 text-[--color-ring]',
                state === 'todo' && 'border-border text-muted-foreground/40')}>
                {state === 'done' ? <Check className="size-3" strokeWidth={2.5} /> : state === 'active' ? <Loader2 className="size-3 animate-spin" strokeWidth={2.5} /> : <span className="size-1 rounded-full bg-current" />}
              </span>
              <span className={cn('min-w-0 flex-1 text-[13px]', state === 'todo' ? 'text-muted-foreground/60' : 'text-foreground/85')}>
                {s.label}
                {state === 'active' && progress?.total > 0 && (
                  <span className="mt-1.5 block">
                    <span className="block h-1.5 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full bg-foreground/70 transition-all duration-500" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
                    </span>
                    <span className="mt-1 block text-[11.5px] tabular-nums text-muted-foreground/70">
                      {progress.label ? `${progress.label} · ` : ''}{progress.done} of {progress.total}{eta(progress, startedAt) ? ` · ${eta(progress, startedAt)}` : ''}
                    </span>
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {stuck ? (
        <p className="rounded-[6px] border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12.5px] text-foreground/85">
          Nothing has happened for {Math.round(sinceProgress / 60_000)} minutes. It looks stuck.
          {canCancel ? ' Nothing has been changed yet — you can cancel and keep everything as it was.' : ' The backup was taken; cancelling now restores it.'}
        </p>
      ) : stalled ? (
        <p className="text-[12px] text-muted-foreground/70">No progress for {Math.round(sinceProgress / 60_000)} min — still trying.</p>
      ) : null}
      {onCancel && (
        <div>
          <Button variant="ghost" size="xs" onClick={onCancel}>{canCancel ? 'Cancel — keep everything as it was' : 'Cancel and restore the backup'}</Button>
        </div>
      )}
    </div>
  );
}

function CancelledBody() {
  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      <p className="text-[14px] font-medium text-foreground/90">Cancelled.</p>
      <p className="max-w-sm text-[12.5px] leading-relaxed text-muted-foreground/80">Your memory is exactly as it was. You can start again any time.</p>
    </div>
  );
}

function DoneBody() {
  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        <Check className="size-5" strokeWidth={2.25} />
      </span>
      <p className="text-[14px] font-medium text-foreground/90">Your assistant is using the new memory.</p>
      <p className="max-w-sm text-[12.5px] leading-relaxed text-muted-foreground/80">
        Routines are on the Routines page now. Keep the backup if you want a copy of the old memory.
      </p>
      <Button variant="outline" size="xs" onClick={downloadBackup}><Download />Download the backup</Button>
    </div>
  );
}

function FailedBody({ error }) {
  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
        <AlertTriangle className="size-5" strokeWidth={2} />
      </span>
      <p className="text-[14px] font-medium text-foreground/90">It did not finish.</p>
      {/* The message says whether the backup was restored — never assert it here:
          a restore that failed once showed "nothing was changed" beside tar errors. */}
      <p className="max-w-md text-[12.5px] leading-relaxed text-muted-foreground/80">
        {/memory restored/.test(error || '') ? 'Your memory is exactly as it was before. ' : /restore failed/.test(error || '') ? 'The backup could not be put back by itself — the operator can restore it. ' : ''}
        {error && <span className="block mt-1.5 max-h-40 overflow-y-auto whitespace-pre-line rounded bg-muted/40 px-2 py-1 text-left text-[11.5px] font-mono">{error}</span>}
      </p>
    </div>
  );
}

/** Mounted only while open, so a reopen starts from where the move is. */
export function MigrationModal({ onClose, onOpenMemory }) {
  const status = useMemoryStatus();
  const migrationId = status.pending?.id || MEMORY_MIGRATION;
  const isMove = migrationId === MEMORY_MIGRATION;
  // "Done" is about the move only; a follow-up starts at review even on v4.
  const [state, setState] = useState(() => (status.job?.state === 'running' ? 'running' : isMove && status.migrated ? 'done' : 'review'));
  const [step, setStep] = useState(() => status.job?.step || 'plan');
  const [progress, setProgress] = useState(() => status.job?.progress || null);
  const [startedAt, setStartedAt] = useState(() => status.job?.startedAt || new Date().toISOString());
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState(null);
  // A clock for the ETA and the stall notice: the job's `progress.at` is a
  // timestamp, so "no progress for N min" needs the present, not a render.
  useEffect(() => {
    if (state !== 'running') return;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [state]);
  const cancel = async () => {
    try { await fetch(`/api/migrations/${migrationId}/cancel`, { method: 'POST', credentials: 'same-origin' }); } catch { /* the poll will say */ }
  };

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Follow the job on the server until it ends.
  useEffect(() => {
    if (state !== 'running') return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/migrations/${migrationId}/job`, { credentials: 'same-origin' });
        const d = r.ok ? await r.json() : null;
        const job = d?.job;
        if (stop || !job) return;
        setStep(job.step);
        setProgress(job.progress || null);
        if (job.startedAt) setStartedAt(job.startedAt);
        if (job.state === 'done') { setState('done'); status.reload(); return; }
        if (job.state === 'cancelled') { setState('cancelled'); status.reload(); return; }
        if (job.state === 'failed') { setError(job.error); setState('failed'); status.reload(); return; }
      } catch { /* try again */ }
      if (!stop) setTimeout(tick, 1200);
    };
    tick();
    return () => { stop = true; };
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setError(null);
    setStep('plan');
    try {
      const r = await fetch(`/api/migrations/${migrationId}/start`, { method: 'POST', credentials: 'same-origin' });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setError(d.error || `HTTP ${r.status}`);
        setState('failed');
        return;
      }
      setState('running');
    } catch (e) {
      setError(e.message);
      setState('failed');
    }
  };

  const noun = isMove ? 'memory' : 'your memory cards';
  const title = state === 'running' ? `Updating ${noun}…` : state === 'done' ? (isMove ? 'Memory upgraded' : 'Cards sorted') : state === 'cancelled' ? 'Cancelled' : (isMove ? 'Upgrade memory' : 'Tidy your memory cards');

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[80] flex items-center justify-center modal-backdrop px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden modal-panel">
        <div className="flex items-start gap-3 border-b border-border/40 px-6 py-4">
          <div className="min-w-0 flex-1 self-center">
            <div className="text-[15px] font-semibold text-foreground/90">{title}</div>
            {state === 'review' && <div className="text-[12px] text-muted-foreground/70">Nothing changes until you start. Admins only.</div>}
          </div>
          <button type="button" onClick={onClose} className="rounded-[6px] p-1.5 text-muted-foreground/65 hover:bg-muted/30 hover:text-foreground/85" aria-label="Close">
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {state === 'review' && <ReviewBody pending={status.pending} />}
          {state === 'running' && <RunningBody step={step} progress={progress} startedAt={startedAt} migrationId={migrationId} onCancel={cancel} now={now} />}
          {state === 'cancelled' && <CancelledBody />}
          {state === 'done' && <DoneBody />}
          {state === 'failed' && <FailedBody error={error} />}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/40 px-6 py-3.5">
          {state === 'review' && (
            <>
              <Button variant="ghost" size="sm" onClick={onClose}>Not now</Button>
              <Button size="sm" onClick={start} disabled={!status.admin}>Start migration</Button>
            </>
          )}
          {state === 'running' && <Button variant="outline" size="sm" onClick={onClose}>Continue in background</Button>}
          {state === 'done' && <Button size="sm" onClick={() => { onClose(); onOpenMemory?.(); }}>Open the new memory</Button>}
          {(state === 'failed' || state === 'cancelled') && <Button variant="outline" size="sm" onClick={onClose}>Close</Button>}
        </div>
      </div>
    </div>
  );
}
