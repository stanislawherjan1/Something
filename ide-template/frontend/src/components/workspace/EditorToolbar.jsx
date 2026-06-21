import { useState } from 'react';
import { Popover } from 'radix-ui';
import {
  useBlockNoteEditor,
  useActiveStyles,
  useSelectedBlocks,
} from '@blocknote/react';
import {
  Type, Heading1, Heading2, Heading3,
  List, ListOrdered, ListChecks, Quote, Code,
  Bold, Italic, Strikethrough, Code2,
  ChevronDown, Check, Link2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * EditorToolbar — the floating selection toolbar for the markdown editor,
 * mounted via <FormattingToolbarController>. BlockNote's controller handles
 * positioning + show/hide; this component only renders the contents, built
 * entirely from OUR design-system primitives (Button, DropdownMenu, Popover)
 * so it reads as one with the rest of the workspace — no @blocknote/shadcn
 * chrome.
 *
 * Scope is deliberately markdown-faithful: we only expose what survives the
 * markdown round-trip on save (block types, bold/italic/strike/code, links).
 * Colour/alignment are intentionally omitted — they'd be silently dropped.
 */

// Block-type registry. `match` detects the current block for the active label;
// `type`/`props` are applied via editor.updateBlock. (Paragraph = no props.)
const BLOCK_TYPES = [
  { id: 'paragraph', label: 'Text',         icon: Type,       type: 'paragraph',        match: (b) => b.type === 'paragraph' },
  { id: 'h1',        label: 'Heading 1',     icon: Heading1,   type: 'heading', props: { level: 1 }, match: (b) => b.type === 'heading' && b.props?.level === 1 },
  { id: 'h2',        label: 'Heading 2',     icon: Heading2,   type: 'heading', props: { level: 2 }, match: (b) => b.type === 'heading' && b.props?.level === 2 },
  { id: 'h3',        label: 'Heading 3',     icon: Heading3,   type: 'heading', props: { level: 3 }, match: (b) => b.type === 'heading' && b.props?.level === 3 },
  { id: 'bullet',    label: 'Bullet List',   icon: List,        type: 'bulletListItem',   match: (b) => b.type === 'bulletListItem' },
  { id: 'numbered',  label: 'Numbered List', icon: ListOrdered, type: 'numberedListItem', match: (b) => b.type === 'numberedListItem' },
  { id: 'check',     label: 'Check List',    icon: ListChecks,  type: 'checkListItem',    match: (b) => b.type === 'checkListItem' },
  { id: 'quote',     label: 'Quote',         icon: Quote,       type: 'quote',            match: (b) => b.type === 'quote' },
  { id: 'code',      label: 'Code',          icon: Code,        type: 'codeBlock',        match: (b) => b.type === 'codeBlock' },
];

function Divider() {
  return <div className="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden />;
}

function StyleButton({ active, onClick, label, children }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-pressed={active}
      title={label}
      // Keep the editor selection alive when pressing the button (otherwise the
      // mousedown blurs ProseMirror and collapses the range we're styling).
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn('text-muted-foreground hover:text-foreground', active && 'bg-accent text-accent-foreground')}
    >
      {children}
    </Button>
  );
}

export default function EditorToolbar() {
  const editor = useBlockNoteEditor();
  const activeStyles = useActiveStyles(editor);
  const selectedBlocks = useSelectedBlocks(editor);

  const current = selectedBlocks[0];
  const active = (current && BLOCK_TYPES.find((t) => t.match(current))) || BLOCK_TYPES[0];
  const ActiveIcon = active.icon;

  const applyType = (item) => {
    editor.transact(() => {
      for (const block of selectedBlocks) {
        editor.updateBlock(block, { type: item.type, props: item.props || {} });
      }
    });
    editor.focus();
  };

  const toggle = (style) => editor.toggleStyles({ [style]: true });

  // Link popover ----------------------------------------------------------
  const [linkOpen, setLinkOpen] = useState(false);
  const [url, setUrl] = useState('');
  const submitLink = (e) => {
    e?.preventDefault();
    const u = url.trim();
    if (u) editor.createLink(u);          // applies to the persisted selection
    setUrl('');
    setLinkOpen(false);
    editor.focus();
  };

  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
      {/* Block type */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-1.5 px-2 font-normal text-foreground/85">
            <ActiveIcon className="size-4 opacity-80" />
            <span className="text-[13px]">{active.label}</span>
            <ChevronDown className="size-3.5 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={6} className="w-48">
          {BLOCK_TYPES.map((t) => {
            const Icon = t.icon;
            return (
              <DropdownMenuItem key={t.id} onClick={() => applyType(t)} className="gap-2">
                <Icon className="size-4 opacity-70" />
                <span className="flex-1">{t.label}</span>
                {active.id === t.id && <Check className="size-4 opacity-70" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <Divider />

      <StyleButton active={!!activeStyles.bold}   onClick={() => toggle('bold')}   label="Bold"><Bold className="size-4" /></StyleButton>
      <StyleButton active={!!activeStyles.italic} onClick={() => toggle('italic')} label="Italic"><Italic className="size-4" /></StyleButton>
      <StyleButton active={!!activeStyles.strike} onClick={() => toggle('strike')} label="Strikethrough"><Strikethrough className="size-4" /></StyleButton>
      <StyleButton active={!!activeStyles.code}   onClick={() => toggle('code')}   label="Code"><Code2 className="size-4" /></StyleButton>

      <Divider />

      <Popover.Root open={linkOpen} onOpenChange={setLinkOpen}>
        <Popover.Trigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Link"
            className={cn('text-muted-foreground hover:text-foreground', linkOpen && 'bg-muted text-foreground')}
          >
            <Link2 className="size-4" />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={8}
            className="z-50 w-72 overflow-hidden rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-xl outline-none"
          >
            <form onSubmit={submitLink}>
              <div className="flex items-center gap-2.5 px-3.5">
                <Link2 className="size-4 shrink-0 text-muted-foreground/55" strokeWidth={1.75} />
                <input
                  autoFocus
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="Paste a link…"
                  className="h-10 w-full bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground/50"
                />
              </div>
              <div className="border-t border-border/50 p-2">
                <Button type="submit" size="sm" className="w-full" disabled={!url.trim()}>Apply link</Button>
              </div>
            </form>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
