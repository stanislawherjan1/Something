// The browser extension's side panel is destroyed every time it closes, so
// each open is a cold start. In that embed only, the chat keeps the last
// screen it showed here — who is signed in, which conversation, its latest
// messages — and paints that at once; live data replaces it as it arrives.
// Everywhere else these are no-ops.
import { isExtensionEmbed } from './extensionEmbed';

const KEY = 'something:panel-cache';
const MAX_MESSAGES = 30;

export function readPanelCache() {
  if (!isExtensionEmbed()) return null;
  try { return JSON.parse(window.localStorage.getItem(KEY)) || null; } catch { return null; }
}

export function writePanelCache(patch) {
  if (!isExtensionEmbed()) return;
  try { window.localStorage.setItem(KEY, JSON.stringify({ ...readPanelCache(), ...patch })); } catch { /* storage full or blocked */ }
}

// Finished messages only, text only (inline images can be megabytes), and the
// time of the last one — used to tell whether the conversation has gone stale.
export function panelMessages(messages) {
  const done = messages.filter(m => m.state === 'done' && (m.text || m.attachments?.length)).slice(-MAX_MESSAGES);
  const last = done[done.length - 1];
  return {
    messages: done.map(({ role, text, kind, attachments, tools, ts }) => ({ role, text, kind, attachments, tools, ts })),
    lastAt: last?.ts ? Date.parse(last.ts) : Date.now(),
  };
}
