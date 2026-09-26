// Side panel = the workspace's own chat, framed.
//
// The panel asks for the workspace address once, then shows
// https://<workspace>/app/?embed=extension — the real chat, with the current
// tab and a screenshot button above its input (ExtensionChat.jsx). The page
// cannot reach the browser, so this shell answers it over postMessage:
//
//   page → shell   something:ready       → shell sends the current tab
//   page → shell   something:need-login  → Google sign-in in a popup, session
//                                          installed, page reloaded
//   page → shell   something:selection   → { text } selected on the tab
//   page → shell   something:capture     → { dataUrl } of the visible tab
//   page → shell   something:theme       { theme: 'light'|'dark'|'system' }
//   shell → page   something:tab         { url, title, capturable }
//
// Only messages from the framed workspace origin are answered.

const $ = (id) => document.getElementById(id);
const frame = $('chat');
let origin = '';
let signingIn = false;
let readyTimer = null;
const READY_AFTER_LOAD_MS = 8000;   // the page loaded but never said it is ready
const LOAD_TIMEOUT_MS = 15000;      // the page never loaded at all

// ── Setup ────────────────────────────────────────────────────────────────────
function normalizeOrigin(input) {
  const raw = String(input || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  return `https://${url.host}`;
}

function showSetup(message = '') {
  clearTimeout(readyTimer);
  $('loading').hidden = true;
  frame.hidden = true;
  frame.removeAttribute('src');
  $('setup').hidden = false;
  $('domain').value = origin ? origin.replace(/^https:\/\//, '') : '';
  $('setup-error').hidden = !message;
  $('setup-error-text').textContent = message;
  $('domain').classList.toggle('invalid', !!message);
}

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  let next;
  try { next = normalizeOrigin($('domain').value); } catch { next = ''; }
  if (!next) return showSetup('Not a valid address.');
  // Asked inside the click, before any await: the workspace itself, plus every
  // site so the panel can read the page you are on and capture it on request.
  const granted = await chrome.permissions.request({ origins: [`${next}/*`, '<all_urls>'] });
  if (!granted) return showSetup('Permission is needed to continue.');
  origin = next;
  await chrome.storage.local.set({ origin });
  openChat();
});

