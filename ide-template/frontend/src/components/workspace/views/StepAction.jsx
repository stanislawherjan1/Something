import { useState } from 'react';
import { Download, Copy, Check, Loader2 } from 'lucide-react';

const btn = 'inline-flex items-center gap-1.5 rounded-[6px] border border-border/70 bg-background px-3 py-1.5 text-[12px] font-medium text-foreground/85 transition-all hover:border-foreground/30 hover:bg-muted/30 hover:text-foreground active:scale-[0.99] disabled:opacity-60';

/**
 * One action under a setup step: a file to download, or — `copy: true` — text
 * to put on the clipboard. A Slack manifest is pasted into a text box, not
 * uploaded: as a download it was one more file to open and copy from, and the
 * one-line JSON pasted unreadably. Copied, JSON is laid out to read.
 */
export default function StepAction({ label, url, filename = '', copy = false }) {
  const [state, setState] = useState(null);   // null | 'busy' | 'done' | 'failed'
  if (!copy) {
    return (
      <a href={url} download={filename || true} className={btn}>
        <Download className="size-3.5" strokeWidth={1.75} />{label}
      </a>
    );
  }
  const onCopy = async () => {
    setState('busy');
    try {
      const r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) throw new Error(String(r.status));
      let text = await r.text();
      try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON: as served */ }
      await navigator.clipboard.writeText(text);
      setState('done');
      setTimeout(() => setState(null), 2500);
    } catch {
      setState('failed');
      setTimeout(() => setState(null), 3500);
    }
  };
  return (
    <button type="button" onClick={onCopy} disabled={state === 'busy'} className={btn}>
      {state === 'busy' ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} />
        : state === 'done' ? <Check className="size-3.5 text-emerald-600" strokeWidth={2} />
        : <Copy className="size-3.5" strokeWidth={1.75} />}
      {state === 'done' ? 'Copied' : state === 'failed' ? 'Could not copy — try again' : label}
    </button>
  );
}
