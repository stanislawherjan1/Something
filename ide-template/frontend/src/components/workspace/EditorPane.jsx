import { lazy, Suspense, useState, useEffect } from 'react';
import { Menu, Folder, FileText } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { SkeletonEditorHeader, SkeletonLine, SkeletonFolderGrid } from './SkeletonLoader.jsx';
import { FUNCTIONAL_PATHS } from './FileTree.jsx';
import { useBranding } from './identity.jsx';
import FileViewer         from './FileViewer.jsx';
import ImageViewer        from './ImageViewer.jsx';
import EditorHeader       from './EditorHeader.jsx';
import KanbanView         from './views/KanbanView.jsx';
import GalleryView        from './views/GalleryView.jsx';
import ClaudeDashboard    from './views/ClaudeDashboard.jsx';
import SkillsDashboard    from './views/SkillsDashboard.jsx';
import IntegrationsDashboard from './views/IntegrationsDashboard.jsx';
import RemindersDashboard from './views/RemindersDashboard.jsx';
import TeamDashboard      from './views/TeamDashboard.jsx';
import MemoryDashboard    from './views/MemoryDashboard.jsx';
import NotificationsView  from './views/NotificationsView.jsx';

// BlockNote is heavy (~500 KB gzip) — lazy-load so the initial bundle stays
// lean. Only paid when the user actually opens a markdown file.
const MarkdownEditor = lazy(() => import('./MarkdownEditor.jsx'));
// TanStack Table + papaparse — also lazy so .csv-less sessions pay nothing.
const CSVEditor      = lazy(() => import('./CSVEditor.jsx'));
// pdfjs-dist + react-pdf — ~300 KB, lazy so non-PDF sessions don't pay.
const PdfViewer      = lazy(() => import('./PdfViewer.jsx'));

const IMAGE_EXT    = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
const MARKDOWN_EXT = /\.(md|mdx|markdown)$/i;
const PDF_EXT      = /\.pdf$/i;
const CSV_EXT      = /\.(csv|tsv)$/i;

/**
 * EditorPane — the centre column. Picks a view component based on the
 * selected entry. View registry (top-down match):
 *
 *   type === 'dashboard'              → ClaudeDashboard (managed config view)
 *   path === 'Tasks.md'               → KanbanView      (## columns + ### cards)
 *   type === 'dir',  name 'generated' → GalleryView     (image tiles)
 *   type === 'file', image ext        → ImageViewer     (raw <img> + cache-bust)
 *   type === 'file', csv ext          → CSVEditor       (TanStack table, edit cells)
 *   type === 'file', anything         → FileViewer      (text/markdown plain)
 *   type === 'dir',  fallback         → FolderEmpty
 *   null                              → EmptyState
 *
 * Adding a new view = register one match here + a component in views/.
 */
export default function EditorPane({ selected, fileEventNonce, sidebarOpen, onExpandSidebar, onSelect, className }) {
  const viewKey = selected ? `${selected.type}:${selected.path}` : '__empty__';
  return (
    <main className={cn("relative flex flex-1 min-w-0 min-h-0 flex-col bg-background w-full", className)}>
      {/* Hamburger button — appears only when the sidebar is collapsed.
          Fades + scales rather than snapping in, and waits one beat on
          enter so the sidebar's width-collapse finishes first (otherwise
          the button overlaps the still-shrinking sidebar visually). On
          exit it leaves immediately so re-expanding feels snappy. */}
      <AnimatePresence>
        {!sidebarOpen && (
          <motion.button
            type="button"
            onClick={onExpandSidebar}
            title="Show sidebar"
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{
              opacity: 1, scale: 1,
              transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1], delay: 0.18 },
            }}
            exit={{
              opacity: 0, scale: 0.7,
              transition: { duration: 0.14, ease: [0.22, 1, 0.36, 1] },
            }}
            // Boxed hamburger (bordered tile, soft hover). Inset 14px on both
            // top and left so the corner gap is balanced, and the top inset
            // (60px row → 32px button → 14px) keeps it centred on the file name.
            className="absolute top-3.5 z-10 flex size-8 items-center justify-center rounded-md border bg-background text-muted-foreground/70 shadow-xs transition-colors hover:bg-sidebar-accent/40 hover:text-foreground/85"
            style={{ left: '14px' }}
          >
            <Menu className="size-4" strokeWidth={1.75} />
          </motion.button>
        )}
      </AnimatePresence>
      <ActiveView
        key={viewKey}
        selected={selected}
        fileEventNonce={fileEventNonce}
        onSelect={onSelect}
        sidebarOpen={sidebarOpen}
      />
    </main>
  );
}

