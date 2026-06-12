import { cn } from '@/lib/utils';

/**
 * EditorHeader — shared top bar for every centre-pane view (FileViewer,
 * ImageViewer, KanbanView, GalleryView, ClaudeDashboard, etc.).
 *
 * Matches the chat header in height (h-14, 56 px) but has no border below
 * it; the visual separation between the title and content comes from
 * spacing alone.
 *
 * If `title` looks like a path (`Foo/bar.md`, `notes.md`, `dir/sub/`), the
 * header dims the directory and extension and only the file's base name
 * renders in foreground colour — easier to scan when the path is long.
 *
 * Props:
 *   icon  — Lucide component (rendered small, muted)
 *   title — main label (filename, view name, etc.)
 *   subtitle — optional smaller label below title
 *   meta  — optional right-aligned text or React node (size, count, badge)
 */
export default function EditorHeader({ icon: Icon, title, subtitle, meta, sidebarOpen = true }) {
  const hasSubtitle = !!subtitle;

  return (
    <div className={cn('flex shrink-0', hasSubtitle ? 'flex-col py-3.5' : 'items-center py-3.5')} style={{ paddingLeft: sidebarOpen ? '24px' : '56px', minHeight: '60px' }}>
      <div className="flex w-full items-center justify-between gap-2.5 pr-6">
        <div className="flex min-w-0 items-center gap-2.5">
          {Icon && (
            <Icon
              className="size-[17px] shrink-0 text-muted-foreground/75"
              strokeWidth={1.75}
            />
          )}
          <div className="flex min-w-0 items-baseline whitespace-nowrap text-[16px] tracking-[-0.01em] font-bold text-foreground">
            {renderTitle(title)}
          </div>
        </div>
        {meta && (
          <span className="flex shrink-0 items-center text-[12px] text-muted-foreground/70">
            {meta}
          </span>
        )}
      </div>
      {subtitle && (
        <div className="mt-1.5 text-[13px] text-muted-foreground/75">
          {subtitle}
        </div>
      )}
    </div>
  );
}

function renderTitle(title) {
  if (typeof title !== 'string') {
    return <span className="font-medium text-foreground/90">{title}</span>;
  }
  const { dir, stem, ext } = splitPath(title);
  if (!dir && !ext) {
    return <span className="font-medium text-foreground/90">{title}</span>;
  }
  // The dir prefix (without its trailing slash) uses RTL direction so
  // `text-overflow: ellipsis` truncates from the *start* (visually left),
  // keeping the parent folder closest to the filename always visible.
  // The trailing slash + stem + ext are flex-shrink-0 so the filename never
  // gets cut, and the slash never gets pushed around by RTL bidi rules.
  const dirNoSlash = dir.endsWith('/') ? dir.slice(0, -1) : dir;
  const hasSlash   = dir.endsWith('/');
  return (
    <span className="flex min-w-0 items-baseline" title={title}>
      {dirNoSlash && (
        <span
          className="min-w-0 overflow-hidden text-ellipsis font-normal text-muted-foreground/60"
          style={{ direction: 'rtl', textAlign: 'left' }}
        >
          {dirNoSlash}
        </span>
      )}
      {hasSlash && <span className="shrink-0 font-normal text-muted-foreground/60">/</span>}
      <span className="shrink-0 font-medium text-foreground/90">{stem}</span>
      {ext && <span className="shrink-0 font-normal text-muted-foreground/60">{ext}</span>}
    </span>
  );
}

// Split into (dir, stem, ext) where dir keeps its trailing slash and ext
// keeps its leading dot. Hidden files (".env") get an empty ext so the dot
// stays attached to the visible name.
function splitPath(s) {
  const slash = s.lastIndexOf('/');
  const dir   = slash >= 0 ? s.slice(0, slash + 1) : '';
  const rest  = slash >= 0 ? s.slice(slash + 1)    : s;
  const dot   = rest.lastIndexOf('.');
  const stem  = dot > 0 ? rest.slice(0, dot) : rest;
  const ext   = dot > 0 ? rest.slice(dot)    : '';
  return { dir, stem, ext };
}
