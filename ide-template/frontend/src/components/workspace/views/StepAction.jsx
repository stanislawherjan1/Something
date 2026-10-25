import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Download, Copy, Check, Loader2 } from 'lucide-react';
import TileBanner from './TileBanner.jsx';
import { useBranding, BOT_FALLBACK } from '../identity';
import { isStockAvatar } from '@/lib/avatar';

const btn = 'inline-flex items-center gap-1.5 rounded-[6px] border border-border/70 bg-background px-3 py-1.5 text-[12px] font-medium text-foreground/85 transition-all hover:border-foreground/30 hover:bg-muted/30 hover:text-foreground active:scale-[0.99] disabled:opacity-60';

/**
 * One action under a setup step: a file to download, the bot's face as the
 * screens draw it (`render: 'botPicture'`), or — `copy: true` — text to put
 * on the clipboard. A Slack manifest is pasted into a text box, not
 * uploaded: as a download it was one more file to open and copy from, and the
 * one-line JSON pasted unreadably. Copied, JSON is laid out to read.
 */
// The text to copy, laid out to read when it is JSON.
async function fetchCopyText(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(String(r.status));
  const text = await r.text();
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; /* not JSON: as served */ }
}

// The old way, for a browser that refuses the Clipboard API: a selected
// textarea and the copy command, inside the same click.
function copyByCommand(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copy refused');
}

export default function StepAction({ label, url, filename = '', copy = false, render = null }) {
  const [state, setState] = useState(null);   // null | 'busy' | 'done' | 'failed'
  // Fetched as soon as the step shows: the clipboard is written in the click
  // itself, since a browser (Safari first) refuses a write that comes after an
  // awaited fetch — the click no longer counts as the person's.
  const ready = useRef(null);
  useEffect(() => {
    if (!copy || !url) return;
    let live = true;
    fetchCopyText(url).then((t) => { if (live) ready.current = t; }).catch(() => {});
    return () => { live = false; };
  }, [copy, url]);
  if (render === 'botPicture') return <BotPictureDownload label={label} filename={filename} />;
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
      if (ready.current != null) {
        // Already here: written within the click.
        try { await navigator.clipboard.writeText(ready.current); } catch { copyByCommand(ready.current); }
      } else if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        // Not fetched yet: the browser is handed the fetch as part of the click.
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': fetchCopyText(url).then((t) => new Blob([t], { type: 'text/plain' })) })]);
      } else {
        await navigator.clipboard.writeText(await fetchCopyText(url));
      }
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

// The bot's face as a picture to upload to Slack or Telegram, the way the
// screens show it: a stock picture with the dot-grid effect (the plain stock
// image looked like someone else there), drawn by the same component and
// settings as BotPicture, off screen at 512 px, with the dot pitch scaled so
// it reads as the small avatar does, on the same paper; an uploaded picture
// as it is, a 512 px square from its middle.
const EXPORT_PX = 512;
const AVATAR_PX = 64;     // the in-app size whose look is kept
const PAPER = '#efede7';
function BotPictureDownload({ label, filename }) {
  const { botAvatarUrl } = useBranding();
  const [state, setState] = useState(null);
  const taken = useRef(false);   // one download per click: the banner may redraw (a resize)
  const finish = (s) => { setState(s); setTimeout(() => setState(null), s === 'done' ? 2500 : 3500); };
  const src = botAvatarUrl || BOT_FALLBACK;
  const stock = isStockAvatar(src);
  const save = (out) => {
    out.toBlob((blob) => {
      if (!blob) return finish('failed');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename || 'bot.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      finish('done');
    }, 'image/png');
  };
  // A stock picture: the halftone, as drawn on screen.
  const onDrawn = (canvas) => {
    if (taken.current) return;
    taken.current = true;
    try {
      const out = document.createElement('canvas');
      out.width = canvas.width; out.height = canvas.height;
      const c = out.getContext('2d');
      c.fillStyle = PAPER; c.fillRect(0, 0, out.width, out.height);
      c.drawImage(canvas, 0, 0);
      save(out);
    } catch { finish('failed'); }
  };
  // An uploaded picture goes out as it is: a square, cropped to its middle.
  const drawUploaded = () => {
    const img = new Image();
    img.onload = () => {
      try {
        const out = document.createElement('canvas');
        out.width = EXPORT_PX; out.height = EXPORT_PX;
        const c = out.getContext('2d');
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        c.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, EXPORT_PX, EXPORT_PX);
        save(out);
      } catch { finish('failed'); }
    };
    img.onerror = () => finish('failed');
    img.src = src;
  };
  const start = () => {
    taken.current = false;
    setState('busy');
    setTimeout(() => setState((s) => (s === 'busy' ? 'failed' : s)), 10000);
    if (!stock) drawUploaded();
  };
  return (
    <>
      <button type="button" onClick={start} disabled={state === 'busy'} className={btn}>
        {state === 'busy' ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} />
          : state === 'done' ? <Check className="size-3.5 text-emerald-600" strokeWidth={2} />
          : <Download className="size-3.5" strokeWidth={1.75} />}
        {state === 'done' ? 'Downloaded' : state === 'failed' ? 'Could not draw it — try again' : label}
      </button>
      {state === 'busy' && stock && createPortal(
        <div aria-hidden="true" style={{ position: 'fixed', left: -100000, top: 0, width: EXPORT_PX, height: EXPORT_PX, pointerEvents: 'none' }}>
          <TileBanner image={src} mode="dark" center plain step={1.7 * (EXPORT_PX / AVATAR_PX)} scale={1} seed="bot" paper onDrawn={onDrawn} className="!h-full" />
        </div>,
        document.body,
      )}
    </>
  );
}
