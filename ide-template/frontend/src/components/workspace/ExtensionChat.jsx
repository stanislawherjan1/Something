/**
 * The workspace chat as the browser extension shows it (/app/?embed=extension).
 *
 * The extension's side panel frames this page, so the chat IS the workspace
 * chat — same component, same look, same behaviour, updated with every deploy.
 * What the page cannot do on its own the extension does, over postMessage:
 *
 *   extension → page   something:tab          { url, title, capturable }  (tab changed)
 *   extension → page   something:mode         { mode: 'look', reason }    (control switched itself off)
 *   extension → page   something:mode         { mode: 'act' }             (still on from before the panel closed)
 *   extension → page   something:act-paused   { site }                    (the tab moved to another site by itself)
 *   page → extension   something:need-login                               (no session here)
 *   page → extension   something:selection    → { text }                  (selected text)
 *   page → extension   something:set-mode     { mode } → { site } | { error }
 *   page → extension   something:tab-command  { command } → { ok, result | error }
 *
 * Act — the assistant operating the tab — is off by default; once the user
 * switches it on it stays on across pages and a reopened panel (the extension
 * remembers it until 10 idle minutes pass). Switching it off (or the extension
 * switching itself off) is sent to the extension AND to workspace-api at once,
 * without waiting for either: both refuse from then on.
 *
 * Messages are accepted only from the parent frame, and only when that parent
 * is a browser extension; Caddy's `frame-ancestors` already limits which
 * extension may frame the page at all.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, X, Loader2, MousePointerClick } from 'lucide-react';
import ChatPane from './ChatPane';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { cn } from '@/lib/utils';
import { PARENT_ORIGIN } from '@/lib/extensionEmbed';
import { WORKSPACE_FONT_STYLE } from '@/lib/workspaceFont';

// Opening the panel after a longer pause starts a new conversation.
const FRESH_AFTER_MS = 4 * 60 * 60 * 1000;
const OFF_REASONS = {
  'debugging cancelled': 'Chrome’s debugging bar was cancelled.',
  'idle': 'Nothing happened for 10 minutes.',
};

// Request/response over postMessage with a timeout, so a missing reply can
// never hang a send.
let rpcSeq = 0;
function rpc(type, payload = {}, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const id = `r${++rpcSeq}`;
    const done = (value) => { window.removeEventListener('message', onMsg); clearTimeout(timer); resolve(value); };
    const onMsg = (e) => {
      if (e.source !== window.parent || e.origin !== PARENT_ORIGIN) return;
      if (e.data?.type === `${type}:reply` && e.data.id === id) done(e.data);
    };
    const timer = setTimeout(() => done({ error: 'The browser did not answer.' }), timeoutMs);
    window.addEventListener('message', onMsg);
    window.parent.postMessage({ type, id, ...payload }, PARENT_ORIGIN);
  });
}

// Mode reports go out one after another, so a quick look → act (a reopened
// panel restoring Act) can never reach the server in the wrong order.
let modeChain = Promise.resolve();
function reportMode(mode) {
  modeChain = modeChain.then(() => fetch('/api/tab/mode', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  })).catch(() => {});
  return modeChain;
}

export default function ExtensionChat() {
  const { session, isLoading } = useAuth();
  const { theme } = useTheme();
  const [tab, setTab] = useState(null);                 // { url, title, capturable }
  const [includePage, setIncludePage] = useState(true);  // for the next message
  const [actSite, setActSite] = useState('');            // non-empty = Act is on, for this site
  const [notice, setNotice] = useState('');
  const [switching, setSwitching] = useState(false);
  const [pausedSite, setPausedSite] = useState('');     // Act held: the tab moved to another site by itself
  const actRef = useRef(false);

  // Let the extension's own screens (address step, spinner) match the theme.
  useEffect(() => {
    window.parent.postMessage({ type: 'something:theme', theme }, PARENT_ORIGIN);
  }, [theme]);

  // No session in this browser → the extension signs in (Google refuses to
  // render its login inside a frame) and reloads us.
  useEffect(() => {
    if (!isLoading && !session) window.parent.postMessage({ type: 'something:need-login' }, PARENT_ORIGIN);
  }, [isLoading, session]);

  // The one way to switch Act off: extension and server, at once, unconditionally.
  const actOff = useCallback((why = '') => {
    actRef.current = false;
    setActSite('');
    setPausedSite('');
    window.parent.postMessage({ type: 'something:set-mode', mode: 'look' }, PARENT_ORIGIN);
    reportMode('look');
    if (why) setNotice(why);
  }, []);

  const actOn = useCallback(async () => {
    setNotice('');
    setSwitching(true);
    const r = await rpc('something:set-mode', { mode: 'act' }, 6000);
    setSwitching(false);
    if (!r.site) { setNotice(r.error || 'Could not take control of this tab.'); actOff(); return; }
    actRef.current = true;
    setActSite(r.site);
    setPausedSite('');
    reportMode('act');
  }, [actOff]);

  // Messages from the extension: the current tab, and control switching itself off.
  useEffect(() => {
    const onMsg = (e) => {
      if (e.source !== window.parent || e.origin !== PARENT_ORIGIN) return;
      if (e.data?.type === 'something:tab') {
        setTab(e.data.url ? { url: e.data.url, title: e.data.title || e.data.url, capturable: !!e.data.capturable } : null);
        setIncludePage(true);
      } else if (e.data?.type === 'something:mode' && e.data.mode === 'look') {
        actOff(OFF_REASONS[e.data.reason] || '');
      } else if (e.data?.type === 'something:act-paused') {
        setPausedSite(String(e.data.site || 'another site'));
      } else if (e.data?.type === 'something:mode' && e.data.mode === 'act') {
        actRef.current = true;
        setActSite('on');
        reportMode('act');
      }
    };
    window.addEventListener('message', onMsg);
    window.parent.postMessage({ type: 'something:ready' }, PARENT_ORIGIN);
    reportMode('look');   // until the extension says Act is still on
    return () => window.removeEventListener('message', onMsg);
  }, [actOff]);

  // Commands from the assistant (via workspace-api) → the extension → the answer back.
  useEffect(() => {
    if (!session) return undefined;
    let es = null, retry = null, gone = false;
    const answer = (id, payload) => fetch('/api/tab/result', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...payload }),
    }).catch(() => {});
    const onCommand = async (ev) => {
      let cmd;
      try { cmd = JSON.parse(ev.data); } catch { return; }
      // Looking is always allowed here; acting only while Act is on.
      if (cmd.op === 'act' && !actRef.current) return answer(cmd.id, { ok: false, error: 'Act is off.' });
      // Passed on untouched, signature included: the extension checks it
      // against a key this page never sees (routes/tab.js panelKeys).
      const r = await rpc('something:tab-command', { command: { id: cmd.id, op: cmd.op, target: cmd.target, text: cmd.text, steps: cmd.steps, ts: cmd.ts, sig: cmd.sig } }, 18000);
      answer(cmd.id, r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error || 'failed' });
    };
    const connect = () => {
      es = new EventSource('/api/tab/stream', { withCredentials: true });
      // Every (re)connection — e.g. after workspace-api restarted — tells the
      // server where the switch is, since it forgets the mode when it restarts.
      es.addEventListener('hello', () => reportMode(actRef.current ? 'act' : 'look'));
      es.addEventListener('command', onCommand);
      // A server restart answers with an error status, and EventSource then
      // stops for good; without this the panel stays deaf until it is reopened.
      es.onerror = () => {
        if (gone || es.readyState !== EventSource.CLOSED) return;
        clearTimeout(retry);
        retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => { gone = true; clearTimeout(retry); es?.close(); };
  }, [session]);

  // What travels with each message.
  const extraFields = useCallback(async () => {
    const ctx = { act: actRef.current };
    if (tab && includePage) {
      ctx.url = tab.url;
      ctx.title = tab.title;
      const sel = await rpc('something:selection', {}, 1500);
      if (sel.text) ctx.selection = sel.text;
    }
    setIncludePage(true);
    return { pageContext: JSON.stringify(ctx) };
  }, [tab, includePage]);


  const accessory = useMemo(() => (
    <div className="flex flex-col gap-1.5 px-4 pb-1.5">
      {notice && <div className="text-[11.5px] text-muted-foreground/85">{notice}</div>}
      {pausedSite && (
        <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground/85">
          <span className="min-w-0 truncate">Act paused — the tab moved to {pausedSite} on its own.</span>
          <button onClick={actOn} disabled={switching} className="shrink-0 rounded px-1.5 py-0.5 font-medium text-foreground/85 hover:bg-accent disabled:opacity-50">
            Continue here
          </button>
        </div>
      )}
      <div className="flex items-center gap-1.5">
        {tab ? (
          <span className={cn(
            'inline-flex min-w-0 items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 text-[11px] text-foreground/75',
            !includePage && 'line-through opacity-50',
          )}>
            <FileText className="size-3 shrink-0 opacity-65" strokeWidth={1.75} />
            <span className="max-w-[200px] truncate" title={tab.url}>{tab.title}</span>
            <button onClick={() => setIncludePage(v => !v)} title={includePage ? "Don't send this page with the next message" : 'Send this page with the next message'}
              className="ml-0.5 text-muted-foreground/60 hover:text-foreground">
              <X className="size-3" strokeWidth={1.75} />
            </button>
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <button
            role="switch"
            aria-checked={!!actSite}
            onClick={() => (actSite ? actOff() : actOn())}
            disabled={switching || (!actSite && !tab?.capturable)}
            title={actSite
              ? 'The assistant can click and type on the tab you are on. Switch off to stop it at once.'
              : 'Let the assistant click and type on the tab you are on'}
            className="inline-flex items-center rounded-md p-1.5 hover:bg-accent disabled:opacity-35"
          >
            <MousePointerClick className={cn('mr-1 size-3.5', actSite ? 'text-destructive/85' : 'text-muted-foreground/75')} strokeWidth={1.75} />
            <span className={cn('relative h-3.5 w-6 rounded-full transition-colors', actSite ? 'bg-destructive/80' : 'bg-muted-foreground/30')}>
              <span className={cn('absolute top-0.5 size-2.5 rounded-full bg-background transition-all', actSite ? 'left-3' : 'left-0.5')} />
            </span>
          </button>
        </div>
      </div>
    </div>
  ), [tab, includePage, actSite, pausedSite, notice, switching, actOn, actOff]);

  if (isLoading || !session) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-2 bg-background text-[13px] text-muted-foreground/75">
        <Loader2 className="size-5 animate-spin" strokeWidth={1.75} />
        {!isLoading && <span>Signing in…</span>}
      </div>
    );
  }

  return (
    // text-foreground: the workspace sets it on its own root; without it here the
    // input inherits the body's legacy always-dark text colour in dark mode.
    <div className="fixed inset-0 flex flex-col bg-background text-foreground" style={WORKSPACE_FONT_STYLE}>
      <ChatPane
        className="h-full border-l-0"
        showThemeMenu
        freshAfterMs={FRESH_AFTER_MS}
        extraFields={extraFields}
        composerAccessory={accessory}
      />
    </div>
  );
}
