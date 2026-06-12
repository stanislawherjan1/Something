import { useEffect, useRef, useState } from 'react';
import { File as FileIcon, Folder } from 'lucide-react';

/**
 * InlineCreateRow — VS Code-style inline naming for new files/folders.
 *
 * Renders a row inside the file tree at the requested depth with a focused
 * input. Enter submits, Escape cancels, blur cancels (committing only
 * happens on Enter so a stray click doesn't create empty entries).
 *
 * For files: if the user-typed name has no extension, ".md" is auto-appended
 * — notes are the dominant case in this workspace.
 */
export default function InlineCreateRow({ kind, depth = 1, onSubmit, onCancel }) {
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const Icon = kind === 'folder' ? Folder : FileIcon;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => {
    let clean = name.trim();
    if (!clean) { onCancel(); return; }
    if (clean.includes('/') || clean.includes('\\')) { setError('No slashes'); return; }
    if (clean.startsWith('.')) { setError('No leading dot'); return; }
    if (clean.length > 200) { setError('Too long'); return; }
    if (kind === 'file' && !/\.[a-zA-Z0-9]+$/.test(clean)) clean += '.md';
    onSubmit({ kind, name: clean });
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter')      { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };

  return (
    <div
      style={{ paddingLeft: `${8 + depth * 12}px` }}
      className="flex h-7 items-center gap-1.5 rounded-md pr-2 text-[13px]"
    >
      <span className="inline-block size-3 shrink-0" />
      <Icon className="size-3.5 shrink-0 text-muted-foreground/80" strokeWidth={1.75} />
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => { setName(e.target.value); setError(null); }}
        onKeyDown={onKeyDown}
        onBlur={onCancel}
        placeholder={kind === 'folder' ? 'folder name' : 'note.md'}
        className="h-5 flex-1 bg-transparent px-0.5 text-[13px] outline-none border-b border-foreground/20 focus-visible:border-foreground/50"
        aria-invalid={!!error}
      />
      {error && (
        <span className="ml-1 truncate text-[11px] text-destructive">{error}</span>
      )}
    </div>
  );
}
