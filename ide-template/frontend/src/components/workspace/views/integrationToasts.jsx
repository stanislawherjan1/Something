import { useState, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle2, AlertTriangle, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { RESTART_WINDOW_MS } from '../RestartBanners';
import { Logo } from './IntegrationsDashboard.jsx';

/*
 * The bottom toasts of the integrations screens — one surface for every
 * outcome: a plain message (ok / error), the bot updating with a progress
 * bar, and an activation (a service installed or removed, the bot
 * restarting on the right). Shared by the Integrations list and a service's
 * own page, so both show results the same way.
 */
export function useIntegrationToasts(botDisplayName) {
  const [toasts, setToasts] = useState([]);
  const toastSeq = useRef(0);
  const dismissToast = useCallback((id) => setToasts(t => t.filter(x => x.id !== id)), []);
  const pushToast = useCallback((text, kind = 'ok', opts = {}) => {
    const { ttl = 4500, logo = null, label = null } = opts;
    const id = ++toastSeq.current;
    setToasts(t => [...t, { id, text, kind, logo, label }]);
    if (ttl) setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), ttl);
    return id;
  }, []);
  // A single progress toast for the bot restart the activation triggers —
  // replaces the old in-modal RestartingBanner/DoneBanner so every path funnels
  // through toasts. Bar fills over the restart window, then flips to "ready".
  const pushRestartToast = useCallback(() => {
    const id = ++toastSeq.current;
    setToasts(t => [...t, { id, kind: 'progress', text: `Updating ${botDisplayName}…`, duration: RESTART_WINDOW_MS }]);
    setTimeout(() => {
      setToasts(t => t.map(x => x.id === id ? { ...x, kind: 'ok', text: `${botDisplayName} is ready` } : x));
      setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 2500);
    }, RESTART_WINDOW_MS);
  }, [botDisplayName]);

  // Rich activation bar: left = logo + name + a circle that ticks to a check
  // once connected; right = the bot-restart status with a progress bar that
  // fills over the restart window, then flips to "ready". The bar lingers a
  // beat after the restart finishes, then dismisses.
  const pushActivationToast = useCallback((integration, restarting = true, mode = 'install') => {
    const id = ++toastSeq.current;
    setToasts(t => [...t, {
      id, kind: 'activation', mode,
      logo: integration.logo, label: integration.label || integration.id,
      left: 'pending', right: restarting ? 'restarting' : 'idle',
      duration: RESTART_WINDOW_MS,
    }]);
    // left: circle → check after a short beat
    setTimeout(() => setToasts(t => t.map(x => x.id === id ? { ...x, left: 'done' } : x)), 550);
    if (restarting) {
      setTimeout(() => {
        setToasts(t => t.map(x => x.id === id ? { ...x, right: 'ready' } : x));
        setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 1800);   // lingers after restart
      }, RESTART_WINDOW_MS);
    } else {
      setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3000);
    }
  }, []);

  return { toasts, pushToast, pushRestartToast, pushActivationToast, dismissToast };
}

