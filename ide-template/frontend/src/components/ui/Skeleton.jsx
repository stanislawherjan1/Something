import { cn } from '@/lib/utils';

/**
 * Skeleton — neutral shimmering placeholder for content that's still loading.
 *
 * Use these instead of mock-data placeholders (which were misleading: a
 * dashboard would briefly show "Aria" + a stock avatar before the real
 * branding kicked in). A skeleton just says "loading," no false identity.
 *
 * Sizing controlled by `className` — pass tailwind h/w/rounded utilities.
 *
 *   <Skeleton className="h-4 w-32" />            // text-line placeholder
 *   <Skeleton className="size-12 rounded-full" /> // avatar placeholder
 *   <SkeletonTile />                              // pre-styled dashboard tile
 */
export function Skeleton({ className, ...rest }) {
  return (
    <div
      className={cn(
        'animate-pulse rounded bg-muted/60',
        className,
      )}
      {...rest}
    />
  );
}

/** Pre-styled dashboard tile placeholder — matches IntegrationsDashboard tile shape. */
export function SkeletonTile() {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-card px-3.5 py-3">
      <Skeleton className="size-10 shrink-0 rounded-md" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-3 w-40" />
      </div>
    </div>
  );
}

/** Pre-styled list-row placeholder — for Reminders / Skills / Team rows. */
export function SkeletonRow() {
  return (
    <div className="flex items-start gap-3.5 px-4 py-3.5">
      <Skeleton className="mt-0.5 size-9 shrink-0 rounded-full" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}

/** Pre-styled grid skeleton — N tiles. */
export function SkeletonTileGrid({ count = 6 }) {
  return (
    <div className="grid gap-2.5 grid-cols-1 sm:grid-cols-2">
      {Array.from({ length: count }, (_, i) => <SkeletonTile key={i} />)}
    </div>
  );
}

/**
 * Vertical card placeholder — matches the Skills / Integrations tiles
 * (logo/icon top-left + status pill, title, description, a footer action).
 */
export function SkeletonCard() {
  return (
    <div className="flex flex-col rounded-xl border border-border/55 bg-card">
      <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3">
        <Skeleton className="size-12 rounded-lg" />
        <Skeleton className="h-5 w-14 rounded-full" />
      </div>
      <div className="flex flex-col gap-2 px-4">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
      <div className="px-4 pb-4 pt-3.5">
        <Skeleton className="h-8 w-full rounded-md" />
      </div>
    </div>
  );
}

/** Card grid skeleton — matches the 320px auto-fill grid Skills/Integrations use. */
export function SkeletonCardGrid({ count = 6 }) {
  return (
    <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,320px))]">
      {Array.from({ length: count }, (_, i) => <SkeletonCard key={i} />)}
    </div>
  );
}
