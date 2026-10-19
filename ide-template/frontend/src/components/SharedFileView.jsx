import { useEffect, useState } from 'react';
import { Eye, Loader2 } from 'lucide-react';
import { MarkdownView, stripFrontmatter } from '@/lib/markdown';
import { useBranding, BrandedImage } from './workspace/identity';
import TileBanner from './workspace/views/TileBanner.jsx';

/**
 * A file someone shared by link (/app/s/<token>): its name and text, read only,
 * for anyone with the link — no sign-in, nothing of the workspace around it.
 * Someone signed in who can open the file here is taken to it in the workspace
 * instead. The server shows the file as it is now and never its path
 * (workspace-api routes/shares.js).
 */
// A file that opens with its own "# Title" uses it as the page title, once:
// otherwise the name, made readable ("launch-plan.md" → "launch plan").
function titleAndBody(name, content) {
  const body = stripFrontmatter(content || '');
  const m = body.match(/^#\s+(.+?)\s*\n/);
  if (m) return { heading: m[1].replace(/[*_`]/g, ''), body: body.slice(m[0].length).trimStart() };
  return { heading: name.replace(/\.md$/i, '').replace(/[-_]+/g, ' '), body };
}

// Outside the workspace's own address an image would tell whoever wrote the file
// that the link was opened, from where and when (a tracking pixel). Only images
// served from here or inlined in the file are shown; any other reads as its link.
const isOwn = (src) => {
  try { const u = new URL(src, window.location.href); return u.protocol === 'data:' || u.origin === window.location.origin; } catch { return false; }
};
const VIEW_COMPONENTS = {
  img: ({ src, alt }) => (isOwn(src)
    ? <img src={src} alt={alt || ''} />
    : <a href={src} target="_blank" rel="noopener noreferrer nofollow">{alt || 'image'}</a>),
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>,
};

export default function SharedFileView({ token }) {
  const { title, iconUrl } = useBranding();
  const [state, setState] = useState({ kind: 'loading' });

  // The page's address holds the token: never send it on to another site.
  useEffect(() => {
    const m = document.createElement('meta');
    m.name = 'referrer'; m.content = 'no-referrer';
    document.head.appendChild(m);
    return () => m.remove();
  }, []);

  useEffect(() => {
    let gone = false;
    (async () => {
      // Signed in and allowed: open it where it lives. Anyone else: the read-only page.
      try {
        const o = await fetch(`/api/shares/${encodeURIComponent(token)}/open`, { credentials: 'include' });
        if (o.ok) {
          const { path } = await o.json();
          if (path && !gone) { window.location.replace(`${import.meta.env.BASE_URL.replace(/\/$/, '')}/files/${path}`); return; }
        }
      } catch { /* not signed in: read it below */ }
      try {
        const r = await fetch(`/api/public/share/${encodeURIComponent(token)}`, { credentials: 'omit' });
        const out = await r.json().catch(() => ({}));
        if (gone) return;
        if (!r.ok || !out.ok) setState({ kind: 'gone', error: out.error || null });
        else setState({ kind: 'ok', ...out });
      } catch { if (!gone) setState({ kind: 'gone' }); }
    })();
    return () => { gone = true; };
  }, [token]);

  useEffect(() => {
    if (state.kind === 'ok') document.title = `${titleAndBody(state.name, state.content).heading}${title ? ` · ${title}` : ''}`;
  }, [state, title]);

  return (
    <main
      // Its own scroll box: the app pins html/body at the viewport height with
      // overflow hidden (the workspace scrolls inside its panes), so a page
      // that relies on the body scrolling never moves.
      className="h-screen w-screen overflow-y-auto bg-background text-foreground antialiased"
      style={{
        fontFamily: '"Geist Variable", "Geist", -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif',
        fontFeatureSettings: '"cv11", "ss01", "ss03", "calt"',
      }}
    >
      {state.kind === 'loading' && (
        <div className="flex min-h-screen items-center justify-center text-muted-foreground/60">
          <Loader2 className="size-5 animate-spin" strokeWidth={1.75} />
        </div>
      )}
      {state.kind === 'gone' && (
        <div className="flex min-h-screen items-center justify-center px-6">
          <div className="w-full max-w-[380px] overflow-hidden rounded-[6px] border border-border/60 bg-card">
            <TileBanner abstract="wave-fault" seed="shared-file" soft className="h-24" />
            <div className="flex flex-col gap-1 px-7 py-6">
              <h1 className="text-[16px] font-semibold text-foreground/90">This link doesn't work any more</h1>
              <p className="text-[13px] leading-relaxed text-muted-foreground/80">
                The file was unshared, moved or deleted. Ask whoever sent it for a new link.
              </p>
            </div>
          </div>
        </div>
      )}
      {state.kind === 'ok' && (
        <>
          {/* The workspace it comes from, quietly, and that it is read only. */}
          <div className="sticky top-0 z-10 border-b border-border/50 bg-background/85 backdrop-blur">
            <div className="mx-auto flex h-14 w-full max-w-[760px] items-center justify-between gap-3 px-6">
              <div className="flex min-w-0 items-center gap-2.5">
                <BrandedImage src={iconUrl} alt={title} className="size-6 shrink-0 rounded-[5px] bg-card object-cover ring-1 ring-foreground/10" />
                <span className="truncate text-[13px] font-medium text-foreground/80">{title || 'Shared file'}</span>
              </div>
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-card px-2.5 py-0.5 text-[11.5px] text-muted-foreground/80">
                <Eye className="size-3" strokeWidth={1.75} />Read only
              </span>
            </div>
          </div>

          <article className="mx-auto w-full max-w-[760px] px-6 pb-24 pt-8">
            <header className="mb-10">
              <TileBanner abstract="wave" seed={state.name} soft className="h-24 rounded-[6px] border border-border/50" />
              <h1 className="mt-7 text-[28px] font-semibold leading-tight tracking-[-0.02em] text-foreground">
                {titleAndBody(state.name, state.content).heading}
              </h1>
              {state.mtime && (
                <p className="mt-2 text-[13px] text-muted-foreground/70">
                  Updated {new Date(state.mtime).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}
                </p>
              )}
            </header>
            <MarkdownView className="text-[15px]" components={VIEW_COMPONENTS}>{titleAndBody(state.name, state.content).body}</MarkdownView>
          </article>
        </>
      )}
    </main>
  );
}