export function IntegrationToasts({ toasts, botDisplayName, dismissToast }) {
  return (
    <>
      {toasts.length > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[70] flex flex-col items-center gap-2 px-4">
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ y: 24, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 24, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="pointer-events-auto relative w-[calc(100%-1rem)] max-w-3xl overflow-hidden rounded-[6px] border border-border/60 bg-card/95 shadow-[0_8px_30px_rgba(0,0,0,0.10)] backdrop-blur sm:w-[75%] lg:w-[60%]"
            >
              {t.kind === 'activation' ? (
                <div className="flex w-full items-center justify-between gap-2.5 px-3.5 py-2.5 sm:gap-4 sm:px-5 sm:py-3">
                  <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
                    <Logo src={t.logo} alt={t.label} fill={!!t.logoFill} size="size-8 sm:size-9" imgSize="size-5" />
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-semibold text-foreground/90 sm:text-[14px]">{t.label}</div>
                      <div className="mt-0.5 flex items-center gap-1 text-[11.5px] sm:text-[12px]">
                        {t.left === 'pending'
                          ? <><Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground/60" strokeWidth={2.2} /><span className="text-muted-foreground/70">{t.mode === 'remove' ? 'Removing…' : 'Installing…'}</span></>
                          : t.mode === 'remove'
                            ? <><CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground/70" strokeWidth={2.2} /><span className="font-medium text-muted-foreground/85">Removed</span></>
                            : <><CheckCircle2 className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" strokeWidth={2.2} /><span className="font-medium text-emerald-600 dark:text-emerald-400">Installed</span></>}
                      </div>
                    </div>
                  </div>
                  {t.right !== 'idle' && (
                    <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
                      {t.right === 'restarting'
                        ? <><Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground/70" strokeWidth={2.2} /><span className="text-[12px] text-muted-foreground/85 sm:text-[13px]"><span className="hidden sm:inline">{botDisplayName} </span>restarting…</span></>
                        : <><CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" strokeWidth={2.2} /><span className="text-[12px] text-muted-foreground/85 sm:text-[13px]"><span className="hidden sm:inline">{botDisplayName} </span>ready</span></>}
                    </div>
                  )}
                </div>
              ) : (
                // A service's own message (a test, a save, the team's access, a person's
                // connection) in the shape of the activation bar: the logo, the service's
                // name, and under it the outcome with its icon — green for a success,
                // red for an error, grey for a plain change.
                <div className="flex w-full items-center gap-2.5 px-3.5 py-2.5 sm:gap-3 sm:px-5 sm:py-3">
                  {t.logo
                    ? <Logo src={t.logo} alt={t.label} fill={!!t.logoFill} size="size-8 sm:size-9" imgSize="size-5" />
                    : t.kind === 'error'
                      ? <AlertTriangle className="size-4 shrink-0 text-destructive" strokeWidth={2.2} />
                      : (t.kind === 'pending' || t.kind === 'progress')
                        ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground/70" strokeWidth={2.2} />
                        : <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" strokeWidth={2.2} />}
                  {t.logo && t.label ? (
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold text-foreground/90 sm:text-[14px]">{t.label}</div>
                      <div className="mt-0.5 flex items-center gap-1 text-[11.5px] sm:text-[12px]">
                        {t.kind === 'error'
                          ? <><AlertTriangle className="size-3.5 shrink-0 text-destructive" strokeWidth={2.2} /><span className="font-medium text-destructive">{t.text}</span></>
                          : t.kind === 'neutral'
                            ? <><CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground/70" strokeWidth={2.2} /><span className="font-medium text-muted-foreground/85">{t.text}</span></>
                            : (t.kind === 'pending' || t.kind === 'progress')
                              ? <><Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground/60" strokeWidth={2.2} /><span className="text-muted-foreground/70">{t.text}</span></>
                              : <><CheckCircle2 className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" strokeWidth={2.2} /><span className="font-medium text-emerald-600 dark:text-emerald-400">{t.text}</span></>}
                      </div>
                    </div>
                  ) : (
                    <span className={cn('min-w-0 flex-1 text-[13px] font-medium', t.kind === 'error' ? 'text-destructive' : 'text-foreground/85')}>{t.text}</span>
                  )}
                  <button type="button" onClick={() => dismissToast(t.id)} className="-mr-1 shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground" aria-label="Dismiss">
                    <X className="size-3.5" strokeWidth={2} />
                  </button>
                </div>
              )}
              {(t.kind === 'activation' ? t.right === 'restarting' : t.kind === 'progress') && (
                <div className="absolute inset-x-0 bottom-0 h-[3px] bg-border/30">
                  <motion.div className="h-full bg-foreground/40" initial={{ width: '0%' }} animate={{ width: '100%' }} transition={{ duration: (t.duration || RESTART_WINDOW_MS) / 1000, ease: 'linear' }} />
                </div>
              )}
            </motion.div>
          ))}
        </div>
      )}
    </>
  );
}
