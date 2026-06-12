import { useEffect, useState } from 'react';
import { FileText, Folder } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * CreateNew — controlled Dialog for creating a new file or folder.
 *
 *   open  = boolean
 *   onCancel()
 *   onSubmit({ kind: 'file'|'folder', name: string })
 *
 * The parent does the actual API call. Validates name client-side: non-empty,
 * no slashes, no leading dot. Server still re-validates and may reject.
 */
export default function CreateNew({ open, onCancel, onSubmit }) {
  const [kind, setKind] = useState('file');
  const [name, setName] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) { setKind('file'); setName(''); setError(null); }
  }, [open]);

  const submit = (e) => {
    e?.preventDefault();
    const clean = name.trim();
    if (!clean) { setError('Name is required'); return; }
    if (clean.includes('/') || clean.includes('\\')) { setError('Name cannot contain slashes'); return; }
    if (clean.startsWith('.')) { setError('Name cannot start with a dot'); return; }
    if (clean.length > 200) { setError('Name is too long'); return; }
    onSubmit({ kind, name: clean });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New {kind}</DialogTitle>
            <DialogDescription>
              Created at the workspace root.
            </DialogDescription>
          </DialogHeader>

          <div className="my-4 flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <KindButton active={kind === 'file'} onClick={() => setKind('file')} icon={FileText} label="Note" />
              <KindButton active={kind === 'folder'} onClick={() => setKind('folder')} icon={Folder} label="Folder" />
            </div>
            <Input
              autoFocus
              value={name}
              onChange={(e) => { setName(e.target.value); setError(null); }}
              placeholder={kind === 'file' ? 'note.md' : 'new-folder'}
              aria-invalid={!!error}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button type="submit">Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function KindButton({ active, onClick, icon: Icon, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
        active
          ? 'border-foreground/40 bg-muted/60 font-medium text-foreground/95'
          : 'border-border text-muted-foreground/80 hover:bg-muted/30',
      )}
    >
      <Icon className="size-4" strokeWidth={1.75} />
      {label}
    </button>
  );
}
