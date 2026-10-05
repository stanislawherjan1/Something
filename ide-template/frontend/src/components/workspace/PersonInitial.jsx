/**
 * A person's default picture when they have none: an ink initial on paper —
 * a pale warm circle with a hairline edge, no colour, no gradient.
 * Size and shape come from `className` (it fills its box).
 */
import { cn } from '@/lib/utils';

export default function PersonInitial({ initial, className }) {
  const ch = String(initial || '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <div
      className={cn(
        'flex shrink-0 select-none items-center justify-center rounded-full bg-[#f1efea] text-[13px] font-medium leading-none text-[#1c1b18] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)] dark:bg-[#2a2826] dark:text-[#f1efea] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]',
        className,
      )}
    >
      {ch}
    </div>
  );
}
