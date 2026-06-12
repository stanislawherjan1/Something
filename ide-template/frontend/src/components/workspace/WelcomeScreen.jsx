import { useState, useRef, useEffect } from 'react';
import { ArrowUp, Menu, Paperclip } from 'lucide-react';
import { cn } from '@/lib/utils';
import SpinningAvatar from './SpinningAvatar.jsx';

export default function WelcomeScreen({ onSend, sidebarOpen, onExpandSidebar }) {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const submit = () => {
    const msg = input.trim();
    if (!msg) return;
    onSend(msg, attachments);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handleFileSelect = (e) => {
    const files = Array.from(e.currentTarget.files || []);
    setAttachments(prev => [...prev, ...files]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const canSend = input.trim().length > 0;

  return (
    <main className="relative flex h-full flex-col items-center justify-center bg-background px-6">
      {!sidebarOpen && (
        <button
          type="button"
          onClick={onExpandSidebar}
          title="Show sidebar"
          className="absolute top-3 left-3 z-10 flex size-8 items-center justify-center rounded-md border bg-background text-muted-foreground/70 shadow-xs transition-colors hover:bg-sidebar-accent/40 hover:text-foreground/85"
        >
          <Menu className="size-4" strokeWidth={1.75} />
        </button>
      )}

      <div className="w-full max-w-2xl flex flex-col gap-6">
        <div className="flex max-md:flex-col md:flex-row items-center gap-5 max-md:text-center">
          <SpinningAvatar size={16} />
          <h1 className="text-[32px] font-bold tracking-[-0.02em] text-foreground leading-tight">
            Hi, what can I help with today?
          </h1>
        </div>

        <div className={cn(
          'flex flex-col rounded-xl border border-border/60 bg-card/70',
          'shadow-[0_2px_12px_rgba(0,0,0,0.06)]',
          'transition-all duration-150 focus-within:border-border focus-within:bg-card/90 focus-within:shadow-[0_4px_20px_rgba(0,0,0,0.09)]',
        )}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask anything…"
            rows={1}
            className={cn(
              'field-sizing-content w-full resize-none bg-transparent px-4 pt-3.5 pb-1',
              'text-[15px] leading-relaxed text-foreground placeholder:text-muted-foreground/50',
              'outline-none',
            )}
            style={{ maxHeight: '220px' }}
          />

          <div className="flex items-center gap-2 px-3 pb-3 pt-1">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Add attachment"
              className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-muted-foreground/70 transition-colors hover:bg-muted/40 hover:text-foreground/85"
            >
              <Paperclip className="size-3.5" strokeWidth={1.75} />
              Attach
            </button>

            {attachments.length > 0 && (
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                {attachments.map((file, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 text-[11px] text-foreground/75"
                  >
                    <Paperclip className="size-3 shrink-0 opacity-65" strokeWidth={1.75} />
                    <span className="max-w-[160px] truncate">{file.name}</span>
                    <button
                      type="button"
                      onClick={() => setAttachments(prev => prev.filter((_, idx) => idx !== i))}
                      className="ml-0.5 text-muted-foreground/60 hover:text-foreground"
                      aria-label={`Remove ${file.name}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              className={cn(
                'ml-auto flex shrink-0 size-8 items-center justify-center rounded-lg transition-all duration-150',
                canSend
                  ? 'bg-foreground text-background hover:opacity-90 active:scale-95'
                  : 'bg-muted text-muted-foreground/40 cursor-not-allowed',
              )}
            >
              <ArrowUp className="size-4" strokeWidth={2} />
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>
      </div>
    </main>
  );
}
