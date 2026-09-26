/**
 * The workspace chat as the browser extension shows it (/app/?embed=extension).
 *
 * The extension's side panel frames this page, so the chat IS the workspace
 * chat — same component, same look, same behaviour, updated with every deploy.
 * What the page cannot do on its own the extension does, over postMessage:
 *
 *   extension → page   something:tab        { url, title, capturable }  (tab changed)
 *   page → extension   something:need-login                             (no session here)
 *   page → extension   something:selection  → { text }                  (selected text)
 *   page → extension   something:capture    → { dataUrl } | { error }   (screenshot)
 *
 * Messages are accepted only from the parent frame, and only when that parent
 * is a browser extension; Caddy's `frame-ancestors` already limits which
 * extension may frame the page at all.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, FileText, X, Eye, EyeOff, Loader2 } from 'lucide-react';
import ChatPane from './ChatPane';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { cn } from '@/lib/utils';
import { PARENT_ORIGIN } from '@/lib/extensionEmbed';

const AUTO_KEY = 'ext:autoScreens';
const MARKER_RE = /\[\[\s*SCREENSHOT\s*\]\]/i;
const MAX_AUTO_SHOTS = 2;

// Request/response over postMessage with a timeout, so a missing reply can
// never hang a send.
let rpcSeq = 0;
function rpc(type, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const id = `r${++rpcSeq}`;
    const done = (value) => { window.removeEventListener('message', onMsg); clearTimeout(timer); resolve(value); };
    const onMsg = (e) => {
      if (e.source !== window.parent || e.origin !== PARENT_ORIGIN) return;
      if (e.data?.type === `${type}:reply` && e.data.id === id) done(e.data);
    };
    const timer = setTimeout(() => done({ error: 'timeout' }), timeoutMs);
    window.addEventListener('message', onMsg);
    window.parent.postMessage({ type, id }, PARENT_ORIGIN);
  });
}

async function dataUrlToFile(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return new File([blob], `screenshot-${Date.now()}.jpg`, { type: blob.type || 'image/jpeg' });
}

export default function ExtensionChat() {
  const { session, isLoading } = useAuth();
  const { theme } = useTheme();

  // Let the extension's own screens (address step, spinner) match the theme.
  useEffect(() => {
    window.parent.postMessage({ type: 'something:theme', theme }, PARENT_ORIGIN);
  }, [theme]);
  const [tab, setTab] = useState(null);                 // { url, title, capturable }
  const [includePage, setIncludePage] = useState(true);  // for the next message
  const [autoScreens, setAutoScreens] = useState(() => {
    try { return localStorage.getItem(AUTO_KEY) === '1'; } catch { return false; }
  });
  const [wantsShot, setWantsShot] = useState(false);     // assistant asked, auto is off
  const [shotError, setShotError] = useState('');
  const [capturing, setCapturing] = useState(false);
  const screenshotReply = useRef(false);
  const autoShots = useRef(0);

  // No session in this browser → the extension signs in (Google refuses to
  // render its login inside a frame) and reloads us.
  useEffect(() => {
    if (!isLoading && !session) window.parent.postMessage({ type: 'something:need-login' }, PARENT_ORIGIN);
  }, [isLoading, session]);

  // Current tab, pushed by the extension.
  useEffect(() => {
    const onMsg = (e) => {
      if (e.source !== window.parent || e.origin !== PARENT_ORIGIN) return;
      if (e.data?.type === 'something:tab') {
        setTab(e.data.url ? { url: e.data.url, title: e.data.title || e.data.url, capturable: !!e.data.capturable } : null);
        setIncludePage(true);
      }
    };
    window.addEventListener('message', onMsg);
    window.parent.postMessage({ type: 'something:ready' }, PARENT_ORIGIN);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const capture = useCallback(async () => {
    setShotError('');
    setCapturing(true);
    const r = await rpc('something:capture', 8000);
    setCapturing(false);
    if (!r.dataUrl) { setShotError(r.error || 'Could not capture this tab.'); return null; }
    return dataUrlToFile(r.dataUrl);
  }, []);

  const attachShot = useCallback(async () => {
    const file = await capture();
    if (file) window.dispatchEvent(new CustomEvent('ide:chat-attach', { detail: { files: [file] } }));
  }, [capture]);

  const sendShot = useCallback(async () => {
    const file = await capture();
    if (!file) return;
    setWantsShot(false);
    screenshotReply.current = true;
    window.dispatchEvent(new CustomEvent('ide:chat-send', { detail: { text: '(Screenshot of my current tab.)', files: [file] } }));
  }, [capture]);

  // What travels with each message.
  const extraFields = useCallback(async () => {
    const ctx = { screenshots: autoScreens, isScreenshotReply: screenshotReply.current };
    if (!screenshotReply.current) autoShots.current = 0;   // a new user message resets the budget
    screenshotReply.current = false;
    if (tab && includePage) {
      ctx.url = tab.url;
      ctx.title = tab.title;
      const sel = await rpc('something:selection', 1500);
      if (sel.text) ctx.selection = sel.text;
    }
    setIncludePage(true);
    setWantsShot(false);
    return { pageContext: JSON.stringify(ctx) };
  }, [tab, includePage, autoScreens]);

  // The assistant asked to see the tab.
  const onTurnDone = useCallback((text) => {
    if (!MARKER_RE.test(text || '')) return;
    if (!autoScreens || !tab?.capturable) { setWantsShot(true); return; }
    if (autoShots.current >= MAX_AUTO_SHOTS) return;
    autoShots.current += 1;
    sendShot();
  }, [autoScreens, tab, sendShot]);

  const toggleAuto = () => {
    setAutoScreens(v => {
      try { localStorage.setItem(AUTO_KEY, v ? '0' : '1'); } catch { /* per-panel convenience */ }
      return !v;
    });
  };

  const accessory = useMemo(() => (
    <div className="flex flex-col gap-1.5 px-4 pb-1.5">
      {wantsShot && (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/60 px-2.5 py-1.5 text-[12px] text-foreground/80">
          <span>The assistant would like to see this tab.</span>
          <button onClick={sendShot} disabled={!tab?.capturable || capturing}
            className="rounded-md bg-foreground px-2 py-0.5 text-[11.5px] font-medium text-background disabled:opacity-40">
            Share screenshot
          </button>
        </div>
      )}
      {shotError && <div className="text-[11.5px] text-destructive">{shotError}</div>}
      <div className="flex items-center gap-1.5">
        {tab ? (
          <span className={cn(
            'inline-flex min-w-0 items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 text-[11px] text-foreground/75',
            !includePage && 'line-through opacity-50',
          )}>
            <FileText className="size-3 shrink-0 opacity-65" strokeWidth={1.75} />
            <span className="max-w-[220px] truncate" title={tab.url}>{tab.title}</span>
            <button onClick={() => setIncludePage(v => !v)} title={includePage ? "Don't send this page with the next message" : 'Send this page with the next message'}
              className="ml-0.5 text-muted-foreground/60 hover:text-foreground">
              <X className="size-3" strokeWidth={1.75} />
            </button>
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5">
          <button onClick={attachShot} disabled={!tab?.capturable || capturing} title="Attach a screenshot of this tab"
            className="rounded-md p-1.5 text-muted-foreground/75 hover:bg-accent hover:text-foreground disabled:opacity-35">
            {capturing ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} /> : <Camera className="size-3.5" strokeWidth={1.75} />}
          </button>
          <button onClick={toggleAuto} title={autoScreens ? 'The assistant may take a screenshot when it needs one (click to turn off)' : 'Let the assistant take a screenshot when it needs one'}
            className={cn('rounded-md p-1.5 hover:bg-accent', autoScreens ? 'text-foreground' : 'text-muted-foreground/60')}>
            {autoScreens ? <Eye className="size-3.5" strokeWidth={1.75} /> : <EyeOff className="size-3.5" strokeWidth={1.75} />}
          </button>
        </div>
      </div>
    </div>
  ), [tab, includePage, autoScreens, wantsShot, shotError, capturing, attachShot, sendShot]);

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
    <div className="fixed inset-0 flex flex-col bg-background text-foreground">
      <ChatPane
        className="h-full border-l-0"
        showThemeMenu
        extraFields={extraFields}
        composerAccessory={accessory}
        onTurnDone={onTurnDone}
      />
    </div>
  );
}
