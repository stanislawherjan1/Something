import { AlertTriangle, Check, Loader2 } from 'lucide-react';

// Shared inline banners + timing constants for any save flow that triggers
// a bot restart (Claude token rotation, integration activate/patch/remove).
// Keep the visual language identical across modals so operators learn one
// "saving → restarting → done" shape and trust it everywhere.

// 2s watcher poll + tmux teardown + PM2 restart_delay (10s) + bot.sh
// startup overlay = ~14s on a warm container in practice.
//
// Dev shortcut: append `?restartMs=2000` (or any positive integer) to the
// URL to shorten the wait for UI polish iteration. Off by default — the
// real backend takes the full window.
function readWindowOverride() {
  if (typeof window === 'undefined' || !import.meta.env.DEV) return null;
  const v = Number(new URLSearchParams(window.location.search).get('restartMs'));
  return Number.isFinite(v) && v > 0 ? v : null;
}
export const RESTART_WINDOW_MS = readWindowOverride() ?? 14_000;
// Brief hold on the green "Done" banner before the modal closes — gives
// the operator a beat to register success before the dialog disappears.
export const DONE_HOLD_MS = 900;

export function RestartingBanner({ label = 'Restarting the bot so the change takes effect (~10–15s).' }) {
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border/60 bg-muted/30 px-3 py-2.5 text-[12.5px] text-foreground/80">
      <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" strokeWidth={2} />
      <span>{label}</span>
    </div>
  );
}

export function DoneBanner({ label = 'Done: bot is back online.' }) {
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-2.5 text-[12.5px] text-emerald-700 dark:text-emerald-400">
      <Check className="size-3.5 shrink-0" strokeWidth={2.5} />
      <span>{label}</span>
    </div>
  );
}

export function RestartFailedBanner({ label = "Saved, but the bot couldn't be signaled to restart. It will pick the change up after the next container restart." }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5 text-[12.5px] text-amber-700 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
      <span>{label}</span>
    </div>
  );
}

// Helper to drive the post-save phase transition. Pass the API response
// (must have `restarting` + `restartFailed` booleans) and the phase
// setter; resolves when the visible "done" hold has elapsed.
export async function runRestartPhases({ response, setPhase, setRestartFailed }) {
  if (response.restartFailed) {
    setRestartFailed?.(true);
    setPhase('done');
    await new Promise(r => setTimeout(r, DONE_HOLD_MS));
    return;
  }
  if (response.restarting) {
    setPhase('restarting');
    await new Promise(r => setTimeout(r, RESTART_WINDOW_MS));
  }
  setPhase('done');
  await new Promise(r => setTimeout(r, DONE_HOLD_MS));
}