function ActiveView({ selected, fileEventNonce, onSelect, sidebarOpen }) {
  if (!selected) return <EmptyState />;
  const { path, type } = selected;

  if (type === 'dashboard')                              return <ClaudeDashboard onSelect={onSelect} fileEventNonce={fileEventNonce} sidebarOpen={sidebarOpen} />;
  if (type === 'skills')                                 return <SkillsDashboard fileEventNonce={fileEventNonce} sidebarOpen={sidebarOpen} onSelect={onSelect} />;
  if (type === 'integrations')                           return <IntegrationsDashboard sidebarOpen={sidebarOpen} />;
  if (type === 'reminders')                              return <RemindersDashboard fileEventNonce={fileEventNonce} sidebarOpen={sidebarOpen} />;
  if (type === 'team')                                   return <TeamDashboard sidebarOpen={sidebarOpen} />;
  if (type === 'memory')                                 return <MemoryDashboard fileEventNonce={fileEventNonce} sidebarOpen={sidebarOpen} onSelect={onSelect} />;
  if (type === 'notifications')                          return <NotificationsView sidebarOpen={sidebarOpen} />;
  if (path === 'Tasks.md')                               return <KanbanView     path={path} fileEventNonce={fileEventNonce} sidebarOpen={sidebarOpen} />;
  if (type === 'dir' && basename(path) === 'generated')  return <GalleryView    path={path} fileEventNonce={fileEventNonce} onSelect={onSelect} sidebarOpen={sidebarOpen} />;
  if (type === 'file' && IMAGE_EXT.test(path))           return <ImageViewer    path={path} fileEventNonce={fileEventNonce} sidebarOpen={sidebarOpen} />;
  if (type === 'file' && PDF_EXT.test(path))             return (
    <Suspense fallback={<LoadingState />}>
      <PdfViewer path={path} fileEventNonce={fileEventNonce} sidebarOpen={sidebarOpen} />
    </Suspense>
  );
  if (type === 'file' && MARKDOWN_EXT.test(path))        return (
    <Suspense fallback={<LoadingState />}>
      <MarkdownEditor path={path} fileEventNonce={fileEventNonce} sidebarOpen={sidebarOpen} onSelect={onSelect} />
    </Suspense>
  );
  if (type === 'file' && CSV_EXT.test(path))             return (
    <Suspense fallback={<LoadingState />}>
      <CSVEditor path={path} fileEventNonce={fileEventNonce} sidebarOpen={sidebarOpen} />
    </Suspense>
  );
  if (type === 'file')                                   return <FileViewer     path={path} fileEventNonce={fileEventNonce} sidebarOpen={sidebarOpen} />;
  if (type === 'dir')                                    return <FolderView     path={path} fileEventNonce={fileEventNonce} onSelect={onSelect} sidebarOpen={sidebarOpen} />;
  return <EmptyState />;
}

// Document-shaped skeleton for the markdown editor: a title, a couple of
// sections (heading + paragraph), laid out at the SAME reading width and left
// gutter as the real editor content (max-w-3xl wrapper + the BlockNote 54px /
// 16px-mobile inline gutter) so it doesn't jump when the editor mounts.
function ParaSkeleton({ widths }) {
  return (
    <div className="space-y-2.5">
      {widths.map((w, i) => <SkeletonLine key={i} width={w} height="13px" />)}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SkeletonEditorHeader />
      <div className="@container/editor flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-3xl @5xl/editor:max-w-4xl @7xl/editor:max-w-5xl px-4 pt-7 sm:px-[62px]">
          {/* H1 */}
          <SkeletonLine width="46%" height="24px" className="mb-5" />
          <ParaSkeleton widths={['100%', '97%', '92%', '64%']} />
          {/* H2 */}
          <SkeletonLine width="32%" height="17px" className="mt-9 mb-4" />
          <ParaSkeleton widths={['98%', '100%', '88%']} />
          {/* H2 */}
          <SkeletonLine width="27%" height="17px" className="mt-9 mb-4" />
          <ParaSkeleton widths={['95%', '99%', '72%']} />
        </div>
      </div>
    </div>
  );
}

