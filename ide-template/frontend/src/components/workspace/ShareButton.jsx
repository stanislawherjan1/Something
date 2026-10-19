import { useCallback, useEffect, useState } from 'react';
import { Check, Link2, Copy, Link2Off } from 'lucide-react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { shareUrl } from '@/lib/shareUrl';

/**
 * Share a Markdown file by link (workspace-api routes/shares.js). Anyone with
 * the link reads the file as it is now, read only; someone who can open it
 * here is taken to the file instead. The button only shows when this person
 * may share this file and the workspace allows it. A link works for 30 days
 * unless its maker picks another span or no end.
 */
const SPANS = [{ days: 7, label: '7 days' }, { days: 30, label: '30 days' }, { days: 0, label: 'No end' }];
const until = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
// The span the link was given (stored with it; a link from before spans were kept reads as 30 days).
const spanOf = (link) => String(link?.expiresAt ? (link.days ?? 30) : 0);
// Quiet, like the save state beside it: text and icon, no box; darker on hover.
const btn = 'inline-flex items-center gap-1 rounded-[4px] px-1 py-0.5 text-[12px] text-muted-foreground/70 transition-colors hover:text-foreground/85 disabled:opacity-60';

export default function ShareButton({ path }) {
  const [state, setState] = useState(null);   // { enabled, canShare, link }
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/shares?path=${encodeURIComponent(path)}`, { credentials: 'include' });
      setState(r.ok ? await r.json() : null);
    } catch { setState(null); }
  }, [path]);
  useEffect(() => { setState(null); setError(null); load(); }, [load]);

  const copy = async (token) => {
    try { await navigator.clipboard.writeText(shareUrl(token)); setCopied(true); setTimeout(() => setCopied(false), 1600); }
    catch { /* the browser refused the clipboard: the link is still in the menu */ }
  };

  const share = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/shares', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok || !out.ok) throw new Error(out.error || `Sharing failed (${r.status})`);
      setState((s) => ({ ...s, link: { token: out.token, path: out.path, by: out.by, createdAt: out.createdAt } }));
      await copy(out.token);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const setSpan = async (days) => {
    if (!state?.link) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/shares/${state.link.token}`, {
        method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: Number(days) }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok || !out.ok) throw new Error(out.error || `Couldn't change the link (${r.status})`);
      setState((s) => ({ ...s, link: { ...s.link, days: out.days, expiresAt: out.expiresAt } }));
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const stop = async () => {
    if (!state?.link) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/shares/${state.link.token}`, { method: 'DELETE', credentials: 'include' });
      const out = await r.json().catch(() => ({}));
      if (!r.ok || !out.ok) throw new Error(out.error || `Couldn't stop sharing (${r.status})`);
      setState((s) => ({ ...s, link: null }));
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  if (!state?.enabled || (!state.canShare && !state.link)) return null;

  if (!state.link) {
    return (
      <span className="inline-flex items-center gap-2">
        {error && <span className="text-destructive">{error}</span>}
        <button type="button" className={btn} onClick={share} disabled={busy} title="Anyone with the link can read this file">
          <Link2 className="size-3.5" strokeWidth={1.5} />Share
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-destructive">{error}</span>}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={cn(btn, 'text-foreground/70')} disabled={busy}>
            {copied ? <Check className="size-3.5" strokeWidth={2} /> : <Link2 className="size-3.5" strokeWidth={1.75} />}
            {copied ? 'Link copied' : 'Shared'}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <div className="px-2 py-1.5 text-[12px] leading-relaxed text-muted-foreground/80">
            Anyone with the link can read this file as it is now. People who can open it here go straight to it.
            <span className="mt-1 block text-foreground/75">{state.link.expiresAt ? `Works until ${until(state.link.expiresAt)}.` : 'Works until you stop sharing.'}</span>
          </div>
          <DropdownMenuSeparator />
          <div className="px-2 pb-0.5 pt-1 text-[11px] font-medium text-muted-foreground/60">Link works for</div>
          <DropdownMenuRadioGroup value={spanOf(state.link)} onValueChange={setSpan}>
            {SPANS.map((s) => <DropdownMenuRadioItem key={s.days} value={String(s.days)}>{s.label}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => copy(state.link.token)}>
            <Copy className="size-3.5" strokeWidth={1.75} />Copy link
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={stop} className="text-destructive focus:text-destructive">
            <Link2Off className="size-3.5" strokeWidth={1.75} />Stop sharing
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
