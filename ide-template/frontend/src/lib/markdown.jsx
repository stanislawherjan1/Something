/* eslint-disable react-refresh/only-export-components --
 * Shared markdown module: co-locates the MarkdownView component with its prose
 * constant and the stripFrontmatter helper by design. This is a leaf util, not a
 * route — losing Fast Refresh on it is a non-issue, and one import path
 * (`@/lib/markdown`) beats splitting helpers into a second file. */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Strip the leading YAML frontmatter block (--- … ---) — it's the bot's operational
// contract (purpose / write_when / allowed-tools), not content the user reads.
export function stripFrontmatter(md) {
  if (!md) return '';
  return md.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

// Rendered-markdown styling via Tailwind child selectors — no typography plugin
// needed; matches the app's muted, tight-leading vocabulary. Shared by the memory
// card viewer and the read-only skill viewer.
export const MARKDOWN_PROSE = [
  'max-w-none text-[13.5px] leading-[1.7] text-foreground/85',
  '[&_h1]:mb-3 [&_h1]:mt-1 [&_h1]:text-[17px] [&_h1]:font-semibold [&_h1]:text-foreground',
  '[&_h2]:mb-2 [&_h2]:mt-6 [&_h2]:text-[12px] [&_h2]:font-semibold [&_h2]:uppercase [&_h2]:tracking-[0.08em] [&_h2]:text-muted-foreground/70',
  '[&_h3]:mb-1.5 [&_h3]:mt-4 [&_h3]:text-[13.5px] [&_h3]:font-semibold [&_h3]:text-foreground/90',
  '[&_p]:mb-3',
  '[&_ul]:mb-3 [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-1',
  '[&_ol]:mb-3 [&_ol]:ml-5 [&_ol]:list-decimal [&_ol]:flex [&_ol]:flex-col [&_ol]:gap-1',
  '[&_li]:ml-4 [&_li]:list-disc [&_li]:marker:text-muted-foreground/40',
  '[&_strong]:font-semibold [&_strong]:text-foreground',
  '[&_em]:italic',
  '[&_code]:rounded [&_code]:bg-foreground/[0.06] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_code]:text-foreground/80',
  '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border/50 [&_pre]:bg-muted/30 [&_pre]:p-3 [&_pre]:text-[12px]',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_a]:text-[--color-ring] [&_a]:underline-offset-2 [&_a]:hover:underline',
  '[&_hr]:my-5 [&_hr]:border-border/50',
  '[&_del]:text-muted-foreground/55',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-border/60 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground/85',
  '[&_table]:my-3 [&_table]:block [&_table]:w-full [&_table]:overflow-x-auto [&_table]:text-[12.5px]',
  '[&_th]:border [&_th]:border-border/50 [&_th]:bg-muted/40 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium',
  '[&_td]:border [&_td]:border-border/50 [&_td]:px-2 [&_td]:py-1',
].join(' ');

/**
 * Render a markdown string as formatted content (GFM: tables, strikethrough, etc.).
 * Pass already-stripped text, or wrap with stripFrontmatter() at the call site.
 */
export function MarkdownView({ children, className = '' }) {
  return (
    <div className={`${MARKDOWN_PROSE} ${className}`.trim()}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children || ''}</ReactMarkdown>
    </div>
  );
}
