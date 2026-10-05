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
        // Ink at 7%: shows on the page and on cards, in light and dark alike.
        'animate-pulse rounded bg-foreground/[0.07]',
        className,
      )}
      {...rest}
    />
  );
}

/**
 * A banner tile — AI Settings tiles and active integrations: a full-width
 * banner, then the title, two lines of description and the footer button.
 */
export function SkeletonBannerTile() {
  return (
    <div className="flex flex-col overflow-hidden rounded-[6px] border border-border/60">
      <Skeleton className="h-24 w-full rounded-none opacity-60" />
      <div className="flex flex-1 flex-col gap-2 px-4 pt-3.5">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
      <div className="px-4 pb-4 pt-4">
        <Skeleton className="h-8 w-full rounded-[6px]" />
      </div>
    </div>
  );
}

/** A row on hairlines — Routines, Tasks, Notifications-style lists. */
export function SkeletonListRow({ icon = true }) {
  return (
    <div className="flex items-center gap-4 px-2 py-4">
      {icon && <Skeleton className="size-9 shrink-0 rounded-[6px]" />}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton className="h-3.5 w-48" />
        <Skeleton className="h-3 w-3/4" />
      </div>
    </div>
  );
}

/** N hairline rows inside one top-and-bottom ruled list. */
export function SkeletonList({ count = 4, icon = true }) {
  return (
    <div className="flex flex-col divide-y divide-border/60 border-y border-border/60">
      {Array.from({ length: count }, (_, i) => <SkeletonListRow key={i} icon={icon} />)}
    </div>
  );
}

/** A bordered single-line row — Reminders. */
export function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 rounded-[6px] border border-border/60 px-4 py-3">
      <Skeleton className="size-4 shrink-0 rounded-[4px]" />
      <Skeleton className="h-3.5 w-1/2" />
      <Skeleton className="ml-auto h-3 w-16" />
    </div>
  );
}

/**
 * Vertical card placeholder — the Skills tile: a small icon and the name,
 * two lines of description, the footer button.
 */
export function SkeletonCard() {
  return (
    <div className="flex flex-col rounded-[6px] border border-border/60">
      <div className="flex items-center gap-2 px-4 pt-4">
        <Skeleton className="size-[22px] shrink-0 rounded-[5px]" />
        <Skeleton className="h-4 w-28" />
      </div>
      <div className="flex flex-col gap-2 px-4 pt-3">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
      <div className="px-4 pb-4 pt-4">
        <Skeleton className="h-8 w-full rounded-[6px]" />
      </div>
    </div>
  );
}

/** Card grid skeleton — the fixed-width auto-fill grids the dashboards use. */
export function SkeletonCardGrid({ count = 6, width = 306, banner = false }) {
  const Card = banner ? SkeletonBannerTile : SkeletonCard;
  return (
    <div className="grid gap-3 max-sm:!grid-cols-1" style={{ gridTemplateColumns: `repeat(auto-fill, ${width}px)` }}>
      {Array.from({ length: count }, (_, i) => <Card key={i} />)}
    </div>
  );
}
