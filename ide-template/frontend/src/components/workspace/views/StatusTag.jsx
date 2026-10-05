/**
 * Status tag on a tile ("Active", "Beta", "Soon"): a solid white pill with a
 * hairline and a soft shadow, dark text and a coloured dot — readable on a
 * plain card and on a busy banner alike. One component so every screen's
 * tags look the same.
 */
import { cn } from '@/lib/utils';

// A dot only where it carries a state; Beta is a quiet label, no dot.
const DOTS = {
  active: 'bg-emerald-500',
  soon: 'bg-muted-foreground/50',
};

export default function StatusTag({ tone = 'active', children, className }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 rounded-[5px] bg-white px-1.5 py-[3px] text-[11px] font-medium leading-none',
      DOTS[tone] ? 'text-foreground/80' : 'text-muted-foreground',
      'shadow-[0_1px_2px_rgba(0,0,0,0.06)] ring-1 ring-black/[0.06] dark:bg-neutral-900 dark:text-foreground/85 dark:ring-white/10',
      className,
    )}>
      {DOTS[tone] && <span className={cn('size-1.5 shrink-0 rounded-full', DOTS[tone])} aria-hidden />}
      {children}
    </span>
  );
}
