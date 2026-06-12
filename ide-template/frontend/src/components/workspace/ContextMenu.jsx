import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

/**
 * Lightweight right-click menu — a fixed-position popover anchored at the
 * mouse coords passed in `position`. Closes on:
 *   - Escape
 *   - mousedown anywhere outside the menu
 *   - scroll / window resize (pointer no longer maps to the original target)
 *   - any item click
 *
 * Repositions itself if the requested coords would push it past the viewport
 * edges so it never opens off-screen.
 *
 * Items shape: { id, label, icon: LucideComponent, danger?: boolean,
 *                onSelect: () => void, disabled?: boolean }
 */
export default function ContextMenu({ position, items, onClose }) {
  const ref = useRef(null);
  const [adjusted, setAdjusted] = useState(position);

  useLayoutEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const padding = 8;
    let { x, y } = position;
    if (x + rect.width  + padding > window.innerWidth)  x = window.innerWidth  - rect.width  - padding;
    if (y + rect.height + padding > window.innerHeight) y = window.innerHeight - rect.height - padding;
    setAdjusted({ x: Math.max(padding, x), y: Math.max(padding, y) });
  }, [position]);

  useEffect(() => {
    const onDocMouseDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    const onScrollOrResize = () => onClose();
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ left: adjusted.x, top: adjusted.y }}
      className="fixed z-50 min-w-[150px] overflow-hidden rounded-[5px] border border-border/55 bg-background p-1 text-[11px] text-foreground shadow-[0_4px_14px_rgba(0,0,0,0.08)] dark:shadow-[0_4px_14px_rgba(0,0,0,0.4)]"
    >
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => { if (!item.disabled) { onClose(); item.onSelect(); } }}
          className={cn(
            'flex w-full items-center gap-2 rounded-[3px] px-2 py-1.5 text-left transition-colors',
            'disabled:cursor-not-allowed disabled:opacity-40',
            item.danger
              ? 'text-destructive hover:bg-destructive/[0.04] focus:bg-destructive/[0.04]'
              : 'text-foreground/85 hover:bg-foreground/[0.025] focus:bg-foreground/[0.025]',
          )}
        >
          {item.icon && (
            <item.icon
              className={cn('size-[11px] shrink-0 -translate-y-[0.5px]', item.danger ? '' : 'text-muted-foreground/60')}
              strokeWidth={1.75}
            />
          )}
          <span className="flex-1 truncate">{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
