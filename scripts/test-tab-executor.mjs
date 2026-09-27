#!/usr/bin/env node
// test-tab-executor.mjs — run the browser agent's page-side code against a real
// Chrome, on a local fixture site (scripts/tab-fixture/). It evaluates exactly
// what the extension evaluates — the vendored jev-ultrafast snapshot, the
// sensitive-field filter, the freshness and target checks, the post-action
// wait — taken from chrome-extension/sidepanel.js, and drives input the same
// way (CDP Input.*). No dependencies: Chrome is driven over
// --remote-debugging-pipe, the fixture is served by a local HTTP server.
//
//   node scripts/test-tab-executor.mjs            # uses Google Chrome on macOS
//   CHROME=/path/to/chrome node scripts/test-tab-executor.mjs
//
// Local only (needs a Chrome binary); not part of CI.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) { console.log(`skip: no Chrome at ${CHROME}`); process.exit(0); }

// ── The extension's own page-side code ───────────────────────────────────────
const panel = readFileSync(join(ROOT, 'chrome-extension/sidepanel.js'), 'utf8');
function extract(name) {
  const start = panel.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`sidepanel.js has no function ${name}`);
  const end = panel.indexOf('\n}\n', start);
  return panel.slice(start, end + 2);
}
// eslint-disable-next-line no-new-func
const pageCode = new Function(`${extract('freshExpression')}\n${extract('targetExpression')}\n${extract('settleExpression')}\n${extract('sensitiveFieldIds')}
  return { freshExpression, targetExpression, settleExpression, sensitiveFieldIds };`)();
const SNAPSHOT = readFileSync(join(ROOT, 'chrome-extension/vendor/jev-snapshot.js'), 'utf8')
  .split('\n').filter((l) => !l.startsWith('//')).join('\n').trim();
const SENSITIVE = `(${pageCode.sensitiveFieldIds.toString()})()`;

// ── Fixture server ───────────────────────────────────────────────────────────
const FIXTURE = join(ROOT, 'scripts/tab-fixture');
const server = createServer((req, res) => {
  const path = join(FIXTURE, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!path.startsWith(FIXTURE) || !existsSync(path)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': extname(path) === '.html' ? 'text/html' : 'application/octet-stream' });
  res.end(readFileSync(path));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ── Chrome over a pipe ───────────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'tab-exec-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1200,900', 'about:blank'],
{ stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
let seq = 0, buf = '';
const waiting = new Map(), listeners = [];
chrome.stdio[4].on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (msg.id && waiting.has(msg.id)) { const w = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result); }
    else listeners.forEach((l) => l(msg));
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  waiting.set(id, { resolve, reject });
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});
const once = (method, sessionId) => new Promise((resolve) => {
  const l = (m) => { if (m.method === method && m.sessionId === sessionId) { listeners.splice(listeners.indexOf(l), 1); resolve(m.params); } };
  listeners.push(l);
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const cdp = (method, params) => send(method, params, sessionId);
await cdp('Page.enable');
// The user's tab is the visible one; headless targets are not, so keep animation
// frames running the way jev-ultrafast does for its own background tab.
await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result?.value;
}
async function open(path) {
  const loaded = once('Page.loadEventFired', sessionId);
  await cdp('Page.navigate', { url: `${BASE}${path}` });
  await loaded;
}
async function observe() {
  const state = await evaluate(SNAPSHOT);
  const hidden = new Set(await evaluate(SENSITIVE) || []);
  state.actions = state.actions.filter((a) => a.node == null || !hidden.has(a.node));
  return state;
}
const find = (state, re, kind) => state.actions.find((a) => re.test(a.label) && (!kind || a.kind === kind));
async function click(x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}
async function fill(target, text) {
  await click(target.x, target.y);
  const mod = process.platform === 'darwin' ? 4 : 2;
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: mod, commands: ['selectAll'] });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: mod });
  await cdp('Input.insertText', { text });
}

