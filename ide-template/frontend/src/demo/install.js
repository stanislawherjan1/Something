// Demo build only (VITE_DEMO=1): route the workspace's /api/* and /auth/*
// calls to the in-browser server and stand in for its two event streams.
// Installed before the app mounts; nothing here leaves the page.

import { handle } from './server.js';
import { NOTIFICATIONS, LIVE_NOTIFICATIONS } from './data/workspace.js';
import { SHOWCASE } from './flags.js';

const isOurs = (url) => {
  try {
    const u = new URL(url, location.origin);
    return u.origin === location.origin && /^\/(api|auth)\//.test(u.pathname);
  } catch { return false; }
};

async function bodyOf(init, req) {
  const raw = init?.body ?? (req ? await req.clone().text() : null);
  if (raw == null || raw === '') return {};
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return {}; } }
  // FormData / Blob uploads: the demo doesn't keep files.
  return {};
}

export function installDemo() {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : String(input);
    if (!isOurs(url)) return realFetch(input, init);
    const method = (init.method || req?.method || 'GET').toUpperCase();
    // A beat of latency, so loading states look as they do for real — but not in the
    // landing's replay, which shows the app ready, never loading.
    if (!SHOWCASE) await new Promise((r) => setTimeout(r, 60 + Math.random() * 120));
    return handle(method, url, await bodyOf(init, req));
  };

  // Event streams: notifications (a replayed batch, then two live ones) and
  // the file watcher (quiet).
  const RealEventSource = window.EventSource;
  class DemoEventSource extends EventTarget {
    constructor(url, opts) {
      super();
      this.url = String(url);
      this.withCredentials = !!opts?.withCredentials;
      this.readyState = 0;
      this.onopen = this.onmessage = this.onerror = null;
      this._timers = [];
      setTimeout(() => this._open(), 50);
    }
    _emit(type, data) {
      if (this.readyState === 2) return;
      const ev = new MessageEvent(type, { data: typeof data === 'string' ? data : JSON.stringify(data) });
      this.dispatchEvent(ev);
      const h = type === 'message' ? this.onmessage : null;
      if (h) h.call(this, ev);
    }
    _open() {
      if (this.readyState === 2) return;
      this.readyState = 1;
      const open = new Event('open');
      this.dispatchEvent(open);
      this.onopen?.call(this, open);
      const path = new URL(this.url, location.origin).pathname;
      if (path === '/api/notifications/stream') {
        // The landing's replay shows the conversation alone: no backlog of notifications.
        const replayed = SHOWCASE ? [] : NOTIFICATIONS;
        this._emit('hello', { ok: true, replay: replayed.length });
        const base = Date.now() - 60_000;
        replayed.forEach((n, i) => this._emit('notification', { ...n, ts: n.ts || new Date(base - (replayed.length - i) * 37 * 60_000).toISOString(), replay: true }));
        if (!SHOWCASE) LIVE_NOTIFICATIONS.forEach((n, i) => {
          this._timers.push(setTimeout(() => this._emit('notification', { ...n, id: `${n.id}_${Date.now().toString(36)}`, ts: new Date().toISOString() }), 25_000 * (i + 1)));
        });
      } else {
        this._emit('hello', { ok: true });
      }
    }
    close() { this.readyState = 2; this._timers.forEach(clearTimeout); }
  }
  DemoEventSource.CONNECTING = 0; DemoEventSource.OPEN = 1; DemoEventSource.CLOSED = 2;
  window.EventSource = function EventSource(url, opts) {
    return isOurs(url) ? new DemoEventSource(url, opts) : new RealEventSource(url, opts);
  };
  Object.assign(window.EventSource, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });

  // The landing page's replay: the question typed and sent once the app is up.
  if (SHOWCASE) import('./showcase.js').then((m) => m.startShowcase());
}
