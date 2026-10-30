import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Check } from 'lucide-react';
import { useBranding, BrandedImage } from './workspace/identity';
import TileBanner from './workspace/views/TileBanner.jsx';
import { cn } from '@/lib/utils';

/**
 * Consent page — an AI agent (Claude Code, Codex) asked to connect
 * to this workspace as the signed-in person. One tile in the sign-in page's
 * family: who is asking, as whom, what it may do, and the one fact that
 * matters — what it reads leaves the workspace into that tool on the
 * person's computer. Allow or deny; both answer the agent's redirect.
 *
 * The request itself is parked in auth-service under ?req=<id>
 * (auth-service/agents.js); this page reads it and posts the choice.
 */
const SCOPE_TEXT = {
  'read': ['Read', 'the company context, memory, the board and the shared files'],
  'read:private': ['Read your private things', 'your private memory, your own task list and your folder — pay, plans, notes about people'],
  'write:tasks': ['Add and update tasks', 'on your own list and the team board, after asking you each time'],
  'write:memory': ['Save notes and session summaries', 'to your own memory, after asking you each time'],
  'write:files': ['Write files', 'into your own folder, or a shared one when you say so, after asking you each time'],
  'ask': ['Ask your assistant questions', 'it answers as you and never acts; needs your private things too; uses your plan'],
};
// Writes are on by default (the agent asks before each one); a turn of the
// assistant is a cost the person opts into.
const DEFAULT_ON = new Set(['read', 'write:tasks', 'write:memory', 'write:files']);   // not read:private

export default function ConsentPage() {
  const { title, iconUrl, botDisplayName, botName } = useBranding();
  const bot = botDisplayName || botName || title;
  const reqId = new URLSearchParams(window.location.search).get('req') || '';
  const [req, setReq] = useState(undefined);   // undefined loading, null gone
  const [chosen, setChosen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/auth/agents/request/${encodeURIComponent(reqId)}`, { credentials: 'include' });
        const j = await r.json().catch(() => ({}));
        if (!alive) return;
        if (!r.ok) { setReq(null); setError(j.error || 'This connection request has expired. Start again from your coding agent.'); return; }
        setReq(j);
        setChosen(new Set(j.scopes.filter(s => DEFAULT_ON.has(s))));
      } catch { if (alive) { setReq(null); setError('Could not reach the workspace. Try again.'); } }
    })();
    return () => { alive = false; };
  }, [reqId]);

  const answer = async (allow) => {
    setBusy(true); setError('');
    try {
      const r = await fetch('/auth/agents/consent', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ req: reqId, allow, scopes: [...(chosen || [])] }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.redirect) throw new Error(j.error || 'The request could not be answered.');
      window.location.assign(j.redirect);
    } catch (e) { setError(e.message); setBusy(false); }
  };
  const toggle = (s) => setChosen(prev => { const n = new Set(prev); if (n.has(s)) n.delete(s); else n.add(s); n.add('read'); return n; });

  return (
    <main
      className="flex min-h-screen w-screen items-center justify-center bg-background px-6 py-10 text-foreground antialiased"
      style={{ fontFamily: '"Geist Variable", "Geist", -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif', fontFeatureSettings: '"cv11", "ss01", "ss03", "calt"' }}
    >
      <div className="w-full max-w-[600px] overflow-hidden rounded-[6px] border border-border/60 bg-card">
        <TileBanner abstract={req === null ? 'wave-fault' : 'wave'} seed={title || 'connect'} soft className="h-20" />
        <div className="flex flex-col gap-5 px-7 pb-7">
          <BrandedImage src={iconUrl} alt={title} className="relative -mt-7 size-14 rounded-[6px] bg-card object-cover ring-1 ring-foreground/10" />

          {req === undefined ? (
            <div className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground/70"><Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> Loading the request…</div>
          ) : req === null ? (
            <>
              <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground/90">Nothing to connect</h1>
              <Problem text={error} />
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground/90">
                  Connect <span className="text-foreground">{req.client.name}</span> to {title}?
                </h1>
                <p className="text-[13px] leading-relaxed text-muted-foreground/80">
                  Signed in as <span className="font-medium text-foreground/80">{req.person.email}</span>. {req.client.name} will see your workspace the way you do — and keep what it reads on your computer.
                </p>
              </div>

              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {req.scopes.map(s => {
                  const [label, detail] = SCOPE_TEXT[s] || [s, ''];
                  const fixed = s === 'read';
                  const on = chosen?.has(s);
                  return (
                    <li key={s} className={cn(s === 'read' && 'sm:col-span-2')}>
                      <div role="checkbox" aria-checked={!!on} aria-disabled={fixed || busy} tabIndex={fixed ? -1 : 0}
                        onClick={() => { if (!fixed && !busy) toggle(s); }}
                        onKeyDown={(e) => { if (!fixed && !busy && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); toggle(s); } }}
                        className={cn('flex h-full items-start gap-2.5 rounded-[6px] border px-3 py-2.5 outline-none focus-visible:ring-1 focus-visible:ring-foreground/30', on ? 'border-border/70 bg-background' : 'border-border/40 bg-muted/20', fixed ? 'cursor-default' : 'cursor-pointer')}>
                        <Tick checked={!!on} dim={fixed} />
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium text-foreground/90">{label}</span>
                          {detail && <span className="block text-[12px] leading-relaxed text-muted-foreground/80">{detail}</span>}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>

              <p className="text-[12px] leading-relaxed text-muted-foreground/70">
                {req.loopback ? `${req.client.name} is running on your computer (${req.redirectHost}).` : `${req.client.name} runs at ${req.redirectHost}.`} You can disconnect it any time on the Context MCP page.
              </p>

              {error && <Problem text={error} />}

              <div className="flex gap-2">
                <button type="button" disabled={busy} onClick={() => answer(false)} className="inline-flex flex-1 items-center justify-center rounded-[6px] border border-border/70 bg-card px-4 py-2.5 text-[13.5px] font-medium text-foreground/75 transition-colors hover:bg-muted/40 disabled:opacity-60">
                  Deny
                </button>
                <button type="button" disabled={busy} onClick={() => answer(true)} className="inline-flex flex-1 items-center justify-center gap-2 rounded-[6px] bg-foreground px-4 py-2.5 text-[13.5px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-60">
                  {busy && <Loader2 className="size-3.5 animate-spin" strokeWidth={2} />}
                  Allow
                </button>
              </div>
              <p className="text-center text-[12px] text-muted-foreground/70">
                Then start a new conversation in {req.client.name} — {bot} shows up there.
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

// The workspace's own checkbox (the Memory screen's Tick): ink, not the browser's blue.
function Tick({ checked, dim }) {
  return (
    <span className={cn('mt-[2px] flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
      checked ? 'border-foreground/80 bg-foreground text-background' : 'border-border bg-transparent', dim && 'opacity-60')}>
      {checked && <Check className="size-3" strokeWidth={3} />}
    </span>
  );
}

function Problem({ text }) {
  return (
    <div className="flex items-start gap-2.5 rounded-[6px] border border-destructive/25 bg-destructive/[0.04] px-3 py-2.5">
      <AlertTriangle className="mt-px size-3.5 shrink-0 text-destructive/85" strokeWidth={1.75} />
      <div className="text-[12.5px] leading-relaxed text-foreground/85">{text}</div>
    </div>
  );
}