// ── Checks ───────────────────────────────────────────────────────────────────
const results = [];
async function check(name, fn) {
  try { const note = await fn(); results.push({ ok: true, name, note }); }
  catch (err) { results.push({ ok: false, name, note: err.message }); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

try {
  await open('/index.html');
  let page = await observe();

  await check('snapshot lists the form, buttons and links', async () => {
    for (const [re, kind] of [[/^Search/, 'fill'], [/^From/, 'fill'], [/Direct only/, 'click'], [/^Count$/, 'click'], [/Next page/, 'click']]) {
      assert(find(page, re, kind), `missing ${re} (${kind})`);
    }
    return `${page.actions.length} controls`;
  });

  await check('password, card and one-time-code fields are not in the snapshot', async () => {
    const leaked = page.actions.filter((a) => /Password|Card number|^Code/.test(a.label));
    assert(!leaked.length, `leaked: ${leaked.map((a) => a.label).join(', ')}`);
  });

  const target = (a) => evaluate(pageCode.targetExpression(a));

  await check('a click lands: the counter goes to 1', async () => {
    const a = find(page, /^Count$/, 'click');
    const fresh = await evaluate(pageCode.freshExpression(a.node));
    assert(fresh === JSON.stringify([page.page_key, page.guards[a.node]]), 'freshness guard does not match its own snapshot');
    const t = await target(a);
    assert(t && t.x, `target refused: ${JSON.stringify(t)}`);
    await click(t.x, t.y);
    const n = await evaluate(`document.getElementById('counter').dataset.n`);
    assert(n === '1', `counter is ${n}`);
  });

  for (const [label, re] of [['off-site link', /Elsewhere/], ['new-tab link', /new tab/i], ['download link', /Download the file/]]) {
    await check(`${label} is refused before the click`, async () => {
      const a = find(page, re);
      if (!a) return 'not offered by the snapshot at all';
      const t = await target(a);
      assert(t && t.offsite, `not refused: ${JSON.stringify(t)}`);
    });
  }

  await check('a covered button is refused', async () => {
    const a = find(page, /^Covered$/);
    if (!a) return 'not offered by the snapshot at all';
    assert((await target(a)) === null, 'covered button accepted');
  });

  await check('a disabled button is refused', async () => {
    const a = find(page, /^Disabled$/);
    if (!a) return 'not offered by the snapshot at all';
    assert((await target(a)) === null, 'disabled button accepted');
  });

  await check('typing replaces the field\'s value', async () => {
    const a = find(page, /^Search/, 'fill');
    const t = await target(a);
    assert(t && t.box, `fill target refused: ${JSON.stringify(t)}`);
    await fill(t, 'Zurich to London');
    const v = await evaluate(`document.getElementById('q').value`);
    assert(v === 'Zurich to London', `value is "${v}"`);
  });

  await check('after typing into a combobox the wait lasts until suggestions show (≤ 200 ms)', async () => {
    page = await observe();
    const a = find(page, /^From/, 'fill');
    const t = await target(a);
    await fill(t, 'Zur');
    const t0 = Date.now();
    await evaluate(pageCode.settleExpression(a));
    const ms = Date.now() - t0;
    const shown = await evaluate(`document.querySelectorAll('#lb [role=option]').length`);
    assert(ms <= 260, `waited ${ms} ms, ${shown} suggestion(s) visible`);
    assert(shown > 0, `no suggestions visible after the wait (${ms} ms)`);
    return `${ms} ms, ${shown} suggestion(s) visible after the wait`;
  });

  await check('after a click the wait is short (two frames or 50 ms)', async () => {
    const a = find(page, /^Count$/, 'click');
    const t0 = Date.now();
    await evaluate(pageCode.settleExpression(a));
    const ms = Date.now() - t0;
    assert(ms <= 120, `waited ${ms} ms`);
    return `${ms} ms`;
  });

  await check('a native select takes an allowed option, refuses a disabled one', async () => {
    page = await observe();
    const b = page.actions.find((a) => a.kind === 'select' && a.value === 'b');
    assert(b, 'no select option "b" in the snapshot');
    assert((await target(b))?.x, 'select refused');
    assert((await evaluate(`document.getElementById('cls').value`)) === 'b', 'value not set');
    const f = page.actions.find((a) => a.kind === 'select' && a.value === 'f');
    if (f) assert((await target(f)) === null, 'disabled option accepted');
    return f ? 'disabled option offered but refused' : 'disabled option not offered';
  });

  await check('a control below the fold is scrolled into view, then clicked', async () => {
    page = await observe();
    const a = find(page, /^Far below$/);
    if (!a) return 'not offered by the snapshot (off screen) — the scroll actions reach it';
    const t = await target(a);
    assert(t && t.x && t.y >= 0 && t.y < 900, `not brought into view: ${JSON.stringify(t)}`);
    await click(t.x, t.y);
    assert((await evaluate(`document.getElementById('far').dataset.clicked`)) === 'yes', 'click did not land');
    await evaluate('scrollTo(0, 0)');
  });

  await check('the page changed → the freshness guard no longer matches', async () => {
    page = await observe();
    const a = find(page, /^Count$/, 'click');
    await evaluate(`document.querySelector('h1').textContent = 'Flights (updated)'; document.getElementById('counter').textContent = 'Count again'`);
    const fresh = await evaluate(pageCode.freshExpression(a.node));
    assert(fresh !== JSON.stringify([page.page_key, page.guards[a.node]]), 'guard still matches after the control changed');
  });

  await check('a same-site link navigates, and the next observation is the new page', async () => {
    page = await observe();
    const a = find(page, /Next page/);
    const t = await target(a);
    assert(t && t.x && !t.offsite, `same-site link refused: ${JSON.stringify(t)}`);
    const t0 = Date.now();
    await click(t.x, t.y);
    let next = null;
    for (let i = 0; i < 50 && !(next && next.title === 'Second page'); i++) {
      try { next = await observe(); } catch { /* navigating */ }
      if (!(next && next.title === 'Second page')) await new Promise((r) => setTimeout(r, 50));
    }
    assert(next?.title === 'Second page', `still on "${next?.title}"`);
    return `${Date.now() - t0} ms to the new page's snapshot`;
  });
} finally {
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill();
  await exited;
  server.close();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* a temp dir; the OS clears it */ }
}

for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.note ? ` — ${r.note}` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