// Centre-pane empty view. Detects a brand-new workspace (no user files) and
// shows a warm first-run welcome; otherwise the plain "pick a file" prompt.
function EmptyState() {
  const branding = useBranding();
  const bot = branding?.botDisplayName || 'the assistant';
  const [fresh, setFresh] = useState(null);   // null = unknown, true = no files

  useEffect(() => {
    let cancelled = false;
    fetch('/api/files/tree')
      .then((r) => (r.ok ? r.json() : {}))
      .then((d) => {
        if (cancelled) return;
        const userFiles = (d.entries || []).filter((e) => !FUNCTIONAL_PATHS.has(e.name));
        setFresh(userFiles.length === 0);
      })
      .catch(() => { if (!cancelled) setFresh(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex h-full items-center justify-center px-12 py-16">
      <div className="flex max-w-md flex-col items-center gap-5 text-center">
        <div className="flex size-16 items-center justify-center rounded-2xl border border-border/55 bg-muted/35 text-muted-foreground/55 shadow-xs">
          <FileText className="size-7" strokeWidth={1.4} />
        </div>
        {fresh !== null && (
          <div className="flex flex-col gap-2">
            <h2 className="text-[16px] font-semibold tracking-tight text-foreground/90">
              {fresh ? 'Your workspace is ready' : 'Nothing open'}
            </h2>
            <p className="text-[13.5px] leading-relaxed text-muted-foreground/70">
              {fresh ? (
                <>No files yet — create your first note from the sidebar, or ask{' '}
                  <span className="font-medium text-foreground/85">{bot}</span> in chat to draft one.</>
              ) : (
                'Select a file from the sidebar to start editing.'
              )}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function FolderView({ path, fileEventNonce, onSelect, sidebarOpen }) {
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    if (!path) {
      setState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setState(prev => prev.status === 'ok' ? prev : { status: 'loading' });

    fetch(`/api/files/tree?path=${encodeURIComponent(path)}`)
      .then(async resp => {
        const data = await resp.json().catch(() => ({}));
        if (cancelled) return;
        if (!resp.ok) {
          setState({ status: 'error', error: data.error || `HTTP ${resp.status}` });
        } else {
          const entries = (data.entries || []).sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          setState({ status: 'ok', entries });
        }
      })
      .catch(err => {
        if (!cancelled) setState({ status: 'error', error: err.message });
      });

    return () => { cancelled = true; };
  }, [path, fileEventNonce]);

  if (!path) return <EmptyState />;
  if (state.status === 'loading') return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={Folder} title={`${path}/`} sidebarOpen={sidebarOpen} />
      <div className="flex-1 overflow-auto px-4 py-6">
        <SkeletonFolderGrid />
      </div>
    </div>
  );
  if (state.status === 'error') return <Centered error>Error: {state.error}</Centered>;

  const entries = state.entries || [];
  const isEmpty = entries.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={Folder} title={`${path}/`} sidebarOpen={sidebarOpen} />
      <div className="flex-1 overflow-auto px-4 py-6">
        {isEmpty ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground/70">
            Folder is empty
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
            {entries.map(entry => {
              const entryPath = entry.path || (path ? `${path}/${entry.name}` : entry.name);
              return (
              <button
                key={entry.name}
                onClick={() => onSelect({ path: entryPath, type: entry.type })}
                className={cn(
                  'flex flex-col items-center gap-2 rounded-lg p-3',
                  'border border-border/50 hover:bg-muted/30 transition-colors',
                  entry.type === 'dir' ? 'cursor-pointer' : 'cursor-pointer'
                )}
              >
                {entry.type === 'dir' ? (
                  <Folder className="size-6 text-muted-foreground/70" strokeWidth={1.75} />
                ) : (
                  <FileText className="size-6 text-muted-foreground/70" strokeWidth={1.75} />
                )}
                <span className="truncate text-[12px] text-foreground/80 text-center w-full">
                  {entry.name}
                </span>
              </button>
            );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Centered({ children, error }) {
  return (
    <div className={cn('flex h-full items-center justify-center text-sm', error ? 'text-destructive' : 'text-muted-foreground/70')}>
      {children}
    </div>
  );
}

function basename(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}
