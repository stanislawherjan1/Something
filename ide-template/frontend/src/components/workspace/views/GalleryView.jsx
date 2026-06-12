import { useState, useEffect, useMemo } from 'react';
import { Images } from 'lucide-react';
import { cn } from '@/lib/utils';
import EditorHeader from '../EditorHeader.jsx';
import { useBranding } from '../identity.jsx';
import { useApi } from '@/lib/useApi';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

/**
 * GalleryView — render a folder as a grid of image tiles.
 *
 * Listing comes from /api/files/tree?path=<folder>. We only render entries
 * that look like images (by extension); other files are ignored. Click a
 * tile → onSelect({ path, type: 'file' }) so the EditorPane swaps to
 * ImageViewer for the full-size view.
 */
export default function GalleryView({ path, fileEventNonce, onSelect, sidebarOpen }) {
  const url = `/api/files/tree?path=${encodeURIComponent(path)}`;
  const { data, loading, error, reload } = useApi(url);

  // Background refresh when a file watcher event fires
  useEffect(() => {
    if (fileEventNonce) reload();
  }, [fileEventNonce, reload]);

  const images = useMemo(() => {
    if (!data?.entries) return [];
    const imgs = data.entries.filter(e => e.type === 'file' && IMAGE_EXT.test(e.name));
    // newest first, mtime desc
    imgs.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    return imgs;
  }, [data]);

  const isInitialLoad = loading && !data;
  const isNotFound = error && (error.includes('404') || error.includes('ENOENT'));
  const realError = error && !isNotFound ? error : null;

  const meta = data
    ? `${images.length} ${images.length === 1 ? 'image' : 'images'}`
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={Images} title="Gallery" meta={meta} sidebarOpen={sidebarOpen} />
      <div className="flex-1 overflow-auto">
        {isInitialLoad && <Centered>Loading…</Centered>}
        {isNotFound && <GalleryEmptyState />}
        {realError && <Centered error>Error: {realError}</Centered>}
        {!isInitialLoad && !isNotFound && images.length === 0 && <GalleryEmptyState />}
        {!isInitialLoad && !isNotFound && images.length > 0 && (
          <div className="px-6 pb-6 pt-4">
            <Grid images={images} folderPath={path} fileEventNonce={fileEventNonce} onSelect={onSelect} />
          </div>
        )}
      </div>
    </div>
  );
}

function Grid({ images, folderPath, fileEventNonce, onSelect }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {images.map((img) => (
        <Tile
          key={img.name}
          image={img}
          folderPath={folderPath}
          fileEventNonce={fileEventNonce}
          onClick={() => onSelect({ path: `${folderPath}/${img.name}`, type: 'file' })}
        />
      ))}
    </div>
  );
}

function Tile({ image, folderPath, fileEventNonce, onClick }) {
  const fullPath = `${folderPath}/${image.name}`;
  const url = `/api/files/raw?path=${encodeURIComponent(fullPath)}&v=${fileEventNonce ?? 0}`;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex flex-col gap-1.5 overflow-hidden rounded-lg text-left',
        'transition-colors',
      )}
      title={image.name}
    >
      <div className="relative aspect-square overflow-hidden rounded-lg border bg-muted/40">
        <img
          src={url}
          alt={image.name}
          loading="lazy"
          className="size-full object-cover transition-transform group-hover:scale-[1.02]"
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
      </div>
      <div className="px-0.5">
        <div className="truncate text-xs font-medium text-foreground/85">{image.name}</div>
        {typeof image.size === 'number' && (
          <div className="text-[11px] text-muted-foreground/60">{formatBytes(image.size)}</div>
        )}
      </div>
    </button>
  );
}

function Centered({ children, error }) {
  return (
    <div className={cn(
      'flex h-full items-center justify-center text-sm',
      error ? 'text-destructive' : 'text-muted-foreground/70',
    )}>
      {children}
    </div>
  );
}

function GalleryEmptyState() {
  const branding = useBranding();
  const botName = branding.botDisplayName || 'Assistant';
  return (
    <div className="flex h-full items-center justify-center px-6 py-16">
      <div className="flex max-w-[320px] flex-col items-center gap-3 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground/50">
          <Images className="size-6" strokeWidth={1.75} />
        </div>
        <h2 className="text-[14px] font-semibold tracking-tight text-foreground/85">No images yet</h2>
        <p className="text-[13px] leading-relaxed text-muted-foreground/75">
          If you ask <span className="font-medium text-foreground/85">{botName}</span> to generate or save an image for you, it will appear here. To enable this, connect an image service (like Seedream or Gemini Image) in the Integrations tab.
        </p>
      </div>
    </div>
  );
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
