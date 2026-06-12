import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import EditorHeader from './EditorHeader.jsx';
import { SkeletonText } from './SkeletonLoader.jsx';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

/**
 * PdfViewer — continuous vertical scroll of all pages, no sidebar / no
 * pagination buttons. Header shows "page X / Y" derived from scroll
 * position via IntersectionObserver.
 *
 * Renders via react-pdf (pdfjs-dist under the hood) so the UI is ours —
 * no Chrome's black toolbar, no native plugin chrome. Worker is bundled
 * via Vite's `?url` import (no CDN dependency, plays well with our
 * egress allowlist).
 *
 * fileEventNonce in the URL forces a refetch when the watcher fires.
 */
export default function PdfViewer({ path, fileEventNonce, sidebarOpen }) {
  const url = `/api/files/raw?path=${encodeURIComponent(path)}&v=${fileEventNonce ?? 0}`;

  const [numPages, setNumPages]   = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageWidth, setPageWidth] = useState(0);
  const [loadError, setLoadError] = useState(null);

  const scrollRef = useRef(null);
  const pageRefs  = useRef({});                                // pageNum -> DOM node

  // file prop is wrapped in useMemo so react-pdf doesn't refetch the
  // document on every render (it compares by reference identity).
  const fileProp = useMemo(() => ({ url }), [url]);

  // Track container width → page width. PDFs render at native ratio,
  // capped to the centre column. min-zero so a recently-mounted ref
  // measured before layout doesn't paint pages 1px wide.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      // Subtract horizontal padding so pages don't run flush to the edge.
      const w = Math.max(0, el.clientWidth - 48);
      // Cap reading width — same intent as MarkdownEditor's @5xl/editor
      // breakpoint. PDFs read fine at ~880px on wide screens; bigger and
      // they start to feel like blueprints.
      setPageWidth(Math.min(w, 880));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Update header "X / Y" based on which page dominates the viewport.
  useEffect(() => {
    if (!numPages || !scrollRef.current) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) {
          const n = parseInt(visible[0].target.dataset.pageNumber, 10);
          if (!Number.isNaN(n)) setCurrentPage(n);
        }
      },
      { root: scrollRef.current, threshold: [0.25, 0.5, 0.75] }
    );
    for (const node of Object.values(pageRefs.current)) {
      if (node) io.observe(node);
    }
    return () => io.disconnect();
  }, [numPages]);

  const meta = loadError
    ? <span className="text-destructive">Error: {loadError}</span>
    : numPages
      ? <span className="tabular-nums text-[12.5px] text-muted-foreground/70">{currentPage} / {numPages}</span>
      : 'Loading…';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={FileText} title={path} meta={meta} sidebarOpen={sidebarOpen} />
      <div
        ref={scrollRef}
        className="@container/pdf flex-1 overflow-auto bg-muted/30 px-6 py-6"
      >
        {loadError ? (
          <FallbackOpen url={url} />
        ) : (
          <Document
            file={fileProp}
            onLoadSuccess={({ numPages: n }) => { setNumPages(n); setLoadError(null); }}
            onLoadError={(err) => setLoadError(err?.message || 'failed to load PDF')}
            loading={<LoadingState />}
            error={<FallbackOpen url={url} />}
            className="mx-auto flex flex-col items-center gap-4"
          >
            {Array.from({ length: numPages }, (_, idx) => {
              const pageNum = idx + 1;
              return (
                <div
                  key={pageNum}
                  ref={(el) => { pageRefs.current[pageNum] = el; }}
                  data-page-number={pageNum}
                  className="overflow-hidden rounded-sm shadow-[0_1px_3px_rgba(0,0,0,0.08),0_4px_12px_rgba(0,0,0,0.06)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.3),0_4px_12px_rgba(0,0,0,0.25)]"
                >
                  <Page
                    pageNumber={pageNum}
                    width={pageWidth || undefined}
                    renderAnnotationLayer
                    renderTextLayer
                  />
                </div>
              );
            })}
          </Document>
        )}
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 pt-6">
      {[...Array(4)].map((_, i) => <SkeletonText key={i} />)}
    </div>
  );
}

function FallbackOpen({ url }) {
  return (
    <div className="flex h-full items-center justify-center px-8 text-center text-sm text-muted-foreground/80">
      <div>
        Couldn't render the PDF inline.{' '}
        <a href={url} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
          Open in a new tab
        </a>.
      </div>
    </div>
  );
}
