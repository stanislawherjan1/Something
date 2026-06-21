import { Fragment, useEffect, useRef } from 'react';
import {
  Heading1, Heading2, Heading3, Heading4, Heading5, Heading6,
  Type, Quote, Code, ListOrdered, List, ListChecks, ListTree,
  Table, Image, Video, AudioLines, File, Smile, Hash,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * EditorSlashMenu — the "/" command menu, mounted via <SuggestionMenuController>.
 * Styled to match our DropdownMenu exactly (same card: rounded-lg bg-popover
 * shadow-md ring-1 ring-foreground/10; same rows: rounded-md px-3, focus:bg-accent)
 * so it reads as one with every other menu in the workspace — not BlockNote's
 * built-in suggestion menu.
 *
 * Items come from getDefaultReactSlashMenuItems; we re-skin them with lucide
 * icons (mapped by title) to keep the icon language consistent, and render the
 * keyboard hint as our kbd pill.
 */
const ICON_BY_TITLE = {
  'heading 1': Heading1, 'heading 2': Heading2, 'heading 3': Heading3,
  'heading 4': Heading4, 'heading 5': Heading5, 'heading 6': Heading6,
  paragraph: Type, quote: Quote, 'code block': Code,
  'numbered list': ListOrdered, 'bullet list': List, 'check list': ListChecks,
  'toggle list': ListTree, table: Table, image: Image, video: Video,
  audio: AudioLines, file: File, emoji: Smile,
};

function iconFor(item) {
  const key = (item.title || '').toLowerCase();
  let C = ICON_BY_TITLE[key];
  if (!C && key.startsWith('toggle heading')) C = ListTree;
  if (!C && key.startsWith('heading')) C = Heading1;
  if (C) return <C className="size-4" strokeWidth={1.9} />;
  if (item.icon) return item.icon;          // fall back to BlockNote's own glyph
  return <Hash className="size-4" strokeWidth={1.9} />;
}

export default function EditorSlashMenu({ items, selectedIndex, onItemClick, loadingState }) {
  const listRef = useRef(null);

  // Keep the keyboard-selected row in view as the user arrows / filters.
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${selectedIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const card =
    'max-h-[min(60vh,340px)] w-80 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10';

  if (loadingState === 'loading-initial' && items.length === 0) {
    return <div className={card}><Empty>Loading…</Empty></div>;
  }
  if (items.length === 0) {
    return <div className={card}><Empty>No matching blocks</Empty></div>;
  }

  return (
    <div ref={listRef} className={card}>
      {items.map((item, idx) => {
        // First row of each group gets a header label (pure: compare to prev item).
        const showGroup = item.group && item.group !== items[idx - 1]?.group;
        const active = idx === selectedIndex;
        return (
          <Fragment key={item.title + idx}>
            {showGroup && (
              <div className="px-3 pt-2.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground/65">
                {item.group}
              </div>
            )}
            <button
              type="button"
              data-idx={idx}
              // Keep editor focus/selection when picking with the mouse.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onItemClick?.(item)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors',
                active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
              )}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/55 bg-muted/40 text-muted-foreground/90 [&_svg]:size-4">
                {iconFor(item)}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] font-medium text-foreground/90">{item.title}</span>
                {item.subtext && (
                  <span className="truncate text-[11.5px] text-muted-foreground/65">{item.subtext}</span>
                )}
              </span>
              {item.badge && (
                <kbd className="shrink-0 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/70">
                  {item.badge}
                </kbd>
              )}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

function Empty({ children }) {
  return <div className="px-3 py-6 text-center text-[12.5px] text-muted-foreground/55">{children}</div>;
}