const host = () => origin.replace(/^https:\/\//, '');

// Before framing: does this workspace allow this extension to show it? The
// answer is in its headers, which the extension can read directly — so a
// workspace without the extension view fails in a moment, with a reason,
// instead of after a timeout behind Chrome's error page.
async function preflight() {
  let res;
  try {
    res = await fetch(`${origin}/app/?embed=extension`, { credentials: 'omit', cache: 'no-store' });
  } catch {
    return `Can't reach ${host()}.`;
  }
  const csp = res.headers.get('content-security-policy') || '';
  if (!csp.includes(`chrome-extension://${chrome.runtime.id}`)) {
    return `This workspace needs an update to work with the extension.`;
  }
  return '';
}

async function openChat() {
  $('setup').hidden = true;
  frame.hidden = true;
  $('loading').hidden = false;
  const problem = await preflight();
  if (problem) return showSetup(problem);
  frame.classList.add('pending');
  frame.hidden = false;
  frame.src = `${origin}/app/?embed=extension`;
  clearTimeout(readyTimer);
  readyTimer = setTimeout(() => showSetup(`Couldn't open the chat.`), LOAD_TIMEOUT_MS);
}

frame.addEventListener('load', () => {
  if (frame.hidden || !frame.classList.contains('pending')) return;
  // The frame's initial about:blank also fires `load`, and it is readable (same
  // origin as the panel). Only the workspace page — cross-origin, so reading it
  // throws — starts the ready countdown.
  try { if (frame.contentWindow.location.href === 'about:blank') return; } catch { /* the workspace page */ }
  clearTimeout(readyTimer);
  readyTimer = setTimeout(() => showSetup(`Couldn't open the chat.`), READY_AFTER_LOAD_MS);
});

function revealChat() {
  clearTimeout(readyTimer);
  $('loading').hidden = true;
  frame.classList.remove('pending');
}

// ── Sign-in (only when the framed page reports no session) ───────────────────
async function signIn() {
  if (signingIn) return;
  signingIn = true;
  try {
    const redirect = await chrome.identity.launchWebAuthFlow({
      url: `${origin}/auth/extension/start?ext=${encodeURIComponent(chrome.runtime.id)}`,
      interactive: true,
    });
    const frag = new URLSearchParams(new URL(redirect).hash.slice(1));
    if (frag.get('error') === 'access_denied') {
      return showSetup(`${frag.get('email') || 'This Google account'} does not have access to this workspace.`);
    }
    const token = frag.get('token');
    const name = frag.get('cookie');
    if (!token || !name) return showSetup('Sign-in did not return a session. Try again.');
    // Install the session the same way the web login does, so the framed page
    // (and any normal tab of the workspace) is signed in.
    await chrome.cookies.set({
      url: `${origin}/`, name, value: token, path: '/',
      secure: true, httpOnly: true, sameSite: 'lax',
      expirationDate: Math.floor(Date.now() / 1000) + (Number(frag.get('expires_in')) || 8 * 3600),
    });
    openChat();
  } catch (err) {
    showSetup(`Sign-in did not finish (${err.message}).`);
  } finally {
    signingIn = false;
  }
}

// ── The tab the user is on ───────────────────────────────────────────────────
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}
function capturable(tab) {
  if (!tab?.url || !/^https?:/i.test(tab.url)) return false;
  try { return !/(^|\.)chromewebstore\.google\.com$/.test(new URL(tab.url).hostname); } catch { return false; }
}
async function pushTab() {
  if (frame.hidden || !frame.contentWindow) return;
  const tab = await activeTab();
  const web = tab && /^https?:/i.test(tab.url || '') && !(origin && tab.url.startsWith(origin));
  frame.contentWindow.postMessage(
    web ? { type: 'something:tab', url: tab.url, title: tab.title || '', capturable: capturable(tab) } : { type: 'something:tab' },
    origin,
  );
}
chrome.tabs.onActivated.addListener(pushTab);
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete' || info.title) pushTab(); });
chrome.windows.onFocusChanged.addListener(pushTab);

async function selectedText() {
  const tab = await activeTab();
  if (!tab?.id || !capturable(tab)) return '';
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => String(getSelection() || '') });
    return (r?.result || '').slice(0, 4000);
  } catch { return ''; }
}
async function captureTab() {
  const tab = await activeTab();
  if (!capturable(tab)) throw new Error('This page cannot be captured.');
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });
}

// ── Messages from the framed chat ────────────────────────────────────────────
window.addEventListener('message', async (e) => {
  if (!origin || e.origin !== origin || e.source !== frame.contentWindow) return;
  const { type, id } = e.data || {};
  const reply = (payload) => frame.contentWindow.postMessage({ type: `${type}:reply`, id, ...payload }, origin);
  if (type === 'something:ready') { revealChat(); pushTab(); }
  else if (type === 'something:theme') applyTheme(e.data.theme, true);
  else if (type === 'something:need-login') { revealChat(); signIn(); }
  else if (type === 'something:selection') reply({ text: await selectedText() });
  else if (type === 'something:capture') {
    try { reply({ dataUrl: await captureTab() }); } catch (err) { reply({ error: err.message }); }
  }
});

// "Change workspace" from the toolbar icon's menu (background.js).
chrome.storage.onChanged.addListener((changes) => {
  if (changes.changeWorkspace) showSetup();
});

// The chat's theme (Light / Dark / System), mirrored onto the address step and
// the spinner so the panel never flashes the other theme.
function applyTheme(theme, remember) {
  const v = theme === 'light' || theme === 'dark' ? theme : '';
  if (v) document.documentElement.dataset.theme = v;
  else delete document.documentElement.dataset.theme;
  if (remember) chrome.storage.local.set({ theme: v });
}

// ── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
  const s = await chrome.storage.local.get(['origin', 'changeWorkspace', 'theme']);
  applyTheme(s.theme, false);
  origin = s.origin || '';
  const allowed = origin && await chrome.permissions.contains({ origins: [`${origin}/*`] });
  const changing = Date.now() - (s.changeWorkspace || 0) < 15000;
  if (allowed && !changing) openChat(); else showSetup();
})();
