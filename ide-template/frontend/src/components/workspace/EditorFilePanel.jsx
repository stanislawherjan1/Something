import { useState } from 'react';
import { useBlockNoteEditor } from '@blocknote/react';
import { Link2, Upload, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * EditorFilePanel — replaces BlockNote's default "Add image" embed/upload popup,
 * mounted via <FilePanelController>. Built to OUR popup idiom (see SearchPalette):
 * a clean bordered card with a borderless/transparent input — not a heavy
 * bordered field with a focus ring. Embed-only unless editor.uploadFile is set.
 */
export default function EditorFilePanel({ blockId }) {
  const editor = useBlockNoteEditor();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const block = editor.getBlock?.(blockId);
  const kind = block?.type || 'image';            // image | video | audio | file
  const canUpload = typeof editor.uploadFile === 'function';
  const noun = kind === 'image' ? 'image' : kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'file';

  const embed = () => {
    const u = url.trim();
    if (u) editor.updateBlock(blockId, { props: { url: u } });
  };

  const upload = async (file) => {
    if (!canUpload || !file) return;
    setBusy(true);
    try {
      const res = await editor.uploadFile(file, blockId);
      const update = typeof res === 'string' ? { props: { url: res, name: file.name } } : res;
      editor.updateBlock(blockId, update);
    } catch (err) {
      console.error('[file-panel] upload failed', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-80 overflow-hidden rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-xl">
      {canUpload && (
        <label
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center gap-1.5 border-b border-border/50 px-4 py-5 text-center transition-colors hover:bg-muted/40',
            busy && 'pointer-events-none opacity-60',
          )}
        >
          <input
            type="file"
            className="hidden"
            accept={kind === 'image' ? 'image/*' : kind === 'video' ? 'video/*' : kind === 'audio' ? 'audio/*' : undefined}
            onChange={(e) => upload(e.target.files?.[0])}
          />
          {busy
            ? <Loader2 className="size-5 text-muted-foreground/60 animate-spin" strokeWidth={1.75} />
            : <Upload className="size-5 text-muted-foreground/60" strokeWidth={1.75} />}
          <span className="text-[13px] font-medium text-foreground/85">{busy ? 'Uploading…' : `Upload ${noun}`}</span>
          <span className="text-[11px] text-muted-foreground/55">or drop a file here</span>
        </label>
      )}

      {/* Embed-link row — borderless input in the card (our popup idiom) */}
      <div className="flex items-center gap-2.5 px-3.5">
        <Link2 className="size-4 shrink-0 text-muted-foreground/55" strokeWidth={1.75} />
        <input
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); embed(); } }}
          placeholder={`Paste ${kind === 'image' ? 'an image' : `a ${noun}`} URL…`}
          className="h-11 w-full bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground/50"
        />
      </div>

      <div className="border-t border-border/50 p-2">
        <Button type="button" size="sm" className="w-full" onClick={embed} disabled={!url.trim()}>
          Embed {noun}
        </Button>
      </div>
    </div>
  );
}
