import { useCallback, useEffect, useState } from 'react';
import { History, Loader2, Undo2, AlertCircle, X, Plus, Replace, Trash2, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * "What I saved" — the memory engine's write log, newest first, with one-tap
 * undo.
 *
 * Memory writes are silent by contract: nothing is pushed to Telegram or the
 * workspace when the bot remembers something, because a notification per fact
 * is friction nobody wants. That only works if there is somewhere to LOOK, and
 * for a while there wasn't: the engine logged every write and exposed it at
 * /api/memory/changes, and no surface read it. This is that surface.
 *
 * Undo goes through the engine, which restores the pre-image and then replays
 * anything written to the same file afterwards — so undoing an older write
 * cannot silently discard newer facts.
 */

const OP_META = {
  remember:     { icon: Plus,    label: 'Saved',    tone: 'text-emerald-600 dark:text-emerald-400' },
  supersede:    { icon: Replace, label: 'Replaced', tone: 'text-amber-600 dark:text-amber-400' },
  retire:       { icon: Trash2,  label: 'Removed',  tone: 'text-rose-600 dark:text-rose-400' },
  retire_page:  { icon: Trash2,  label: 'Page removed', tone: 'text-rose-600 dark:text-rose-400' },
  rename_entity:{ icon: FileText,label: 'Renamed',  tone: 'text-sky-600 dark:text-sky-400' },
  revert:       { icon: Undo2,   label: 'Reverted', tone: 'text-muted-foreground' },
};

/** `memory/users/sam/USER_PROFILE.md` → `USER_PROFILE` (yours) */
function prettyTarget(target) {
  const file = String(target || '').split('/').pop().replace(/\.md$/, '');
  const priv = /\/users\//.test(target || '');
  const kind = /\/concepts\//.test(target || '') ? 'concept'
    : /\/topics\//.test(target || '') ? 'topic'
      : 'card';
  return { file, priv, kind };
}

function when(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function MemoryChanges({ onClose, onReverted }) {
  const [state, setState] = useState({ status: 'loading', changes: [] });
  const [busy, setBusy] = useState(null);
  const [failed, setFailed] = useState(null);

  const load = useCallback(() => {
    setState(s => ({ ...s, status: s.changes.length ? 'ok' : 'loading' }));
    fetch('/api/memory/changes?days=30')
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        setState({ status: 'ok', changes: data.changes || [] });
      })
      .catch(err => setState({ status: 'error', changes: [], error: err.message }));
  }, []);

  useEffect(load, [load]);

  const revert = async (id) => {
    setBusy(id); setFailed(null);
    try {
      const r = await fetch('/api/memory/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: id }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`);
      load();
      onReverted?.();
    } catch (err) {
      setFailed({ id, message: err.message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="absolute inset-y-0 right-0 z-20 flex w-full max-w-md flex-col border-l border-border/55 bg-background shadow-xl">
      <div className="flex shrink-0 items-center justify-between border-b border-border/45 px-4 py-3">
        <div className="flex items-center gap-2">
          <History className="size-4 text-muted-foreground/70" strokeWidth={1.75} />
          <span className="text-[13px] font-semibold text-foreground/90">What I saved</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground"
          aria-label="Close"
        >
          <X className="size-4" strokeWidth={1.75} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.status === 'loading' && (
          <div className="flex h-24 items-center justify-center gap-2 text-[12.5px] text-muted-foreground/65">
            <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} /> Loading…
          </div>
        )}

        {state.status === 'error' && (
          <div className="m-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-[12.5px] text-destructive">
            <AlertCircle className="mt-px size-3.5 shrink-0" strokeWidth={1.75} />
            <span>Couldn't load the memory log: {state.error}</span>
          </div>
        )}

        {state.status === 'ok' && state.changes.length === 0 && (
          <div className="px-6 py-10 text-center text-[12.5px] leading-relaxed text-muted-foreground/70">
            Nothing written in the last 30 days. Memory changes show up here the moment they happen, with a way to undo each one.
          </div>
        )}

        {state.status === 'ok' && state.changes.map((c) => {
          const meta = OP_META[c.action] || OP_META.remember;
          const Icon = meta.icon;
          const t = prettyTarget(c.target);
          return (
            <div key={c.id} className="border-b border-border/30 px-4 py-3 last:border-b-0">
              <div className="flex items-baseline justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <Icon className={cn('size-3.5 shrink-0', meta.tone)} strokeWidth={2} />
                  <span className="text-[12.5px] font-medium text-foreground/85">{meta.label}</span>
                  <span className="text-[11.5px] text-muted-foreground/60">in</span>
                  <span className="text-[11.5px] font-medium text-foreground/70">{t.file}</span>
                  {t.priv && (
                    <span className="rounded bg-muted/70 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
                      private
                    </span>
                  )}
                </div>
                <span className="shrink-0 text-[11px] text-muted-foreground/55">{when(c.ts)}</span>
              </div>

              {c.removed?.map((line, i) => (
                <p key={`r${i}`} className="mt-1.5 rounded bg-rose-500/[0.07] px-2 py-1 text-[12px] leading-snug text-muted-foreground/80 line-through">
                  {line.replace(/^[-*]\s*/, '')}
                </p>
              ))}
              {c.added?.map((line, i) => (
                <p key={`a${i}`} className="mt-1.5 rounded bg-emerald-500/[0.07] px-2 py-1 text-[12px] leading-snug text-foreground/85">
                  {line.replace(/^[-*]\s*/, '')}
                </p>
              ))}

              <div className="mt-2 flex items-center gap-2">
                {c.source && (
                  <span className="text-[11px] text-muted-foreground/55">{c.source}</span>
                )}
                {c.revertable && (
                  <button
                    type="button"
                    onClick={() => revert(c.id)}
                    disabled={busy === c.id}
                    className="ml-auto inline-flex items-center gap-1 rounded-md border border-border/55 px-2 py-0.5 text-[11.5px] font-medium text-foreground/75 transition-colors hover:bg-muted/60 disabled:opacity-50"
                  >
                    {busy === c.id
                      ? <Loader2 className="size-3 animate-spin" strokeWidth={2} />
                      : <Undo2 className="size-3" strokeWidth={2} />}
                    Undo
                  </button>
                )}
              </div>

              {failed?.id === c.id && (
                <p className="mt-1.5 text-[11.5px] text-destructive">Couldn't undo: {failed.message}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
